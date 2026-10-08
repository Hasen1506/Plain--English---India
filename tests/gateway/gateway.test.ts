import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startHarness, PASS, ORIGIN, type Harness } from "./harness.ts";
import { AuditLog } from "../../gateway/audit.ts";
import { suggest } from "../../src/core/strategy.ts";
import { FIXTURE_NOW } from "../mock/fixtures.ts";
import type { Chain } from "../../src/core/chain.ts";

describe("gateway: auth, CORS and broker login (mock Upstox)", () => {
  let h: Harness;
  beforeAll(async () => (h = await startHarness()));
  afterAll(async () => h.close());

  it("health is public; everything under /api needs the gateway token", async () => {
    expect((await h.api("GET", "/health", undefined, { Authorization: "" })).status).toBe(200);
    const saved = h.token;
    h.token = "";
    expect((await h.api("GET", "/api/session")).status).toBe(401);
    h.token = "not.a.jwt";
    expect((await h.api("GET", "/api/session")).status).toBe(401);
    h.token = saved;
    expect((await h.api("GET", "/api/session")).status).toBe(200);
  });

  it("CORS: only the allow-listed origin", async () => {
    const r = await h.api("GET", "/api/session", undefined, { Origin: "https://evil.example" });
    expect(r.status).toBe(403);
    const ok = await h.api("GET", "/api/session", undefined, { Origin: ORIGIN });
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const pre = await fetch(`${h.url}/api/trade/options`, { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" } });
    expect(pre.status).toBe(204);
  });

  it("wrong passphrase is refused and throttled after 5 tries", async () => {
    for (let i = 0; i < 5; i++) expect((await h.api("POST", "/auth/login", { passphrase: "nope" }, { "X-Forwarded-For": "1.2.3.4" })).status).toBe(401);
    // TRUST_PROXY is off, so all test calls share 127.0.0.1: the 6th try is throttled even with the right passphrase
    expect((await h.api("POST", "/auth/login", { passphrase: PASS })).status).toBe(429);
  });

  it("before Upstox login: reference data loads from public endpoints, prices say 'log in'", async () => {
    const s = await h.api("GET", "/api/session");
    expect(s.body.broker).toMatchObject({ id: "upstox", loggedIn: false });
    expect((s.body.instruments as { count: number }).count).toBeGreaterThan(1000);
    const u = await h.api("GET", "/api/instruments/underlyings");
    const ids = (u.body.underlyings as { id: string }[]).map((x) => x.id);
    expect(ids.slice(0, 5)).toEqual(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"]);
    const c = await h.api("GET", "/api/chain?u=NIFTY&expiry=2026-10-13");
    expect(c.status).toBe(401);
    expect(c.body.error).toBe("no-session");
    expect((await h.api("GET", "/api/spots?u=NIFTY")).status).toBe(401);
  });

  it("OAuth: bad state is rejected; the real flow stores a session and never exposes the token", async () => {
    const bad = await fetch(`${h.url}/auth/broker/callback?code=x&state=forged.123.abc`, { redirect: "manual" });
    expect(bad.headers.get("location")).toMatch(/broker=bad-state/);
    await h.brokerLogin();
    const s = await h.api("GET", "/api/session");
    expect(s.body.broker).toMatchObject({ loggedIn: true, userId: "MOCK01" });
    expect(JSON.stringify(s.body)).not.toContain("mock-access-token");
    // encrypted at rest
    expect(readFileSync(join(h.dataDir, "broker-session.json"), "utf8")).not.toContain("mock-access-token");
  });

  it("unsolicited notifier-webhook tokens are ignored", async () => {
    const r = await fetch(`${h.url}/webhook/upstox/notifier`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message_type: "access_token", access_token: "attacker", client_id: "mock-api-key" }) });
    expect((await r.json()).ignored).toBe(true);
  });

  it("live option chain + margin + broker charges come through", async () => {
    const c = await h.api("GET", "/api/chain?u=NIFTY&expiry=2026-10-13");
    expect(c.status).toBe(200);
    const chain = c.body as unknown as Chain;
    expect(chain.spot).toBeGreaterThan(20000);
    expect(chain.rows.length).toBeGreaterThan(50);
    const r = suggest({ underlying: "NIFTY", dir: "above", mode: "stays", level: 22300, expiryDate: "2026-10-13", risk: 5000 }, chain, { now: FIXTURE_NOW });
    const sg = r.suggestions[0]!;
    const m = await h.api("POST", "/api/margin", { legs: sg.legs.map((l) => ({ key: l.inst.key, qty: l.qty, side: l.side, product: "D", price: l.price })) });
    expect(m.status).toBe(200);
    expect(m.body.final).toBeLessThan(m.body.required as number);
    const b = await h.api("POST", "/api/charges/broker", { key: sg.legs[0]!.inst.key, qty: sg.qty, side: "BUY", product: "D", price: sg.legs[0]!.price });
    expect(b.body.total).toBeCloseTo(sg.legs.length ? (b.body.total as number) : 0);
  });

  it("spots for the picker: real price only; no day change or sparkline when the broker gives none", async () => {
    const r = await h.api("GET", "/api/spots?u=NIFTY,RELIANCE,NOPE&spark=NIFTY");
    expect(r.status).toBe(200);
    const sp = r.body.spots as Record<string, { ltp: number | null; changePct: number | null; spark: number[] | null }>;
    expect(sp.NIFTY!.ltp).toBeGreaterThan(20000);
    expect(sp.NIFTY!.changePct).toBeNull(); // the mock's quotes carry no net_change
    expect(sp.NIFTY!.spark).toBeNull(); // the mock has no intraday candles
    expect(sp.NOPE).toEqual({ ltp: null, changePct: null, spark: null });
  });

  it("market status comes from the official holiday list", async () => {
    const m = await h.api("GET", "/api/market");
    const fo = (m.body.sessions as { exchange: string; market: string; state: string }[]).find((x) => x.exchange === "NSE" && x.market === "FO")!;
    expect(fo.state).toBe("open");
  });
});

describe("gateway: trading, risk and kill switches", () => {
  let h: Harness;
  let chain: Chain;
  const legsOf = (risk = 5000) => {
    const sg = suggest({ underlying: "NIFTY", dir: "above", mode: "stays", level: 22300, expiryDate: "2026-10-13", risk }, chain, { now: FIXTURE_NOW }).suggestions[0]!;
    return { sg, legs: sg.legs.map((l) => ({ key: l.inst.key, side: l.side, qty: l.qty, limit: l.limit })) };
  };
  beforeAll(async () => {
    h = await startHarness({ LIVE_TRADING_ENABLED: "1" });
    await h.brokerLogin();
    chain = (await h.api("GET", "/api/chain?u=NIFTY&expiry=2026-10-13")).body as unknown as Chain;
  });
  afterAll(async () => h.close());

  it("paper trade fills against the live book and is labelled paper; nothing reaches the broker", async () => {
    const before = (await h.mockState()).orders.length;
    const r = await h.api("POST", "/api/trade/options", { mode: "paper", legs: legsOf().legs });
    expect(r.status).toBe(200);
    expect(r.body.paper).toBe(true);
    expect((r.body.result as { status: string }).status).toBe("filled");
    expect((await h.mockState()).orders.length).toBe(before);
    const pf = await h.api("GET", "/api/portfolio?mode=paper");
    expect((pf.body.positions as unknown[]).length).toBe(2);
    expect((pf.body.positions as { paper: boolean }[]).every((p) => p.paper)).toBe(true);
    const o = await h.api("GET", "/api/orders?mode=paper");
    expect((o.body.orders as { id: string }[])[0]!.id).toMatch(/^PAPER-/);
  });

  it("live trade needs the typed REAL MONEY phrase", async () => {
    const r = await h.api("POST", "/api/trade/options", { mode: "live", legs: legsOf().legs, confirm: "yes" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("confirm");
  });

  it("only defined-risk structures are accepted (no naked short, no mismatched legs)", async () => {
    const { legs } = legsOf();
    const short = legs.find((l) => l.side === "SELL")!;
    expect((await h.api("POST", "/api/trade/options", { mode: "paper", legs: [short] })).body.error).toBe("defined-risk");
    expect((await h.api("POST", "/api/trade/options", { mode: "paper", legs: [legs[0], { ...legs[1], qty: legs[1]!.qty * 2 }] })).body.error).toBe("defined-risk");
  });

  it("live trade: hedge first, IOC LIMIT orders with slicing, then audited", async () => {
    await fetch(`${h.mockUrl}/__mock/reset`, { method: "POST" });
    const r = await h.api("POST", "/api/trade/options", { mode: "live", legs: legsOf().legs, confirm: "REAL MONEY" });
    expect(r.status).toBe(200);
    expect(r.body.paper).toBe(false);
    expect((r.body.result as { status: string }).status).toBe("filled");
    const st = await h.mockState();
    const places = st.requests.filter((x) => x.path === "/v3/order/place");
    expect(places.map((p) => (p as unknown as { body: { transaction_type: string; order_type: string; validity: string; slice: boolean } }).body)).toEqual([
      expect.objectContaining({ transaction_type: "BUY", order_type: "LIMIT", validity: "IOC", slice: true }),
      expect.objectContaining({ transaction_type: "SELL", order_type: "LIMIT", validity: "IOC", slice: true }),
    ]);
    const a = await h.api("GET", "/api/audit?limit=50");
    const types = (a.body.entries as { type: string }[]).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["trade.start", "order.send", "order.sent", "trade.done"]));
  });

  it("live trade: short leg rejected → bought leg unwound", async () => {
    await fetch(`${h.mockUrl}/__mock/reset`, { method: "POST" });
    await h.scenario({ rejectSides: ["SELL"] });
    const r = await h.api("POST", "/api/trade/options", { mode: "live", legs: legsOf().legs, confirm: "REAL MONEY" });
    const res = r.body.result as { status: string; unwinds: { side: string; filled: number; qty: number }[] };
    expect(res.status).toBe("unwound");
    expect(res.unwinds[0]).toMatchObject({ side: "SELL" });
    expect(res.unwinds[0]!.filled).toBe(res.unwinds[0]!.qty);
    const net = (await h.mockState()).orders.reduce((m: Record<string, number>, o) => {
      const k = String(o.instrument_token);
      m[k] = (m[k] ?? 0) + (o.transaction_type === "BUY" ? 1 : -1) * Number(o.filled_quantity);
      return m;
    }, {});
    expect(Object.values(net).every((q) => q === 0)).toBe(true);
  });

  it("per-trade cap (off by default) blocks a trade above it once set", async () => {
    expect((await h.api("GET", "/api/risk")).body.perTradeCap).toBeNull();
    await h.api("PUT", "/api/risk", { perTradeCap: "1000" });
    const r = await h.api("POST", "/api/trade/options", { mode: "paper", legs: legsOf().legs });
    expect((r.body.result as { status: string; legs: { error?: string }[] }).status).toBe("nothing-filled");
    expect((r.body.result as { legs: { error?: string }[] }).legs[0]!.error).toMatch(/per-trade cap/);
    await h.api("PUT", "/api/risk", { perTradeCap: "" });
  });

  it("kill switch blocks new entries; Exit all closes positions with LIMIT orders; Cancel all works", async () => {
    await fetch(`${h.mockUrl}/__mock/reset`, { method: "POST" });
    await h.api("POST", "/api/trade/options", { mode: "live", legs: legsOf().legs, confirm: "REAL MONEY" });
    await h.api("POST", "/api/kill/switch", { on: true });
    const blocked = await h.api("POST", "/api/trade/options", { mode: "live", legs: legsOf().legs, confirm: "REAL MONEY" });
    expect((blocked.body.result as { legs: { error?: string }[] }).legs[0]!.error).toMatch(/Kill switch/);
    expect((await h.api("POST", "/api/kill/exit-all", { mode: "live", confirm: "nope" })).status).toBe(400);
    const ex = await h.api("POST", "/api/kill/exit-all", { mode: "live", confirm: "EXIT ALL" });
    expect(ex.status).toBe(200);
    const st = await h.mockState();
    const net: Record<string, number> = {};
    for (const o of st.orders) net[String(o.instrument_token)] = (net[String(o.instrument_token)] ?? 0) + (o.transaction_type === "BUY" ? 1 : -1) * Number(o.filled_quantity);
    expect(Object.values(net).every((q) => q === 0)).toBe(true);
    expect(st.orders.every((o) => o.order_type === "LIMIT")).toBe(true);
    // the delivery holding (RELIANCE) is not touched by Exit all
    expect((ex.body.skipped as { reason: string }[]).some((s) => /delivery holding/.test(s.reason))).toBe(true);
    expect((await h.api("POST", "/api/kill/cancel-all", { mode: "live" })).status).toBe(200);
    await h.api("POST", "/api/kill/switch", { on: false });
  });

  it("orders stay under 10 per second at the broker (rate limiter, 5/s default)", async () => {
    const st = await h.mockState();
    const ts = st.requests.filter((x) => /order\/place/.test(x.path)).map((x) => x.ts).sort((a, b) => a - b);
    for (let i = 0; i < ts.length; i++) expect(ts.filter((t) => t >= ts[i]! && t < ts[i]! + 1000).length).toBeLessThanOrEqual(5);
  });

  it("equity: a SELL must reduce holdings; a BUY goes as a DAY LIMIT", async () => {
    const q = await h.api("GET", "/api/instruments/equity?q=reliance");
    const rel = (q.body.results as { key: string }[])[0]!;
    const sellTooMany = await h.api("POST", "/api/trade/equity", { mode: "live", key: rel.key, side: "SELL", qty: 50, limit: 1189.7, product: "D", confirm: "REAL MONEY" });
    expect(sellTooMany.body).toMatchObject({ placed: false, rule: "not-reducing" });
    const buy = await h.api("POST", "/api/trade/equity", { mode: "live", key: rel.key, side: "BUY", qty: 2, limit: 1190, product: "D", confirm: "REAL MONEY" });
    expect(buy.body.placed).toBe(true);
  });

  it("GTT place/list/cancel (live only)", async () => {
    const q = await h.api("GET", "/api/instruments/equity?q=reliance");
    const rel = (q.body.results as { key: string }[])[0]!;
    const p = await h.api("POST", "/api/gtt", { confirm: "REAL MONEY", gtt: { key: rel.key, side: "SELL", qty: 10, product: "D", rules: [{ strategy: "ENTRY", triggerType: "BELOW", triggerPrice: 1100 }] } });
    expect(p.status).toBe(200);
    const id = (p.body.ids as string[])[0]!;
    expect(((await h.api("GET", "/api/gtt")).body.gtt as { id: string }[]).map((g) => g.id)).toContain(id);
    expect((await h.api("DELETE", `/api/gtt/${id}`)).status).toBe(200);
  });

  it("expired broker token → session dropped, UI told to log in again", async () => {
    await fetch(`${h.mockUrl}/__mock/expire-token`, { method: "POST" });
    const r = await h.api("GET", "/api/portfolio?mode=live");
    expect(r.status).toBe(401);
    expect((await h.api("GET", "/api/session")).body.broker).toMatchObject({ loggedIn: false });
  });

  it("the audit log is hash-chained and verifies; no secrets inside", () => {
    const lines = readFileSync(join(h.dataDir, "audit.jsonl"), "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(10);
    expect(AuditLog.verify(lines)).toEqual({ ok: true, badAt: null });
    const tampered = [...lines];
    tampered[3] = tampered[3]!.replace('"type":"', '"type":"x');
    expect(AuditLog.verify(tampered).ok).toBe(false);
    const all = lines.join("\n");
    expect(all).not.toContain("mock-access-token");
    expect(all).not.toContain("mock-api-secret");
    expect(all).not.toContain(PASS);
  });
});

describe("gateway: live trading is OFF unless the server enables it", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
    await h.brokerLogin();
  });
  afterAll(async () => h.close());
  it("returns live-disabled even with the phrase", async () => {
    const r = await h.api("POST", "/api/trade/options", { mode: "live", legs: [], confirm: "REAL MONEY" });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("live-disabled");
    expect((await h.api("GET", "/api/session")).body.liveTrading).toBe(false);
  });
});
