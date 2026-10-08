import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { marketSession, HolidayCalendar, lastWeekdayOfMonth } from "../../src/core/calendar.ts";
import { istMs, istDate, weekday, addDays } from "../../src/core/ist.ts";
import { calendar, nseFoHolidays } from "../mock/fixtures.ts";

const cal = calendar();

describe("IST helpers", () => {
  it("round-trips dates and knows weekdays", () => {
    expect(istDate(istMs("2026-10-08", 0, 0))).toBe("2026-10-08");
    expect(istDate(istMs("2026-10-08", 23, 59))).toBe("2026-10-08");
    expect(weekday("2026-10-13")).toBe(2);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    fc.assert(fc.property(fc.integer({ min: 0, max: 20000 }), (n) => {
      const d = addDays("2020-01-01", n);
      expect(istDate(istMs(d, 12))).toBe(d);
    }));
  });
});

describe("market sessions (official holiday list via the broker API)", () => {
  it("open at 10:36 on a normal Thursday", () => {
    const s = marketSession(istMs("2026-10-08", 10, 36), "NSE", cal);
    expect(s.state).toBe("open");
    expect(s.canTrade).toBe(true);
    expect(s.closesAt).toBe(istMs("2026-10-08", 15, 30));
  });
  it("pre-open before 09:15, closed at 15:30 sharp", () => {
    expect(marketSession(istMs("2026-10-08", 9, 5), "NSE", cal).state).toBe("pre-open");
    expect(marketSession(istMs("2026-10-08", 15, 30), "NSE", cal).state).toBe("closed");
    expect(marketSession(istMs("2026-10-08", 15, 29), "NSE", cal).state).toBe("open");
  });
  it("Dussehra (20 Oct 2026) is a trading holiday; next open is 21 Oct 09:15", () => {
    const s = marketSession(istMs("2026-10-20", 11, 0), "NSE", cal);
    expect(s.state).toBe("holiday");
    expect(s.holiday).toMatch(/Dussehra/);
    expect(s.opensAt).toBe(istMs("2026-10-21", 9, 15));
  });
  it("weekend: Saturday 10 Oct opens Monday 12 Oct", () => {
    const s = marketSession(istMs("2026-10-10", 10, 0), "BSE", cal);
    expect(s.state).toBe("weekend");
    expect(s.opensAt).toBe(istMs("2026-10-12", 9, 15));
  });
  it("Diwali Muhurat (Sunday 8 Nov 2026) is a special F&O session from the broker's timings", () => {
    const h = cal.get("2026-11-08")!;
    const nfo = h.special!.find((x) => x.venue === "NFO")!;
    expect(marketSession(nfo.start + 60_000, "NSE", cal, "FO").state).toBe("special");
    expect(marketSession(nfo.start - 60_000, "NSE", cal, "FO").canTrade).toBe(false);
  });
  it("the NSE holiday master and the broker list agree on NSE F&O trading holidays (weekdays)", () => {
    const nse = HolidayCalendar.fromNse(nseFoHolidays());
    const wk = (d: string) => weekday(d) !== 0 && weekday(d) !== 6;
    const a = nse.dates().filter(wk);
    const b = cal.dates().filter((d) => wk(d) && cal.isHoliday(d, "NSE"));
    expect(b).toEqual(a);
  });
  it("canTrade only inside 09:15–15:30 on trading days (property)", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 400 }), fc.integer({ min: 0, max: 1439 }), (dd, mins) => {
      const date = addDays("2026-01-01", dd);
      const t = istMs(date, Math.floor(mins / 60), mins % 60);
      const s = marketSession(t, "NSE", cal);
      if (s.state === "special") return;
      const inHours = mins >= 555 && mins < 930;
      expect(s.canTrade).toBe(inHours && cal.isTradingDay(date, "NSE"));
    }));
  });
  it("last weekday of month", () => {
    expect(lastWeekdayOfMonth(2026, 10, 2)).toBe("2026-10-27");
    expect(lastWeekdayOfMonth(2026, 11, 2)).toBe("2026-11-24");
    expect(lastWeekdayOfMonth(2026, 10, 4)).toBe("2026-10-29");
  });
});
