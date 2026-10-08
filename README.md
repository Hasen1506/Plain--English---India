# Plain English India

Say what you think an Indian index or stock will do, in plain English, and get a
**defined-risk** options trade on **your own broker account**:

> *"I think Nifty stays above 25,000 till Tuesday's expiry, risking ₹5,000"*

→ a bull put spread on the right weekly Nifty contract, sized in whole lots, with
the full charges, breakeven, max profit and max loss, the chance of profit, and the
broker's margin shown **before** anything is sent. Cash equity works the same way
("buy ₹20,000 of Reliance").

It covers NSE/BSE index options (Nifty, Bank Nifty, Fin Nifty, Midcap Nifty, Sensex,
Bankex), stock F&O and cash equities. **Upstox** is the first broker. Zerodha Kite,
Dhan, Fyers and Angel One SmartAPI are interface stubs that honestly report "not implemented".

> **Status:** everything except deployment and your broker credentials is built and
> tested offline. Nothing here has placed a real order. Read [What is and isn't verified](#what-is-and-isnt-verified).

## Try the demo

The public site (<https://hasen1506.github.io/Plain--English---India/>, or add `#demo`) has a
**Try the demo** button. It runs the whole UI in your browser against the public data recorded on
**Thu 8 Oct 2026, 10:39 IST** (NSE option chains for Nifty 13 & 27 Oct, Bank Nifty, Fin Nifty and
Reliance 27 Oct, plus the Upstox instrument master and holiday list in `tests/fixtures/`). It is
labelled *DEMO · recorded prices from 8 Oct 2026 · no broker, no orders* on every screen, has no
gateway and no broker, and can only place **paper** trades. The recording is a single snapshot, so
the demo shows no day change and no intraday chart. Margin and the broker's own charge figure say
"unavailable: no broker in the demo".

## How it fits together

```
 GitHub Pages (static)                 your VPS in India (static IP)                  Upstox
┌────────────────────┐  HTTPS + JWT   ┌──────────────────────────────────┐  OAuth   ┌──────────┐
│ web/  (Vite, TS)   │ ─────────────▶ │ Caddy (TLS) → gateway (Node 22)  │ ───────▶ │ REST v2/ │
│ plain-English UI   │  CORS allow-   │ • api secret in env vars         │  orders  │ v3, WS   │
│ runs the same pure │  list = your   │ • code→token exchange, daily     │  from    │ feed     │
│ maths as gateway   │  Pages origin  │   re-login prompt                │  the     └──────────┘
└────────────────────┘                │ • market data + order proxy      │  whitelisted IP
                                      │ • risk checks on EVERY order     │
                                      │ • paper book, hash-chained audit │
                                      └──────────────────────────────────┘
```

* **SEBI's retail-algo framework** (circular of 4 Feb 2025, live from 1 Apr 2026) requires
  OAuth logins, 2FA, and orders from a **static IP whitelisted** on the API key. A browser
  can't do that, so orders go through a small gateway you run on a VPS with a static IP.
* The **frontend** is a static site. It never sees the API secret or the broker token.
* The **gateway** holds the secret (env vars), exchanges the login code for the daily
  token, proxies data and orders, and enforces the risk rules server-side. It serves
  exactly one person: you, by passphrase → JWT, from your Pages origin only.

## Features

| Area | What it does |
|---|---|
| Plain-English builder | Parses index/stock, direction (*stays above / goes above / stays below / falls below*), level, expiry (*Tuesday's expiry, next week, monthly, 27 Oct*), and risk (*₹5,000, 10k, 1.5 lakh*). Says what it couldn't read instead of guessing. Every part stays editable as a pill. |
| Spread selection | Credit spreads for "stays", debit spreads for "goes", on the live chain. Uses the **live** lot size, tick size, freeze quantity and weekly/monthly expiry from the day's Upstox instrument master. Sizes to the most lots whose worst case (incl. slippage + charges) fits your risk. Rejects illiquid strikes (no bid/ask, wide spread, thin depth). |
| Before every order | Charges itemised (brokerage, STT, exchange txn, SEBI fee, stamp duty, GST) **and** the broker's own figure side by side; breakeven; max profit/loss; worst case; risk-neutral chance of profit; broker margin (with the hedge benefit). |
| Execution | Multi-leg, **hedge leg first**, IOC **limit** orders with a slippage cap, freeze-quantity slicing. If the second leg fails, the first is **unwound**; if that can't fill, it's flagged **NEEDS ATTENTION** with the exact open quantity. **No market orders, ever.** |
| Market hours | IST, with the holiday list from the broker's market-holidays API (cross-checked in tests against NSE's own holiday master), including special sessions such as Muhurat trading. |
| Account | Portfolio (positions, holdings, funds, P&L), order book with cancel, trades, GTT, P&L report. |
| Safety | Kill switch (blocks new entries; exits allowed); **Cancel all**; **Exit all** (reduce-only protective limits, typed `EXIT ALL`); optional per-trade cap and daily loss cap (**off by default**); typed **`REAL MONEY`** confirmation; ≤ 5 orders/s (SEBI's no-registration threshold is 10/s); live trading off unless the server sets `LIVE_TRADING_ENABLED=1`. |
| Paper mode | Fills simulated against **live** quotes (crossing the touch, capped at the displayed size), clearly labelled, `PAPER-` order ids, never mixed with real fills. Nothing reaches the broker. |
| Look and feel | One big sentence with coloured pills (index, direction, level, expiry, amount), each opening an animated popover: index/stock picker with price, day change and a sparkline when the broker reports them; level and amount sliders with "% from spot · x% chance"; expiries with weekly/monthly tags, days left and the chance per expiry. A floating dock (Options, Stocks, Portfolio, Orders, Safety) with a "Review for ₹X" button; a review screen with three outcomes, a P/L bar chart, collapsible contracts and a quote-freshness countdown. Mobile first; respects reduced motion. |
| Honesty | No made-up prices. Without a broker session the app says "Log in to Upstox" and shows no trades. Mock data exists only in tests. |

## Repository layout

```
src/core/        pure TypeScript shared by frontend and gateway (no I/O)
  charges.ts       dated charge schedules with cited sources
  instruments.ts   Upstox BOD instrument master → lot/tick/freeze/expiries
  calendar.ts      IST sessions, holidays, expiry rules (SEBI/NSE/BSE)
  strategy.ts      spread selection, payoff, breakeven, probability
  sentence.ts      plain-English parser + canonical sentence
  rules.ts         ticks, lots, freeze slicing, protective limits, liquidity
  risk.ts          server-side order checks, rate limiter, REAL MONEY phrase
  execution.ts     multi-leg executor with unwind; position closer
  paper.ts         paper broker on live quotes
  equity.ts        cash-equity tickets
gateway/         Node 22 HTTP server (no framework), Dockerfile at repo root
  brokers/types.ts       the broker-adapter interface
  brokers/upstox/        Upstox REST + V3 protobuf market feed
  brokers/stubs.ts       Zerodha / Dhan / Fyers / Angel: not implemented
web/             Vite frontend
tests/           unit · property (fast-check) · differential · gateway integration · E2E · opt-in live
deploy/          docker-compose + Caddy, nginx example, systemd unit
docs/            SETUP.md (deployment), REGULATIONS.md (sources)
```

## Run it locally (offline, against the mock broker)

Node 22.6+ (the gateway runs TypeScript directly with `--experimental-strip-types`).

```bash
npm ci
npm test                 # unit + property + differential + gateway integration
npx playwright install chromium
npm run test:e2e         # starts mock Upstox + the real gateway + the built frontend
```

To click around: run the three servers from `playwright.config.ts` (or `npm run test:e2e -- --headed`),
open http://127.0.0.1:18779 and sign in with `e2e passphrase 123`. That gateway talks to
the **mock** Upstox with recorded data and a clock frozen at the recording time.

## Tests

| Suite | Command | What |
|---|---|---|
| Unit + property | `npm run test:unit` | charges vs the published schedules (golden values + invariants), lot/tick/freeze rules, IST/holiday sessions, Black-Scholes, sentence round-trip, spread invariants, risk checks, rate limiter, executor (leg-fail unwind), paper fills |
| Differential | `npm run test:diff` | charges vs an independent integer-arithmetic reference; expiry rules + two official holiday lists vs the exchange's listed contracts; Black-Scholes vs numerical integration; spread maths vs brute-force settlement scan |
| Gateway | `npm run test:gateway` | real gateway + mock Upstox: auth, CORS, OAuth state, token at rest, paper/live, unwind, caps, kill switch, Exit all, rate limit, GTT, expired token, audit chain; JWT/scrypt/config/stub/feed units |
| E2E | `npm run test:e2e` | Playwright, desktop + Pixel 7, mock gateway stack |
| Live (opt-in) | `npm run test:live` | real Upstox: `LIVE_PUBLIC=1` (public data), `UPSTOX_ACCESS_TOKEN` (read-only, compares our charges with the broker's), `UPSTOX_SANDBOX_TOKEN` (sandbox orders). Never in CI. |

Fixtures in `tests/fixtures/` are **recorded public data** (Upstox instrument master and holiday API,
NSE option chains and holiday master) captured on 8 Oct 2026; see `tests/fixtures/README.md`.

## What is and isn't verified

**Verified offline (tests):** all the maths and rules above; the gateway's HTTP surface and
risk enforcement against a mock that follows Upstox's documented request/response shapes; the
UI flows on desktop and mobile, including every pill popover and the demo mode.

**Verified against the real Upstox (public, no login):** the instrument master download and
parsing, the holiday API, and the expiry rules against today's listed contracts.

**Not verified (needs your account):**
* The picker's day change (`net_change` in the full market quote) and sparkline (intraday
  30-minute candles) have only been exercised against the mock, which returns neither, so the
  UI hides them. They are coded from Upstox's documentation and untested with a real token.
* Upstox endpoints that need a login (chain, quotes, margin, brokerage, orders, positions, GTT,
  P&L, funds, the access-token-request webhook) are coded from Upstox's documentation and
  official SDK but have **not** been called with a real token. The opt-in live tests do that.
* The V3 WebSocket market feed decoder is tested on protobuf frames built from Upstox's own
  `.proto`, not on a live stream. The gateway falls back to REST polling if the feed fails.
* `Dockerfile` builds in CI (no Docker in the build sandbox).
* Upstox's sandbox (orders only) via `npm run test:live`.

**Stubbed:** Zerodha Kite, Dhan, Fyers, Angel SmartAPI adapters (throw `NotImplementedError`;
the gateway refuses to start with them).

## Safety rules baked in

* Never asks for or stores your broker password, PIN or TOTP; never uses TOTP-login endpoints.
  You log in on Upstox's own page; the gateway receives a one-time code.
* The access token is encrypted at rest (AES-256-GCM, key derived from `GATEWAY_JWT_SECRET`)
  and is never sent to the browser or written to the audit log.
* Live orders need: `LIVE_TRADING_ENABLED=1` on the server, a broker session, the Live toggle,
  a tick of "I understand I can lose ₹X", and typing `REAL MONEY`. The gateway re-checks
  everything server-side and recomputes the worst-case loss itself.

## Documentation

* [docs/SETUP.md](docs/SETUP.md): Upstox app, static IP whitelist, VPS, TLS reverse proxy,
  environment variables, deploy steps, daily login, troubleshooting.
* [docs/REGULATIONS.md](docs/REGULATIONS.md): every rule and rate with its official source.

## Disclaimer

This is personal software, not investment advice and not a SEBI-registered product. Options
can lose money quickly. Charges and rules change: the contract note and the exchange are final.
