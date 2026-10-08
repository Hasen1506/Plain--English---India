// The list of things you can trade, grouped into categories for the picker: indices, F&O
// stocks, MCX metals and energy, NSE currency pairs. Built from the instrument master only:
// whether a commodity has options or only futures, its lot and its expiries are read from
// the master rows, never assumed.

import { INDICES, COMMODITIES, CURRENCIES, venueOf, type Category, type ExpiryInfo, type InstrumentStore, type Venue } from "./instruments.ts";

export interface UnderlyingInfo {
  id: string;
  label: string;
  category: Category;
  index: boolean; // kept for older clients: true for indices
  exchange: string; // NSE, BSE, MCX
  venue: Venue; // whose hours apply
  lotSize: number | null; // units per lot (MCX/CDS: price units, e.g. Gold 100 = 1 kg at a ₹/10 g price)
  unit: string | null; // MCX price quote unit (GRMS, KGS, BBL, mmBtu)
  hasOptions: boolean;
  futures: { key: string; symbol: string; expiryDate: string }[]; // nearest first, up to 3
  spotKey: string | null; // what the list shows a price for: spot (indices, stocks) or the nearest future
  expiries: ExpiryInfo[]; // option expiries ([] when futures only)
}

export const CATEGORY_LABEL: Record<Category, string> = { index: "Indices", stock: "Stocks", metal: "Metals", energy: "Energy", currency: "Currency" };

export function underlyingList(store: InstrumentStore, now: number): UnderlyingInfo[] {
  const out: UnderlyingInfo[] = [];
  for (const u of store.optionUnderlyings()) {
    const idx = INDICES.find((d) => d.id === u);
    const any = store.chain(u, store.expiries(u, now)[0]?.date ?? "")[0];
    out.push({
      id: u,
      label: idx?.label ?? u,
      category: idx ? "index" : "stock",
      index: Boolean(idx),
      exchange: idx?.exchange ?? "NSE",
      venue: any ? venueOf(any) : idx?.exchange === "BSE" ? "BFO" : "NFO",
      lotSize: store.lotSize(u),
      unit: null,
      hasOptions: true,
      futures: store.futuresOf(u, now).slice(0, 3).map((f) => ({ key: f.key, symbol: f.symbol, expiryDate: f.expiryDate! })),
      spotKey: store.spotKey(u),
      expiries: store.expiries(u, now),
    });
  }
  for (const u of store.derivUnderlyings()) {
    const d = [...COMMODITIES, ...CURRENCIES].find((x) => x.id === u)!;
    const fut = store.futuresOf(u, now);
    const exps = store.expiries(u, now);
    const sample = fut[0] ?? store.chain(u, exps[0]?.date ?? "")[0];
    out.push({
      id: u,
      label: d.label,
      category: d.category,
      index: false,
      exchange: sample?.exchange ?? (d.category === "currency" ? "NSE" : "MCX"),
      venue: d.category === "currency" ? "CDS" : "MCX",
      lotSize: store.lotSize(u),
      unit: sample?.unit ?? null,
      hasOptions: store.hasOptions(u) && exps.length > 0,
      futures: fut.slice(0, 3).map((f) => ({ key: f.key, symbol: f.symbol, expiryDate: f.expiryDate! })),
      spotKey: store.refKey(u, now),
      expiries: exps,
    });
  }
  return out;
}
