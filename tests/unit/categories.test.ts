// Category switching, MCX / currency instruments, MCX hours and commodity lot sizes, all on the
// RECORDED public data (Upstox MCX + NSE masters and the mcxindia.com option chains, 8 Oct 2026).
import { describe, it, expect } from "vitest";
import { brokerQty, venueOf } from "../../src/core/instruments.ts";
import { underlyingList } from "../../src/core/catalog.ts";
import { venueSession, venueHours, usDst, optionExpiryMs } from "../../src/core/calendar.ts";
import { charges, derivChargeSegment } from "../../src/core/charges.ts";
import { isOnTick, alignToTick, sliceQuantity } from "../../src/core/rules.ts";
import { chainFromQuotes, strikeStep } from "../../src/core/chain.ts";
import { quotesFromMcx } from "../../src/core/recorded-mcx.ts";
import { suggest } from "../../src/core/strategy.ts";
import { parseView } from "../../src/core/sentence.ts";
import { istMs, istDate } from "../../src/core/ist.ts";
import { store, calendar, mcxChains, FIXTURE_NOW } from "../mock/fixtures.ts";

const s = store();
const cal = calendar();
const list = underlyingList(s, FIXTURE_NOW);
const byId = (id: string) => list.find((u) => u.id === id)!;

describe("categories from the instrument master", () => {
  it("puts every underlying in exactly one category", () => {
    expect(byId("NIFTY").category).toBe("index");
    expect(byId("SENSEX").category).toBe("index");
    expect(byId("RELIANCE").category).toBe("stock");
    for (const id of ["GOLD", "GOLDM", "SILVER", "SILVERM", "COPPER", "ZINC", "ALUMINIUM", "LEAD"]) expect(byId(id).category).toBe("metal");
    for (const id of ["CRUDEOIL", "CRUDEOILM", "NATURALGAS"]) expect(byId(id).category).toBe("energy");
    for (const id of ["USDINR", "EURINR", "GBPINR", "JPYINR"]) expect(byId(id).category).toBe("currency");
    expect(new Set(list.map((u) => u.id)).size).toBe(list.length);
    // agri contracts are out of scope
    expect(list.some((u) => u.id === "COTTON" || u.id === "MENTHAOIL")).toBe(false);
  });

  it("reads options-or-futures-only from the master, never assumes it", () => {
    for (const id of ["GOLD", "GOLDM", "SILVER", "SILVERM", "COPPER", "ZINC", "CRUDEOIL", "CRUDEOILM", "NATURALGAS", "USDINR"]) expect(byId(id).hasOptions).toBe(true);
    for (const id of ["ALUMINIUM", "LEAD"]) {
      expect(byId(id).hasOptions).toBe(false);
      expect(byId(id).expiries).toEqual([]);
      expect(byId(id).futures.length).toBeGreaterThan(0);
    }
    expect(byId("ALUMINIUM").futures[0]!.symbol).toBe("ALUMINIUM FUT 30 OCT 26");
  });

  it("knows the venue whose hours apply", () => {
    expect(byId("NIFTY").venue).toBe("NFO");
    expect(byId("SENSEX").venue).toBe("BFO");
    expect(byId("GOLD").venue).toBe("MCX");
    expect(byId("USDINR").venue).toBe("CDS");
    expect(venueOf(s.chain("GOLD", "2026-10-30")[0]!)).toBe("MCX");
  });

  it("parses commodity names in a typed sentence", () => {
    const p = parseView("I think crude mini stays above 8,900 risking ₹20,000", { known: list.map((u) => u.id), expiriesFor: (u) => s.expiries(u, FIXTURE_NOW), now: FIXTURE_NOW });
    expect(p.underlying).toBe("CRUDEOILM");
    expect(p.level).toBe(8900);
    expect(parseView("gold goes above 150000", { known: list.map((u) => u.id), expiriesFor: (u) => s.expiries(u, FIXTURE_NOW), now: FIXTURE_NOW }).underlying).toBe("GOLD");
  });
});

describe("commodity lot sizes (Upstox qty_multiplier) and order quantity in lots", () => {
  it("counts one lot in price units", () => {
    // Gold: lot_size 1, multiplier 100 (₹/10 g price, 1 kg lot); Gold Mini 10; Silver 30 kg; Silver Mini 5 kg
    expect(byId("GOLD").lotSize).toBe(100);
    expect(byId("GOLDM").lotSize).toBe(10);
    expect(byId("SILVER").lotSize).toBe(30);
    expect(byId("SILVERM").lotSize).toBe(5);
    // base metals: price per kg; Copper 2.5 t, Zinc / Aluminium / Lead 5 t
    expect(byId("COPPER").lotSize).toBe(2500);
    expect(byId("ZINC").lotSize).toBe(5000);
    expect(byId("ALUMINIUM").lotSize).toBe(5000);
    expect(byId("LEAD").lotSize).toBe(5000);
    // energy: barrels and mmBtu
    expect(byId("CRUDEOIL").lotSize).toBe(100);
    expect(byId("CRUDEOILM").lotSize).toBe(10);
    expect(byId("NATURALGAS").lotSize).toBe(1250);
    // currency: USD 1,000 per lot
    expect(byId("USDINR").lotSize).toBe(1000);
  });

  it("sends lots to the broker for commodity and currency, units for equity F&O", () => {
    const gold = s.chain("GOLD", "2026-10-30")[0]!;
    expect(gold.qtyInLots).toBe(true);
    expect(brokerQty(gold, 300)).toBe(3);
    const nifty = s.chain("NIFTY", "2026-10-13")[0]!;
    expect(nifty.qtyInLots).toBeFalsy();
    expect(brokerQty(nifty, 130)).toBe(130);
  });

  it("slices by the freeze limit read as lots", () => {
    const gold = s.chain("GOLD", "2026-10-30")[0]!;
    expect(gold.freezeQty).toBe(100 * 100); // 100 lots
    expect(sliceQuantity(300, gold)).toEqual([300]);
  });

  it("keeps fractional currency ticks exact (USDINR options: ₹0.0025)", () => {
    const usd = s.chain("USDINR", byId("USDINR").expiries[0]!.date)[0]!;
    expect(usd.tickPaise).toBe(0.25);
    expect(isOnTick(0.1825, 0.25)).toBe(true);
    expect(isOnTick(0.1826, 0.25)).toBe(false);
    expect(alignToTick(0.18261, 0.25, "up")).toBeCloseTo(0.185, 10);
    expect(isOnTick(73.25, 5)).toBe(true); // equity ticks unchanged
  });
});

describe("MCX and currency market hours", () => {
  const mcx = (d: string, h: number, m: number) => venueSession(istMs(d, h, m), "MCX", cal);
  it("knows US daylight saving moves the MCX close", () => {
    expect(usDst("2026-10-08")).toBe(true);
    expect(usDst("2026-10-30")).toBe(true);
    expect(usDst("2026-11-02")).toBe(false); // MCX circular 550/2026: 23:55 from 2 Nov 2026
    expect(usDst("2027-03-12")).toBe(false); // … to 12 Mar 2027
    expect(usDst("2026-03-09")).toBe(true); // MCX circular 068/2026: 23:30 from 9 Mar 2026
    expect(venueHours("MCX", "2026-10-08")).toEqual({ open: 540, close: 1410 });
    expect(venueHours("MCX", "2026-11-02")).toEqual({ open: 540, close: 1435 });
  });
  it("is open 09:00 to 23:30 today, closed after", () => {
    expect(mcx("2026-10-08", 8, 59).canTrade).toBe(false);
    const open = mcx("2026-10-08", 9, 0);
    expect(open.canTrade).toBe(true);
    expect(open.label).toBe("MCX open till 23:30");
    expect(mcx("2026-10-08", 23, 29).canTrade).toBe(true);
    const late = mcx("2026-10-08", 23, 40);
    expect(late.canTrade).toBe(false);
    expect(late.opensAt).toBe(istMs("2026-10-09", 9, 0));
  });
  it("runs to 23:55 after the US clocks change", () => {
    expect(mcx("2026-11-02", 23, 40).canTrade).toBe(true);
    expect(mcx("2026-11-02", 23, 40).label).toBe("MCX open till 23:55");
    expect(mcx("2026-11-02", 23, 56).canTrade).toBe(false);
  });
  it("is shut at weekends", () => {
    const sat = mcx("2026-10-10", 12, 0);
    expect(sat.state).toBe("weekend");
    expect(sat.opensAt).toBe(istMs("2026-10-12", 9, 0));
  });
  it("follows the per-venue holiday list (evening-only MCX sessions, full closures)", () => {
    // 15 Jan 2026: NSE/BSE shut; MCX open in the evening only (Upstox open_exchanges 17:00–23:55)
    expect(mcx("2026-01-15", 12, 0).canTrade).toBe(false);
    expect(mcx("2026-01-15", 18, 0).canTrade).toBe(true);
    expect(mcx("2026-01-15", 18, 0).state).toBe("special");
    // Republic Day: MCX closed
    expect(mcx("2026-01-26", 12, 0).state).toBe("holiday");
  });
  it("currency runs 09:00 to 17:00", () => {
    expect(venueSession(istMs("2026-10-08", 16, 59), "CDS", cal).canTrade).toBe(true);
    expect(venueSession(istMs("2026-10-08", 17, 0), "CDS", cal).canTrade).toBe(false);
    // equity F&O keep their own rules
    expect(venueSession(istMs("2026-10-08", 16, 0), "NFO", cal).canTrade).toBe(false);
  });
  it("puts option expiry at the venue's close", () => {
    expect(optionExpiryMs("MCX_FO", "2026-10-30")).toBe(istMs("2026-10-30", 23, 30));
    expect(optionExpiryMs("MCX_FO", "2026-11-27")).toBe(istMs("2026-11-27", 23, 55));
    expect(optionExpiryMs("NCD_FO", "2026-10-16")).toBe(istMs("2026-10-16", 12, 30));
    expect(optionExpiryMs("NSE_FO", "2026-10-13")).toBe(istMs("2026-10-13", 15, 30));
  });
});

describe("commodity and currency charges (Upstox brokerage page)", () => {
  const date = istDate(FIXTURE_NOW);
  it("MCX options: CTT 0.05% on sells, MCX 0.0418%, stamp 0.003% on buys", () => {
    const sell = charges({ segment: "MCX_OPT", exchange: "MCX", side: "SELL", qty: 100, price: 1000, date });
    expect(sell.stt).toBeCloseTo(50, 2); // 0.05% of ₹1,00,000
    expect(sell.exchangeTxn).toBeCloseTo(41.8, 2);
    expect(sell.stampDuty).toBe(0);
    const buy = charges({ segment: "MCX_OPT", exchange: "MCX", side: "BUY", qty: 100, price: 1000, date });
    expect(buy.stt).toBe(0);
    expect(buy.stampDuty).toBeCloseTo(3, 2);
    expect(buy.brokerage).toBe(20);
  });
  it("currency: no STT", () => {
    const c = charges({ segment: "CDS_OPT", exchange: "NSE", side: "SELL", qty: 1000, price: 0.5, date });
    expect(c.stt).toBe(0);
  });
  it("picks the segment from the contract", () => {
    expect(derivChargeSegment(s.chain("GOLD", "2026-10-30")[0]!)).toBe("MCX_OPT");
    expect(derivChargeSegment(s.futuresOf("GOLD", FIXTURE_NOW)[0]!)).toBe("MCX_FUT");
    expect(derivChargeSegment(s.chain("NIFTY", "2026-10-13")[0]!)).toBe("OPT");
  });
});

describe("options strategies on commodity options (recorded MCX chain)", () => {
  const chains = mcxChains();
  const build = (u: string, date: string) => {
    const q = quotesFromMcx(u, date, chains[`${u}:${date}`]!, s, FIXTURE_NOW, FIXTURE_NOW);
    const pk = s.pricingKey(u, date, FIXTURE_NOW)!;
    return chainFromQuotes({ underlying: u, expiryDate: date, expiryMs: optionExpiryMs("MCX_FO", date), spot: q.get(pk)!.ltp!, insts: s.chain(u, date), quotes: Object.fromEntries(q), fetchedAt: FIXTURE_NOW, source: "fixture" });
  };
  it("prices options off the futures contract they devolve into", () => {
    expect(s.get(s.pricingKey("GOLD", "2026-10-30", FIXTURE_NOW)!)!.symbol).toBe("GOLD FUT 04 DEC 26");
    expect(s.get(s.pricingKey("CRUDEOILM", "2026-10-15", FIXTURE_NOW)!)!.symbol).toBe("CRUDEOILM FUT 19 OCT 26");
    const c = build("GOLD", "2026-10-30");
    expect(c.spot).toBe(chains["GOLD:2026-10-30"]!.underlyingValue);
    expect(c.rows.length).toBeGreaterThan(20);
    // MCX publishes sizes in lots; quotes count units
    const row = c.rows.find((r) => r.call?.q?.bid && r.call.q.bidQty)!;
    expect(row.call!.q!.bidQty % 100).toBe(0);
  });
  it("builds a defined-risk spread on Crude Mini with whole lots and MCX charges", () => {
    const c = build("CRUDEOILM", "2026-10-15");
    const step = strikeStep(c);
    const level = Math.floor((c.spot * 0.994) / step) * step;
    const r = suggest({ underlying: "CRUDEOILM", dir: "above", mode: "stays", level, expiryDate: "2026-10-15", risk: 20000 }, c, { now: FIXTURE_NOW });
    const sg = r.suggestions[0]!;
    expect(sg).toBeTruthy();
    expect(sg.lotSize).toBe(10);
    for (const l of sg.legs) {
      expect(l.qty % 10).toBe(0);
      expect(l.inst.segment).toBe("MCX_FO");
    }
    expect(sg.worstMaxLoss).toBeLessThanOrEqual(20000);
    expect(sg.entryCharges.stt).toBeGreaterThan(0); // CTT on the sold leg
    // never sized above the book at the best prices (thin MCX books)
    expect(sg.legs[0]!.qty).toBeLessThanOrEqual(sg.legs[0]!.side === "BUY" ? sg.legs[0]!.quote.askQty : sg.legs[0]!.quote.bidQty);
    expect(sg.legs[1]!.qty).toBeLessThanOrEqual(sg.legs[1]!.side === "BUY" ? sg.legs[1]!.quote.askQty : sg.legs[1]!.quote.bidQty);
  });
});
