// Server-side risk checks. The gateway runs every order through `checkOrder`
// before it reaches the broker; the browser shows the same result in advance.
// Pure functions + a tiny rate limiter, so every rule is unit/property tested.

import type { Instrument, Segment } from "./instruments.ts";
import { checkQuantity, isOnTick, maxPerOrder } from "./rules.ts";
import type { Quote } from "./chain.ts";
import type { MarketSession } from "./calendar.ts";

export const REAL_MONEY_PHRASE = "REAL MONEY";
/** SEBI/NSE retail-algo threshold is 10 orders/second per exchange; we stay well under it. */
export const OPS_HARD_LIMIT = 9;

export interface RiskConfig {
  perTradeCap: number | null; // ₹ worst-case loss (or buy value) per trade; null = off (default)
  dailyLossCap: number | null; // ₹; block new entries once today's P&L ≤ −cap; null = off (default)
  allowedSegments: Segment[];
  maxOrdersPerSecond: number; // ≤ OPS_HARD_LIMIT
  maxSlippage: number; // fraction a limit may cross the touch (entries)
  maxExitSlippage: number; // exits/unwinds may cross further to get out
  quoteMaxAgeMs: number;
  maxSlicesPerLeg: number;
}

export const DEFAULT_RISK: RiskConfig = {
  perTradeCap: null,
  dailyLossCap: null,
  allowedSegments: ["NSE_FO", "BSE_FO", "NSE_EQ", "BSE_EQ", "MCX_FO", "NCD_FO"],
  maxOrdersPerSecond: 5,
  maxSlippage: 0.03,
  maxExitSlippage: 0.25,
  quoteMaxAgeMs: 15_000,
  maxSlicesPerLeg: 10,
};

export type Purpose = "entry" | "exit" | "unwind";

export interface OrderIntent {
  instrumentKey: string;
  side: "BUY" | "SELL";
  qty: number;
  orderType: "LIMIT" | "MARKET" | "SL" | "SL-M";
  limitPrice: number;
  product: "D" | "I";
  purpose: Purpose;
}

export interface RiskState {
  killSwitch: boolean;
  todayPnl: number | null; // realised + unrealised, ₹ (null when unknown)
  netQtyByKey: Record<string, number>; // current net position, for reduce-only exits
}

export interface CheckContext {
  config: RiskConfig;
  state: RiskState;
  inst: Instrument | undefined;
  quote: Quote | null;
  session: MarketSession;
  now: number;
  tradeWorstLoss?: number; // for the whole multi-leg trade (entries)
}

export type RiskCode =
  | "kill-switch" | "unknown-instrument" | "segment" | "order-type" | "quantity" | "freeze" | "tick"
  | "market-closed" | "no-quote" | "stale-quote" | "slippage" | "per-trade-cap" | "daily-loss-cap" | "not-reducing" | "bad-price";

export type RiskResult = { ok: true } | { ok: false; code: RiskCode; message: string };

const no = (code: RiskCode, message: string): RiskResult => ({ ok: false, code, message });

export function checkOrder(o: OrderIntent, c: CheckContext): RiskResult {
  const { config, state, inst, quote, session } = c;
  const entry = o.purpose === "entry";
  if (!inst) return no("unknown-instrument", "Instrument not in today's instrument master.");
  if (state.killSwitch && entry) return no("kill-switch", "Kill switch is on: only exits and cancels are allowed.");
  if (!config.allowedSegments.includes(inst.segment)) return no("segment", `${inst.segment} is not an allowed segment on this gateway.`);
  if (o.orderType !== "LIMIT") return no("order-type", "Only LIMIT orders are sent (no market orders).");
  if (!(o.limitPrice > 0) || !Number.isFinite(o.limitPrice)) return no("bad-price", "Limit price must be positive.");
  const qp = checkQuantity(o.qty, inst);
  if (qp) return no("quantity", qp === "not-lot-multiple" ? `Quantity must be a multiple of the lot size ${inst.lotSize}.` : "Quantity must be a positive whole number.");
  const per = maxPerOrder(inst);
  if (Number.isFinite(per) && Math.ceil(o.qty / per) > config.maxSlicesPerLeg) return no("freeze", `Quantity needs more than ${config.maxSlicesPerLeg} orders at the freeze limit.`);
  if (!isOnTick(o.limitPrice, inst.tickPaise)) return no("tick", `Price must be a multiple of ₹${(inst.tickPaise / 100).toFixed(2)}.`);
  if (!session.canTrade) return no("market-closed", `${session.label}. Orders are only sent during market hours.`);
  if (!quote) return no("no-quote", "No live quote for this instrument.");
  if (!(c.now - quote.ts <= config.quoteMaxAgeMs)) return no("stale-quote", "Quote is too old; refresh prices.");
  const slip = entry ? config.maxSlippage : config.maxExitSlippage;
  if (o.side === "BUY") {
    const ref = quote.ask ?? quote.ltp;
    if (!ref) return no("no-quote", "No offer to buy from.");
    if (o.limitPrice > ref * (1 + slip) + 1e-9) return no("slippage", `Buy limit is more than ${(slip * 100).toFixed(1)}% above the offer.`);
  } else {
    const ref = quote.bid ?? quote.ltp;
    if (!ref) return no("no-quote", "No bid to sell into.");
    if (o.limitPrice < ref * (1 - slip) - 1e-9) return no("slippage", `Sell limit is more than ${(slip * 100).toFixed(1)}% below the bid.`);
  }
  if (!entry) {
    // exits/unwinds must reduce an existing position
    const net = state.netQtyByKey[o.instrumentKey] ?? 0;
    const reduces = (o.side === "SELL" && net >= o.qty) || (o.side === "BUY" && -net >= o.qty);
    if (!reduces) return no("not-reducing", "An exit must reduce an open position by at most its size.");
    return { ok: true };
  }
  if (config.dailyLossCap != null && config.dailyLossCap > 0 && state.todayPnl != null && state.todayPnl <= -config.dailyLossCap)
    return no("daily-loss-cap", `Today's loss has reached your ₹${config.dailyLossCap.toLocaleString("en-IN")} daily cap. New trades are blocked until tomorrow.`);
  if (config.perTradeCap != null && config.perTradeCap > 0) {
    const worst = c.tradeWorstLoss ?? (o.side === "BUY" ? o.qty * o.limitPrice : Infinity);
    if (worst > config.perTradeCap) return no("per-trade-cap", `Worst case ₹${Math.round(worst).toLocaleString("en-IN")} is above your ₹${config.perTradeCap.toLocaleString("en-IN")} per-trade cap.`);
  }
  return { ok: true };
}

/** Sliding one-second window rate limiter (per gateway, all exchanges together: stricter than per-exchange). */
export class RateLimiter {
  private stamps: number[] = [];
  private readonly perSecond: number;
  constructor(perSecond: number) {
    this.perSecond = perSecond;
    if (!(perSecond >= 1) || perSecond > OPS_HARD_LIMIT) throw new Error(`orders/second must be 1…${OPS_HARD_LIMIT}`);
  }
  /** ms to wait before the next order may go (0 = now). Does not record. */
  waitMs(now: number): number {
    this.stamps = this.stamps.filter((t) => now - t < 1000);
    if (this.stamps.length < this.perSecond) return 0;
    return 1000 - (now - this.stamps[0]!);
  }
  record(now: number): void {
    this.stamps.push(now);
  }
  countInLastSecond(now: number): number {
    return this.stamps.filter((t) => now - t < 1000).length;
  }
}

/** Sanitise a risk config coming from the UI. Caps: empty/0/junk = off. */
export function sanitizeRiskConfig(input: Partial<Record<keyof RiskConfig, unknown>>, base: RiskConfig): RiskConfig {
  const cap = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(String(v).replace(/[₹,\s]/g, ""));
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
  };
  return {
    ...base,
    perTradeCap: "perTradeCap" in input ? cap(input.perTradeCap) : base.perTradeCap,
    dailyLossCap: "dailyLossCap" in input ? cap(input.dailyLossCap) : base.dailyLossCap,
  };
}

export function confirmPhraseOk(typed: unknown): boolean {
  return typeof typed === "string" && typed.trim().toUpperCase() === REAL_MONEY_PHRASE;
}

/**
 * Segments that never go live from this app, even with LIVE_TRADING_ENABLED, and why.
 * MCX: Upstox's order API answers UDAPI1161 "MCX orders via API are temporarily disabled"
 * (https://upstox.com/developer/api-documentation/v3/place-order/, read 8 Oct 2026).
 * NSE currency: not yet verified against Upstox's order API, so paper only until it is.
 */
export const LIVE_BLOCKED: Partial<Record<Segment, string>> = {
  MCX_FO: "Commodity trades are paper only: Upstox has disabled MCX orders through its API (UDAPI1161, \"MCX orders via API are temporarily disabled\").",
  NCD_FO: "Currency trades are paper only: live currency orders through the Upstox API are not verified in this app yet.",
};
