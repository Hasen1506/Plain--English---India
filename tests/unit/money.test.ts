import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { inr, inr2, num, parseRupees, round2 } from "../../src/core/money.ts";

describe("rupee formatting", () => {
  it("uses Indian digit grouping", () => {
    expect(inr(5000)).toBe("₹5,000");
    expect(inr(123456789)).toBe("₹12,34,56,789");
    expect(inr2(73.25)).toBe("₹73.25");
    expect(inr(-1500)).toBe("−₹1,500");
    expect(num(22454.65)).toBe("22,454.65");
    expect(inr(NaN)).toBe("—");
  });
  it("parses rupee amounts people type", () => {
    expect(parseRupees("₹5,000")).toBe(5000);
    expect(parseRupees("5k")).toBe(5000);
    expect(parseRupees("1.5 lakh")).toBe(150000);
    expect(parseRupees("2 cr")).toBe(2e7);
    expect(parseRupees("Rs. 750")).toBe(750);
    expect(parseRupees("abc")).toBeNull();
  });
  it("round2 is half-up and stable", () => {
    expect(round2(0.195)).toBe(0.2);
    expect(round2(1.005)).toBe(1.01);
    expect(round2(-2.675)).toBe(-2.68);
    fc.assert(fc.property(fc.integer({ min: -1e9, max: 1e9 }), (p) => { expect(round2(p / 100)).toBe(p / 100); }));
  });
  it("format → parse round trip for whole rupees", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 1e10 }), (n) => { expect(parseRupees(inr(n, 0))).toBe(n); }));
  });
});
