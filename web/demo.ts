// DEMO MODE: the whole UI runs in the browser against the recorded public fixtures
// (NSE option chains and the Upstox instrument master, recorded Thu 8 Oct 2026 ~10:39 IST;
// MCX option chains from mcxindia.com and the Upstox MCX/currency master, 16:13–16:14 IST the same day).
// NSE currency option prices could not be recorded (the public chain was empty), so currency
// pairs list their real contracts with "No recorded currency prices in the demo".
// There is no broker and no gateway: every trade is a PAPER trade on recorded prices,
// and the UI labels this everywhere. Live mode is refused here as well as in the UI.
//
// It answers the same paths as the gateway, using the same core modules (instrument
// store, paper broker, leg execution with unwind, risk checks, charges), so the demo
// exercises the real logic. Data is loaded lazily, only when the demo starts.

import { InstrumentStore, INDICES, derivDef, venueOf, type Instrument, type Venue } from "../src/core/instruments.ts";
import { HolidayCalendar, marketSession, venueSession, optionExpiryMs } from "../src/core/calendar.ts";
import { underlyingList } from "../src/core/catalog.ts";
import { quotesFromMcx, type McxChainRecord } from "../src/core/recorded-mcx.ts";
import { makeQuote, chainFromQuotes, type Chain, type Quote } from "../src/core/chain.ts";
import { PaperBroker, emptyPaper, unrealised } from "../src/core/paper.ts";
import { executeLegs, closePosition, type ExecDeps, type PlaceRequest, type UnwindResult } from "../src/core/execution.ts";
import { checkOrder, DEFAULT_RISK, sanitizeRiskConfig, REAL_MONEY_PHRASE, LIVE_BLOCKED, type OrderIntent, type RiskState } from "../src/core/risk.ts";
import { protectiveLimit, alignToTick } from "../src/core/rules.ts";
import { charges, sumCharges, derivChargeSegment } from "../src/core/charges.ts";
import { legsPayoff } from "../src/core/strategy.ts";
import { istDate, istMs } from "../src/core/ist.ts";
import { round2 } from "../src/core/money.ts";

export const DEMO_LABEL = "DEMO · recorded prices from 8 Oct 2026 · no broker, no orders";
export const DEMO_RECORDED = "Recorded NSE option chain, Thu 8 Oct 2026 10:39 IST";

interface NseSide { buyPrice1: number; buyQuantity1: number; sellPrice1: number; sellQuantity1: number; lastPrice: number; impliedVolatility: number; openInterest: number }
interface NseChain { timestamp: string; underlyingValue: number; expiry: string; data: { strikePrice: number; CE?: NseSide; PE?: NseSide }[] }

export class DemoError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (code: string, msg: string, status = 400): never => {
  throw new DemoError(status, code, msg);
};

const MON: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
const nseIso = (e: string): string => {
  const [d, m, y] = e.split("-") as [string, string, string];
  return `${y}-${MON[m]}-${d.padStart(2, "0")}`;
};

/** Demo clock: starts at the recording time and runs in real time, capped at +4 h so the recorded session stays open. */
const RECORDED_AT = istMs("2026-10-08", 10, 39);
const started = Date.now();
const now = (): number => RECORDED_AT + Math.min(Date.now() - started, 4 * 3600_000);

async function loadData() {
  const [inst, instMcx, mcx, hol, idx, n13, n27, bn, fn, rel] = await Promise.all([
    import("../tests/fixtures/upstox-instruments.json"),
    import("../tests/fixtures/upstox-instruments-mcx-cds.json"),
    import("../tests/fixtures/mcx-chains.json"),
    import("../tests/fixtures/upstox-holidays.json"),
    import("../tests/fixtures/nse-indices.json"),
    import("../tests/fixtures/nse-chain-NIFTY-13-Oct-2026.json"),
    import("../tests/fixtures/nse-chain-NIFTY-27-Oct-2026.json"),
    import("../tests/fixtures/nse-chain-BANKNIFTY-27-Oct-2026.json"),
    import("../tests/fixtures/nse-chain-FINNIFTY-27-Oct-2026.json"),
    import("../tests/fixtures/nse-chain-RELIANCE-27-Oct-2026.json"),
  ]);
  const d = <T>(m: unknown): T => ((m as { default?: T }).default ?? m) as T;
  return {
    rows: [...d<{ rows: Record<string, unknown>[] }>(inst).rows, ...d<{ rows: Record<string, unknown>[] }>(instMcx).rows],
    mcx: d<{ chains: Record<string, McxChainRecord> }>(mcx).chains,
    holidays: d<{ body: { data: Parameters<typeof HolidayCalendar.fromUpstox>[0] } }>(hol).body.data,
    indices: d<{ data: { index: string; last: number }[] }>(idx).data,
    chains: { NIFTY: [d<NseChain>(n13), d<NseChain>(n27)], BANKNIFTY: [d<NseChain>(bn)], FINNIFTY: [d<NseChain>(fn)], RELIANCE: [d<NseChain>(rel)] } as Record<string, NseChain[]>,
  };
}

const INDEX_NAMES: Record<string, string> = { "NIFTY 50": "NIFTY", "NIFTY BANK": "BANKNIFTY", "NIFTY FINANCIAL SERVICES": "FINNIFTY", "NIFTY MIDCAP SELECT": "MIDCPNIFTY" };

export async function createDemo() {
  const data = await loadData();
  const store = InstrumentStore.fromUpstox(data.rows, RECORDED_AT);
  const cal = HolidayCalendar.fromUpstox(data.holidays);
  let risk = { ...DEFAULT_RISK };
  let killSwitch = false;
  const audit: { seq: number; ts: number; type: string }[] = [];
  const log = (type: string) => audit.push({ seq: audit.length + 1, ts: now(), type });
  log("demo.start");

  // recorded quotes: option quotes from the chains, spots from the chains / the NSE indices snapshot
  const quotes = new Map<string, Omit<Quote, "ts">>();
  const spotOf = new Map<string, number>();
  for (const x of data.indices) if (INDEX_NAMES[x.index]) spotOf.set(INDEX_NAMES[x.index]!, x.last);
  const chainOf = (u: string, expiry: string): Chain | null => {
    const c = (data.chains[u] ?? []).find((x) => nseIso(x.expiry) === expiry);
    if (!c) return null;
    const rows = new Map<number, Chain["rows"][number]>();
    for (const i of store.chain(u, expiry)) {
      const r = c.data.find((dd) => dd.strikePrice === i.strike);
      const x = r ? (i.type === "CE" ? r.CE : r.PE) : undefined;
      const q = x ? makeQuote({ ltp: x.lastPrice, bid: x.buyPrice1, ask: x.sellPrice1, bidQty: x.buyQuantity1, askQty: x.sellQuantity1, ivPct: x.impliedVolatility, oi: x.openInterest }, now()) : null;
      const row = rows.get(i.strike!) ?? { strike: i.strike!, call: null, put: null };
      if (i.type === "CE") row.call = { inst: i, q };
      else row.put = { inst: i, q };
      rows.set(i.strike!, row);
    }
    return { underlying: u, expiryDate: expiry, expiryMs: istMs(expiry, 15, 30), spot: c.underlyingValue, rows: [...rows.values()].sort((a, b) => a.strike - b.strike), fetchedAt: now(), source: DEMO_RECORDED };
  };
  for (const [u, list] of Object.entries(data.chains)) {
    for (const c of list) {
      const ch = chainOf(u, nseIso(c.expiry));
      if (!ch) continue;
      for (const r of ch.rows) for (const sd of [r.call, r.put]) if (sd?.q) quotes.set(sd.inst.key, sd.q);
      if (c === list[0]) spotOf.set(u, c.underlyingValue); // same snapshot the builder prices from
    }
  }
  for (const [u, v] of spotOf) {
    const k = store.spotKey(u);
    if (k) quotes.set(k, { ltp: v, bid: null, ask: null, bidQty: 0, askQty: 0, iv: null, oi: null });
  }
  // MCX: the recorded public MCX option chains (options + the futures they are written on)
  const mcxQuotes = new Map<string, Map<string, Omit<Quote, "ts">>>();
  for (const [k, rec] of Object.entries(data.mcx)) {
    const [u, date] = k.split(":") as [string, string];
    const m = quotesFromMcx(u, date, rec, store, now(), 0);
    mcxQuotes.set(k, m);
    for (const [key, q] of m) quotes.set(key, q);
    const near = store.futuresOf(u, now())[0];
    if (near && store.pricingKey(u, date, now()) === near.key && rec.underlyingValue) spotOf.set(u, rec.underlyingValue);
  }
  for (const k of Object.keys(data.mcx)) {
    const u = k.split(":")[0]!;
    if (!spotOf.has(u)) {
      // the nearest future had no option on it today: show the price of the future the first recorded expiry is written on
      const date = k.split(":")[1]!;
      const pk = store.pricingKey(u, date, now());
      const v = pk ? quotes.get(pk)?.ltp : null;
      if (v) spotOf.set(u, v);
    }
  }
  const mcxChain = (u: string, expiry: string): Chain | null => {
    const m = mcxQuotes.get(`${u}:${expiry}`);
    const rec = data.mcx[`${u}:${expiry}`];
    if (!m || !rec?.underlyingValue) return null;
    const insts = store.chain(u, expiry);
    const q: Record<string, Quote> = {};
    for (const [k, x] of m) q[k] = { ...x, ts: now() };
    return chainFromQuotes({ underlying: u, expiryDate: expiry, expiryMs: optionExpiryMs("MCX_FO", expiry), spot: rec.underlyingValue, insts, quotes: q, fetchedAt: now(), source: `Recorded MCX option chain, Thu 8 Oct 2026 ${rec.asOn.slice(11)}` });
  };

  // the one stock with a recorded price: RELIANCE (its option chain's underlying value; no order book)
  const rel = store.equity("RELIANCE");
  if (rel && spotOf.has("RELIANCE")) quotes.set(rel.key, { ltp: spotOf.get("RELIANCE")!, bid: null, ask: null, bidQty: 0, askQty: 0, iv: null, oi: null });

  const quote = (k: string): Quote | null => {
    const q = quotes.get(k);
    return q ? { ...q, ts: now() } : null;
  };
  const paper = new PaperBroker(emptyPaper(), (k) => store.get(k), async (k) => quote(k), now);
  const session = (inst: Pick<Instrument, "exchange" | "type" | "segment">) => venueSession(now(), venueOf(inst), cal);

  const riskState = (): RiskState => {
    const netQtyByKey: Record<string, number> = {};
    let todayPnl: number | null = 0;
    for (const p of Object.values(paper.state.positions)) {
      netQtyByKey[p.instrumentKey] = p.qty;
      const u = unrealised(p, quote(p.instrumentKey)?.ltp ?? null);
      todayPnl = todayPnl === null || u === null ? null : todayPnl + p.realised - p.charges + u;
    }
    return { killSwitch, todayPnl, netQtyByKey };
  };

  const deps = (tradeWorstLoss: number | undefined, product: "D" | "I", tag: string): ExecDeps => {
    let rs = riskState();
    return {
      broker: {
        async place(r: PlaceRequest) {
          log("order.send (paper)");
          return paper.place(r);
        },
        status: (id) => paper.status(id),
        cancel: (id) => paper.cancel(id),
      },
      async check(r) {
        const inst = store.get(r.instrumentKey);
        if (r.purpose !== "entry") rs = riskState();
        const intent: OrderIntent = { instrumentKey: r.instrumentKey, side: r.side, qty: r.qty, orderType: "LIMIT", limitPrice: r.limit, product: r.product, purpose: r.purpose };
        const res = checkOrder(intent, { config: risk, state: rs, inst, quote: quote(r.instrumentKey), session: session(inst ?? { exchange: "NSE", type: "CE", segment: "NSE_FO" }), now: now(), tradeWorstLoss: r.purpose === "entry" ? tradeWorstLoss : undefined });
        if (!res.ok) log(`risk.block ${res.code}`);
        return res;
      },
      async unwindLimit(inst, side, attempt) {
        const q = quote(inst.key);
        const touch = side === "SELL" ? (q?.bid ?? q?.ltp) : (q?.ask ?? q?.ltp);
        if (!touch) return side === "SELL" ? inst.tickPaise / 100 : alignToTick(1e7, inst.tickPaise, "down");
        return protectiveLimit(side, touch, inst.tickPaise, Math.min(risk.maxExitSlippage, 0.05 * attempt));
      },
      product,
      tag,
      pollMs: 50,
      timeoutMs: 2000,
    };
  };

  const noLive = (b: Record<string, unknown>) => {
    if (b.mode === "live") bad("demo", "The demo is paper only: no broker, no real orders.", 403);
    if (b.mode !== "paper") bad("mode", 'mode must be "paper"');
  };

  async function handle(method: string, path: string, body: Record<string, unknown> = {}): Promise<unknown> {
    const url = new URL(path, "http://demo");
    const q = url.searchParams;
    const p = url.pathname;
    const route = `${method} ${p}`;
    switch (route) {
      case "GET /api/session": {
        const t = now();
        const markets = (["NSE", "BSE"] as const).flatMap((ex) => (["FO", "EQ"] as const).map((m) => ({ ...marketSession(t, ex, cal, m), market: m, label: "Recorded session · 8 Oct 2026 10:39 IST" })));
        const venues = (["NFO", "BFO", "NSE", "BSE", "MCX", "CDS"] as Venue[]).map((v) => ({ venue: v, ...venueSession(t, v, cal), label: v === "MCX" ? "Recorded · MCX 8 Oct 2026 16:13–16:14 IST" : "Recorded session · 8 Oct 2026 10:39 IST" }));
        return {
          now: t,
          demo: true,
          broker: { id: "upstox", name: "No broker (demo)", status: "implemented", docs: "", sandbox: false, loggedIn: false, userId: null, userName: null, expiresAt: null, approvalPendingUntil: null },
          liveTrading: false,
          killSwitch,
          risk,
          instruments: { count: store.size, loadedAt: RECORDED_AT },
          holidays: { source: "Recorded Upstox holiday list" },
          markets,
          venues,
          liveBlocked: LIVE_BLOCKED,
          confirmPhrase: REAL_MONEY_PHRASE,
        };
      }
      case "GET /api/instruments/underlyings":
        return {
          loadedAt: RECORDED_AT,
          underlyings: underlyingList(store, now()),
        };
      case "GET /api/instruments/equity":
        return { results: store.searchEquity(q.get("q") ?? "", 8) };
      case "GET /api/chain": {
        const u = q.get("u") ?? "", e = q.get("expiry") ?? "";
        const dd = derivDef(u);
        if (dd?.category === "currency") bad("no-recording", "No recorded currency prices in the demo (the public NSE currency option chain was empty when we recorded)", 404);
        if (dd) {
          const mc = mcxChain(u, e);
          if (!mc) bad("no-recording", `No recorded ${dd.label} prices for this expiry in the demo. Recorded: the two nearest MCX option expiries of each commodity, 8 Oct 2026 16:13–16:14 IST.`, 404);
          return mc;
        }
        const c = chainOf(u, e);
        if (!c) bad("no-recording", `The demo has no recorded option chain for ${INDICES.find((x) => x.id === u)?.label ?? u} on this expiry. Recorded: Nifty 13 & 27 Oct, Bank Nifty, Fin Nifty and Reliance 27 Oct.`, 404);
        return c;
      }
      case "GET /api/quotes": {
        const out: Record<string, Quote> = {};
        for (const k of (q.get("keys") ?? "").split(",").filter(Boolean)) {
          const x = quote(k);
          if (x) out[k] = x;
        }
        return { quotes: out };
      }
      case "GET /api/spots": {
        const spots: Record<string, { ltp: number | null; changePct: null; spark: null }> = {};
        // the recording is one snapshot: there is no previous close and no intraday series, so no day % and no sparkline
        for (const u of (q.get("u") ?? "").split(",").filter(Boolean)) spots[u] = { ltp: spotOf.get(u) ?? null, changePct: null, spark: null };
        return { spots, at: now() };
      }
      case "POST /api/margin":
      case "POST /api/charges/broker":
        return bad("demo", "no broker in the demo", 503);
      case "PUT /api/risk": {
        risk = sanitizeRiskConfig(body as never, risk);
        log("risk.config");
        return { ...risk, killSwitch };
      }
      case "POST /api/kill/switch":
        killSwitch = Boolean(body.on);
        log(`kill.switch ${killSwitch ? "on" : "off"}`);
        return { killSwitch };
      case "POST /api/trade/options": {
        noLive(body);
        const raw = (Array.isArray(body.legs) ? body.legs : []) as { key: string; side: "BUY" | "SELL"; qty: number; limit: number }[];
        if (raw.length < 1 || raw.length > 2) bad("legs", "An options trade here is one bought option or a two-leg spread");
        const legs = raw.map((l) => {
          const inst = store.get(String(l.key));
          if (!inst || (inst.type !== "CE" && inst.type !== "PE")) bad("legs", `Not an option: ${l.key}`);
          return { inst: inst!, side: l.side, qty: Number(l.qty), limit: Number(l.limit) };
        });
        if (legs.length === 1 && legs[0]!.side !== "BUY") bad("defined-risk", "A single option can only be bought");
        if (legs.length === 2) {
          const [a, b] = legs as [(typeof legs)[0], (typeof legs)[0]];
          if (a.inst.underlying !== b.inst.underlying || a.inst.expiryDate !== b.inst.expiryDate || a.inst.type !== b.inst.type || a.side === b.side || a.qty !== b.qty) bad("defined-risk", "Two legs must form a vertical spread");
        }
        const ks = legs.map((l) => l.inst.strike!);
        const pay = legs.map((l) => ({ inst: l.inst, side: l.side, qty: l.qty, price: l.limit }));
        const worstPay = Math.min(...[0.01, ...ks, Math.max(...ks) * 10].map((S) => legsPayoff(pay, S)));
        const ch = sumCharges(legs.map((l) => charges({ segment: derivChargeSegment(l.inst), exchange: l.inst.exchange, side: l.side, qty: l.qty, price: l.limit, date: istDate(now()) })));
        const worst = round2(Math.max(0, -worstPay) + ch.total);
        log("trade.start (paper)");
        const res = await executeLegs(legs, deps(worst, "D", `demo-${now().toString(36)}`));
        log(`trade.done ${res.status}`);
        return { mode: "paper", paper: true, demo: true, worstLoss: worst, result: res };
      }
      case "POST /api/trade/equity": {
        noLive(body);
        const inst = store.get(String(body.key));
        if (!inst || inst.type !== "EQ") bad("instrument", "Not an equity in the recorded master");
        const side = body.side === "SELL" ? "SELL" : "BUY";
        const qty = Number(body.qty), limit = Number(body.limit);
        const product = body.product === "I" ? "I" : "D";
        const dd = deps(side === "BUY" ? qty * limit : undefined, product, `demo-eq-${now().toString(36)}`);
        const req: PlaceRequest = { instrumentKey: inst!.key, side, qty, limit, product, validity: "DAY", tag: dd.tag, purpose: side === "SELL" ? "exit" : "entry" };
        const rc = await dd.check(req);
        if (!rc.ok) return { mode: "paper", paper: true, placed: false, rule: rc.code, message: rc.message };
        const pl = await dd.broker.place(req);
        if (!pl.ok) return { mode: "paper", paper: true, placed: false, message: pl.error };
        return { mode: "paper", paper: true, placed: true, orderIds: pl.orderIds, status: await dd.broker.status(pl.orderIds[0]!) };
      }
      case "GET /api/orders":
        await paper.sweep();
        return { mode: "paper", paper: true, orders: [...paper.state.orders].reverse() };
      case "GET /api/trades":
        return { mode: "paper", paper: true, trades: paper.state.orders.filter((o) => o.filled > 0).map((o) => ({ tradeId: o.id, orderId: o.id, key: o.instrumentKey, symbol: o.symbol, side: o.side, qty: o.filled, price: o.avgPrice, ts: o.ts, paper: true })).reverse() };
      case "POST /api/orders/cancel":
        await paper.cancel(String(body.orderId ?? ""));
        return { cancelled: body.orderId };
      case "GET /api/portfolio": {
        await paper.sweep();
        const positions = Object.values(paper.state.positions).map((x) => {
          const ltp = quote(x.instrumentKey)?.ltp ?? null;
          const u = unrealised(x, ltp);
          return { key: x.instrumentKey, symbol: x.symbol, qty: x.qty, avgPrice: x.avgPrice || null, ltp, realised: x.realised, unrealised: u, charges: x.charges, pnl: u === null ? null : round2(x.realised + u - x.charges), paper: true };
        });
        const total = positions.every((x) => x.pnl !== null) ? round2(positions.reduce((a, x) => a + (x.pnl ?? 0), 0)) : null;
        return { mode: "paper", paper: true, positions, holdings: [], funds: null, pnl: total, note: "Demo: positions are marked at the recorded 8 Oct 2026 prices." };
      }
      case "POST /api/paper/reset":
        paper.reset();
        log("paper.reset");
        return { reset: true };
      case "POST /api/kill/cancel-all":
        noLive(body);
        log("kill.cancel-all");
        return { mode: "paper", cancelled: paper.cancelAll() };
      case "POST /api/kill/exit-all": {
        noLive(body);
        if (String(body.confirm ?? "").trim().toUpperCase() !== "EXIT ALL") bad("confirm", "Type EXIT ALL to close every position");
        paper.cancelAll();
        const open = Object.entries(riskState().netQtyByKey).filter(([, n]) => n !== 0);
        const dd = deps(undefined, "D", `demo-exit-${now().toString(36)}`);
        const results: UnwindResult[] = [];
        for (const [key, n] of [...open.filter(([, x]) => x < 0), ...open.filter(([, x]) => x > 0)]) {
          const inst = store.get(key);
          if (inst) results.push(await closePosition(inst, n, dd));
        }
        log("kill.exit-all");
        return { mode: "paper", paper: true, results, skipped: [] };
      }
      case "GET /api/audit":
        return { entries: [...audit].reverse().slice(0, Number(q.get("limit") ?? 30)) };
      case "GET /api/brokers":
        return { brokers: [{ id: "upstox", name: "Upstox", status: "implemented", docs: "https://upstox.com/developer/api-documentation/" }] };
      case "GET /auth/broker/login":
      case "POST /auth/broker/request":
      case "POST /auth/broker/logout":
        return bad("demo", "The demo has no broker. Sign in to your own gateway to connect Upstox.", 403);
      default:
        return bad("not-found", `Not in the demo: ${route}`, 404);
    }
  }
  return { handle, now };
}
export type Demo = Awaited<ReturnType<typeof createDemo>>;
