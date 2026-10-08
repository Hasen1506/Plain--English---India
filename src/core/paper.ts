// Paper trading against LIVE quotes. Every paper order, fill and position is
// labelled paper and kept apart from the broker's real order book. A paper order
// fills only if the live book would have filled it: a BUY limit at or above the
// live offer fills at the offer, up to the size shown there; a SELL symmetrically.
// Charges are applied as if real, so paper P&L is not flattering.

import type { Instrument } from "./instruments.ts";
import type { Quote } from "./chain.ts";
import type { ExecBroker, OrderStatus, PlaceRequest } from "./execution.ts";
import { charges, type ChargeSegment, derivChargeSegment } from "./charges.ts";
import { round2 } from "./money.ts";
import { istDate } from "./ist.ts";

export interface PaperOrder {
  id: string;
  paper: true;
  ts: number;
  instrumentKey: string;
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  limit: number;
  validity: "IOC" | "DAY";
  product: "D" | "I";
  state: "complete" | "cancelled" | "open" | "rejected";
  filled: number;
  avgPrice: number | null;
  charges: number;
  message?: string;
  tag: string;
}

export interface PaperPosition {
  instrumentKey: string;
  symbol: string;
  qty: number; // + long / − short
  avgPrice: number; // of the open quantity
  realised: number; // closed P&L, before charges
  charges: number; // all charges paid on this instrument
  dayDate: string;
}

export interface PaperState {
  orders: PaperOrder[];
  positions: Record<string, PaperPosition>;
  seq: number;
}

export const emptyPaper = (): PaperState => ({ orders: [], positions: {}, seq: 0 });

export function chargeSegment(inst: Instrument, product: "D" | "I"): ChargeSegment {
  if (inst.type === "CE" || inst.type === "PE" || inst.type === "FUT") return derivChargeSegment(inst);
  return product === "I" ? "EQ_INTRADAY" : "EQ_DELIVERY";
}

/** Apply a fill to a position (average-cost), returning the updated position. */
export function applyFill(p: PaperPosition | undefined, key: string, symbol: string, side: "BUY" | "SELL", qty: number, price: number, fee: number, date: string): PaperPosition {
  const pos: PaperPosition = p ? { ...p } : { instrumentKey: key, symbol, qty: 0, avgPrice: 0, realised: 0, charges: 0, dayDate: date };
  const signed = side === "BUY" ? qty : -qty;
  if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(signed)) {
    const newQty = pos.qty + signed;
    pos.avgPrice = (Math.abs(pos.qty) * pos.avgPrice + qty * price) / Math.abs(newQty);
    pos.qty = newQty;
  } else {
    const closing = Math.min(Math.abs(pos.qty), qty);
    pos.realised = round2(pos.realised + closing * (price - pos.avgPrice) * Math.sign(pos.qty));
    const rest = qty - closing;
    pos.qty += Math.sign(signed) * closing;
    if (rest > 0) {
      pos.qty = Math.sign(signed) * rest;
      pos.avgPrice = price;
    }
    if (pos.qty === 0) pos.avgPrice = 0;
  }
  pos.charges = round2(pos.charges + fee);
  return pos;
}

export function unrealised(p: PaperPosition, ltp: number | null): number | null {
  if (p.qty === 0) return 0;
  if (ltp == null) return null;
  return round2((ltp - p.avgPrice) * p.qty);
}

export class PaperBroker implements ExecBroker {
  state: PaperState;
  private readonly instrument: (key: string) => Instrument | undefined;
  private readonly quote: (key: string) => Promise<Quote | null>;
  private readonly now: () => number;
  private readonly onChange: (s: PaperState) => void;

  constructor(state: PaperState, instrument: (key: string) => Instrument | undefined, quote: (key: string) => Promise<Quote | null>, now: () => number, onChange: (s: PaperState) => void = () => {}) {
    this.state = state;
    this.instrument = instrument;
    this.quote = quote;
    this.now = now;
    this.onChange = onChange;
  }

  async place(r: PlaceRequest): Promise<{ ok: true; orderIds: string[] } | { ok: false; error: string }> {
    const inst = this.instrument(r.instrumentKey);
    if (!inst) return { ok: false, error: "unknown instrument" };
    const q = await this.quote(r.instrumentKey);
    const id = `PAPER-${++this.state.seq}`;
    const o: PaperOrder = { id, paper: true, ts: this.now(), instrumentKey: r.instrumentKey, symbol: inst.symbol, side: r.side, qty: r.qty, limit: r.limit, validity: r.validity, product: r.product, state: "open", filled: 0, avgPrice: null, charges: 0, tag: r.tag };
    this.state.orders.push(o);
    this.tryFill(o, inst, q);
    if (o.state === "open" && r.validity === "IOC") {
      o.state = "cancelled";
      o.message = q ? "IOC: the live book did not reach your limit" : "IOC: no live quote";
    }
    this.onChange(this.state);
    return { ok: true, orderIds: [id] };
  }

  private tryFill(o: PaperOrder, inst: Instrument, q: Quote | null): void {
    if (!q || o.state !== "open") return;
    const left = o.qty - o.filled;
    const touch = o.side === "BUY" ? q.ask : q.bid;
    const depth = o.side === "BUY" ? q.askQty : q.bidQty;
    if (!touch || !(o.side === "BUY" ? o.limit >= touch : o.limit <= touch)) return;
    const lot = inst.lotSize;
    const can = Math.floor(Math.min(left, depth) / lot) * lot;
    if (can <= 0) return;
    const date = istDate(this.now());
    const fee = charges({ segment: chargeSegment(inst, o.product), exchange: inst.exchange, side: o.side, qty: can, price: touch, date, bseGroup: inst.group }).total;
    o.avgPrice = o.filled ? (o.filled * (o.avgPrice ?? 0) + can * touch) / (o.filled + can) : touch;
    o.filled += can;
    o.charges = round2(o.charges + fee);
    if (o.filled === o.qty) o.state = "complete";
    this.state.positions[o.instrumentKey] = applyFill(this.state.positions[o.instrumentKey], o.instrumentKey, inst.symbol, o.side, can, touch, fee, date);
  }

  /** Re-try resting DAY orders against fresh quotes. */
  async sweep(): Promise<void> {
    for (const o of this.state.orders.filter((x) => x.state === "open")) {
      const inst = this.instrument(o.instrumentKey);
      if (inst) this.tryFill(o, inst, await this.quote(o.instrumentKey));
    }
    this.onChange(this.state);
  }

  async status(orderId: string): Promise<OrderStatus> {
    const o = this.state.orders.find((x) => x.id === orderId);
    if (!o) return { state: "rejected", filled: 0, avgPrice: null, message: "unknown paper order" };
    return { state: o.state, filled: o.filled, avgPrice: o.avgPrice, message: o.message };
  }

  async cancel(orderId: string): Promise<void> {
    const o = this.state.orders.find((x) => x.id === orderId);
    if (o && o.state === "open") {
      o.state = "cancelled";
      this.onChange(this.state);
    }
  }

  cancelAll(): number {
    let n = 0;
    for (const o of this.state.orders) {
      if (o.state !== "open") continue;
      o.state = "cancelled";
      n++;
    }
    this.onChange(this.state);
    return n;
  }

  reset(): void {
    this.state = emptyPaper();
    this.onChange(this.state);
  }
}
