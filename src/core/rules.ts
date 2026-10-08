// Exchange order rules: lot multiples, tick alignment, freeze-quantity slicing.
// All prices are handled in integer paise so ₹0.05 ticks never drift.

import type { Instrument } from "./instruments.ts";

export type Round = "up" | "down" | "nearest";

/** Align a rupee price to the instrument tick. Returns rupees with ≤ 2 decimals. */
export function alignToTick(price: number, tickPaise: number, mode: Round): number {
  if (!Number.isFinite(price) || !(tickPaise > 0)) return NaN;
  const p = Math.round(price * 1e6) / 1e4; // paise, tolerant of float noise
  const q = p / tickPaise;
  const n = mode === "up" ? Math.ceil(q - 1e-9) : mode === "down" ? Math.floor(q + 1e-9) : Math.round(q);
  return (n * tickPaise) / 100;
}

export function isOnTick(price: number, tickPaise: number): boolean {
  if (!Number.isFinite(price) || !(price > 0) || !(tickPaise > 0)) return false;
  // in 1/100 paise so fractional ticks (USDINR options: 0.25 paise) work too
  const u = Math.round(price * 1e4), t = Math.round(tickPaise * 100);
  return Math.abs(price * 1e4 - u) < 1e-4 && t > 0 && u % t === 0;
}

export type QtyProblem = "not-integer" | "not-positive" | "not-lot-multiple";

export function checkQuantity(qty: number, inst: Pick<Instrument, "lotSize">): QtyProblem | null {
  if (!Number.isInteger(qty)) return "not-integer";
  if (qty <= 0) return "not-positive";
  if (qty % inst.lotSize !== 0) return "not-lot-multiple";
  return null;
}

/** Largest order size allowed in one exchange order: the freeze quantity rounded down to a lot multiple. */
export function maxPerOrder(inst: Pick<Instrument, "lotSize" | "freezeQty">): number {
  if (!inst.freezeQty) return Infinity;
  return Math.max(inst.lotSize, Math.floor(inst.freezeQty / inst.lotSize) * inst.lotSize);
}

/**
 * Split a quantity into exchange-acceptable orders (each ≤ freeze, each a lot
 * multiple). The broker's own auto-slicing (Upstox `slice: true`) does the same;
 * we compute it so the review screen can show how many orders (and so how many
 * ₹20 brokerage charges) one leg becomes.
 */
export function sliceQuantity(qty: number, inst: Pick<Instrument, "lotSize" | "freezeQty">): number[] {
  if (checkQuantity(qty, inst)) return [];
  const max = maxPerOrder(inst);
  if (!Number.isFinite(max)) return [qty];
  const out: number[] = [];
  let left = qty;
  while (left > 0) {
    const s = Math.min(left, max);
    out.push(s);
    left -= s;
  }
  return out;
}

/** Protective limit for a marketable order: cross the touch by `slip` (fraction), on the tick. */
export function protectiveLimit(side: "BUY" | "SELL", touch: number, tickPaise: number, slip: number): number {
  if (!(touch > 0)) return NaN;
  if (side === "BUY") return alignToTick(touch * (1 + slip), tickPaise, "up");
  const p = alignToTick(touch * (1 - slip), tickPaise, "down");
  return Math.max(p, tickPaise / 100);
}

export interface Liquidity {
  ok: boolean;
  reason: null | "no-bid" | "no-ask" | "wide-spread" | "thin";
  spreadPct: number;
}

/** A leg is illiquid when a side of the book is empty, the spread is wide, or the touch cannot fill the size. */
export function liquidity(bid: number, ask: number, bidQty: number, askQty: number, side: "BUY" | "SELL", qty: number, maxSpreadPct = 0.2): Liquidity {
  const mid = (bid + ask) / 2;
  const spreadPct = bid > 0 && ask > 0 ? (ask - bid) / mid : Infinity;
  if (!(bid > 0)) return { ok: false, reason: "no-bid", spreadPct };
  if (!(ask > 0)) return { ok: false, reason: "no-ask", spreadPct };
  if (spreadPct > maxSpreadPct && ask - bid > 0.5) return { ok: false, reason: "wide-spread", spreadPct };
  const depth = side === "BUY" ? askQty : bidQty;
  if (!(depth >= qty)) return { ok: false, reason: "thin", spreadPct };
  return { ok: true, reason: null, spreadPct };
}
