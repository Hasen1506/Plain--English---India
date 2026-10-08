import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { charges } from "../../src/core/charges.ts";
import { referenceTotalPaise } from "./charges-reference.ts";

describe("charges vs an independent integer-arithmetic reference (schedule from 1 Apr 2026)", () => {
  it("totals agree to within 3 paise on random fills", () => {
    fc.assert(fc.property(
      fc.constantFrom<"EQ_DELIVERY" | "EQ_INTRADAY" | "FUT" | "OPT">("EQ_DELIVERY", "EQ_INTRADAY", "FUT", "OPT"),
      fc.constantFrom<"NSE" | "BSE">("NSE", "BSE"),
      fc.constantFrom<"BUY" | "SELL">("BUY", "SELL"),
      fc.integer({ min: 1, max: 50_000 }),
      fc.integer({ min: 5, max: 2_000_000 }),
      fc.integer({ min: 1, max: 6 }),
      (seg, ex, side, qty, pricePaise, orders) => {
        const ours = charges({ segment: seg, exchange: ex, side, qty, price: pricePaise / 100, orders, date: "2026-10-08", bseGroup: "A" });
        const ref = Number(referenceTotalPaise(seg, ex, side, qty, pricePaise, orders)) / 100;
        // the two round at different stages (GST is taken on rounded vs exact parts): ≤ 3 paise apart
        expect(Math.abs(ours.total - ref)).toBeLessThanOrEqual(0.03 + 1e-9);
      },
    ), { numRuns: 2000 });
  });
});
