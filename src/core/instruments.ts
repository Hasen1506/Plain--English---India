// The broker-neutral instrument model and the index registry.
// Every lot size, tick size, freeze quantity and expiry the app shows comes from
// the broker's instrument master (Upstox: the BOD JSON). Nothing is hard-coded
// here except how to find an index in that master.

import { istDate } from "./ist.ts";

export type Exchange = "NSE" | "BSE";
export type Segment = "NSE_EQ" | "BSE_EQ" | "NSE_FO" | "BSE_FO" | "NSE_INDEX" | "BSE_INDEX";
export type InstType = "EQ" | "FUT" | "CE" | "PE" | "INDEX";

export interface Instrument {
  key: string; // broker instrument key (Upstox instrument_key)
  segment: Segment;
  exchange: Exchange;
  type: InstType;
  symbol: string; // trading symbol
  name: string;
  underlying: string; // NIFTY, BANKNIFTY … or the stock symbol
  underlyingKey: string | null; // spot instrument key
  expiry: number | null; // ms (end of expiry day, as the master gives it)
  expiryDate: string | null; // IST YYYY-MM-DD
  strike: number | null;
  lotSize: number;
  freezeQty: number | null; // maximum quantity in one order, per the exchange
  tickPaise: number; // minimum price step in paise (5 = ₹0.05)
  weekly: boolean;
  group?: string; // BSE scrip group (A, B, X …) for BSE equities
  isin?: string;
}

export interface IndexDef {
  id: string; // underlying_symbol in the master
  label: string;
  exchange: Exchange;
  foSegment: Segment;
  aliases: string[];
}

/** Index options the sentence builder knows by name. Spot keys come from the master's underlying_key. */
export const INDICES: IndexDef[] = [
  { id: "NIFTY", label: "Nifty 50", exchange: "NSE", foSegment: "NSE_FO", aliases: ["nifty", "nifty 50", "nifty50", "the nifty"] },
  { id: "BANKNIFTY", label: "Bank Nifty", exchange: "NSE", foSegment: "NSE_FO", aliases: ["bank nifty", "banknifty", "nifty bank", "banknifty index"] },
  { id: "FINNIFTY", label: "Fin Nifty", exchange: "NSE", foSegment: "NSE_FO", aliases: ["fin nifty", "finnifty", "nifty fin", "nifty financial services", "nifty fin service"] },
  { id: "MIDCPNIFTY", label: "Midcap Nifty", exchange: "NSE", foSegment: "NSE_FO", aliases: ["midcap nifty", "midcpnifty", "nifty midcap select", "midcap select"] },
  { id: "SENSEX", label: "Sensex", exchange: "BSE", foSegment: "BSE_FO", aliases: ["sensex", "bse sensex", "the sensex"] },
  { id: "BANKEX", label: "Bankex", exchange: "BSE", foSegment: "BSE_FO", aliases: ["bankex", "bse bankex"] },
];

const SEGMENTS = new Set<Segment>(["NSE_EQ", "BSE_EQ", "NSE_FO", "BSE_FO", "NSE_INDEX", "BSE_INDEX"]);

/** Upstox BOD JSON row → Instrument. Returns null for rows we do not trade (commodities, currency, MF …). */
export function fromUpstoxRow(r: Record<string, unknown>): Instrument | null {
  const seg = r.segment as Segment;
  if (!SEGMENTS.has(seg)) return null;
  const it = String(r.instrument_type ?? "");
  let type: InstType;
  if (seg === "NSE_INDEX" || seg === "BSE_INDEX") type = "INDEX";
  else if (seg === "NSE_FO" || seg === "BSE_FO") {
    if (it !== "CE" && it !== "PE" && it !== "FUT") return null;
    type = it;
  } else {
    // NSE_EQ: only the EQ series (BE/SM/… are trade-for-trade or SME, out of scope);
    // BSE_EQ: instrument_type carries the scrip group
    if (seg === "NSE_EQ" && it !== "EQ") return null;
    type = "EQ";
  }
  const expiry = typeof r.expiry === "number" ? r.expiry : null;
  const lot = typeof r.lot_size === "number" && r.lot_size > 0 ? r.lot_size : 1;
  const tick = typeof r.tick_size === "number" && r.tick_size > 0 ? Math.round(r.tick_size) : 5;
  const freeze = typeof r.freeze_quantity === "number" && r.freeze_quantity > 0 ? r.freeze_quantity : null;
  const symbol = String(r.trading_symbol ?? "");
  return {
    key: String(r.instrument_key),
    segment: seg,
    exchange: (String(r.exchange) === "BSE" ? "BSE" : "NSE"),
    type,
    symbol,
    name: String(r.name ?? symbol),
    underlying: String(r.underlying_symbol ?? (type === "INDEX" ? r.name : symbol) ?? symbol),
    underlyingKey: typeof r.underlying_key === "string" ? r.underlying_key : null,
    expiry,
    expiryDate: expiry !== null ? istDate(expiry) : null,
    strike: type === "CE" || type === "PE" ? Number(r.strike_price) : null,
    lotSize: lot,
    freezeQty: freeze,
    tickPaise: tick,
    weekly: Boolean(r.weekly),
    group: seg === "BSE_EQ" ? it : undefined,
    isin: typeof r.isin === "string" ? r.isin : undefined,
  };
}

export interface ExpiryInfo {
  date: string; // IST YYYY-MM-DD
  expiryMs: number;
  weekly: boolean; // as flagged in the master
  kind: "weekly" | "monthly";
}

export class InstrumentStore {
  readonly byKey = new Map<string, Instrument>();
  private readonly options = new Map<string, Instrument[]>(); // underlying → CE/PE
  private readonly futures = new Map<string, Instrument[]>();
  private readonly equities: Instrument[] = [];
  readonly loadedAt: number;

  constructor(list: Instrument[], loadedAt: number) {
    this.loadedAt = loadedAt;
    for (const i of list) {
      this.byKey.set(i.key, i);
      if (i.type === "CE" || i.type === "PE") push(this.options, i.underlying, i);
      else if (i.type === "FUT") push(this.futures, i.underlying, i);
      else if (i.type === "EQ") this.equities.push(i);
    }
  }

  static fromUpstox(rows: Record<string, unknown>[], loadedAt: number): InstrumentStore {
    return new InstrumentStore(rows.map(fromUpstoxRow).filter((x): x is Instrument => x !== null), loadedAt);
  }

  get size(): number {
    return this.byKey.size;
  }

  get(key: string): Instrument | undefined {
    return this.byKey.get(key);
  }

  hasOptions(underlying: string): boolean {
    return (this.options.get(underlying)?.length ?? 0) > 0;
  }

  /** Underlyings with listed options, index ones first. */
  optionUnderlyings(): string[] {
    const idx = INDICES.map((d) => d.id).filter((id) => this.hasOptions(id));
    const stocks = [...this.options.keys()].filter((u) => !idx.includes(u)).sort();
    return [...idx, ...stocks];
  }

  /** Expiries still tradable at `now` (expiry ms is end of the expiry day). */
  expiries(underlying: string, now: number): ExpiryInfo[] {
    const m = new Map<number, boolean>();
    for (const i of this.options.get(underlying) ?? []) if (i.expiry !== null && i.expiry > now) m.set(i.expiry, (m.get(i.expiry) ?? false) || i.weekly);
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([expiryMs, weekly]) => ({ date: istDate(expiryMs), expiryMs, weekly, kind: weekly ? "weekly" : "monthly" }));
  }

  /** Option contracts of one expiry, sorted by strike then CE before PE. */
  chain(underlying: string, expiryDate: string): Instrument[] {
    return (this.options.get(underlying) ?? []).filter((i) => i.expiryDate === expiryDate).sort((a, b) => a.strike! - b.strike! || (a.type === "CE" ? -1 : 1));
  }

  /** Spot instrument key for an underlying (from the options' underlying_key). */
  spotKey(underlying: string): string | null {
    const o = this.options.get(underlying)?.[0] ?? this.futures.get(underlying)?.[0];
    return o?.underlyingKey ?? null;
  }

  equity(symbol: string, exchange: Exchange = "NSE"): Instrument | undefined {
    const s = symbol.toUpperCase();
    return this.equities.find((e) => e.exchange === exchange && e.symbol.toUpperCase() === s);
  }

  /** Case-insensitive equity search by symbol prefix, then name substring. */
  searchEquity(q: string, limit = 8): Instrument[] {
    const t = q.trim().toUpperCase();
    if (!t) return [];
    const nse = this.equities.filter((e) => e.exchange === "NSE");
    const exact = nse.filter((e) => e.symbol === t);
    const pre = nse.filter((e) => e.symbol !== t && e.symbol.startsWith(t));
    const name = nse.filter((e) => !e.symbol.startsWith(t) && e.name.toUpperCase().includes(t));
    return [...exact, ...pre, ...name].slice(0, limit);
  }

  lotSize(underlying: string): number | null {
    return this.options.get(underlying)?.[0]?.lotSize ?? this.futures.get(underlying)?.[0]?.lotSize ?? null;
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

export function indexDef(id: string): IndexDef | undefined {
  return INDICES.find((d) => d.id === id);
}

export function displayName(underlying: string): string {
  return indexDef(underlying)?.label ?? underlying;
}
