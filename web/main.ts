// Plain English India — the static frontend. It only ever talks to the user's own
// gateway. Every price, lot size and expiry on screen comes from the gateway (which
// reads the broker); when something is not available the UI says so instead of
// showing a number.

import "./styles.css";
import { api, ApiError, defaultGateway } from "./api.ts";
import { escapeHtml as esc, inr, inr2, num, pct, signedInr } from "../src/core/money.ts";
import { istClock, shortDate, dayDiff, istDate, longDate } from "../src/core/ist.ts";
import { parseView, sentence, type ParsedView } from "../src/core/sentence.ts";
import { suggest, describeFail, payoffCurve, type Suggestion, type View } from "../src/core/strategy.ts";
import { CHARGE_LABELS, type ChargeBreakdown } from "../src/core/charges.ts";
import { parseEquity, equityTicket, type EquityTicket } from "../src/core/equity.ts";
import type { Chain, Quote } from "../src/core/chain.ts";
import type { ExpiryInfo, Instrument } from "../src/core/instruments.ts";
import { maxPerOrder } from "../src/core/rules.ts";

// ── state ────────────────────────────────────────────────────────────
interface Underlying { id: string; label: string; index: boolean; exchange: string; lotSize: number | null; spotKey: string | null; expiries: ExpiryInfo[] }
interface MarketS { exchange: string; market: string; state: string; canTrade: boolean; label: string; opensAt: number | null }
interface Session {
  now: number;
  broker: { id: string; name: string; sandbox: boolean; loggedIn: boolean; userId: string | null; userName: string | null; expiresAt: number | null; approvalPendingUntil: number | null };
  liveTrading: boolean;
  killSwitch: boolean;
  risk: { perTradeCap: number | null; dailyLossCap: number | null; maxSlippage: number; quoteMaxAgeMs: number; maxOrdersPerSecond: number };
  instruments: { count: number; loadedAt?: number; error?: string };
  holidays: { source?: string; error?: string };
  markets: MarketS[];
  confirmPhrase: string;
}

const S = {
  session: null as Session | null,
  clockSkew: 0, // gateway now − browser now
  mode: "paper" as "paper" | "live",
  tab: "options" as "options" | "stocks" | "portfolio" | "orders" | "safety",
  underlyings: [] as Underlying[],
  view: { underlying: "NIFTY", dir: "above", mode: "stays", level: NaN, expiryDate: "", risk: NaN } as View,
  parsed: null as ParsedView | null,
  chain: null as Chain | null,
  chainError: null as string | null,
  suggestions: [] as Suggestion[],
  failures: [] as string[],
  margins: new Map<string, string>(),
  review: null as Suggestion | null,
  brokerCharges: null as { total: number } | null | string,
  ticket: null as EquityTicket | null,
  ticketMsg: "",
};
const gwNow = (): number => Date.now() + S.clockSkew;

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T => root.querySelector(sel) as T;
const app = document.getElementById("app")!;

function toast(msg: string, kind: "ok" | "err" = "ok"): void {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast toast--${kind}`;
  t.hidden = false;
  clearTimeout((t as unknown as { _t?: number })._t);
  (t as unknown as { _t?: number })._t = window.setTimeout(() => (t.hidden = true), 6000);
}
const errText = (e: unknown): string => (e instanceof ApiError ? e.message : (e as Error).message);

// ── shell ────────────────────────────────────────────────────────────
function shell(): void {
  app.innerHTML = `
  <header class="top">
    <div class="brand">Plain English <b>India</b></div>
    <div class="chips" id="chips"></div>
  </header>
  <div id="banner"></div>
  <nav class="tabs" role="tablist">
    ${(["options", "stocks", "portfolio", "orders", "safety"] as const).map((t) => `<button role="tab" data-tab="${t}" aria-selected="${S.tab === t}">${{ options: "Options", stocks: "Stocks", portfolio: "Portfolio", orders: "Orders", safety: "Safety" }[t]}</button>`).join("")}
  </nav>
  <main id="view"></main>
  <div class="toast" id="toast" hidden role="status"></div>
  <div class="scrim" id="scrim" hidden><div class="sheet" id="sheet" role="dialog" aria-modal="true"></div></div>`;
  app.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      S.tab = b.dataset.tab as typeof S.tab;
      app.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      render();
    }),
  );
}

function chips(): void {
  const s = S.session;
  const el = $("#chips");
  if (!s) {
    el.innerHTML = `<span class="chip chip--grey">Not connected</span>`;
    return;
  }
  const fo = s.markets.find((m) => m.exchange === "NSE" && m.market === "FO");
  const mk = fo ? `<span class="chip ${fo.canTrade ? "chip--green" : "chip--grey"}" data-testid="market-chip" title="${esc(s.holidays.source ?? "")}">${esc(fo.label)}${!fo.canTrade && fo.opensAt ? ` · opens ${esc(shortDate(istDate(fo.opensAt)))} ${esc(istClock(fo.opensAt))}` : ""}</span>` : `<span class="chip chip--amber">Market hours unknown</span>`;
  const b = s.broker;
  const br = b.loggedIn
    ? `<span class="chip chip--dark" data-testid="broker-chip">${esc(b.name)}${b.sandbox ? " sandbox" : ""} · ${esc(b.userId ?? "")} · till ${b.expiresAt ? esc(istClock(b.expiresAt)) : "?"}</span>`
    : `<button class="chip chip--amber" id="brokerLogin" data-testid="broker-chip">Log in to ${esc(b.name)}</button>`;
  const modeSeg = `<span class="seg" role="group" aria-label="Trading mode">
      <button data-mode="paper" aria-pressed="${S.mode === "paper"}">Paper</button>
      <button data-mode="live" aria-pressed="${S.mode === "live"}" ${s.liveTrading && b.loggedIn ? "" : `disabled title="${s.liveTrading ? "Log in to the broker first" : "Live trading is disabled on your gateway (LIVE_TRADING_ENABLED)"}"`}>Live</button>
    </span>`;
  const ks = s.killSwitch ? `<span class="chip chip--red" data-testid="kill-chip">Kill switch ON</span>` : "";
  el.innerHTML = mk + br + ks + modeSeg;
  $("#brokerLogin", el)?.addEventListener("click", brokerLogin);
  el.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((x) =>
    x.addEventListener("click", () => {
      S.mode = x.dataset.mode as "paper" | "live";
      chips();
      banner();
      render();
    }),
  );
}

function banner(): void {
  const b = $("#banner");
  if (S.mode === "live") b.innerHTML = `<div class="banner banner--live" data-testid="live-banner">LIVE · real money · orders go to ${esc(S.session?.broker.name ?? "your broker")}</div>`;
  else b.innerHTML = `<div class="banner banner--paper" data-testid="paper-banner">PAPER · simulated fills against live quotes · nothing is sent to the broker</div>`;
}

async function brokerLogin(): Promise<void> {
  try {
    const r = await api.get<{ url: string }>("/auth/broker/login");
    location.href = r.url; // Upstox login page → gateway callback → back here
  } catch (e) {
    toast(errText(e), "err");
  }
}

// ── connect / sign in ────────────────────────────────────────────────
function connectView(msg = ""): void {
  app.innerHTML = `
  <div class="connect">
    <div class="brand brand--big">Plain English <b>India</b></div>
    <p class="lede">Say what you think Nifty, Bank Nifty, Fin Nifty or Sensex will do, in plain English, and get a defined-risk options spread on your own broker account.</p>
    <form id="connect" class="card">
      <label>Your gateway URL<input name="url" required placeholder="https://gateway.example.in" value="${esc(defaultGateway())}" autocomplete="url"></label>
      <label>Gateway passphrase<input name="pass" type="password" required autocomplete="current-password"></label>
      <button class="btn btn--dark" type="submit">Sign in</button>
      <p class="muted small">The gateway is the small server you run on a static-IP VPS (SEBI requires API orders to come from a whitelisted static IP). Your broker password, PIN and TOTP are only ever typed on the broker's own login page.</p>
      ${msg ? `<p class="err">${esc(msg)}</p>` : ""}
    </form>
  </div>`;
  $("#connect").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target as HTMLFormElement);
    api.setBase(String(f.get("url")));
    try {
      const r = await api.post<{ token: string }>("/auth/login", { passphrase: String(f.get("pass")) });
      api.setToken(r.token);
      await boot();
    } catch (e) {
      connectView(errText(e));
    }
  });
}

async function refreshSession(): Promise<void> {
  const s = await api.get<Session>("/api/session");
  S.session = s;
  S.clockSkew = s.now - Date.now();
  if (S.mode === "live" && !(s.liveTrading && s.broker.loggedIn)) S.mode = "paper";
  chips();
  banner();
}

async function boot(): Promise<void> {
  if (!api.token || !api.base) return connectView();
  try {
    shell();
    await refreshSession();
    const fromHash = new URLSearchParams(location.hash.slice(1)).get("broker");
    if (fromHash) {
      toast(fromHash === "connected" ? "Upstox connected" : `Upstox login: ${fromHash}`, fromHash === "connected" ? "ok" : "err");
      history.replaceState(null, "", location.pathname + location.search);
    }
    try {
      S.underlyings = (await api.get<{ underlyings: Underlying[] }>("/api/instruments/underlyings")).underlyings;
    } catch (e) {
      S.underlyings = [];
      S.chainError = errText(e);
    }
    const u = S.underlyings.find((x) => x.id === S.view.underlying) ?? S.underlyings[0];
    if (u) S.view = { ...S.view, underlying: u.id, expiryDate: u.expiries[0]?.date ?? "" };
    render();
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 0)) return connectView(errText(e));
    toast(errText(e), "err");
  }
}

// ── views ────────────────────────────────────────────────────────────
function render(): void {
  const v = $("#view");
  if (!v) return;
  if (S.tab === "options") optionsView(v);
  else if (S.tab === "stocks") stocksView(v);
  else if (S.tab === "portfolio") void portfolioView(v);
  else if (S.tab === "orders") void ordersView(v);
  else void safetyView(v);
}

const dirLabel = (v: Pick<View, "dir" | "mode">): string => ({ "above-stays": "stays above", "above-reaches": "goes above", "below-stays": "stays below", "below-reaches": "falls below" })[`${v.dir}-${v.mode}`]!;

function expiryLabel(e: ExpiryInfo): string {
  const d = dayDiff(istDate(gwNow()), e.date);
  return `${shortDate(e.date)} · ${e.kind} · ${d === 0 ? "today" : `${d} day${d === 1 ? "" : "s"}`}`;
}

function optionsView(root: HTMLElement): void {
  const u = S.underlyings.find((x) => x.id === S.view.underlying);
  const s = S.session!;
  root.innerHTML = `
  <section class="builder">
    <form id="nl" class="nl">
      <input id="nlText" aria-label="Your view in plain English" placeholder="I think Nifty stays above 25,000 till Tuesday's expiry, risking ₹5,000" autocomplete="off">
      <button class="btn btn--dark" type="submit">Read it</button>
    </form>
    <div id="nlNotes" class="notes"></div>
    <p class="sent" data-testid="sentence">
      I think
      <select class="pill pill--lav" id="pU" aria-label="Underlying">${S.underlyings.map((x) => `<option value="${esc(x.id)}" ${x.id === S.view.underlying ? "selected" : ""}>${esc(x.label)}</option>`).join("") || `<option>—</option>`}</select>
      <select class="pill pill--sal" id="pD" aria-label="Direction">${[["above", "stays"], ["above", "reaches"], ["below", "stays"], ["below", "reaches"]].map(([d, m]) => `<option value="${d}-${m}" ${S.view.dir === d && S.view.mode === m ? "selected" : ""}>${dirLabel({ dir: d as View["dir"], mode: m as View["mode"] })}</option>`).join("")}</select>
      <input class="pill pill--mint" id="pL" inputmode="decimal" aria-label="Level" placeholder="level" value="${Number.isFinite(S.view.level) ? S.view.level : ""}" size="7">
      by the
      <select class="pill pill--lav" id="pE" aria-label="Expiry">${(u?.expiries ?? []).map((e) => `<option value="${e.date}" ${e.date === S.view.expiryDate ? "selected" : ""}>${esc(expiryLabel(e))}</option>`).join("") || `<option value="">no expiries</option>`}</select>
      expiry, risking
      <input class="pill pill--amt" id="pR" inputmode="decimal" aria-label="Amount you are risking in rupees" placeholder="₹ amount" value="${Number.isFinite(S.view.risk) ? S.view.risk : ""}" size="7">
    </p>
    <div class="meta" id="chainMeta" data-testid="chain-meta"></div>
    ${u ? `<p class="muted small">Lot size ${u.lotSize ?? "—"} (from today's instrument master${s.instruments.loadedAt ? `, loaded ${esc(istClock(s.instruments.loadedAt))}` : ""}).</p>` : ""}
  </section>
  <section id="sugs" class="sugs" aria-live="polite"></section>`;
  $("#nl").addEventListener("submit", (ev) => {
    ev.preventDefault();
    readSentence(String($<HTMLInputElement>("#nlText").value));
  });
  const onPill = () => {
    const [d, m] = $<HTMLSelectElement>("#pD").value.split("-") as [View["dir"], View["mode"]];
    const nu = $<HTMLSelectElement>("#pU").value;
    const changedU = nu !== S.view.underlying;
    S.view = {
      underlying: nu,
      dir: d,
      mode: m,
      level: Number(String($<HTMLInputElement>("#pL").value).replace(/[,₹\s]/g, "")),
      expiryDate: changedU ? (S.underlyings.find((x) => x.id === nu)?.expiries[0]?.date ?? "") : $<HTMLSelectElement>("#pE").value,
      risk: Number(String($<HTMLInputElement>("#pR").value).replace(/[,₹\s]/g, "")),
    };
    if (changedU) {
      S.chain = null;
      optionsView(root);
    }
    void loadChain();
  };
  root.querySelectorAll("#pU,#pD,#pE").forEach((x) => x.addEventListener("change", onPill));
  root.querySelectorAll("#pL,#pR").forEach((x) => x.addEventListener("change", onPill));
  void loadChain();
}

function readSentence(text: string): void {
  const known = S.underlyings.map((u) => u.id);
  const p = parseView(text, { known, expiriesFor: (u) => S.underlyings.find((x) => x.id === u)?.expiries ?? [], now: gwNow() });
  S.parsed = p;
  const v = { ...S.view };
  if (p.underlying) v.underlying = p.underlying;
  if (p.dir) v.dir = p.dir;
  if (p.mode) v.mode = p.mode;
  if (p.level !== null) v.level = p.level;
  if (p.expiryDate) v.expiryDate = p.expiryDate;
  else if (p.underlying) v.expiryDate = S.underlyings.find((x) => x.id === p.underlying)?.expiries[0]?.date ?? "";
  if (p.risk !== null) v.risk = p.risk;
  S.view = v;
  if (p.underlying !== S.chain?.underlying || v.expiryDate !== S.chain?.expiryDate) S.chain = null;
  optionsView($("#view"));
  const miss = p.missing.map((m) => ({ underlying: "which index or stock", direction: "up or down (e.g. 'stays above')", level: "the level", expiry: "which expiry", risk: "how much you're risking (₹)" })[m]);
  $("#nlNotes").innerHTML = [...(miss.length ? [`I couldn't find ${miss.join(", ")}. Set it in the sentence below.`] : []), ...p.notes].map((n) => `<p class="note">${esc(n)}</p>`).join("");
  $<HTMLInputElement>("#nlText").value = text;
}

let chainTimer = 0;
async function loadChain(): Promise<void> {
  clearTimeout(chainTimer);
  const v = S.view;
  const meta = $("#chainMeta");
  if (!v.underlying || !v.expiryDate) return renderSuggestions();
  try {
    S.chain = await api.get<Chain>(`/api/chain?u=${encodeURIComponent(v.underlying)}&expiry=${v.expiryDate}`);
    S.chainError = null;
  } catch (e) {
    S.chain = null;
    S.chainError = errText(e);
  }
  if (meta) {
    meta.innerHTML = S.chain
      ? `<span class="chip chip--green">Live</span> ${esc(S.underlyings.find((x) => x.id === v.underlying)?.label ?? v.underlying)} <b data-testid="spot">${num(S.chain.spot)}</b> · ${esc(S.chain.source)} · ${esc(istClock(S.chain.fetchedAt))}`
      : `<span class="chip chip--amber">Prices unavailable</span> ${esc(S.chainError ?? "")}`;
  }
  renderSuggestions();
  if (S.tab === "options" && !S.review) chainTimer = window.setTimeout(() => void loadChain(), 5000);
}

function complete(v: View): boolean {
  return Boolean(v.underlying && v.expiryDate && Number.isFinite(v.level) && v.level > 0 && Number.isFinite(v.risk) && v.risk > 0);
}

function renderSuggestions(): void {
  const box = $("#sugs");
  if (!box) return;
  const v = S.view;
  if (!complete(v)) {
    box.innerHTML = `<p class="muted">Fill in the level and how much you're risking to see trades.</p>`;
    return;
  }
  if (!S.chain) {
    box.innerHTML = `<p class="muted" data-testid="no-prices">No trades shown: ${esc(S.chainError ?? "waiting for live prices")}.</p>`;
    return;
  }
  const r = suggest(v, S.chain, { now: gwNow(), slippage: Math.min(0.02, S.session?.risk.maxSlippage ?? 0.02) });
  S.suggestions = r.suggestions;
  box.innerHTML = `<p class="canon">${esc(sentence(v))}</p>` +
    r.suggestions.map((sg, i) => card(sg, i === 0)).join("") +
    r.failures.map((f) => `<div class="card card--muted" data-testid="sug-fail"><b>${esc(f.kind.replace(/-/g, " "))}</b>: ${esc(describeFail(f.fail))}</div>`).join("");
  box.querySelectorAll<HTMLButtonElement>("[data-review]").forEach((b) => b.addEventListener("click", () => openReview(S.suggestions.find((x) => x.id === b.dataset.review)!)));
  for (const sg of r.suggestions) void loadMargin(sg);
}

function legLine(l: Suggestion["legs"][number], lotSize: number): string {
  return `<li><b class="${l.side === "BUY" ? "buy" : "sell"}">${l.side}</b> ${l.qty / lotSize} lot${l.qty / lotSize === 1 ? "" : "s"} (${l.qty}) ${esc(l.inst.symbol)} at ${inr2(l.price)} <span class="muted">· limit ${l.side === "BUY" ? "≤" : "≥"} ${inr2(l.limit)}</span></li>`;
}

function card(sg: Suggestion, best: boolean): string {
  return `<article class="card ${best ? "card--best" : ""}" data-testid="suggestion">
    <header><h3>${esc(sg.title)}</h3>${best ? `<span class="chip chip--dark">Best fit</span>` : ""}</header>
    <p>${esc(sg.plain)}</p>
    <ul class="legs">${sg.legs.map((l) => legLine(l, sg.lotSize)).join("")}</ul>
    <dl class="stats">
      <div><dt>Max profit</dt><dd class="up">${inr(sg.maxProfit)}</dd></div>
      <div><dt>Max loss</dt><dd class="dn" data-testid="max-loss">${inr(sg.maxLoss)}</dd></div>
      <div><dt>Breakeven</dt><dd>${num(sg.breakeven)}</dd></div>
      <div><dt>Chance of profit</dt><dd>${sg.probProfit === null ? "unavailable" : pct(sg.probProfit)}</dd></div>
      <div><dt>Charges (entry)</dt><dd>${inr2(sg.entryCharges.total)}</dd></div>
      <div><dt>Margin (broker)</dt><dd data-margin="${esc(sg.id)}">${esc(S.margins.get(sg.id) ?? "…")}</dd></div>
    </dl>
    ${sg.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join("")}
    <button class="btn btn--dark" data-review="${esc(sg.id)}">Review</button>
  </article>`;
}

async function loadMargin(sg: Suggestion): Promise<void> {
  const set = (t: string) => {
    S.margins.set(sg.id, t);
    document.querySelectorAll(`[data-margin="${CSS.escape(sg.id)}"]`).forEach((x) => (x.textContent = t));
  };
  try {
    const m = await api.post<{ final: number; required: number }>("/api/margin", { legs: sg.legs.map((l) => ({ key: l.inst.key, qty: l.qty, side: l.side, product: "D", price: l.price })) });
    set(`${inr(m.final)}${m.final < m.required ? ` (hedged; ${inr(m.required)} unhedged)` : ""}`);
  } catch (e) {
    set(`unavailable: ${errText(e)}`);
  }
}

// ── review & confirm ─────────────────────────────────────────────────
function chargesTable(c: ChargeBreakdown, broker: string): string {
  const rows = (Object.keys(CHARGE_LABELS) as (keyof typeof CHARGE_LABELS)[]).filter((k) => c[k] > 0 || k === "brokerage" || k === "stt").map((k) => `<tr><td>${CHARGE_LABELS[k]}</td><td>${inr2(c[k])}</td></tr>`).join("");
  return `<table class="tbl"><tbody>${rows}<tr class="tot"><td>Total (our calculation)</td><td data-testid="charges-total">${inr2(c.total)}</td></tr><tr><td>Broker's own figure</td><td data-testid="broker-charges">${esc(broker)}</td></tr></tbody></table>
    <p class="muted small">Schedule in force: ${esc(c.scheduleId)} (Upstox brokerage page, NSE/BSE circulars, Finance Act 2026 STT). The contract note is final.</p>`;
}

function payoffSvg(sg: Suggestion, spot: number): string {
  const ks = sg.legs.map((l) => l.inst.strike!);
  const lo = Math.min(...ks, spot) * 0.97, hi = Math.max(...ks, spot) * 1.03;
  const pts = payoffCurve(sg, lo, hi, 121);
  const W = 640, H = 200, P = 8;
  const maxY = Math.max(...pts.map((p) => p.pnl), 1), minY = Math.min(...pts.map((p) => p.pnl), -1);
  const x = (S: number) => P + ((S - lo) / (hi - lo)) * (W - 2 * P);
  const y = (v: number) => P + ((maxY - v) / (maxY - minY)) * (H - 2 * P);
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(p.S).toFixed(1)},${y(p.pnl).toFixed(1)}`).join("");
  return `<svg class="payoff" viewBox="0 0 ${W} ${H}" role="img" aria-label="Profit and loss at expiry">
    <line x1="${P}" x2="${W - P}" y1="${y(0)}" y2="${y(0)}" class="axis"/>
    <path d="${path}" class="curve"/>
    <line x1="${x(spot)}" x2="${x(spot)}" y1="${P}" y2="${H - P}" class="spot"/>
    <line x1="${x(sg.breakeven)}" x2="${x(sg.breakeven)}" y1="${P}" y2="${H - P}" class="be"/>
    <text x="${x(spot) + 4}" y="${P + 12}" class="lbl">now ${num(spot, 0)}</text>
    <text x="${x(sg.breakeven) + 4}" y="${H - P - 4}" class="lbl">breakeven ${num(sg.breakeven, 0)}</text>
  </svg>`;
}

function openReview(sg: Suggestion): void {
  S.review = sg;
  S.brokerCharges = null;
  clearTimeout(chainTimer);
  const s = S.session!;
  const live = S.mode === "live";
  const age = S.chain ? Math.max(0, gwNow() - S.chain.fetchedAt) : Infinity;
  const fresh = age <= (s.risk.quoteMaxAgeMs ?? 15000);
  const capHit = s.risk.perTradeCap != null && sg.worstMaxLoss > s.risk.perTradeCap;
  const sheet = $("#sheet");
  sheet.innerHTML = `
    <h2 data-testid="review-title">${esc(sg.title)} · ${live ? `<span class="chip chip--red">REAL MONEY</span>` : `<span class="chip chip--grey">PAPER</span>`}</h2>
    <p>${esc(sg.plain)}</p>
    ${payoffSvg(sg, S.chain?.spot ?? sg.breakeven)}
    <h3>Orders (buy leg first, then sell; IOC limit orders)</h3>
    <table class="tbl"><thead><tr><th>Side</th><th>Contract</th><th>Lots × size</th><th>Price now</th><th>Limit</th><th>Tick</th><th>Freeze</th><th>Orders</th></tr></thead><tbody>
      ${sg.legs.map((l) => `<tr><td class="${l.side === "BUY" ? "buy" : "sell"}">${l.side}</td><td>${esc(l.inst.symbol)}</td><td>${l.qty / sg.lotSize} × ${sg.lotSize}</td><td>${inr2(l.price)}</td><td>${inr2(l.limit)}</td><td>₹${(l.inst.tickPaise / 100).toFixed(2)}</td><td>${l.inst.freezeQty ?? "—"} (≤${Number.isFinite(maxPerOrder(l.inst)) ? maxPerOrder(l.inst) : "—"}/order)</td><td>${l.slices.length}</td></tr>`).join("")}
    </tbody></table>
    <dl class="stats">
      <div><dt>${sg.credit ? "Credit received" : "Debit paid"}</dt><dd>${inr(Math.abs(sg.netPerUnit) * sg.qty)}</dd></div>
      <div><dt>Max profit</dt><dd class="up">${inr(sg.maxProfit)}</dd></div>
      <div><dt>Max loss</dt><dd class="dn">${inr(sg.maxLoss)}</dd></div>
      <div><dt>Worst case incl. slippage + charges</dt><dd class="dn" data-testid="worst">${inr(sg.worstMaxLoss)}</dd></div>
      <div><dt>Breakeven at expiry</dt><dd>${num(sg.breakeven)}</dd></div>
      <div><dt>Chance of profit</dt><dd>${sg.probProfit === null ? "unavailable" : pct(sg.probProfit)}</dd></div>
      <div><dt>Margin (broker)</dt><dd>${esc(S.margins.get(sg.id) ?? "…")}</dd></div>
    </dl>
    <p class="muted small">Chance = risk-neutral probability from the option chain's implied volatility (lognormal, zero rates). It is not a forecast.</p>
    <h3>Charges to open</h3>
    <div id="chg">${chargesTable(sg.entryCharges, "checking…")}</div>
    <p class="muted small">Closing before expiry at today's prices would cost about ${inr2(sg.exitChargesIfClosed.total)} more. ${esc(sg.entryCharges.notes.join(" "))}</p>
    ${sg.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join("")}
    ${!fresh ? `<p class="err" data-testid="stale">Prices are ${Math.round(age / 1000)} s old. Refresh before placing.</p>` : ""}
    ${capHit ? `<p class="err">Above your per-trade cap of ${inr(s.risk.perTradeCap!)}.</p>` : ""}
    ${s.killSwitch ? `<p class="err">Kill switch is on: new trades are blocked.</p>` : ""}
    <form id="confirm" class="confirm">
      <label class="check"><input type="checkbox" id="agree" required> I understand I can lose up to ${inr(sg.worstMaxLoss)}.</label>
      ${live ? `<label>Type <b>${esc(s.confirmPhrase)}</b> to send a real order<input id="phrase" autocomplete="off" data-testid="phrase"></label>` : ""}
      <div class="row">
        <button type="button" class="btn" id="cancelReview">Back</button>
        <button type="button" class="btn" id="refresh">Refresh prices</button>
        <button type="submit" class="btn ${live ? "btn--red" : "btn--dark"}" id="go" data-testid="place" disabled>${live ? "Send real order" : "Place paper trade"}</button>
      </div>
    </form>
    <div id="result" aria-live="polite"></div>`;
  $("#scrim").hidden = false;
  const go = $<HTMLButtonElement>("#go");
  const gate = () => {
    const okPhrase = !live || $<HTMLInputElement>("#phrase").value.trim().toUpperCase() === s.confirmPhrase;
    go.disabled = !($<HTMLInputElement>("#agree").checked && okPhrase && fresh && !capHit && !s.killSwitch);
  };
  sheet.querySelectorAll("input").forEach((i) => i.addEventListener("input", gate));
  $("#cancelReview").addEventListener("click", closeReview);
  $("#refresh").addEventListener("click", async () => {
    await loadChain();
    const again = S.suggestions.find((x) => x.kind === sg.kind);
    if (again) openReview(again);
    else {
      closeReview();
      toast("That trade is no longer available at current prices", "err");
    }
  });
  $("#confirm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    go.disabled = true;
    go.textContent = "Placing…";
    try {
      const r = await api.post<{ paper: boolean; worstLoss: number; result: { status: string; matchedQty: number; legs: { inst: { symbol: string }; side: string; requested: number; filled: number; avgPrice: number | null; error?: string }[]; unwinds: { inst: { symbol: string }; side: string; qty: number; filled: number; error?: string }[]; residual: { inst: { symbol: string }; netQty: number }[] } }>("/api/trade/options", {
        mode: S.mode,
        legs: sg.legs.map((l) => ({ key: l.inst.key, side: l.side, qty: l.qty, limit: l.limit })),
        confirm: live ? $<HTMLInputElement>("#phrase").value : undefined,
        view: sentence(S.view),
      });
      const res = r.result;
      const head = { filled: "Filled", partial: "Partly filled", unwound: "Not filled: the bought leg was closed again", "nothing-filled": "Nothing filled", "needs-attention": "NEEDS ATTENTION: a leg could not be closed" }[res.status] ?? res.status;
      $("#result").innerHTML = `<div class="card ${res.status === "needs-attention" ? "card--red" : ""}" data-testid="result">
        <h3>${r.paper ? "Paper · " : ""}${esc(head)}</h3>
        <ul>${res.legs.map((l) => `<li>${esc(l.side)} ${esc(l.inst.symbol)}: ${l.filled}/${l.requested}${l.avgPrice ? ` @ ${inr2(l.avgPrice)}` : ""}${l.error ? ` · ${esc(l.error)}` : ""}</li>`).join("")}</ul>
        ${res.unwinds.map((u) => `<p class="warn">Unwind ${esc(u.side)} ${esc(u.inst.symbol)}: ${u.filled}/${u.qty}${u.error ? ` · ${esc(u.error)}` : ""}</p>`).join("")}
        ${res.residual.map((x) => `<p class="err">Open: ${esc(x.inst.symbol)} ${x.netQty > 0 ? "long" : "short"} ${Math.abs(x.netQty)}. Close it from Portfolio or the broker app.</p>`).join("")}
      </div>`;
      go.textContent = "Done";
    } catch (e) {
      $("#result").innerHTML = `<p class="err" data-testid="result-error">${esc(errText(e))}</p>`;
      go.textContent = live ? "Send real order" : "Place paper trade";
      gate();
    }
  });
  // broker's own charges for each leg (cross-check)
  void (async () => {
    try {
      let total = 0;
      for (const l of sg.legs) total += (await api.post<{ total: number }>("/api/charges/broker", { key: l.inst.key, qty: l.qty, side: l.side, product: "D", price: l.price })).total;
      $("#chg").innerHTML = chargesTable(sg.entryCharges, inr2(total));
    } catch (e) {
      $("#chg").innerHTML = chargesTable(sg.entryCharges, `unavailable: ${errText(e)}`);
    }
  })();
}

function closeReview(): void {
  S.review = null;
  $("#scrim").hidden = true;
  if (S.tab === "options") void loadChain();
}

// ── stocks ───────────────────────────────────────────────────────────
function stocksView(root: HTMLElement): void {
  root.innerHTML = `
  <section class="builder">
    <form id="eq" class="nl">
      <input id="eqText" aria-label="Stock order in plain English" placeholder="buy ₹20,000 of Reliance" autocomplete="off">
      <button class="btn btn--dark" type="submit">Read it</button>
    </form>
    <p class="muted small">Cash equity, delivery by default (say "intraday" for MIS). Always a limit order.</p>
    <div id="eqOut"></div>
  </section>`;
  $("#eq").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    await readEquity(String($<HTMLInputElement>("#eqText").value));
  });
}

async function readEquity(text: string): Promise<void> {
  const out = $("#eqOut");
  const p = parseEquity(text);
  if (p.missing.length) {
    out.innerHTML = `<p class="note">I need ${p.missing.map((m) => ({ side: "buy or sell", stock: "which stock", size: "how many shares or how many rupees" })[m]).join(", ")}.</p>`;
    return;
  }
  try {
    const found = (await api.get<{ results: Instrument[] }>(`/api/instruments/equity?q=${encodeURIComponent(p.query!)}`)).results;
    if (!found.length) {
      out.innerHTML = `<p class="note">No NSE stock matches "${esc(p.query!)}" in today's instrument master.</p>`;
      return;
    }
    const inst = found[0]!;
    let q: Quote | null = null;
    try {
      q = (await api.get<{ quotes: Record<string, Quote> }>(`/api/quotes?keys=${encodeURIComponent(inst.key)}`)).quotes[inst.key] ?? null;
    } catch (e) {
      out.innerHTML = `<p class="note">${esc(errText(e))}</p>`;
    }
    const t = equityTicket({ ...p, side: p.side! }, inst, q, gwNow());
    if ("fail" in t) {
      out.innerHTML += `<p class="err">${esc({ "no-quote": "No live quote, and you gave no limit price. Add 'at <price>' or log in to the broker.", "zero-qty": "That amount buys less than one share.", "bad-price": "That price isn't valid." }[t.fail])}</p>`;
      return;
    }
    S.ticket = t;
    const live = S.mode === "live";
    out.innerHTML = `<article class="card" data-testid="eq-ticket">
      <h3>${t.side === "BUY" ? "Buy" : "Sell"} ${t.qty} ${esc(inst.symbol)} <span class="muted">(${esc(inst.name)}, ${inst.exchange})</span></h3>
      <dl class="stats">
        <div><dt>Limit price</dt><dd>${inr2(t.limit)}</dd></div>
        <div><dt>Last / ${t.side === "BUY" ? "offer" : "bid"}</dt><dd>${q?.ltp ? inr2(q.ltp) : "—"} / ${t.touch ? inr2(t.touch) : "—"}</dd></div>
        <div><dt>Order value</dt><dd>${inr(t.value)}</dd></div>
        <div><dt>Product</dt><dd>${t.product === "I" ? "Intraday" : "Delivery"}</dd></div>
        <div><dt>Charges</dt><dd>${inr2(t.charges.total)}</dd></div>
      </dl>
      ${t.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join("")}
      ${chargesTable(t.charges, "—")}
      <form id="eqGo" class="confirm">
        ${live ? `<label>Type <b>${esc(S.session!.confirmPhrase)}</b><input id="eqPhrase" autocomplete="off"></label>` : ""}
        <button class="btn ${live ? "btn--red" : "btn--dark"}" type="submit">${live ? "Send real order" : "Place paper order"}</button>
      </form>
      <div id="eqRes"></div>
    </article>`;
    $("#eqGo").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      try {
        const r = await api.post<{ placed: boolean; message?: string; status?: { state: string; filled: number } }>("/api/trade/equity", { mode: S.mode, key: inst.key, side: t.side, qty: t.qty, limit: t.limit, product: t.product, confirm: live ? $<HTMLInputElement>("#eqPhrase").value : undefined });
        $("#eqRes").innerHTML = r.placed ? `<p class="ok">${S.mode === "paper" ? "Paper order" : "Order"} placed: ${esc(r.status?.state ?? "")} (${r.status?.filled ?? 0} filled).</p>` : `<p class="err">${esc(r.message ?? "Not placed")}</p>`;
      } catch (e) {
        $("#eqRes").innerHTML = `<p class="err">${esc(errText(e))}</p>`;
      }
    });
  } catch (e) {
    out.innerHTML = `<p class="err">${esc(errText(e))}</p>`;
  }
}

// ── portfolio / orders ───────────────────────────────────────────────
async function portfolioView(root: HTMLElement): Promise<void> {
  root.innerHTML = `<p class="muted">Loading ${S.mode} portfolio…</p>`;
  try {
    const p = await api.get<{ paper: boolean; positions: { symbol: string; qty: number; avgPrice: number | null; ltp: number | null; pnl: number | null }[]; holdings: { symbol: string; qty: number; avgPrice: number | null; ltp: number | null; pnl: number | null }[]; funds: { available: number | null } | null; pnl: number | null; note?: string | null }>(`/api/portfolio?mode=${S.mode}`);
    root.innerHTML = `
      <h2>${p.paper ? "Paper portfolio" : "Portfolio"} ${p.pnl !== null ? `<span class="${p.pnl >= 0 ? "up" : "dn"}" data-testid="pnl">${signedInr(p.pnl)}</span>` : `<span class="muted small">P&L unavailable</span>`}</h2>
      ${p.note ? `<p class="note">${esc(p.note)}</p>` : ""}
      ${p.funds ? `<p>Available to trade: <b>${p.funds.available !== null ? inr(p.funds.available) : "—"}</b></p>` : ""}
      <h3>Positions</h3>
      ${table(["Contract", "Qty", "Avg", "LTP", "P&L"], p.positions.map((x) => [esc(x.symbol), String(x.qty), x.avgPrice ? inr2(x.avgPrice) : "—", x.ltp ? inr2(x.ltp) : "—", x.pnl === null ? "—" : signedInr(x.pnl)]), "positions")}
      ${p.paper ? `<button class="btn" id="resetPaper">Reset paper book</button>` : `<h3>Holdings</h3>${table(["Stock", "Qty", "Avg", "LTP", "P&L"], p.holdings.map((x) => [esc(x.symbol), String(x.qty), x.avgPrice ? inr2(x.avgPrice) : "—", x.ltp ? inr2(x.ltp) : "—", x.pnl === null ? "—" : signedInr(x.pnl)]), "holdings")}`}`;
    $("#resetPaper")?.addEventListener("click", async () => {
      await api.post("/api/paper/reset");
      void portfolioView(root);
    });
  } catch (e) {
    root.innerHTML = `<p class="err">${esc(errText(e))}</p>`;
  }
}

function table(head: string[], rows: string[][], id: string): string {
  if (!rows.length) return `<p class="muted" data-testid="${id}-empty">None.</p>`;
  return `<table class="tbl" data-testid="${id}"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

async function ordersView(root: HTMLElement): Promise<void> {
  root.innerHTML = `<p class="muted">Loading orders…</p>`;
  try {
    const [o, t] = await Promise.all([api.get<{ paper: boolean; orders: Record<string, unknown>[] }>(`/api/orders?mode=${S.mode}`), api.get<{ trades: Record<string, unknown>[] }>(`/api/trades?mode=${S.mode}`)]);
    const rows = o.orders.map((x) => {
      const id = String(x.orderId ?? x.id);
      const state = String(x.state ?? x.status);
      return [esc(id), esc(String(x.symbol)), esc(String(x.side)), `${x.filled ?? 0}/${x.qty}`, inr2(Number(x.price ?? x.limit)), esc(state), state === "open" ? `<button class="btn btn--sm" data-cancel="${esc(id)}">Cancel</button>` : ""];
    });
    root.innerHTML = `<h2>${o.paper ? "Paper orders" : "Order book"}</h2>${table(["Order", "Contract", "Side", "Filled", "Price", "Status", ""], rows, "orders")}
      <h3>Trades today</h3>${table(["Trade", "Contract", "Side", "Qty", "Price"], t.trades.map((x) => [esc(String(x.tradeId)), esc(String(x.symbol)), esc(String(x.side)), String(x.qty), x.price ? inr2(Number(x.price)) : "—"]), "trades")}`;
    root.querySelectorAll<HTMLButtonElement>("[data-cancel]").forEach((b) =>
      b.addEventListener("click", async () => {
        await api.post("/api/orders/cancel", { mode: S.mode, orderId: b.dataset.cancel });
        void ordersView(root);
      }),
    );
  } catch (e) {
    root.innerHTML = `<p class="err">${esc(errText(e))}</p>`;
  }
}

// ── safety ───────────────────────────────────────────────────────────
async function safetyView(root: HTMLElement): Promise<void> {
  await refreshSession().catch(() => {});
  const s = S.session!;
  let audit: { seq: number; ts: number; type: string }[] = [];
  let brokers: { id: string; name: string; status: string; docs: string }[] = [];
  try {
    audit = (await api.get<{ entries: typeof audit }>("/api/audit?limit=30")).entries;
    brokers = (await api.get<{ brokers: typeof brokers }>("/api/brokers")).brokers;
  } catch {
    /* shown empty */
  }
  root.innerHTML = `
  <section class="card">
    <h2>Kill switches</h2>
    <label class="check"><input type="checkbox" id="ks" ${s.killSwitch ? "checked" : ""} data-testid="kill-toggle"> Kill switch: block every new trade (exits still allowed)</label>
    <div class="row">
      <button class="btn" id="cancelAll" data-testid="cancel-all">Cancel all open orders (${S.mode})</button>
    </div>
    <form id="exitAll" class="row">
      <input id="exitPhrase" placeholder="type EXIT ALL" aria-label="Type EXIT ALL" data-testid="exit-phrase">
      <button class="btn btn--red" type="submit" data-testid="exit-all">Exit all positions (${S.mode})</button>
    </form>
    <p class="muted small">Exit all cancels open orders, then closes each F&O/intraday position with protective IOC limit orders (never market orders). Delivery holdings are left alone.</p>
    <div id="killRes"></div>
  </section>
  <section class="card">
    <h2>Limits (optional, off by default)</h2>
    <form id="caps" class="grid2">
      <label>Max loss per trade (₹)<input id="cap1" inputmode="decimal" placeholder="off" value="${s.risk.perTradeCap ?? ""}" data-testid="cap-trade"></label>
      <label>Daily loss cap (₹)<input id="cap2" inputmode="decimal" placeholder="off" value="${s.risk.dailyLossCap ?? ""}" data-testid="cap-day"></label>
      <button class="btn btn--dark" type="submit">Save</button>
    </form>
    <p class="muted small">Enforced by the gateway on every order. Also enforced: limit orders only, ≤ ${s.risk.maxOrdersPerSecond} orders/second (SEBI's retail threshold is 10), price within ${(s.risk.maxSlippage * 100).toFixed(0)}% of the live quote, market hours from the official holiday list.</p>
  </section>
  <section class="card">
    <h2>Broker</h2>
    <p>${esc(s.broker.name)}: ${s.broker.loggedIn ? `logged in as ${esc(s.broker.userId ?? "")} until ${s.broker.expiresAt ? esc(istClock(s.broker.expiresAt)) : "?"} (Upstox tokens end at 03:30 IST daily)` : "not logged in"}</p>
    <div class="row">
      <button class="btn btn--dark" id="bLogin">Log in to ${esc(s.broker.name)}</button>
      <button class="btn" id="bRequest">Send login request to my phone</button>
      ${s.broker.loggedIn ? `<button class="btn" id="bLogout">Log out of broker</button>` : ""}
    </div>
    <p class="muted small">Your broker password, PIN and TOTP are typed only on ${esc(s.broker.name)}'s own page. The gateway keeps the daily access token (encrypted at rest) and the API secret (environment variable).</p>
    ${table(["Broker", "Status", "Docs"], brokers.map((b) => [esc(b.name), b.status === "implemented" ? "implemented" : `<span class="muted">not implemented</span>`, `<a href="${esc(b.docs)}" rel="noopener" target="_blank">docs</a>`]), "brokers")}
  </section>
  <section class="card">
    <h2>Audit log</h2>
    ${table(["#", "Time", "Event"], audit.map((a) => [String(a.seq), `${esc(longDate(istDate(a.ts)))} ${esc(istClock(a.ts))}`, esc(a.type)]), "audit")}
  </section>`;
  $<HTMLInputElement>("#ks").addEventListener("change", async (ev) => {
    await api.post("/api/kill/switch", { on: (ev.target as HTMLInputElement).checked });
    await refreshSession();
    toast((ev.target as HTMLInputElement).checked ? "Kill switch ON" : "Kill switch off");
  });
  $("#cancelAll").addEventListener("click", async () => {
    try {
      const r = await api.post<{ cancelled: unknown }>("/api/kill/cancel-all", { mode: S.mode });
      $("#killRes").innerHTML = `<p class="ok">Cancelled: ${esc(Array.isArray(r.cancelled) ? String(r.cancelled.length) : String(r.cancelled))}</p>`;
    } catch (e) {
      $("#killRes").innerHTML = `<p class="err">${esc(errText(e))}</p>`;
    }
  });
  $("#exitAll").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      const r = await api.post<{ results: { inst: { symbol: string }; qty: number; filled: number; error?: string }[]; skipped: { key: string; reason: string }[] }>("/api/kill/exit-all", { mode: S.mode, confirm: $<HTMLInputElement>("#exitPhrase").value });
      $("#killRes").innerHTML = `<div data-testid="exit-result">${r.results.map((x) => `<p class="${x.error ? "err" : "ok"}">${esc(x.inst.symbol)}: closed ${x.filled}/${x.qty}${x.error ? ` · ${esc(x.error)}` : ""}</p>`).join("") || `<p class="muted">No open positions.</p>`}${r.skipped.map((x) => `<p class="muted small">${esc(x.key)}: ${esc(x.reason)}</p>`).join("")}</div>`;
    } catch (e) {
      $("#killRes").innerHTML = `<p class="err">${esc(errText(e))}</p>`;
    }
  });
  $("#caps").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    await api.put("/api/risk", { perTradeCap: $<HTMLInputElement>("#cap1").value, dailyLossCap: $<HTMLInputElement>("#cap2").value });
    await refreshSession();
    toast("Limits saved");
  });
  $("#bLogin").addEventListener("click", brokerLogin);
  $("#bRequest").addEventListener("click", async () => {
    try {
      await api.post("/auth/broker/request");
      toast("Request sent: approve it in the Upstox app or on WhatsApp");
    } catch (e) {
      toast(errText(e), "err");
    }
  });
  $("#bLogout")?.addEventListener("click", async () => {
    await api.post("/auth/broker/logout");
    await refreshSession();
    void safetyView(root);
  });
}

// session upkeep: market status, token expiry, kill switch
window.setInterval(() => {
  if (api.token && S.session) void refreshSession().catch(() => {});
}, 30_000);

void boot();
