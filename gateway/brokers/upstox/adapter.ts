// Upstox adapter. Endpoints verified against https://upstox.com/developer/api-documentation/
// (llms.txt index + page markdown, October 2026):
//
//   auth      GET  /v2/login/authorization/dialog         (browser redirect)
//             POST /v2/login/authorization/token           (code → access_token, valid till 03:30 IST next day)
//             POST /v3/login/auth/token/request/{client_id} (push an approval to the user's app; token arrives on the notifier webhook)
//             DELETE /v2/logout
//   data      GET  assets.upstox.com/market-quote/instruments/exchange/complete.json.gz (public BOD master)
//             GET  /v2/market/holidays                     (public)
//             GET  /v2/market-quote/quotes?instrument_key=… (full quote with depth)
//             GET  /v2/option/chain?instrument_key=…&expiry_date=YYYY-MM-DD
//             GET  /v3/feed/market-data-feed/authorize     (→ one-time wss:// URL, protobuf feed)
//   orders    POST api-hft /v3/order/place  (slice: true for freeze-quantity auto-slicing)
//             PUT  api-hft /v3/order/modify, DELETE api-hft /v3/order/cancel?order_id=
//             GET  /v2/order/details?order_id=, /v2/order/retrieve-all, /v2/order/trades/get-trades-for-day
//             DELETE /v2/order/multi/cancel?segment=, POST /v2/order/positions/exit?segment=
//             GTT: POST /v3/order/gtt/place, PUT /v3/order/gtt/modify, DELETE /v3/order/gtt/cancel, GET /v3/order/gtt
//   account   GET  /v2/portfolio/short-term-positions, /v2/portfolio/long-term-holdings
//             GET  /v3/user/get-funds-and-margin, POST /v2/charges/margin, GET /v2/charges/brokerage
//             GET  /v2/trade/profit-loss/data
//   sandbox   https://api-sandbox.upstox.com — only place/modify/cancel (v2 + v3) and multi-place
//             accept the sandbox token (per the docs' "Sandbox enabled" list and the official SDK).
//
// MARKET orders from the API are rejected by the exchange (UDAPI1158) and are never sent here.

import { gunzipSync } from "node:zlib";
import type { BrokerAdapter, BrokerInfo, BrokerSession, Result, Position, Holding, BrokerOrder, Trade, Funds, MarginLeg, MarginResult, BrokerCharges, GttRequest, GttOrder, PnlRow } from "../types.ts";
import { fromUpstoxRow, type Instrument, type InstrumentStore } from "../../../src/core/instruments.ts";
import { HolidayCalendar } from "../../../src/core/calendar.ts";
import { makeQuote, type Chain, type Quote } from "../../../src/core/chain.ts";
import type { OrderState, OrderStatus, PlaceRequest } from "../../../src/core/execution.ts";
import { istDate, istMs, addDays, istParts } from "../../../src/core/ist.ts";
import { decodeFeed } from "./feed.ts";

export interface UpstoxConfig {
  apiKey: string;
  apiSecret: string;
  redirectUri: string;
  baseUrl?: string; // https://api.upstox.com
  hftUrl?: string; // https://api-hft.upstox.com
  assetsUrl?: string; // https://assets.upstox.com
  loginUrl?: string; // https://api.upstox.com (dialog lives under /v2/login/…)
  sandbox?: { token: string; url?: string } | null;
  fetch?: typeof fetch;
  now?: () => number;
  algoName?: string | null; // X-Algo-Name header, only for exchange-approved algos (not needed under 10 OPS)
}

/** Upstox access tokens expire at 03:30 IST the following day (03:30 the same day if issued before it). */
export function upstoxExpiry(obtainedAt: number): number {
  const d = istDate(obtainedAt);
  const p = istParts(obtainedAt);
  return p.minutes < 3 * 60 + 30 ? istMs(d, 3, 30) : istMs(addDays(d, 1), 3, 30);
}

const STATE: Record<string, OrderState> = {
  complete: "complete",
  rejected: "rejected",
  cancelled: "cancelled",
  "cancelled after market order": "cancelled",
  open: "open",
  "trigger pending": "open",
  modified: "open",
  "not cancelled": "open",
  "not modified": "open",
};
export const orderState = (s: string | null | undefined): OrderState => STATE[String(s ?? "").toLowerCase()] ?? "pending";

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

interface UpstoxError {
  status?: string;
  errors?: { errorCode?: string; error_code?: string; message?: string }[];
}

export class UpstoxAdapter implements BrokerAdapter {
  readonly info: BrokerInfo;
  private token: string | null = null;
  private sess: BrokerSession | null = null;
  private readonly cfg: Required<Omit<UpstoxConfig, "sandbox" | "algoName">> & { sandbox: UpstoxConfig["sandbox"]; algoName: string | null };

  constructor(cfg: UpstoxConfig) {
    this.cfg = {
      baseUrl: "https://api.upstox.com",
      hftUrl: "https://api-hft.upstox.com",
      assetsUrl: "https://assets.upstox.com",
      loginUrl: "https://api.upstox.com",
      fetch: globalThis.fetch.bind(globalThis),
      now: Date.now,
      ...cfg,
      sandbox: cfg.sandbox ?? null,
      algoName: cfg.algoName ?? null,
    };
    this.info = { id: "upstox", name: "Upstox", status: "implemented", docs: "https://upstox.com/developer/api-documentation/", sandbox: Boolean(this.cfg.sandbox) };
  }

  // ── plumbing ───────────────────────────────────────────────────────
  private async call<T>(method: string, url: string, opts: { body?: unknown; form?: Record<string, string>; auth?: "user" | "order" | "none"; headers?: Record<string, string> } = {}): Promise<Result<T>> {
    const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
    const auth = opts.auth ?? "user";
    if (auth !== "none") {
      const tok = auth === "order" && this.cfg.sandbox ? this.cfg.sandbox.token : this.token;
      if (!tok) return { ok: false, error: "Not logged in to Upstox", code: "no-session", status: 401 };
      headers.Authorization = `Bearer ${tok}`;
    }
    let body: string | undefined;
    if (opts.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(opts.form).toString();
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    let r: Response;
    try {
      r = await this.cfg.fetch(url, { method, headers, body, signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      return { ok: false, error: `Upstox unreachable: ${(e as Error).message}`, code: "network" };
    }
    let j: unknown = null;
    try {
      j = await r.json();
    } catch {
      /* non-JSON */
    }
    const err = j as UpstoxError | null;
    if (!r.ok || err?.status === "error") {
      const e0 = err?.errors?.[0];
      const code = e0?.errorCode ?? e0?.error_code;
      if (r.status === 401 || code === "UDAPI100050") {
        // token invalid/expired (or invalidated by a static-IP change): drop it so the UI asks for a fresh login
        if (auth === "user") this.setSession(null, null);
      }
      return { ok: false, error: e0?.message ?? `HTTP ${r.status}`, code, status: r.status };
    }
    return { ok: true, value: j as T };
  }

  private get orderBase(): string {
    return this.cfg.sandbox ? (this.cfg.sandbox.url ?? "https://api-sandbox.upstox.com") : this.cfg.hftUrl;
  }

  // ── auth ───────────────────────────────────────────────────────────
  loginUrl(state: string): string {
    const q = new URLSearchParams({ response_type: "code", client_id: this.cfg.apiKey, redirect_uri: this.cfg.redirectUri, state });
    return `${this.cfg.loginUrl}/v2/login/authorization/dialog?${q}`;
  }

  async exchangeCode(code: string): Promise<Result<BrokerSession & { accessToken: string }>> {
    const r = await this.call<{ access_token?: string; user_id?: string; user_name?: string }>("POST", `${this.cfg.baseUrl}/v2/login/authorization/token`, {
      auth: "none",
      form: { code, client_id: this.cfg.apiKey, client_secret: this.cfg.apiSecret, redirect_uri: this.cfg.redirectUri, grant_type: "authorization_code" },
    });
    if (!r.ok) return r;
    if (!r.value.access_token) return { ok: false, error: "Upstox returned no access token" };
    const now = this.cfg.now();
    return { ok: true, value: { accessToken: r.value.access_token, userId: r.value.user_id ?? null, userName: r.value.user_name ?? null, obtainedAt: now, expiresAt: upstoxExpiry(now) } };
  }

  async requestApproval(): Promise<Result<{ expiresAt: number }>> {
    const r = await this.call<{ data?: { authorization_expiry?: string } }>("POST", `${this.cfg.baseUrl}/v3/login/auth/token/request/${encodeURIComponent(this.cfg.apiKey)}`, { auth: "none", body: { client_secret: this.cfg.apiSecret } });
    if (!r.ok) return r;
    return { ok: true, value: { expiresAt: Number(r.value.data?.authorization_expiry ?? 0) || upstoxExpiry(this.cfg.now()) } };
  }

  async verifyToken(token: string): Promise<Result<{ userId: string | null; userName: string | null }>> {
    const prev = this.token;
    this.token = token;
    const r = await this.call<{ data?: { user_id?: string; user_name?: string } }>("GET", `${this.cfg.baseUrl}/v2/user/profile`);
    this.token = prev;
    return r.ok ? { ok: true, value: { userId: r.value.data?.user_id ?? null, userName: r.value.data?.user_name ?? null } } : r;
  }

  setSession(token: string | null, session: BrokerSession | null): void {
    this.token = token;
    this.sess = session;
  }

  session(): BrokerSession | null {
    if (this.sess && this.sess.expiresAt <= this.cfg.now()) this.setSession(null, null);
    return this.sess;
  }

  async logout(): Promise<void> {
    if (this.token) await this.call("DELETE", `${this.cfg.baseUrl}/v2/logout`);
    this.setSession(null, null);
  }

  // ── public reference data ──────────────────────────────────────────
  async instruments(): Promise<Instrument[]> {
    const r = await this.cfg.fetch(`${this.cfg.assetsUrl}/market-quote/instruments/exchange/complete.json.gz`, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`instrument master HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const text = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
    const rows = JSON.parse(text) as Record<string, unknown>[];
    return rows.map(fromUpstoxRow).filter((x): x is Instrument => x !== null);
  }

  async holidays(): Promise<HolidayCalendar> {
    const r = await this.call<{ data: Parameters<typeof HolidayCalendar.fromUpstox>[0] }>("GET", `${this.cfg.baseUrl}/v2/market/holidays`, { auth: "none" });
    if (!r.ok) throw new Error(`holidays: ${r.error}`);
    return HolidayCalendar.fromUpstox(r.value.data);
  }

  // ── market data ────────────────────────────────────────────────────
  async quotes(keys: string[]): Promise<Result<Record<string, Quote>>> {
    const out: Record<string, Quote> = {};
    for (let i = 0; i < keys.length; i += 450) {
      const chunk = keys.slice(i, i + 450);
      const r = await this.call<{ data: Record<string, { instrument_token: string; last_price?: number; net_change?: number; depth?: { buy?: { price: number; quantity: number }[]; sell?: { price: number; quantity: number }[] }; oi?: number }> }>(
        "GET",
        `${this.cfg.baseUrl}/v2/market-quote/quotes?instrument_key=${encodeURIComponent(chunk.join(","))}`,
      );
      if (!r.ok) return r;
      const now = this.cfg.now();
      for (const v of Object.values(r.value.data ?? {})) {
        const b = v.depth?.buy?.[0], s = v.depth?.sell?.[0];
        out[v.instrument_token] = makeQuote({ ltp: v.last_price, bid: b?.price, ask: s?.price, bidQty: b?.quantity, askQty: s?.quantity, oi: v.oi, change: v.net_change }, now);
      }
    }
    return { ok: true, value: out };
  }

  /** Today's 30-minute closes, oldest first (GET /v2/historical-candle/intraday/{key}/30minute). */
  async intraday(key: string): Promise<Result<number[]>> {
    const r = await this.call<{ data?: { candles?: unknown[][] } }>("GET", `${this.cfg.baseUrl}/v2/historical-candle/intraday/${encodeURIComponent(key)}/30minute`);
    if (!r.ok) return r;
    const closes = (r.value.data?.candles ?? []).map((c) => Number(c[4])).filter((x) => Number.isFinite(x) && x > 0);
    return { ok: true, value: closes.reverse() };
  }

  async optionChain(store: InstrumentStore, underlying: string, expiryDate: string): Promise<Result<Chain>> {
    const spotKey = store.spotKey(underlying);
    if (!spotKey) return { ok: false, error: `No spot instrument for ${underlying}` };
    type Side = { instrument_key: string; market_data?: Record<string, number>; option_greeks?: { iv?: number } };
    const r = await this.call<{ data: { strike_price: number; underlying_spot_price: number; call_options?: Side; put_options?: Side }[] }>(
      "GET",
      `${this.cfg.baseUrl}/v2/option/chain?instrument_key=${encodeURIComponent(spotKey)}&expiry_date=${expiryDate}`,
    );
    if (!r.ok) return r;
    const now = this.cfg.now();
    const rows: Chain["rows"] = [];
    let spot = 0;
    const side = (s: Side | undefined) => {
      if (!s) return null;
      const inst = store.get(s.instrument_key);
      if (!inst) return null;
      const m = s.market_data ?? {};
      return { inst, q: makeQuote({ ltp: m.ltp, bid: m.bid_price, ask: m.ask_price, bidQty: m.bid_qty, askQty: m.ask_qty, ivPct: s.option_greeks?.iv, oi: m.oi }, now) };
    };
    for (const d of r.value.data ?? []) {
      spot = d.underlying_spot_price || spot;
      const call = side(d.call_options), put = side(d.put_options);
      if (call || put) rows.push({ strike: d.strike_price, call, put });
    }
    rows.sort((a, b) => a.strike - b.strike);
    if (!rows.length || !(spot > 0)) return { ok: false, error: "Upstox returned an empty option chain" };
    return { ok: true, value: { underlying, expiryDate, expiryMs: istMs(expiryDate, 15, 30), spot, rows, fetchedAt: now, source: this.cfg.sandbox ? "Upstox option chain" : "Upstox option chain" } };
  }

  async stream(keys: string[], onQuote: (key: string, q: Partial<Quote>) => void, onClose: (why: string) => void): Promise<(() => void) | null> {
    if (!this.token || typeof WebSocket === "undefined") return null;
    const a = await this.call<{ data?: { authorized_redirect_uri?: string } }>("GET", `${this.cfg.baseUrl}/v3/feed/market-data-feed/authorize`);
    const url = a.ok ? a.value.data?.authorized_redirect_uri : undefined;
    if (!url) return null;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => ws.send(new TextEncoder().encode(JSON.stringify({ guid: `pei-${this.cfg.now()}`, method: "sub", data: { mode: "full", instrumentKeys: keys } })));
    ws.onmessage = (ev) => {
      try {
        for (const [k, q] of Object.entries(decodeFeed(new Uint8Array(ev.data as ArrayBuffer), this.cfg.now()))) onQuote(k, q);
      } catch (e) {
        onClose(`feed decode error: ${(e as Error).message}`);
      }
    };
    ws.onclose = () => onClose("closed");
    ws.onerror = () => onClose("error");
    return () => ws.close();
  }

  // ── orders ─────────────────────────────────────────────────────────
  async place(o: PlaceRequest): Promise<{ ok: true; orderIds: string[] } | { ok: false; error: string }> {
    const headers: Record<string, string> = {};
    if (this.cfg.algoName) headers["X-Algo-Name"] = this.cfg.algoName;
    const r = await this.call<{ data?: { order_ids?: string[] } }>("POST", `${this.orderBase}/v3/order/place`, {
      auth: "order",
      headers,
      body: {
        quantity: o.qty,
        product: o.product,
        validity: o.validity,
        price: o.limit,
        tag: o.tag.slice(0, 40),
        instrument_token: o.instrumentKey,
        order_type: "LIMIT",
        transaction_type: o.side,
        disclosed_quantity: 0,
        trigger_price: 0,
        is_amo: false,
        slice: true,
      },
    });
    if (!r.ok) return { ok: false, error: `${r.code ? r.code + ": " : ""}${r.error}` };
    const ids = r.value.data?.order_ids ?? [];
    return ids.length ? { ok: true, orderIds: ids } : { ok: false, error: "Upstox accepted the request but returned no order id" };
  }

  async modify(orderId: string, p: { qty?: number; price: number; validity: "DAY" | "IOC" }): Promise<Result<string>> {
    const r = await this.call<{ data?: { order_id?: string } }>("PUT", `${this.orderBase}/v3/order/modify`, {
      auth: "order",
      body: { order_id: orderId, quantity: p.qty, validity: p.validity, price: p.price, order_type: "LIMIT", trigger_price: 0, disclosed_quantity: 0 },
    });
    return r.ok ? { ok: true, value: r.value.data?.order_id ?? orderId } : r;
  }

  async cancel(orderId: string): Promise<void> {
    await this.call("DELETE", `${this.orderBase}/v3/order/cancel?order_id=${encodeURIComponent(orderId)}`, { auth: "order" });
  }

  async status(orderId: string): Promise<OrderStatus> {
    if (this.cfg.sandbox) return { state: "pending", filled: 0, avgPrice: null, message: "Upstox sandbox has no order-status API" };
    const r = await this.call<{ data?: { status?: string; filled_quantity?: number; average_price?: number; status_message?: string | null } }>("GET", `${this.cfg.baseUrl}/v2/order/details?order_id=${encodeURIComponent(orderId)}`);
    if (!r.ok) return { state: "pending", filled: 0, avgPrice: null, message: r.error };
    const d = r.value.data ?? {};
    const filled = num(d.filled_quantity) ?? 0;
    return { state: orderState(d.status), filled, avgPrice: filled > 0 ? num(d.average_price) : null, message: d.status_message ?? undefined };
  }

  async cancelAll(segment?: string): Promise<Result<string[]>> {
    const q = segment ? `?segment=${encodeURIComponent(segment)}` : "";
    const r = await this.call<{ data?: { order_ids?: string[] } }>("DELETE", `${this.cfg.baseUrl}/v2/order/multi/cancel${q}`);
    return r.ok ? { ok: true, value: r.value.data?.order_ids ?? [] } : r;
  }

  async exitAll(segment?: string): Promise<Result<string[]>> {
    const q = segment ? `?segment=${encodeURIComponent(segment)}` : "";
    const r = await this.call<{ data?: { order_ids?: string[] } }>("POST", `${this.cfg.baseUrl}/v2/order/positions/exit${q}`, { body: {} });
    return r.ok ? { ok: true, value: r.value.data?.order_ids ?? [] } : r;
  }

  // ── GTT ────────────────────────────────────────────────────────────
  private gttBody(g: GttRequest): Record<string, unknown> {
    return {
      type: g.rules.length > 1 ? "MULTIPLE" : "SINGLE",
      quantity: g.qty,
      product: g.product,
      instrument_token: g.key,
      transaction_type: g.side,
      rules: g.rules.map((r) => ({ strategy: r.strategy, trigger_type: r.triggerType, trigger_price: r.triggerPrice })),
    };
  }
  async placeGtt(g: GttRequest): Promise<Result<string[]>> {
    const r = await this.call<{ data?: { gtt_order_ids?: string[] } }>("POST", `${this.cfg.baseUrl}/v3/order/gtt/place`, { body: this.gttBody(g) });
    return r.ok ? { ok: true, value: r.value.data?.gtt_order_ids ?? [] } : r;
  }
  async modifyGtt(id: string, g: GttRequest): Promise<Result<string>> {
    const b = this.gttBody(g);
    const r = await this.call("PUT", `${this.cfg.baseUrl}/v3/order/gtt/modify`, { body: { type: b.type, quantity: b.quantity, rules: b.rules, gtt_order_id: id } });
    return r.ok ? { ok: true, value: id } : r;
  }
  async cancelGtt(id: string): Promise<Result<string>> {
    const r = await this.call("DELETE", `${this.cfg.baseUrl}/v3/order/gtt/cancel`, { body: { gtt_order_id: id } });
    return r.ok ? { ok: true, value: id } : r;
  }
  async listGtt(): Promise<Result<GttOrder[]>> {
    type R = { gtt_order_id: string; instrument_token: string; trading_symbol?: string; quantity: number; rules: { strategy: GttRequest["rules"][number]["strategy"]; trigger_type: GttRequest["rules"][number]["triggerType"]; trigger_price: number; status?: string; transaction_type?: "BUY" | "SELL" }[] };
    const r = await this.call<{ data?: R[] }>("GET", `${this.cfg.baseUrl}/v3/order/gtt`);
    if (!r.ok) return r;
    return {
      ok: true,
      value: (r.value.data ?? []).map((g) => ({
        id: g.gtt_order_id,
        key: g.instrument_token,
        symbol: g.trading_symbol ?? null,
        side: g.rules[0]?.transaction_type ?? "BUY",
        qty: g.quantity,
        status: g.rules.map((x) => `${x.strategy}:${x.status ?? "?"}`).join(" "),
        rules: g.rules.map((x) => ({ strategy: x.strategy, triggerType: x.trigger_type, triggerPrice: x.trigger_price })),
      })),
    };
  }

  // ── account ────────────────────────────────────────────────────────
  async positions(): Promise<Result<Position[]>> {
    type R = { instrument_token: string; trading_symbol?: string; tradingsymbol?: string; exchange: string; product: string; quantity: number; average_price: number | null; last_price: number | null; pnl: number | null; realised: number | null; unrealised: number | null };
    const r = await this.call<{ data?: R[] }>("GET", `${this.cfg.baseUrl}/v2/portfolio/short-term-positions`);
    if (!r.ok) return r;
    return { ok: true, value: (r.value.data ?? []).map((p) => ({ key: p.instrument_token, symbol: p.trading_symbol ?? p.tradingsymbol ?? p.instrument_token, exchange: p.exchange, product: p.product, qty: p.quantity, avgPrice: num(p.average_price), ltp: num(p.last_price), pnl: num(p.pnl), realised: num(p.realised), unrealised: num(p.unrealised) })) };
  }

  async holdings(): Promise<Result<Holding[]>> {
    type R = { instrument_token: string; trading_symbol?: string; tradingsymbol?: string; isin?: string; quantity: number; average_price: number | null; last_price: number | null; pnl: number | null; day_change_percentage: number | null };
    const r = await this.call<{ data?: R[] }>("GET", `${this.cfg.baseUrl}/v2/portfolio/long-term-holdings`);
    if (!r.ok) return r;
    return { ok: true, value: (r.value.data ?? []).map((h) => ({ key: h.instrument_token, symbol: h.trading_symbol ?? h.tradingsymbol ?? h.instrument_token, isin: h.isin ?? null, qty: h.quantity, avgPrice: num(h.average_price), ltp: num(h.last_price), pnl: num(h.pnl), dayChangePct: num(h.day_change_percentage) })) };
  }

  async orders(): Promise<Result<BrokerOrder[]>> {
    type R = { order_id: string; instrument_token: string; trading_symbol?: string; tradingsymbol?: string; transaction_type: "BUY" | "SELL"; quantity: number; filled_quantity: number; pending_quantity: number; price: number; average_price: number | null; order_type: string; validity: string; product: string; status: string; status_message: string | null; order_timestamp: string | null; tag: string | null };
    const r = await this.call<{ data?: R[] }>("GET", `${this.cfg.baseUrl}/v2/order/retrieve-all`);
    if (!r.ok) return r;
    return {
      ok: true,
      value: (r.value.data ?? []).map((o) => ({ orderId: o.order_id, key: o.instrument_token, symbol: o.trading_symbol ?? o.tradingsymbol ?? o.instrument_token, side: o.transaction_type, qty: o.quantity, filled: o.filled_quantity, pending: o.pending_quantity, price: o.price, avgPrice: num(o.average_price), orderType: o.order_type, validity: o.validity, product: o.product, status: o.status, state: orderState(o.status), message: o.status_message, ts: o.order_timestamp, tag: o.tag })),
    };
  }

  async trades(): Promise<Result<Trade[]>> {
    type R = { trade_id: string; order_id: string; instrument_token: string; trading_symbol?: string; tradingsymbol?: string; transaction_type: "BUY" | "SELL"; quantity: number; average_price: number; exchange_timestamp: string | null };
    const r = await this.call<{ data?: R[] }>("GET", `${this.cfg.baseUrl}/v2/order/trades/get-trades-for-day`);
    if (!r.ok) return r;
    return { ok: true, value: (r.value.data ?? []).map((t) => ({ tradeId: t.trade_id, orderId: t.order_id, key: t.instrument_token, symbol: t.trading_symbol ?? t.tradingsymbol ?? t.instrument_token, side: t.transaction_type, qty: t.quantity, price: t.average_price, ts: t.exchange_timestamp })) };
  }

  async funds(): Promise<Result<Funds>> {
    const r = await this.call<{ data?: { available_to_trade?: { total?: number; cash_available_to_trade?: { margin_used?: { total?: number } } } } }>("GET", `${this.cfg.baseUrl}/v3/user/get-funds-and-margin`, { headers: { "Api-Version": "3.0" } });
    if (!r.ok) return r;
    const a = r.value.data?.available_to_trade;
    return { ok: true, value: { available: num(a?.total), used: num(a?.cash_available_to_trade?.margin_used?.total), source: "Upstox funds & margin v3" } };
  }

  async margin(legs: MarginLeg[]): Promise<Result<MarginResult>> {
    const r = await this.call<{ data?: { required_margin?: number; final_margin?: number; margins?: { total_margin?: number }[] } }>("POST", `${this.cfg.baseUrl}/v2/charges/margin`, {
      body: { instruments: legs.slice(0, 20).map((l) => ({ instrument_key: l.key, quantity: l.qty, transaction_type: l.side, product: l.product, ...(l.price ? { price: l.price } : {}) })) },
    });
    if (!r.ok) return r;
    const d = r.value.data ?? {};
    if (num(d.final_margin) === null) return { ok: false, error: "Upstox margin API returned no margin" };
    return { ok: true, value: { required: num(d.required_margin) ?? d.final_margin!, final: d.final_margin!, perLeg: (d.margins ?? []).map((m) => num(m.total_margin) ?? 0) } };
  }

  async brokerage(l: MarginLeg & { price: number }): Promise<Result<BrokerCharges>> {
    const q = new URLSearchParams({ instrument_token: l.key, quantity: String(l.qty), product: l.product, transaction_type: l.side, price: String(l.price) });
    type C = { total: number; brokerage: number; taxes?: { gst?: number; stt?: number; stamp_duty?: number }; other_charges?: { transaction?: number; clearing?: number; ipft?: number; sebi_turnover?: number }; dp_plan?: { min_expense?: number } };
    const r = await this.call<{ data?: { charges?: C } }>("GET", `${this.cfg.baseUrl}/v2/charges/brokerage?${q}`);
    if (!r.ok) return r;
    const c = r.value.data?.charges;
    if (!c) return { ok: false, error: "Upstox brokerage API returned no charges" };
    return {
      ok: true,
      value: { total: c.total, brokerage: c.brokerage, stt: c.taxes?.stt ?? 0, exchangeTxn: (c.other_charges?.transaction ?? 0) + (c.other_charges?.clearing ?? 0), stampDuty: c.taxes?.stamp_duty ?? 0, gst: c.taxes?.gst ?? 0, sebiFee: c.other_charges?.sebi_turnover ?? 0, ipft: c.other_charges?.ipft ?? 0, dpMin: num(c.dp_plan?.min_expense) },
    };
  }

  async pnlReport(segment: "EQ" | "FO", financialYear: string): Promise<Result<PnlRow[]>> {
    type R = { scrip_name: string; quantity: number; buy_date: string | null; buy_average: number; sell_date: string | null; sell_average: number; buy_amount: number; sell_amount: number };
    const r = await this.call<{ data?: R[] }>("GET", `${this.cfg.baseUrl}/v2/trade/profit-loss/data?segment=${segment}&financial_year=${financialYear}&page_number=1&page_size=500`);
    if (!r.ok) return r;
    return { ok: true, value: (r.value.data ?? []).map((x) => ({ symbol: x.scrip_name, qty: x.quantity, buyDate: x.buy_date, buyAvg: x.buy_average, sellDate: x.sell_date, sellAvg: x.sell_average, pnl: Math.round((x.sell_amount - x.buy_amount) * 100) / 100 })) };
  }
}
