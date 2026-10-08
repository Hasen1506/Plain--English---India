import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { alignToTick, isOnTick, checkQuantity, sliceQuantity, maxPerOrder, protectiveLimit, liquidity } from "../../src/core/rules.ts";
import { fixture, store } from "../mock/fixtures.ts";

const ticks = fc.constantFrom(1, 5, 10, 20, 50, 100, 500);

describe("tick alignment", () => {
  it("aligned prices are on the tick and on the right side of the input", () => {
    fc.assert(fc.property(fc.double({ min: 0.05, max: 100000, noNaN: true }), ticks, (p, t) => {
      const up = alignToTick(p, t, "up"), dn = alignToTick(p, t, "down"), nr = alignToTick(p, t, "nearest");
      for (const x of [up, dn, nr]) expect(Math.round(x * 100) % t).toBe(0);
      expect(up).toBeGreaterThanOrEqual(p - 1e-6);
      expect(dn).toBeLessThanOrEqual(p + 1e-6);
      expect(up - dn).toBeLessThanOrEqual(t / 100 + 1e-9);
      expect(Math.abs(nr - p)).toBeLessThanOrEqual(t / 200 + 1e-6);
    }));
  });
  it("is idempotent and float-noise tolerant (73.25 stays 73.25 on a 5-paise tick)", () => {
    expect(alignToTick(73.25, 5, "up")).toBe(73.25);
    expect(alignToTick(0.1 + 0.2, 5, "down")).toBe(0.3);
    expect(isOnTick(73.25, 5)).toBe(true);
    expect(isOnTick(73.26, 5)).toBe(false);
    expect(isOnTick(73.2, 10)).toBe(true);
    expect(isOnTick(0, 5)).toBe(false);
  });
});

describe("lots and freeze quantity", () => {
  const nifty = { lotSize: 65, freezeQty: 3510 };
  it("quantity must be a positive lot multiple", () => {
    expect(checkQuantity(130, nifty)).toBeNull();
    expect(checkQuantity(100, nifty)).toBe("not-lot-multiple");
    expect(checkQuantity(0, nifty)).toBe("not-positive");
    expect(checkQuantity(65.5, nifty)).toBe("not-integer");
  });
  it("slices: sum to the quantity, each ≤ freeze, each a lot multiple", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 2000 }), fc.integer({ min: 1, max: 1800 }), fc.integer({ min: 1, max: 60 }), (lots, lot, f) => {
      const inst = { lotSize: lot, freezeQty: lot * f + (lots % 3) };
      const qty = lots * lot;
      const s = sliceQuantity(qty, inst);
      expect(s.reduce((a, b) => a + b, 0)).toBe(qty);
      for (const x of s) {
        expect(x % lot).toBe(0);
        expect(x).toBeLessThanOrEqual(Math.max(lot, inst.freezeQty));
      }
      expect(s.length).toBe(Math.ceil(qty / maxPerOrder(inst)));
    }));
  });
  it("real contract specs (recorded instrument master): freeze ≥ lot for every NSE/BSE F&O underlying", () => {
    const specs = fixture<{ specs: Record<string, { lot: number[]; freeze: number[]; tick: number[] }> }>("upstox-fo-specs.json").specs;
    const keys = Object.keys(specs);
    expect(keys.length).toBeGreaterThan(150);
    for (const k of keys) {
      const s = specs[k]!;
      for (const lot of s.lot) for (const fr of s.freeze) {
        expect(fr).toBeGreaterThanOrEqual(lot);
        expect(maxPerOrder({ lotSize: lot, freezeQty: fr }) % lot).toBe(0);
      }
      for (const t of s.tick) expect(t).toBeGreaterThan(0);
    }
  });
  it("index contracts in the fixture carry the master's lot, freeze and tick", () => {
    const s = store();
    for (const u of ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"]) {
      const exp = s.expiries(u, 0)[0]!;
      const c = s.chain(u, exp.date);
      expect(c.length).toBeGreaterThan(20);
      const lots = new Set(c.map((i) => i.lotSize));
      expect(lots.size).toBe(1);
      expect(c.every((i) => i.freezeQty! >= i.lotSize && i.tickPaise > 0)).toBe(true);
    }
  });
});

describe("protective limits and liquidity", () => {
  it("buy limit ≥ touch, sell limit ≤ touch, both on the tick, within slip + one tick", () => {
    fc.assert(fc.property(fc.integer({ min: 5, max: 1_000_000 }).map((p) => p / 100), ticks, fc.double({ min: 0, max: 0.3, noNaN: true }), (touch, t, slip) => {
      const b = protectiveLimit("BUY", touch, t, slip), s = protectiveLimit("SELL", touch, t, slip);
      expect(b).toBeGreaterThanOrEqual(touch - 1e-9);
      expect(b).toBeLessThanOrEqual(touch * (1 + slip) + t / 100 + 1e-9);
      expect(s).toBeLessThanOrEqual(Math.max(touch, t / 100) + 1e-9);
      expect(s).toBeGreaterThan(0);
      expect(isOnTick(b, t) && isOnTick(s, t)).toBe(true);
    }));
  });
  it("flags empty sides, wide spreads and thin depth", () => {
    expect(liquidity(0, 10, 0, 100, "BUY", 65).reason).toBe("no-bid");
    expect(liquidity(10, 0, 100, 0, "SELL", 65).reason).toBe("no-ask");
    expect(liquidity(5, 10, 100, 100, "BUY", 65).reason).toBe("wide-spread");
    expect(liquidity(9.9, 10, 100, 30, "BUY", 65).reason).toBe("thin");
    expect(liquidity(9.9, 10, 100, 300, "BUY", 65).ok).toBe(true);
  });
});
