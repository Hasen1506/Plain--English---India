// Plain English India — the static frontend. It talks to the user's own gateway, or, in
// DEMO mode, to an in-browser stand-in that serves the recorded public fixtures (always
// labelled, paper only). Every price, lot size and expiry on screen comes from one of
// those; when something is not available the UI says so instead of showing a number.

import "./styles.css";
import { api, ApiError, defaultGateway } from "./api.ts";
import { ICON, sparkline, countTo, morph, placePopover, dismissable, ring, reducedMotion } from "./ui.ts";
import { escapeHtml as esc, inr, inr2, num, pct, signedInr, parseRupees } from "../src/core/money.ts";
import { istClock, shortDate, dayDiff, istDate, longDate } from "../src/core/ist.ts";
import { parseView, sentence, type ParsedView } from "../src/core/sentence.ts";
import { suggest, describeFail, payoffCurve, legsPayoff, type Suggestion, type View, type Kind } from "../src/core/strategy.ts";
import { CHARGE_LABELS, type ChargeBreakdown } from "../src/core/charges.ts";
import { parseEquity, equityTicket, type EquityTicket, type ParsedEquity } from "../src/core/equity.ts";
import { smile, ivAt, strikeStep, type Chain, type Quote } from "../src/core/chain.ts";
import { probAbove, yearsTo } from "../src/core/math.ts";
import type { ExpiryInfo, Instrument } from "../src/core/instruments.ts";
import { maxPerOrder } from "../src/core/rules.ts";

const DEMO_LABEL = "DEMO · recorded prices from 8 Oct 2026 · no broker, no orders";

// ── state ────────────────────────────────────────────────────────────
interface Underlying { id: string; label: string; index: boolean; exchange: string; lotSize: number | null; spotKey: string | null; expiries: ExpiryInfo[] }
interface MarketS { exchange: string; market: string; state: string; canTrade: boolean; label: string; opensAt: number | null }
interface Session {
  now: number;
  demo?: boolean;
  broker: { id: string; name: string; sandbox: boolean; loggedIn: boolean; userId: string | null; userName: string | null; expiresAt: number | null; approvalPendingUntil: number | null };
  liveTrading: boolean;
  killSwitch: boolean;
  risk: { perTradeCap: number | null; dailyLossCap: number | null; maxSlippage: number; quoteMaxAgeMs: number; maxOrdersPerSecond: number };
  instruments: { count: number; loadedAt?: number; error?: string };
  holidays: { source?: string; error?: string };
  markets: MarketS[];
  confirmPhrase: string;
}
interface Spot { ltp: number | null; changePct: number | null; spark: number[] | null }
type Tab = "options" | "stocks" | "portfolio" | "orders" | "safety";
type PopKey = "u" | "d" | "l" | "e" | "r" | "eside" | "esize" | "estock" | "eprod";

const S = {
  session: null as Session | null,
  demo: false,
  clockSkew: 0, // gateway now − browser now
  mode: "paper" as "paper" | "live",
  tab: "options" as Tab,
  underlyings: [] as Underlying[],
  view: { underlying: "NIFTY", dir: "above", mode: "stays", level: NaN, expiryDate: "", risk: 5000 } as View,
  parsed: null as ParsedView | null,
  chain: null as Chain | null,
  chainError: null as string | null,
  chains: new Map<string, Chain | string>(), // u:expiry → chain or the reason it is unavailable (expiry chances)
  suggestions: [] as Suggestion[],
  pick: null as Kind | null,
  margins: new Map<string, string>(),
  review: null as Suggestion | null,
  spots: new Map<string, Spot>(),
  spotsNote: "",
  spotsAt: 0,
  pop: null as PopKey | null,
  eq: { side: "BUY" as "BUY" | "SELL", by: "amount" as "amount" | "qty", amount: 20000, qty: 10, symbol: "RELIANCE", name: "Reliance", product: "D" as "D" | "I", price: null as number | null },
  ticket: null as EquityTicket | null,
};
const gwNow = (): number => Date.now() + S.clockSkew;

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T => root.querySelector(sel) as T;
const app = document.getElementById("app")!;
const errText = (e: unknown): string => (e instanceof ApiError ? e.message : (e as Error).message);
const shortD = (d: string): string => shortDate(d).replace(",", "");

function toast(msg: string, kind: "ok" | "err" = "ok"): void {
  const t = $("#toast");
  if (!t) return;
  t.textContent = msg;
  t.className = `x-toast x-toast--${kind}`;
  t.hidden = false;
  clearTimeout((t as unknown as { _t?: number })._t);
  (t as unknown as { _t?: number })._t = window.setTimeout(() => (t.hidden = true), 5000);
}

// ── shell: floating top pill, status chips, view, dock ───────────────
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "options", label: "Options", icon: ICON.trend },
  { id: "stocks", label: "Stocks", icon: ICON.bag },
  { id: "portfolio", label: "Portfolio", icon: ICON.pie },
  { id: "orders", label: "Orders", icon: ICON.list },
  { id: "safety", label: "Safety", icon: ICON.shield },
];

function shell(): void {
  document.body.classList.add("x-app");
  app.innerHTML = `
  ${S.demo ? `<div class="x-demo" data-testid="demo-bar" role="note"><span><b>DEMO</b> · recorded prices from 8 Oct 2026 · no broker, no orders</span><button type="button" id="exitDemo">Exit demo</button></div>` : ""}
  <div class="x-root">
    <header class="x-top">
      <div id="brokerSlot" class="x-topbar"></div>
      <div class="x-status" id="chips"></div>
    </header>
    <main id="view"></main>
  </div>
  <nav class="x-dock" aria-label="Sections">
    <div class="x-tabs" role="tablist">
      ${TABS.map((t) => `<button type="button" class="x-ic" role="tab" data-tab="${t.id}" aria-label="${t.label}" title="${t.label}" aria-selected="${S.tab === t.id}">${t.icon}<span class="x-ic__l">${t.label}</span></button>`).join("")}
    </div>
    <span class="x-sep" id="dockSep" hidden></span>
    <button type="button" class="x-buy" id="primary" data-testid="dock-primary" hidden></button>
  </nav>
  <div class="x-toast" id="toast" hidden role="status"></div>`;
  app.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab as Tab)));
  $("#exitDemo")?.addEventListener("click", exitDemo);
  $("#primary").addEventListener("click", () => {
    const sg = chosen();
    if (S.tab === "options" && !S.review && sg) openReview(sg);
  });
}

function setTab(t: Tab): void {
  closePop();
  S.tab = t;
  if (t !== "options") S.review = null;
  app.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-selected", String((x as HTMLElement).dataset.tab === t)));
  render();
}

function dock(): void {
  const b = $<HTMLButtonElement>("#primary"), sep = $("#dockSep");
  if (!b) return;
  const show = S.tab === "options" && !S.review;
  b.hidden = sep.hidden = !show;
  if (!show) return;
  const sg = chosen();
  b.disabled = !sg;
  b.innerHTML = sg ? `<span>Review for <b id="dockAmt">${inr(sg.worstMaxLoss)}</b></span><span class="x-arr">${ICON.arrow}</span>` : `<span>Review</span><span class="x-arr">${ICON.arrow}</span>`;
}

function chips(): void {
  const s = S.session;
  const slot = $("#brokerSlot"), el = $("#chips");
  if (!slot || !el) return;
  document.body.classList.toggle("is-live", S.mode === "live");
  if (!s) {
    slot.innerHTML = `<span class="x-bal">Not connected</span>`;
    el.innerHTML = "";
    return;
  }
  const b = s.broker;
  if (S.demo) slot.innerHTML = `<span class="x-bal" data-testid="broker-chip"><i class="x-dot x-dot--demo"></i><span class="x-bal__t"><span>Demo · no broker</span><small>paper only</small></span><span class="x-av" aria-hidden="true">D</span></span>`;
  else if (b.loggedIn) slot.innerHTML = `<span class="x-bal" data-testid="broker-chip"><i class="x-dot"></i><span class="x-bal__t"><span>${esc(b.name)}${b.sandbox ? " sandbox" : ""} · ${esc(b.userId ?? "")}</span><small>till ${b.expiresAt ? esc(istClock(b.expiresAt)) : "?"}</small></span><span class="x-av" aria-hidden="true">${esc((b.userName ?? b.userId ?? "U").slice(0, 1).toUpperCase())}</span></span>`;
  else slot.innerHTML = `<button type="button" class="x-bal x-bal--login" id="brokerLogin" data-testid="broker-chip"><i class="x-dot x-dot--off"></i><span class="x-bal__t"><span>Log in to ${esc(b.name)}</span><small>for live prices</small></span><span class="x-arr">${ICON.arrow}</span></button>`;
  const fo = s.markets.find((m) => m.exchange === "NSE" && m.market === "FO");
  const mk = fo
    ? `<span class="x-chip ${S.demo ? "x-chip--demo" : fo.canTrade ? "x-chip--ok" : ""}" data-testid="market-chip" title="${esc(s.holidays.source ?? "")}">${esc(fo.label)}${!S.demo && !fo.canTrade && fo.opensAt ? ` · opens ${esc(shortDate(istDate(fo.opensAt)))} ${esc(istClock(fo.opensAt))}` : ""}</span>`
    : `<span class="x-chip x-chip--amber" data-testid="market-chip">Market hours unknown</span>`;
  const liveOk = s.liveTrading && b.loggedIn && !S.demo;
  const modeSeg = `<span class="x-seg" role="group" aria-label="Trading mode">
      <button type="button" data-mode="paper" aria-pressed="${S.mode === "paper"}">Paper</button>
      <button type="button" data-mode="live" aria-pressed="${S.mode === "live"}" ${liveOk ? "" : `disabled title="${S.demo ? "The demo is paper only" : s.liveTrading ? "Log in to the broker first" : "Live trading is disabled on your gateway (LIVE_TRADING_ENABLED)"}"`}>Live</button>
    </span>`;
  const badge = S.mode === "live"
    ? `<span class="x-chip x-chip--live" data-testid="live-banner">LIVE · real money · orders go to ${esc(b.name)}</span>`
    : `<span class="x-chip x-chip--paper" data-testid="paper-banner" title="Simulated fills; nothing is sent to the broker">PAPER · ${S.demo ? "recorded prices, no orders" : "nothing is sent to the broker"}</span>`;
  const ks = s.killSwitch ? `<span class="x-chip x-chip--red" data-testid="kill-chip">Kill switch ON</span>` : "";
  el.innerHTML = mk + modeSeg + badge + ks;
  $("#brokerLogin", slot)?.addEventListener("click", brokerLogin);
  el.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((x) =>
    x.addEventListener("click", () => {
      S.mode = x.dataset.mode as "paper" | "live";
      chips();
      if (S.review) openReview(S.review);
      else render();
    }),
  );
}

async function brokerLogin(): Promise<void> {
  try {
    const r = await api.get<{ url: string }>("/auth/broker/login");
    location.href = r.url; // Upstox login page → gateway callback → back here
  } catch (e) {
    toast(errText(e), "err");
  }
}

// ── sign in / gateway screen ─────────────────────────────────────────
function connectView(msg = ""): void {
  document.body.classList.add("x-app");
  app.innerHTML = `
  <div class="x-gate">
    <div class="x-gate__brand"><span class="x-logo" aria-hidden="true">₹</span>Plain English <b>India</b></div>
    <h1 class="x-gate__h">Say what you think <mark class="x-lav">Nifty</mark> will do. Get a <mark class="x-mint">defined‑risk</mark> trade on <mark class="x-amt">your own</mark> broker.</h1>
    <div class="x-gate__grid">
      <form id="connect" class="x-card x-gate__card" autocomplete="on">
        <h2>Sign in to your gateway</h2>
        <label for="gwUrl">Your gateway URL</label>
        <input id="gwUrl" class="x-in" name="url" required placeholder="https://gateway.example.in" value="${esc(defaultGateway())}" autocomplete="url">
        <label for="gwPass">Gateway passphrase</label>
        <input id="gwPass" class="x-in" name="pass" type="password" required autocomplete="current-password">
        <button class="x-buy x-wide" type="submit"><span>Sign in</span><span class="x-arr">${ICON.arrow}</span></button>
        ${msg ? `<p class="x-err" role="alert">${esc(msg)}</p>` : ""}
        <p class="x-fine">The gateway is the small server you run on a static-IP VPS (SEBI requires API orders to come from a whitelisted static IP). Your broker password, PIN and TOTP are only ever typed on the broker's own login page.</p>
      </form>
      <div class="x-card x-gate__demo">
        <span class="x-chip x-chip--demo">DEMO</span>
        <h2>No gateway yet?</h2>
        <p>Try the full app on prices recorded from NSE on <b>Thu 8 Oct 2026, 10:39 IST</b>. No broker, no orders, paper trades only.</p>
        <button type="button" class="x-buy x-wide x-buy--light" id="tryDemo" data-testid="try-demo"><span>Try the demo</span><span class="x-arr">${ICON.play}</span></button>
        <p class="x-fine">${DEMO_LABEL}</p>
      </div>
    </div>
    <p class="x-foot">Defined-risk spreads only · limit orders only · kill switch and Exit all always on hand.</p>
  </div>`;
  $("#tryDemo").addEventListener("click", () => void startDemo());
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

async function startDemo(): Promise<void> {
  app.innerHTML = `<div class="x-gate"><p class="x-loading">Loading the recorded 8 Oct 2026 prices…</p></div>`;
  try {
    const { createDemo } = await import("./demo.ts");
    const d = await createDemo();
    api.demo = d.handle;
    S.demo = true;
    S.mode = "paper";
    sessionStorage.setItem("pei.demo", "1");
    S.view = { underlying: "NIFTY", dir: "above", mode: "stays", level: 22300, expiryDate: "2026-10-13", risk: 5000 };
    await boot();
  } catch (e) {
    connectView(`Demo failed to load: ${errText(e)}`);
  }
}

function exitDemo(): void {
  sessionStorage.removeItem("pei.demo");
  api.demo = null;
  S.demo = false;
  S.session = null;
  S.chain = null;
  S.chains.clear();
  S.spots.clear();
  S.review = null;
  history.replaceState(null, "", location.pathname);
  connectView();
}

async function refreshSession(): Promise<void> {
  const s = await api.get<Session>("/api/session");
  if (S.session && S.session.broker.loggedIn !== s.broker.loggedIn) {
    // broker logged in or out: drop prices fetched under the old state
    S.spots.clear();
    S.spotsAt = 0;
    S.chains.clear();
  }
  S.session = s;
  S.clockSkew = s.now - Date.now();
  if (S.mode === "live" && !(s.liveTrading && s.broker.loggedIn && !S.demo)) S.mode = "paper";
  chips();
}

async function boot(): Promise<void> {
  if (!api.demo && sessionStorage.getItem("pei.demo") === "1") return startDemo();
  if (!api.demo && /(^|[#&?])demo\b/.test(location.hash + location.search)) return startDemo();
  if (!api.demo && (!api.token || !api.base)) return connectView();
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
    if (u) S.view = { ...S.view, underlying: u.id, expiryDate: u.expiries.some((e) => e.date === S.view.expiryDate) ? S.view.expiryDate : (u.expiries[0]?.date ?? "") };
    render();
    void loadSpots();
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 0)) return connectView(errText(e));
    toast(errText(e), "err");
  }
}

// ── views ────────────────────────────────────────────────────────────
function render(): void {
  const v = $("#view");
  if (!v) return;
  v.classList.remove("x-enter");
  void v.offsetWidth;
  v.classList.add("x-enter");
  if (S.tab === "options") {
    if (S.review) openReview(S.review);
    else optionsView(v);
  } else if (S.tab === "stocks") stocksView(v);
  else if (S.tab === "portfolio") void portfolioView(v);
  else if (S.tab === "orders") void ordersView(v);
  else void safetyView(v);
  dock();
}

const DIRS: { d: View["dir"]; m: View["mode"]; label: string; desc: string }[] = [
  { d: "above", m: "stays", label: "stays above", desc: "Profit if it settles above the level on expiry" },
  { d: "above", m: "reaches", label: "goes above", desc: "Bigger payout if it rises to the level" },
  { d: "below", m: "stays", label: "stays below", desc: "Profit if it settles below the level on expiry" },
  { d: "below", m: "reaches", label: "falls below", desc: "Bigger payout if it falls to the level" },
];
const dirLabel = (v: Pick<View, "dir" | "mode">): string => DIRS.find((x) => x.d === v.dir && x.m === v.mode)!.label;
const underlyingLabel = (id: string): string => S.underlyings.find((x) => x.id === id)?.label ?? id;
const curU = (): Underlying | undefined => S.underlyings.find((x) => x.id === S.view.underlying);

function expiryMeta(e: ExpiryInfo): string {
  const d = dayDiff(istDate(gwNow()), e.date);
  return `${d === 0 ? "today" : `${d} day${d === 1 ? "" : "s"}`} · ${e.kind}`;
}

/** Risk-neutral chance the underlying settles beyond `level` (from the chain's IV smile), or null. */
function chanceAt(chain: Chain | null, level: number, dir: View["dir"]): number | null {
  if (!chain || !Number.isFinite(level) || level <= 0) return null;
  const T = yearsTo(chain.expiryMs, gwNow());
  const iv = ivAt(smile(chain, gwNow()), level);
  if (iv === null || !(T > 0)) return null;
  const p = probAbove(chain.spot, level, T, iv);
  return dir === "above" ? p : 1 - p;
}

function pillHtml(k: "u" | "d" | "l" | "e" | "r"): string {
  const v = S.view;
  if (k === "u") return `<span>${esc(underlyingLabel(v.underlying) || "—")}</span>${ICON.chev}`;
  if (k === "d") return `<span>${dirLabel(v)}</span>${ICON.chev}`;
  if (k === "l") {
    if (!Number.isFinite(v.level)) return `<span class="x-ph">level</span>${ICON.chev}`;
    const sp = S.chain?.spot;
    const d = sp ? (v.level / sp - 1) * 100 : null;
    return `<span>${num(v.level, 0)}</span>${d !== null ? `<span class="x-pct ${d < 0 ? "is-down" : ""}">${d >= 0 ? "↑" : "↓"}${Math.abs(d).toFixed(1)}%</span>` : ""}${ICON.chev}`;
  }
  if (k === "e") return v.expiryDate ? `<span>${esc(shortD(v.expiryDate))}</span>${ICON.chev}` : `<span class="x-ph">expiry</span>${ICON.chev}`;
  return Number.isFinite(v.risk) && v.risk > 0 ? `<span>${inr(v.risk)}</span>${ICON.chev}` : `<span class="x-ph">₹ amount</span>${ICON.chev}`;
}

const PILL_META: Record<"u" | "d" | "l" | "e" | "r", { cls: string; label: string }> = {
  u: { cls: "x-lav", label: "Underlying" },
  d: { cls: "x-sal", label: "Direction" },
  l: { cls: "x-mint", label: "Level" },
  e: { cls: "x-lav", label: "Expiry" },
  r: { cls: "x-amt", label: "Amount you are risking in rupees" },
};
const pill = (k: "u" | "d" | "l" | "e" | "r"): string => `<button type="button" class="x-pill ${PILL_META[k].cls}" id="p_${k}" data-pop="${k}" aria-haspopup="dialog" aria-expanded="false" aria-label="${PILL_META[k].label}">${pillHtml(k)}</button>`;

function optionsView(root: HTMLElement): void {
  root.innerHTML = `
  <section class="x-builder" id="builder">
    <div class="x-tags"><span class="x-tag x-tag--dark" id="kindTag">Defined-risk spread</span><span class="x-tag" id="chainMeta" data-testid="chain-meta">…</span></div>
    <p class="x-sent" data-testid="sentence">I think ${pill("u")} ${pill("d")} ${pill("l")} by ${pill("e")}, risking ${pill("r")}</p>
    <div class="x-quote" id="quote" aria-live="polite"></div>
    <div id="sugs" class="x-sugs"></div>
    <div id="nlNotes" class="x-notes-box"></div>
    <form id="nl" class="x-nl">
      <input id="nlText" aria-label="Your view in plain English" placeholder="Or type it: Nifty stays above 25,000 till Tuesday, risking ₹5,000" autocomplete="off">
      <button class="x-edit" type="submit">Read it</button>
    </form>
    <div class="x-pop" id="pop" role="dialog" hidden></div>
  </section>`;
  $("#nl").addEventListener("submit", (ev) => {
    ev.preventDefault();
    readSentence(String($<HTMLInputElement>("#nlText").value));
  });
  root.querySelectorAll<HTMLButtonElement>("[data-pop]").forEach((b) => b.addEventListener("click", () => togglePop(b.dataset.pop as PopKey, b)));
  metaTag();
  renderSuggestions();
  void loadChain();
}

function refreshPills(): void {
  for (const k of ["u", "d", "l", "e", "r"] as const) morph($(`#p_${k}`), pillHtml(k));
}

function metaTag(): void {
  const meta = $("#chainMeta");
  if (!meta) return;
  const v = S.view;
  if (S.chain) {
    meta.className = `x-tag ${S.demo ? "is-demo" : ""}`;
    meta.innerHTML = S.demo
      ? `<b class="x-dot-demo">●</b> Recorded · ${esc(underlyingLabel(v.underlying))} <b data-testid="spot">${num(S.chain.spot)}</b> · 8 Oct 2026, 10:39 IST`
      : `<b>●</b> Live · ${esc(underlyingLabel(v.underlying))} <b data-testid="spot">${num(S.chain.spot)}</b><span class="x-hide-s"> · ${esc(S.chain.source)}</span> · ${esc(istClock(S.chain.fetchedAt))}`;
  } else if (S.chainError) {
    meta.className = "x-tag is-amber";
    meta.innerHTML = `<b>●</b> Prices unavailable · ${esc(S.chainError)}`;
  } else {
    meta.className = "x-tag is-sim";
    meta.innerHTML = `<b>●</b> Loading prices…`;
  }
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
  else if (p.underlying && p.underlying !== S.view.underlying) v.level = NaN;
  if (p.expiryDate) v.expiryDate = p.expiryDate;
  else if (p.underlying) v.expiryDate = S.underlyings.find((x) => x.id === p.underlying)?.expiries[0]?.date ?? "";
  if (p.risk !== null) v.risk = p.risk;
  const changed = v.underlying !== S.chain?.underlying || v.expiryDate !== S.chain?.expiryDate;
  S.view = v;
  S.pick = null;
  if (changed) S.chain = null;
  refreshPills();
  metaTag();
  const miss = p.missing.map((m) => ({ underlying: "which index or stock", direction: "up or down (e.g. 'stays above')", level: "the level", expiry: "which expiry", risk: "how much you're risking (₹)" })[m]);
  $("#nlNotes").innerHTML = [...(miss.length ? [`I couldn't find ${miss.join(", ")}. Set it in the sentence above.`] : []), ...p.notes].map((n) => `<p class="note">${esc(n)}</p>`).join("");
  void loadChain();
}

let chainTimer = 0;
async function loadChain(): Promise<void> {
  clearTimeout(chainTimer);
  const v = S.view;
  if (!v.underlying || !v.expiryDate) {
    renderSuggestions();
    return;
  }
  try {
    const c = await api.get<Chain>(`/api/chain?u=${encodeURIComponent(v.underlying)}&expiry=${v.expiryDate}`);
    if (c.underlying !== S.view.underlying || c.expiryDate !== S.view.expiryDate) return; // superseded
    S.chain = c;
    S.chains.set(`${c.underlying}:${c.expiryDate}`, c);
    S.chainError = null;
    if (!Number.isFinite(S.view.level)) {
      // start from a sensible strike near spot (0.6% away, on the strike grid); the user moves it
      const step = strikeStep(c) || 50;
      S.view = { ...S.view, level: S.view.dir === "above" ? Math.floor((c.spot * 0.994) / step) * step : Math.ceil((c.spot * 1.006) / step) * step };
    }
  } catch (e) {
    S.chain = null;
    S.chainError = errText(e);
  }
  if (S.tab !== "options" || S.review) return;
  metaTag();
  refreshPills();
  renderSuggestions();
  if (S.pop === "l" || S.pop === "e") renderPopBody();
  chainTimer = window.setTimeout(() => void loadChain(), S.demo ? 30_000 : 5000);
}

async function loadSpots(force = false): Promise<void> {
  if (!S.underlyings.length || (!force && gwNow() - S.spotsAt < 30_000)) return;
  S.spotsAt = gwNow();
  const ids = S.underlyings.map((u) => u.id);
  try {
    const r = await api.get<{ spots: Record<string, Spot> }>(`/api/spots?u=${encodeURIComponent(ids.join(","))}&spark=${encodeURIComponent(S.underlyings.filter((u) => u.index).map((u) => u.id).join(","))}`);
    for (const [k, x] of Object.entries(r.spots)) S.spots.set(k, x);
    S.spotsNote = "";
  } catch (e) {
    S.spotsNote = errText(e);
  }
  if (S.pop === "u") renderPopBody();
}

const complete = (v: View): boolean => Boolean(v.underlying && v.expiryDate && Number.isFinite(v.level) && v.level > 0 && Number.isFinite(v.risk) && v.risk > 0);
const chosen = (): Suggestion | null => S.suggestions.find((x) => x.kind === S.pick) ?? S.suggestions[0] ?? null;

function renderSuggestions(): void {
  const box = $("#sugs"), quote = $("#quote");
  if (!box || !quote) return;
  const v = S.view;
  S.suggestions = [];
  if (!complete(v)) {
    quote.innerHTML = `<span class="x-cost x-grey">Pick a level and how much you're risking</span>`;
    box.innerHTML = S.chain || !S.chainError ? "" : `<p class="x-msg" data-testid="no-prices">No trades shown: ${esc(S.chainError)}.</p>`;
    $("#kindTag").textContent = "Defined-risk spread";
    dock();
    return;
  }
  if (!S.chain) {
    quote.innerHTML = `<span class="x-cost x-grey">${S.chainError ? "No live prices" : "Waiting for prices…"}</span>`;
    box.innerHTML = `<p class="x-msg" data-testid="no-prices">No trades shown: ${esc(S.chainError ?? "waiting for live prices")}.</p>`;
    dock();
    return;
  }
  const r = suggest(v, S.chain, { now: gwNow(), slippage: Math.min(0.02, S.session?.risk.maxSlippage ?? 0.02) });
  S.suggestions = r.suggestions;
  const sg = chosen();
  const fails = r.failures.map((f) => `<div class="x-msg x-msg--muted" data-testid="sug-fail"><b>${esc(f.kind.replace(/-/g, " "))}</b>: ${esc(describeFail(f.fail))}</div>`).join("");
  if (!sg) {
    quote.innerHTML = `<span class="x-cost x-grey">No trade fits</span>`;
    box.innerHTML = fails;
    $("#kindTag").textContent = "Defined-risk spread";
    dock();
    return;
  }
  $("#kindTag").textContent = sg.title;
  let cost = $("#qCost"), ch = $("#qChance");
  if (!cost || !ch) {
    quote.innerHTML = `<span class="x-cost" data-testid="summary">It risks <b id="qCost"></b> · <b id="qChance"></b> chance of profit</span><span class="x-grey" id="qMeta"></span>`;
    cost = $("#qCost");
    ch = $("#qChance");
  }
  countTo(cost, Math.round(sg.worstMaxLoss), (x) => inr(Math.round(x)));
  if (sg.probProfit === null) ch.textContent = "unknown";
  else countTo(ch, Math.round(sg.probProfit * 100), (x) => `${Math.round(x)}%`);
  $("#qMeta").textContent = `${sg.lots} lot${sg.lots === 1 ? "" : "s"} × ${sg.lotSize} · ${sg.credit ? `${inr(Math.abs(sg.netPerUnit) * sg.qty)} credit` : `${inr(Math.abs(sg.netPerUnit) * sg.qty)} debit`}`;
  const other = S.suggestions.find((x) => x !== sg);
  box.innerHTML = `
    <div class="x-trade" data-testid="suggestion">
      <span class="x-trade__t">${esc(sg.title)}</span>
      ${sg.legs.map((l) => `<span class="x-leg"><b class="${l.side === "BUY" ? "buy" : "sell"}">${l.side}</b> ${esc(l.inst.symbol)}</span>`).join("")}
      <span class="x-leg">max loss <b data-testid="max-loss">${inr(sg.maxLoss)}</b></span>
      <button type="button" class="x-link" data-review="${esc(sg.id)}">Review</button>
    </div>
    ${other ? `<button type="button" class="x-alt" id="alt" data-testid="alt-suggestion">Other way: <b>${esc(other.title)}</b> · risks ${inr(other.worstMaxLoss)} · ${other.probProfit === null ? "chance unknown" : `${pct(other.probProfit)} chance`}</button>` : ""}
    ${sg.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join("")}
    ${fails}`;
  $("#alt")?.addEventListener("click", () => {
    S.pick = other!.kind;
    renderSuggestions();
  });
  box.querySelector<HTMLButtonElement>("[data-review]")?.addEventListener("click", () => openReview(sg));
  dock();
}

// ── popovers ─────────────────────────────────────────────────────────
let popDispose: (() => void) | null = null;
let popAnchor: HTMLElement | null = null;

function closePop(): void {
  const pop = $("#pop");
  popDispose?.();
  popDispose = null;
  if (popAnchor) {
    popAnchor.classList.remove("is-on");
    popAnchor.setAttribute("aria-expanded", "false");
  }
  popAnchor = null;
  S.pop = null;
  if (pop) {
    pop.hidden = true;
    pop.innerHTML = "";
  }
}

function togglePop(k: PopKey, anchor: HTMLElement): void {
  if (S.pop === k) return closePop();
  closePop();
  const pop = $("#pop");
  if (!pop) return;
  S.pop = k;
  popAnchor = anchor;
  anchor.classList.add("is-on");
  anchor.setAttribute("aria-expanded", "true");
  pop.setAttribute("aria-label", anchor.getAttribute("aria-label") ?? "");
  pop.dataset.k = k;
  pop.hidden = false;
  renderPopBody();
  placePopover(pop, anchor, pop.parentElement!);
  pop.classList.remove("is-in");
  void pop.offsetWidth;
  pop.classList.add("is-in");
  popDispose = dismissable(pop, anchor, closePop);
  const first = pop.querySelector<HTMLElement>("input:not([type=range]), .is-sel, button");
  if (first && !matchMedia("(pointer: coarse)").matches) first.focus({ preventScroll: true });
  if (k === "u") void loadSpots();
  if (k === "e") void loadExpiryChances();
}

function renderPopBody(): void {
  const pop = $("#pop");
  if (!pop || !S.pop) return;
  const k = S.pop;
  if (k === "u") popUnderlying(pop);
  else if (k === "d") popDirection(pop);
  else if (k === "l") popLevel(pop);
  else if (k === "e") popExpiry(pop);
  else if (k === "r") popRisk(pop);
  else popStocks(pop, k);
}

function commit(next: Partial<View>, opts: { reload?: boolean; close?: boolean } = {}): void {
  S.view = { ...S.view, ...next };
  S.pick = null;
  if (opts.reload) {
    S.chain = null;
    metaTag();
  }
  refreshPills();
  if (opts.close) closePop();
  renderSuggestions();
  if (opts.reload) void loadChain();
}

function spotRow(u: Underlying): string {
  const sp = S.spots.get(u.id);
  const ch = sp?.changePct;
  return `<li><button type="button" data-u="${esc(u.id)}" class="${u.id === S.view.underlying ? "is-sel" : ""}">
    <span class="x-li-n">${esc(u.label)}<small>${u.index ? `${esc(u.exchange)} index` : "F&O stock"}${u.lotSize ? ` · lot ${u.lotSize}` : ""}</small></span>
    <span class="x-li-p">${sp?.ltp ? num(sp.ltp) : "—"}${ch !== null && ch !== undefined ? `<em class="${ch >= 0 ? "x-up" : "x-dn"}">${ch >= 0 ? "+" : "−"}${Math.abs(ch * 100).toFixed(2)}%</em>` : ""}</span>
    ${sparkline(sp?.spark) || `<span class="x-spark-none" aria-hidden="true"></span>`}
  </button></li>`;
}

function popUnderlying(pop: HTMLElement): void {
  const q = ($<HTMLInputElement>("#uSearch", pop)?.value ?? "").trim().toLowerCase();
  const idx = S.underlyings.filter((u) => u.index);
  const stocks = S.underlyings.filter((u) => !u.index);
  const match = (u: Underlying) => !q || u.label.toLowerCase().includes(q) || u.id.toLowerCase().includes(q);
  const hadFocus = document.activeElement?.id === "uSearch";
  pop.innerHTML = `
    <p class="x-pop__cap">Choose an index or F&O stock</p>
    ${stocks.length > 6 || q ? `<label class="x-search">${ICON.search}<input id="uSearch" aria-label="Search underlyings" placeholder="Search" value="${esc(q)}" autocomplete="off"></label>` : ""}
    <ul class="x-list" data-testid="pick-underlying">${idx.filter(match).map(spotRow).join("")}</ul>
    ${stocks.filter(match).length ? `<p class="x-pop__sub">F&O stocks</p><ul class="x-list">${stocks.filter(match).slice(0, 60).map(spotRow).join("")}</ul>` : ""}
    <p class="x-pop__foot">${S.spotsNote ? esc(S.spotsNote) : S.demo ? "Recorded 8 Oct 2026 snapshot: no day change or intraday chart in the recording." : "Day change and chart when the broker reports them."}</p>`;
  const inp = $<HTMLInputElement>("#uSearch", pop);
  if (inp) {
    inp.addEventListener("input", () => popUnderlying(pop));
    if (hadFocus) {
      inp.focus();
      inp.setSelectionRange(inp.value.length, inp.value.length);
    }
  }
  pop.querySelectorAll<HTMLButtonElement>("[data-u]").forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.dataset.u!;
      if (id === S.view.underlying) return closePop();
      const u = S.underlyings.find((x) => x.id === id);
      commit({ underlying: id, level: NaN, expiryDate: u?.expiries[0]?.date ?? "" }, { reload: true, close: true });
    }),
  );
}

function popDirection(pop: HTMLElement): void {
  pop.innerHTML = `<p class="x-pop__cap">What do you think ${esc(underlyingLabel(S.view.underlying))} will do?</p><ul class="x-list">${DIRS.map(
    (x) => `<li><button type="button" data-d="${x.d}-${x.m}" class="${S.view.dir === x.d && S.view.mode === x.m ? "is-sel" : ""}"><span class="x-li-n">${x.label}<small>${x.desc}</small></span><i class="x-dir ${x.d === "above" ? "x-up" : "x-dn"}">${x.d === "above" ? ICON.up : ICON.down}</i></button></li>`,
  ).join("")}</ul>`;
  pop.querySelectorAll<HTMLButtonElement>("[data-d]").forEach((b) =>
    b.addEventListener("click", () => {
      const [d, m] = b.dataset.d!.split("-") as [View["dir"], View["mode"]];
      commit({ dir: d, mode: m }, { close: true });
    }),
  );
}

function levelInfo(level: number): string {
  const c = S.chain;
  if (!c || !Number.isFinite(level)) return "Log in for live prices";
  const d = (level / c.spot - 1) * 100;
  const p = chanceAt(c, level, S.view.dir);
  return `${d >= 0 ? "↑" : "↓"}${Math.abs(d).toFixed(1)}% from spot · ${p === null ? "chance unknown" : `${pct(p)} chance`} it settles ${S.view.dir}`;
}

function popLevel(pop: HTMLElement): void {
  const c = S.chain;
  const step = c ? strikeStep(c) || 50 : 50;
  const spot = c?.spot ?? NaN;
  const lo = c ? Math.floor((spot * 0.92) / step) * step : 0, hi = c ? Math.ceil((spot * 1.08) / step) * step : 0;
  const v = Number.isFinite(S.view.level) ? S.view.level : spot;
  pop.innerHTML = `
    <p class="x-pop__cap">${esc(underlyingLabel(S.view.underlying))} ${c ? `${S.demo ? "recorded at" : "now"} <b>${num(spot)}</b>` : "· no live price"}</p>
    <label class="x-field"><input id="popIn" inputmode="decimal" aria-label="Level value" value="${Number.isFinite(v) ? v : ""}" autocomplete="off"><small>type or drag</small></label>
    ${c ? `<input type="range" class="x-range" id="popRange" aria-label="Level slider" min="${lo}" max="${hi}" step="${step}" value="${Math.min(hi, Math.max(lo, v))}">
    <div class="x-ends"><span>${num(lo, 0)}</span><b id="popInfo">${esc(levelInfo(v))}</b><span>${num(hi, 0)}</span></div>` : `<p class="x-pop__foot">${esc(S.chainError ?? "Waiting for prices")}</p>`}`;
  const inp = $<HTMLInputElement>("#popIn", pop), rng = $<HTMLInputElement>("#popRange", pop);
  const set = (x: number, fromRange: boolean) => {
    if (!Number.isFinite(x) || x <= 0) return;
    if (fromRange) inp.value = String(x);
    else if (rng) rng.value = String(x);
    const info = $("#popInfo", pop);
    if (info) info.textContent = levelInfo(x);
    commit({ level: x });
  };
  rng?.addEventListener("input", () => set(Number(rng.value), true));
  inp.addEventListener("change", () => set(Number(inp.value.replace(/[,₹\s]/g, "")), false));
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      set(Number(inp.value.replace(/[,₹\s]/g, "")), false);
      closePop();
    }
  });
}

async function loadExpiryChances(): Promise<void> {
  const u = curU();
  if (!u) return;
  const list = u.expiries.slice(0, 8).filter((e) => !S.chains.has(`${u.id}:${e.date}`));
  await Promise.all(
    list.map(async (e) => {
      try {
        S.chains.set(`${u.id}:${e.date}`, await api.get<Chain>(`/api/chain?u=${encodeURIComponent(u.id)}&expiry=${e.date}`));
      } catch (x) {
        S.chains.set(`${u.id}:${e.date}`, errText(x));
      }
    }),
  );
  if (S.pop === "e") renderPopBody();
}

function popExpiry(pop: HTMLElement): void {
  const u = curU();
  const ex = u?.expiries ?? [];
  const row = (e: ExpiryInfo, i: number) => {
    const c = S.chains.get(`${u!.id}:${e.date}`);
    const p = typeof c === "object" ? chanceAt(c, S.view.level, S.view.dir) : null;
    const chance = i >= 8 ? "" : c === undefined ? `<em class="x-chance is-wait">…</em>` : typeof c === "string" ? `<em class="x-chance is-none" title="${esc(c)}">no prices</em>` : `<em class="x-chance">${p === null ? "—" : pct(p)}</em>`;
    return `<li><button type="button" data-e="${e.date}" class="${e.date === S.view.expiryDate ? "is-sel" : ""}"><span class="x-li-n">${esc(shortDate(e.date, Number(istDate(gwNow()).slice(0, 4))))}<small>${esc(expiryMeta(e))}</small></span>${chance}</button></li>`;
  };
  pop.innerHTML = `<p class="x-pop__cap">Expiry · chance it settles ${S.view.dir} ${Number.isFinite(S.view.level) ? num(S.view.level, 0) : "the level"}</p><ul class="x-list x-list--scroll">${ex.map(row).join("") || `<li class="x-pop__foot">No expiries listed</li>`}</ul>`;
  pop.querySelectorAll<HTMLButtonElement>("[data-e]").forEach((b) => b.addEventListener("click", () => commit({ expiryDate: b.dataset.e! }, { reload: true, close: true })));
}

// risk slider: log scale ₹1,000 … ₹5,00,000
const R_MIN = 1000, R_MAX = 500000;
const toSlider = (r: number): number => Math.round((Math.log(Math.min(R_MAX, Math.max(R_MIN, r)) / R_MIN) / Math.log(R_MAX / R_MIN)) * 1000);
const fromSlider = (t: number): number => {
  const raw = R_MIN * Math.pow(R_MAX / R_MIN, t / 1000);
  const step = raw < 10000 ? 500 : raw < 100000 ? 1000 : 5000;
  return Math.round(raw / step) * step;
};

function popRisk(pop: HTMLElement): void {
  const v = Number.isFinite(S.view.risk) ? S.view.risk : 5000;
  pop.innerHTML = `
    <p class="x-pop__cap">How much are you willing to lose?</p>
    <label class="x-field"><span>₹</span><input id="popIn" inputmode="decimal" aria-label="Amount value" value="${v}" autocomplete="off"><small>type or drag</small></label>
    <input type="range" class="x-range x-range--amt" id="popRange" aria-label="Amount slider" min="0" max="1000" step="1" value="${toSlider(v)}">
    <div class="x-ends"><span>₹1,000</span><b>max loss incl. charges</b><span>₹5,00,000</span></div>`;
  const inp = $<HTMLInputElement>("#popIn", pop), rng = $<HTMLInputElement>("#popRange", pop);
  rng.addEventListener("input", () => {
    const x = fromSlider(Number(rng.value));
    inp.value = String(x);
    commit({ risk: x });
  });
  const typed = () => {
    const x = parseRupees(inp.value);
    if (x && x > 0) {
      rng.value = String(toSlider(x));
      commit({ risk: x });
    }
  };
  inp.addEventListener("change", typed);
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      typed();
      closePop();
    }
  });
}

// ── review & confirm ─────────────────────────────────────────────────
function chargesTable(c: ChargeBreakdown, broker: string): string {
  const rows = (Object.keys(CHARGE_LABELS) as (keyof typeof CHARGE_LABELS)[]).filter((k) => c[k] > 0 || k === "brokerage" || k === "stt").map((k) => `<tr><td>${CHARGE_LABELS[k]}</td><td>${inr2(c[k])}</td></tr>`).join("");
  return `<table class="x-tbl x-tbl--tight"><tbody>${rows}<tr class="tot"><td>Total (our calculation)</td><td>${inr2(c.total)}</td></tr><tr><td>Broker's own figure</td><td>${esc(broker)}</td></tr></tbody></table>
    <p class="x-fine">Schedule in force: ${esc(c.scheduleId)} (Upstox brokerage page, NSE/BSE circulars, Finance Act 2026 STT). The contract note is final.</p>`;
}

function chartHtml(sg: Suggestion): { html: string; pts: { S: number; pnl: number }[] } {
  const ks = sg.legs.map((l) => l.inst.strike!);
  const lo = Math.min(...ks), hi = Math.max(...ks);
  const pad = Math.max(hi - lo, (S.chain ? strikeStep(S.chain) : 50) * 2) * 2.2;
  const pts = payoffCurve(sg, lo - pad, hi + pad, 15);
  const maxUp = Math.max(1e-9, ...pts.map((p) => p.pnl)), maxDn = Math.max(1e-9, ...pts.map((p) => -p.pnl));
  const H = 160, W = 600, mid = H * (maxUp / (maxUp + maxDn)), bw = W / pts.length;
  const bars = pts
    .map((p, i) => {
      const h = Math.max(3, p.pnl >= 0 ? (p.pnl / maxUp) * (mid - 6) : (-p.pnl / maxDn) * (H - mid - 6));
      const y = p.pnl >= 0 ? mid - h : mid;
      return `<rect data-i="${i}" x="${(i * bw + 4).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 8).toFixed(1)}" height="${h.toFixed(1)}" rx="6" fill="${p.pnl >= 0 ? "#5BD08A" : "#F2A39B"}" tabindex="0" aria-label="At ${num(p.S, 0)}: ${signedInr(p.pnl)}"></rect>`;
    })
    .join("");
  const html = `<div class="x-chart" id="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Profit or loss at expiry by price">${bars}<line x1="0" x2="${W}" y1="${mid.toFixed(1)}" y2="${mid.toFixed(1)}" stroke="#151515" stroke-width="2"/></svg><span class="x-tip" id="tip" hidden></span></div>
    <div class="x-axis"><span>${num(pts[0]!.S, 0)}</span><span>${num(pts[Math.floor(pts.length / 3)]!.S, 0)}</span><span>${num(pts[Math.floor((2 * pts.length) / 3)]!.S, 0)}</span><span>${num(pts[pts.length - 1]!.S, 0)}</span></div>`;
  return { html, pts };
}

let reviewTimer = 0;

function openReview(sg: Suggestion): void {
  closePop();
  S.review = sg;
  clearTimeout(chainTimer);
  clearInterval(reviewTimer);
  const root = $("#view");
  if (!root) return;
  const s = S.session!;
  const live = S.mode === "live";
  const maxAge = s.risk.quoteMaxAgeMs ?? 15000;
  const fetchedAt = S.chain?.fetchedAt ?? 0;
  const capHit = s.risk.perTradeCap != null && sg.worstMaxLoss > s.risk.perTradeCap;
  const ks = sg.legs.map((l) => l.inst.strike!);
  const loK = Math.min(...ks), hiK = Math.max(...ks);
  const bull = sg.kind.startsWith("bull");
  const net = (S0: number) => legsPayoff(sg.legs, S0) - sg.entryCharges.total;
  const label = underlyingLabel(S.view.underlying);
  const midK = (loK + hiK) / 2;
  const headLevel = bull ? hiK : loK;
  const ch = chartHtml(sg);
  const idx = curU()?.index ?? true;
  const exp = sg.legs[0]!.inst.expiryDate ?? S.view.expiryDate;
  const outRow = (icon: string, bg: string, text: string, v: number) => `<div class="x-out"><i style="background:${bg}">${icon}</i>${esc(text)}<b class="${v > 0 ? "x-up" : v < 0 ? "x-dn" : ""}">${signedInr(Math.round(v))}</b></div>`;
  root.innerHTML = `
  <div class="x-review">
    <div class="x-card x-card--pos">
      <div class="x-card__top" data-testid="review-title"><span>${esc(sg.title)}</span><span class="x-badges">${live ? `<span class="x-badge x-badge--live">REAL MONEY</span>` : `<span class="x-badge">PAPER</span>`}${S.demo ? `<span class="x-badge x-badge--demo">DEMO</span>` : ""}</span><button type="button" class="x-edit" id="editReview">Edit</button></div>
      <h2 class="x-rh">Make <mark class="x-amt">${inr(sg.maxProfit)}</mark> if ${esc(label)} <mark class="x-sal">${bull ? (S.view.mode === "stays" ? "stays above" : "ends above") : S.view.mode === "stays" ? "stays below" : "ends below"}</mark> <mark class="x-mint">${num(headLevel, 0)}</mark> by <mark class="x-lav">${esc(shortD(exp))}</mark></h2>
      <p class="x-fine">Before ${inr2(sg.entryCharges.total)} charges to open; the outcomes and chart below are after them.</p>
      <div class="x-outs">
        ${outRow(bull ? "↗" : "↘", "#BDEFCB", `Ends ${bull ? "above" : "below"} ${num(bull ? hiK : loK, 0)}`, net(bull ? hiK : loK))}
        ${outRow("→", "#EEEDEA", `Ends at ${num(midK, 0)}`, net(midK))}
        ${outRow(bull ? "↘" : "↗", "#F7C6BC", `Ends ${bull ? "below" : "above"} ${num(bull ? loK : hiK, 0)}`, net(bull ? loK : hiK))}
      </div>
      <p class="x-chcap">Profit or loss by ${esc(label)} on ${esc(shortD(exp))}, after charges to open · ${matchMedia("(hover: hover)").matches ? "hover" : "tap"} the bars</p>
      ${ch.html}
      <details class="x-contracts" id="contracts">
        <summary>Contracts <span aria-hidden="true">${ICON.plus}</span></summary>
        <p class="x-fine">Buy leg first, then sell; IOC limit orders${S.demo ? " (paper, demo)" : ""}.</p>
        <div class="x-scroll"><table class="x-tbl" data-testid="legs"><thead><tr><th>Side</th><th>Contract</th><th>Lots × size</th><th>Price now</th><th>Limit</th><th>Tick</th><th>Freeze</th><th>Orders</th></tr></thead><tbody>
        ${sg.legs.map((l) => `<tr><td class="${l.side === "BUY" ? "buy" : "sell"}">${l.side}</td><td>${esc(l.inst.symbol)}</td><td>${l.qty / sg.lotSize} × ${sg.lotSize}</td><td>${inr2(l.price)}</td><td>${inr2(l.limit)}</td><td>₹${(l.inst.tickPaise / 100).toFixed(2)}</td><td>${l.inst.freezeQty ?? "—"} (≤${Number.isFinite(maxPerOrder(l.inst)) ? maxPerOrder(l.inst) : "—"}/order)</td><td>${l.slices.length}</td></tr>`).join("")}
        </tbody></table></div>
      </details>
    </div>
    <div class="x-col">
      <div class="x-card">
        <dl class="x-rows">
          <div><dt>Size</dt><dd>${sg.lots} lot${sg.lots === 1 ? "" : "s"} × ${sg.lotSize} = ${sg.qty} units</dd></div>
          <div><dt>${sg.credit ? "Credit received" : "Debit paid"}</dt><dd>${inr(Math.abs(sg.netPerUnit) * sg.qty)}</dd></div>
          <div><dt>Maximum profit</dt><dd class="x-up">${inr(sg.maxProfit)}</dd></div>
          <div><dt>Maximum loss</dt><dd class="x-dn">${inr(sg.maxLoss)}</dd></div>
          <div><dt>Worst case incl. slippage + charges</dt><dd class="x-dn" data-testid="worst">${inr(sg.worstMaxLoss)}</dd></div>
          <div><dt>Breakeven at expiry</dt><dd>${num(sg.breakeven)}</dd></div>
          <div><dt>Chance of profit</dt><dd>${sg.probProfit === null ? "unavailable" : pct(sg.probProfit)}</dd></div>
          <div class="x-rows__x"><dt>Charges to open</dt><dd><details><summary data-testid="charges-total">${inr2(sg.entryCharges.total)}</summary><div id="chg">${chargesTable(sg.entryCharges, "checking…")}</div></details></dd></div>
          <div><dt>Broker's own figure</dt><dd data-testid="broker-charges">checking…</dd></div>
          <div><dt>Margin (broker)</dt><dd data-margin="${esc(sg.id)}">${esc(S.margins.get(sg.id) ?? "…")}</dd></div>
          <div><dt>Expires</dt><dd>${esc(longDate(exp))} · 15:30 IST</dd></div>
          <div><dt>Settlement</dt><dd>${idx ? "Cash settled · European" : "Physical delivery if held to expiry"}</dd></div>
          <div><dt>Prices</dt><dd>${S.demo ? "Recorded 8 Oct 2026 10:39 IST" : `${esc(S.chain?.source ?? "—")} · ${S.chain ? esc(istClock(S.chain.fetchedAt)) : ""}`}</dd></div>
        </dl>
        <p class="x-fine">Chance = risk-neutral probability from the option chain's implied volatility (lognormal, zero rates). It is not a forecast. Closing before expiry at today's prices would cost about ${inr2(sg.exitChargesIfClosed.total)} more.</p>
        ${sg.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join("")}
      </div>
      <div id="gates">
        ${capHit ? `<p class="x-err">Above your per-trade cap of ${inr(s.risk.perTradeCap!)}.</p>` : ""}
        ${s.killSwitch ? `<p class="x-err">Kill switch is on: new trades are blocked.</p>` : ""}
        <p class="x-err" data-testid="stale" id="stale" hidden></p>
      </div>
      <form id="confirm" class="x-confirmbox">
        ${live ? `<div class="x-real" role="alert">Real money: this sends orders to ${esc(s.broker.name)}. Type <b>${esc(s.confirmPhrase)}</b> to send a real order<input id="phrase" autocomplete="off" spellcheck="false" aria-label="Type ${esc(s.confirmPhrase)} to confirm" data-testid="phrase"></div>` : ""}
        <label class="x-agree"><input type="checkbox" id="agree"><span>I understand I can lose up to ${inr(sg.worstMaxLoss)}${live ? "" : S.demo ? " (paper trade on recorded prices; nothing is sent anywhere)" : " (paper trade: nothing is sent to the broker)"}.</span></label>
        <button type="submit" class="x-buy x-confirm ${live ? "x-confirm--live" : "x-confirm--paper"}" id="go" data-testid="place" disabled></button>
        <p class="x-step" id="step" role="status"></p>
      </form>
      <div id="result" aria-live="polite"></div>
    </div>
  </div>`;
  dock();
  root.scrollIntoView({ block: "start" });
  window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });

  // chart tooltips (hover on desktop, tap on phones)
  const tip = $("#tip"), chart = $("#chart");
  const showTip = (r: SVGRectElement) => {
    const p = ch.pts[Number(r.dataset.i)]!;
    const box = chart.getBoundingClientRect(), rb = r.getBoundingClientRect();
    tip.textContent = `${label} ${num(p.S, 0)} · ${signedInr(Math.round(p.pnl))}`;
    tip.hidden = false;
    tip.style.left = `${Math.max(60, Math.min(box.width - 60, rb.left - box.left + rb.width / 2))}px`;
    chart.querySelectorAll("rect").forEach((x) => x.classList.toggle("is-hi", x === r));
  };
  chart.querySelectorAll<SVGRectElement>("rect").forEach((r) => {
    r.addEventListener("pointerenter", () => showTip(r));
    r.addEventListener("click", () => showTip(r));
    r.addEventListener("focus", () => showTip(r));
  });
  chart.addEventListener("pointerleave", () => {
    tip.hidden = true;
    chart.querySelectorAll("rect").forEach((x) => x.classList.remove("is-hi"));
  });

  $("#editReview").addEventListener("click", closeReview);
  const go = $<HTMLButtonElement>("#go");
  let placed = false;
  const age = () => gwNow() - fetchedAt;
  const fresh = () => age() <= maxAge;
  const gate = () => {
    if (placed) return;
    const okPhrase = !live || $<HTMLInputElement>("#phrase").value.trim().toUpperCase() === s.confirmPhrase;
    const f = fresh();
    const left = Math.max(0, Math.ceil((maxAge - age()) / 1000));
    const stale = $("#stale");
    stale.hidden = f;
    if (!f) stale.textContent = `Prices are ${Math.round(age() / 1000)} s old. Refresh before placing.`;
    if (!f) {
      go.disabled = false;
      go.dataset.act = "refresh";
      go.innerHTML = `<span>Refresh prices</span>`;
      return;
    }
    go.dataset.act = "place";
    go.disabled = !($<HTMLInputElement>("#agree").checked && okPhrase && !capHit && !s.killSwitch);
    const text = live ? `Send real order · ${inr(sg.worstMaxLoss)} at risk` : `Place paper trade · ${inr(sg.worstMaxLoss)} at risk`;
    go.innerHTML = `<span>${go.disabled && !$<HTMLInputElement>("#agree").checked ? "Tick the box to continue" : text}</span>${S.demo ? "" : ring(left / (maxAge / 1000), String(left))}`;
  };
  $("#confirm").querySelectorAll("input").forEach((i) => i.addEventListener("input", gate));
  gate();
  reviewTimer = window.setInterval(gate, 500);
  const refresh = async () => {
    go.disabled = true;
    $("#step").textContent = "Refreshing prices…";
    await loadChainOnce();
    const again = S.suggestions.find((x) => x.kind === sg.kind);
    if (again && S.tab === "options") openReview(again);
    else {
      closeReview();
      toast("That trade is no longer available at current prices", "err");
    }
  };
  $("#confirm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (go.dataset.act === "refresh") return void refresh();
    go.disabled = true;
    placed = true;
    clearInterval(reviewTimer);
    go.innerHTML = `<span>Placing…</span>`;
    try {
      const r = await api.post<{ paper: boolean; worstLoss: number; result: { status: string; matchedQty: number; legs: { inst: { symbol: string }; side: string; requested: number; filled: number; avgPrice: number | null; error?: string }[]; unwinds: { inst: { symbol: string }; side: string; qty: number; filled: number; error?: string }[]; residual: { inst: { symbol: string }; netQty: number }[] } }>("/api/trade/options", {
        mode: S.mode,
        legs: sg.legs.map((l) => ({ key: l.inst.key, side: l.side, qty: l.qty, limit: l.limit })),
        confirm: live ? $<HTMLInputElement>("#phrase").value : undefined,
        view: sentence(S.view),
      });
      const res = r.result;
      const head = { filled: "Filled", partial: "Partly filled", unwound: "Not filled: the bought leg was closed again", "nothing-filled": "Nothing filled", "needs-attention": "NEEDS ATTENTION: a leg could not be closed" }[res.status] ?? res.status;
      $("#result").innerHTML = `<div class="x-card x-result ${res.status === "needs-attention" ? "x-result--bad" : res.status === "filled" ? "x-result--ok" : ""}" data-testid="result">
        <h3>${r.paper ? "Paper · " : ""}${esc(head)}</h3>
        <ul>${res.legs.map((l) => `<li><b class="${l.side === "BUY" ? "buy" : "sell"}">${esc(l.side)}</b> ${esc(l.inst.symbol)}: ${l.filled}/${l.requested}${l.avgPrice ? ` @ ${inr2(l.avgPrice)}` : ""}${l.error ? ` · ${esc(l.error)}` : ""}</li>`).join("")}</ul>
        ${res.unwinds.map((u) => `<p class="warn">Unwind ${esc(u.side)} ${esc(u.inst.symbol)}: ${u.filled}/${u.qty}${u.error ? ` · ${esc(u.error)}` : ""}</p>`).join("")}
        ${res.residual.map((x) => `<p class="x-err">Open: ${esc(x.inst.symbol)} ${x.netQty > 0 ? "long" : "short"} ${Math.abs(x.netQty)}. Close it from Portfolio or the broker app.</p>`).join("")}
        <button type="button" class="x-edit" id="toPortfolio">See portfolio</button>
      </div>`;
      $("#toPortfolio").addEventListener("click", () => setTab("portfolio"));
      $("[data-testid=result]").scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
      go.innerHTML = `<span>Done</span>`;
    } catch (e) {
      placed = false;
      $("#result").innerHTML = `<p class="x-err" data-testid="result-error">${esc(errText(e))}</p>`;
      gate();
      reviewTimer = window.setInterval(gate, 500);
    }
  });
  void loadMargin(sg);
  // broker's own charges for each leg (cross-check)
  void (async () => {
    let text: string;
    try {
      let total = 0;
      for (const l of sg.legs) total += (await api.post<{ total: number }>("/api/charges/broker", { key: l.inst.key, qty: l.qty, side: l.side, product: "D", price: l.price })).total;
      text = inr2(total);
    } catch (e) {
      text = `unavailable: ${errText(e)}`;
    }
    const bc = $("[data-testid=broker-charges]"), chg = $("#chg");
    if (bc) bc.textContent = text;
    if (chg) chg.innerHTML = chargesTable(sg.entryCharges, text);
  })();
}

async function loadChainOnce(): Promise<void> {
  const v = S.view;
  try {
    S.chain = await api.get<Chain>(`/api/chain?u=${encodeURIComponent(v.underlying)}&expiry=${v.expiryDate}`);
    S.chainError = null;
    S.suggestions = suggest(v, S.chain, { now: gwNow(), slippage: Math.min(0.02, S.session?.risk.maxSlippage ?? 0.02) }).suggestions;
  } catch (e) {
    S.chain = null;
    S.chainError = errText(e);
    S.suggestions = [];
  }
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

function closeReview(): void {
  clearInterval(reviewTimer);
  S.review = null;
  if (S.tab === "options") render();
}

// ── stocks ───────────────────────────────────────────────────────────
function eqPill(k: "eside" | "esize" | "estock" | "eprod"): string {
  const e = S.eq;
  const inner = {
    eside: `<span>${e.side === "BUY" ? "Buy" : "Sell"}</span>`,
    esize: `<span>${e.by === "amount" ? inr(e.amount) : `${e.qty} share${e.qty === 1 ? "" : "s"}`}</span>`,
    estock: `<span>${esc(e.name)}</span>`,
    eprod: `<span>${e.product === "I" ? "intraday" : "delivery"}</span>`,
  }[k];
  const meta = { eside: ["x-sal", "Buy or sell"], esize: ["x-amt", "How much"], estock: ["x-lav", "Stock"], eprod: ["x-mint", "Delivery or intraday"] }[k];
  return `<button type="button" class="x-pill ${meta[0]}" id="p_${k}" data-pop="${k}" aria-haspopup="dialog" aria-expanded="false" aria-label="${meta[1]}">${inner}${ICON.chev}</button>`;
}

function stocksView(root: HTMLElement): void {
  root.innerHTML = `
  <section class="x-builder x-builder--eq" id="builder">
    <div class="x-tags"><span class="x-tag x-tag--dark">Cash equity</span><span class="x-tag">Always a limit order</span></div>
    <p class="x-sent x-sent--eq" id="eqSent">${eqPill("eside")} ${eqPill("esize")} of ${eqPill("estock")}, ${eqPill("eprod")}</p>
    <form id="eq" class="x-nl">
      <input id="eqText" aria-label="Stock order in plain English" placeholder="Or type it: buy ₹20,000 of Reliance" autocomplete="off">
      <button class="x-edit" type="submit">Read it</button>
    </form>
    <div id="eqOut"></div>
    <div class="x-pop" id="pop" role="dialog" hidden></div>
  </section>`;
  wireEqPills(root);
  $("#eq").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const p = parseEquity(String($<HTMLInputElement>("#eqText").value));
    if (p.missing.length) {
      $("#eqOut").innerHTML = `<p class="note">I need ${p.missing.map((m) => ({ side: "buy or sell", stock: "which stock", size: "how many shares or how many rupees" })[m]).join(", ")}.</p>`;
      return;
    }
    S.eq = { ...S.eq, side: p.side!, by: p.qty !== null ? "qty" : "amount", amount: p.amount ?? S.eq.amount, qty: p.qty ?? S.eq.qty, symbol: p.query!, name: p.query!, product: p.product, price: p.price };
    void buildTicket(true);
  });
  void buildTicket(false);
}

function wireEqPills(root: ParentNode): void {
  root.querySelectorAll<HTMLButtonElement>("#eqSent [data-pop]").forEach((b) => b.addEventListener("click", () => togglePop(b.dataset.pop as PopKey, b)));
}
function refreshEqPills(): void {
  for (const k of ["eside", "esize", "estock", "eprod"] as const) morph($(`#p_${k}`), eqPill(k).replace(/^<button[^>]*>|<\/button>$/g, ""));
}

let eqSearchT = 0;
function popStocks(pop: HTMLElement, k: PopKey): void {
  const e = S.eq;
  const done = (next: Partial<typeof S.eq>) => {
    S.eq = { ...S.eq, ...next };
    refreshEqPills();
    void buildTicket(false);
  };
  if (k === "eside" || k === "eprod") {
    const opts = k === "eside" ? [["BUY", "Buy", "Add to your holdings"], ["SELL", "Sell", "Only what you hold (no short selling in cash)"]] : [["D", "delivery", "Keep the shares (CNC)"], ["I", "intraday", "Square off today (MIS)"]];
    const cur = k === "eside" ? e.side : e.product;
    pop.innerHTML = `<ul class="x-list">${opts.map(([v, l, d]) => `<li><button type="button" data-v="${v}" class="${cur === v ? "is-sel" : ""}"><span class="x-li-n">${l}<small>${d}</small></span></button></li>`).join("")}</ul>`;
    pop.querySelectorAll<HTMLButtonElement>("[data-v]").forEach((b) =>
      b.addEventListener("click", () => {
        done(k === "eside" ? { side: b.dataset.v as "BUY" | "SELL" } : { product: b.dataset.v as "D" | "I" });
        closePop();
      }),
    );
    return;
  }
  if (k === "esize") {
    pop.innerHTML = `
      <div class="x-seg x-seg--in" role="group" aria-label="Size in"><button type="button" data-by="amount" aria-pressed="${e.by === "amount"}">Rupees</button><button type="button" data-by="qty" aria-pressed="${e.by === "qty"}">Shares</button></div>
      <label class="x-field">${e.by === "amount" ? "<span>₹</span>" : ""}<input id="popIn" inputmode="decimal" aria-label="Size value" value="${e.by === "amount" ? e.amount : e.qty}" autocomplete="off"><small>${e.by === "amount" ? "type or drag" : "shares"}</small></label>
      ${e.by === "amount" ? `<input type="range" class="x-range x-range--amt" id="popRange" aria-label="Amount slider" min="0" max="1000" value="${toSlider(e.amount)}"><div class="x-ends"><span>₹1,000</span><b>whole shares at a limit</b><span>₹5,00,000</span></div>` : ""}`;
    pop.querySelectorAll<HTMLButtonElement>("[data-by]").forEach((b) =>
      b.addEventListener("click", () => {
        S.eq.by = b.dataset.by as "amount" | "qty";
        refreshEqPills();
        popStocks(pop, k);
        void buildTicket(false);
      }),
    );
    const inp = $<HTMLInputElement>("#popIn", pop), rng = $<HTMLInputElement>("#popRange", pop);
    rng?.addEventListener("input", () => {
      const x = fromSlider(Number(rng.value));
      inp.value = String(x);
      done({ amount: x });
    });
    const typed = () => {
      const x = e.by === "amount" ? parseRupees(inp.value) : Math.floor(Number(inp.value));
      if (x && x > 0) done(e.by === "amount" ? { amount: x } : { qty: x });
    };
    inp.addEventListener("change", typed);
    inp.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        typed();
        closePop();
      }
    });
    return;
  }
  // stock picker: F&O stocks you can also trade options on, plus a search of the instrument master
  const hadFocus = document.activeElement?.id === "sSearch";
  const qv = $<HTMLInputElement>("#sSearch", pop)?.value ?? "";
  pop.innerHTML = `<p class="x-pop__cap">Choose a stock (NSE)</p><label class="x-search">${ICON.search}<input id="sSearch" aria-label="Search stocks" placeholder="Search by name or symbol" value="${esc(qv)}" autocomplete="off"></label><ul class="x-list x-list--scroll" id="sList"></ul>`;
  const inp = $<HTMLInputElement>("#sSearch", pop);
  if (hadFocus) inp.focus();
  const list = $("#sList", pop);
  const show = (rows: { symbol: string; name: string }[]) => {
    list.innerHTML = rows.map((r) => {
      const sp = S.spots.get(r.symbol);
      return `<li><button type="button" data-s="${esc(r.symbol)}" data-n="${esc(r.name)}" class="${r.symbol === e.symbol ? "is-sel" : ""}"><span class="x-li-n">${esc(r.name)}<small>${esc(r.symbol)} · NSE</small></span><span class="x-li-p">${sp?.ltp ? num(sp.ltp) : ""}</span></button></li>`;
    }).join("") || `<li class="x-pop__foot">No NSE stock matches.</li>`;
    list.querySelectorAll<HTMLButtonElement>("[data-s]").forEach((b) =>
      b.addEventListener("click", () => {
        done({ symbol: b.dataset.s!, name: b.dataset.n!, price: null });
        closePop();
      }),
    );
  };
  const base = S.underlyings.filter((u) => !u.index).map((u) => ({ symbol: u.id, name: u.label === u.id ? u.id.charAt(0) + u.id.slice(1).toLowerCase() : u.label }));
  const search = async () => {
    const t = inp.value.trim();
    if (!t) return show(base);
    try {
      const r = (await api.get<{ results: Instrument[] }>(`/api/instruments/equity?q=${encodeURIComponent(t)}`)).results;
      show(r.map((x) => ({ symbol: x.symbol, name: x.name })));
    } catch (er) {
      list.innerHTML = `<li class="x-pop__foot">${esc(errText(er))}</li>`;
    }
  };
  inp.addEventListener("input", () => {
    clearTimeout(eqSearchT);
    eqSearchT = window.setTimeout(() => void search(), 180);
  });
  void search();
}

let ticketSeq = 0;
async function buildTicket(fromText: boolean): Promise<void> {
  const out = $("#eqOut");
  if (!out) return;
  const my = ++ticketSeq;
  const e = S.eq;
  const p: ParsedEquity & { side: "BUY" | "SELL" } = { side: e.side, query: e.symbol, qty: e.by === "qty" ? e.qty : null, amount: e.by === "amount" ? e.amount : null, price: e.price, product: e.product, missing: [] };
  try {
    const found = (await api.get<{ results: Instrument[] }>(`/api/instruments/equity?q=${encodeURIComponent(e.symbol)}`)).results;
    if (my !== ticketSeq) return;
    if (!found.length) {
      out.innerHTML = `<p class="note">No NSE stock matches "${esc(e.symbol)}" in today's instrument master.</p>`;
      return;
    }
    const inst = found[0]!;
    if (fromText || S.eq.symbol !== inst.symbol) {
      S.eq.symbol = inst.symbol;
      S.eq.name = inst.name.replace(/\b(LIMITED|LTD\.?)\b/gi, "").trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) || inst.symbol;
    }
    refreshEqPills();
    let q: Quote | null = null;
    let qErr = "";
    try {
      q = (await api.get<{ quotes: Record<string, Quote> }>(`/api/quotes?keys=${encodeURIComponent(inst.key)}`)).quotes[inst.key] ?? null;
    } catch (er) {
      qErr = errText(er);
    }
    if (my !== ticketSeq) return;
    const t = equityTicket(p, inst, q, gwNow());
    if ("fail" in t) {
      out.innerHTML = `${qErr ? `<p class="note">${esc(qErr)}</p>` : ""}<p class="x-err">${esc({ "no-quote": S.demo ? `No recorded price for ${inst.symbol} in the demo (only Reliance has one).` : "No live quote, and you gave no limit price. Add 'at <price>' or log in to the broker.", "zero-qty": "That amount buys less than one share.", "bad-price": "That price isn't valid." }[t.fail])}</p>`;
      S.ticket = null;
      return;
    }
    S.ticket = t;
    renderTicket(out, t, inst, q);
  } catch (er) {
    out.innerHTML = `<p class="x-err">${esc(errText(er))}</p>`;
  }
}

function renderTicket(out: HTMLElement, t: EquityTicket, inst: Instrument, q: Quote | null): void {
  const live = S.mode === "live";
  out.innerHTML = `<article class="x-card x-ticket" data-testid="eq-ticket">
    <div class="x-card__top"><span>Order ticket · ${esc(inst.exchange)}</span><span class="x-badges">${live ? `<span class="x-badge x-badge--live">REAL MONEY</span>` : `<span class="x-badge">PAPER</span>`}${S.demo ? `<span class="x-badge x-badge--demo">DEMO</span>` : ""}</span></div>
    <h3 class="x-rh x-rh--sm">${t.side === "BUY" ? "Buy" : "Sell"} ${t.qty} ${esc(inst.symbol)} <span class="x-grey">at ${inr2(t.limit)} limit</span></h3>
    <p class="x-grey x-small">${esc(inst.name)}</p>
    <dl class="x-rows">
      <div><dt>Limit price</dt><dd>${inr2(t.limit)}</dd></div>
      <div><dt>Last / ${t.side === "BUY" ? "offer" : "bid"}</dt><dd>${q?.ltp ? inr2(q.ltp) : "—"} / ${t.touch ? inr2(t.touch) : "—"}${S.demo ? " (recorded)" : ""}</dd></div>
      <div><dt>Order value</dt><dd>${inr(t.value)}</dd></div>
      <div><dt>Product</dt><dd>${t.product === "I" ? "Intraday" : "Delivery"}</dd></div>
      <div class="x-rows__x"><dt>Charges</dt><dd><details><summary>${inr2(t.charges.total)}</summary>${chargesTable(t.charges, "—")}</details></dd></div>
    </dl>
    ${t.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join("")}
    <form id="eqGo" class="x-confirmbox">
      ${live ? `<div class="x-real">Real money. Type <b>${esc(S.session!.confirmPhrase)}</b><input id="eqPhrase" autocomplete="off" aria-label="Type ${esc(S.session!.confirmPhrase)} to confirm"></div>` : ""}
      <button class="x-buy x-confirm ${live ? "x-confirm--live" : "x-confirm--paper"}" type="submit">${live ? "Send real order" : "Place paper order"}</button>
    </form>
    <div id="eqRes" aria-live="polite"></div>
  </article>`;
  $("#eqGo").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      const r = await api.post<{ placed: boolean; message?: string; status?: { state: string; filled: number } }>("/api/trade/equity", { mode: S.mode, key: inst.key, side: t.side, qty: t.qty, limit: t.limit, product: t.product, confirm: live ? $<HTMLInputElement>("#eqPhrase").value : undefined });
      $("#eqRes").innerHTML = r.placed
        ? `<p class="ok">${S.mode === "paper" ? "Paper order" : "Order"} placed: ${esc(r.status?.state ?? "")} (${r.status?.filled ?? 0} filled).${S.demo && r.status?.state === "open" ? " The recording has no stock order book, so a demo order rests unfilled." : ""}</p>`
        : `<p class="x-err">${esc(r.message ?? "Not placed")}</p>`;
    } catch (e) {
      $("#eqRes").innerHTML = `<p class="x-err">${esc(errText(e))}</p>`;
    }
  });
}

// ── portfolio / orders ───────────────────────────────────────────────
interface PosRow { symbol: string; qty: number; avgPrice: number | null; ltp: number | null; pnl: number | null }

function posCards(rows: PosRow[], id: string): string {
  if (!rows.length) return `<p class="x-empty" data-testid="${id}-empty">None.</p>`;
  return `<ul class="x-items" data-testid="${id}">${rows
    .map(
      (x) => `<li class="x-item" data-testid="${id === "positions" ? "position" : "holding"}">
      <div class="x-item__l"><b>${esc(x.symbol)}</b><small>${x.qty > 0 ? "Long" : x.qty < 0 ? "Short" : "Closed"} ${Math.abs(x.qty)} · avg ${x.avgPrice ? inr2(x.avgPrice) : "—"} · last ${x.ltp ? inr2(x.ltp) : "—"}</small></div>
      <b class="x-item__r ${x.pnl === null ? "" : x.pnl >= 0 ? "x-up" : "x-dn"}">${x.pnl === null ? "—" : signedInr(x.pnl)}</b>
    </li>`,
    )
    .join("")}</ul>`;
}

async function portfolioView(root: HTMLElement): Promise<void> {
  root.innerHTML = `<p class="x-loading">Loading ${S.mode} portfolio…</p>`;
  try {
    const p = await api.get<{ paper: boolean; positions: PosRow[]; holdings: PosRow[]; funds: { available: number | null } | null; pnl: number | null; note?: string | null }>(`/api/portfolio?mode=${S.mode}`);
    if (S.tab !== "portfolio") return;
    root.innerHTML = `
    <div class="x-page">
      <div class="x-card x-hero">
        <div class="x-card__top"><span>${S.demo ? "Demo · " : ""}${p.paper ? "Paper book" : "Broker account"}</span>${p.paper ? `<button type="button" class="x-edit" id="resetPaper">Reset paper book</button>` : ""}</div>
        <h2 class="x-rh">${p.paper ? "Paper portfolio" : "Portfolio"}</h2>
        <p class="x-big ${p.pnl === null ? "" : p.pnl >= 0 ? "x-up" : "x-dn"}" ${p.pnl !== null ? 'data-testid="pnl"' : ""}>${p.pnl !== null ? signedInr(p.pnl) : `<span class="x-grey x-small">P&L unavailable</span>`}</p>
        ${p.funds ? `<p class="x-grey">Available to trade: <b>${p.funds.available !== null ? inr(p.funds.available) : "—"}</b></p>` : ""}
        ${p.note ? `<p class="note">${esc(p.note)}</p>` : ""}
      </div>
      <div class="x-card"><h3 class="x-h3">Positions</h3>${posCards(p.positions, "positions")}</div>
      ${p.paper ? "" : `<div class="x-card"><h3 class="x-h3">Holdings</h3>${posCards(p.holdings, "holdings")}</div>`}
    </div>`;
    $("#resetPaper")?.addEventListener("click", async () => {
      await api.post("/api/paper/reset");
      void portfolioView(root);
    });
  } catch (e) {
    root.innerHTML = `<div class="x-page"><p class="x-err">${esc(errText(e))}</p></div>`;
  }
}

async function ordersView(root: HTMLElement): Promise<void> {
  root.innerHTML = `<p class="x-loading">Loading orders…</p>`;
  try {
    const [o, t] = await Promise.all([api.get<{ paper: boolean; orders: Record<string, unknown>[] }>(`/api/orders?mode=${S.mode}`), api.get<{ trades: Record<string, unknown>[] }>(`/api/trades?mode=${S.mode}`)]);
    if (S.tab !== "orders") return;
    const orders = o.orders.map((x) => {
      const id = String(x.orderId ?? x.id);
      const state = String(x.state ?? x.status);
      const side = String(x.side);
      return `<li class="x-item" data-testid="order"><div class="x-item__l"><b>${esc(String(x.symbol))}</b><small><span class="${side === "BUY" ? "buy" : "sell"}">${esc(side)}</span> ${x.filled ?? 0}/${x.qty} @ ${inr2(Number(x.price ?? x.limit))} · <span class="x-mono">${esc(id)}</span></small></div><span class="x-item__r"><span class="x-state x-state--${esc(state)}">${esc(state)}</span>${state === "open" ? `<button type="button" class="x-edit x-small" data-cancel="${esc(id)}">Cancel</button>` : ""}</span></li>`;
    });
    const trades = t.trades.map((x) => `<li class="x-item" data-testid="trade"><div class="x-item__l"><b>${esc(String(x.symbol))}</b><small><span class="${x.side === "BUY" ? "buy" : "sell"}">${esc(String(x.side))}</span> ${x.qty} · <span class="x-mono">${esc(String(x.tradeId))}</span></small></div><b class="x-item__r">${x.price ? inr2(Number(x.price)) : "—"}</b></li>`);
    root.innerHTML = `<div class="x-page">
      <div class="x-card"><div class="x-card__top"><span>${S.demo ? "Demo · " : ""}${o.paper ? "Paper" : "Broker"}</span></div><h2 class="x-rh">${o.paper ? "Paper orders" : "Order book"}</h2>${orders.length ? `<ul class="x-items" data-testid="orders">${orders.join("")}</ul>` : `<p class="x-empty" data-testid="orders-empty">None.</p>`}</div>
      <div class="x-card"><h3 class="x-h3">Trades today</h3>${trades.length ? `<ul class="x-items" data-testid="trades">${trades.join("")}</ul>` : `<p class="x-empty" data-testid="trades-empty">None.</p>`}</div>
    </div>`;
    root.querySelectorAll<HTMLButtonElement>("[data-cancel]").forEach((b) =>
      b.addEventListener("click", async () => {
        await api.post("/api/orders/cancel", { mode: S.mode, orderId: b.dataset.cancel });
        void ordersView(root);
      }),
    );
  } catch (e) {
    root.innerHTML = `<div class="x-page"><p class="x-err">${esc(errText(e))}</p></div>`;
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
  if (S.tab !== "safety") return;
  root.innerHTML = `
  <div class="x-page x-page--grid">
  <section class="x-card x-card--danger">
    <div class="x-card__top"><span>Emergency</span><span class="x-badge ${S.mode === "live" ? "x-badge--live" : ""}">${S.mode.toUpperCase()}</span></div>
    <h2 class="x-rh x-rh--sm">Kill switches</h2>
    <label class="x-switch"><input type="checkbox" id="ks" role="switch" ${s.killSwitch ? "checked" : ""} data-testid="kill-toggle"><span class="x-switch__t" aria-hidden="true"></span><span>Kill switch: block every new trade <small>exits still allowed</small></span></label>
    <button type="button" class="x-buy x-wide x-buy--light" id="cancelAll" data-testid="cancel-all">Cancel all open orders (${S.mode})</button>
    <form id="exitAll" class="x-exit">
      <input id="exitPhrase" class="x-in" placeholder="type EXIT ALL" aria-label="Type EXIT ALL" data-testid="exit-phrase" autocomplete="off">
      <button class="x-buy x-confirm--live" type="submit" data-testid="exit-all">Exit all positions (${S.mode})</button>
    </form>
    <p class="x-fine">Exit all cancels open orders, then closes each F&O/intraday position with protective IOC limit orders (never market orders). Delivery holdings are left alone.</p>
    <div id="killRes"></div>
  </section>
  <section class="x-card">
    <div class="x-card__top"><span>Optional · off by default</span></div>
    <h2 class="x-rh x-rh--sm">Limits</h2>
    <form id="caps" class="x-caps">
      <label>Max loss per trade (₹)<input id="cap1" class="x-in" inputmode="decimal" placeholder="off" value="${s.risk.perTradeCap ?? ""}" data-testid="cap-trade"></label>
      <label>Daily loss cap (₹)<input id="cap2" class="x-in" inputmode="decimal" placeholder="off" value="${s.risk.dailyLossCap ?? ""}" data-testid="cap-day"></label>
      <button class="x-buy" type="submit">Save</button>
    </form>
    <p class="x-fine">Enforced ${S.demo ? "on every demo order" : "by the gateway on every order"}. Also enforced: limit orders only, ≤ ${s.risk.maxOrdersPerSecond} orders/second (SEBI's retail threshold is 10), price within ${(s.risk.maxSlippage * 100).toFixed(0)}% of the ${S.demo ? "recorded" : "live"} quote, market hours from the official holiday list.</p>
  </section>
  <section class="x-card">
    <div class="x-card__top"><span>Broker</span></div>
    <h2 class="x-rh x-rh--sm">${S.demo ? "No broker in the demo" : esc(s.broker.name)}</h2>
    <p>${S.demo ? "The demo never connects to a broker. Sign in to your own gateway to log in to Upstox." : s.broker.loggedIn ? `Logged in as <b>${esc(s.broker.userId ?? "")}</b> until ${s.broker.expiresAt ? esc(istClock(s.broker.expiresAt)) : "?"} (Upstox tokens end at 03:30 IST daily)` : "Not logged in"}</p>
    <div class="x-btnrow">
      <button type="button" class="x-buy" id="bLogin" ${S.demo ? "disabled" : ""}>Log in to ${esc(S.demo ? "Upstox" : s.broker.name)}</button>
      <button type="button" class="x-edit" id="bRequest" ${S.demo ? "disabled" : ""}>Send login request to my phone</button>
      ${s.broker.loggedIn ? `<button type="button" class="x-edit" id="bLogout">Log out of broker</button>` : ""}
    </div>
    <p class="x-fine">Your broker password, PIN and TOTP are typed only on the broker's own page. The gateway keeps the daily access token (encrypted at rest) and the API secret (environment variable).</p>
    <ul class="x-items" data-testid="brokers">${brokers.map((b) => `<li class="x-item"><div class="x-item__l"><b>${esc(b.name)}</b></div><span class="x-item__r">${b.status === "implemented" ? `<span class="x-state x-state--complete">implemented</span>` : `<span class="x-state">not implemented</span>`} ${b.docs ? `<a href="${esc(b.docs)}" rel="noopener" target="_blank">docs</a>` : ""}</span></li>`).join("")}</ul>
  </section>
  <section class="x-card">
    <div class="x-card__top"><span>Hash-chained</span></div>
    <h2 class="x-rh x-rh--sm">Audit log</h2>
    ${audit.length ? `<ol class="x-audit" data-testid="audit">${audit.map((a) => `<li><span class="x-mono">#${a.seq}</span><span>${esc(a.type)}</span><small>${esc(longDate(istDate(a.ts)))} ${esc(istClock(a.ts))}</small></li>`).join("")}</ol>` : `<p class="x-empty" data-testid="audit-empty">None.</p>`}
  </section>
  </div>`;
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
      $("#killRes").innerHTML = `<p class="x-err">${esc(errText(e))}</p>`;
    }
  });
  $("#exitAll").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      const r = await api.post<{ results: { inst: { symbol: string }; qty: number; filled: number; error?: string }[]; skipped: { key: string; reason: string }[] }>("/api/kill/exit-all", { mode: S.mode, confirm: $<HTMLInputElement>("#exitPhrase").value });
      $("#killRes").innerHTML = `<div data-testid="exit-result">${r.results.map((x) => `<p class="${x.error ? "x-err" : "ok"}">${esc(x.inst.symbol)}: closed ${x.filled}/${x.qty}${x.error ? ` · ${esc(x.error)}` : ""}</p>`).join("") || `<p class="x-grey">No open positions.</p>`}${r.skipped.map((x) => `<p class="x-fine">${esc(x.key)}: ${esc(x.reason)}</p>`).join("")}</div>`;
    } catch (e) {
      $("#killRes").innerHTML = `<p class="x-err">${esc(errText(e))}</p>`;
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
  if ((api.token || api.demo) && S.session) void refreshSession().catch(() => {});
}, 30_000);

void boot();
