// The broker-adapter interface. The gateway only talks to this; Upstox is the
// first implementation. Zerodha Kite, Dhan, Fyers and Angel SmartAPI are stubs
// that report "not implemented" (see ./stubs.ts) until someone writes them.

import type { Instrument, InstrumentStore } from "../../src/core/instruments.ts";
import type { HolidayCalendar } from "../../src/core/calendar.ts";
import type { Chain, Quote } from "../../src/core/chain.ts";
import type { OrderState, OrderStatus, PlaceRequest } from "../../src/core/execution.ts";
import type { Side } from "../../src/core/charges.ts";

export type BrokerId = "upstox" | "zerodha" | "dhan" | "fyers" | "angel";

export interface BrokerInfo {
  id: BrokerId;
  name: string;
  status: "implemented" | "not-implemented";
  docs: string;
  sandbox: boolean; // the adapter is pointed at the broker's sandbox (orders only)
}

export interface BrokerSession {
  userId: string | null;
  userName: string | null;
  obtainedAt: number;
  expiresAt: number; // Upstox: 03:30 IST the next day
}

export interface Position {
  key: string;
  symbol: string;
  exchange: string;
  product: string;
  qty: number; // + long / − short
  avgPrice: number | null;
  ltp: number | null;
  pnl: number | null;
  realised: number | null;
  unrealised: number | null;
}

export interface Holding {
  key: string;
  symbol: string;
  isin: string | null;
  qty: number;
  avgPrice: number | null;
  ltp: number | null;
  pnl: number | null;
  dayChangePct: number | null;
}

export interface BrokerOrder {
  orderId: string;
  key: string;
  symbol: string;
  side: Side;
  qty: number;
  filled: number;
  pending: number;
  price: number;
  avgPrice: number | null;
  orderType: string;
  validity: string;
  product: string;
  status: string; // the broker's own status text
  state: OrderState;
  message: string | null;
  ts: string | null;
  tag: string | null;
}

export interface Trade {
  tradeId: string;
  orderId: string;
  key: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  ts: string | null;
}

export interface Funds {
  available: number | null;
  used: number | null;
  source: string;
}

export interface MarginLeg {
  key: string;
  qty: number;
  side: Side;
  product: "D" | "I";
  price?: number;
}

export interface MarginResult {
  required: number; // sum of legs
  final: number; // after hedge benefit
  perLeg: number[];
}

export interface BrokerCharges {
  total: number;
  brokerage: number;
  stt: number;
  exchangeTxn: number;
  stampDuty: number;
  gst: number;
  sebiFee: number;
  ipft: number;
  dpMin: number | null;
}

export interface GttRule {
  strategy: "ENTRY" | "TARGET" | "STOPLOSS";
  triggerType: "ABOVE" | "BELOW" | "IMMEDIATE";
  triggerPrice: number;
}

export interface GttRequest {
  key: string;
  side: Side;
  qty: number;
  product: "D" | "I";
  rules: GttRule[];
}

export interface GttOrder {
  id: string;
  key: string;
  symbol: string | null;
  side: Side;
  qty: number;
  status: string;
  rules: GttRule[];
}

export interface PnlRow {
  symbol: string;
  qty: number;
  buyDate: string | null;
  buyAvg: number;
  sellDate: string | null;
  sellAvg: number;
  pnl: number;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string; code?: string; status?: number };

export class NotImplementedError extends Error {
  readonly broker: BrokerId;
  constructor(broker: BrokerId, what: string) {
    super(`${broker}: ${what} is not implemented yet`);
    this.broker = broker;
  }
}

export interface BrokerAdapter {
  readonly info: BrokerInfo;

  // ── auth (OAuth: the api secret stays on the gateway) ──
  loginUrl(state: string): string;
  exchangeCode(code: string): Promise<Result<BrokerSession & { accessToken: string }>>;
  /** Ask the broker to push a login approval to the user's phone (Upstox access-token request). */
  requestApproval?(): Promise<Result<{ expiresAt: number }>>;
  /** Check a token (e.g. one delivered to the notifier webhook) by reading the user's profile. */
  verifyToken(token: string): Promise<Result<{ userId: string | null; userName: string | null }>>;
  setSession(token: string | null, session: BrokerSession | null): void;
  session(): BrokerSession | null;
  logout(): Promise<void>;

  // ── public reference data ──
  instruments(): Promise<Instrument[]>;
  holidays(): Promise<HolidayCalendar>;

  // ── market data (needs a session) ──
  quotes(keys: string[]): Promise<Result<Record<string, Quote>>>;
  optionChain(store: InstrumentStore, underlying: string, expiryDate: string): Promise<Result<Chain>>;
  /** Today's intraday closes (oldest first) for a sparkline. Optional: no sparkline when missing. */
  intraday?(key: string): Promise<Result<number[]>>;
  /** Live stream (WebSocket). Returns an unsubscribe function, or null when streaming is unavailable. */
  stream?(keys: string[], onQuote: (key: string, q: Partial<Quote>) => void, onClose: (why: string) => void): Promise<(() => void) | null>;

  // ── orders ──
  place(r: PlaceRequest): Promise<{ ok: true; orderIds: string[] } | { ok: false; error: string }>;
  modify(orderId: string, p: { qty?: number; price: number; validity: "DAY" | "IOC" }): Promise<Result<string>>;
  cancel(orderId: string): Promise<void>;
  status(orderId: string): Promise<OrderStatus>;
  cancelAll(segment?: string): Promise<Result<string[]>>;
  exitAll(segment?: string): Promise<Result<string[]>>;

  // ── GTT ──
  placeGtt(g: GttRequest): Promise<Result<string[]>>;
  modifyGtt(id: string, g: GttRequest): Promise<Result<string>>;
  cancelGtt(id: string): Promise<Result<string>>;
  listGtt(): Promise<Result<GttOrder[]>>;

  // ── account ──
  positions(): Promise<Result<Position[]>>;
  holdings(): Promise<Result<Holding[]>>;
  orders(): Promise<Result<BrokerOrder[]>>;
  trades(): Promise<Result<Trade[]>>;
  funds(): Promise<Result<Funds>>;
  margin(legs: MarginLeg[]): Promise<Result<MarginResult>>;
  brokerage(leg: MarginLeg & { price: number }): Promise<Result<BrokerCharges>>;
  pnlReport(segment: "EQ" | "FO", financialYear: string): Promise<Result<PnlRow[]>>;
}
