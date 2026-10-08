import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { executeLegs, type ExecBroker, type PlaceRequest, type OrderStatus, type ExecLeg } from "../../src/core/execution.ts";
import { store } from "../mock/fixtures.ts";

const s = store();
const pe = s.chain("NIFTY", "2026-10-13").filter((i) => i.type === "PE");
const longI = pe.find((i) => i.strike === 22200)!, shortI = pe.find((i) => i.strike === 22300)!;
const LOT = 65;

/** A scripted broker: each placed order fills `script()` lots (capped at the request). */
function scripted(fills: number[], reject: boolean[] = []): ExecBroker & { placed: PlaceRequest[] } {
  const orders = new Map<string, OrderStatus>();
  const placed: PlaceRequest[] = [];
  let n = 0;
  return {
    placed,
    async place(r) {
      placed.push(r);
      const i = n++;
      if (reject[i]) return { ok: false, error: "RMS: insufficient margin" };
      const lots = fills[i] ?? 0;
      const f = Math.min(r.qty, lots * LOT);
      orders.set(String(i), { state: f === r.qty ? "complete" : "cancelled", filled: f, avgPrice: f ? r.limit : null });
      return { ok: true, orderIds: [String(i)] };
    },
    async status(id) {
      return orders.get(id)!;
    },
    async cancel() {},
  };
}

const legs = (lots: number): ExecLeg[] => [
  { inst: shortI, side: "SELL", qty: lots * LOT, limit: 70 },
  { inst: longI, side: "BUY", qty: lots * LOT, limit: 50 },
];
const deps = (broker: ExecBroker) => ({ broker, check: () => ({ ok: true as const }), unwindLimit: () => 40, product: "D" as const, tag: "t", sleep: async () => {} });

describe("multi-leg execution", () => {
  it("hedge (BUY) goes first even if listed second", async () => {
    const b = scripted([2, 2]);
    const r = await executeLegs(legs(2), deps(b));
    expect(b.placed.map((p) => p.side)).toEqual(["BUY", "SELL"]);
    expect(b.placed.every((p) => p.validity === "IOC")).toBe(true);
    expect(r.status).toBe("filled");
    expect(r.matchedQty).toBe(130);
  });
  it("short leg fails → long leg is unwound", async () => {
    const b = scripted([2, 0, 2]);
    const r = await executeLegs(legs(2), deps(b));
    expect(r.status).toBe("unwound");
    expect(b.placed[2]).toMatchObject({ side: "SELL", instrumentKey: longI.key, qty: 130, purpose: "unwind" });
  });
  it("short leg rejected by the broker → unwind", async () => {
    const b = scripted([3, 0, 3], [false, true, false]);
    const r = await executeLegs(legs(3), deps(b));
    expect(r.status).toBe("unwound");
    expect(r.legs[1]!.error).toMatch(/margin/);
  });
  it("unwind that cannot fill is flagged NEEDS ATTENTION with the residual", async () => {
    const b = scripted([2, 1, 0, 0, 0]);
    const r = await executeLegs(legs(2), deps(b));
    expect(r.status).toBe("needs-attention");
    expect(r.residual).toEqual([{ inst: longI, netQty: 65 }]);
  });
  it("nothing filled → nothing sent after the first leg", async () => {
    const b = scripted([0]);
    const r = await executeLegs(legs(1), deps(b));
    expect(r.status).toBe("nothing-filled");
    expect(b.placed).toHaveLength(1);
  });
  it("risk check failure on the first leg sends nothing", async () => {
    const b = scripted([1, 1]);
    const r = await executeLegs(legs(1), { ...deps(b), check: () => ({ ok: false as const, code: "kill-switch" as const, message: "kill switch" }) });
    expect(b.placed).toHaveLength(0);
    expect(r.status).toBe("nothing-filled");
  });
  it("property: never short more than long; ends matched, unwound, or flagged with exact residuals", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 6 }), fc.array(fc.integer({ min: 0, max: 7 }), { minLength: 6, maxLength: 6 }), async (lots, script) => {
      const b = scripted(script);
      const r = await executeLegs(legs(lots), deps(b));
      // net per instrument from what the broker actually filled
      const net = new Map<string, number>();
      let i = 0;
      for (const p of b.placed) {
        const f = Math.min(p.qty, (script[i++] ?? 0) * LOT);
        net.set(p.instrumentKey, (net.get(p.instrumentKey) ?? 0) + (p.side === "BUY" ? f : -f));
      }
      const L = net.get(longI.key) ?? 0, S = 0 - (net.get(shortI.key) ?? 0) + 0;
      expect(S).toBeLessThanOrEqual(L); // never naked short
      expect(Math.abs(S % LOT)).toBe(0);
      if (r.status === "needs-attention") expect(L - S).toBe(r.residual.reduce((a, x) => a + x.netQty, 0));
      else expect(L).toBe(S); // flat or fully matched
      expect(r.matchedQty).toBe(S);
      expect(S).toBeLessThanOrEqual(lots * LOT);
    }), { numRuns: 300 });
  });
});
