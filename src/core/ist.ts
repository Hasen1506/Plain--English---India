// India Standard Time helpers. IST is UTC+05:30 all year (no daylight saving),
// so a fixed offset is exact. Everything here is pure and never reads the clock.

export const IST_OFFSET_MS = 5.5 * 3600_000;
export const DAY_MS = 86_400_000;

export interface IstParts {
  y: number;
  m: number; // 1-12
  d: number;
  hh: number;
  mm: number;
  ss: number;
  wd: number; // 0 = Sunday
  minutes: number; // minutes since IST midnight
}

export function istParts(ms: number): IstParts {
  const t = new Date(ms + IST_OFFSET_MS);
  const hh = t.getUTCHours(), mm = t.getUTCMinutes();
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), hh, mm, ss: t.getUTCSeconds(), wd: t.getUTCDay(), minutes: hh * 60 + mm };
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** "YYYY-MM-DD" of the IST calendar day containing `ms`. */
export function istDate(ms: number): string {
  const p = istParts(ms);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** Epoch ms of IST wall-clock `date hh:mm`. */
export function istMs(date: string, hh = 0, mm = 0): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d, hh, mm) - IST_OFFSET_MS;
}

/** Weekday (0 = Sunday) of an IST calendar date string. */
export function weekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Whole calendar days from IST date a to IST date b. */
export function dayDiff(a: string, b: string): number {
  return Math.round((istMs(b) - istMs(a)) / DAY_MS);
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const weekdayName = (wd: number): string => WD[wd]!;
export const longWeekday = (wd: number): string => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][wd]!;

/** "Tue, 13 Oct" (adds the year when it differs from `refYear`). */
export function shortDate(date: string, refYear?: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return `${WD[weekday(date)]}, ${d} ${MON[m - 1]}` + (refYear !== undefined && y !== refYear ? ` ${y}` : "");
}

/** "13 Oct 2026" */
export function longDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return `${d} ${MON[m - 1]} ${y}`;
}

/** "10:36 IST" */
export function istClock(ms: number): string {
  const p = istParts(ms);
  return `${pad(p.hh)}:${pad(p.mm)} IST`;
}
