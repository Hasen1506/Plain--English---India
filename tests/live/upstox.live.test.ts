// OPT-IN live tests against the real Upstox API. Never run in CI by default.
//
//   LIVE_PUBLIC=1 npm run test:live                      public data only (instrument master, holidays)
//   UPSTOX_ACCESS_TOKEN=… npm run test:live              + read-only: option chain, margin, brokerage (NO orders)
//   UPSTOX_SANDBOX_TOKEN=… npm run test:live             + sandbox orders: place / modify / cancel at api-sandbox.upstox.com
//
// Get the sandbox token from https://account.upstox.com/developer/apps#sandbox (valid 30 days).
// Get a read-only access token by logging in through your gateway, or the Upstox app's token page.
// These tests NEVER place a live order: order calls only go to the sandbox adapter.

import { describe, it, expect } from "vitest";
import { UpstoxAdapter } from "../../gateway/brokers/upstox/adapter.ts";
import { InstrumentStore } from "../../src/core/instruments.ts";
import { ruleExpiries } from "../../src/core/calendar.ts";
import { charges } from "../../src/core/charges.ts";
import { suggest } from "../../src/core/strategy.ts";
import { istDate } from "../../src/core/ist.ts";

const PUBLIC = process.env.LIVE_PUBLIC === "1" || Boolean(process.env.UPSTOX_ACCESS_TOKEN) || Boolean(process.env.UPSTOX_SANDBOX_TOKEN);
const READ = process.env.UPSTOX_ACCESS_TOKEN ?? "";
const SANDBOX = process.env.UPSTOX_SANDBOX_TOKEN ?? "";
const mk = (sandbox: string | null = null) => new UpstoxAdapter({ apiKey: process.env.UPSTOX_API_KEY ?? "unused", apiSecret: "unused", redirectUri: "https://unused.invalid", sandbox: sandbox ? { token: sandbox } : null });

let storeP: Promise<InstrumentStore> | null = null;
const store = () => (storeP ??= mk().instruments().then((l) => new InstrumentStore(l, Date.now())));

describe.skipIf(!PUBLIC)("live public data (Upstox, no login)", () => {
  it("instrument master has today's index options with lot/tick/freeze", async () => {
    const s = await store();
    for (const u of ["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX"]) {
      const e = s.expiries(u, Date.now());
      expect(e.length).toBeGreaterThan(0);
      const c = s.chain(u, e[0]!.date);
      expect(c[0]!.lotSize).toBeGreaterThan(0);
      expect(c[0]!.tickPaise).toBeGreaterThan(0);
    }
  });
  it("expiry rules + live holiday list reproduce today's listed monthlies", async () => {
    const s = await store();
    const cal = await mk().holidays();
    const today = istDate(Date.now());
    for (const u of ["NIFTY", "BANKNIFTY", "SENSEX"]) {
      const listed = s.expiries(u, Date.now()).filter((e) => e.kind === "monthly").map((e) => e.date).slice(0, 2);
      const rule = ruleExpiries(u, today, 3, cal).filter((e) => e.kind === "monthly").map((e) => e.date).slice(0, 2);
      expect(rule).toEqual(listed);
    }
  });
});

describe.skipIf(!READ)("live read-only (Upstox access token; no orders)", () => {
  it("option chain → suggestion → broker margin and brokerage; our charges match the broker's", async () => {
    const a = mk();
    const s = await store();
    a.setSession(READ, { userId: null, userName: null, obtainedAt: Date.now(), expiresAt: Date.now() + 3600e3 });
    const e = s.expiries("NIFTY", Date.now())[0]!;
    const c = await a.optionChain(s, "NIFTY", e.date);
    if (!c.ok) throw new Error(c.error);
    const spot = c.value.spot;
    const r = suggest({ underlying: "NIFTY", dir: "above", mode: "stays", level: Math.round((spot * 0.98) / 50) * 50, expiryDate: e.date, risk: 20000 }, c.value, { now: Date.now() });
    const sg = r.suggestions[0];
    expect(sg, JSON.stringify(r.failures)).toBeTruthy();
    const m = await a.margin(sg!.legs.map((l) => ({ key: l.inst.key, qty: l.qty, side: l.side, product: "D", price: l.price })));
    expect(m.ok && m.value.final > 0).toBe(true);
    for (const l of sg!.legs) {
      const b = await a.brokerage({ key: l.inst.key, qty: l.qty, side: l.side, product: "D", price: l.price });
      if (!b.ok) throw new Error(b.error);
      const ours = charges({ segment: "OPT", exchange: "NSE", side: l.side, qty: l.qty, price: l.price, date: istDate(Date.now()) });
      // the broker rounds STT/stamp on its own schedule; within ₹1 per leg is a match
      expect(Math.abs(ours.total - b.value.total)).toBeLessThanOrEqual(1);
    }
  });
});

describe.skipIf(!SANDBOX)("sandbox orders (api-sandbox.upstox.com only)", () => {
  it("place → modify → cancel a far-away LIMIT order", async () => {
    const a = mk(SANDBOX);
    expect(a.info.sandbox).toBe(true);
    const s = await store();
    const rel = s.equity("RELIANCE")!;
    const p = await a.place({ instrumentKey: rel.key, side: "BUY", qty: 1, limit: 10, product: "D", validity: "DAY", tag: "pei-sandbox", purpose: "entry" });
    if (!p.ok) throw new Error(p.error);
    expect(p.orderIds.length).toBeGreaterThan(0);
    const m = await a.modify(p.orderIds[0]!, { price: 11, validity: "DAY" });
    expect(m.ok).toBe(true);
    await a.cancel(p.orderIds[0]!);
  });
});
