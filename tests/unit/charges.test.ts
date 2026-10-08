import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { charges, scheduleFor, sumCharges, exerciseStt, type Fill, type ChargeSegment } from "../../src/core/charges.ts";

const D = "2026-10-08";

describe("charges: golden values from the published schedules", () => {
  it("NSE option BUY 65 @ ₹100 (Nifty lot) — brokerage ₹20, txn ₹3,553/cr, stamp 0.003%, GST 18%", () => {
    const c = charges({ segment: "OPT", exchange: "NSE", side: "BUY", qty: 65, price: 100, date: D });
    expect(c).toMatchObject({ turnover: 6500, brokerage: 20, stt: 0, exchangeTxn: 2.31, sebiFee: 0.01, stampDuty: 0.2, dp: 0, gst: 4.02, total: 26.54 });
  });
  it("NSE option SELL 65 @ ₹100 — STT 0.15% of premium from 1 Apr 2026", () => {
    const c = charges({ segment: "OPT", exchange: "NSE", side: "SELL", qty: 65, price: 100, date: D });
    expect(c).toMatchObject({ stt: 9.75, stampDuty: 0, total: 36.09 });
  });
  it("same sell before 1 Apr 2026 used 0.1% STT", () => {
    expect(charges({ segment: "OPT", exchange: "NSE", side: "SELL", qty: 65, price: 100, date: "2026-03-15" }).stt).toBe(6.5);
  });
  it("futures sell ₹1,00,000: STT ₹50 (0.05%), the HDFC Bank Budget-2026 worked example", () => {
    expect(charges({ segment: "FUT", exchange: "NSE", side: "SELL", qty: 1, price: 100000, date: D }).stt).toBe(50);
  });
  it("futures brokerage is min(₹20, 0.05%)", () => {
    expect(charges({ segment: "FUT", exchange: "NSE", side: "BUY", qty: 1, price: 20000, date: D }).brokerage).toBe(10);
    expect(charges({ segment: "FUT", exchange: "NSE", side: "BUY", qty: 1, price: 2000000, date: D }).brokerage).toBe(20);
  });
  it("NSE options transaction charge ₹3,553 per crore of premium (NSE/FA/73061)", () => {
    expect(charges({ segment: "OPT", exchange: "NSE", side: "BUY", qty: 1, price: 1e7, date: D }).exchangeTxn).toBe(3553);
  });
  it("BSE (Sensex) options transaction charge 0.0325% of premium", () => {
    expect(charges({ segment: "OPT", exchange: "BSE", side: "BUY", qty: 1, price: 1e7, date: D }).exchangeTxn).toBe(3250);
  });
  it("equity delivery: STT both sides 0.1%, stamp 0.015% on buy, DP ₹20+GST on sell", () => {
    const b = charges({ segment: "EQ_DELIVERY", exchange: "NSE", side: "BUY", qty: 10, price: 1000, date: D });
    expect(b).toMatchObject({ brokerage: 20, stt: 10, stampDuty: 1.5, dp: 0 });
    const s = charges({ segment: "EQ_DELIVERY", exchange: "NSE", side: "SELL", qty: 10, price: 1000, date: D });
    expect(s).toMatchObject({ stt: 10, stampDuty: 0, dp: 20 });
    expect(s.gst).toBe(Math.round(0.18 * (20 + s.exchangeTxn + 20) * 100) / 100);
  });
  it("intraday brokerage is min(₹20, 0.1%) and STT 0.025% on sell only", () => {
    const c = charges({ segment: "EQ_INTRADAY", exchange: "NSE", side: "SELL", qty: 10, price: 500, date: D });
    expect(c).toMatchObject({ brokerage: 5, stt: 1.25 });
    expect(charges({ segment: "EQ_INTRADAY", exchange: "NSE", side: "BUY", qty: 10, price: 500, date: D }).stt).toBe(0);
  });
  it("brokerage is per executed order: a leg sliced into 3 orders pays ₹60", () => {
    expect(charges({ segment: "OPT", exchange: "NSE", side: "BUY", qty: 3510 * 3, price: 10, orders: 3, date: D }).brokerage).toBe(60);
  });
  it("SEBI 2.5% ceiling caps brokerage on tiny orders", () => {
    expect(charges({ segment: "EQ_DELIVERY", exchange: "NSE", side: "BUY", qty: 1, price: 10, date: D }).brokerage).toBe(0.25);
  });
  it("unknown BSE equity group is flagged, not silently zero", () => {
    const c = charges({ segment: "EQ_DELIVERY", exchange: "BSE", side: "BUY", qty: 1, price: 100, date: D, bseGroup: "QQ" });
    expect(c.notes.join(" ")).toMatch(/not in the schedule/);
    expect(c.exchangeTxn).toBeGreaterThanOrEqual(0);
  });
  it("schedule selection by trade date", () => {
    expect(scheduleFor("2025-01-01").id).toBe("2024-10-01");
    expect(scheduleFor("2026-03-01").id).toBe("2026-03-01");
    expect(scheduleFor("2026-10-08").id).toBe("2026-04-01");
    expect(() => scheduleFor("2020-01-01")).toThrow();
  });
  it("exercise STT 0.15% of intrinsic", () => {
    expect(exerciseStt(100, 65)).toBe(9.75);
    expect(exerciseStt(-5, 65)).toBe(0);
  });
});

const fillArb = fc.record({
  segment: fc.constantFrom<ChargeSegment>("EQ_DELIVERY", "EQ_INTRADAY", "FUT", "OPT"),
  exchange: fc.constantFrom<"NSE" | "BSE">("NSE", "BSE"),
  side: fc.constantFrom<"BUY" | "SELL">("BUY", "SELL"),
  qty: fc.integer({ min: 1, max: 100_000 }),
  price: fc.integer({ min: 5, max: 5_000_000 }).map((p) => p / 100),
  orders: fc.integer({ min: 1, max: 10 }),
  date: fc.constantFrom("2024-11-01", "2026-03-10", "2026-10-08"),
  bseGroup: fc.constantFrom("A", "B", "X", "Z"),
});

describe("charges: properties", () => {
  it("every component ≥ 0 and the total is their sum (to the paisa)", () => {
    fc.assert(fc.property(fillArb, (f: Fill) => {
      const c = charges(f);
      const parts = [c.brokerage, c.stt, c.exchangeTxn, c.sebiFee, c.stampDuty, c.gst, c.dp];
      expect(parts.every((x) => x >= 0)).toBe(true);
      expect(Math.abs(parts.reduce((a, b) => a + b, 0) - c.total)).toBeLessThan(0.005);
    }));
  });
  it("F&O: STT only on the sell side, stamp duty only on the buy side", () => {
    fc.assert(fc.property(fillArb.filter((f) => f.segment === "FUT" || f.segment === "OPT"), (f) => {
      const c = charges(f);
      if (f.side === "BUY") expect(c.stt).toBe(0);
      else expect(c.stampDuty).toBe(0);
    }));
  });
  it("total never decreases when quantity grows (same price, same orders)", () => {
    fc.assert(fc.property(fillArb, fc.integer({ min: 1, max: 1000 }), (f, extra) => {
      expect(charges({ ...f, qty: f.qty + extra }).total).toBeGreaterThanOrEqual(charges(f).total);
    }));
  });
  it("GST is 18% of brokerage + exchange + DP (rounded)", () => {
    fc.assert(fc.property(fillArb, (f) => {
      const c = charges(f);
      expect(Math.abs(c.gst - 0.18 * (c.brokerage + c.exchangeTxn + c.dp))).toBeLessThanOrEqual(0.0051);
    }));
  });
  it("sumCharges adds component-wise", () => {
    fc.assert(fc.property(fc.array(fillArb, { minLength: 1, maxLength: 5 }), (fs) => {
      const all = fs.map(charges);
      const s = sumCharges(all);
      expect(Math.abs(s.total - all.reduce((a, c) => a + c.total, 0))).toBeLessThan(0.01 * fs.length);
    }));
  });
  it("rejects nonsense fills", () => {
    expect(() => charges({ segment: "OPT", exchange: "NSE", side: "BUY", qty: 0, price: 1, date: D })).toThrow();
    expect(() => charges({ segment: "OPT", exchange: "NSE", side: "BUY", qty: 1, price: NaN, date: D })).toThrow();
  });
});
