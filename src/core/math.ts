// Normal distribution, Black-Scholes, implied volatility and expiry probabilities.
// normCdf is the Hart (1968) / West (2005) double-precision algorithm (~1e-14, monotone),
// copied from the Plain English Options app.

export function normCdf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const z = Math.abs(x);
  let c: number;
  if (z > 37) {
    c = 0;
  } else {
    const e = Math.exp((-z * z) / 2);
    if (z < 7.07106781186547) {
      let n = 3.52624965998911e-2 * z + 0.700383064443688;
      n = n * z + 6.37396220353165;
      n = n * z + 33.912866078383;
      n = n * z + 112.079291497871;
      n = n * z + 221.213596169931;
      n = n * z + 220.206867912376;
      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      c = (e * n) / d;
    } else {
      let b = z + 0.65;
      b = z + 4 / b;
      b = z + 3 / b;
      b = z + 2 / b;
      b = z + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

export interface BsResult {
  call: number;
  put: number;
  d1: number;
  d2: number;
}

/**
 * European Black-Scholes on a spot S with continuous rate r (no dividends; for
 * index options the dividend yield is small and is absorbed into the implied vol
 * the chain reports). T in years.
 */
export function blackScholes(S: number, K: number, T: number, vol: number, r = 0): BsResult {
  if (!(S > 0) || !(K > 0)) return { call: NaN, put: NaN, d1: NaN, d2: NaN };
  if (!(T > 0) || !(vol > 0)) {
    const call = Math.max(S - K, 0);
    const put = Math.max(K - S, 0);
    const d = S > K ? Infinity : S < K ? -Infinity : 0;
    return { call, put, d1: d, d2: d };
  }
  const sd = vol * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * vol * vol) * T) / sd;
  const d2 = d1 - sd;
  const df = Math.exp(-r * T);
  const call = S * normCdf(d1) - K * df * normCdf(d2);
  const put = K * df * normCdf(-d2) - S * normCdf(-d1);
  return { call: Math.max(call, 0), put: Math.max(put, 0), d1, d2 };
}

/** Risk-neutral probability that S_T > K (lognormal, vol = implied vol at K). */
export function probAbove(S: number, K: number, T: number, vol: number, r = 0): number {
  if (!(S > 0) || !(K > 0)) return NaN;
  if (!(T > 0) || !(vol > 0)) return S > K ? 1 : 0;
  const { d2 } = blackScholes(S, K, T, vol, r);
  return normCdf(d2);
}

export const probBelow = (S: number, K: number, T: number, vol: number, r = 0): number => {
  const p = probAbove(S, K, T, vol, r);
  return Number.isNaN(p) ? NaN : 1 - p;
};

/** Implied vol from a price by bisection; null when the price is outside no-arbitrage bounds. */
export function impliedVol(price: number, S: number, K: number, T: number, type: "CE" | "PE", r = 0): number | null {
  if (!(price > 0) || !(S > 0) || !(K > 0) || !(T > 0)) return null;
  const df = Math.exp(-r * T);
  const intrinsic = type === "CE" ? Math.max(S - K * df, 0) : Math.max(K * df - S, 0);
  const upper = type === "CE" ? S : K * df;
  if (price <= intrinsic || price >= upper) return null;
  let lo = 1e-4, hi = 5;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const p = type === "CE" ? blackScholes(S, K, T, mid, r).call : blackScholes(S, K, T, mid, r).put;
    if (p > price) hi = mid;
    else lo = mid;
    if (hi - lo < 1e-7) break;
  }
  return (lo + hi) / 2;
}

/** Years between now and an expiry (calendar time, 365-day year). */
export const yearsTo = (expiryMs: number, now: number): number => Math.max(0, (expiryMs - now) / (365 * 86_400_000));

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
