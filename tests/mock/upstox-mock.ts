// A mock Upstox API for gateway integration tests and Playwright E2E. TEST-ONLY.
// Reference data and option-chain quotes are the RECORDED public fixtures
// (Upstox BOD master + holidays, NSE option chain); the order book, fills,
// positions and holdings are simulated here and exist only in tests.
//
//   node --experimental-strip-types tests/mock/upstox-mock.ts 8788

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { quotesFromMcx } from "../../src/core/recorded-mcx.ts";
import { fixture, upstoxRows, mcxChains, FIXTURE_NOW, store, upstoxOptionChain, coreChain, NSE_CHAIN_FILES, nseExpiryToIso, type NseChain } from "./fixtures.ts";
import type { Quote } from "../../src/core/chain.ts";
import { charges } from "../../src/core/charges.ts";
import { chargeSegment } from "../../src/core/paper.ts";

export const MOCK = { apiKey: "mock-api-key", apiSecret: "mock-api-secret", code: "mock-auth-code", token: "mock-access-token", userId: "MOCK01" };

interface MockOrder {
  order_id: string;
  instrument_token: string;
  trading_symbol: string;
  transaction_type: "BUY" | "SELL";
  quantity: number;
  filled_quantity: number;
  pending_quantity: number;
  price: number;
  average_price: number;
  order_type: string;
  validity: string;
  product: string;
  status: string;
  status_message: string | null;
  order_timestamp: string;
  tag: string | null;
}

export interface Scenario {
  rejectSides?: ("BUY" | "SELL")[]; // reject the next order on this side (consumed)
  fillNone?: string[]; // instrument keys that never fill (IOC cancels)
  requireIp?: string | null; // simulate static-IP enforcement on order APIs
}

export function startUpstoxMock(port: number, host = "127.0.0.1") {
  const s = store();
  const quotes = new Map<string, Quote>();
  // option quotes from the recorded chains
  for (const [u, files] of Object.entries(NSE_CHAIN_FILES)) {
    for (const f of files) {
      const c = coreChain(u, nseExpiryToIso(fixture<NseChain>(f).expiry));
      if (!c) continue;
      for (const r of c.rows) for (const sd of [r.call, r.put]) if (sd?.q) quotes.set(sd.inst.key, sd.q);
      const spot = s.spotKey(u);
      if (spot) quotes.set(spot, { ltp: c.spot, bid: null, ask: null, bidQty: 0, askQty: 0, iv: null, oi: null, ts: 0 });
      if (u === "RELIANCE") {
        const eq = s.equity("RELIANCE")!;
        quotes.set(eq.key, { ltp: c.spot, bid: Math.round((c.spot - 0.1) * 10) / 10, ask: c.spot, bidQty: 500, askQty: 800, iv: null, oi: null, ts: 0 });
      }
    }
  }
  // MCX: the recorded public MCX option chains (bid/ask/LTP per strike + the futures price the options
  // are written on), keyed by the recorded Upstox master rows of the same contracts
  for (const [k, rec] of Object.entries(mcxChains())) {
    const [u, date] = k.split(":") as [string, string];
    for (const [key, q] of quotesFromMcx(u, date, rec, s, FIXTURE_NOW, 0)) quotes.set(key, q);
  }
  const gz = gzipSync(Buffer.from(JSON.stringify(upstoxRows())));
  let orders: MockOrder[] = [];
  let gtts: { gtt_order_id: string; instrument_token: string; quantity: number; rules: unknown[] }[] = [];
  let seq = 1000;
  let scenario: Scenario = {};
  const requests: { method: string; path: string; ts: number; body: unknown }[] = [];
  let tokenValid = true;
  const holdings = [{ instrument_token: s.equity("RELIANCE")!.key, trading_symbol: "RELIANCE", isin: "INE002A01018", quantity: 10, average_price: 1100, last_price: quotes.get(s.equity("RELIANCE")!.key)?.ltp ?? null, pnl: null as number | null, day_change_percentage: 0 }];

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };
  const err = (res: ServerResponse, status: number, code: string, message: string) => json(res, status, { status: "error", errors: [{ errorCode: code, error_code: code, message }] });

  function positions() {
    const m = new Map<string, { qty: number; buyQ: number; buyV: number; sellQ: number; sellV: number; sym: string; product: string }>();
    for (const o of orders.filter((x) => x.filled_quantity > 0)) {
      const p = m.get(o.instrument_token) ?? { qty: 0, buyQ: 0, buyV: 0, sellQ: 0, sellV: 0, sym: o.trading_symbol, product: o.product };
      const f = o.filled_quantity, v = o.filled_quantity * o.average_price;
      if (o.transaction_type === "BUY") {
        p.qty += f;
        p.buyQ += f;
        p.buyV += v;
      } else {
        p.qty -= f;
        p.sellQ += f;
        p.sellV += v;
      }
      m.set(o.instrument_token, p);
    }
    return [...m.entries()].map(([k, p]) => {
      const ltp = quotes.get(k)?.ltp ?? null;
      const pnl = ltp === null ? null : Math.round((p.sellV - p.buyV + p.qty * ltp) * 100) / 100;
      return { exchange: "NFO", product: p.product, instrument_token: k, trading_symbol: p.sym, quantity: p.qty, average_price: p.qty ? (p.qty > 0 ? p.buyV / p.buyQ : p.sellV / p.sellQ) : null, last_price: ltp, pnl, realised: null, unrealised: null };
    });
  }

  function fill(o: MockOrder): void {
    const q = quotes.get(o.instrument_token);
    const inst = s.get(o.instrument_token);
    if (scenario.fillNone?.includes(o.instrument_token) || !q || !inst) {
      o.status = o.validity === "IOC" ? "cancelled" : "open";
      return;
    }
    const touch = o.transaction_type === "BUY" ? q.ask : q.bid;
    const depth = o.transaction_type === "BUY" ? q.askQty : q.bidQty;
    const crosses = touch !== null && (o.transaction_type === "BUY" ? o.price >= touch : o.price <= touch);
    if (!crosses) {
      o.status = o.validity === "IOC" ? "cancelled" : "open";
      return;
    }
    // simulated depth: the touch plus the same size again one tick through it
    const can = Math.floor(Math.min(o.quantity, Math.max(depth, inst.lotSize) * 2) / inst.lotSize) * inst.lotSize;
    o.filled_quantity = can;
    o.pending_quantity = o.quantity - can;
    o.average_price = touch!;
    o.status = can === o.quantity ? "complete" : o.validity === "IOC" ? "cancelled" : "open";
  }

  async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const t = Buffer.concat(chunks).toString("utf8");
    if (!t) return {};
    if (String(req.headers["content-type"]).includes("x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(t));
    return JSON.parse(t);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    const p = url.pathname;
    const b = await body(req);
    requests.push({ method: req.method!, path: p, ts: Date.now(), body: b });
    const authed = () => req.headers.authorization === `Bearer ${MOCK.token}` && tokenValid;

    // ── mock control (tests only) ──
    if (p === "/__mock/scenario") return (scenario = b as Scenario), json(res, 200, { ok: true });
    if (p === "/__mock/reset") return (orders = [], gtts = [], scenario = {}, (requests.length = 0), (tokenValid = true), json(res, 200, { ok: true }));
    if (p === "/__mock/state") return json(res, 200, { orders, requests, positions: positions() });
    if (p === "/__mock/expire-token") return (tokenValid = false), json(res, 200, { ok: true });

    // ── public ──
    if (p === "/market-quote/instruments/exchange/complete.json.gz") {
      res.setHeader("Content-Type", "application/gzip");
      return res.end(gz);
    }
    if (p === "/v2/market/holidays") return json(res, 200, fixture<{ body: unknown }>("upstox-holidays.json").body);
    if (p === "/v2/login/authorization/dialog") {
      // the real page asks the user to log in at Upstox; the mock approves immediately
      const ru = url.searchParams.get("redirect_uri")!;
      if (url.searchParams.get("client_id") !== MOCK.apiKey) return err(res, 400, "UDAPI100068", "Check your 'client_id' and 'redirect_uri'");
      res.statusCode = 302;
      res.setHeader("Location", `${ru}?code=${MOCK.code}&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}`);
      return res.end();
    }
    if (p === "/v2/login/authorization/token" && req.method === "POST") {
      if (b.client_id !== MOCK.apiKey || b.client_secret !== MOCK.apiSecret) return err(res, 401, "UDAPI100069", "Check your 'client_id' and 'client_secret'");
      if (b.code !== MOCK.code || b.grant_type !== "authorization_code") return err(res, 400, "UDAPI100057", "Invalid Auth code");
      tokenValid = true;
      return json(res, 200, { email: "mock@example.com", user_id: MOCK.userId, user_name: "Mock User", access_token: MOCK.token, exchanges: ["NSE", "NFO", "BSE", "BFO"], products: ["D", "I"], order_types: ["LIMIT"], is_active: true });
    }
    if (p.startsWith("/v3/login/auth/token/request/") && req.method === "POST") {
      if (b.client_secret !== MOCK.apiSecret) return err(res, 401, "UDAPI100069", "bad secret");
      return json(res, 200, { status: "success", data: { authorization_expiry: String(Date.now() + 3600_000), notifier_url: "https://example.invalid/webhook" } });
    }
    if (p === "/v3/feed/market-data-feed/authorize") return err(res, 404, "UDAPI10000", "mock: no websocket feed");

    // ── authenticated ──
    if (!authed()) return err(res, 401, "UDAPI100050", "Invalid token used to access API");
    if (scenario.requireIp && /order\/(place|modify|cancel)/.test(p)) return err(res, 403, "UDAPI1154", "Access to this API is blocked due to static IP restrictions.");

    if (p === "/v2/user/profile") return json(res, 200, { status: "success", data: { user_id: MOCK.userId, user_name: "Mock User" } });
    if (p === "/v2/logout") return json(res, 200, { status: "success", data: true });
    if (p === "/v2/option/chain") {
      const key = url.searchParams.get("instrument_key")!;
      const u = s.optionUnderlyings().find((x) => s.spotKey(x) === key);
      const c = u ? upstoxOptionChain(u, url.searchParams.get("expiry_date")!, s) : null;
      return c ? json(res, 200, c) : json(res, 200, { status: "success", data: [] });
    }
    if (p === "/v2/market-quote/quotes") {
      const keys = (url.searchParams.get("instrument_key") ?? "").split(",");
      const data: Record<string, unknown> = {};
      for (const k of keys) {
        const q = quotes.get(k);
        const i = s.get(k);
        if (!q) continue;
        const per = i?.qtyInLots ? i.lotSize : 1; // like Upstox, commodity/currency depth is in lots
        data[`${i?.segment ?? "X"}:${i?.symbol ?? k}`] = { instrument_token: k, last_price: q.ltp, oi: q.oi, depth: { buy: [{ price: q.bid ?? 0, quantity: q.bidQty / per, orders: 1 }], sell: [{ price: q.ask ?? 0, quantity: q.askQty / per, orders: 1 }] } };
      }
      return json(res, 200, { status: "success", data });
    }
    if (p === "/v3/order/place" && req.method === "POST") {
      const side = b.transaction_type as "BUY" | "SELL";
      if (b.order_type !== "LIMIT") return err(res, 400, "UDAPI1158", "Market orders are not allowed. Try placing a limit order.");
      const ri = scenario.rejectSides?.indexOf(side) ?? -1;
      if (ri >= 0) {
        scenario.rejectSides!.splice(ri, 1);
        return err(res, 400, "UDAPI100500", "RMS: margin shortfall (mock)");
      }
      const inst = s.get(String(b.instrument_token));
      if (!inst) return err(res, 400, "UDAPI100011", "Invalid Instrument key");
      const max = inst.freezeQty ? Math.floor(inst.freezeQty / inst.lotSize) * inst.lotSize : Infinity;
      const qty = Number(b.quantity);
      const parts: number[] = [];
      for (let left = qty; left > 0; left -= Math.min(left, max)) parts.push(Math.min(left, max));
      if (!b.slice && parts.length > 1) return err(res, 400, "UDAPI100500", "Quantity above freeze limit");
      const ids: string[] = [];
      for (const part of parts) {
        const o: MockOrder = { order_id: String(++seq), instrument_token: inst.key, trading_symbol: inst.symbol, transaction_type: side, quantity: part, filled_quantity: 0, pending_quantity: part, price: Number(b.price), average_price: 0, order_type: "LIMIT", validity: String(b.validity), product: String(b.product), status: "open", status_message: null, order_timestamp: new Date().toISOString(), tag: (b.tag as string) ?? null };
        fill(o);
        orders.push(o);
        ids.push(o.order_id);
      }
      return json(res, 200, { status: "success", data: { order_ids: ids }, metadata: { latency: 5 } });
    }
    if (p === "/v2/order/details") {
      const o = orders.find((x) => x.order_id === url.searchParams.get("order_id"));
      return o ? json(res, 200, { status: "success", data: o }) : err(res, 400, "UDAPI100010", "Order not found");
    }
    if (p === "/v3/order/cancel" && req.method === "DELETE") {
      const o = orders.find((x) => x.order_id === url.searchParams.get("order_id"));
      if (o && o.status === "open") o.status = "cancelled";
      return json(res, 200, { status: "success", data: { order_id: o?.order_id ?? null } });
    }
    if (p === "/v3/order/modify" && req.method === "PUT") {
      const o = orders.find((x) => x.order_id === b.order_id);
      if (!o || o.status !== "open") return err(res, 400, "UDAPI100010", "Order not open");
      o.price = Number(b.price);
      fill(o);
      return json(res, 200, { status: "success", data: { order_id: o.order_id } });
    }
    if (p === "/v2/order/retrieve-all") return json(res, 200, { status: "success", data: orders });
    if (p === "/v2/order/trades/get-trades-for-day") return json(res, 200, { status: "success", data: orders.filter((o) => o.filled_quantity > 0).map((o, i) => ({ trade_id: `T${i}`, order_id: o.order_id, instrument_token: o.instrument_token, trading_symbol: o.trading_symbol, transaction_type: o.transaction_type, quantity: o.filled_quantity, average_price: o.average_price, exchange_timestamp: o.order_timestamp })) });
    if (p === "/v2/order/multi/cancel" && req.method === "DELETE") {
      const ids = orders.filter((o) => o.status === "open").map((o) => ((o.status = "cancelled"), o.order_id));
      return json(res, 200, { status: "success", data: { order_ids: ids }, summary: { total: ids.length, success: ids.length, error: 0 } });
    }
    if (p === "/v2/portfolio/short-term-positions") return json(res, 200, { status: "success", data: positions() });
    if (p === "/v2/portfolio/long-term-holdings") return json(res, 200, { status: "success", data: holdings });
    if (p === "/v3/user/get-funds-and-margin") return json(res, 200, { status: "success", data: { available_to_trade: { total: 250000, cash_available_to_trade: { margin_used: { total: 0 } } } } });
    if (p === "/v2/charges/margin" && req.method === "POST") {
      // simulated: premium for bought legs, 12% of notional for sold legs, half off when hedged
      const ins = (b.instruments as { instrument_key: string; quantity: number; transaction_type: string; price?: number }[]) ?? [];
      const per = ins.map((l) => {
        const i = s.get(l.instrument_key);
        const q = quotes.get(l.instrument_key);
        if (l.transaction_type === "BUY") return Math.round(l.quantity * (l.price ?? q?.ask ?? 0) * 100) / 100;
        return Math.round(l.quantity * (i?.strike ?? 0) * 0.12 * 100) / 100;
      });
      const req = per.reduce((a, x) => a + x, 0);
      const hedged = ins.some((l) => l.transaction_type === "BUY") && ins.some((l) => l.transaction_type === "SELL");
      return json(res, 200, { status: "success", data: { margins: per.map((x) => ({ total_margin: x })), required_margin: req, final_margin: hedged ? Math.round(req * 0.5 * 100) / 100 : req } });
    }
    if (p === "/v2/charges/brokerage") {
      const i = s.get(url.searchParams.get("instrument_token")!);
      if (!i) return err(res, 400, "UDAPI1059", "bad instrument");
      const c = charges({ segment: chargeSegment(i, url.searchParams.get("product") === "I" ? "I" : "D"), exchange: i.exchange, side: url.searchParams.get("transaction_type") as "BUY" | "SELL", qty: Number(url.searchParams.get("quantity")), price: Number(url.searchParams.get("price")), date: "2026-10-08" });
      return json(res, 200, { status: "success", data: { charges: { total: c.total, brokerage: c.brokerage, taxes: { gst: c.gst, stt: c.stt, stamp_duty: c.stampDuty }, other_charges: { transaction: c.exchangeTxn, clearing: 0, ipft: 0, sebi_turnover: c.sebiFee }, dp_plan: { name: "MOCK", min_expense: 20 } } } });
    }
    if (p === "/v3/order/gtt/place" && req.method === "POST") {
      const id = `GTT-MOCK${++seq}`;
      gtts.push({ gtt_order_id: id, instrument_token: String(b.instrument_token), quantity: Number(b.quantity), rules: (b.rules as unknown[]).map((r) => ({ ...(r as object), status: "SCHEDULED", transaction_type: b.transaction_type })) });
      return json(res, 200, { status: "success", data: { gtt_order_ids: [id] } });
    }
    if (p === "/v3/order/gtt" && req.method === "GET") return json(res, 200, { status: "success", data: gtts });
    if (p === "/v3/order/gtt/cancel" && req.method === "DELETE") {
      gtts = gtts.filter((g) => g.gtt_order_id !== b.gtt_order_id);
      return json(res, 200, { status: "success", data: { gtt_order_ids: [b.gtt_order_id] } });
    }
    if (p === "/v2/trade/profit-loss/data") return json(res, 200, { status: "success", data: [] });
    return err(res, 404, "UDAPI10000", `mock: ${req.method} ${p} not implemented`);
  });
  const ready = new Promise<string>((resolve) =>
    server.listen(port, host, () => {
      const a = server.address();
      resolve(`http://${host}:${typeof a === "object" && a ? a.port : port}`);
    }),
  );
  return { server, ready, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 8788);
  startUpstoxMock(port);
  console.log(`mock Upstox on http://127.0.0.1:${port}`);
}
