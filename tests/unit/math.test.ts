import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { blackScholes, probAbove, impliedVol, normCdf } from "../../src/core/math.ts";

const S = fc.double({ min: 1000, max: 100000, noNaN: true });
const m = fc.double({ min: 0.7, max: 1.3, noNaN: true });
const T = fc.double({ min: 1 / 365, max: 1, noNaN: true });
const V = fc.double({ min: 0.05, max: 1, noNaN: true });

describe("Black-Scholes and probabilities", () => {
  it("normCdf symmetric and bounded", () => {
    fc.assert(fc.property(fc.double({ min: -40, max: 40, noNaN: true }), (x) => {
      const p = normCdf(x);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
      expect(Math.abs(p + normCdf(-x) - 1)).toBeLessThan(1e-12);
    }));
  });
  it("put-call parity C − P = S − K·e^(−rT)", () => {
    fc.assert(fc.property(S, m, T, V, fc.double({ min: 0, max: 0.1, noNaN: true }), (s, mm, t, v, r) => {
      const K = s * mm;
      const { call, put } = blackScholes(s, K, t, v, r);
      expect(Math.abs(call - put - (s - K * Math.exp(-r * t)))).toBeLessThan(1e-6 * s);
    }));
  });
  it("P(S_T > K) is in [0,1] and falls as K rises", () => {
    fc.assert(fc.property(S, m, T, V, (s, mm, t, v) => {
      const a = probAbove(s, s * mm, t, v), b = probAbove(s, s * mm * 1.01, t, v);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
      expect(b).toBeLessThanOrEqual(a + 1e-12);
    }));
  });
  it("implied vol inverts the price", () => {
    fc.assert(fc.property(S, fc.double({ min: 0.9, max: 1.1, noNaN: true }), fc.double({ min: 7 / 365, max: 1, noNaN: true }), fc.double({ min: 0.08, max: 0.8, noNaN: true }), fc.constantFrom<"CE" | "PE">("CE", "PE"), (s, mm, t, v, ty) => {
      const K = s * mm;
      const bs = blackScholes(s, K, t, v);
      const px = ty === "CE" ? bs.call : bs.put;
      const iv = impliedVol(px, s, K, t, ty);
      if (iv === null) return; // price too close to intrinsic to invert
      expect(Math.abs(iv - v)).toBeLessThan(1e-3);
    }));
  });
  it("at expiry the price is intrinsic and probability is 0/1", () => {
    expect(blackScholes(100, 90, 0, 0.2).call).toBe(10);
    expect(probAbove(100, 90, 0, 0.2)).toBe(1);
    expect(probAbove(80, 90, 0, 0.2)).toBe(0);
  });
});
