# Rules, rates and their sources

Everything the app enforces or computes, with the official source it was taken from.
Checked October 2026. Rates change: `src/core/charges.ts` keeps dated schedules and picks the
one in force on the trade date.

## Retail algo / API trading framework

| Rule | Source |
|---|---|
| API access by OAuth only, with 2FA; orders only from a static IP whitelisted per API key; broker accountable for API orders | SEBI circular *Safer participation of retail investors in Algorithmic trading*, 4 Feb 2025: https://www.sebi.gov.in/legal/circulars/feb-2025/safer-participation-of-retail-investors-in-algorithmic-trading_91614.html (PDF https://www.sebi.gov.in/sebi_data/attachdocs/feb-2025/1738665456458.pdf) |
| Exchange implementation standards: static IP may change at most once per calendar week; orders-per-second (TOPS) threshold of 10 per exchange below which no algo registration is needed; effective 1 Apr 2026 | NSE circular: https://nsearchives.nseindia.com/content/circulars/INVG67858.pdf |
| FAQ: algo IDs, generic tag for sub-threshold orders (starts `444444444444`) | NSE FAQ, 3 Nov 2025: https://nsearchives.nseindia.com/web/sites/default/files/inline-files/FAQ_Retail%20Algo_03112025_NSE.pdf |

What the app does about it: orders only via the gateway on your static IP; OAuth login on
Upstox's own page; rate-limited to 5 orders/s (max 9); every order is a human-confirmed action;
no TOTP automation.

## Expiries

| Rule | Source |
|---|---|
| One weekly benchmark index option per exchange; other index and stock derivatives monthly | SEBI circular, 26 May 2025: https://www.sebi.gov.in/sebi_data/attachdocs/may-2025/1748266377271.pdf |
| NSE expiry day Tuesday (NIFTY weekly; monthlies on the last Tuesday) | NSE circular FAOP68747: https://nsearchives.nseindia.com/web/sites/default/files/inline-files/FAOP68747.pdf |
| BSE expiry day Thursday (SENSEX weekly; monthlies on the last Thursday) | BSE notice 20250623-59 |
| Expiry on a holiday moves to the previous trading day; NIFTY has 4 weekly contracts besides monthlies | NSE contract specifications: https://www.nseindia.com/static/products-services/equity-derivatives-contract-specifications |

The app never computes which contracts exist: it lists what the day's **instrument master** has. The
rules above are used as an independent cross-check in the tests (`tests/diff/expiry.diff.test.ts`).

## Lot size, tick size, freeze quantity

From the Upstox BOD instrument master (public, refreshed daily):
https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz
(documented at https://upstox.com/developer/api-documentation/instruments). On 8 Oct 2026:
NIFTY lot 65 / freeze 3,510; BANKNIFTY 30 / 1,440; FINNIFTY 60 / 3,240; MIDCPNIFTY 120 / 5,760;
SENSEX 20 / 1,000; option tick ₹0.05. The app always uses the live values.

## Market hours and holidays

* Sessions: normal market 09:15–15:30 IST; equity pre-open 09:00–09:15. https://www.nseindia.com/market-data/timings
* Holidays at runtime: Upstox market holidays API `GET /v2/market/holidays` (public):
  https://upstox.com/developer/api-documentation/get-market-holidays. Cross-checked in tests against
  NSE's holiday master https://www.nseindia.com/api/holiday-master?type=trading (as published on
  https://www.nseindia.com/resources/exchange-communication-holidays).

## Charges (from 1 Apr 2026)

| Charge | Rate | Source |
|---|---|---|
| Brokerage (Upstox) | delivery ₹20/order; intraday min(₹20, 0.1%); futures min(₹20, 0.05%); options ₹20/order | https://upstox.com/brokerage-charges/ |
| STT (Finance Act 2026) | options sell 0.15% of premium; exercised options 0.15% of intrinsic (buyer); futures sell 0.05%; delivery 0.1% both sides; intraday sell 0.025% | https://www.nseindia.com/static/invest/first-time-investor-sebi-turnover-fees-stt-other-levies; NSE circular NSE/FATAX/73524 (31 Mar 2026) |
| NSE transaction charges (from 1 Mar 2026) | cash 0.00307%; futures 0.00183%; options 0.03553% of premium; IPFT ₹0.01/cr (₹1/cr options) | NSE/FA/73061: https://nsearchives.nseindia.com/content/circulars/FA73061.pdf |
| BSE transaction charges | options 0.0325% of premium; equity derivatives futures nil; equity by scrip group | https://upstox.com/brokerage-charges/ |
| SEBI turnover fee | ₹10 per crore | https://upstox.com/brokerage-charges/ |
| Stamp duty (buy side) | delivery 0.015%; intraday 0.003%; futures 0.002%; options 0.003% | Indian Stamp Act as amended, uniform from 1 Jul 2020; https://upstox.com/brokerage-charges/ |
| GST | 18% of brokerage + transaction charges (+ DP) | https://upstox.com/brokerage-charges/ |
| DP charge | ₹20 + GST per scrip per day on delivery sells (Upstox) | https://upstox.com/brokerage-charges/ |

Before each order the review screen also shows Upstox's own figure from
`GET /v2/charges/brokerage`. The contract note is final.

## Upstox API

Documentation index: https://upstox.com/developer/api-documentation/llms.txt

| Use | Endpoint |
|---|---|
| Login dialog | `GET https://api.upstox.com/v2/login/authorization/dialog` |
| Code → token (expires 03:30 IST next day) | `POST /v2/login/authorization/token` |
| Login request to the user's phone (token to notifier webhook) | `POST /v3/login/auth/token/request/{client_id}` |
| Instruments | `https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz` |
| Option chain / quotes / LTP | `GET /v2/option/chain`, `GET /v2/market-quote/quotes`, `GET /v3/market-quote/ltp` |
| Market feed (protobuf) | `GET /v3/feed/market-data-feed/authorize` → `wss://…` |
| Orders (slicing via `slice: true`) | `POST/PUT/DELETE https://api-hft.upstox.com/v3/order/place|modify|cancel` |
| Order book, details, trades | `GET /v2/order/retrieve-all`, `/v2/order/details`, `/v2/order/trades/get-trades-for-day` |
| Cancel all / exit all | `DELETE /v2/order/multi/cancel`, `POST /v2/order/positions/exit` |
| GTT | `POST /v3/order/gtt/place`, `PUT …/modify`, `DELETE …/cancel`, `GET /v3/order/gtt` |
| Positions / holdings / funds | `GET /v2/portfolio/short-term-positions`, `/v2/portfolio/long-term-holdings`, `/v3/user/get-funds-and-margin` |
| Margin / brokerage | `POST /v2/charges/margin`, `GET /v2/charges/brokerage` |
| P&L report | `GET /v2/trade/profit-loss/data` |
| Static IP | `GET/PUT /v2/user/ip` |
| Sandbox (orders only) | `https://api-sandbox.upstox.com` |

Error codes the app handles: `UDAPI100050` (invalid/expired token → re-login), `UDAPI1154`
(static-IP restriction), `UDAPI1158` (market orders blocked; never sent).

Protobuf schema for the feed: copied from the official `upstox-js-sdk` (MIT), also at
https://assets.upstox.com/feed/market-data-feed/v3/MarketDataFeed.proto.

## Other brokers (not implemented)

Zerodha Kite Connect https://kite.trade/docs/connect/v3/ · Dhan https://dhanhq.co/docs/v2/ ·
Fyers https://myapi.fyers.in/docsv3 · Angel One SmartAPI https://smartapi.angelbroking.com/docs
