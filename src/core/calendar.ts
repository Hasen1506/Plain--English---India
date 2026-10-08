// Market hours and the derivatives expiry calendar, in IST.
//
// Sessions (NSE/BSE equity and equity derivatives):
//   normal market 09:15–15:30; equity pre-open 09:00–09:08 order entry (09:15 open).
//   https://www.nseindia.com/market-data/timings  (exchange "Market Timings")
// Holidays come from an official list at runtime: the broker's holiday API
// (Upstox GET /v2/market/holidays, which mirrors the exchange circulars) or NSE's
// holiday master https://www.nseindia.com/api/holiday-master?type=trading .
//
// Expiry rules (only used as an independent cross-check of the instrument master;
// the app always lists the expiries the master actually has):
//   SEBI circular SEBI/HO/MRD/TPD-1/P/CIR/2025/76 (26 May 2025): one weekly benchmark
//   index option per exchange; everything else monthly, last Tuesday/Thursday.
//   NSE/FAOP/68747 (25 Jun 2025): NSE expiry day Tuesday from 1 Sep 2025, NIFTY weekly;
//   BSE notice 20250623-59: BSE expiry day Thursday, SENSEX weekly.
//   If the expiry day is a trading holiday, the expiry is the previous trading day
//   (NSE contract specifications).

import { addDays, istDate, istMs, istParts, weekday, daysInMonth } from "./ist.ts";
import type { Exchange, Venue } from "./instruments.ts";

export interface Holiday {
  date: string;
  description: string;
  closed: Exchange[]; // exchanges closed for trading (equity + F&O)
  special?: { venue: string; start: number; end: number }[]; // e.g. Muhurat trading; venue NSE/BSE (equity) or NFO/BFO (F&O)
}

/** Per-venue view of one holiday-list date (MCX and CDS): which venues are shut, and any session windows. */
export interface VenueDay {
  description: string;
  closed: string[]; // Upstox closed_exchanges (NSE, NFO, CDS, BSE, BFO, BCD, MCX, NSCOM)
  open: { venue: string; start: number; end: number }[]; // open_exchanges windows
}

export class HolidayCalendar {
  private readonly byDate = new Map<string, Holiday>();
  readonly venueDays = new Map<string, VenueDay>();
  readonly source: string;
  constructor(list: Holiday[], source: string, venueDays?: Map<string, VenueDay>) {
    for (const h of list) this.byDate.set(h.date, h);
    this.source = source;
    if (venueDays) for (const [k, v] of venueDays) this.venueDays.set(k, v);
  }

  /** From Upstox GET /v2/market/holidays `data`. NFO/BFO closures count as F&O closures of NSE/BSE. */
  static fromUpstox(data: { date: string; description: string; holiday_type: string; closed_exchanges: string[]; open_exchanges?: { exchange: string; start_time: number; end_time: number }[] }[]): HolidayCalendar {
    const list: Holiday[] = [];
    for (const d of data) {
      const closed: Exchange[] = [];
      if (d.holiday_type === "TRADING_HOLIDAY") {
        if (d.closed_exchanges.includes("NSE") || d.closed_exchanges.includes("NFO")) closed.push("NSE");
        if (d.closed_exchanges.includes("BSE") || d.closed_exchanges.includes("BFO")) closed.push("BSE");
      }
      const special = (d.open_exchanges ?? [])
        .filter((o) => ["NSE", "BSE", "NFO", "BFO"].includes(o.exchange) && d.holiday_type === "SPECIAL_TIMING")
        .map((o) => ({ venue: o.exchange, start: o.start_time, end: o.end_time }));
      if (closed.length || special.length) list.push({ date: d.date, description: d.description, closed, special: special.length ? special : undefined });
    }
    const vd = new Map<string, VenueDay>();
    for (const d of data) vd.set(d.date, { description: d.description, closed: [...d.closed_exchanges], open: (d.open_exchanges ?? []).map((o) => ({ venue: o.exchange, start: o.start_time, end: o.end_time })) });
    return new HolidayCalendar(list, "Upstox market holidays API", vd);
  }

  /** From NSE holiday-master `FO` (or `CM`) array: { tradingDate: "20-Oct-2026", description }. NSE-only. */
  static fromNse(rows: { tradingDate: string; description: string }[]): HolidayCalendar {
    const M: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
    return new HolidayCalendar(
      rows.map((r) => {
        const [d, m, y] = r.tradingDate.split("-") as [string, string, string];
        return { date: `${y}-${M[m]}-${d.padStart(2, "0")}`, description: r.description, closed: ["NSE"] as Exchange[] };
      }),
      "NSE holiday master",
    );
  }

  get(date: string): Holiday | undefined {
    return this.byDate.get(date);
  }

  isHoliday(date: string, ex: Exchange): boolean {
    return this.byDate.get(date)?.closed.includes(ex) ?? false;
  }

  isTradingDay(date: string, ex: Exchange): boolean {
    const wd = weekday(date);
    return wd !== 0 && wd !== 6 && !this.isHoliday(date, ex);
  }

  previousTradingDay(date: string, ex: Exchange): string {
    let d = date;
    for (let i = 0; i < 15 && !this.isTradingDay(d, ex); i++) d = addDays(d, -1);
    return d;
  }

  nextTradingDay(date: string, ex: Exchange): string {
    let d = addDays(date, 1);
    for (let i = 0; i < 15 && !this.isTradingDay(d, ex); i++) d = addDays(d, 1);
    return d;
  }

  dates(): string[] {
    return [...this.byDate.keys()].sort();
  }
}

export type SessionState = "open" | "pre-open" | "closed" | "holiday" | "weekend" | "special";

export interface MarketSession {
  exchange: Exchange;
  state: SessionState;
  canTrade: boolean; // regular orders accepted now (normal or special session)
  label: string;
  opensAt: number | null; // next open (ms) when not open
  closesAt: number | null; // when open
  holiday?: string;
}

export const OPEN_MIN = 9 * 60 + 15;
export const CLOSE_MIN = 15 * 60 + 30;
export const PREOPEN_MIN = 9 * 60;

export function marketSession(now: number, ex: Exchange, cal: HolidayCalendar, market: "EQ" | "FO" = "FO"): MarketSession {
  const date = istDate(now);
  const p = istParts(now);
  const h = cal.get(date);
  const venue = market === "EQ" ? ex : ex === "NSE" ? "NFO" : "BFO";
  const sp = h?.special?.find((s) => s.venue === venue);
  if (sp && now >= sp.start && now < sp.end) return { exchange: ex, state: "special", canTrade: true, label: `${h!.description} session`, opensAt: null, closesAt: sp.end, holiday: h!.description };
  const nextOpen = (): number => {
    const today = cal.isTradingDay(date, ex) && p.minutes < OPEN_MIN ? date : cal.nextTradingDay(date, ex);
    return istMs(today, 9, 15);
  };
  if (p.wd === 0 || p.wd === 6) return { exchange: ex, state: "weekend", canTrade: false, label: "Closed for the weekend", opensAt: nextOpen(), closesAt: null };
  if (cal.isHoliday(date, ex)) return { exchange: ex, state: "holiday", canTrade: false, label: `Holiday: ${h!.description}`, opensAt: nextOpen(), closesAt: null, holiday: h!.description };
  if (p.minutes >= OPEN_MIN && p.minutes < CLOSE_MIN) return { exchange: ex, state: "open", canTrade: true, label: "Market open", opensAt: null, closesAt: istMs(date, 15, 30) };
  if (p.minutes >= PREOPEN_MIN && p.minutes < OPEN_MIN) return { exchange: ex, state: "pre-open", canTrade: false, label: "Pre-open (orders from 09:15)", opensAt: istMs(date, 9, 15), closesAt: null };
  return { exchange: ex, state: "closed", canTrade: false, label: "Market closed", opensAt: nextOpen(), closesAt: null };
}

// ── MCX commodities and NSE currency derivatives ──
//   MCX non-agri (metals, energy): 09:00 to 23:30 IST while US daylight saving is on, 09:00 to 23:55
//   otherwise (MCX circulars MCX/TRD/068/2026: 23:30 from 9 Mar 2026; MCX/TRD/550/2026: 23:55 from
//   2 Nov 2026 to 12 Mar 2027). US DST runs from the second Sunday of March to the first Sunday of
//   November, so the first Indian trading day after each switch follows it.
//   NSE currency derivatives (CDS): 09:00 to 17:00 IST.
//   Holidays and special sessions per venue come from the Upstox holiday list (closed_exchanges /
//   open_exchanges, e.g. MCX evening-only sessions on some exchange holidays).

/** True when US daylight saving is in force on this IST calendar date (2nd Sun of March ≤ d < 1st Sun of November). */
export function usDst(date: string): boolean {
  const y = Number(date.slice(0, 4));
  const nthSunday = (m: number, n: number) => {
    const first = `${y}-${String(m).padStart(2, "0")}-01`;
    return addDays(first, ((7 - weekday(first)) % 7) + 7 * (n - 1));
  };
  return date >= nthSunday(3, 2) && date < nthSunday(11, 1);
}

/** Regular trading window (minutes since IST midnight) of a venue on a date. */
export function venueHours(venue: Venue, date: string): { open: number; close: number } {
  if (venue === "MCX") return { open: 9 * 60, close: usDst(date) ? 23 * 60 + 30 : 23 * 60 + 55 };
  if (venue === "CDS") return { open: 9 * 60, close: 17 * 60 };
  return { open: OPEN_MIN, close: CLOSE_MIN };
}

const hhmm = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const VENUE_EX: Record<Venue, Exchange> = { NSE: "NSE", BSE: "BSE", NFO: "NSE", BFO: "BSE", MCX: "MCX", CDS: "NSE" };

/** Market session for any venue. NSE/BSE/NFO/BFO use marketSession(); MCX and CDS use their own hours and the per-venue holiday list. */
export function venueSession(now: number, venue: Venue, cal: HolidayCalendar): MarketSession {
  if (venue === "NSE" || venue === "BSE") return marketSession(now, venue, cal, "EQ");
  if (venue === "NFO" || venue === "BFO") return marketSession(now, venue === "NFO" ? "NSE" : "BSE", cal, "FO");
  const ex = VENUE_EX[venue];
  const name = venue === "MCX" ? "MCX" : "Currency";
  const dayState = (date: string): { closed: boolean; window: { start: number; end: number } | null; why: string | null } => {
    const wd = weekday(date);
    const vd = cal.venueDays.get(date);
    const win = vd?.open.find((o) => o.venue === venue) ?? null;
    if (vd && vd.closed.includes(venue)) return { closed: !win, window: win, why: vd.description };
    if (win) return { closed: false, window: win, why: vd!.description };
    if (wd === 0 || wd === 6) return { closed: true, window: null, why: null };
    const h = venueHours(venue, date);
    return { closed: false, window: { start: istMs(date, Math.floor(h.open / 60), h.open % 60), end: istMs(date, Math.floor(h.close / 60), h.close % 60) }, why: null };
  };
  const date = istDate(now);
  const next = (): number | null => {
    let d = date;
    for (let i = 0; i < 15; i++) {
      const st = dayState(d);
      if (!st.closed && st.window && st.window.start > now) return st.window.start;
      d = addDays(d, 1);
    }
    return null;
  };
  const st = dayState(date);
  const p = istParts(now);
  if (st.window && now >= st.window.start && now < st.window.end) {
    const close = istParts(st.window.end);
    return { exchange: ex, state: st.why ? "special" : "open", canTrade: true, label: `${name} open till ${hhmm(close.minutes)}`, opensAt: null, closesAt: st.window.end, holiday: st.why ?? undefined };
  }
  if (p.wd === 0 || p.wd === 6) return { exchange: ex, state: "weekend", canTrade: false, label: `${name} closed for the weekend`, opensAt: next(), closesAt: null };
  if (st.closed && st.why) return { exchange: ex, state: "holiday", canTrade: false, label: `${name} holiday: ${st.why}`, opensAt: next(), closesAt: null, holiday: st.why };
  return { exchange: ex, state: "closed", canTrade: false, label: `${name} closed`, opensAt: next(), closesAt: null };
}

// ── rule-based expiry generator (reference implementation for differential tests) ──

export interface ExpiryRule {
  exchange: Exchange;
  weekday: number; // 2 = Tuesday (NSE), 4 = Thursday (BSE)
  weekly: boolean; // has weekly contracts
}

export const EXPIRY_RULES: Record<string, ExpiryRule> = {
  NIFTY: { exchange: "NSE", weekday: 2, weekly: true },
  BANKNIFTY: { exchange: "NSE", weekday: 2, weekly: false },
  FINNIFTY: { exchange: "NSE", weekday: 2, weekly: false },
  MIDCPNIFTY: { exchange: "NSE", weekday: 2, weekly: false },
  SENSEX: { exchange: "BSE", weekday: 4, weekly: true },
  BANKEX: { exchange: "BSE", weekday: 4, weekly: false },
};

/** Last `wd` of a month (IST date). */
export function lastWeekdayOfMonth(y: number, m: number, wd: number): string {
  const last = `${y}-${String(m).padStart(2, "0")}-${String(daysInMonth(y, m)).padStart(2, "0")}`;
  const back = (weekday(last) - wd + 7) % 7;
  return addDays(last, -back);
}

/**
 * Nominal expiry days from `fromDate` (inclusive) for `months` calendar months,
 * shifted to the previous trading day when the nominal day is a holiday.
 * Monthly = last expiry-weekday of the month; weekly = every expiry-weekday.
 */
export function ruleExpiries(underlying: string, fromDate: string, months: number, cal: HolidayCalendar): { date: string; kind: "weekly" | "monthly" }[] {
  const r = EXPIRY_RULES[underlying];
  if (!r) return [];
  const [y0, m0] = fromDate.split("-").map(Number) as [number, number];
  const out: { date: string; kind: "weekly" | "monthly" }[] = [];
  for (let k = 0; k < months; k++) {
    const y = y0 + Math.floor((m0 - 1 + k) / 12), m = ((m0 - 1 + k) % 12) + 1;
    const monthly = lastWeekdayOfMonth(y, m, r.weekday);
    const nominal: string[] = [];
    if (r.weekly) {
      const first = `${y}-${String(m).padStart(2, "0")}-01`;
      let d = addDays(first, (r.weekday - weekday(first) + 7) % 7);
      while (d <= monthly) {
        nominal.push(d);
        d = addDays(d, 7);
      }
    } else nominal.push(monthly);
    for (const n of nominal) {
      const actual = cal.previousTradingDay(n, r.exchange);
      if (actual >= fromDate) out.push({ date: actual, kind: n === monthly ? "monthly" : "weekly" });
    }
  }
  return out;
}

/**
 * When an option expiry stops trading (IST): equity F&O 15:30; MCX at the venue close that day
 * (23:30 or 23:55); NSE currency options at 12:30 (NSE currency derivatives contract specs).
 */
export function optionExpiryMs(segment: string, date: string): number {
  if (segment === "MCX_FO") {
    const c = venueHours("MCX", date).close;
    return istMs(date, Math.floor(c / 60), c % 60);
  }
  if (segment === "NCD_FO") return istMs(date, 12, 30);
  return istMs(date, 15, 30);
}
