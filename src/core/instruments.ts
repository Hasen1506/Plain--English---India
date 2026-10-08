// The broker-neutral instrument model and the index registry.
// Every lot size, tick size, freeze quantity and expiry the app shows comes from
// the broker's instrument master (Upstox: the BOD JSON). Nothing is hard-coded
// here except how to find an index in that master.

import { istDate } from "./ist.ts";

export type Exchange = "NSE" | "BSE" | "MCX";
export type Segment = "NSE_EQ" | "BSE_EQ" | "NSE_FO" | "BSE_FO" | "NSE_INDEX" | "BSE_INDEX" | "MCX_FO" | "NCD_FO";
/** Trading venue for market hours: NSE/BSE cash, NFO/BFO equity derivatives, MCX commodities, CDS NSE currency derivatives. */
export type Venue = "NSE" | "BSE" | "NFO" | "BFO" | "MCX" | "CDS";
export type Category = "index" | "stock" | "metal" | "energy" | "currency";
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
  lotSize: number; // units per lot that P&L is counted in (MCX/CDS: the master's qty_multiplier, e.g. Gold 100 = 1 kg at a ₹/10 g price)
  freezeQty: number | null; // maximum quantity in one order, per the exchange, in the same units as lotSize
  tickPaise: number; // minimum price step in paise (5 = ₹0.05; USDINR options 0.25 = ₹0.0025)
  qtyInLots?: boolean; // the broker takes order quantity as a number of lots (Upstox: commodity and currency)
  unit?: string; // price quote unit from the master (MCX: GRMS, KGS, BBL, mmBtu)
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

/**
 * Commodities and currency pairs the builder knows by name. Whether each has options or only
 * futures is read from the instrument master (MCX_FO / NCD_FO rows), never assumed here.
 */
export interface DerivDef {
  id: string; // underlying_symbol in the master
  label: string;
  category: "metal" | "energy" | "currency";
  aliases: string[];
}
export const COMMODITIES: DerivDef[] = [
  { id: "GOLD", label: "Gold", category: "metal", aliases: ["gold", "mcx gold"] },
  { id: "GOLDM", label: "Gold Mini", category: "metal", aliases: ["gold mini", "goldm"] },
  { id: "SILVER", label: "Silver", category: "metal", aliases: ["silver", "mcx silver"] },
  { id: "SILVERM", label: "Silver Mini", category: "metal", aliases: ["silver mini", "silverm"] },
  { id: "COPPER", label: "Copper", category: "metal", aliases: ["copper"] },
  { id: "ZINC", label: "Zinc", category: "metal", aliases: ["zinc"] },
  { id: "ALUMINIUM", label: "Aluminium", category: "metal", aliases: ["aluminium", "aluminum"] },
  { id: "LEAD", label: "Lead", category: "metal", aliases: ["lead"] },
  { id: "CRUDEOIL", label: "Crude Oil", category: "energy", aliases: ["crude oil", "crude", "crudeoil"] },
  { id: "CRUDEOILM", label: "Crude Mini", category: "energy", aliases: ["crude mini", "crude oil mini", "crudeoilm"] },
  { id: "NATURALGAS", label: "Natural Gas", category: "energy", aliases: ["natural gas", "naturalgas", "nat gas"] },
];
export const CURRENCIES: DerivDef[] = [
  { id: "USDINR", label: "USD/INR", category: "currency", aliases: ["usdinr", "usd inr", "dollar", "usd/inr"] },
  { id: "EURINR", label: "EUR/INR", category: "currency", aliases: ["eurinr", "eur inr", "euro", "eur/inr"] },
  { id: "GBPINR", label: "GBP/INR", category: "currency", aliases: ["gbpinr", "gbp inr", "pound", "gbp/inr"] },
  { id: "JPYINR", label: "JPY/INR", category: "currency", aliases: ["jpyinr", "jpy inr", "yen", "jpy/inr"] },
];
const DERIV_IDS = new Set([...COMMODITIES, ...CURRENCIES].map((d) => d.id));
export const derivDef = (id: string): DerivDef | undefined => COMMODITIES.find((d) => d.id === id) ?? CURRENCIES.find((d) => d.id === id);

const SEGMENTS = new Set<Segment>(["NSE_EQ", "BSE_EQ", "NSE_FO", "BSE_FO", "NSE_INDEX", "BSE_INDEX", "MCX_FO", "NCD_FO"]);

/** Venue whose hours govern an instrument. */
export function venueOf(i: Pick<Instrument, "segment" | "exchange" | "type">): Venue {
  if (i.segment === "MCX_FO") return "MCX";
  if (i.segment === "NCD_FO") return "CDS";
  if (i.type === "EQ" || i.type === "INDEX") return i.exchange === "BSE" ? "BSE" : "NSE";
  return i.exchange === "BSE" ? "BFO" : "NFO";
}

/** Upstox BOD JSON row → Instrument. Returns null for rows we do not trade (agri commodities, MF …). */
export function fromUpstoxRow(r: Record<string, unknown>): Instrument | null {
  const seg = r.segment as Segment;
  if (!SEGMENTS.has(seg)) return null;
  const it = String(r.instrument_type ?? "");
  let type: InstType;
  if (seg === "MCX_FO" || seg === "NCD_FO") {
    // only the named metals, energy and currency pairs; agri contracts are out of scope
    if (!DERIV_IDS.has(String(r.underlying_symbol ?? "")) || (it !== "CE" && it !== "PE" && it !== "FUT")) return null;
    return fromUpstoxDerivRow(r, seg, it);
  }
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

/**
 * MCX and NSE-currency rows. Upstox takes their order quantity as a NUMBER OF LOTS
 * (place-order docs: "For commodity - number of lots is accepted"), and the master's
 * qty_multiplier is how many price units one lot is worth (Gold: lot_size 1, multiplier 100,
 * price per 10 g → 1 kg). We count quantities in those price units so payoff and charges are
 * simply price × qty; the adapter converts back to lots when it sends an order.
 * freeze_quantity on these rows is read as lots (assumption; Upstox does not document it).
 */
function fromUpstoxDerivRow(r: Record<string, unknown>, seg: Segment, it: string): Instrument {
  const mult = typeof r.qty_multiplier === "number" && r.qty_multiplier > 0 ? r.qty_multiplier : typeof r.lot_size === "number" && r.lot_size > 0 ? r.lot_size : 1;
  const expiry = typeof r.expiry === "number" ? r.expiry : null;
  const freezeLots = typeof r.freeze_quantity === "number" && r.freeze_quantity > 0 ? r.freeze_quantity : null;
  const tick = typeof r.tick_size === "number" && r.tick_size > 0 ? r.tick_size : 5;
  const symbol = String(r.trading_symbol ?? "");
  const type = it as InstType;
  return {
    key: String(r.instrument_key),
    segment: seg,
    exchange: seg === "MCX_FO" ? "MCX" : "NSE",
    type,
    symbol,
    name: String(r.name ?? symbol),
    underlying: String(r.underlying_symbol ?? symbol),
    underlyingKey: typeof r.underlying_key === "string" ? r.underlying_key : null,
    expiry,
    expiryDate: expiry !== null ? istDate(expiry) : null,
    strike: type === "CE" || type === "PE" ? Number(r.strike_price) : null,
    lotSize: mult,
    freezeQty: freezeLots !== null ? freezeLots * mult : null,
    tickPaise: Math.round(tick * 1e4) / 1e4,
    weekly: Boolean(r.weekly),
    qtyInLots: true,
    unit: typeof r.price_quote_unit === "string" ? r.price_quote_unit : undefined,
  };
}

/** Broker order quantity for `qty` units: lots for commodity/currency, units otherwise. */
export const brokerQty = (inst: Pick<Instrument, "qtyInLots" | "lotSize">, qty: number): number => (inst.qtyInLots ? Math.round(qty / inst.lotSize) : qty);

export function categoryOf(underlying: string, store?: { hasOptions(u: string): boolean }): Category {
  if (INDICES.some((d) => d.id === underlying)) return "index";
  const d = derivDef(underlying);
  if (d) return d.category;
  void store;
  return "stock";
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

  hasFutures(underlying: string): boolean {
    return (this.futures.get(underlying)?.length ?? 0) > 0;
  }

  /** Underlyings with listed options, index ones first (NSE/BSE equity derivatives only). */
  optionUnderlyings(): string[] {
    const idx = INDICES.map((d) => d.id).filter((id) => this.hasOptions(id));
    const stocks = [...this.options.keys()].filter((u) => !idx.includes(u) && !DERIV_IDS.has(u)).sort();
    return [...idx, ...stocks];
  }

  /** Named commodities and currency pairs present in the master (with options, or futures only). */
  derivUnderlyings(): string[] {
    return [...COMMODITIES, ...CURRENCIES].map((d) => d.id).filter((id) => this.hasOptions(id) || this.hasFutures(id));
  }

  /** Futures of an underlying still trading at `now`, nearest first. */
  futuresOf(underlying: string, now: number): Instrument[] {
    return (this.futures.get(underlying) ?? []).filter((i) => i.expiry !== null && i.expiry > now).sort((a, b) => a.expiry! - b.expiry!);
  }

  /**
   * The contract an option expiry is priced off. NSE/BSE: the spot index or stock.
   * MCX: the futures contract the options devolve into (the options' underlying_key).
   * NSE currency: no underlying key in the master, so the nearest future expiring on or after the option.
   */
  pricingKey(underlying: string, expiryDate: string, now: number): string | null {
    const opt = this.chain(underlying, expiryDate)[0];
    if (opt?.segment === "NCD_FO" || (!opt && derivDef(underlying)?.category === "currency")) {
      const f = this.futuresOf(underlying, now).find((x) => (x.expiryDate ?? "") >= expiryDate) ?? this.futuresOf(underlying, now)[0];
      return f?.key ?? null;
    }
    if (opt?.segment === "MCX_FO") return opt.underlyingKey;
    return this.spotKey(underlying);
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

  /** Price to show for an underlying in lists: the spot (indices, stocks) or the nearest future (commodities, currency). */
  refKey(underlying: string, now: number): string | null {
    if (derivDef(underlying)) return this.futuresOf(underlying, now)[0]?.key ?? null;
    return this.spotKey(underlying);
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
  return indexDef(underlying)?.label ?? derivDef(underlying)?.label ?? underlying;
}
