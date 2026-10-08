import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { planClose } from "../../src/core/close.ts";
import { store } from "../mock/fixtures.ts";

const s = store();
const get = (k: string) => s.get(k);
const pe = s.chain("NIFTY", "2026-10-13").filter((i) => i.type === "PE");
const longI = pe.find((i) => i.strike === 22200)!, shortI = pe.find((i) => i.strike === 22300)!;
const rel = s.equity("RELIANCE")!;
const spread = { [shortI.key]: -65, [longI.key]: 65 };

describe("closing chosen positions", () => {
  it("closes a whole spread, buying the sold leg back first", () => {
    const p = planClose([longI.key, shortI.key], spread, get);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.legs.map((l) => [l.inst.key, l.netQty])).toEqual([[shortI.key, -65], [longI.key, 65]]);
  });

  it("refuses to close only the hedge of a sold option", () => {
    expect(planClose([longI.key], spread, get)).toMatchObject({ ok: false, code: "naked" });
  });

  it("closing only the sold leg is allowed (it lowers risk)", () => {
    expect(planClose([shortI.key], spread, get).ok).toBe(true);
  });

  it("refuses shares, flat positions, unknown keys and bad input", () => {
    expect(planClose([rel.key], { [rel.key]: 10 }, get)).toMatchObject({ ok: false, code: "equity" });
    expect(planClose([longI.key], {}, get)).toMatchObject({ ok: false, code: "flat" });
    expect(planClose(["NSE_FO|nope"], {}, get)).toMatchObject({ ok: false, code: "unknown-instrument" });
    expect(planClose([], spread, get)).toMatchObject({ ok: false, code: "keys" });
    expect(planClose("x", spread, get)).toMatchObject({ ok: false, code: "keys" });
  });

  it("property: an accepted plan never leaves more sold options uncovered than before", () => {
    const keys = pe.slice(0, 6).map((i) => i.key);
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -3, max: 3 }), { minLength: 6, maxLength: 6 }), fc.subarray(keys, { minLength: 1 }), (lots, chosen) => {
        const net = Object.fromEntries(keys.map((k, i) => [k, lots[i]! * 65]));
        const p = planClose(chosen, net, get);
        if (!p.ok) return;
        const unc = (n: Record<string, number>) => Math.max(0, -Object.values(n).filter((q) => q < 0).reduce((a, q) => a + q, 0) - Object.values(n).filter((q) => q > 0).reduce((a, q) => a + q, 0));
        const after = { ...net, ...Object.fromEntries(chosen.map((k) => [k, 0])) };
        expect(unc(after)).toBeLessThanOrEqual(unc(net));
        // sold legs first
        const firstLong = p.legs.findIndex((l) => l.netQty > 0);
        if (firstLong >= 0) expect(p.legs.slice(firstLong).every((l) => l.netQty > 0)).toBe(true);
      }),
    );
  });
});
