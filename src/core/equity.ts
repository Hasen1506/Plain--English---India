// Plain-English cash equity orders: "buy ₹20,000 of Reliance", "sell 10 TCS at 3,450",
// "buy 5 shares of Infosys intraday". Always a LIMIT order: at the user's price, or
// at the touch plus a small protective margin when they say "at market".

import { parseRupees, round2 } from "./money.ts";
import { alignToTick, protectiveLimit } from "./rules.ts";
import type { Instrument } from "./instruments.ts";
import type { Quote } from "./chain.ts";
import { charges, type ChargeBreakdown, type Side } from "./charges.ts";
import { istDate } from "./ist.ts";

export interface ParsedEquity {
  side: Side | null;
  query: string | null; // what to look up (symbol or company name)
  qty: number | null;
  amount: number | null; // ₹ to invest (buy) or raise (sell)
  price: number | null; // limit the user gave
  product: "D" | "I";
  missing: ("side" | "stock" | "size")[];
}

export function parseEquity(input: string): ParsedEquity {
  const t = input.toLowerCase().replace(/\s+/g, " ").trim();
  const side: Side | null = /\b(buy|purchase|invest|add)\b/.test(t) ? "BUY" : /\b(sell|exit|book|dump|trim)\b/.test(t) ? "SELL" : null;
  const product = /\b(intraday|mis|today only|day trade)\b/.test(t) ? "I" : "D";
  let price: number | null = null;
  const pm = /\b(?:at|@|limit(?: price)?(?: of)?)\s*(?:₹|rs\.?\s*)?(\d[\d,]*(?:\.\d+)?)\b/.exec(t);
  let rest = t;
  if (pm) {
    price = Number(pm[1]!.replace(/,/g, ""));
    rest = rest.replace(pm[0], " ");
  }
  let amount: number | null = null;
  const am = /(?:₹|rs\.?\s*|inr\s*)(\d[\d,]*(?:\.\d+)?\s*(?:k|lakhs?|lac|l|cr|crores?)?)|(\d[\d,]*(?:\.\d+)?\s*(?:k|lakhs?|lac|cr|crores?))\b|\bworth\s+(?:of\s+)?(?:₹|rs\.?\s*)?(\d[\d,]*(?:\.\d+)?\s*(?:k|lakhs?|lac|l|cr|crores?)?)/.exec(rest);
  if (am) {
    amount = parseRupees(am[1] ?? am[2] ?? am[3] ?? "");
    rest = rest.replace(am[0], " ");
  }
  let qty: number | null = null;
  const qm = /\b(\d+)\s*(?:shares?|qty|units?|stocks?)?\b/.exec(rest);
  if (qm && amount === null) {
    qty = Number(qm[1]);
    rest = rest.replace(qm[0], " ");
  }
  const query = rest
    .replace(/\b(i want to|i'd like to|please|buy|purchase|invest|add|sell|exit|book|dump|trim|shares?|of|in|worth|intraday|mis|delivery|cnc|at market|market|today only|day trade|stock|the|my|some|qty|units?)\b/g, " ")
    .replace(/[^a-z0-9&.\- ]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || null;
  const missing: ParsedEquity["missing"] = [];
  if (!side) missing.push("side");
  if (!query) missing.push("stock");
  if (qty === null && amount === null) missing.push("size");
  return { side, query, qty, amount, price, product, missing };
}

export interface EquityTicket {
  inst: Instrument;
  side: Side;
  qty: number;
  limit: number;
  product: "D" | "I";
  value: number;
  charges: ChargeBreakdown;
  touch: number | null;
  warnings: string[];
}

export type TicketFail = "no-quote" | "zero-qty" | "bad-price";

/** Size and price an equity order from a live quote. */
export function equityTicket(p: ParsedEquity & { side: Side }, inst: Instrument, q: Quote | null, now: number, slippage = 0.005): EquityTicket | { fail: TicketFail } {
  const touch = p.side === "BUY" ? (q?.ask ?? q?.ltp ?? null) : (q?.bid ?? q?.ltp ?? null);
  let limit: number;
  if (p.price !== null) {
    if (!(p.price > 0)) return { fail: "bad-price" };
    limit = alignToTick(p.price, inst.tickPaise, p.side === "BUY" ? "down" : "up");
  } else {
    if (!touch) return { fail: "no-quote" };
    limit = protectiveLimit(p.side, touch, inst.tickPaise, slippage);
  }
  const qty = p.qty ?? Math.floor((p.amount ?? 0) / limit);
  if (!(qty >= 1)) return { fail: "zero-qty" };
  const warnings: string[] = [];
  if (p.price !== null && touch && Math.abs(p.price / touch - 1) > 0.05) warnings.push(`Your price is ${((p.price / touch - 1) * 100).toFixed(1)}% from the market.`);
  if (q?.bid == null || q?.ask == null) warnings.push("No full order book in the quote; the limit is based on the last traded price.");
  const date = istDate(now);
  return {
    inst,
    side: p.side,
    qty,
    limit,
    product: p.product,
    value: round2(qty * limit),
    charges: charges({ segment: p.product === "I" ? "EQ_INTRADAY" : "EQ_DELIVERY", exchange: inst.exchange, side: p.side, qty, price: limit, date, bseGroup: inst.group }),
    touch,
    warnings,
  };
}
