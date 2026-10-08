// A broker-neutral option chain with live quotes, and the implied-vol smile read from it.

import type { Instrument } from "./instruments.ts";
import { impliedVol, yearsTo } from "./math.ts";

export interface Quote {
  ltp: number | null;
  bid: number | null; // best bid (₹); null when the book has no bid
  ask: number | null;
  bidQty: number;
  askQty: number;
  iv: number | null; // implied vol as a fraction (0.12 = 12%), as reported by the broker
  oi: number | null;
  ts: number; // when the gateway received it (ms)
}

export interface ChainSide {
  inst: Instrument;
  q: Quote | null;
}

export interface ChainRow {
  strike: number;
  call: ChainSide | null;
  put: ChainSide | null;
}

export interface Chain {
  underlying: string;
  expiryDate: string;
  expiryMs: number;
  spot: number; // underlying spot from the broker
  rows: ChainRow[]; // sorted by strike
  fetchedAt: number;
  source: string; // e.g. "Upstox option chain"
}

const pos = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : null);

export function makeQuote(p: { ltp?: unknown; bid?: unknown; ask?: unknown; bidQty?: unknown; askQty?: unknown; ivPct?: unknown; oi?: unknown }, ts: number): Quote {
  const iv = pos(p.ivPct);
  return {
    ltp: pos(p.ltp),
    bid: pos(p.bid),
    ask: pos(p.ask),
    bidQty: typeof p.bidQty === "number" && p.bidQty > 0 ? p.bidQty : 0,
    askQty: typeof p.askQty === "number" && p.askQty > 0 ? p.askQty : 0,
    iv: iv !== null && iv < 500 ? iv / 100 : null,
    oi: typeof p.oi === "number" ? p.oi : null,
    ts,
  };
}

export const mid = (q: Quote | null): number | null => (q && q.bid && q.ask ? (q.bid + q.ask) / 2 : (q?.ltp ?? null));

export function strikes(chain: Chain): number[] {
  return chain.rows.map((r) => r.strike);
}

/** Most common gap between listed strikes near spot (50 for Nifty, 100 for Bank Nifty …). */
export function strikeStep(chain: Chain): number {
  const ks = strikes(chain);
  const near = ks.filter((k) => Math.abs(k / chain.spot - 1) < 0.05);
  const use = near.length >= 3 ? near : ks;
  const counts = new Map<number, number>();
  for (let i = 1; i < use.length; i++) {
    const g = Math.round((use[i]! - use[i - 1]!) * 100) / 100;
    if (g > 0) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  let best = 0, n = -1;
  for (const [g, c] of counts) if (c > n || (c === n && g < best)) [best, n] = [g, c];
  return best;
}

export interface SmilePoint {
  strike: number;
  iv: number;
}

/**
 * IV smile from out-of-the-money options (puts below spot, calls above), using
 * the broker's IV and, when missing, IV implied from the mid price.
 */
export function smile(chain: Chain, now: number): SmilePoint[] {
  const T = yearsTo(chain.expiryMs, now);
  const pts: SmilePoint[] = [];
  for (const r of chain.rows) {
    const side = r.strike >= chain.spot ? r.call : r.put;
    if (!side) continue;
    let iv = side.q?.iv ?? null;
    if (iv === null) {
      const m = mid(side.q);
      if (m !== null && T > 0) iv = impliedVol(m, chain.spot, r.strike, T, side.inst.type === "CE" ? "CE" : "PE");
    }
    if (iv !== null && iv > 0.01 && iv < 3) pts.push({ strike: r.strike, iv });
  }
  return pts;
}

/** Linear interpolation of the smile; flat beyond the ends; null when the smile is empty. */
export function ivAt(pts: SmilePoint[], K: number): number | null {
  if (!pts.length) return null;
  if (K <= pts[0]!.strike) return pts[0]!.iv;
  const last = pts[pts.length - 1]!;
  if (K >= last.strike) return last.iv;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    if (K <= b.strike) return a.iv + ((b.iv - a.iv) * (K - a.strike)) / (b.strike - a.strike);
  }
  return last.iv;
}

export function row(chain: Chain, strike: number): ChainRow | undefined {
  return chain.rows.find((r) => r.strike === strike);
}
