// The gateway: a small single-user HTTP server that sits on a static-IP VPS between
// the static frontend and the broker. It holds the broker api secret (env), does the
// OAuth code → token exchange, proxies market data, runs every order through the
// server-side risk checks, executes multi-leg trades with leg-fail unwind, keeps the
// paper book, and writes a hash-chained audit log.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayConfig } from "./config.ts";
import type { BrokerAdapter, MarginLeg, Result } from "./brokers/types.ts";
import { AuditLog } from "./audit.ts";
import { StateStore } from "./state.ts";
import { verifyPassphrase, signJwt, verifyJwt, makeState, checkState, LoginThrottle } from "./auth.ts";
import { InstrumentStore, INDICES, type Instrument } from "../src/core/instruments.ts";
import { HolidayCalendar, marketSession, type MarketSession } from "../src/core/calendar.ts";
import type { Chain, Quote } from "../src/core/chain.ts";
import { checkOrder, confirmPhraseOk, RateLimiter, sanitizeRiskConfig, type OrderIntent, type RiskState, REAL_MONEY_PHRASE } from "../src/core/risk.ts";
import { executeLegs, closePosition, type ExecBroker, type ExecDeps, type PlaceRequest, type ExecResult, type UnwindResult } from "../src/core/execution.ts";
import { PaperBroker, unrealised } from "../src/core/paper.ts";
import { protectiveLimit, alignToTick } from "../src/core/rules.ts";
import { charges, sumCharges } from "../src/core/charges.ts";
import { legsPayoff } from "../src/core/strategy.ts";
import { istDate, istParts } from "../src/core/ist.ts";
import { round2 } from "../src/core/money.ts";

export const VERSION = "0.1.0";

export interface GatewayDeps {
  config: GatewayConfig;
  adapter: BrokerAdapter;
  now?: () => number;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

type Mode = "paper" | "live";
interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
  ip: string;
  origin: string | null;
  auth: Record<string, unknown> | null;
  raw: IncomingMessage;
}
type Reply = { status: number; body?: unknown; headers?: Record<string, string>; redirect?: string; stream?: (res: ServerResponse) => void };
type Handler = (r: Req) => Promise<Reply> | Reply;

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (code: string, msg: string, status = 400): never => {
  throw new HttpError(status, code, msg);
};

const ok = (body: unknown): Reply => ({ status: 200, body });
const unwrap = <T>(r: Result<T>, status = 502): T => (r.ok ? r.value : bad(r.code ?? "broker", r.error, r.status === 401 ? 401 : status));

function serializeInst(i: Instrument): Pick<Instrument, "key" | "symbol" | "type" | "strike" | "expiryDate" | "lotSize" | "underlying" | "exchange"> {
  return { key: i.key, symbol: i.symbol, type: i.type, strike: i.strike, expiryDate: i.expiryDate, lotSize: i.lotSize, underlying: i.underlying, exchange: i.exchange };
}
function serializeExec(r: ExecResult): unknown {
  return {
    ...r,
    legs: r.legs.map((l) => ({ ...l, inst: serializeInst(l.inst) })),
    unwinds: r.unwinds.map((u) => ({ ...u, inst: serializeInst(u.inst) })),
    residual: r.residual.map((x) => ({ inst: serializeInst(x.inst), netQty: x.netQty })),
  };
}

/** The gateway clock: real time, or (tests only) a fixed start that then advances in real time. */
export function makeClock(config: Pick<GatewayConfig, "fakeNow">): () => number {
  if (config.fakeNow === null) return Date.now;
  const startReal = Date.now();
  return () => config.fakeNow! + (Date.now() - startReal);
}

export function createGateway(deps: GatewayDeps) {
  const { config, adapter } = deps;
  const now = deps.now ?? makeClock(config);
  const log = deps.log ?? ((m: string) => console.log(`[gateway] ${m}`));
  const audit = new AuditLog(config.dataDir ? `${config.dataDir}/audit.jsonl` : null);
  const store$ = new StateStore(config.dataDir, config.jwtSecret);
  const throttle = new LoginThrottle();
  const limiter = new RateLimiter(config.risk.maxOrdersPerSecond);
  let store: InstrumentStore | null = null;
  let storeError: string | null = null;
  let cal: HolidayCalendar | null = null;
  let calError: string | null = null;
  let approvalPendingUntil = 0;
  const quoteCache = new Map<string, Quote>();
  const chainCache = new Map<string, { at: number; chain: Chain }>();
  let busy = false; // one trade at a time

  const restored = store$.loadBroker(now());
  if (restored) adapter.setSession(restored.token, restored.session);

  const riskConfig = () => ({ ...config.risk, perTradeCap: store$.state.perTradeCap, dailyLossCap: store$.state.dailyLossCap });

  const paper = new PaperBroker(store$.state.paper, (k) => store?.get(k), async (k) => (await quotesFor([k]))[k] ?? null, now, (s) => {
    store$.state.paper = s;
    store$.save();
  });

  // ── reference data ─────────────────────────────────────────────────
  async function loadReference(): Promise<void> {
    try {
      const list = await adapter.instruments();
      store = new InstrumentStore(list, now());
      storeError = null;
      log(`instrument master: ${store.size} instruments`);
    } catch (e) {
      storeError = (e as Error).message;
      log(`instrument master unavailable: ${storeError}`);
    }
    try {
      cal = await adapter.holidays();
      calError = null;
    } catch (e) {
      calError = (e as Error).message;
      log(`holiday list unavailable: ${calError}`);
    }
  }
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  function scheduleRefresh(): void {
    // the BOD master is published each morning: reload once per IST day after 08:00
    refreshTimer = setInterval(() => {
      const t = now();
      if (istParts(t).hh >= 8 && (!store || istDate(store.loadedAt) !== istDate(t))) void loadReference();
    }, 10 * 60_000);
    refreshTimer.unref?.();
  }

  const needStore = (): InstrumentStore => store ?? bad("no-instruments", `Instrument master not loaded${storeError ? `: ${storeError}` : ""}`, 503);
  const sessionFor = (inst: Instrument): MarketSession => {
    if (!cal) return { exchange: inst.exchange, state: "closed", canTrade: false, label: `Holiday list unavailable${calError ? `: ${calError}` : ""}; trading paused`, opensAt: null, closesAt: null };
    return marketSession(now(), inst.exchange, cal, inst.type === "EQ" ? "EQ" : "FO");
  };

  // ── market data ────────────────────────────────────────────────────
  async function quotesFor(keys: string[], maxAgeMs = 1500): Promise<Record<string, Quote>> {
    const t = now();
    const stale = keys.filter((k) => !(t - (quoteCache.get(k)?.ts ?? 0) < maxAgeMs));
    if (stale.length && adapter.session()) {
      const r = await adapter.quotes(stale);
      if (r.ok) for (const [k, q] of Object.entries(r.value)) quoteCache.set(k, q);
    }
    const out: Record<string, Quote> = {};
    for (const k of keys) {
      const q = quoteCache.get(k);
      if (q && t - q.ts < 60_000) out[k] = q;
    }
    return out;
  }

  async function chainFor(u: string, expiry: string): Promise<Chain> {
    const s = needStore();
    if (!adapter.session()) bad("no-session", "Log in to Upstox to load live option prices", 401);
    const key = `${u}:${expiry}`;
    const c = chainCache.get(key);
    if (c && now() - c.at < 2500) return c.chain;
    const chain = unwrap(await adapter.optionChain(s, u, expiry));
    chainCache.set(key, { at: now(), chain });
    for (const r of chain.rows) for (const sd of [r.call, r.put]) if (sd?.q) quoteCache.set(sd.inst.key, sd.q);
    return chain;
  }

  // ── positions & risk state ─────────────────────────────────────────
  async function riskState(mode: Mode): Promise<RiskState> {
    const netQtyByKey: Record<string, number> = {};
    let todayPnl: number | null = 0;
    if (mode === "paper") {
      const today = istDate(now());
      const ps = Object.values(paper.state.positions);
      const q = await quotesFor(ps.filter((p) => p.qty !== 0).map((p) => p.instrumentKey));
      for (const p of ps) {
        netQtyByKey[p.instrumentKey] = p.qty;
        if (p.dayDate === today) {
          const u = unrealised(p, q[p.instrumentKey]?.ltp ?? null);
          todayPnl = todayPnl === null || u === null ? null : todayPnl + p.realised - p.charges + u;
        }
      }
    } else {
      const pos = await adapter.positions();
      if (pos.ok) {
        for (const p of pos.value) {
          netQtyByKey[p.key] = (netQtyByKey[p.key] ?? 0) + p.qty;
          todayPnl = todayPnl === null || p.pnl === null ? null : todayPnl + p.pnl;
        }
      } else todayPnl = null;
      const h = await adapter.holdings();
      if (h.ok) for (const x of h.value) netQtyByKey[x.key] = (netQtyByKey[x.key] ?? 0) + x.qty;
    }
    return { killSwitch: store$.state.killSwitch, todayPnl, netQtyByKey };
  }

  function rateLimited(b: ExecBroker): ExecBroker {
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    return {
      async place(r) {
        let w = limiter.waitMs(now());
        while (w > 0) {
          await sleep(w);
          w = limiter.waitMs(now());
        }
        limiter.record(now());
        return b.place(r);
      },
      status: (id) => b.status(id),
      cancel: (id) => b.cancel(id),
    };
  }

  function execDeps(mode: Mode, rs0: RiskState, tradeWorstLoss: number | undefined, product: "D" | "I", tag: string): ExecDeps {
    const broker = rateLimited(mode === "live" ? adapter : paper);
    const s = needStore();
    let rs = rs0;
    return {
      broker: {
        async place(r: PlaceRequest) {
          audit.append("order.send", { mode, ...r }, now());
          const res = await broker.place(r);
          audit.append(res.ok ? "order.sent" : "order.rejected", { mode, instrumentKey: r.instrumentKey, side: r.side, qty: r.qty, limit: r.limit, ...(res.ok ? { orderIds: res.orderIds } : { error: res.error }) }, now());
          return res;
        },
        async status(id) {
          return broker.status(id);
        },
        async cancel(id) {
          audit.append("order.cancel", { mode, orderId: id }, now());
          return broker.cancel(id);
        },
      },
      async check(r) {
        const inst = s.get(r.instrumentKey);
        const q = (await quotesFor([r.instrumentKey], 1000))[r.instrumentKey] ?? null;
        const intent: OrderIntent = { instrumentKey: r.instrumentKey, side: r.side, qty: r.qty, orderType: "LIMIT", limitPrice: r.limit, product: r.product, purpose: r.purpose };
        // exits/unwinds must reduce what is held *now* (including fills from this very trade)
        if (r.purpose !== "entry") rs = await riskState(mode);
        const res = checkOrder(intent, { config: riskConfig(), state: rs, inst, quote: q, session: inst ? sessionFor(inst) : sessionFor({ exchange: "NSE", type: "CE" } as Instrument), now: now(), tradeWorstLoss: r.purpose === "entry" ? tradeWorstLoss : undefined });
        if (!res.ok) audit.append("risk.block", { mode, instrumentKey: r.instrumentKey, side: r.side, qty: r.qty, limit: r.limit, purpose: r.purpose, rule: res.code, message: res.message }, now());
        return res;
      },
      async unwindLimit(inst, side, attempt) {
        const q = (await quotesFor([inst.key], 500))[inst.key];
        const touch = side === "SELL" ? (q?.bid ?? q?.ltp) : (q?.ask ?? q?.ltp);
        const slip = Math.min(riskConfig().maxExitSlippage, 0.05 * attempt);
        if (!touch) return side === "SELL" ? inst.tickPaise / 100 : alignToTick(1e7, inst.tickPaise, "down");
        return protectiveLimit(side, touch, inst.tickPaise, slip);
      },
      product,
      tag,
      sleep: deps.sleep,
      pollMs: 300,
      timeoutMs: 8000,
    };
  }

  function requireMode(b: Record<string, unknown>): Mode {
    const m = b.mode;
    if (m !== "paper" && m !== "live") bad("mode", 'mode must be "paper" or "live"');
    return m as Mode;
  }
  function requireLive(b: Record<string, unknown>, what: string): void {
    if (!config.liveTrading) bad("live-disabled", "Live trading is disabled on this gateway. Set LIVE_TRADING_ENABLED=1 on the server to allow real orders.", 403);
    if (adapter.info.sandbox) bad("sandbox", "This gateway points at the Upstox sandbox: use npm run test:live for sandbox orders.", 403);
    if (!adapter.session()) bad("no-session", "Log in to Upstox first", 401);
    if (!confirmPhraseOk(b.confirm)) bad("confirm", `Type ${REAL_MONEY_PHRASE} to ${what}`, 400);
  }

  /** Server-side worst case for a 1- or 2-leg defined-risk option trade at the limit prices, plus entry charges. */
  function worstLossOf(legs: { inst: Instrument; side: "BUY" | "SELL"; qty: number; limit: number }[]): number {
    const ks = legs.map((l) => l.inst.strike!);
    const pts = [0.01, ...ks, Math.max(...ks) * 10];
    const pay = legs.map((l) => ({ inst: l.inst, side: l.side, qty: l.qty, price: l.limit }));
    const worst = Math.min(...pts.map((S) => legsPayoff(pay, S)));
    const date = istDate(now());
    const ch = sumCharges(legs.map((l) => charges({ segment: "OPT", exchange: l.inst.exchange, side: l.side, qty: l.qty, price: l.limit, date })));
    return round2(Math.max(0, -worst) + ch.total);
  }

  async function withLock<T>(f: () => Promise<T>): Promise<T> {
    if (busy) bad("busy", "Another order is being placed; wait for it to finish", 409);
    busy = true;
    try {
      return await f();
    } finally {
      busy = false;
    }
  }

  // ── routes ─────────────────────────────────────────────────────────
  const routes: { method: string; re: RegExp; auth: boolean; h: Handler }[] = [];
  const route = (method: string, path: string, auth: boolean, h: Handler) => routes.push({ method, re: new RegExp(`^${path}$`), auth, h });

  route("GET", "/health", false, () => ok({ ok: true, version: VERSION, time: now(), broker: adapter.info.id, instruments: store ? store.size : 0, holidays: cal ? cal.source : null }));

  route("POST", "/auth/login", false, (r) => {
    const t = now();
    if (throttle.blocked(r.ip, t)) bad("throttled", "Too many failed attempts; try again in 15 minutes", 429);
    if (typeof r.body.passphrase !== "string" || !verifyPassphrase(r.body.passphrase, config.passphraseHash)) {
      throttle.fail(r.ip, t);
      audit.append("auth.fail", { ip: r.ip }, t);
      bad("auth", "Wrong passphrase", 401);
    }
    throttle.reset(r.ip);
    const exp = Math.floor((t + config.jwtTtlMs) / 1000);
    audit.append("auth.ok", { ip: r.ip }, t);
    return ok({ token: signJwt({ sub: "owner", iat: Math.floor(t / 1000), exp }, config.jwtSecret), expiresAt: exp * 1000 });
  });

  route("GET", "/auth/broker/login", true, () => ok({ url: adapter.loginUrl(makeState(config.jwtSecret, now())) }));

  route("GET", "/auth/broker/callback", false, async (r) => {
    const back = (frag: string): Reply => (config.frontendUrl ? { status: 302, redirect: `${config.frontendUrl}#${frag}` } : ok({ result: frag }));
    const state = r.query.get("state") ?? "";
    const code = r.query.get("code") ?? "";
    if (!checkState(state, config.jwtSecret, now())) {
      audit.append("broker.login.bad-state", {}, now());
      return back("broker=bad-state");
    }
    if (!code) return back("broker=no-code");
    const ex = await adapter.exchangeCode(code);
    if (!ex.ok) {
      audit.append("broker.login.fail", { error: ex.error }, now());
      return back("broker=failed");
    }
    const { accessToken, ...session } = ex.value;
    adapter.setSession(accessToken, session);
    store$.saveBroker(accessToken, session);
    audit.append("broker.login.ok", { userId: session.userId, expiresAt: session.expiresAt }, now());
    return back("broker=connected");
  });

  route("POST", "/auth/broker/request", true, async () => {
    if (!adapter.requestApproval) bad("unsupported", "This broker has no approval-request login");
    const r = unwrap(await adapter.requestApproval!());
    approvalPendingUntil = r.expiresAt;
    audit.append("broker.approval.requested", { expiresAt: r.expiresAt }, now());
    return ok({ requested: true, expiresAt: r.expiresAt, note: "Approve the request in the Upstox app or WhatsApp; the token is delivered to this gateway's notifier webhook." });
  });

  route("POST", "/webhook/upstox/notifier", false, async (r) => {
    const b = r.body;
    if (b.message_type !== "access_token" || typeof b.access_token !== "string") return ok({ ignored: true });
    if (!(approvalPendingUntil > now())) {
      audit.append("broker.webhook.unsolicited", { userId: b.user_id ?? null }, now());
      return ok({ ignored: true });
    }
    if (b.client_id !== config.upstox.apiKey) return ok({ ignored: true });
    const v = await adapter.verifyToken(b.access_token);
    if (!v.ok) {
      audit.append("broker.webhook.invalid", { error: v.error }, now());
      return ok({ ignored: true });
    }
    const prev = adapter.session();
    if (prev?.userId && v.value.userId && prev.userId !== v.value.userId) {
      audit.append("broker.webhook.wrong-user", { userId: v.value.userId }, now());
      return ok({ ignored: true });
    }
    const expiresAt = Number(b.expires_at) || now() + 3600_000;
    const session = { userId: v.value.userId, userName: v.value.userName, obtainedAt: now(), expiresAt };
    adapter.setSession(b.access_token, session);
    store$.saveBroker(b.access_token, session);
    approvalPendingUntil = 0;
    audit.append("broker.login.ok", { via: "approval", userId: session.userId, expiresAt }, now());
    return ok({ received: true });
  });

  route("POST", "/auth/broker/logout", true, async () => {
    await adapter.logout();
    store$.saveBroker(null, null);
    audit.append("broker.logout", {}, now());
    return ok({ loggedOut: true });
  });

  route("GET", "/api/session", true, async () => {
    const s = adapter.session();
    const t = now();
    const markets = cal ? (["NSE", "BSE"] as const).flatMap((ex) => (["FO", "EQ"] as const).map((m) => ({ ...marketSession(t, ex, cal!, m), market: m }))) : [];
    return ok({
      now: t,
      version: VERSION,
      broker: { ...adapter.info, loggedIn: Boolean(s), userId: s?.userId ?? null, userName: s?.userName ?? null, expiresAt: s?.expiresAt ?? null, approvalPendingUntil: approvalPendingUntil > t ? approvalPendingUntil : null },
      liveTrading: config.liveTrading && !adapter.info.sandbox,
      killSwitch: store$.state.killSwitch,
      risk: riskConfig(),
      instruments: store ? { count: store.size, loadedAt: store.loadedAt } : { count: 0, error: storeError },
      holidays: cal ? { source: cal.source } : { error: calError },
      markets,
      confirmPhrase: REAL_MONEY_PHRASE,
    });
  });

  route("GET", "/api/market", true, () => {
    if (!cal) bad("no-holidays", `Holiday list unavailable${calError ? `: ${calError}` : ""}`, 503);
    const t = now();
    return ok({ now: t, source: cal!.source, sessions: (["NSE", "BSE"] as const).flatMap((ex) => (["FO", "EQ"] as const).map((m) => ({ ...marketSession(t, ex, cal!, m), market: m }))) });
  });

  route("GET", "/api/instruments/underlyings", true, () => {
    const s = needStore();
    const t = now();
    return ok({
      loadedAt: s.loadedAt,
      underlyings: s.optionUnderlyings().map((u) => {
        const idx = INDICES.find((d) => d.id === u);
        return { id: u, label: idx?.label ?? u, index: Boolean(idx), exchange: idx?.exchange ?? "NSE", lotSize: s.lotSize(u), spotKey: s.spotKey(u), expiries: s.expiries(u, t) };
      }),
    });
  });

  route("GET", "/api/instruments/expiries", true, (r) => {
    const s = needStore();
    const u = r.query.get("u") ?? bad("u", "u (underlying) is required");
    return ok({ underlying: u, expiries: s.expiries(u, now()) });
  });

  route("GET", "/api/instruments/equity", true, (r) => {
    const s = needStore();
    return ok({ results: s.searchEquity(r.query.get("q") ?? "", 8) });
  });

  route("GET", "/api/chain", true, async (r) => {
    const u = r.query.get("u") ?? bad("u", "u is required");
    const e = r.query.get("expiry") ?? bad("expiry", "expiry is required");
    return ok(await chainFor(u, e));
  });

  route("GET", "/api/quotes", true, async (r) => {
    const keys = (r.query.get("keys") ?? "").split(",").filter(Boolean).slice(0, 200);
    if (!adapter.session()) bad("no-session", "Log in to Upstox for live prices", 401);
    return ok({ quotes: await quotesFor(keys) });
  });

  route("GET", "/api/stream", true, async (r) => {
    const keys = (r.query.get("keys") ?? "").split(",").filter(Boolean).slice(0, 100);
    if (!adapter.session()) bad("no-session", "Log in to Upstox for live prices", 401);
    return {
      status: 200,
      stream: (res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        let closed = false;
        let stop: (() => void) | null = null;
        const push = (k: string, q: Partial<Quote>) => {
          const prev = quoteCache.get(k);
          const merged = { ...(prev ?? { ltp: null, bid: null, ask: null, bidQty: 0, askQty: 0, iv: null, oi: null }), ...q, ts: now() } as Quote;
          quoteCache.set(k, merged);
          if (!closed) res.write(`event: quote\ndata: ${JSON.stringify({ key: k, q: merged })}\n\n`);
        };
        const poll = setInterval(async () => {
          if (closed || stop) return;
          const q = await quotesFor(keys, 1500);
          for (const [k, v] of Object.entries(q)) if (!closed) res.write(`event: quote\ndata: ${JSON.stringify({ key: k, q: v })}\n\n`);
        }, 2000);
        void (async () => {
          try {
            stop = (await adapter.stream?.(keys, push, (why) => {
              stop = null;
              if (!closed) res.write(`event: info\ndata: ${JSON.stringify({ feed: "polling", why })}\n\n`);
            })) ?? null;
          } catch {
            stop = null;
          }
          if (!closed) res.write(`event: info\ndata: ${JSON.stringify({ feed: stop ? "websocket" : "polling" })}\n\n`);
        })();
        r.raw.on("close", () => {
          closed = true;
          clearInterval(poll);
          stop?.();
        });
      },
    };
  });

  route("POST", "/api/margin", true, async (r) => {
    const legs = (Array.isArray(r.body.legs) ? r.body.legs : []) as MarginLeg[];
    if (!legs.length || legs.length > 20) bad("legs", "1–20 legs");
    return ok(unwrap(await adapter.margin(legs)));
  });

  route("POST", "/api/charges/broker", true, async (r) => {
    const b = r.body as unknown as MarginLeg & { price: number };
    return ok(unwrap(await adapter.brokerage(b)));
  });

  route("GET", "/api/risk", true, () => ok({ ...riskConfig(), killSwitch: store$.state.killSwitch }));
  route("PUT", "/api/risk", true, (r) => {
    const next = sanitizeRiskConfig(r.body as never, riskConfig());
    store$.state.perTradeCap = next.perTradeCap;
    store$.state.dailyLossCap = next.dailyLossCap;
    store$.save();
    audit.append("risk.config", { perTradeCap: next.perTradeCap, dailyLossCap: next.dailyLossCap }, now());
    return ok({ ...riskConfig(), killSwitch: store$.state.killSwitch });
  });

  // ── trading ────────────────────────────────────────────────────────
  route("POST", "/api/trade/options", true, async (r) => {
    const mode = requireMode(r.body);
    if (mode === "live") requireLive(r.body, "send this trade");
    const s = needStore();
    const raw = (Array.isArray(r.body.legs) ? r.body.legs : []) as { key: string; side: "BUY" | "SELL"; qty: number; limit: number }[];
    if (raw.length < 1 || raw.length > 2) bad("legs", "An options trade here is one bought option or a two-leg spread");
    const legs = raw.map((l) => {
      const inst = s.get(String(l.key));
      if (!inst || (inst.type !== "CE" && inst.type !== "PE")) bad("legs", `Not an option in today's master: ${l.key}`);
      if (l.side !== "BUY" && l.side !== "SELL") bad("legs", "side must be BUY or SELL");
      return { inst: inst!, side: l.side, qty: Number(l.qty), limit: Number(l.limit) };
    });
    // defined risk only: a lone option must be bought; a pair must be a vertical (same underlying/expiry/type, one bought, one sold, same size)
    if (legs.length === 1 && legs[0]!.side !== "BUY") bad("defined-risk", "A single option can only be bought (selling it alone has unlimited risk)");
    if (legs.length === 2) {
      const [a, b] = legs as [(typeof legs)[0], (typeof legs)[0]];
      if (a.inst.underlying !== b.inst.underlying || a.inst.expiryDate !== b.inst.expiryDate || a.inst.type !== b.inst.type || a.side === b.side || a.qty !== b.qty)
        bad("defined-risk", "Two legs must form a vertical spread: same underlying, expiry and option type, one bought and one sold, equal size");
    }
    const worst = worstLossOf(legs);
    const product = r.body.product === "I" ? "I" : "D";
    return withLock(async () => {
      const rs = await riskState(mode);
      const tag = `pei-${mode}-${now().toString(36)}`;
      audit.append("trade.start", { mode, tag, legs: legs.map((l) => ({ key: l.inst.key, symbol: l.inst.symbol, side: l.side, qty: l.qty, limit: l.limit })), worstLoss: worst, view: r.body.view ?? null }, now());
      const res = await executeLegs(legs.map((l) => ({ inst: l.inst, side: l.side, qty: l.qty, limit: l.limit })), execDeps(mode, rs, worst, product, tag));
      audit.append("trade.done", { mode, tag, status: res.status, matchedQty: res.matchedQty, log: res.log, residual: res.residual.map((x) => ({ key: x.inst.key, netQty: x.netQty })) }, now());
      return ok({ mode, paper: mode === "paper", worstLoss: worst, result: serializeExec(res) });
    });
  });

  route("POST", "/api/trade/equity", true, async (r) => {
    const mode = requireMode(r.body);
    if (mode === "live") requireLive(r.body, "send this order");
    const s = needStore();
    const inst = s.get(String(r.body.key));
    if (!inst || inst.type !== "EQ") bad("instrument", "Not an equity in today's master");
    const side = r.body.side === "SELL" ? "SELL" : r.body.side === "BUY" ? "BUY" : bad("side", "side must be BUY or SELL");
    const qty = Number(r.body.qty), limit = Number(r.body.limit);
    const product = r.body.product === "I" ? "I" : "D";
    return withLock(async () => {
      const rs = await riskState(mode);
      // a SELL must reduce what you hold (no short selling in cash); a BUY is an entry
      const purpose = side === "SELL" ? "exit" : "entry";
      const d = execDeps(mode, rs, side === "BUY" ? qty * limit : undefined, product, `pei-eq-${now().toString(36)}`);
      const req: PlaceRequest = { instrumentKey: inst!.key, side, qty, limit, product, validity: "DAY", tag: d.tag, purpose };
      const rc = await d.check(req);
      if (!rc.ok) return ok({ mode, paper: mode === "paper", placed: false, rule: rc.code, message: rc.message });
      const p = await d.broker.place(req);
      if (!p.ok) return ok({ mode, paper: mode === "paper", placed: false, message: p.error });
      const st = await d.broker.status(p.orderIds[0]!);
      return ok({ mode, paper: mode === "paper", placed: true, orderIds: p.orderIds, status: st });
    });
  });

  route("GET", "/api/orders", true, async (r) => {
    const mode = (r.query.get("mode") ?? "paper") as Mode;
    if (mode === "paper") {
      await paper.sweep();
      return ok({ mode, paper: true, orders: [...paper.state.orders].reverse() });
    }
    return ok({ mode, paper: false, orders: unwrap(await adapter.orders()) });
  });

  route("GET", "/api/trades", true, async (r) => {
    const mode = (r.query.get("mode") ?? "paper") as Mode;
    if (mode === "paper") return ok({ mode, paper: true, trades: paper.state.orders.filter((o) => o.filled > 0).map((o) => ({ tradeId: o.id, orderId: o.id, key: o.instrumentKey, symbol: o.symbol, side: o.side, qty: o.filled, price: o.avgPrice, ts: o.ts, paper: true })).reverse() });
    return ok({ mode, paper: false, trades: unwrap(await adapter.trades()) });
  });

  route("POST", "/api/orders/cancel", true, async (r) => {
    const mode = requireMode(r.body);
    const id = String(r.body.orderId ?? "");
    audit.append("order.cancel", { mode, orderId: id }, now());
    if (mode === "paper") await paper.cancel(id);
    else await adapter.cancel(id);
    return ok({ cancelled: id });
  });

  route("POST", "/api/orders/modify", true, async (r) => {
    const mode = requireMode(r.body);
    if (mode === "paper") bad("paper", "Paper orders can be cancelled, not modified");
    requireLive(r.body, "modify this order");
    const price = Number(r.body.price);
    audit.append("order.modify", { orderId: r.body.orderId, price, qty: r.body.qty ?? null }, now());
    return ok({ orderId: unwrap(await adapter.modify(String(r.body.orderId), { price, qty: r.body.qty ? Number(r.body.qty) : undefined, validity: "DAY" })) });
  });

  route("GET", "/api/portfolio", true, async (r) => {
    const mode = (r.query.get("mode") ?? "paper") as Mode;
    if (mode === "paper") {
      await paper.sweep();
      const ps = Object.values(paper.state.positions);
      const q = await quotesFor(ps.map((p) => p.instrumentKey));
      const positions = ps.map((p) => {
        const ltp = q[p.instrumentKey]?.ltp ?? null;
        const u = unrealised(p, ltp);
        return { key: p.instrumentKey, symbol: p.symbol, qty: p.qty, avgPrice: p.avgPrice || null, ltp, realised: p.realised, unrealised: u, charges: p.charges, pnl: u === null ? null : round2(p.realised + u - p.charges), paper: true };
      });
      const total = positions.every((p) => p.pnl !== null) ? round2(positions.reduce((a, p) => a + (p.pnl ?? 0), 0)) : null;
      return ok({ mode, paper: true, positions, holdings: [], funds: null, pnl: total, note: adapter.session() ? null : "Log in to Upstox to mark paper positions at live prices" });
    }
    const [pos, hold, funds] = await Promise.all([adapter.positions(), adapter.holdings(), adapter.funds()]);
    const positions = unwrap(pos);
    return ok({ mode, paper: false, positions, holdings: hold.ok ? hold.value : [], holdingsError: hold.ok ? null : hold.error, funds: funds.ok ? funds.value : null, fundsError: funds.ok ? null : funds.error, pnl: positions.every((p) => p.pnl !== null) ? round2(positions.reduce((a, p) => a + (p.pnl ?? 0), 0)) : null });
  });

  route("POST", "/api/paper/reset", true, () => {
    paper.reset();
    audit.append("paper.reset", {}, now());
    return ok({ reset: true });
  });

  route("GET", "/api/pnl", true, async (r) => {
    const seg = r.query.get("segment") === "EQ" ? "EQ" : "FO";
    const fy = r.query.get("fy") ?? "";
    if (!/^\d{4}$/.test(fy)) bad("fy", "fy like 2627 for FY 2026-27");
    return ok({ rows: unwrap(await adapter.pnlReport(seg, fy)) });
  });

  route("GET", "/api/gtt", true, async () => ok({ gtt: unwrap(await adapter.listGtt()) }));
  route("POST", "/api/gtt", true, async (r) => {
    requireLive(r.body, "place this GTT");
    const g = r.body.gtt as Parameters<BrokerAdapter["placeGtt"]>[0];
    const inst = needStore().get(String(g?.key));
    if (!inst) bad("instrument", "Unknown instrument");
    if (!g.rules?.length || g.rules.length > 3) bad("rules", "1–3 GTT rules");
    for (const x of g.rules) if (!(x.triggerPrice > 0)) bad("rules", "trigger prices must be positive");
    audit.append("gtt.place", { key: g.key, side: g.side, qty: g.qty, rules: g.rules }, now());
    return ok({ ids: unwrap(await adapter.placeGtt(g)) });
  });
  route("DELETE", "/api/gtt/([A-Za-z0-9-]+)", true, async (r) => {
    const id = r.path.split("/").pop()!;
    audit.append("gtt.cancel", { id }, now());
    return ok({ id: unwrap(await adapter.cancelGtt(id)) });
  });

  // ── kill switches ──────────────────────────────────────────────────
  route("POST", "/api/kill/switch", true, (r) => {
    store$.state.killSwitch = Boolean(r.body.on);
    store$.save();
    audit.append("kill.switch", { on: store$.state.killSwitch }, now());
    return ok({ killSwitch: store$.state.killSwitch });
  });

  route("POST", "/api/kill/cancel-all", true, async (r) => {
    const mode = requireMode(r.body);
    audit.append("kill.cancel-all", { mode }, now());
    if (mode === "paper") return ok({ mode, cancelled: paper.cancelAll() });
    if (!adapter.session()) bad("no-session", "Log in to Upstox first", 401);
    return ok({ mode, cancelled: unwrap(await adapter.cancelAll()) });
  });

  route("POST", "/api/kill/exit-all", true, async (r) => {
    const mode = requireMode(r.body);
    if (String(r.body.confirm ?? "").trim().toUpperCase() !== "EXIT ALL") bad("confirm", "Type EXIT ALL to close every position");
    if (mode === "live" && !adapter.session()) bad("no-session", "Log in to Upstox first", 401);
    const s = needStore();
    return withLock(async () => {
      audit.append("kill.exit-all.start", { mode }, now());
      // 1. cancel every open order so nothing new fills while we close
      if (mode === "paper") paper.cancelAll();
      else await adapter.cancelAll();
      // 2. close each position with reduce-only protective IOC limits (sells first frees margin for buys? no: close shorts first, they carry the risk)
      const rs = await riskState(mode);
      const open = Object.entries(rs.netQtyByKey).filter(([, q]) => q !== 0);
      const d = execDeps(mode, rs, undefined, "D", `pei-exit-${now().toString(36)}`);
      const ordered = [...open.filter(([, q]) => q < 0), ...open.filter(([, q]) => q > 0)];
      const results: UnwindResult[] = [];
      const skipped: { key: string; reason: string }[] = [];
      for (const [key, q] of ordered) {
        const inst = s.get(key);
        if (!inst) {
          skipped.push({ key, reason: "not in today's master" });
          continue;
        }
        if (inst.type === "EQ" && mode === "live") {
          // delivery holdings are investments, not trades: Exit all only closes F&O and intraday positions
          const pos = await adapter.positions();
          const intraday = pos.ok ? pos.value.filter((p) => p.key === key && p.product === "I").reduce((a, p) => a + p.qty, 0) : 0;
          if (!intraday) {
            skipped.push({ key, reason: "delivery holding (not closed by Exit all)" });
            continue;
          }
        }
        results.push(await closePosition(inst, q, d));
      }
      audit.append("kill.exit-all.done", { mode, closed: results.map((x) => ({ key: x.inst.key, filled: x.filled, qty: x.qty, error: x.error ?? null })), skipped }, now());
      return ok({ mode, paper: mode === "paper", results: results.map((x) => ({ ...x, inst: serializeInst(x.inst) })), skipped });
    });
  });

  route("GET", "/api/audit", true, (r) => ok({ entries: audit.recent(Math.min(500, Number(r.query.get("limit") ?? 100))) }));

  route("GET", "/api/brokers", true, async () => {
    const { STUB_BROKERS, stubAdapter } = await import("./brokers/stubs.ts");
    return ok({ brokers: [adapter.info, ...STUB_BROKERS.map((b) => stubAdapter(b).info)] });
  });

  // ── HTTP plumbing ──────────────────────────────────────────────────
  function cors(origin: string | null, res: ServerResponse): boolean {
    if (!origin) return true; // same-origin / curl / broker redirect / webhook
    if (!config.corsOrigins.includes(origin.replace(/\/$/, ""))) return false;
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
    return true;
  }

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (req.method === "GET" || req.method === "HEAD") return {};
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) {
      n += (c as Buffer).length;
      if (n > 64 * 1024) bad("too-large", "Body too large", 413);
      chunks.push(c as Buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text) return {};
    try {
      const j = JSON.parse(text);
      return j && typeof j === "object" && !Array.isArray(j) ? j : bad("json", "JSON object expected");
    } catch (e) {
      if (e instanceof HttpError) throw e;
      return bad("json", "Invalid JSON");
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    const origin = (req.headers.origin as string | undefined) ?? null;
    const url = new URL(req.url ?? "/", "http://gateway");
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(body));
    };
    if (!cors(origin, res)) return send(403, { error: "origin", message: "Origin not allowed" });
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    const ip = (config.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "") || req.socket.remoteAddress || "?";
    const rt = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!rt) return send(404, { error: "not-found", message: "No such endpoint" });
    try {
      let auth: Record<string, unknown> | null = null;
      if (rt.auth) {
        const h = String(req.headers.authorization ?? "");
        const tok = h.startsWith("Bearer ") ? h.slice(7) : url.pathname === "/api/stream" ? (url.searchParams.get("token") ?? "") : "";
        auth = tok ? verifyJwt(tok, config.jwtSecret, now()) : null;
        if (!auth) return send(401, { error: "unauthorized", message: "Sign in to the gateway" });
      }
      const body = await readBody(req);
      const out = await rt.h({ method: req.method!, path: url.pathname, query: url.searchParams, body, ip, origin, auth, raw: req });
      if (out.stream) return out.stream(res);
      if (out.redirect) {
        res.statusCode = 302;
        res.setHeader("Location", out.redirect);
        res.end();
        return;
      }
      for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
      send(out.status, out.body ?? {});
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.code, message: e.message });
      log(`error on ${req.method} ${url.pathname}: ${(e as Error).stack ?? e}`);
      send(500, { error: "internal", message: (e as Error).message });
    }
  }

  return {
    handle,
    async init(): Promise<void> {
      await loadReference();
      scheduleRefresh();
      audit.append("gateway.start", { version: VERSION, broker: adapter.info.id, sandbox: adapter.info.sandbox, liveTrading: config.liveTrading }, now());
    },
    stop(): void {
      if (refreshTimer) clearInterval(refreshTimer);
    },
    audit,
    now,
    get store() {
      return store;
    },
  };
}

export type Gateway = ReturnType<typeof createGateway>;
