import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { suggest, spreadPayoff, legsPayoff, payoffCurve, kindsFor, type View } from "../../src/core/strategy.ts";
import { isOnTick } from "../../src/core/rules.ts";
import { coreChain, FIXTURE_NOW } from "../mock/fixtures.ts";

const chain = coreChain("NIFTY", "2026-10-13")!;
const bank = coreChain("BANKNIFTY", "2026-10-27")!;

const view = (v: Partial<View>): View => ({ underlying: "NIFTY", dir: "above", mode: "stays", level: 22300, expiryDate: "2026-10-13", risk: 5000, ...v });

describe("spread suggestions on the recorded live Nifty chain", () => {
  it("'Nifty stays above 22,300, risking ₹5,000' → bull put credit spread first, worst case within ₹5,000", () => {
    const r = suggest(view({}), chain, { now: FIXTURE_NOW });
    expect(r.suggestions.length).toBeGreaterThan(0);
    const s = r.suggestions[0]!;
    expect(s.kind).toBe("bull-put-credit");
    const short = s.legs.find((l) => l.side === "SELL")!, long = s.legs.find((l) => l.side === "BUY")!;
    expect(short.inst.strike).toBe(22300);
    expect(long.inst.strike!).toBeLessThan(22300);
    expect(short.inst.type).toBe("PE");
    expect(s.worstMaxLoss).toBeLessThanOrEqual(5000);
    expect(s.qty % 65).toBe(0);
    expect(s.legs[0]!.side).toBe("BUY"); // hedge first
    expect(s.probProfit).not.toBeNull();
    expect(s.probProfit!).toBeGreaterThan(0.3);
    expect(s.plain).toMatch(/Nifty 50/);
  });
  it("tells you the minimum risk when one lot does not fit", () => {
    const r = suggest(view({ risk: 100 }), chain, { now: FIXTURE_NOW });
    expect(r.suggestions).toHaveLength(0);
    expect(r.failures[0]!.fail.reason).toBe("risk-too-small");
  });
  it("no chain → explicit failure, never invented prices", () => {
    const r = suggest(view({}), null, { now: FIXTURE_NOW });
    expect(r.suggestions).toHaveLength(0);
    expect(r.failures.every((f) => f.fail.reason === "no-chain")).toBe(true);
  });
  it("expired chain → expired", () => {
    const r = suggest(view({}), chain, { now: chain.expiryMs + 1 });
    expect(r.failures[0]!.fail.reason).toBe("expired");
  });
  it("directional 'goes above' builds an ATM→level debit spread", () => {
    const r = suggest(view({ mode: "reaches", level: 22800, risk: 20000 }), chain, { now: FIXTURE_NOW });
    const s = r.suggestions.find((x) => x.kind === "bull-call-debit")!;
    expect(s).toBeTruthy();
    expect(s.legs.find((l) => l.side === "SELL")!.inst.strike).toBe(22800);
    expect(s.legs.find((l) => l.side === "BUY")!.inst.strike!).toBeLessThanOrEqual(chain.spot);
  });
  it("Bank Nifty 'falls below' → bear put debit spread", () => {
    const r = suggest({ underlying: "BANKNIFTY", dir: "below", mode: "reaches", level: 53500, expiryDate: "2026-10-27", risk: 30000 }, bank, { now: FIXTURE_NOW });
    expect(r.suggestions[0]?.kind).toBe("bear-put-debit");
  });
});

const levelArb = fc.integer({ min: 21000, max: 23900 }).map((x) => Math.round(x / 50) * 50);
const viewArb = fc.record({
  underlying: fc.constant("NIFTY"),
  dir: fc.constantFrom<"above" | "below">("above", "below"),
  mode: fc.constantFrom<"stays" | "reaches">("stays", "reaches"),
  level: levelArb,
  expiryDate: fc.constant("2026-10-13"),
  risk: fc.integer({ min: 500, max: 200000 }),
});

describe("spread invariants (property, recorded chain)", () => {
  it("every suggestion: risk respected, lot multiples, ticks, strikes listed, payoff bounds", () => {
    fc.assert(fc.property(viewArb, (v) => {
      const r = suggest(v, chain, { now: FIXTURE_NOW });
      expect(kindsFor(v)).toContain(r.suggestions[0]?.kind ?? kindsFor(v)[0]);
      for (const s of r.suggestions) {
        expect(s.worstMaxLoss).toBeLessThanOrEqual(v.risk + 1e-6);
        expect(s.maxLoss).toBeGreaterThan(0);
        expect(s.maxProfit).toBeGreaterThan(0);
        expect(s.qty).toBe(s.lots * s.lotSize);
        expect(s.legs.map((l) => l.side)).toEqual(["BUY", "SELL"]);
        for (const l of s.legs) {
          expect(l.qty).toBe(s.qty);
          expect(isOnTick(l.price, l.inst.tickPaise)).toBe(true);
          expect(isOnTick(l.limit, l.inst.tickPaise)).toBe(true);
          expect(chain.rows.some((row) => row.strike === l.inst.strike)).toBe(true);
          if (l.side === "BUY") expect(l.limit).toBeGreaterThanOrEqual(l.price);
          else expect(l.limit).toBeLessThanOrEqual(l.price);
        }
        // payoff at the far tails equals max profit / max loss (before charges)
        const lo = legsPayoff(s.legs, 1), hi = legsPayoff(s.legs, 1e6);
        const best = Math.max(lo, hi), worst = Math.min(lo, hi);
        expect(Math.abs(best - s.maxProfit)).toBeLessThan(0.02 * s.qty + 0.01);
        expect(Math.abs(-worst - s.maxLoss)).toBeLessThan(0.02 * s.qty + 0.01);
        // breakeven is where the expiry payoff crosses zero
        expect(Math.abs(legsPayoff(s.legs, s.breakeven))).toBeLessThan(0.02 * s.qty + 0.01);
        if (s.probProfit !== null) expect(s.probProfit).toBeGreaterThanOrEqual(0);
        if (s.probProfit !== null) expect(s.probProfit).toBeLessThanOrEqual(1);
        // max profit is never above width × qty
        expect(s.maxProfit).toBeLessThanOrEqual(s.width * s.qty + 1e-6);
      }
    }), { numRuns: 150 });
  });
  it("more risk never means fewer lots for the same view", () => {
    fc.assert(fc.property(viewArb, fc.integer({ min: 1, max: 100000 }), (v, extra) => {
      const a = suggest(v, chain, { now: FIXTURE_NOW }).suggestions;
      const b = suggest({ ...v, risk: v.risk + extra }, chain, { now: FIXTURE_NOW }).suggestions;
      for (const s of a) {
        const t = b.find((x) => x.kind === s.kind);
        expect(t).toBeTruthy();
        expect(t!.maxProfit).toBeGreaterThanOrEqual(s.maxProfit - 1e-6);
      }
    }), { numRuns: 60 });
  });
  it("payoff curve net of charges never beats max profit or loses more than max loss + charges", () => {
    const s = suggest(view({}), chain, { now: FIXTURE_NOW }).suggestions[0]!;
    for (const p of payoffCurve(s, 20000, 25000)) {
      expect(p.pnl).toBeLessThanOrEqual(s.maxProfit);
      expect(p.pnl).toBeGreaterThanOrEqual(-(s.maxLoss + s.entryCharges.total) - 0.01);
    }
  });
  it("closed-form spread payoff matches the leg-by-leg sum", () => {
    fc.assert(fc.property(fc.integer({ min: 100, max: 400 }).map((x) => x * 50), fc.integer({ min: 1, max: 6 }).map((x) => x * 50), fc.double({ min: 1, max: 200, noNaN: true }), fc.double({ min: 1000, max: 40000, noNaN: true }), (k, w, net, S) => {
      const p = spreadPayoff("bull-put-credit", { short: k, long: k - w }, net, S);
      const legs = [
        { inst: { strike: k - w, type: "PE" } as never, side: "BUY" as const, qty: 1, price: 0 },
        { inst: { strike: k, type: "PE" } as never, side: "SELL" as const, qty: 1, price: net },
      ];
      expect(Math.abs(p - legsPayoff(legs, S))).toBeLessThan(1e-9);
    }));
  });
});
