import { describe, it, expect } from "vitest";
import { parseEquity, equityTicket } from "../../src/core/equity.ts";
import { makeQuote } from "../../src/core/chain.ts";
import { isOnTick } from "../../src/core/rules.ts";
import { store, FIXTURE_NOW } from "../mock/fixtures.ts";

const s = store();
const rel = s.equity("RELIANCE")!;
const q = makeQuote({ ltp: 1189.8, bid: 1189.7, ask: 1189.9, bidQty: 500, askQty: 800 }, FIXTURE_NOW);

describe("cash equity in plain English", () => {
  it.each([
    ["buy ₹20,000 of Reliance", { side: "BUY", query: "reliance", amount: 20000, qty: null, product: "D" }],
    ["sell 10 TCS at 3,450", { side: "SELL", query: "tcs", qty: 10, price: 3450 }],
    ["buy 5 shares of infosys intraday", { side: "BUY", query: "infosys", qty: 5, product: "I" }],
    ["invest 50k in hdfcbank", { side: "BUY", query: "hdfcbank", amount: 50000 }],
  ])("%s", (t, want) => expect(parseEquity(t)).toMatchObject(want));
  it("missing pieces are listed", () => {
    expect(parseEquity("reliance").missing).toEqual(["side", "size"]);
  });
  it("search finds the NSE equity from the master", () => {
    expect(s.searchEquity("reliance")[0]?.symbol).toBe("RELIANCE");
    expect(s.searchEquity("hdfc")[0]?.symbol).toBe("HDFCBANK");
  });
  it("amount → whole shares at a protective limit on the tick", () => {
    const t = equityTicket({ ...parseEquity("buy ₹20,000 of Reliance"), side: "BUY" }, rel, q, FIXTURE_NOW);
    if ("fail" in t) throw new Error(t.fail);
    expect(t.qty).toBe(Math.floor(20000 / t.limit));
    expect(t.limit).toBeGreaterThanOrEqual(1189.9);
    expect(isOnTick(t.limit, rel.tickPaise)).toBe(true);
    expect(t.charges.stt).toBeGreaterThan(0);
  });
  it("no quote and no price → refuses (no market orders)", () => {
    expect(equityTicket({ ...parseEquity("buy 1 reliance"), side: "BUY" }, rel, null, FIXTURE_NOW)).toEqual({ fail: "no-quote" });
  });
});
