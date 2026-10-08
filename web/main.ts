// Plain English India — the static frontend. It talks to the user's own gateway, or, in
// DEMO mode, to an in-browser stand-in that serves the recorded public fixtures (always
// labelled, paper only). Every price, lot size and expiry on screen comes from one of
// those; when something is not available the UI says so instead of showing a number.
//
// Look and motion: the sister app's (Plain-English-Options) design system, ported for real:
// its stylesheet is copied verbatim (web/styles.css), its icons, sparkline, chart, ring and
// motion helpers live in web/ui.ts and web/motion.ts, and the markup below uses its classes.

import "./styles.css";
import { api, ApiError, defaultGateway } from "./api.ts";
import { ICON, sparkSvg, changeText, ringHtml, chartSvg, axisHtml, placePopover, dismissable, reducedMotion, popIn, popOut, setText, fillRange } from "./ui.ts";
import { escapeHtml as esc, inr, inr2, num, pct, signedInr, parseRupees } from "../src/core/money.ts";
import { istClock, shortDate, dayDiff, istDate, longDate } from "../src/core/ist.ts";
import { parseView, sentence, type ParsedView } from "../src/core/sentence.ts";
import { suggest, describeFail, payoffCurve, legsPayoff, type Suggestion, type View, type Kind } from "../src/core/strategy.ts";
import { CHARGE_LABELS, type ChargeBreakdown } from "../src/core/charges.ts";
import { parseEquity, equityTicket, type EquityTicket, type ParsedEquity } from "../src/core/equity.ts";
import { smile, ivAt, strikeStep, type Chain, type Quote } from "../src/core/chain.ts";
import { probAbove, yearsTo } from "../src/core/math.ts";
import type { Category, ExpiryInfo, Instrument, Venue } from "../src/core/instruments.ts";
import { maxPerOrder } from "../src/core/rules.ts";
import { venueHours } from "../src/core/calendar.ts";

const DEMO_LABEL = "DEMO · recorded prices from 8 Oct 2026 · no broker, no orders";

// ── state ────────────────────────────────────────────────────────────
interface Underlying {
  id: string;
  label: string;
  index: boolean;
  category?: Category;
  exchange: string;
  venue?: Venue;
  lotSize: number | null;
  unit?: string | null;
  hasOptions?: boolean;
  futures?: { key: string; symbol: string; expiryDate: string }[];
  spotKey: string | null;
  expiries: ExpiryInfo[];
}
interface MarketS { exchange: string; market?: string; venue?: Venue; state: string; canTrade: boolean; label: string; opensAt: number | null; closesAt?: number | null }
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
  venues?: MarketS[];
  liveBlocked?: Record<string, string>;
  confirmPhrase: string;
}
interface Spot { ltp: number | null; changePct: number | null; spark: number[] | null }
type Tab = "options" | "stocks" | "portfolio" | "orders" | "safety";
type PopKey = "u" | "d" | "l" | "e" | "r" | "eside" | "esize" | "estock" | "eprod";

const CATS: { id: Category; label: string }[] = [
  { id: "index", label: "Indices" },
  { id: "stock", label: "Stocks" },
  { id: "metal", label: "Metals" },
  { id: "energy", label: "Energy" },
  { id: "currency", label: "Currency" },
];
const catOf = (u: Underlying | undefined): Category => u?.category ?? (u?.index ? "index" : "stock");

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
  cat: null as Category | null, // category shown in the underlying picker (defaults to the current one)
  eqCat: "fo" as "fo" | "all",
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
  t.classList.toggle("is-err", kind === "err");
  t.hidden = false;
  clearTimeout((t as unknown as { _t?: number })._t);
  (t as unknown as { _t?: number })._t = window.setTimeout(() => (t.hidden = true), 5000);
}

// ── shell: floating balance pill on top, view, dock below (sister app layout) ──
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "options", label: "Options", icon: ICON.build },
  { id: "stocks", label: "Stocks", icon: ICON.swap },
  { id: "portfolio", label: "Portfolio", icon: ICON.bars },
  { id: "orders", label: "Orders", icon: ICON.history },
  { id: "safety", label: "Safety", icon: ICON.shield },
];

function shell(): void {
  document.body.classList.add("x-app");
  app.innerHTML = `
  ${S.demo ? `<div class="x-demo" data-testid="demo-bar" role="note"><span><b>DEMO</b> · recorded prices from 8 Oct 2026 · no broker, no orders</span><button type="button" id="exitDemo">Exit demo</button></div>` : ""}
  <main class="x-root">
    <div class="x-top" id="brokerSlot"></div>
    <div id="view"></div>
    <p class="x-foot">Defined-risk spreads · limit orders only · kill switch and Exit all on the Safety tab · not investment advice · <a href="https://github.com/Hasen1506/Plain--English---India" rel="noopener" target="_blank">source</a></p>
  </main>
  <nav class="x-dock" aria-label="Sections">
    <span class="x-tabs" role="tablist">
      ${TABS.map((t) => `<button type="button" class="x-ic${S.tab === t.id ? " is-on" : ""}" role="tab" data-tab="${t.id}" aria-label="${t.label}" title="${t.label}" aria-selected="${S.tab === t.id}">${t.icon}</button>`).join("")}
    </span>
    <span class="x-toast" id="toast" role="status" hidden></span>
    <span class="x-sep" id="dockSep" hidden></span>
    <button type="button" class="x-buy" id="primary" data-testid="dock-primary" hidden></button>
  </nav>`;
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
  app.querySelectorAll<HTMLElement>("[data-tab]").forEach((x) => {
    const on = x.dataset.tab === t;
    x.setAttribute("aria-selected", String(on));
    x.classList.toggle("is-on", on);
  });
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
  if (!b.querySelector("#dockAmt")) b.innerHTML = `<span>Review<span class="x-for"> for</span> <span id="dockAmt"></span></span><span class="x-arr">→</span>`;
  const amt = $("#dockAmt", b);
  if (sg) setText(amt, inr(sg.worstMaxLoss), { animate: true });
  else amt.textContent = "…";
}

/** The venue whose hours apply to what is on screen. */
function curVenue(): Venue {
  if (S.tab === "stocks") return "NSE";
  const u = curU();
  return u?.venue ?? (u?.exchange === "BSE" ? "BFO" : "NFO");
}

function venueSession(v: Venue): MarketS | undefined {
  const s = S.session;
  if (!s) return undefined;
  const fromVenues = s.venues?.find((m) => m.venue === v);
  if (fromVenues) return fromVenues;
  const ex = v === "BFO" || v === "BSE" ? "BSE" : "NSE";
  return s.markets.find((m) => m.exchange === ex && m.market === (v === "NSE" || v === "BSE" ? "EQ" : "FO"));
}

/** Top pill: broker + mode (the sister app's balance pill). Paper/Live is spelled out under the name. */
function topPill(): void {
  const s = S.session;
  const slot = $("#brokerSlot");
  if (!slot) return;
  const live = S.mode === "live";
  document.body.classList.toggle("is-live", live);
  if (!s) {
    slot.innerHTML = `<span class="x-bal"><span class="x-bal__t"><span>Not connected</span></span></span>`;
    return;
  }
  const b = s.broker;
  const modeLine = live ? `<small class="x-bal__live" data-testid="live-banner">LIVE · real money</small>` : `<small data-testid="paper-banner">Paper · ${S.demo ? "recorded prices, no orders" : "nothing is sent to the broker"}</small>`;
  if (S.demo) slot.innerHTML = `<span class="x-bal" data-testid="broker-chip"><span class="x-bal__t"><span>Demo · no broker</span>${modeLine}</span><i>+</i><span class="x-av" aria-hidden="true"></span></span>`;
  else if (b.loggedIn) slot.innerHTML = `<span class="x-bal" data-testid="broker-chip" title="Upstox tokens end at 03:30 IST daily"><span class="x-bal__t"><span>${esc(b.name)}${b.sandbox ? " sandbox" : ""} · ${esc(b.userId ?? "")}</span>${modeLine}</span><i>${b.expiresAt ? esc(istClock(b.expiresAt).replace(" IST", "")) : "+"}</i><span class="x-av" aria-hidden="true"></span></span>`;
  else slot.innerHTML = `<button type="button" class="x-bal" id="brokerLogin" data-testid="broker-chip"><span class="x-bal__t"><span>Log in to ${esc(b.name)}</span>${modeLine}</span><i>+</i><span class="x-av" aria-hidden="true"></span></button>`;
  $("#brokerLogin", slot)?.addEventListener("click", brokerLogin);
}

/**
 * The tag row above the sentence (sister app .x-tags): what kind of trade, the price, the
 * market and price status, and the Paper/Live switch in the same pill switch the sister app
 * uses for Testnet/Mainnet. Live adds a red note under it and a red ring on the top pill.
 */
function tagsHtml(o: { kind?: string; spot?: boolean }): string {
  const s = S.session!;
  const v = curVenue();
  const m = venueSession(v);
  const market = S.demo
    ? v === "MCX"
      ? "Recorded session · MCX 8 Oct 2026"
      : v === "CDS"
        ? "Recorded · 8 Oct 2026"
        : "Recorded session · 8 Oct 2026"
    : m
      ? `${m.label}${!m.canTrade && m.opensAt ? ` · opens ${shortDate(istDate(m.opensAt)).replace(",", "")} ${istClock(m.opensAt).replace(" IST", "")}` : ""}`
      : "Market hours unknown";
  const ok = S.demo || Boolean(m?.canTrade);
  const liveOk = s.liveTrading && s.broker.loggedIn && !S.demo;
  const blocked = s.liveBlocked?.[v === "MCX" ? "MCX_FO" : v === "CDS" ? "NCD_FO" : ""];
  const liveWhy = S.demo ? "The demo is paper only" : !s.liveTrading ? "Live trading is disabled on your gateway (LIVE_TRADING_ENABLED)" : !s.broker.loggedIn ? "Log in to the broker first" : (blocked ?? "");
  return `<div class="x-tags">
      ${o.kind !== undefined ? `<span class="x-tag x-tag--dark" id="kindTag" data-testid="strategy">${esc(o.kind)}</span>` : ""}
      ${o.spot ? `<span class="x-tag${S.chain ? "" : " is-sim"}" id="spotTag"><b>●</b> <span id="spotName">${esc(underlyingLabel(S.view.underlying))}</span> <span data-testid="spot" id="spotVal">${S.chain ? lvl(S.chain.spot, 2) : "…"}</span></span>` : ""}
      <span class="x-tag${ok ? "" : " is-sim"}" id="statusTag"><b>●</b> <span data-testid="market-chip" title="${esc(s.holidays.source ?? "")}">${esc(market)}</span>${o.spot ? `<span class="x-tag__sep"> · </span><span data-testid="chain-meta" id="chainMeta"></span>` : ""}</span>
      <span class="x-seg x-seg--mode" role="group" aria-label="Trading mode"><button type="button" data-mode="paper" aria-pressed="${S.mode === "paper"}">Paper</button><button type="button" data-mode="live" aria-pressed="${S.mode === "live"}" ${liveOk && !blocked ? "" : `disabled title="${esc(liveWhy)}"`}>Live</button></span>
      ${s.killSwitch ? `<span class="x-tag is-kill" data-testid="kill-chip"><b>●</b> Kill switch on</span>` : ""}
    </div>
    ${S.mode === "live" ? `<p class="x-amber x-amber--live" role="note">Live: orders go to ${esc(s.broker.name)} with real money.</p>` : ""}`;
}

function wireTags(root: ParentNode): void {
  root.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((x) =>
    x.addEventListener("click", () => {
      if (x.disabled || S.mode === x.dataset.mode) return;
      S.mode = x.dataset.mode as "paper" | "live";
      topPill();
      if (S.review) openReview(S.review);
      else render();
    }),
  );
}

function chips(): void {
  topPill();
  // keep the status tag current without re-rendering the page (market open/close, kill switch)
  const tags = document.querySelector(".x-tags");
  if (tags && S.session && S.tab !== "options") {
    const wrap = document.createElement("div");
    wrap.innerHTML = tagsHtml({ kind: tags.querySelector("#kindTag")?.textContent ?? undefined });
    const fresh = wrap.querySelector(".x-tags")!;
    if (fresh.innerHTML !== tags.innerHTML) {
      tags.replaceWith(fresh);
      wireTags(fresh.parentElement!);
    }
  } else if (tags && S.session) {
    const st = $("#statusTag"), wrap = document.createElement("div");
    wrap.innerHTML = tagsHtml({ kind: "", spot: true });
    const nst = wrap.querySelector("#statusTag")!;
    const mc = nst.querySelector("[data-testid=market-chip]")!;
    const cur = st?.querySelector("[data-testid=market-chip]");
    if (cur && cur.textContent !== mc.textContent) cur.textContent = mc.textContent;
    st?.classList.toggle("is-sim", nst.classList.contains("is-sim"));
    const hasKill = Boolean(tags.querySelector("[data-testid=kill-chip]"));
    if (hasKill !== Boolean(S.session.killSwitch)) {
      if (S.session.killSwitch) tags.insertAdjacentHTML("beforeend", `<span class="x-tag is-kill" data-testid="kill-chip"><b>●</b> Kill switch on</span>`);
      else tags.querySelector("[data-testid=kill-chip]")?.remove();
    }
  }
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
  document.body.classList.remove("is-live");
  app.innerHTML = `
  <main class="x-root x-gate">
    <div class="x-top"><span class="x-bal x-bal--brand"><span class="x-bal__t"><span>Plain English India</span><small>options, stocks, commodities</small></span><i>₹</i><span class="x-av" aria-hidden="true"></span></span></div>
    <section class="x-builder x-gate__b">
      <h1 class="x-sent">Say what you think <span class="x-pill x-lav x-pill--static">Nifty</span> will do. Get a <span class="x-pill x-mint x-pill--static">defined‑risk</span> trade on <span class="x-pill x-amt x-pill--static">your own</span> broker.</h1>
    </section>
    <div class="x-review x-gate__grid">
      <form id="connect" class="x-card" autocomplete="on">
        <div class="x-card__top"><span>Your gateway</span></div>
        <h2 class="x-rh x-rh--sm">Sign in</h2>
        <label for="gwUrl">Your gateway URL</label>
        <input id="gwUrl" class="x-in" name="url" required placeholder="https://gateway.example.in" value="${esc(defaultGateway())}" autocomplete="url">
        <label for="gwPass">Gateway passphrase</label>
        <input id="gwPass" class="x-in" name="pass" type="password" required autocomplete="current-password">
        <button class="x-buy x-confirm x-gate__go" type="submit"><span>Sign in</span><span class="x-arr">→</span></button>
        ${msg ? `<p class="x-hint" role="alert">${esc(msg)}</p>` : ""}
        <p class="x-pop__note x-left">The gateway is the small server you run on a static-IP VPS (SEBI requires API orders to come from a whitelisted static IP). Your broker password, PIN and TOTP are only ever typed on the broker's own login page.</p>
      </form>
      <div class="x-card x-gate__demo">
        <div class="x-card__top"><span>No gateway yet?</span><span class="x-mode is-demo">DEMO</span></div>
        <h2 class="x-rh x-rh--sm">Try the demo</h2>
        <p class="x-empty">The full app on prices recorded on <b>Thu 8 Oct 2026</b>: NSE option chains at 10:39 IST and MCX commodity option chains at 16:13–16:14 IST. No broker, no orders, paper trades only.</p>
        <button type="button" class="x-buy x-confirm" id="tryDemo" data-testid="try-demo"><span>Try the demo</span><span class="x-arr">${ICON.play}</span></button>
        <p class="x-pop__note x-left">${DEMO_LABEL}</p>
      </div>
    </div>
  </main>`;
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
  app.innerHTML = `<main class="x-root"><p class="x-empty x-loading">Loading the recorded 8 Oct 2026 prices…</p></main>`;
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
  topPill();
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

/** Decimals for levels of the current underlying: from its strike grid (USDINR 0.25 → 2, Zinc 2.5 → 1). */
function levelDp(): number {
  const st = S.chain ? strikeStep(S.chain) : 0;
  if (!st || st >= 1) return 0;
  return Math.min(4, String(st).split(".")[1]?.length ?? 0);
}
const lvl = (x: number, dp = levelDp()): string => num(x, catOf(curU()) === "currency" ? Math.max(dp, 2) : dp);

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

function pctMove(level: number): { text: string; down: boolean } | null {
  const sp = S.chain?.spot;
  if (!sp || !Number.isFinite(level)) return null;
  const d = (level / sp - 1) * 100;
  return { text: `${d >= 0 ? "↑" : "↓"}${Math.abs(d).toFixed(1)}%`, down: d < 0 };
}

function pillInner(k: "u" | "d" | "l" | "e" | "r"): string {
  const v = S.view;
  if (k === "u") return `<span id="pk_u">${esc(underlyingLabel(v.underlying) || "—")}</span>`;
  if (k === "d") return `<span id="pk_d">${dirLabel(v)}</span>${v.dir === "above" ? ICON.up : ICON.down}`;
  if (k === "l") {
    const m = Number.isFinite(v.level) ? pctMove(v.level) : null;
    return `<span id="pk_l"${Number.isFinite(v.level) ? "" : ' class="x-ph"'}>${Number.isFinite(v.level) ? lvl(v.level) : "level"}</span><span class="x-pct${m?.down ? " is-down" : ""}" id="pk_lp"${m ? "" : " hidden"}>${m?.text ?? ""}</span>`;
  }
  if (k === "e") return `<span id="pk_e"${v.expiryDate ? "" : ' class="x-ph"'}>${v.expiryDate ? esc(shortD(v.expiryDate)) : curU()?.hasOptions === false ? "no options" : "expiry"}</span>`;
  return `<span id="pk_r"${Number.isFinite(v.risk) && v.risk > 0 ? "" : ' class="x-ph"'}>${Number.isFinite(v.risk) && v.risk > 0 ? inr(v.risk) : "₹ amount"}</span>`;
}

const PILL_META: Record<"u" | "d" | "l" | "e" | "r", { cls: string; label: string }> = {
  u: { cls: "x-lav", label: "Underlying" },
  d: { cls: "x-sal", label: "Direction" },
  l: { cls: "x-mint", label: "Level" },
  e: { cls: "x-lav", label: "Expiry" },
  r: { cls: "x-amt", label: "Amount you are risking in rupees" },
};
const pill = (k: "u" | "d" | "l" | "e" | "r"): string =>
  `<button type="button" class="x-pill ${PILL_META[k].cls}" id="p_${k}" data-pop="${k}" aria-haspopup="dialog" aria-expanded="false" aria-label="${PILL_META[k].label}">${pillInner(k)}${k === "d" ? "" : ICON.chev}</button>`;

function optionsView(root: HTMLElement): void {
  root.innerHTML = `
  <section class="x-builder" id="builder" aria-label="Build an options trade">
    ${tagsHtml({ kind: "Defined-risk spread", spot: true })}
    <h1 class="x-sent" data-testid="sentence">I think ${pill("u")} ${pill("d")} ${pill("l")} by ${pill("e")}, risking ${pill("r")}</h1>
    <div class="x-quote" id="quote" aria-live="polite"></div>
    <p class="x-hint" id="hint" hidden></p>
    <div id="sugs" class="x-sugs"></div>
    <div id="nlNotes" class="x-notes-box"></div>
    <form id="nl" class="x-nl">
      <input id="nlText" class="x-in" aria-label="Your view in plain English" placeholder="Or type it: Nifty stays above 25,000 till Tuesday, risking ₹5,000" autocomplete="off">
      <button class="x-edit" type="submit">Read it</button>
    </form>
    <div class="x-pop" id="pop" role="dialog" hidden></div>
  </section>`;
  wireTags(root);
  $("#nl").addEventListener("submit", (ev) => {
    ev.preventDefault();
    readSentence(String($<HTMLInputElement>("#nlText").value));
  });
  root.querySelectorAll<HTMLButtonElement>(".x-sent [data-pop]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePop(b.dataset.pop as PopKey, b);
    }),
  );
  metaTag();
  renderSuggestions();
  void loadChain();
}

/** Update the pills in place: numbers roll, pills spring to their new width (sister app renderBuilder). */
function refreshPills(roll = false): void {
  const v = S.view;
  const set = (k: "u" | "d" | "l" | "e" | "r", text: string, ph: boolean, animate = false) => {
    const el = $(`#pk_${k}`);
    if (!el) return;
    el.classList.toggle("x-ph", ph);
    setText(el, text, { animate, pill: $(`#p_${k}`) });
  };
  set("u", underlyingLabel(v.underlying) || "—", false);
  const dEl = $("#pk_d");
  if (dEl) {
    setText(dEl, dirLabel(v), { pill: $("#p_d") });
    const ic = $("#p_d")?.querySelector("svg");
    if (ic) ic.outerHTML = v.dir === "above" ? ICON.up : ICON.down;
  }
  set("l", Number.isFinite(v.level) ? lvl(v.level) : "level", !Number.isFinite(v.level), roll);
  const lp = $("#pk_lp");
  if (lp) {
    const m = Number.isFinite(v.level) ? pctMove(v.level) : null;
    lp.hidden = !m;
    lp.classList.toggle("is-down", Boolean(m?.down));
    if (m) setText(lp, m.text, { animate: roll, pill: $("#p_l") });
  }
  set("e", v.expiryDate ? shortD(v.expiryDate) : curU()?.hasOptions === false ? "no options" : "expiry", !v.expiryDate);
  set("r", Number.isFinite(v.risk) && v.risk > 0 ? inr(v.risk) : "₹ amount", !(Number.isFinite(v.risk) && v.risk > 0), roll);
}

function metaTag(): void {
  const meta = $("#chainMeta"), sp = $("#spotVal"), name = $("#spotName"), tag = $("#spotTag");
  if (!meta) return;
  const v = S.view;
  if (name) name.textContent = underlyingLabel(v.underlying);
  if (sp) setText(sp, S.chain ? lvl(S.chain.spot, 2) : "…", { animate: true });
  tag?.classList.toggle("is-sim", !S.chain);
  const st = $("#statusTag");
  if (S.chain) {
    st?.classList.remove("is-amber");
    meta.textContent = S.demo ? `Recorded ${/(\d\d:\d\d IST)/.exec(S.chain.source)?.[1] ?? ""}`.trim() : `Live · ${istClock(S.chain.fetchedAt)}`;
    meta.title = S.chain.source;
  } else if (S.chainError) {
    st?.classList.add("is-amber");
    meta.textContent = `Prices unavailable · ${S.chainError}`;
  } else {
    st?.classList.remove("is-amber");
    meta.textContent = "Loading prices…";
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
  const uChanged = v.underlying !== S.view.underlying;
  S.view = v;
  S.pick = null;
  if (changed) S.chain = null;
  if (uChanged) return rerenderBuilder(() => showNotes(p));
  refreshPills();
  metaTag();
  showNotes(p);
  void loadChain();
}

function showNotes(p: ParsedView): void {
  const miss = p.missing.map((m) => ({ underlying: "which index, stock or commodity", direction: "up or down (e.g. 'stays above')", level: "the level", expiry: "which expiry", risk: "how much you're risking (₹)" })[m]);
  const box = $("#nlNotes");
  if (box) box.innerHTML = [...(miss.length ? [`I couldn't find ${miss.join(", ")}. Set it in the sentence above.`] : []), ...p.notes].map((n) => `<p class="note x-warn">${esc(n)}</p>`).join("");
}

/** A new underlying can change the venue (hours, live rules): rebuild the builder, keep the typed notes. */
function rerenderBuilder(after?: () => void): void {
  const v = $("#view");
  if (!v) return;
  optionsView(v);
  after?.();
}

let chainTimer = 0;
async function loadChain(): Promise<void> {
  clearTimeout(chainTimer);
  const v = S.view;
  const u = curU();
  if (u && u.hasOptions === false) {
    S.chain = null;
    S.chainError = futuresOnlyText(u);
    metaTag();
    renderSuggestions();
    return;
  }
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
      const raw = S.view.dir === "above" ? Math.floor((c.spot * 0.994) / step) * step : Math.ceil((c.spot * 1.006) / step) * step;
      S.view = { ...S.view, level: Number(raw.toFixed(4)) };
    }
  } catch (e) {
    if (v.underlying !== S.view.underlying || v.expiryDate !== S.view.expiryDate) return;
    S.chain = null;
    S.chainError = errText(e);
  }
  if (S.tab !== "options" || S.review) return;
  metaTag();
  refreshPills(true);
  renderSuggestions();
  if (S.pop === "l" || S.pop === "e") renderPopBody();
  chainTimer = window.setTimeout(() => void loadChain(), S.demo ? 30_000 : 5000);
}

function futuresOnlyText(u: Underlying): string {
  const f = u.futures?.[0];
  return `${u.label} has futures only on ${u.exchange === "MCX" ? "MCX" : "NSE"} (no options listed${f ? `; nearest ${f.symbol}` : ""}), so there is no defined-risk options trade to build`;
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

function setKind(t: string): void {
  const k = $("#kindTag");
  if (k) setText(k, t);
}

function renderSuggestions(): void {
  const box = $("#sugs"), quote = $("#quote");
  if (!box || !quote) return;
  quote.removeAttribute("data-testid");
  const v = S.view;
  S.suggestions = [];
  const u = curU();
  if (u && u.hasOptions === false) {
    quote.innerHTML = `<span class="x-cost"><span class="x-cost__l">Futures only</span></span><span class="x-grey">No options listed for ${esc(u.label)}</span>`;
    box.innerHTML = `<p class="x-warn" data-testid="no-prices">${esc(futuresOnlyText(u))}.</p>${futuresList(u)}`;
    setKind("Futures only");
    dock();
    return;
  }
  if (!complete(v)) {
    quote.innerHTML = `<span class="x-cost"><span class="x-cost__l">Pick a level and how much you're risking</span></span>`;
    box.innerHTML = S.chain || !S.chainError ? "" : `<p class="x-warn" data-testid="no-prices">No trades shown: ${esc(S.chainError)}.</p>`;
    setKind("Defined-risk spread");
    dock();
    return;
  }
  if (!S.chain) {
    quote.innerHTML = `<span class="x-cost"><span class="x-cost__l">It risks</span> <b>…</b></span><span class="x-grey">${S.chainError ? "No prices" : "Waiting for prices"}</span>`;
    box.innerHTML = `<p class="x-warn" data-testid="no-prices">No trades shown: ${esc(S.chainError ?? "waiting for live prices")}.</p>`;
    dock();
    return;
  }
  const r = suggest(v, S.chain, { now: gwNow(), slippage: Math.min(0.02, S.session?.risk.maxSlippage ?? 0.02) });
  S.suggestions = r.suggestions;
  const sg = chosen();
  const fails = r.failures.map((f) => `<p class="x-warn" data-testid="sug-fail"><b>${esc(f.kind.replace(/-/g, " "))}</b>: ${esc(describeFail(f.fail))}</p>`).join("");
  if (!sg) {
    quote.innerHTML = `<span class="x-cost"><span class="x-cost__l">No trade fits</span></span>`;
    box.innerHTML = fails;
    setKind("Defined-risk spread");
    dock();
    return;
  }
  setKind(sg.title);
  let cost = $("#qCost"), ch = $("#qChance");
  if (!cost || !ch) {
    // reads as one sentence for screen readers and tests: "It risks ₹X · Y% chance of profit"
    quote.innerHTML = `<span class="x-cost"><span class="x-cost__l">It risks</span> <b id="qCost"></b><span class="x-sr"> · </span></span><span class="x-grey"><span id="qChance"></span> chance of profit<span class="x-sr"> · </span></span><span class="x-grey x-hide-s" id="qMeta"></span>`;
    cost = $("#qCost");
    ch = $("#qChance");
  }
  quote.setAttribute("data-testid", "summary");
  setText(cost, inr(Math.round(sg.worstMaxLoss)), { animate: true });
  setText(ch, sg.probProfit === null ? "unknown" : `${Math.round(sg.probProfit * 100)}%`, { animate: true });
  $("#qMeta").textContent = `${sg.lots} lot${sg.lots === 1 ? "" : "s"} × ${sg.lotSize} · ${sg.credit ? `${inr(Math.abs(sg.netPerUnit) * sg.qty)} credit` : `${inr(Math.abs(sg.netPerUnit) * sg.qty)} debit`}`;
  const other = S.suggestions.find((x) => x !== sg);
  box.innerHTML = `
    <div class="x-trade" data-testid="suggestion">
      ${sg.legs.map((l) => `<span class="x-legtag"><b class="${l.side === "BUY" ? "x-up" : "x-dn"}">${l.side === "BUY" ? "Buy" : "Sell"}</b> ${esc(l.inst.symbol)}</span>`).join("")}
      <span class="x-legtag">Max loss <b data-testid="max-loss">${inr(sg.maxLoss)}</b></span>
      <button type="button" class="x-link" data-review="${esc(sg.id)}">Review</button>
    </div>
    ${other ? `<button type="button" class="x-alt" id="alt" data-testid="alt-suggestion"><span>Other way: <b>${esc(other.title)}</b></span><span class="x-grey">risks ${inr(other.worstMaxLoss)} · ${other.probProfit === null ? "chance unknown" : `${pct(other.probProfit)} chance`}</span></button>` : ""}
    ${sg.warnings.map((w) => `<p class="x-warn">${esc(w)}</p>`).join("")}
    ${fails}`;
  $("#alt")?.addEventListener("click", () => {
    S.pick = other!.kind;
    renderSuggestions();
  });
  box.querySelector<HTMLButtonElement>("[data-review]")?.addEventListener("click", () => openReview(sg));
  dock();
}

function futuresList(u: Underlying): string {
  if (!u.futures?.length) return "";
  return `<div class="x-card x-futs"><div class="x-card__top"><span>Listed futures · lot ×${u.lotSize ?? "?"}${u.unit ? ` · priced per ${esc(u.unit)}` : ""}</span></div><ul class="x-poslist">${u.futures
    .map((f) => {
      const sp = S.spots.get(u.id);
      return `<li class="x-leg"><span><b class="x-mono">${esc(f.symbol)}</b><small>expires ${esc(longDate(f.expiryDate))}</small></span><b>${f === u.futures![0] && sp?.ltp ? num(sp.ltp) : ""}</b></li>`;
    })
    .join("")}</ul><p class="x-pop__note x-left">This app builds defined-risk option spreads only; it does not trade futures.</p></div>`;
}

// ── popovers (sister app: anchored under the pill, spring in, fade out) ──
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
  S.cat = null;
  if (pop && !pop.hidden) {
    popOut(pop);
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
  renderPopBody(false);
  const ox = placePopover(pop, anchor, pop.parentElement!);
  popIn(pop, ox);
  popDispose = dismissable(pop, anchor, closePop);
  const sel = pop.querySelector<HTMLElement>(".is-sel");
  const list = pop.querySelector<HTMLElement>(".x-list");
  if (sel && list && list.scrollHeight > list.clientHeight) list.scrollTop = Math.max(0, sel.offsetTop - list.clientHeight / 2);
  const first = pop.querySelector<HTMLElement>("input:not([type=range]), .is-sel, .x-list button");
  if (first && !matchMedia("(pointer: coarse)").matches) first.focus({ preventScroll: true });
  fitPop(pop);
  if (k === "u") void loadSpots();
  if (k === "e") void loadExpiryChances();
}

function renderPopBody(fit = true): void {
  const pop = $("#pop");
  if (!pop || !S.pop) return;
  const k = S.pop;
  if (k === "u") popUnderlying(pop);
  else if (k === "d") popDirection(pop);
  else if (k === "l") popLevel(pop);
  else if (k === "e") popExpiry(pop);
  else if (k === "r") popRisk(pop);
  else popStocks(pop, k);
  if (fit) fitPop(pop);
}

/**
 * Keep the whole popover above the dock: scroll the page, and when a short page cannot scroll
 * that far (long MCX lists on small phones) shorten the list instead. offsetHeight, not the
 * rect, because the pop-in scale would under-measure it.
 */
function fitPop(pop: HTMLElement): void {
  const room = window.innerHeight - 96;
  const over = () => pop.getBoundingClientRect().top + pop.offsetHeight - room;
  if (over() > 0) window.scrollBy({ top: over(), behavior: "auto" });
  const list = pop.querySelector<HTMLElement>(".x-list");
  if (list && over() > 0) list.style.maxHeight = `${Math.max(150, list.clientHeight - over())}px`;
}

function commit(next: Partial<View>, opts: { reload?: boolean; close?: boolean } = {}): void {
  S.view = { ...S.view, ...next };
  S.pick = null;
  if (opts.reload) {
    S.chain = null;
    S.chainError = null;
    metaTag();
  }
  refreshPills();
  if (opts.close) closePop();
  renderSuggestions();
  if (opts.reload) void loadChain();
}

/** Rows like the sister app's list: `<li style="--i">` (staggered in), `.is-sel` black selected row. */
function listHtml(rows: { html: string; sel?: boolean; attr: string }[], cls = ""): string {
  return `<ul class="x-list${cls ? " " + cls : ""}">${rows.map((r, i) => `<li style="--i:${i}"><button type="button" ${r.attr}${r.sel ? ' class="is-sel" aria-current="true"' : ""}>${r.html}</button></li>`).join("")}</ul>`;
}

function catSeg(cur: Category, avail: Category[]): string {
  return `<span class="x-seg x-seg--cats" role="group" aria-label="Category">${CATS.filter((c) => avail.includes(c.id))
    .map((c) => `<button type="button" data-cat="${c.id}" aria-pressed="${c.id === cur}"><i class="x-dot x-cat--${c.id}" aria-hidden="true"></i>${c.label}</button>`)
    .join("")}</span>`;
}

function assetRow(u: Underlying): string {
  const sp = S.spots.get(u.id);
  const ch = sp?.changePct;
  const has = ch !== null && ch !== undefined && Number.isFinite(ch);
  const c = catOf(u);
  const changeEm = `<em class="${has ? (ch! >= 0 ? "x-up" : "x-dn") : ""}">${has ? changeText(ch!) : ""}</em><span class="x-sparkbox">${sparkSvg(sp?.spark)}</span>`;
  if (c === "index" || c === "stock") {
    return `<span class="x-arow"><i class="x-dot x-cat--${c}" aria-hidden="true"></i><b>${esc(u.label)}</b><small>${sp?.ltp ? num(sp.ltp) : "—"}</small></span>${changeEm}`;
  }
  // commodities and currency: two lines, so the lot and whether options exist are visible before picking
  const price = sp?.ltp ? num(sp.ltp, sp.ltp >= 1000 ? 0 : 2) : "no price";
  const what = u.hasOptions === false ? "futures only" : `${u.expiries.length} option expir${u.expiries.length === 1 ? "y" : "ies"}`;
  return `<span class="x-drow x-drow--dot"><b><i class="x-dot x-cat--${c}" aria-hidden="true"></i>${esc(u.label)}</b><small>${price} · lot ×${u.lotSize ?? "?"} · ${what}</small></span>${changeEm}`;
}

function popUnderlying(pop: HTMLElement): void {
  const cur = catOf(curU());
  const avail = CATS.map((c) => c.id).filter((c) => S.underlyings.some((u) => catOf(u) === c));
  const cat = S.cat && avail.includes(S.cat) ? S.cat : cur;
  const q = ($<HTMLInputElement>("#uSearch", pop)?.value ?? "").trim().toLowerCase();
  const inCat = S.underlyings.filter((u) => catOf(u) === cat);
  const match = (u: Underlying) => !q || u.label.toLowerCase().includes(q) || u.id.toLowerCase().includes(q);
  const shown = inCat.filter(match).slice(0, 80);
  const hadFocus = document.activeElement?.id === "uSearch";
  const notes: Record<Category, string> = {
    index: "NSE and BSE index options · cash settled",
    stock: "F&O stocks · physically settled",
    metal: "MCX options on futures · they devolve into the future at expiry",
    energy: "MCX options on futures · they devolve into the future at expiry",
    currency: "NSE currency options · cash settled at the RBI reference rate",
  };
  const foot = S.spotsNote ? esc(S.spotsNote) : S.demo ? (cat === "metal" || cat === "energy" ? "MCX prices recorded 8 Oct 2026 16:13–16:14 IST (mcxindia.com option chain). Futures-only contracts have no recorded price." : cat === "currency" ? "No recorded currency prices in the demo." : "Recorded 8 Oct 2026 snapshot: no day change or intraday chart in the recording.") : "Price, day change and chart when the broker reports them.";
  pop.innerHTML = `
    <p class="x-pop__cap">Choose what to trade · ${notes[cat]}</p>
    ${catSeg(cat, avail)}
    ${inCat.length > 8 ? `<label class="x-field x-field--search">${ICON.search}<input id="uSearch" aria-label="Search" placeholder="Search ${CATS.find((c) => c.id === cat)!.label.toLowerCase()}" value="${esc(q)}" autocomplete="off"></label>` : ""}
    ${shown.length ? listHtml(shown.map((u) => ({ html: assetRow(u), sel: u.id === S.view.underlying, attr: `data-u="${esc(u.id)}"` })), "x-list--assets").replace('<ul class="x-list', '<ul data-testid="pick-underlying" class="x-list') : `<p class="x-empty x-pad">Nothing matches.</p>`}
    <p class="x-pop__note">${foot}</p>`;
  pop.querySelectorAll<HTMLButtonElement>("[data-cat]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      S.cat = b.dataset.cat as Category;
      const inp = $<HTMLInputElement>("#uSearch", pop);
      if (inp) inp.value = "";
      popUnderlying(pop);
      const list = pop.querySelector<HTMLElement>(".x-list");
      if (list) list.scrollTop = 0;
    }),
  );
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
      const venueChanged = (u?.venue ?? "NFO") !== (curU()?.venue ?? "NFO");
      closePop();
      S.view = { ...S.view, underlying: id, level: NaN, expiryDate: u?.expiries[0]?.date ?? "" };
      S.pick = null;
      S.chain = null;
      S.chainError = null;
      if (venueChanged || S.mode === "live") rerenderBuilder();
      else commit({}, { reload: true });
    }),
  );
}

function popDirection(pop: HTMLElement): void {
  pop.innerHTML = `<p class="x-pop__cap">What do you think ${esc(underlyingLabel(S.view.underlying))} will do?</p>${listHtml(
    DIRS.map((x) => ({
      html: `<span class="x-drow"><b>${x.label}</b><small>${x.desc}</small></span><i class="x-diric ${x.d === "above" ? "is-up" : "is-dn"}">${x.d === "above" ? ICON.up : ICON.down}</i>`,
      sel: S.view.dir === x.d && S.view.mode === x.m,
      attr: `data-d="${x.d}-${x.m}"`,
    })),
  )}`;
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
  const m = pctMove(level)!;
  const p = chanceAt(c, level, S.view.dir);
  return `${m.text} from spot · ${p === null ? "chance unknown" : `${pct(p)} chance`} it settles ${S.view.dir}`;
}

/** Slider popover (sister app sliderPop): big field, filled range with a badge, end labels with the caption between. */
function sliderPop(pop: HTMLElement, o: { cap: string; tone: "amt" | "tgt"; prefix?: string; val: number; min: number; max: number; step: number; toRange?: (v: number) => number; fromRange?: (t: number) => number; l: string; r: string; info: string; inputLabel: string; rangeLabel: string; badge?: (v: number) => string; onSet: (v: number) => void; parse: (s: string) => number | null }): void {
  const toR = o.toRange ?? ((v: number) => v), fromR = o.fromRange ?? ((t: number) => t);
  pop.innerHTML = `
    <p class="x-pop__cap">${o.cap}</p>
    <label class="x-field">${o.prefix ? `<span>${o.prefix}</span>` : ""}<input type="text" inputmode="decimal" autocomplete="off" enterkeyhint="done" id="popIn" aria-label="${o.inputLabel}"><small>type or drag</small></label>
    <div class="x-rangewrap x-rangewrap--${o.tone}"><input class="x-range" type="range" id="popRg" aria-label="${o.rangeLabel}">${o.badge ? '<span class="x-badge" id="popBadge" aria-hidden="true"></span>' : ""}</div>
    <div class="x-ends"><span>${o.l}</span><b id="popInfo">${esc(o.info)}</b><span>${o.r}</span></div>`;
  const inp = $<HTMLInputElement>("#popIn", pop), rg = $<HTMLInputElement>("#popRg", pop);
  rg.min = String(toR(o.min));
  rg.max = String(toR(o.max));
  rg.step = String(o.toRange ? 1 : o.step);
  rg.value = String(toR(Math.min(o.max, Math.max(o.min, o.val))));
  inp.value = String(o.val);
  const badge = $("#popBadge", pop);
  const paint = (v: number) => {
    fillRange(rg);
    if (badge && o.badge) badge.textContent = o.badge(v);
  };
  paint(o.val);
  rg.addEventListener("input", () => {
    const v = fromR(Number(rg.value));
    inp.value = String(v);
    paint(v);
    o.onSet(v);
  });
  const typed = (): boolean => {
    const v = o.parse(inp.value);
    if (v === null || !(v > 0)) return false;
    rg.value = String(toR(Math.min(o.max, Math.max(o.min, v))));
    paint(v);
    o.onSet(v);
    return true;
  };
  inp.addEventListener("change", typed);
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      typed();
      closePop();
      popAnchor?.focus();
    }
  });
}

function popLevel(pop: HTMLElement): void {
  const c = S.chain;
  if (!c) {
    pop.innerHTML = `<p class="x-pop__cap">${esc(underlyingLabel(S.view.underlying))} · no live price</p><label class="x-field"><input id="popIn" inputmode="decimal" aria-label="Level value" value="${Number.isFinite(S.view.level) ? S.view.level : ""}" autocomplete="off"><small>type it</small></label><p class="x-pop__note">${esc(S.chainError ?? "Waiting for prices")}</p>`;
    const inp = $<HTMLInputElement>("#popIn", pop);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const x = Number(inp.value.replace(/[,₹\s]/g, ""));
        if (x > 0) commit({ level: x });
        closePop();
      }
    });
    return;
  }
  const step = strikeStep(c) || 50;
  const spot = c.spot;
  const lo = Math.floor((spot * 0.92) / step) * step, hi = Math.ceil((spot * 1.08) / step) * step;
  const v = Number.isFinite(S.view.level) ? S.view.level : spot;
  sliderPop(pop, {
    cap: `${esc(underlyingLabel(S.view.underlying))} ${S.demo ? "recorded at" : "now"} <b>${lvl(spot, 2)}</b>${c.source.includes("MCX") ? " (futures)" : ""}`,
    tone: "tgt",
    val: v,
    min: lo,
    max: hi,
    step,
    l: lvl(lo),
    r: lvl(hi),
    info: levelInfo(v),
    inputLabel: "Level value",
    rangeLabel: "Level slider",
    badge: (x) => pctMove(x)?.text ?? "",
    parse: (s) => {
      const x = Number(s.replace(/[,₹\s]/g, ""));
      return Number.isFinite(x) ? x : null;
    },
    onSet: (x) => {
      const info = $("#popInfo", pop);
      if (info) info.textContent = levelInfo(x);
      commit({ level: x });
    },
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
  if (!ex.length) {
    pop.innerHTML = `<p class="x-pop__cap">Expiry</p><p class="x-empty x-pad">${u?.hasOptions === false ? esc(futuresOnlyText(u)) : "No expiries listed"}.</p>`;
    return;
  }
  const yr = Number(istDate(gwNow()).slice(0, 4));
  pop.innerHTML = `<p class="x-pop__cap">Pick an expiry · chance it settles ${S.view.dir} ${Number.isFinite(S.view.level) ? lvl(S.view.level) : "the level"}</p>${listHtml(
    ex.map((e, i) => {
      const c = S.chains.get(`${u!.id}:${e.date}`);
      const p = typeof c === "object" ? chanceAt(c, S.view.level, S.view.dir) : null;
      const chance = i >= 8 ? "" : c === undefined ? `<em class="x-chance is-na">…</em>` : typeof c === "string" ? `<em class="x-chance is-na" title="${esc(c)}">no prices</em>` : `<em class="x-chance${p === null ? " is-na" : ""}">${p === null ? "—" : pct(p)}</em>`;
      return { html: `<span class="x-drow"><b>${esc(shortDate(e.date, yr))}</b><small>${esc(expiryMeta(e))}</small></span>${chance}`, sel: e.date === S.view.expiryDate, attr: `data-e="${e.date}"` };
    }),
    "x-list--dates",
  )}`;
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
  sliderPop(pop, {
    cap: "How much are you willing to lose?",
    tone: "amt",
    prefix: "₹",
    val: Number.isFinite(S.view.risk) ? S.view.risk : 5000,
    min: R_MIN,
    max: R_MAX,
    step: 1,
    toRange: toSlider,
    fromRange: fromSlider,
    l: "₹1,000",
    r: "₹5,00,000",
    info: "max loss incl. charges",
    inputLabel: "Amount value",
    rangeLabel: "Amount slider",
    parse: parseRupees,
    onSet: (x) => commit({ risk: x }),
  });
}

// ── review & confirm (sister app review layout) ───────────────────────
function chargesTable(c: ChargeBreakdown, broker: string, ctt = false): string {
  const rows = (Object.keys(CHARGE_LABELS) as (keyof typeof CHARGE_LABELS)[]).filter((k) => c[k] > 0 || k === "brokerage" || k === "stt").map((k) => `<div><dt>${k === "stt" && ctt ? "CTT" : CHARGE_LABELS[k]}</dt><dd>${inr2(c[k])}</dd></div>`).join("");
  return `<dl class="x-rows x-rows--tight">${rows}<div><dt><b>Total (our calculation)</b></dt><dd>${inr2(c.total)}</dd></div><div><dt>Broker's own figure</dt><dd>${esc(broker)}</dd></div></dl>
    <p class="x-pop__note x-left">Schedule in force: ${esc(c.scheduleId)} (Upstox brokerage page, exchange circulars, Finance Act 2026 STT). The contract note is final.</p>`;
}

let reviewTimer = 0;

function settleText(sg: Suggestion, idx: boolean): string {
  const seg = sg.legs[0]!.inst.segment;
  if (seg === "MCX_FO") return "MCX option on futures · devolves into the future if in the money";
  if (seg === "NCD_FO") return "Cash settled at the RBI reference rate · European";
  return idx ? "Cash settled · European" : "Physical delivery if held to expiry";
}
function expiresAt(seg: string, date: string): string {
  if (seg === "MCX_FO") {
    const c = venueHours("MCX", date).close;
    return `${String(Math.floor(c / 60)).padStart(2, "0")}:${String(c % 60).padStart(2, "0")} IST (MCX close)`;
  }
  if (seg === "NCD_FO") return "12:30 IST";
  return "15:30 IST";
}

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
  const u = curU();
  const idx = u?.index ?? true;
  const seg = sg.legs[0]!.inst.segment;
  const exp = sg.legs[0]!.inst.expiryDate ?? S.view.expiryDate;
  // chart: the same 15 bars across the strikes ± a margin, after charges to open
  const pad = Math.max(hiK - loK, (S.chain ? strikeStep(S.chain) : 50) * 2) * 2.2;
  const pts = payoffCurve(sg, loK - pad, hiK + pad, 15).map((p) => ({ x: p.S, pl: p.pnl }));
  const outRow = (cls: string, icon: string, text: string, v: number) => `<div class="x-out"><i class="${cls}">${icon}</i>${esc(text)}<b class="${v > 0 ? "x-up" : v < 0 ? "x-dn" : ""}">${signedInr(Math.round(v))}</b></div>`;
  const modeChip = live ? `<span class="x-chip-real">REAL MONEY</span>` : `<span class="x-mode">PAPER</span>`;
  root.innerHTML = `
  <div class="x-review" id="review">
    <div class="x-card x-pos-card">
      <div class="x-card__top"><span data-testid="review-title">${esc(sg.title)} ${modeChip}${S.demo ? ` <span class="x-mode is-demo">DEMO</span>` : ""}</span><button type="button" class="x-edit" id="editReview">Edit</button></div>
      <h2 class="x-rh">Make <mark class="x-m-amt">${inr(sg.maxProfit)}</mark> if ${esc(label)} ${bull ? (S.view.mode === "stays" ? "stays above" : "ends above") : S.view.mode === "stays" ? "stays below" : "ends below"} <mark class="x-m-tgt">${lvl(headLevel)}</mark> by <mark class="x-m-date">${esc(shortD(exp))}</mark></h2>
      <div class="x-outs">
        ${outRow("is-up", bull ? ICON.up : ICON.down, `Ends ${bull ? "above" : "below"} ${lvl(bull ? hiK : loK)}`, net(bull ? hiK : loK))}
        ${outRow("is-mid", ICON.mid, `Ends at ${lvl(midK)}`, net(midK))}
        ${outRow("is-dn", bull ? ICON.down : ICON.up, `Ends ${bull ? "below" : "above"} ${lvl(bull ? loK : hiK)}`, net(bull ? loK : hiK))}
      </div>
      <p class="x-chcap">Profit or loss by ${esc(label)} on ${esc(shortD(exp))}, after ${inr2(sg.entryCharges.total)} charges to open · ${matchMedia("(hover: hover)").matches ? "hover" : "tap"} the bars</p>
      <div class="x-chart" id="chart">${chartSvg(pts, (p) => `At ${lvl(p.x)}: ${signedInr(Math.round(p.pl))}`)}<span class="x-tip" id="tip" role="status" hidden></span></div>
      ${axisHtml(pts[0]!.x, pts[pts.length - 1]!.x, loK, hiK, pts.length, (x) => lvl(x))}
      <details class="x-ctr" id="contracts"><summary>Contracts<i aria-hidden="true"></i></summary>
        <p class="x-pop__note x-left">Buy leg first, then sell; IOC limit orders${S.demo ? " (paper, demo)" : ""}.</p>
        <div class="x-scroll"><table class="x-tbl" data-testid="legs"><thead><tr><th>Side</th><th>Contract</th><th>Lots × size</th><th class="n">Price now</th><th class="n">Limit</th><th class="n">Tick</th><th class="n">Freeze</th><th class="n">Orders</th></tr></thead><tbody>
        ${sg.legs.map((l) => `<tr><td class="${l.side === "BUY" ? "x-up" : "x-dn"}">${l.side}</td><td class="x-mono">${esc(l.inst.symbol)}</td><td>${l.qty / sg.lotSize} × ${sg.lotSize}</td><td class="n">${inr2(l.price)}</td><td class="n">${inr2(l.limit)}</td><td class="n">₹${(l.inst.tickPaise / 100).toFixed(l.inst.tickPaise < 1 ? 4 : 2)}</td><td class="n">${l.inst.freezeQty ?? "—"} (≤${Number.isFinite(maxPerOrder(l.inst)) ? maxPerOrder(l.inst) : "—"}/order)</td><td class="n">${l.slices.length}</td></tr>`).join("")}
        </tbody></table></div>
      </details>
    </div>
    <div class="x-rcol">
      <div class="x-card x-det-card">
        <dl class="x-rows">
          <div><dt>Size</dt><dd>${sg.lots} lot${sg.lots === 1 ? "" : "s"} × ${sg.lotSize}${u?.unit ? ` (price per ${esc(u.unit)})` : ""}</dd></div>
          <div><dt>${sg.credit ? "Credit received" : "Debit paid"}</dt><dd>${inr(Math.abs(sg.netPerUnit) * sg.qty)}</dd></div>
          <div><dt>Maximum profit</dt><dd class="x-up">${inr(sg.maxProfit)}</dd></div>
          <div><dt>Maximum loss</dt><dd class="x-dn">${inr(sg.maxLoss)}</dd></div>
          <div><dt>Worst case incl. slippage + charges</dt><dd class="x-dn" data-testid="worst">${inr(sg.worstMaxLoss)}</dd></div>
          <div><dt>Breakeven at expiry</dt><dd>${lvl(sg.breakeven, 2)}</dd></div>
          <div><dt>Chance of profit</dt><dd>${sg.probProfit === null ? "unavailable" : pct(sg.probProfit)}</dd></div>
          <div><dt>Charges to open</dt><dd><details class="x-inl"><summary data-testid="charges-total">${inr2(sg.entryCharges.total)}</summary></details></dd></div>
          <div class="x-rows__x" id="chgRow" hidden><dd id="chg">${chargesTable(sg.entryCharges, "checking…", seg === "MCX_FO")}</dd></div>
          <div><dt>Broker's own figure</dt><dd data-testid="broker-charges">checking…</dd></div>
          <div><dt>Margin (broker)</dt><dd data-margin="${esc(sg.id)}">${esc(S.margins.get(sg.id) ?? "…")}</dd></div>
          <div><dt>Expires</dt><dd>${esc(longDate(exp))} · ${expiresAt(seg, exp)}</dd></div>
          <div><dt>Settlement</dt><dd>${settleText(sg, idx)}</dd></div>
          <div><dt>Prices</dt><dd>${S.demo ? esc(S.chain?.source ?? "Recorded 8 Oct 2026") : `${esc(S.chain?.source ?? "—")} · ${S.chain ? esc(istClock(S.chain.fetchedAt)) : ""}`}</dd></div>
        </dl>
        <p class="x-pop__note x-left">Chance = risk-neutral probability from the option chain's implied volatility (lognormal, zero rates). It is not a forecast. Closing before expiry at today's prices would cost about ${inr2(sg.exitChargesIfClosed.total)} more.</p>
        ${sg.warnings.map((w) => `<p class="x-warn">${esc(w)}</p>`).join("")}
      </div>
      <div id="gates">
        ${capHit ? `<p class="x-hint">Above your per-trade cap of ${inr(s.risk.perTradeCap!)}.</p>` : ""}
        ${s.killSwitch ? `<p class="x-hint">Kill switch is on: new trades are blocked.</p>` : ""}
        <p class="x-hint" data-testid="stale" id="stale" hidden></p>
      </div>
      <form id="confirm">
        ${live ? `<div class="x-real" role="alert">Real money: this sends orders to ${esc(s.broker.name)}. Type <b>${esc(s.confirmPhrase)}</b> to send a real order<input id="phrase" autocomplete="off" spellcheck="false" aria-label="Type ${esc(s.confirmPhrase)} to confirm" data-testid="phrase"></div>` : ""}
        <label class="x-agree"><input type="checkbox" id="agree"><span>I understand I can lose up to ${inr(sg.worstMaxLoss)}${live ? "" : S.demo ? " (paper trade on recorded prices; nothing is sent anywhere)" : " (paper trade: nothing is sent to the broker)"}.</span></label>
        <button type="submit" class="x-buy x-confirm${live ? " x-confirm--live" : ""}" id="go" data-testid="place" disabled></button>
        <p class="x-step" id="step" role="status"></p>
      </form>
      <div id="result" aria-live="polite"></div>
    </div>
  </div>`;
  dock();
  window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });

  // charges breakdown opens under its row
  const chgSum = root.querySelector<HTMLDetailsElement>(".x-inl");
  chgSum?.addEventListener("toggle", () => ($("#chgRow").hidden = !chgSum.open));

  // chart tooltips (hover on desktop, tap on phones)
  const tip = $("#tip"), chart = $("#chart");
  const showTip = (r: SVGRectElement) => {
    const p = pts[Number(r.dataset.i)]!;
    const box = chart.getBoundingClientRect(), rb = r.getBoundingClientRect();
    tip.textContent = `${label} ${lvl(p.x)} · ${signedInr(Math.round(p.pl))}`;
    tip.classList.toggle("is-dn", p.pl < 0);
    tip.hidden = false;
    tip.style.left = `${Math.max(60, Math.min(box.width - 60, rb.left - box.left + rb.width / 2))}px`;
    chart.classList.add("is-hovering");
    chart.querySelectorAll("rect").forEach((x) => x.classList.toggle("is-hot", x === r));
  };
  chart.querySelectorAll<SVGRectElement>("rect").forEach((r) => {
    r.addEventListener("pointerenter", () => showTip(r));
    r.addEventListener("click", () => showTip(r));
    r.addEventListener("focus", () => showTip(r));
  });
  chart.addEventListener("pointerleave", () => {
    tip.hidden = true;
    chart.classList.remove("is-hovering");
    chart.querySelectorAll("rect").forEach((x) => x.classList.remove("is-hot"));
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
    const html = `<span>${go.disabled && !$<HTMLInputElement>("#agree").checked ? "Tick the box to continue" : text}</span>${S.demo || go.disabled ? "" : ringHtml(left, Math.round(maxAge / 1000))}`;
    if (go.innerHTML !== html) go.innerHTML = html;
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
      $("#result").innerHTML = `<div class="x-card x-result ${res.status === "needs-attention" ? "is-bad" : res.status === "filled" ? "is-ok" : ""}" data-testid="result">
        <div class="x-card__top"><span>${r.paper ? "Paper · " : ""}${esc(head)}</span><button type="button" class="x-edit" id="toPortfolio">See portfolio</button></div>
        <div class="x-poslist">${res.legs.map((l) => `<div class="x-leg"><span><b class="x-mono">${esc(l.inst.symbol)}</b><small><span class="${l.side === "BUY" ? "x-up" : "x-dn"}">${esc(l.side)}</span> ${l.filled}/${l.requested}${l.error ? ` · ${esc(l.error)}` : ""}</small></span><b>${l.avgPrice ? inr2(l.avgPrice) : "—"}</b></div>`).join("")}</div>
        ${res.unwinds.map((x) => `<p class="x-warn">Unwind ${esc(x.side)} ${esc(x.inst.symbol)}: ${x.filled}/${x.qty}${x.error ? ` · ${esc(x.error)}` : ""}</p>`).join("")}
        ${res.residual.map((x) => `<p class="x-hint">Open: ${esc(x.inst.symbol)} ${x.netQty > 0 ? "long" : "short"} ${Math.abs(x.netQty)}. Close it from Portfolio or the broker app.</p>`).join("")}
      </div>`;
      $("#toPortfolio").addEventListener("click", () => setTab("portfolio"));
      $("[data-testid=result]").scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
      go.innerHTML = `<span>Done</span>`;
    } catch (e) {
      placed = false;
      $("#result").innerHTML = `<p class="x-hint" data-testid="result-error">${esc(errText(e))}</p>`;
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
    if (chg) chg.innerHTML = chargesTable(sg.entryCharges, text, sg.legs[0]!.inst.segment === "MCX_FO");
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
function eqInner(k: "eside" | "esize" | "estock" | "eprod"): string {
  const e = S.eq;
  return {
    eside: `<span id="pk_eside">${e.side === "BUY" ? "Buy" : "Sell"}</span>`,
    esize: `<span id="pk_esize">${e.by === "amount" ? inr(e.amount) : `${e.qty} share${e.qty === 1 ? "" : "s"}`}</span>`,
    estock: `<span id="pk_estock">${esc(e.name)}</span>`,
    eprod: `<span id="pk_eprod">${e.product === "I" ? "intraday" : "delivery"}</span>`,
  }[k];
}
function eqPill(k: "eside" | "esize" | "estock" | "eprod"): string {
  const meta = { eside: ["x-sal", "Buy or sell"], esize: ["x-amt", "How much"], estock: ["x-lav", "Stock"], eprod: ["x-mint", "Delivery or intraday"] }[k];
  return `<button type="button" class="x-pill ${meta[0]}" id="p_${k}" data-pop="${k}" aria-haspopup="dialog" aria-expanded="false" aria-label="${meta[1]}">${eqInner(k)}${ICON.chev}</button>`;
}

function stocksView(root: HTMLElement): void {
  root.innerHTML = `
  <section class="x-builder x-builder--eq" id="builder" aria-label="Buy or sell a stock">
    ${tagsHtml({ kind: "Cash equity · limit order" })}
    <h1 class="x-sent" id="eqSent">${eqPill("eside")} ${eqPill("esize")} of ${eqPill("estock")}, ${eqPill("eprod")}</h1>
    <form id="eq" class="x-nl">
      <input id="eqText" class="x-in" aria-label="Stock order in plain English" placeholder="Or type it: buy ₹20,000 of Reliance" autocomplete="off">
      <button class="x-edit" type="submit">Read it</button>
    </form>
    <div id="eqOut"></div>
    <div class="x-pop" id="pop" role="dialog" hidden></div>
  </section>`;
  wireTags(root);
  root.querySelectorAll<HTMLButtonElement>("#eqSent [data-pop]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePop(b.dataset.pop as PopKey, b);
    }),
  );
  $("#eq").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const p = parseEquity(String($<HTMLInputElement>("#eqText").value));
    if (p.missing.length) {
      $("#eqOut").innerHTML = `<p class="note x-warn">I need ${p.missing.map((m) => ({ side: "buy or sell", stock: "which stock", size: "how many shares or how many rupees" })[m]).join(", ")}.</p>`;
      return;
    }
    S.eq = { ...S.eq, side: p.side!, by: p.qty !== null ? "qty" : "amount", amount: p.amount ?? S.eq.amount, qty: p.qty ?? S.eq.qty, symbol: p.query!, name: p.query!, product: p.product, price: p.price };
    void buildTicket(true);
  });
  void buildTicket(false);
}

function refreshEqPills(): void {
  const e = S.eq;
  const t: Record<string, string> = { eside: e.side === "BUY" ? "Buy" : "Sell", esize: e.by === "amount" ? inr(e.amount) : `${e.qty} share${e.qty === 1 ? "" : "s"}`, estock: e.name, eprod: e.product === "I" ? "intraday" : "delivery" };
  for (const k of Object.keys(t)) {
    const el = $(`#pk_${k}`);
    if (el) setText(el, t[k]!, { animate: k === "esize", pill: $(`#p_${k}`) });
  }
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
    pop.innerHTML = `<p class="x-pop__cap">${k === "eside" ? "Buy or sell?" : "Delivery or intraday?"}</p>${listHtml(opts.map(([v, l, d]) => ({ html: `<span class="x-drow"><b>${l}</b><small>${d}</small></span>`, sel: cur === v, attr: `data-v="${v}"` })))}`;
    pop.querySelectorAll<HTMLButtonElement>("[data-v]").forEach((b) =>
      b.addEventListener("click", () => {
        done(k === "eside" ? { side: b.dataset.v as "BUY" | "SELL" } : { product: b.dataset.v as "D" | "I" });
        closePop();
      }),
    );
    return;
  }
  if (k === "esize") {
    const seg = `<span class="x-seg x-seg--cats x-seg--in" role="group" aria-label="Size in"><button type="button" data-by="amount" aria-pressed="${e.by === "amount"}">Rupees</button><button type="button" data-by="qty" aria-pressed="${e.by === "qty"}">Shares</button></span>`;
    if (e.by === "amount") {
      sliderPop(pop, { cap: "How much?", tone: "amt", prefix: "₹", val: e.amount, min: R_MIN, max: R_MAX, step: 1, toRange: toSlider, fromRange: fromSlider, l: "₹1,000", r: "₹5,00,000", info: "whole shares at a limit", inputLabel: "Size value", rangeLabel: "Amount slider", parse: parseRupees, onSet: (x) => done({ amount: x }) });
    } else {
      pop.innerHTML = `<p class="x-pop__cap">How many shares?</p><label class="x-field"><input id="popIn" inputmode="numeric" aria-label="Size value" value="${e.qty}" autocomplete="off"><small>shares</small></label>`;
      const inp = $<HTMLInputElement>("#popIn", pop);
      const typed = () => {
        const x = Math.floor(Number(inp.value));
        if (x > 0) done({ qty: x });
      };
      inp.addEventListener("change", typed);
      inp.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          typed();
          closePop();
        }
      });
    }
    pop.querySelector(".x-pop__cap")!.insertAdjacentHTML("afterend", seg);
    pop.querySelectorAll<HTMLButtonElement>("[data-by]").forEach((b) =>
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        S.eq.by = b.dataset.by as "amount" | "qty";
        refreshEqPills();
        popStocks(pop, k);
        void buildTicket(false);
      }),
    );
    return;
  }
  // stock picker: the same category switch as the options picker (F&O stocks with prices, or all of NSE)
  const hadFocus = document.activeElement?.id === "sSearch";
  const qv = $<HTMLInputElement>("#sSearch", pop)?.value ?? "";
  pop.innerHTML = `<p class="x-pop__cap">Choose a stock · NSE cash market</p>
    <span class="x-seg x-seg--cats" role="group" aria-label="Category"><button type="button" data-ecat="fo" aria-pressed="${S.eqCat === "fo"}"><i class="x-dot x-cat--stock" aria-hidden="true"></i>F&amp;O stocks</button><button type="button" data-ecat="all" aria-pressed="${S.eqCat === "all"}"><i class="x-dot x-cat--all" aria-hidden="true"></i>All NSE</button></span>
    <label class="x-field x-field--search">${ICON.search}<input id="sSearch" aria-label="Search stocks" placeholder="${S.eqCat === "fo" ? "Search F&O stocks" : "Search all NSE stocks"}" value="${esc(qv)}" autocomplete="off"></label><ul class="x-list x-list--assets" id="sList"></ul>`;
  pop.querySelectorAll<HTMLButtonElement>("[data-ecat]").forEach((b) =>
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      S.eqCat = b.dataset.ecat as "fo" | "all";
      popStocks(pop, k);
    }),
  );
  const inp = $<HTMLInputElement>("#sSearch", pop);
  if (hadFocus) inp.focus();
  const list = $("#sList", pop);
  const show = (rows: { symbol: string; name: string; fo: boolean }[]) => {
    list.innerHTML =
      rows
        .map((r, i) => {
          const sp = S.spots.get(r.symbol);
          return `<li style="--i:${i}"><button type="button" data-s="${esc(r.symbol)}" data-n="${esc(r.name)}"${r.symbol === e.symbol ? ' class="is-sel"' : ""}><span class="x-arow"><i class="x-dot x-cat--${r.fo ? "stock" : "all"}" aria-hidden="true"></i><b>${esc(r.name)}</b><small>${esc(r.symbol)}</small></span><em>${sp?.ltp ? num(sp.ltp) : ""}</em><span class="x-sparkbox">${sparkSvg(sp?.spark)}</span></button></li>`;
        })
        .join("") || `<li class="x-empty x-pad">No NSE stock matches.</li>`;
    list.querySelectorAll<HTMLButtonElement>("[data-s]").forEach((b) =>
      b.addEventListener("click", () => {
        done({ symbol: b.dataset.s!, name: b.dataset.n!, price: null });
        closePop();
      }),
    );
  };
  const fo = S.underlyings.filter((u) => catOf(u) === "stock").map((u) => ({ symbol: u.id, name: u.label === u.id ? u.id.charAt(0) + u.id.slice(1).toLowerCase() : u.label, fo: true }));
  const foSet = new Set(fo.map((x) => x.symbol));
  const search = async () => {
    const t = inp.value.trim();
    if (S.eqCat === "fo") {
      const hit = fo.filter((x) => !t || x.symbol.toLowerCase().includes(t.toLowerCase()) || x.name.toLowerCase().includes(t.toLowerCase())).slice(0, 60);
      if (hit.length || !t) return show(hit); // no F&O match: fall through to all of NSE (grey dot)
    }
    if (!t) return show(fo.slice(0, 20));
    try {
      const r = (await api.get<{ results: Instrument[] }>(`/api/instruments/equity?q=${encodeURIComponent(t)}`)).results;
      show(r.map((x) => ({ symbol: x.symbol, name: x.name, fo: foSet.has(x.symbol) })));
    } catch (er) {
      list.innerHTML = `<li class="x-empty x-pad">${esc(errText(er))}</li>`;
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
      out.innerHTML = `<p class="note x-warn">No NSE stock matches "${esc(e.symbol)}" in today's instrument master.</p>`;
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
      out.innerHTML = `${qErr ? `<p class="note x-warn">${esc(qErr)}</p>` : ""}<p class="x-hint">${esc({ "no-quote": S.demo ? `No recorded price for ${inst.symbol} in the demo (only Reliance has one).` : "No live quote, and you gave no limit price. Add 'at <price>' or log in to the broker.", "zero-qty": "That amount buys less than one share.", "bad-price": "That price isn't valid." }[t.fail])}</p>`;
      S.ticket = null;
      return;
    }
    S.ticket = t;
    renderTicket(out, t, inst, q);
  } catch (er) {
    out.innerHTML = `<p class="x-hint">${esc(errText(er))}</p>`;
  }
}

function renderTicket(out: HTMLElement, t: EquityTicket, inst: Instrument, q: Quote | null): void {
  const live = S.mode === "live";
  out.innerHTML = `<div class="x-review x-review--one"><article class="x-card x-ticket" data-testid="eq-ticket">
    <div class="x-card__top"><span>Order ticket · ${esc(inst.exchange)} ${live ? `<span class="x-chip-real">REAL MONEY</span>` : `<span class="x-mode">PAPER</span>`}${S.demo ? ` <span class="x-mode is-demo">DEMO</span>` : ""}</span></div>
    <h2 class="x-rh x-rh--sm">${t.side === "BUY" ? "Buy" : "Sell"} <mark class="x-m-amt">${t.qty} ${esc(inst.symbol)}</mark> at <mark class="x-m-tgt">${inr2(t.limit)}</mark> limit</h2>
    <dl class="x-rows">
      <div><dt>Company</dt><dd>${esc(inst.name)}</dd></div>
      <div><dt>Last / ${t.side === "BUY" ? "offer" : "bid"}</dt><dd>${q?.ltp ? inr2(q.ltp) : "—"} / ${t.touch ? inr2(t.touch) : "—"}${S.demo ? " (recorded)" : ""}</dd></div>
      <div><dt>Order value</dt><dd>${inr(t.value)}</dd></div>
      <div><dt>Product</dt><dd>${t.product === "I" ? "Intraday" : "Delivery"}</dd></div>
      <div><dt>Charges</dt><dd>${inr2(t.charges.total)}</dd></div>
    </dl>
    ${t.warnings.map((w) => `<p class="x-warn">${esc(w)}</p>`).join("")}
    <form id="eqGo">
      ${live ? `<div class="x-real">Real money. Type <b>${esc(S.session!.confirmPhrase)}</b><input id="eqPhrase" autocomplete="off" aria-label="Type ${esc(S.session!.confirmPhrase)} to confirm"></div>` : ""}
      <button class="x-buy x-confirm${live ? " x-confirm--live" : ""}" type="submit">${live ? "Send real order" : "Place paper order"}</button>
    </form>
    <div id="eqRes" aria-live="polite"></div>
  </article></div>`;
  $("#eqGo").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      const r = await api.post<{ placed: boolean; message?: string; status?: { state: string; filled: number } }>("/api/trade/equity", { mode: S.mode, key: inst.key, side: t.side, qty: t.qty, limit: t.limit, product: t.product, confirm: live ? $<HTMLInputElement>("#eqPhrase").value : undefined });
      $("#eqRes").innerHTML = r.placed
        ? `<p class="x-step x-ok">${S.mode === "paper" ? "Paper order" : "Order"} placed: ${esc(r.status?.state ?? "")} (${r.status?.filled ?? 0} filled).${S.demo && r.status?.state === "open" ? " The recording has no stock order book, so a demo order rests unfilled." : ""}</p>`
        : `<p class="x-hint">${esc(r.message ?? "Not placed")}</p>`;
    } catch (e) {
      $("#eqRes").innerHTML = `<p class="x-hint">${esc(errText(e))}</p>`;
    }
  });
}

// ── portfolio / orders (sister app .x-port cards, .x-pos rows, empty cards) ──
interface PosRow { symbol: string; qty: number; avgPrice: number | null; ltp: number | null; pnl: number | null }

function emptyCard(title: string, text: string, testid: string): string {
  return `<div class="x-card x-emptycard" data-testid="${testid}"><span class="x-emptyic">${ICON.wallet}</span><h2>${esc(title)}</h2><p class="x-empty">${esc(text)}</p></div>`;
}

function posCards(rows: PosRow[], id: string): string {
  if (!rows.length) return `<p class="x-empty" data-testid="${id}-empty">None.</p>`;
  return `<div class="x-poslist" data-testid="${id}">${rows
    .map(
      (x) => `<div class="x-pos" data-testid="${id === "positions" ? "position" : "holding"}"><header><span><b class="x-mono">${esc(x.symbol)}</b><small>${x.qty > 0 ? "Long" : x.qty < 0 ? "Short" : "Closed"} ${Math.abs(x.qty)} · avg ${x.avgPrice ? inr2(x.avgPrice) : "—"} · last ${x.ltp ? inr2(x.ltp) : "—"}</small></span><b class="${x.pnl === null ? "" : x.pnl >= 0 ? "x-up" : "x-dn"}">${x.pnl === null ? "—" : signedInr(x.pnl)}</b></header></div>`,
    )
    .join("")}</div>`;
}

function pageHead(): string {
  return `<div class="x-pagehead">${tagsHtml({})}</div>`;
}

async function portfolioView(root: HTMLElement): Promise<void> {
  root.innerHTML = `${pageHead()}<p class="x-empty x-loading">Loading ${S.mode} portfolio…</p>`;
  wireTags(root);
  try {
    const p = await api.get<{ paper: boolean; positions: PosRow[]; holdings: PosRow[]; funds: { available: number | null } | null; pnl: number | null; note?: string | null }>(`/api/portfolio?mode=${S.mode}`);
    if (S.tab !== "portfolio") return;
    root.innerHTML = `${pageHead()}
    <section class="x-port">
      <div class="x-card x-hero">
        <div class="x-card__top"><span>${S.demo ? "Demo · " : ""}${p.paper ? "Paper book" : "Broker account"}</span>${p.paper ? `<button type="button" class="x-edit" id="resetPaper">Reset paper book</button>` : ""}</div>
        <h2 class="x-rh">${p.paper ? "Paper portfolio" : "Portfolio"}</h2>
        <p class="x-big ${p.pnl === null ? "" : p.pnl >= 0 ? "x-up" : "x-dn"}" ${p.pnl !== null ? 'data-testid="pnl"' : ""}>${p.pnl !== null ? signedInr(p.pnl) : `<span class="x-empty">P&amp;L unavailable</span>`}</p>
        ${p.funds ? `<p class="x-empty">Available to trade: <b>${p.funds.available !== null ? inr(p.funds.available) : "—"}</b></p>` : ""}
        ${p.note ? `<p class="x-warn">${esc(p.note)}</p>` : ""}
      </div>
      <div class="x-card"><h2>Positions</h2>${posCards(p.positions, "positions")}</div>
      ${p.paper ? "" : `<div class="x-card"><h2>Holdings</h2>${posCards(p.holdings, "holdings")}</div>`}
    </section>`;
    wireTags(root);
    $("#resetPaper")?.addEventListener("click", async () => {
      await api.post("/api/paper/reset");
      void portfolioView(root);
    });
  } catch (e) {
    root.innerHTML = `${pageHead()}<section class="x-port">${emptyCard("Portfolio unavailable", errText(e), "portfolio-error")}</section>`;
    wireTags(root);
  }
}

async function ordersView(root: HTMLElement): Promise<void> {
  root.innerHTML = `${pageHead()}<p class="x-empty x-loading">Loading orders…</p>`;
  wireTags(root);
  try {
    const [o, t] = await Promise.all([api.get<{ paper: boolean; orders: Record<string, unknown>[] }>(`/api/orders?mode=${S.mode}`), api.get<{ trades: Record<string, unknown>[] }>(`/api/trades?mode=${S.mode}`)]);
    if (S.tab !== "orders") return;
    const orders = o.orders.map((x) => {
      const id = String(x.orderId ?? x.id);
      const state = String(x.state ?? x.status);
      const side = String(x.side);
      return `<div class="x-pos" data-testid="order"><header><span><b class="x-mono">${esc(String(x.symbol))}</b><small><span class="${side === "BUY" ? "x-up" : "x-dn"}">${esc(side)}</span> ${x.filled ?? 0}/${x.qty} @ ${inr2(Number(x.price ?? x.limit))} · <span class="x-mono">${esc(id)}</span></small></span><span class="x-acts"><span class="x-state x-state--${esc(state)}">${esc(state)}</span>${state === "open" ? `<button type="button" class="x-edit x-small" data-cancel="${esc(id)}">Cancel</button>` : ""}</span></header></div>`;
    });
    const trades = t.trades.map((x) => `<div class="x-pos" data-testid="trade"><header><span><b class="x-mono">${esc(String(x.symbol))}</b><small><span class="${x.side === "BUY" ? "x-up" : "x-dn"}">${esc(String(x.side))}</span> ${x.qty} · <span class="x-mono">${esc(String(x.tradeId))}</span></small></span><b>${x.price ? inr2(Number(x.price)) : "—"}</b></header></div>`);
    root.innerHTML = `${pageHead()}<section class="x-hist">
      <div class="x-card"><div class="x-card__top"><span>${S.demo ? "Demo · " : ""}${o.paper ? "Paper" : "Broker"}</span></div><h2 class="x-rh x-rh--sm">${o.paper ? "Paper orders" : "Order book"}</h2>${orders.length ? `<div class="x-poslist" data-testid="orders">${orders.join("")}</div>` : `<p class="x-empty" data-testid="orders-empty">None.</p>`}</div>
      <div class="x-card"><h2>Trades today</h2>${trades.length ? `<div class="x-poslist" data-testid="trades">${trades.join("")}</div>` : `<p class="x-empty" data-testid="trades-empty">None.</p>`}</div>
    </section>`;
    wireTags(root);
    root.querySelectorAll<HTMLButtonElement>("[data-cancel]").forEach((b) =>
      b.addEventListener("click", async () => {
        await api.post("/api/orders/cancel", { mode: S.mode, orderId: b.dataset.cancel });
        void ordersView(root);
      }),
    );
  } catch (e) {
    root.innerHTML = `${pageHead()}<section class="x-hist">${emptyCard("Orders unavailable", errText(e), "orders-error")}</section>`;
    wireTags(root);
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
  const live = S.mode === "live";
  root.innerHTML = `${pageHead()}
  <section class="x-port x-port--grid">
  <div class="x-card x-card--danger">
    <div class="x-card__top"><span>Emergency</span>${live ? `<span class="x-chip-real">LIVE</span>` : `<span class="x-mode">PAPER</span>`}</div>
    <h2 class="x-rh x-rh--sm">Kill switches</h2>
    <label class="x-switch"><input type="checkbox" id="ks" role="switch" ${s.killSwitch ? "checked" : ""} data-testid="kill-toggle"><span class="x-switch__t" aria-hidden="true"></span><span>Kill switch: block every new trade <small>exits still allowed</small></span></label>
    <button type="button" class="x-buy x-confirm x-buy--light" id="cancelAll" data-testid="cancel-all">Cancel all open orders (${S.mode})</button>
    <form id="exitAll" class="x-exit">
      <input id="exitPhrase" class="x-in" placeholder="type EXIT ALL" aria-label="Type EXIT ALL" data-testid="exit-phrase" autocomplete="off">
      <button class="x-buy x-kill" type="submit" data-testid="exit-all">Exit all positions (${S.mode})</button>
    </form>
    <p class="x-pop__note x-left">Exit all cancels open orders, then closes each F&amp;O, commodity, currency or intraday position with protective IOC limit orders (never market orders). Delivery holdings are left alone.</p>
    <div id="killRes"></div>
  </div>
  <div class="x-card">
    <div class="x-card__top"><span>Optional · off by default</span></div>
    <h2 class="x-rh x-rh--sm">Limits</h2>
    <form id="caps" class="x-caps">
      <label>Max loss per trade (₹)<input id="cap1" class="x-in" inputmode="decimal" placeholder="off" value="${s.risk.perTradeCap ?? ""}" data-testid="cap-trade"></label>
      <label>Daily loss cap (₹)<input id="cap2" class="x-in" inputmode="decimal" placeholder="off" value="${s.risk.dailyLossCap ?? ""}" data-testid="cap-day"></label>
      <button class="x-buy" type="submit">Save</button>
    </form>
    <p class="x-pop__note x-left">Enforced ${S.demo ? "on every demo order" : "by the gateway on every order"}. Also enforced: limit orders only, ≤ ${s.risk.maxOrdersPerSecond} orders/second (SEBI's retail threshold is 10), price within ${(s.risk.maxSlippage * 100).toFixed(0)}% of the ${S.demo ? "recorded" : "live"} quote, market hours per venue (NSE/BSE 09:15–15:30, MCX 09:00–23:30/23:55, currency 09:00–17:00) from the official holiday list. Commodity and currency trades are paper only.</p>
  </div>
  <div class="x-card">
    <div class="x-card__top"><span>Broker</span></div>
    <h2 class="x-rh x-rh--sm">${S.demo ? "No broker in the demo" : esc(s.broker.name)}</h2>
    <p class="x-empty">${S.demo ? "The demo never connects to a broker. Sign in to your own gateway to log in to Upstox." : s.broker.loggedIn ? `Logged in as <b>${esc(s.broker.userId ?? "")}</b> until ${s.broker.expiresAt ? esc(istClock(s.broker.expiresAt)) : "?"} (Upstox tokens end at 03:30 IST daily)` : "Not logged in"}</p>
    <div class="x-btnrow">
      <button type="button" class="x-buy" id="bLogin" ${S.demo ? "disabled" : ""}>Log in to ${esc(S.demo ? "Upstox" : s.broker.name)}</button>
      <button type="button" class="x-edit" id="bRequest" ${S.demo ? "disabled" : ""}>Send login request to my phone</button>
      ${s.broker.loggedIn ? `<button type="button" class="x-edit" id="bLogout">Log out of broker</button>` : ""}
    </div>
    <p class="x-pop__note x-left">Your broker password, PIN and TOTP are typed only on the broker's own page. The gateway keeps the daily access token (encrypted at rest) and the API secret (environment variable).</p>
    <div class="x-poslist" data-testid="brokers">${brokers.map((b) => `<div class="x-leg"><span><b>${esc(b.name)}</b></span><span class="x-acts">${b.status === "implemented" ? `<span class="x-state x-state--complete">implemented</span>` : `<span class="x-state">not implemented</span>`} ${b.docs ? `<a class="x-small" href="${esc(b.docs)}" rel="noopener" target="_blank">docs</a>` : ""}</span></div>`).join("")}</div>
  </div>
  <div class="x-card">
    <div class="x-card__top"><span>Hash-chained</span></div>
    <h2 class="x-rh x-rh--sm">Audit log</h2>
    ${audit.length ? `<ol class="x-audit" data-testid="audit">${audit.map((a) => `<li><span class="x-mono">#${a.seq}</span><span>${esc(a.type)}</span><small>${esc(longDate(istDate(a.ts)))} ${esc(istClock(a.ts))}</small></li>`).join("")}</ol>` : `<p class="x-empty" data-testid="audit-empty">None.</p>`}
  </div>
  </section>`;
  wireTags(root);
  $<HTMLInputElement>("#ks").addEventListener("change", async (ev) => {
    await api.post("/api/kill/switch", { on: (ev.target as HTMLInputElement).checked });
    await refreshSession();
    toast((ev.target as HTMLInputElement).checked ? "Kill switch ON" : "Kill switch off");
  });
  $("#cancelAll").addEventListener("click", async () => {
    try {
      const r = await api.post<{ cancelled: unknown }>("/api/kill/cancel-all", { mode: S.mode });
      $("#killRes").innerHTML = `<p class="x-step x-ok">Cancelled: ${esc(Array.isArray(r.cancelled) ? String(r.cancelled.length) : String(r.cancelled))}</p>`;
    } catch (e) {
      $("#killRes").innerHTML = `<p class="x-hint">${esc(errText(e))}</p>`;
    }
  });
  $("#exitAll").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      const r = await api.post<{ results: { inst: { symbol: string }; qty: number; filled: number; error?: string }[]; skipped: { key: string; reason: string }[] }>("/api/kill/exit-all", { mode: S.mode, confirm: $<HTMLInputElement>("#exitPhrase").value });
      $("#killRes").innerHTML = `<div class="x-poslist" data-testid="exit-result">${r.results.map((x) => `<div class="x-leg"><span><b class="x-mono">${esc(x.inst.symbol)}</b><small>${x.error ? esc(x.error) : "closed"}</small></span><b class="${x.error ? "x-dn" : "x-up"}">${x.filled}/${x.qty}</b></div>`).join("") || `<p class="x-empty">No open positions.</p>`}${r.skipped.map((x) => `<p class="x-pop__note x-left">${esc(x.key)}: ${esc(x.reason)}</p>`).join("")}</div>`;
    } catch (e) {
      $("#killRes").innerHTML = `<p class="x-hint">${esc(errText(e))}</p>`;
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
