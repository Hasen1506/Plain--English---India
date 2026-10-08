import { describe, it, expect } from "vitest";
import { ruleExpiries, HolidayCalendar } from "../../src/core/calendar.ts";
import { istDate } from "../../src/core/ist.ts";
import { fixture, calendar, nseFoHolidays, FIXTURE_NOW } from "../mock/fixtures.ts";

// The instrument master (what the exchange actually listed) vs the published rules
// (SEBI 26 May 2025, NSE/FAOP/68747, BSE notice 20250623-59) + an official holiday list.
const master = fixture<{ expiries: Record<string, { expiry: number; weekly: boolean; types: string[] }[]> }>("upstox-expiries.json").expiries;
const today = istDate(FIXTURE_NOW);

function listed(u: string, months: number): { date: string; kind: "weekly" | "monthly" }[] {
  const end = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 + months, 1));
  const endStr = `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, "0")}-01`;
  return (master[u] ?? [])
    .filter((e) => e.types.includes("CE"))
    .map((e) => ({ date: istDate(e.expiry), kind: (e.weekly ? "weekly" : "monthly") as "weekly" | "monthly" }))
    .filter((e) => e.date >= today && e.date < endStr);
}

// The master lists 3 monthly contracts and a fixed number of weekly ones (NSE contract
// specifications: NIFTY has 4 weekly contracts excluding monthlies). So: monthlies over
// the next 3 months must match exactly, and the listed weeklies must be exactly the
// first k weeklies the rules produce.
function compare(u: string, cal: HolidayCalendar): void {
  const want = listed(u, 3);
  const rule = ruleExpiries(u, today, 3, cal);
  expect(rule.filter((e) => e.kind === "monthly")).toEqual(want.filter((e) => e.kind === "monthly"));
  const lw = want.filter((e) => e.kind === "weekly");
  expect(rule.filter((e) => e.kind === "weekly").slice(0, lw.length)).toEqual(lw);
}

describe("expiry calendar: rules + official holidays reproduce the listed contracts", () => {
  for (const u of ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"]) {
    it(`${u}: matches the instrument master (Upstox holiday list)`, () => compare(u, calendar()));
  }
  it("NSE underlyings also match using NSE's own holiday master (independent official source)", () => {
    const nse = HolidayCalendar.fromNse(nseFoHolidays());
    for (const u of ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"]) compare(u, nse);
  });
  it("NIFTY lists 4 weekly contracts besides the monthlies; Bank/Fin/Midcap Nifty are monthly-only", () => {
    expect(listed("NIFTY", 3).filter((e) => e.kind === "weekly").length).toBe(4);
    for (const u of ["BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"]) expect(listed(u, 3).every((e) => e.kind === "monthly")).toBe(true);
  });
  it("holiday shifts are real: Dussehra (Tue 20 Oct) → Mon 19 Oct, Guru Nanak Jayanti (Tue 24 Nov) → Mon 23 Nov", () => {
    const d = listed("NIFTY", 3).map((e) => e.date);
    expect(d).toContain("2026-10-19");
    expect(d).toContain("2026-11-23");
    expect(d).not.toContain("2026-10-20");
  });
});
