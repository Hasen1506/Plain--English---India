import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { suggest, type View } from "../../src/core/strategy.ts";
import { coreChain, FIXTURE_NOW } from "../mock/fixtures.ts";

// Brute force: scan settlement prices on a fine grid, sum each leg's cash flow
// independently, and compare with the closed-form max profit / max loss / breakeven.
const chains = { NIFTY: coreChain("NIFTY", "2026-10-27")!, BANKNIFTY: coreChain("BANKNIFTY", "2026-10-27")!, FINNIFTY: coreChain("FINNIFTY", "2026-10-27")! };

function bruteForce(legs: { strike: number; type: string; side: string; qty: number; price: number }[], lo: number, hi: number) {
  let best = -Infinity, worst = Infinity;
  const crossings: number[] = [];
  let prev: number | null = null;
  for (let S = lo; S <= hi; S += 0.5) {
    let v = 0;
    for (const l of legs) {
      const intr = l.type === "CE" ? Math.max(S - l.strike, 0) : Math.max(l.strike - S, 0);
      v += (l.side === "BUY" ? 1 : -1) * (intr - l.price) * l.qty;
    }
    best = Math.max(best, v);
    worst = Math.min(worst, v);
    if (prev !== null && Math.sign(prev) !== Math.sign(v) && v !== 0) crossings.push(S);
    prev = v;
  }
  return { best, worst, crossings };
}

describe("spread maths vs brute-force settlement scan (recorded chains)", () => {
  it("max profit, max loss and breakeven match", () => {
    fc.assert(fc.property(fc.constantFrom("NIFTY", "BANKNIFTY", "FINNIFTY" as const), fc.constantFrom<"above" | "below">("above", "below"), fc.constantFrom<"stays" | "reaches">("stays", "reaches"), fc.double({ min: 0.95, max: 1.05, noNaN: true }), fc.integer({ min: 2000, max: 300000 }), (u, dir, mode, m, risk) => {
      const c = chains[u as keyof typeof chains];
      const v: View = { underlying: u, dir, mode, level: Math.round(c.spot * m), expiryDate: c.expiryDate, risk };
      for (const s of suggest(v, c, { now: FIXTURE_NOW }).suggestions) {
        const legs = s.legs.map((l) => ({ strike: l.inst.strike!, type: l.inst.type, side: l.side, qty: l.qty, price: l.price }));
        const ks = legs.map((l) => l.strike);
        const bf = bruteForce(legs, Math.min(...ks) - 2000, Math.max(...ks) + 2000);
        expect(Math.abs(bf.best - s.maxProfit)).toBeLessThan(0.01 * s.qty);
        expect(Math.abs(-bf.worst - s.maxLoss)).toBeLessThan(0.01 * s.qty);
        expect(bf.crossings.length).toBe(1);
        expect(Math.abs(bf.crossings[0]! - s.breakeven)).toBeLessThanOrEqual(0.5);
      }
    }), { numRuns: 120 });
  });
});
