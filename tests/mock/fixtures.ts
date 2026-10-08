// Load the recorded public fixtures and reshape them the way Upstox serves them.
// Used by unit tests, the mock Upstox server (gateway integration + E2E) and the
// differential tests. TEST-ONLY: nothing here is imported by src/, web/ or gateway/.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InstrumentStore, type Instrument } from "../../src/core/instruments.ts";
import { HolidayCalendar } from "../../src/core/calendar.ts";
import { istMs, istDate } from "../../src/core/ist.ts";
import { makeQuote, type Chain } from "../../src/core/chain.ts";
import type { McxChainRecord } from "../../src/core/recorded-mcx.ts";

const DIR = join(import.meta.dirname, "..", "fixtures");
const cache = new Map<string, unknown>();
export function fixture<T = unknown>(name: string): T {
  if (!cache.has(name)) cache.set(name, JSON.parse(readFileSync(join(DIR, name), "utf8")));
  return cache.get(name) as T;
}

/** The moment the NSE chain fixtures were recorded (IST), parsed from their own timestamp. */
export function chainTime(file = "nse-chain-NIFTY-13-Oct-2026.json"): number {
  const ts = fixture<{ timestamp: string }>(file).timestamp; // "08-Oct-2026 10:39:12"
  const M: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
  const [d, mon, rest] = ts.split("-") as [string, string, string];
  const [y, hms] = rest.split(" ") as [string, string];
  const [hh, mm] = hms.split(":").map(Number) as [number, number];
  return istMs(`${y}-${M[mon]}-${d}`, hh, mm);
}
export const FIXTURE_NOW = chainTime();

export type UpstoxRow = Record<string, unknown>;
/** NSE/BSE rows (recorded 10:39 IST) plus the MCX metals/energy and NSE currency rows (recorded ~16:13 IST, same day). */
export const upstoxRows = (): UpstoxRow[] => [...fixture<{ rows: UpstoxRow[] }>("upstox-instruments.json").rows, ...fixture<{ rows: UpstoxRow[] }>("upstox-instruments-mcx-cds.json").rows];
export const mcxChains = (): Record<string, McxChainRecord> => fixture<{ chains: Record<string, McxChainRecord> }>("mcx-chains.json").chains;
export const store = (): InstrumentStore => InstrumentStore.fromUpstox(upstoxRows(), FIXTURE_NOW);
export const upstoxHolidays = (): Parameters<typeof HolidayCalendar.fromUpstox>[0] => fixture<{ body: { data: Parameters<typeof HolidayCalendar.fromUpstox>[0] } }>("upstox-holidays.json").body.data;
export const calendar = (): HolidayCalendar => HolidayCalendar.fromUpstox(upstoxHolidays());
export const nseFoHolidays = (): { tradingDate: string; description: string }[] => fixture<{ FO: { tradingDate: string; description: string }[] }>("nse-holidays.json").FO;

export interface NseSide {
  buyPrice1: number; buyQuantity1: number; sellPrice1: number; sellQuantity1: number; lastPrice: number; impliedVolatility: number; openInterest: number; totalTradedVolume: number; strikePrice: number;
}
export interface NseChain {
  timestamp: string; underlyingValue: number; expiry: string;
  data: { strikePrice: number; CE?: NseSide; PE?: NseSide }[];
}

export const NSE_CHAIN_FILES: Record<string, string[]> = {
  NIFTY: ["nse-chain-NIFTY-13-Oct-2026.json", "nse-chain-NIFTY-27-Oct-2026.json"],
  BANKNIFTY: ["nse-chain-BANKNIFTY-27-Oct-2026.json"],
  FINNIFTY: ["nse-chain-FINNIFTY-27-Oct-2026.json"],
  RELIANCE: ["nse-chain-RELIANCE-27-Oct-2026.json"],
};

export function nseExpiryToIso(e: string): string {
  const M: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
  const [d, m, y] = e.split("-") as [string, string, string];
  return `${y}-${M[m]}-${d.padStart(2, "0")}`;
}

/** The recorded NSE chain for an underlying/expiry, or null. */
export function nseChain(underlying: string, expiryDate: string): NseChain | null {
  for (const f of NSE_CHAIN_FILES[underlying] ?? []) {
    const c = fixture<NseChain>(f);
    if (nseExpiryToIso(c.expiry) === expiryDate) return c;
  }
  return null;
}

/**
 * Upstox GET /v2/option/chain response body, built from the recorded NSE chain and
 * the recorded Upstox instrument master (strikes matched by underlying/expiry/strike/type).
 */
export function upstoxOptionChain(underlying: string, expiryDate: string, s = store()): { status: string; data: unknown[] } | null {
  const c = nseChain(underlying, expiryDate);
  if (!c) return null;
  const insts = s.chain(underlying, expiryDate);
  const by = new Map(insts.map((i) => [`${i.strike}:${i.type}`, i] as const));
  const spotKey = s.spotKey(underlying);
  const side = (x: NseSide | undefined, i: Instrument | undefined): unknown =>
    i && x
      ? {
          instrument_key: i.key,
          market_data: { ltp: x.lastPrice, volume: x.totalTradedVolume, oi: x.openInterest, close_price: x.lastPrice, bid_price: x.buyPrice1, bid_qty: x.buyQuantity1, ask_price: x.sellPrice1, ask_qty: x.sellQuantity1, prev_oi: x.openInterest },
          option_greeks: { vega: 0, theta: 0, gamma: 0, delta: 0, iv: x.impliedVolatility, pop: 0 },
        }
      : undefined;
  const data = c.data
    .map((r) => {
      const ce = by.get(`${r.strikePrice}:CE`), pe = by.get(`${r.strikePrice}:PE`);
      if (!ce && !pe) return null;
      return { expiry: expiryDate, pcr: 0, strike_price: r.strikePrice, underlying_key: spotKey, underlying_spot_price: c.underlyingValue, call_options: side(r.CE, ce), put_options: side(r.PE, pe) };
    })
    .filter(Boolean);
  return { status: "success", data };
}

/** The same chain as the core `Chain` type (what the gateway hands the strategy). */
export function coreChain(underlying: string, expiryDate: string, now = FIXTURE_NOW, s = store()): Chain | null {
  const c = nseChain(underlying, expiryDate);
  if (!c) return null;
  const insts = s.chain(underlying, expiryDate);
  const rows = new Map<number, Chain["rows"][number]>();
  for (const i of insts) {
    const r = c.data.find((d) => d.strikePrice === i.strike);
    const x = r ? (i.type === "CE" ? r.CE : r.PE) : undefined;
    const q = x ? makeQuote({ ltp: x.lastPrice, bid: x.buyPrice1, ask: x.sellPrice1, bidQty: x.buyQuantity1, askQty: x.sellQuantity1, ivPct: x.impliedVolatility, oi: x.openInterest }, now) : null;
    const row = rows.get(i.strike!) ?? { strike: i.strike!, call: null, put: null };
    if (i.type === "CE") row.call = { inst: i, q };
    else row.put = { inst: i, q };
    rows.set(i.strike!, row);
  }
  const exp = s.expiries(underlying, now).find((e) => e.date === expiryDate);
  if (!exp) return null;
  return { underlying, expiryDate, expiryMs: istMs(expiryDate, 15, 30), spot: c.underlyingValue, rows: [...rows.values()].sort((a, b) => a.strike - b.strike), fetchedAt: now, source: "fixture: NSE option chain (recorded)" };
}

export const today = (): string => istDate(FIXTURE_NOW);
