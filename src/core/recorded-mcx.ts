// Turn a RECORDED public MCX option chain (tests/fixtures/mcx-chains.json, from
// https://www.mcxindia.com/market-data/option-chain) into quotes keyed by the Upstox
// instrument keys of the same contracts. Pure: used by the demo and the mock broker.
// MCX publishes bid/ask sizes in lots; quotes here count units (lots × the master's multiplier).

import { makeQuote, type Quote } from "./chain.ts";
import type { InstrumentStore } from "./instruments.ts";

export interface McxChainRecord {
  source: string;
  asOn: string;
  asOnMs: number;
  underlyingValue: number | null;
  rows: Record<string, number | string | null>[];
}

const n = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : undefined);

/** Quotes for one recorded expiry: every matched option, plus the futures contract the options are written on. */
export function quotesFromMcx(underlying: string, expiryDate: string, rec: McxChainRecord, store: InstrumentStore, now: number, ts: number): Map<string, Quote> {
  const out = new Map<string, Quote>();
  const insts = store.chain(underlying, expiryDate);
  const by = new Map(insts.map((i) => [`${i.strike}:${i.type}`, i] as const));
  for (const r of rec.rows) {
    const k = Number(r.CE_StrikePrice ?? r.PE_StrikePrice);
    for (const t of ["CE", "PE"] as const) {
      const i = by.get(`${k}:${t}`);
      if (!i) continue;
      const bid = n(r[`${t}_BidPrice`]), ask = n(r[`${t}_AskPrice`]);
      const q = makeQuote({ ltp: n(r[`${t}_LTP`]), bid, ask, bidQty: bid ? (n(r[`${t}_BidQty`]) ?? 0) * i.lotSize : 0, askQty: ask ? (n(r[`${t}_AskQty`]) ?? 0) * i.lotSize : 0, oi: typeof r[`${t}_OpenInterest`] === "number" ? (r[`${t}_OpenInterest`] as number) * i.lotSize : undefined }, ts);
      if (q.ltp !== null || q.bid !== null || q.ask !== null) out.set(i.key, q);
    }
  }
  const fk = store.pricingKey(underlying, expiryDate, now);
  if (fk && rec.underlyingValue) out.set(fk, { ltp: rec.underlyingValue, bid: null, ask: null, bidQty: 0, askQty: 0, iv: null, oi: null, ts });
  return out;
}
