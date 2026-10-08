// Charges for one executed fill, from the published schedules.
//
// Every rate below carries its official source. Rates change: each schedule has an
// effective-from date and the calculator picks the one in force on the trade date.
// The review screen ALSO asks the broker's own brokerage API (Upstox
// GET /v2/charges/brokerage) and shows both; the broker's contract note is final.
//
// Sources
//  [UPX]  Upstox brokerage & charges          https://upstox.com/brokerage-charges/
//  [STT]  Finance Act 2026 STT rates (w.e.f. 1 Apr 2026), NSE circular NSE/FATAX/73524 (31 Mar 2026)
//         https://www.nseindia.com/static/invest/first-time-investor-sebi-turnover-fees-stt-other-levies
//  [NTX]  NSE transaction charges w.e.f. 1 Mar 2026, NSE/FA/73061 (27 Feb 2026)
//         https://nsearchives.nseindia.com/content/circulars/FA73061.pdf
//  [NTX24] NSE transaction charges w.e.f. 1 Oct 2024, NSE/FA/64232
//         https://nsearchives.nseindia.com/content/circulars/FA64232.pdf
//  [SEBI] SEBI turnover fee ₹10 per crore (listed on [UPX] and NSE levies page above)
//  [STAMP] Indian Stamp Act amendment (Finance Act 2019), uniform rates from 1 Jul 2020
//         https://upstox.com/announcements/demat-account/revision-in-stamp-duty-rates-on-1st-july-2020/
//  [GST]  18% on brokerage + exchange transaction (incl. IPFT) + DP charges, as stated on [UPX].
//
// Not modelled (shown as notes): STT on exercise of in-the-money options at expiry
// (0.15% of intrinsic value, payable by the buyer, w.e.f. 1 Apr 2026), auto square-off
// fees, MTF interest, pledge fees, contract-note rounding (STT/stamp may be rounded
// to the rupee on the contract note).

import { round2 } from "./money.ts";
import type { Exchange } from "./instruments.ts";

export type ChargeSegment = "EQ_DELIVERY" | "EQ_INTRADAY" | "FUT" | "OPT";
export type Side = "BUY" | "SELL";

export interface Fill {
  segment: ChargeSegment;
  exchange: Exchange;
  side: Side;
  qty: number; // units (not lots)
  price: number; // ₹ per unit (premium for options)
  orders?: number; // executed orders this fill was split into (freeze slicing); brokerage is per executed order
  bseGroup?: string; // BSE equity scrip group for transaction charges
  date: string; // IST trade date YYYY-MM-DD (selects the schedule)
}

export interface ChargeBreakdown {
  turnover: number;
  brokerage: number;
  stt: number;
  exchangeTxn: number;
  sebiFee: number;
  stampDuty: number;
  gst: number;
  dp: number;
  total: number;
  scheduleId: string;
  notes: string[];
}

type PerSeg<T> = Record<ChargeSegment, T>;

export interface Schedule {
  id: string;
  from: string; // effective from (inclusive), IST date
  sources: string[];
  brokerage: PerSeg<{ flat: number; pct: number | null }>; // min(flat, pct × turnover) when pct set
  brokerageCapPct: number; // SEBI cap on brokerage as % of turnover (2.5%)
  stt: PerSeg<{ buy: number; sell: number }>; // fraction of turnover (premium for options)
  nseTxn: PerSeg<number>; // fraction of turnover
  bseTxn: { FUT: number; OPT: number; eqByGroup: Record<string, number>; eqDefault: number | null };
  sebiPerCrore: number;
  stampBuy: PerSeg<number>;
  gstRate: number;
  dpPerScripSell: number; // ₹ per scrip per day on delivery sells (+GST)
}

const PCT = (p: number): number => p / 100;
const PER_CRORE = (r: number): number => r / 1e7;

const BROKERAGE_UPSTOX: Schedule["brokerage"] = {
  EQ_DELIVERY: { flat: 20, pct: null },
  EQ_INTRADAY: { flat: 20, pct: PCT(0.1) },
  FUT: { flat: 20, pct: PCT(0.05) },
  OPT: { flat: 20, pct: null },
};
const STAMP: Schedule["stampBuy"] = { EQ_DELIVERY: PCT(0.015), EQ_INTRADAY: PCT(0.003), FUT: PCT(0.002), OPT: PCT(0.003) };
// BSE equity: groups A/B 0.00375%; X, XC, XD, XT, Z, ZP ₹10,000/crore; SS, ST ₹1,00,000/crore [UPX]
const BSE_EQ_GROUPS: Record<string, number> = {
  A: PCT(0.00375), B: PCT(0.00375),
  X: PER_CRORE(10_000), XC: PER_CRORE(10_000), XD: PER_CRORE(10_000), XT: PER_CRORE(10_000), Z: PER_CRORE(10_000), ZP: PER_CRORE(10_000),
  SS: PER_CRORE(100_000), ST: PER_CRORE(100_000),
};

export const SCHEDULES: Schedule[] = [
  {
    id: "2024-10-01",
    from: "2024-10-01",
    sources: ["[UPX]", "[NTX24]", "Finance (No. 2) Act 2024 STT"],
    brokerage: BROKERAGE_UPSTOX,
    brokerageCapPct: PCT(2.5),
    stt: { EQ_DELIVERY: { buy: PCT(0.1), sell: PCT(0.1) }, EQ_INTRADAY: { buy: 0, sell: PCT(0.025) }, FUT: { buy: 0, sell: PCT(0.02) }, OPT: { buy: 0, sell: PCT(0.1) } },
    nseTxn: { EQ_DELIVERY: PCT(0.00297), EQ_INTRADAY: PCT(0.00297), FUT: PCT(0.00173), OPT: PCT(0.03503) },
    bseTxn: { FUT: 0, OPT: PCT(0.0325), eqByGroup: BSE_EQ_GROUPS, eqDefault: null },
    sebiPerCrore: 10,
    stampBuy: STAMP,
    gstRate: 0.18,
    dpPerScripSell: 20,
  },
  {
    // NSE rolled IPFT back into transaction charges; total outflow per crore: cash ₹307, futures ₹183, options ₹3,553 (premium)
    id: "2026-03-01",
    from: "2026-03-01",
    sources: ["[UPX]", "[NTX]"],
    brokerage: BROKERAGE_UPSTOX,
    brokerageCapPct: PCT(2.5),
    stt: { EQ_DELIVERY: { buy: PCT(0.1), sell: PCT(0.1) }, EQ_INTRADAY: { buy: 0, sell: PCT(0.025) }, FUT: { buy: 0, sell: PCT(0.02) }, OPT: { buy: 0, sell: PCT(0.1) } },
    nseTxn: { EQ_DELIVERY: PER_CRORE(307), EQ_INTRADAY: PER_CRORE(307), FUT: PER_CRORE(183), OPT: PER_CRORE(3553) },
    bseTxn: { FUT: 0, OPT: PCT(0.0325), eqByGroup: BSE_EQ_GROUPS, eqDefault: null },
    sebiPerCrore: 10,
    stampBuy: STAMP,
    gstRate: 0.18,
    dpPerScripSell: 20,
  },
  {
    // Finance Act 2026: STT futures 0.05%, options 0.15% of premium (sell side)
    id: "2026-04-01",
    from: "2026-04-01",
    sources: ["[UPX]", "[NTX]", "[STT]"],
    brokerage: BROKERAGE_UPSTOX,
    brokerageCapPct: PCT(2.5),
    stt: { EQ_DELIVERY: { buy: PCT(0.1), sell: PCT(0.1) }, EQ_INTRADAY: { buy: 0, sell: PCT(0.025) }, FUT: { buy: 0, sell: PCT(0.05) }, OPT: { buy: 0, sell: PCT(0.15) } },
    nseTxn: { EQ_DELIVERY: PER_CRORE(307), EQ_INTRADAY: PER_CRORE(307), FUT: PER_CRORE(183), OPT: PER_CRORE(3553) },
    bseTxn: { FUT: 0, OPT: PCT(0.0325), eqByGroup: BSE_EQ_GROUPS, eqDefault: null },
    sebiPerCrore: 10,
    stampBuy: STAMP,
    gstRate: 0.18,
    dpPerScripSell: 20,
  },
];

export const OPTION_EXERCISE_STT = PCT(0.15); // w.e.f. 1 Apr 2026, on intrinsic value, payable by the buyer [STT]

export function scheduleFor(date: string): Schedule {
  let s: Schedule | undefined;
  for (const c of SCHEDULES) if (c.from <= date) s = c;
  if (!s) throw new Error(`no charge schedule for ${date} (earliest ${SCHEDULES[0]!.from})`);
  return s;
}

/** Charges on one fill. Each component is rounded to the paisa, as brokers do per order. */
export function charges(f: Fill): ChargeBreakdown {
  const s = scheduleFor(f.date);
  const notes: string[] = [];
  if (!(f.qty > 0) || !(f.price >= 0) || !Number.isFinite(f.qty * f.price)) throw new Error("bad fill");
  const orders = Math.max(1, Math.floor(f.orders ?? 1));
  const turnover = f.qty * f.price;

  // brokerage: per executed order. With slicing, each order's turnover is its share.
  const b = s.brokerage[f.segment];
  const perOrderTurnover = turnover / orders;
  let brokerage = orders * (b.pct === null ? b.flat : Math.min(b.flat, b.pct * perOrderTurnover));
  brokerage = Math.min(brokerage, s.brokerageCapPct * turnover); // SEBI ceiling (relevant for tiny orders)

  const sttRate = f.side === "BUY" ? s.stt[f.segment].buy : s.stt[f.segment].sell;
  const stt = sttRate * turnover;

  let txnRate: number;
  if (f.exchange === "NSE") txnRate = s.nseTxn[f.segment];
  else if (f.segment === "FUT" || f.segment === "OPT") txnRate = s.bseTxn[f.segment];
  else {
    const g = (f.bseGroup ?? "").toUpperCase();
    const r = s.bseTxn.eqByGroup[g] ?? s.bseTxn.eqDefault;
    if (r == null) {
      notes.push(`BSE transaction charge for scrip group "${g || "?"}" is not in the schedule; check the broker's figure.`);
      txnRate = BSE_EQ_GROUPS.A!;
    } else txnRate = r;
  }
  const exchangeTxn = txnRate * turnover;
  const sebiFee = PER_CRORE(s.sebiPerCrore) * turnover;
  const stampDuty = f.side === "BUY" ? s.stampBuy[f.segment] * turnover : 0;
  const dp = f.segment === "EQ_DELIVERY" && f.side === "SELL" ? s.dpPerScripSell : 0;
  if (dp) notes.push("DP charge is per scrip per day: selling the same stock again today does not add it twice.");

  const r = {
    brokerage: round2(brokerage),
    stt: round2(stt),
    exchangeTxn: round2(exchangeTxn),
    sebiFee: round2(sebiFee),
    stampDuty: round2(stampDuty),
    dp: round2(dp),
  };
  const gst = round2(s.gstRate * (r.brokerage + r.exchangeTxn + r.dp));
  const total = round2(r.brokerage + r.stt + r.exchangeTxn + r.sebiFee + r.stampDuty + r.dp + gst);
  if (f.segment === "OPT" && f.side === "BUY") notes.push("If this option ends in the money and is exercised, STT of 0.15% of its intrinsic value is charged at expiry.");
  return { turnover: round2(turnover), ...r, gst, total, scheduleId: s.id, notes };
}

export function sumCharges(list: ChargeBreakdown[]): ChargeBreakdown {
  const z: ChargeBreakdown = { turnover: 0, brokerage: 0, stt: 0, exchangeTxn: 0, sebiFee: 0, stampDuty: 0, gst: 0, dp: 0, total: 0, scheduleId: list[0]?.scheduleId ?? "", notes: [] };
  for (const c of list) {
    for (const k of ["turnover", "brokerage", "stt", "exchangeTxn", "sebiFee", "stampDuty", "gst", "dp", "total"] as const) z[k] = round2(z[k] + c[k]);
    for (const n of c.notes) if (!z.notes.includes(n)) z.notes.push(n);
  }
  return z;
}

/** STT due at expiry when a bought option finishes in the money (cash-settled index options). */
export function exerciseStt(intrinsicPerUnit: number, qty: number): number {
  return round2(Math.max(0, intrinsicPerUnit) * qty * OPTION_EXERCISE_STT);
}

export const CHARGE_LABELS: Record<keyof Omit<ChargeBreakdown, "scheduleId" | "notes" | "turnover" | "total">, string> = {
  brokerage: "Brokerage",
  stt: "STT",
  exchangeTxn: "Exchange transaction",
  sebiFee: "SEBI turnover fee",
  stampDuty: "Stamp duty",
  gst: "GST (18%)",
  dp: "DP charge",
};
