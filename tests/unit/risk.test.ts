import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { checkOrder, RateLimiter, DEFAULT_RISK, sanitizeRiskConfig, confirmPhraseOk, type OrderIntent, type CheckContext } from "../../src/core/risk.ts";
import { makeQuote } from "../../src/core/chain.ts";
import { marketSession } from "../../src/core/calendar.ts";
import { store, calendar, FIXTURE_NOW } from "../mock/fixtures.ts";

const s = store();
const inst = s.chain("NIFTY", "2026-10-13").find((i) => i.strike === 22300 && i.type === "PE")!;
const q = makeQuote({ bid: 73.05, ask: 73.25, bidQty: 1755, askQty: 585, ltp: 73 }, FIXTURE_NOW);
const session = marketSession(FIXTURE_NOW, "NSE", calendar());
const base = (o: Partial<OrderIntent> = {}): OrderIntent => ({ instrumentKey: inst.key, side: "BUY", qty: 65, orderType: "LIMIT", limitPrice: 73.25, product: "D", purpose: "entry", ...o });
const ctx = (c: Partial<CheckContext> = {}): CheckContext => ({ config: DEFAULT_RISK, state: { killSwitch: false, todayPnl: 0, netQtyByKey: {} }, inst, quote: q, session, now: FIXTURE_NOW, ...c });

describe("gateway risk checks", () => {
  it("a sane limit order passes with defaults (caps off)", () => expect(checkOrder(base(), ctx())).toEqual({ ok: true }));
  it.each([
    ["market orders", base({ orderType: "MARKET" }), "order-type"],
    ["not a lot multiple", base({ qty: 100 }), "quantity"],
    ["off-tick price", base({ limitPrice: 73.26 }), "tick"],
    ["buy too far above the offer", base({ limitPrice: 80 }), "slippage"],
    ["sell too far below the bid", base({ side: "SELL", limitPrice: 60 }), "slippage"],
  ])("rejects %s", (_n, o, code) => expect(checkOrder(o, ctx())).toMatchObject({ ok: false, code }));
  it("kill switch blocks entries but allows reducing exits", () => {
    const st = { killSwitch: true, todayPnl: 0, netQtyByKey: { [inst.key]: 130 } };
    expect(checkOrder(base(), ctx({ state: st }))).toMatchObject({ code: "kill-switch" });
    expect(checkOrder(base({ side: "SELL", purpose: "exit", limitPrice: 70 }), ctx({ state: st }))).toEqual({ ok: true });
  });
  it("exits must reduce, never flip or open", () => {
    const st = { killSwitch: false, todayPnl: 0, netQtyByKey: { [inst.key]: 65 } };
    expect(checkOrder(base({ side: "SELL", qty: 130, purpose: "exit", limitPrice: 70 }), ctx({ state: st }))).toMatchObject({ code: "not-reducing" });
  });
  it("closed market, stale or missing quotes, disallowed segment", () => {
    const closed = marketSession(FIXTURE_NOW + 6 * 3600e3, "NSE", calendar());
    expect(checkOrder(base(), ctx({ session: closed }))).toMatchObject({ code: "market-closed" });
    expect(checkOrder(base(), ctx({ now: FIXTURE_NOW + 60_000 }))).toMatchObject({ code: "stale-quote" });
    expect(checkOrder(base(), ctx({ quote: null }))).toMatchObject({ code: "no-quote" });
    expect(checkOrder(base(), ctx({ config: { ...DEFAULT_RISK, allowedSegments: ["NSE_EQ"] } }))).toMatchObject({ code: "segment" });
  });
  it("per-trade and daily loss caps are optional and off by default", () => {
    expect(DEFAULT_RISK.perTradeCap).toBeNull();
    expect(DEFAULT_RISK.dailyLossCap).toBeNull();
    const cfg = { ...DEFAULT_RISK, perTradeCap: 1000, dailyLossCap: 5000 };
    expect(checkOrder(base(), ctx({ config: cfg, tradeWorstLoss: 4000 }))).toMatchObject({ code: "per-trade-cap" });
    expect(checkOrder(base(), ctx({ config: cfg, tradeWorstLoss: 900, state: { killSwitch: false, todayPnl: -5000, netQtyByKey: {} } }))).toMatchObject({ code: "daily-loss-cap" });
    expect(checkOrder(base(), ctx({ config: cfg, tradeWorstLoss: 900, state: { killSwitch: false, todayPnl: -4999, netQtyByKey: {} } }))).toEqual({ ok: true });
  });
  it("property: with the kill switch on, no entry ever passes", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 40000 }), fc.constantFrom<"BUY" | "SELL">("BUY", "SELL"), (lots, paise, side) => {
      const r = checkOrder(base({ qty: lots * 65, limitPrice: paise / 100, side }), ctx({ state: { killSwitch: true, todayPnl: 0, netQtyByKey: {} } }));
      expect(r.ok).toBe(false);
    }));
  });
  it("property: caps off ⇒ cap rules never fire", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 20 }), fc.double({ min: -1e7, max: 1e7, noNaN: true }), fc.double({ min: 0, max: 1e8, noNaN: true }), (lots, pnl, worst) => {
      const r = checkOrder(base({ qty: lots * 65 }), ctx({ state: { killSwitch: false, todayPnl: pnl, netQtyByKey: {} }, tradeWorstLoss: worst }));
      if (!r.ok) expect(["per-trade-cap", "daily-loss-cap"]).not.toContain(r.code);
    }));
  });
  it("sanitises caps from the UI: blank/zero/junk = off", () => {
    expect(sanitizeRiskConfig({ perTradeCap: "₹5,000", dailyLossCap: "" }, DEFAULT_RISK)).toMatchObject({ perTradeCap: 5000, dailyLossCap: null });
    expect(sanitizeRiskConfig({ perTradeCap: "0", dailyLossCap: "abc" }, DEFAULT_RISK)).toMatchObject({ perTradeCap: null, dailyLossCap: null });
  });
  it("REAL MONEY phrase", () => {
    expect(confirmPhraseOk(" real money ")).toBe(true);
    expect(confirmPhraseOk("REAL")).toBe(false);
    expect(confirmPhraseOk(undefined)).toBe(false);
  });
});

describe("order rate limiter (< 10 orders/second, SEBI retail-algo threshold)", () => {
  it("refuses limits ≥ 10/s", () => {
    expect(() => new RateLimiter(10)).toThrow();
    expect(() => new RateLimiter(0)).toThrow();
  });
  it("property: never more than N orders in any 1-second window", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 9 }), fc.array(fc.integer({ min: 0, max: 400 }), { minLength: 1, maxLength: 80 }), (n, gaps) => {
      const rl = new RateLimiter(n);
      let t = 0;
      const sent: number[] = [];
      for (const g of gaps) {
        t += g;
        const w = rl.waitMs(t);
        t += w;
        expect(rl.waitMs(t)).toBe(0);
        rl.record(t);
        sent.push(t);
      }
      for (let i = 0; i < sent.length; i++) expect(sent.filter((x) => x >= sent[i]! && x < sent[i]! + 1000).length).toBeLessThanOrEqual(n);
    }));
  });
});
