// An INDEPENDENT reference for the charges calculator, written separately from
// src/core/charges.ts straight from the published tables, in integer
// "milli-paise per crore" arithmetic so it shares no code or float path.
//
//   Upstox: https://upstox.com/brokerage-charges/  (brokerage, GST base, stamp, DP)
//   NSE txn w.e.f. 1 Mar 2026 (NSE/FA/73061): ₹307 / ₹183 / ₹3,553 per crore (cash / fut / opt premium)
//   BSE: options 0.0325% of premium; futures nil; A/B group equity 0.00375%
//   STT w.e.f. 1 Apr 2026 (Finance Act 2026): delivery 0.1% both sides; intraday 0.025% sell; fut 0.05% sell; opt 0.15% sell
//   SEBI ₹10/crore; stamp (buy) 0.015% delivery, 0.003% intraday, 0.002% fut, 0.003% opt
//
// Only the schedule in force from 2026-04-01 is encoded here.

type Seg = "EQ_DELIVERY" | "EQ_INTRADAY" | "FUT" | "OPT";

// rates in rupees per crore of turnover
const PER_CRORE = {
  sttBuy: { EQ_DELIVERY: 10_000, EQ_INTRADAY: 0, FUT: 0, OPT: 0 }, // 0.1% of ₹1 crore = ₹10,000
  sttSell: { EQ_DELIVERY: 10_000, EQ_INTRADAY: 2_500, FUT: 5_000, OPT: 15_000 },
  nse: { EQ_DELIVERY: 307, EQ_INTRADAY: 307, FUT: 183, OPT: 3_553 },
  bse: { EQ_DELIVERY: 375, EQ_INTRADAY: 375, FUT: 0, OPT: 3_250 },
  sebi: 10,
  stampBuy: { EQ_DELIVERY: 1_500, EQ_INTRADAY: 300, FUT: 200, OPT: 300 }, // Upstox: ₹1500 / ₹300 / ₹200 / ₹300 per crore
} as const;

/** round a value in 1/1e7 paise units to whole paise, half up */
const toPaise = (v: bigint): bigint => (v + 5_000_000n) / 10_000_000n;

export function referenceTotalPaise(seg: Seg, ex: "NSE" | "BSE", side: "BUY" | "SELL", qty: number, pricePaise: number, orders: number): bigint {
  const turnoverPaise = BigInt(qty) * BigInt(pricePaise); // exact
  // component in paise = turnoverPaise × perCrore / 1e7  → keep 1e7 scale then round
  const comp = (perCrore: number): bigint => toPaise(turnoverPaise * BigInt(perCrore));
  // brokerage (paise)
  const perOrderTurnover = Number(turnoverPaise) / orders; // paise
  let brok: number;
  if (seg === "OPT" || seg === "EQ_DELIVERY") brok = 2000 * orders;
  else if (seg === "EQ_INTRADAY") brok = orders * Math.min(2000, perOrderTurnover * 0.001);
  else brok = orders * Math.min(2000, perOrderTurnover * 0.0005);
  brok = Math.min(brok, Number(turnoverPaise) * 0.025);
  const brokerage = BigInt(Math.round(brok + 1e-7));
  const stt = comp(side === "BUY" ? PER_CRORE.sttBuy[seg] : PER_CRORE.sttSell[seg]);
  const txn = comp((ex === "NSE" ? PER_CRORE.nse : PER_CRORE.bse)[seg]);
  const sebi = comp(PER_CRORE.sebi);
  const stamp = side === "BUY" ? comp(PER_CRORE.stampBuy[seg]) : 0n;
  const dp = seg === "EQ_DELIVERY" && side === "SELL" ? 2000n : 0n;
  const gst = (18n * (brokerage + txn + dp) + 50n) / 100n; // half up
  return brokerage + stt + txn + sebi + stamp + dp + gst;
}
