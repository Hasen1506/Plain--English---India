import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { PaperBroker, emptyPaper, applyFill, unrealised } from "../../src/core/paper.ts";
import { makeQuote } from "../../src/core/chain.ts";
import { store, FIXTURE_NOW } from "../mock/fixtures.ts";

const s = store();
const inst = s.chain("NIFTY", "2026-10-13").find((i) => i.strike === 22300 && i.type === "PE")!;

describe("paper trading against live quotes", () => {
  const q = makeQuote({ bid: 73.05, ask: 73.25, bidQty: 1755, askQty: 585, ltp: 73 }, FIXTURE_NOW);
  const mk = () => new PaperBroker(emptyPaper(), (k) => s.get(k), async () => q, () => FIXTURE_NOW);
  it("BUY IOC at or above the offer fills at the offer, capped by the size shown", async () => {
    const b = mk();
    const r = await b.place({ instrumentKey: inst.key, side: "BUY", qty: 650, limit: 74, product: "D", validity: "IOC", tag: "t", purpose: "entry" });
    if (!r.ok) throw new Error();
    const st = await b.status(r.orderIds[0]!);
    expect(st.filled).toBe(585); // 9 lots shown at the offer
    expect(st.avgPrice).toBe(73.25);
    expect(st.state).toBe("cancelled"); // IOC remainder
    expect(b.state.orders[0]!.paper).toBe(true);
    expect(b.state.orders[0]!.id).toMatch(/^PAPER-/);
  });
  it("BUY below the offer does not fill (no fantasy fills)", async () => {
    const b = mk();
    const r = await b.place({ instrumentKey: inst.key, side: "BUY", qty: 65, limit: 73.2, product: "D", validity: "IOC", tag: "t", purpose: "entry" });
    if (!r.ok) throw new Error();
    expect((await b.status(r.orderIds[0]!)).filled).toBe(0);
  });
  it("no quote → no fill", async () => {
    const b = new PaperBroker(emptyPaper(), (k) => s.get(k), async () => null, () => FIXTURE_NOW);
    const r = await b.place({ instrumentKey: inst.key, side: "SELL", qty: 65, limit: 1, product: "D", validity: "IOC", tag: "t", purpose: "entry" });
    if (!r.ok) throw new Error();
    expect((await b.status(r.orderIds[0]!)).filled).toBe(0);
  });
  it("property: realised P&L of a round trip = Σ sell value − Σ buy value", () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.constantFrom<"BUY" | "SELL">("BUY", "SELL"), fc.integer({ min: 1, max: 10 }), fc.integer({ min: 100, max: 50000 })), { minLength: 1, maxLength: 20 }), (fills) => {
      let p = undefined as ReturnType<typeof applyFill> | undefined;
      let cash = 0;
      for (const [side, lots, paise] of fills) {
        const px = paise / 100;
        p = applyFill(p, "k", "X", side, lots, px, 0, "2026-10-08");
        cash += (side === "SELL" ? 1 : -1) * lots * px;
      }
      // mark the remainder at a price, then realised + unrealised = cash + qty × mark
      const mark = 123.45;
      const total = p!.realised + (unrealised(p!, mark) ?? 0);
      expect(Math.abs(total - (cash + p!.qty * mark))).toBeLessThan(0.01 * fills.length + 1e-6);
    }));
  });
});
