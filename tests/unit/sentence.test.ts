import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseView, sentence, toView, resolveExpiry, type ParseContext } from "../../src/core/sentence.ts";
import { store, FIXTURE_NOW } from "../mock/fixtures.ts";

const s = store();
const ctx: ParseContext = { known: s.optionUnderlyings(), expiriesFor: (u) => s.expiries(u, FIXTURE_NOW), now: FIXTURE_NOW };

describe("plain-English parser (today = Thu 8 Oct 2026)", () => {
  it("the headline example", () => {
    const p = parseView("I think Nifty stays above 25,000 till Tuesday's expiry, risking ₹5,000", ctx);
    expect(p).toMatchObject({ underlying: "NIFTY", dir: "above", mode: "stays", level: 25000, expiryDate: "2026-10-13", risk: 5000, missing: [] });
  });
  it.each([
    ["Bank Nifty will stay below 56000 by 27 Oct, risk 10k", { underlying: "BANKNIFTY", dir: "below", mode: "stays", level: 56000, expiryDate: "2026-10-27", risk: 10000 }],
    ["sensex goes above 85,000 by next thursday risking 3000", { underlying: "SENSEX", dir: "above", mode: "reaches", level: 85000, expiryDate: "2026-10-15", risk: 3000 }],
    ["Nifty falls to 22000 by the monthly expiry, max loss ₹8,000", { underlying: "NIFTY", dir: "below", mode: "reaches", level: 22000, expiryDate: "2026-10-27", risk: 8000 }],
    ["fin nifty won't fall below 24.5k this month, risking 4k", { underlying: "FINNIFTY", dir: "above", mode: "stays", level: 24500, expiryDate: "2026-10-27", risk: 4000 }],
    ["Nifty to remain under 23000 next week risking 2 lakh", { underlying: "NIFTY", dir: "below", mode: "stays", level: 23000, expiryDate: "2026-10-13", risk: 200000 }],
    ["Reliance stays above 1150 by Oct 27 risking 6000", { underlying: "RELIANCE", dir: "above", mode: "stays", level: 1150, expiryDate: "2026-10-27", risk: 6000 }],
  ])("%s", (text, want) => {
    expect(parseView(text, ctx)).toMatchObject({ ...want, missing: [] });
  });
  it("reports what is missing instead of guessing", () => {
    const p = parseView("nifty goes up", ctx);
    expect(p.missing).toEqual(expect.arrayContaining(["level", "risk", "expiry"]));
    expect(parseView("stays above 25000", ctx).missing).toContain("underlying");
  });
  it("dates with no listed expiry pick the last expiry before them, and say so", () => {
    const r = resolveExpiry("by 30 oct", s.expiries("NIFTY", FIXTURE_NOW), FIXTURE_NOW);
    expect(r.date).toBe("2026-10-27");
    expect(r.note).toMatch(/No contract expires/);
  });
  it("Monday expiry when Tuesday is a holiday (Dussehra) comes straight from the master", () => {
    expect(parseView("nifty stays above 22000 by 19 oct risking 5000", ctx).expiryDate).toBe("2026-10-19");
  });
  it("round trip: parse(sentence(view)) === view", () => {
    const under = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];
    fc.assert(fc.property(
      fc.constantFrom(...under),
      fc.constantFrom<"above" | "below">("above", "below"),
      fc.constantFrom<"stays" | "reaches">("stays", "reaches"),
      fc.integer({ min: 1000, max: 99999 }),
      fc.integer({ min: 100, max: 5_000_000 }),
      fc.nat(),
      (u, dir, mode, level, risk, ei) => {
        const exps = s.expiries(u, FIXTURE_NOW);
        const expiryDate = exps[ei % exps.length]!.date;
        const v = { underlying: u, dir, mode, level, expiryDate, risk };
        expect(toView(parseView(sentence(v), ctx))).toEqual(v);
      },
    ), { numRuns: 300 });
  });
});
