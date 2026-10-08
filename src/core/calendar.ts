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
import type { Exchange } from "./instruments.ts";

export interface Holiday {
  date: string;
  description: string;
  closed: Exchange[]; // exchanges closed for trading (equity + F&O)
  special?: { venue: string; start: number; end: number }[]; // e.g. Muhurat trading; venue NSE/BSE (equity) or NFO/BFO (F&O)
}

export class HolidayCalendar {
  private readonly byDate = new Map<string, Holiday>();
  readonly source: string;
  constructor(list: Holiday[], source: string) {
    for (const h of list) this.byDate.set(h.date, h);
    this.source = source;
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
    return new HolidayCalendar(list, "Upstox market holidays API");
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
