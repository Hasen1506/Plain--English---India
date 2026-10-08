import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { blackScholes, probAbove } from "../../src/core/math.ts";

// Independent reference: integrate the lognormal terminal density numerically
// (Simpson's rule in log-space). Shares nothing with the closed form or normCdf.
function density(S: number, T: number, v: number, r: number, x: number): number {
  // x = ln(S_T); mean ln S + (r − v²/2) T, sd v√T
  const mu = Math.log(S) + (r - (v * v) / 2) * T, sd = v * Math.sqrt(T);
  return Math.exp(-((x - mu) ** 2) / (2 * sd * sd)) / (sd * Math.sqrt(2 * Math.PI));
}
function integrate(f: (x: number) => number, a: number, b: number, n = 4000): number {
  const h = (b - a) / n;
  let s = f(a) + f(b);
  for (let i = 1; i < n; i++) s += f(a + i * h) * (i % 2 ? 4 : 2);
  return (s * h) / 3;
}
function refCall(S: number, K: number, T: number, v: number, r: number): number {
  const sd = v * Math.sqrt(T), mu = Math.log(S) + (r - (v * v) / 2) * T;
  return Math.exp(-r * T) * integrate((x) => Math.max(Math.exp(x) - K, 0) * density(S, T, v, r, x), Math.log(K), mu + 12 * sd);
}
function refProbAbove(S: number, K: number, T: number, v: number, r: number): number {
  const sd = v * Math.sqrt(T), mu = Math.log(S) + (r - (v * v) / 2) * T;
  const lo = Math.log(K), hi = mu + 12 * sd;
  return lo >= hi ? 0 : integrate((x) => density(S, T, v, r, x), lo, hi);
}

describe("Black-Scholes vs numerical integration of the lognormal density", () => {
  it("call prices agree", () => {
    fc.assert(fc.property(fc.double({ min: 5000, max: 90000, noNaN: true }), fc.double({ min: 0.85, max: 1.15, noNaN: true }), fc.double({ min: 2 / 365, max: 0.5, noNaN: true }), fc.double({ min: 0.08, max: 0.6, noNaN: true }), fc.double({ min: 0, max: 0.08, noNaN: true }), (S, m, T, v, r) => {
      const K = S * m;
      expect(Math.abs(blackScholes(S, K, T, v, r).call - refCall(S, K, T, v, r))).toBeLessThan(1e-4 * S);
    }), { numRuns: 200 });
  });
  it("P(S_T > K) agrees", () => {
    fc.assert(fc.property(fc.double({ min: 5000, max: 90000, noNaN: true }), fc.double({ min: 0.8, max: 1.2, noNaN: true }), fc.double({ min: 2 / 365, max: 0.5, noNaN: true }), fc.double({ min: 0.08, max: 0.6, noNaN: true }), (S, m, T, v) => {
      expect(Math.abs(probAbove(S, S * m, T, v) - refProbAbove(S, S * m, T, v, 0))).toBeLessThan(1e-6);
    }), { numRuns: 200 });
  });
});
