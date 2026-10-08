// Turn a plain-English view into defined-risk vertical spreads on the live chain.
//
//   "Nifty stays above 25,000"  → bull put credit spread at 25,000   (alt: bull call debit spread)
//   "Nifty goes above 25,000"   → bull call debit spread ATM → 25,000 (alt: bull put credit at 25,000)
//   "Nifty stays below 25,000"  → bear call credit spread at 25,000  (alt: bear put debit spread)
//   "Nifty falls to 25,000"     → bear put debit spread ATM → 25,000 (alt: bear call credit at 25,000)
//
// Index options are European and cash-settled: they pay on where the index settles on
// expiry day, not on whether it touched the level before. The plain sentence says so.
//
// Prices are the live book: buy legs at the ask, sell legs at the bid, on the tick.
// The limit actually sent crosses the touch by at most `slippage`; sizing uses that
// worst case so the money at risk never exceeds what the user said.

import type { Chain, ChainSide, Quote } from "./chain.ts";
import { smile, ivAt, strikeStep } from "./chain.ts";
import type { Instrument } from "./instruments.ts";
import { displayName } from "./instruments.ts";
import { probAbove, yearsTo } from "./math.ts";
import { alignToTick, protectiveLimit, sliceQuantity, liquidity } from "./rules.ts";
import { charges, sumCharges, derivChargeSegment, type ChargeBreakdown, type Side } from "./charges.ts";
import { inr, num, round2 } from "./money.ts";
import { istDate, shortDate } from "./ist.ts";

export type Direction = "above" | "below";
export type Mode = "stays" | "reaches";

export interface View {
  underlying: string;
  dir: Direction;
  mode: Mode;
  level: number;
  expiryDate: string;
  risk: number; // ₹ the user is willing to lose (max loss incl. entry charges)
}

export type Kind = "bull-put-credit" | "bull-call-debit" | "bear-call-credit" | "bear-put-debit";

export interface Leg {
  inst: Instrument;
  side: Side;
  qty: number; // units
  quote: Quote;
  price: number; // touch: ask for BUY, bid for SELL (tick-aligned)
  limit: number; // price sent: touch ± slippage, on the tick
  slices: number[]; // freeze-quantity split
}

export interface Suggestion {
  id: string;
  kind: Kind;
  title: string; // "Bull put spread"
  plain: string; // one-sentence explanation
  legs: Leg[]; // BUY legs first: the hedge is placed before the short leg
  lots: number;
  lotSize: number;
  qty: number;
  credit: boolean;
  netPerUnit: number; // + credit received / − debit paid, at the touch
  worstNetPerUnit: number; // same at the limit prices
  width: number;
  maxProfit: number; // ₹, at the touch, before charges
  maxLoss: number; // ₹, at the touch, before charges (positive number)
  worstMaxLoss: number; // ₹, at the limits, plus entry charges: what sizing respects
  breakeven: number;
  probProfit: number | null; // risk-neutral P(settles beyond breakeven)
  probMaxProfit: number | null;
  entryCharges: ChargeBreakdown;
  exitChargesIfClosed: ChargeBreakdown; // estimate if both legs are closed at today's prices
  maxLossPerLot: number;
  warnings: string[];
}

export type SuggestFail =
  | { reason: "no-chain" }
  | { reason: "no-strikes"; detail: string }
  | { reason: "illiquid"; detail: string }
  | { reason: "risk-too-small"; minRisk: number; kind: Kind }
  | { reason: "expired" };

export interface SuggestResult {
  suggestions: Suggestion[];
  failures: { kind: Kind; fail: SuggestFail }[];
  spot: number;
  step: number;
  T: number;
}

export interface SuggestOptions {
  now: number;
  slippage?: number; // fraction, default 2%
  maxWidthSteps?: number; // widths tried for the narrow spreads, default 6
  maxSpreadPct?: number; // illiquidity threshold
}

const KIND_TITLE: Record<Kind, string> = {
  "bull-put-credit": "Bull put spread (credit)",
  "bull-call-debit": "Bull call spread (debit)",
  "bear-call-credit": "Bear call spread (credit)",
  "bear-put-debit": "Bear put spread (debit)",
};

interface Strikes {
  long: number;
  short: number;
}

function sideOf(chain: Chain, strike: number, type: "CE" | "PE"): ChainSide | null {
  const r = chain.rows.find((x) => x.strike === strike);
  return (type === "CE" ? r?.call : r?.put) ?? null;
}

const legType = (k: Kind): "CE" | "PE" => (k === "bull-put-credit" || k === "bear-put-debit" ? "PE" : "CE");
const isCredit = (k: Kind): boolean => k === "bull-put-credit" || k === "bear-call-credit";
const isBull = (k: Kind): boolean => k.startsWith("bull");

/** Expiry payoff per unit of one spread, excluding charges. */
export function spreadPayoff(kind: Kind, s: Strikes, netPerUnit: number, S: number): number {
  const call = (K: number): number => Math.max(S - K, 0);
  const put = (K: number): number => Math.max(K - S, 0);
  const t = legType(kind);
  const v = t === "CE" ? call(s.long) - call(s.short) : put(s.long) - put(s.short);
  return v + netPerUnit;
}

/** Payoff of an arbitrary set of legs at expiry (per the given quantities, ₹), entry at `price`. */
export function legsPayoff(legs: Pick<Leg, "inst" | "side" | "qty" | "price">[], S: number): number {
  let v = 0;
  for (const l of legs) {
    const K = l.inst.strike!;
    const intrinsic = l.inst.type === "CE" ? Math.max(S - K, 0) : Math.max(K - S, 0);
    const sign = l.side === "BUY" ? 1 : -1;
    v += sign * (intrinsic - l.price) * l.qty;
  }
  return v;
}

function chooseStrikes(kind: Kind, view: View, ks: number[], spot: number, widthSteps: number, step: number): Strikes | null {
  const L = view.level;
  const le = ks.filter((k) => k <= L + 1e-9);
  const ge = ks.filter((k) => k >= L - 1e-9);
  const narrow = view.mode === "stays" || (view.mode === "reaches" && isCredit(kind));
  if (isBull(kind)) {
    // profit region: settles ≥ L. High strike = largest listed ≤ L.
    const hi = le.length ? le[le.length - 1]! : null;
    if (hi === null) return null;
    let lo: number | undefined;
    if (narrow) lo = ks.filter((k) => k <= hi - widthSteps * step + 1e-9).pop();
    else lo = ks.filter((k) => k <= spot && k < hi).pop(); // ATM (at or just below spot)
    if (lo === undefined) return null;
    return kind === "bull-put-credit" ? { short: hi, long: lo } : { long: lo, short: hi };
  } else {
    // profit region: settles ≤ L. Low strike = smallest listed ≥ L.
    const lo = ge.length ? ge[0]! : null;
    if (lo === null) return null;
    let hi: number | undefined;
    if (narrow) hi = ks.find((k) => k >= lo + widthSteps * step - 1e-9);
    else hi = ks.find((k) => k >= spot && k > lo);
    if (hi === undefined) return null;
    return kind === "bear-call-credit" ? { short: lo, long: hi } : { long: hi, short: lo };
  }
}

function buildLeg(side: Side, s: ChainSide, qty: number, slippage: number): Leg | { illiquid: string } {
  const q = s.q;
  const touch = side === "BUY" ? q?.ask : q?.bid;
  if (!q || !touch) return { illiquid: `${s.inst.symbol}: no live ${side === "BUY" ? "offer" : "bid"}` };
  const price = alignToTick(touch, s.inst.tickPaise, side === "BUY" ? "up" : "down");
  const limit = protectiveLimit(side, price, s.inst.tickPaise, slippage);
  return { inst: s.inst, side, qty, quote: q, price, limit, slices: sliceQuantity(qty, s.inst) };
}

function legCharges(legs: Leg[], date: string, useLimit: boolean): ChargeBreakdown {
  return sumCharges(
    legs.map((l) => charges({ segment: derivChargeSegment(l.inst), exchange: l.inst.exchange, side: l.side, qty: l.qty, price: useLimit ? l.limit : l.price, orders: l.slices.length, date })),
  );
}

function exitCharges(legs: Leg[], date: string): ChargeBreakdown {
  // closing = the opposite side, at today's opposite touch (mid when absent)
  return sumCharges(
    legs.map((l) => {
      const side: Side = l.side === "BUY" ? "SELL" : "BUY";
      const px = (side === "SELL" ? l.quote.bid : l.quote.ask) ?? l.quote.ltp ?? l.price;
      return charges({ segment: derivChargeSegment(l.inst), exchange: l.inst.exchange, side, qty: l.qty, price: Math.max(px, 0.05), orders: l.slices.length, date });
    }),
  );
}

function plainSentence(kind: Kind, view: View, s: Strikes, lots: number, lotSize: number, breakeven: number, maxProfit: number, maxLoss: number): string {
  const u = displayName(view.underlying);
  const when = shortDate(view.expiryDate);
  const t = legType(kind) === "CE" ? "call" : "put";
  const legsTxt = `buy the ${num(s.long, 0)} ${t} and sell the ${num(s.short, 0)} ${t}, ${lots} lot${lots === 1 ? "" : "s"} of ${lotSize}`;
  const edge = isBull(kind) ? `settles at or above ${num(Math.max(s.long, s.short), 0)}` : `settles at or below ${num(Math.min(s.long, s.short), 0)}`;
  return `${legsTxt}. You make up to ${inr(maxProfit)} if ${u} ${edge} on ${when}, break even at ${num(breakeven, 2)}, and can lose at most ${inr(maxLoss)} (before charges).`;
}

function evaluate(kind: Kind, view: View, chain: Chain, s: Strikes, opt: Required<SuggestOptions>, T: number, smilePts: ReturnType<typeof smile>): Suggestion | SuggestFail {
  const t = legType(kind);
  const longSide = sideOf(chain, s.long, t), shortSide = sideOf(chain, s.short, t);
  if (!longSide || !shortSide) return { reason: "no-strikes", detail: `${num(s.long, 0)}/${num(s.short, 0)} ${t} not listed` };
  const lotSize = longSide.inst.lotSize;
  const width = Math.abs(s.short - s.long);
  const probeLong = buildLeg("BUY", longSide, lotSize, opt.slippage);
  const probeShort = buildLeg("SELL", shortSide, lotSize, opt.slippage);
  if ("illiquid" in probeLong) return { reason: "illiquid", detail: probeLong.illiquid };
  if ("illiquid" in probeShort) return { reason: "illiquid", detail: probeShort.illiquid };
  for (const [leg, side] of [[probeLong, "BUY"], [probeShort, "SELL"]] as const) {
    const lq = liquidity(leg.quote.bid ?? 0, leg.quote.ask ?? 0, leg.quote.bidQty, leg.quote.askQty, side, 0, opt.maxSpreadPct);
    if (!lq.ok && lq.reason !== "thin") return { reason: "illiquid", detail: `${leg.inst.symbol}: ${lq.reason === "wide-spread" ? `bid–ask spread ${(lq.spreadPct * 100).toFixed(0)}%` : lq.reason}` };
  }
  const net = probeShort.price - probeLong.price; // + credit / − debit
  const worstNet = probeShort.limit - probeLong.limit;
  const credit = isCredit(kind);
  if (credit ? !(net > 0) : !(-net > 0)) return { reason: "no-strikes", detail: "no edge at these prices" };
  const maxLossUnit = credit ? width - net : -net;
  const maxProfitUnit = credit ? net : width + net;
  const worstLossUnit = credit ? width - worstNet : -worstNet;
  if (!(maxLossUnit > 0) || !(maxProfitUnit > 0)) return { reason: "no-strikes", detail: "no edge at these prices" };

  const date = istDate(opt.now);
  // largest lot count whose worst-case loss + entry charges fits the risk
  let lots = Math.floor(view.risk / (worstLossUnit * lotSize));
  const make = (n: number): Leg[] => {
    const q = n * lotSize;
    return [
      { ...probeLong, qty: q, slices: sliceQuantity(q, longSide.inst) },
      { ...probeShort, qty: q, slices: sliceQuantity(q, shortSide.inst) },
    ];
  };
  while (lots > 0 && lots * worstLossUnit * lotSize + legCharges(make(lots), date, true).total > view.risk) lots--;
  const minRisk = round2(worstLossUnit * lotSize + legCharges(make(1), date, true).total);
  if (lots < 1) return { reason: "risk-too-small", minRisk, kind };
  // never size above what the book shows at the best prices on either leg: a bigger order fills
  // one leg partly and leaves the other to unwind (found on thin MCX option books)
  const depthLots = Math.min(Math.floor(probeLong.quote.askQty / lotSize), Math.floor(probeShort.quote.bidQty / lotSize));
  const capped = depthLots >= 1 && depthLots < lots;
  if (capped) lots = depthLots;

  const legs = make(lots);
  const qty = lots * lotSize;
  const entry = legCharges(legs, date, false);
  const worstEntry = legCharges(legs, date, true);
  const breakeven = kind === "bull-put-credit" ? s.short - net : kind === "bull-call-debit" ? s.long - net : kind === "bear-call-credit" ? s.short + net : s.long + net;
  const above = isBull(kind);
  const pAt = (K: number): number | null => {
    const iv = ivAt(smilePts, K);
    if (iv === null || !(T > 0)) return null;
    const p = probAbove(chain.spot, K, T, iv);
    return above ? p : 1 - p;
  };
  const warnings: string[] = [];
  if (capped) warnings.push(`Sized to ${lots} lot${lots === 1 ? "" : "s"}: that is all the order book shows at the best prices. Risking more would not fill both legs.`);
  for (const l of legs) {
    const depth = l.side === "BUY" ? l.quote.askQty : l.quote.bidQty;
    if (depth < l.qty) warnings.push(`${l.inst.symbol}: only ${depth} at the best ${l.side === "BUY" ? "offer" : "bid"}; the order may fill partly.`);
    if (l.slices.length > 1) warnings.push(`${l.inst.symbol}: ${l.qty} is above the freeze quantity, so it goes as ${l.slices.length} orders (₹20 brokerage each).`);
  }
  const maxProfit = round2(maxProfitUnit * qty);
  const maxLoss = round2(maxLossUnit * qty);
  return {
    id: `${kind}:${s.long}:${s.short}:${view.expiryDate}`,
    kind,
    title: KIND_TITLE[kind],
    plain: plainSentence(kind, view, s, lots, lotSize, breakeven, maxProfit, maxLoss),
    legs,
    lots,
    lotSize,
    qty,
    credit,
    netPerUnit: round2(net),
    worstNetPerUnit: round2(worstNet),
    width,
    maxProfit,
    maxLoss,
    worstMaxLoss: round2(worstLossUnit * qty + worstEntry.total),
    breakeven: round2(breakeven),
    probProfit: pAt(breakeven),
    probMaxProfit: pAt(above ? Math.max(s.long, s.short) : Math.min(s.long, s.short)),
    entryCharges: entry,
    exitChargesIfClosed: exitCharges(legs, date),
    maxLossPerLot: round2(maxLossUnit * lotSize),
    warnings,
  };
}

export function kindsFor(view: Pick<View, "dir" | "mode">): Kind[] {
  if (view.dir === "above") return view.mode === "stays" ? ["bull-put-credit", "bull-call-debit"] : ["bull-call-debit", "bull-put-credit"];
  return view.mode === "stays" ? ["bear-call-credit", "bear-put-debit"] : ["bear-put-debit", "bear-call-credit"];
}

/** Suggestions for a view on a live chain. Pure: same inputs → same output. */
export function suggest(view: View, chain: Chain | null, o: SuggestOptions): SuggestResult {
  const opt: Required<SuggestOptions> = { slippage: 0.02, maxWidthSteps: 6, maxSpreadPct: 0.25, ...o };
  const failures: SuggestResult["failures"] = [];
  const kinds = kindsFor(view);
  if (!chain || !chain.rows.length || !(chain.spot > 0)) return { suggestions: [], failures: kinds.map((kind) => ({ kind, fail: { reason: "no-chain" } })), spot: chain?.spot ?? NaN, step: 0, T: 0 };
  const T = yearsTo(chain.expiryMs, opt.now);
  if (!(chain.expiryMs > opt.now)) return { suggestions: [], failures: kinds.map((kind) => ({ kind, fail: { reason: "expired" } })), spot: chain.spot, step: 0, T };
  const ks = chain.rows.map((r) => r.strike);
  const step = strikeStep(chain);
  const pts = smile(chain, opt.now);
  const suggestions: Suggestion[] = [];
  for (const kind of kinds) {
    const narrow = view.mode === "stays" || isCredit(kind);
    const widths = narrow ? Array.from({ length: opt.maxWidthSteps }, (_, i) => i + 1) : [0];
    let best: Suggestion | null = null;
    let lastFail: SuggestFail | null = null;
    let minRisk = Infinity;
    for (const w of widths) {
      const s = chooseStrikes(kind, view, ks, chain.spot, w, step);
      if (!s) {
        lastFail ??= { reason: "no-strikes", detail: `no listed strikes for ${KIND_TITLE[kind]} at ${num(view.level, 0)}` };
        continue;
      }
      const r = evaluate(kind, view, chain, s, opt, T, pts);
      if ("reason" in r) {
        if (r.reason === "risk-too-small") minRisk = Math.min(minRisk, r.minRisk);
        else lastFail = r;
        continue;
      }
      // most profit within the risk; ties → the narrower spread
      if (!best || r.maxProfit > best.maxProfit + 1e-9) best = r;
    }
    if (best) suggestions.push(best);
    else failures.push({ kind, fail: Number.isFinite(minRisk) ? { reason: "risk-too-small", minRisk, kind } : (lastFail ?? { reason: "no-strikes", detail: "no strikes" }) });
  }
  return { suggestions, failures, spot: chain.spot, step, T };
}

export function describeFail(f: SuggestFail): string {
  switch (f.reason) {
    case "no-chain": return "No live option chain from the broker right now.";
    case "expired": return "That expiry has passed.";
    case "illiquid": return `Not tradable safely: ${f.detail}.`;
    case "no-strikes": return f.detail.charAt(0).toUpperCase() + f.detail.slice(1) + ".";
    case "risk-too-small": return `One lot can lose up to ${inr(f.minRisk)} including charges. Raise the amount you're risking to at least that.`;
  }
}

/** Points for a payoff chart: P&L in ₹ at expiry across [lo, hi], net of entry charges. */
export function payoffCurve(sg: Suggestion, lo: number, hi: number, n = 81): { S: number; pnl: number }[] {
  const out: { S: number; pnl: number }[] = [];
  for (let i = 0; i < n; i++) {
    const S = lo + ((hi - lo) * i) / (n - 1);
    out.push({ S, pnl: round2(legsPayoff(sg.legs, S) - sg.entryCharges.total) });
  }
  return out;
}
