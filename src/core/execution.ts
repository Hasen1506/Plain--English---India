// Multi-leg execution with leg-fail unwind.
//
// 1. BUY legs go first (the hedge), SELL legs after, so a short option is never
//    larger than the long one protecting it.
// 2. Every leg is an IOC LIMIT order (never MARKET). A leg after the first is sized
//    to what the earlier legs actually filled.
// 3. If a later leg fills less (or is rejected), the excess of the earlier legs is
//    closed again with a protective IOC limit ("unwind"), retried with a wider
//    limit, and if it still cannot be closed the trade is flagged NEEDS ATTENTION
//    with the exact residual quantities.
//
// The executor only talks to `ExecBroker`, so the same code runs live (Upstox),
// in paper mode (PaperBroker) and in tests (a scripted fake).

import type { Instrument } from "./instruments.ts";
import type { Side } from "./charges.ts";
import type { Purpose, RiskResult } from "./risk.ts";

export interface PlaceRequest {
  instrumentKey: string;
  side: Side;
  qty: number;
  limit: number;
  product: "D" | "I";
  validity: "IOC" | "DAY";
  tag: string;
  purpose: Purpose;
}

export type OrderState = "complete" | "rejected" | "cancelled" | "open" | "pending";

export interface OrderStatus {
  state: OrderState;
  filled: number;
  avgPrice: number | null;
  message?: string;
}

export interface ExecBroker {
  place(r: PlaceRequest): Promise<{ ok: true; orderIds: string[] } | { ok: false; error: string }>;
  status(orderId: string): Promise<OrderStatus>;
  cancel(orderId: string): Promise<void>;
}

export interface ExecLeg {
  inst: Instrument;
  side: Side;
  qty: number;
  limit: number;
}

export interface LegResult {
  inst: Instrument;
  side: Side;
  requested: number;
  filled: number;
  avgPrice: number | null;
  orderIds: string[];
  error?: string;
}

export interface UnwindResult {
  inst: Instrument;
  side: Side; // side of the unwind order
  qty: number;
  filled: number;
  avgPrice: number | null;
  orderIds: string[];
  attempts: number;
  error?: string;
}

export type ExecStatus = "filled" | "partial" | "unwound" | "nothing-filled" | "needs-attention";

export interface ExecResult {
  status: ExecStatus;
  matchedQty: number; // complete spreads held (units per leg)
  legs: LegResult[];
  unwinds: UnwindResult[];
  residual: { inst: Instrument; netQty: number }[]; // positions not matched and not closed (needs attention)
  log: string[];
}

export interface ExecDeps {
  broker: ExecBroker;
  /** Risk check right before each order (gateway: server-side checkOrder). */
  check: (r: PlaceRequest) => RiskResult | Promise<RiskResult>;
  /** Protective limit for an unwind of `qty` on `inst` at attempt n (1-based): wider each time. */
  unwindLimit: (inst: Instrument, side: Side, attempt: number) => number | Promise<number>;
  product: "D" | "I";
  tag: string;
  pollMs?: number;
  timeoutMs?: number;
  unwindAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const TERMINAL = new Set<OrderState>(["complete", "rejected", "cancelled"]);

async function settle(ids: string[], d: ExecDeps): Promise<{ filled: number; avgPrice: number | null; error?: string }> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = d.pollMs ?? 300;
  const deadline = (d.timeoutMs ?? 8000) / pollMs;
  let filled = 0, notional = 0;
  const errors: string[] = [];
  for (const id of ids) {
    let st = await d.broker.status(id);
    for (let i = 0; !TERMINAL.has(st.state) && i < deadline; i++) {
      await sleep(pollMs);
      st = await d.broker.status(id);
    }
    if (!TERMINAL.has(st.state)) {
      // IOC should never rest; if it does, cancel and take what filled
      await d.broker.cancel(id);
      st = await d.broker.status(id);
    }
    filled += st.filled;
    if (st.filled > 0 && st.avgPrice !== null) notional += st.filled * st.avgPrice;
    if (st.state === "rejected" && st.message) errors.push(st.message);
  }
  return { filled, avgPrice: filled > 0 ? notional / filled : null, error: errors.length ? errors.join("; ") : undefined };
}

async function placeAndSettle(req: PlaceRequest, d: ExecDeps): Promise<{ filled: number; avgPrice: number | null; orderIds: string[]; error?: string }> {
  const rc = await d.check(req);
  if (!rc.ok) return { filled: 0, avgPrice: null, orderIds: [], error: rc.message };
  const p = await d.broker.place(req);
  if (!p.ok) return { filled: 0, avgPrice: null, orderIds: [], error: p.error };
  const s = await settle(p.orderIds, d);
  return { ...s, orderIds: p.orderIds };
}

const floorLot = (q: number, lot: number): number => Math.floor(q / lot) * lot;

export function orderLegs(legs: ExecLeg[]): ExecLeg[] {
  return [...legs.filter((l) => l.side === "BUY"), ...legs.filter((l) => l.side === "SELL")];
}

export async function executeLegs(input: ExecLeg[], d: ExecDeps): Promise<ExecResult> {
  const legs = orderLegs(input);
  const log: string[] = [];
  const results: LegResult[] = [];
  let target = Infinity;
  for (const leg of legs) {
    const want = Math.min(leg.qty, floorLot(target, leg.inst.lotSize));
    if (!(want > 0)) {
      results.push({ inst: leg.inst, side: leg.side, requested: 0, filled: 0, avgPrice: null, orderIds: [], error: "not sent: an earlier leg did not fill" });
      continue;
    }
    const r = await placeAndSettle({ instrumentKey: leg.inst.key, side: leg.side, qty: want, limit: leg.limit, product: d.product, validity: "IOC", tag: d.tag, purpose: "entry" }, d);
    const filled = floorLot(Math.min(r.filled, want), leg.inst.lotSize);
    results.push({ inst: leg.inst, side: leg.side, requested: want, filled, avgPrice: r.avgPrice, orderIds: r.orderIds, error: r.error });
    log.push(`${leg.side} ${want} ${leg.inst.symbol} @ ≤${leg.limit}: filled ${filled}${r.error ? ` (${r.error})` : ""}`);
    target = Math.min(target, filled);
    if (filled === 0) break;
  }
  // legs never reached
  for (const leg of legs.slice(results.length)) results.push({ inst: leg.inst, side: leg.side, requested: 0, filled: 0, avgPrice: null, orderIds: [], error: "not sent: an earlier leg did not fill" });

  const matched = legs.length ? Math.min(...results.map((r) => r.filled)) : 0;
  const unwinds: UnwindResult[] = [];
  const residual: ExecResult["residual"] = [];
  for (const r of results) {
    const excess = r.filled - matched;
    if (excess <= 0) continue;
    const side: Side = r.side === "BUY" ? "SELL" : "BUY";
    let left = excess, attempts = 0, filledTotal = 0, notional = 0;
    const ids: string[] = [];
    let err: string | undefined;
    const maxAttempts = d.unwindAttempts ?? 3;
    while (left > 0 && attempts < maxAttempts) {
      attempts++;
      const limit = await d.unwindLimit(r.inst, side, attempts);
      const u = await placeAndSettle({ instrumentKey: r.inst.key, side, qty: left, limit, product: d.product, validity: "IOC", tag: d.tag, purpose: "unwind" }, d);
      const f = Math.min(u.filled, left);
      filledTotal += f;
      if (f > 0 && u.avgPrice !== null) notional += f * u.avgPrice;
      left -= f;
      ids.push(...u.orderIds);
      if (u.error) err = u.error;
      log.push(`unwind ${side} ${r.inst.symbol} attempt ${attempts} @ ≤${limit}: filled ${f}, left ${left}`);
    }
    unwinds.push({ inst: r.inst, side, qty: excess, filled: filledTotal, avgPrice: filledTotal ? notional / filledTotal : null, orderIds: ids, attempts, error: left > 0 ? (err ?? "could not close") : undefined });
    if (left > 0) residual.push({ inst: r.inst, netQty: r.side === "BUY" ? left : -left });
  }
  const anyFilled = results.some((r) => r.filled > 0);
  const status: ExecStatus = residual.length ? "needs-attention" : !anyFilled ? "nothing-filled" : matched === 0 ? "unwound" : results.every((r) => r.filled === legs.find((l) => l.inst.key === r.inst.key && l.side === r.side)!.qty) ? "filled" : "partial";
  return { status, matchedQty: matched, legs: results, unwinds, residual, log };
}

/**
 * Close one position with reduce-only IOC limits, widening the limit on each attempt
 * (the kill switch's "Exit all"). Never sends MARKET orders.
 */
export async function closePosition(inst: Instrument, netQty: number, d: ExecDeps): Promise<UnwindResult> {
  const side: Side = netQty > 0 ? "SELL" : "BUY";
  let left = Math.abs(netQty), attempts = 0, filled = 0, notional = 0;
  const ids: string[] = [];
  let err: string | undefined;
  const maxAttempts = d.unwindAttempts ?? 3;
  while (left > 0 && attempts < maxAttempts) {
    attempts++;
    const limit = await d.unwindLimit(inst, side, attempts);
    const u = await placeAndSettle({ instrumentKey: inst.key, side, qty: left, limit, product: d.product, validity: "IOC", tag: d.tag, purpose: "exit" }, d);
    const f = Math.min(u.filled, left);
    filled += f;
    if (f > 0 && u.avgPrice !== null) notional += f * u.avgPrice;
    left -= f;
    ids.push(...u.orderIds);
    if (u.error) err = u.error;
    if (u.error && u.orderIds.length === 0) break; // rejected before sending (risk/market closed): retrying will not help
  }
  return { inst, side, qty: Math.abs(netQty), filled, avgPrice: filled ? notional / filled : null, orderIds: ids, attempts, error: left > 0 ? (err ?? "could not close") : undefined };
}
