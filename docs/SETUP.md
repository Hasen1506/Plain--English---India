# Setup and deployment

You need four things. None of them exist yet, and this repo can't create them for you:

1. **A GitHub repository** for the frontend (GitHub Pages) and CI.
2. **A server in India with a static IPv4 address** for the gateway.
3. **A domain name** (or subdomain) pointing at that IP, for HTTPS.
4. **An Upstox developer app** with that IP whitelisted.

Time needed: about an hour, plus Upstox's app activation.

> Why a server? SEBI's retail-algo framework (circular of 4 Feb 2025, in force from 1 Apr 2026)
> lets API orders come only from a **static IP registered on the API key**. A browser on your
> phone or laptop does not have one. The gateway is that fixed point. See [REGULATIONS.md](REGULATIONS.md).

---

## 1. GitHub repository and Pages

```bash
cd plain-english-india
git remote add origin git@github.com:<you>/plain-english-india.git
git push -u origin main
```

On GitHub:

* **Settings → Pages → Build and deployment → Source: GitHub Actions.**
* **Settings → Secrets and variables → Actions → Variables → New repository variable:**
  `GATEWAY_URL` = `https://gw.example.in` (your gateway's address, step 3). Optional: without it,
  the app asks for the gateway URL on first open and remembers it in the browser.

Every push to `main` runs `.github/workflows/ci.yml`: lint, typecheck, the unit/property/
differential/gateway suites, Playwright E2E (desktop + mobile), a Docker build of the
gateway, and then (only if tests pass) deploys `dist/` to Pages at
`https://<you>.github.io/plain-english-india/`. Pull requests run the tests only. A newer
push cancels an older run on the same branch.

## 2. A server with a static IP (India region)

Any small Linux VM works (1 vCPU, 1 GB RAM is plenty). Pick a region in India for latency,
and make sure the public IPv4 is **static** (reserved), not ephemeral:

| Provider | Region | Static IP feature |
|---|---|---|
| AWS Lightsail / EC2 | Mumbai (ap-south-1), Hyderabad (ap-south-2) | Lightsail static IP / EC2 Elastic IP |
| Google Cloud | Mumbai (asia-south1), Delhi (asia-south2) | Reserved static external IP |
| Microsoft Azure | Central India (Pune), South India (Chennai) | Static public IP |
| DigitalOcean | Bangalore (BLR1) | Reserved IP |
| Akamai / Linode | Mumbai, Chennai | IPs on a Linode are static |
| Oracle Cloud | Mumbai, Hyderabad | Reserved public IP |

Notes:

* The whitelisted IP is what the **broker sees**. If your provider's outbound traffic uses a
  different address than the inbound one (NAT gateways, some reserved-IP setups), whitelist
  the **outbound** address. Check from the server: `curl -4 https://ifconfig.me`.
* NSE's implementation standards allow changing the static IP **at most once a calendar
  week**, and Upstox invalidates the access token when the IP changes. Choose carefully.
* Harden the box: SSH keys only, `ufw allow 22,80,443/tcp`, automatic security updates.

Install Docker (Ubuntu): `curl -fsSL https://get.docker.com | sh`.

## 3. Domain and HTTPS

Create a DNS **A record**, e.g. `gw.example.in → <static IP>`. HTTPS is handled by **Caddy**
in `deploy/docker-compose.yml`, which gets a Let's Encrypt certificate automatically once DNS
resolves. (Prefer nginx? `deploy/nginx.conf.example` + certbot. No Docker?
`deploy/plain-english-india-gateway.service` for systemd with Node 22.6+.)

## 4. Upstox developer app

1. Log in at **https://account.upstox.com/developer/apps** and create a new app.
2. **Redirect URL:** `https://gw.example.in/auth/broker/callback` (must match `UPSTOX_REDIRECT_URI` exactly).
3. **Notifier webhook URL** (optional, enables the "send login request to my phone" button):
   `https://gw.example.in/webhook/upstox/notifier`.
4. **Static IP:** add your server's IP as the primary static IP (Upstox: *My Apps → Static IP*,
   also settable via `PUT /v2/user/ip`). Orders from any other IP fail with `UDAPI1154`.
5. Copy the **API key** and **API secret**. The secret goes only into the server's `.env`.
6. Optional, for testing order calls without real money: create a **sandbox app** under
   *My Apps → Sandbox* (https://account.upstox.com/developer/apps#sandbox) and generate a
   sandbox token (valid 30 days). Use it only with `npm run test:live`.

You do **not** need exchange algo registration: this app sends far fewer than 10 orders per
second (it is capped at 5/s, configurable 1–9) and only acts when you press a button.
Upstox documents its own API rate limits separately; the gateway stays well under them.

## 5. Configure the gateway

On your laptop (in the repo), make the two secrets:

```bash
npm run gateway:hash -- "a long passphrase only you know"   # → GATEWAY_PASSPHRASE_HASH
openssl rand -hex 32                                         # → GATEWAY_JWT_SECRET
```

On the server:

```bash
git clone https://github.com/<you>/plain-english-india.git && cd plain-english-india
cp .env.example .env && chmod 600 .env && nano .env
```

### Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `UPSTOX_API_KEY` | yes | App's API key (client_id) |
| `UPSTOX_API_SECRET` | yes | App's API secret. Never leaves the server. |
| `UPSTOX_REDIRECT_URI` | yes | `https://<gateway>/auth/broker/callback`, identical to the app's Redirect URL |
| `GATEWAY_PASSPHRASE_HASH` | yes | scrypt hash from `npm run gateway:hash` |
| `GATEWAY_JWT_SECRET` | yes | ≥ 32 random chars. Signs gateway sessions and encrypts the stored broker token. |
| `CORS_ORIGINS` | yes | Your Pages origin, e.g. `https://<you>.github.io` (comma-separated list allowed) |
| `FRONTEND_URL` | recommended | Where to send you back after broker login, e.g. `https://<you>.github.io/plain-english-india/` |
| `LIVE_TRADING_ENABLED` | no (default `0`) | `1` allows real orders. Leave `0` until paper trading looks right. |
| `RISK_MAX_ORDERS_PER_SEC` | no (default `5`) | 1–9. SEBI's no-registration threshold is 10/s. |
| `ALLOWED_SEGMENTS` | no | Default `NSE_FO,BSE_FO,NSE_EQ,BSE_EQ`. Remove one to forbid it server-side. |
| `GATEWAY_SESSION_HOURS` | no (default 12) | Gateway sign-in lifetime |
| `TRUST_PROXY` | behind a proxy | `1` behind Caddy/nginx (login throttling uses the real client IP) |
| `HOST`, `PORT`, `DATA_DIR` | no | Compose sets `0.0.0.0`, `8080`, `/data` |
| `UPSTOX_SANDBOX_TOKEN` | no | Points **orders** at the Upstox sandbox. The app then refuses live trades; use the opt-in tests. |
| `UPSTOX_ALGO_NAME` | no | `X-Algo-Name` header, only for an exchange-approved algo. Not needed here. |
| `BROKER` | no | `upstox` (others are stubs; the gateway won't start with them) |

The per-trade cap and daily loss cap are set in the app (Safety tab), **off by default**,
and stored on the gateway.

## 6. Deploy

```bash
GATEWAY_DOMAIN=gw.example.in docker compose -f deploy/docker-compose.yml up -d --build
curl https://gw.example.in/health        # {"ok":true,...,"instruments":<n>,"holidays":"Upstox market holidays API"}
docker compose -f deploy/docker-compose.yml logs -f gateway
```

The gateway refuses to start (exit code 2) when a required variable is missing or weak, and
says which one.

Data on the server (Docker volume `gateway-data`, or `DATA_DIR`):
* `audit.jsonl`: append-only, SHA-256 hash-chained log of logins, risk blocks, every order sent,
  cancels, kill-switch actions. Back it up. Secrets are redacted.
* `state.json`: risk caps, kill switch, paper book.
* `broker-session.json`: today's access token, AES-256-GCM encrypted.

Updating: `git pull && docker compose -f deploy/docker-compose.yml up -d --build`.

## 7. First use

1. Open `https://<you>.github.io/plain-english-india/`, enter the gateway URL (if you didn't set
   `GATEWAY_URL`) and your passphrase.
2. Click **Log in to Upstox**. You log in **on Upstox's site** (password/PIN/TOTP go to Upstox, never
   to this app), then land back in the app with "Upstox connected".
3. Use **Paper** mode first. Paper fills use live quotes and are clearly labelled.
4. When ready, set `LIVE_TRADING_ENABLED=1`, restart, switch to **Live**, and type `REAL MONEY` to
   confirm each trade.

### Daily re-login

Upstox access tokens expire at **03:30 IST** every day. Each morning the app shows **Log in to Upstox**
again. Two ways:

* **Log in to Upstox** (browser redirect), or
* **Send login request to my phone** (Safety tab): the gateway calls Upstox's access-token request API;
  you approve in the Upstox app/WhatsApp; Upstox posts the token to the notifier webhook. The gateway only
  accepts a webhook token while a request it made is pending, checks it belongs to your app, and verifies it
  against your profile.

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `UDAPI1154` on orders | The server's outbound IP isn't the whitelisted static IP. Check `curl -4 ifconfig.me` on the server and Upstox *My Apps → Static IP*. |
| `UDAPI100050` / "Log in to Upstox" | Token expired (03:30 IST) or was invalidated (IP change, logout). Log in again. |
| `UDAPI1158` | Market orders are blocked by the exchange; this app never sends them. If you see it, report a bug. |
| "Origin not allowed" | `CORS_ORIGINS` must be exactly the scheme+host of your Pages site, no path. |
| "Live trading is disabled" | `LIVE_TRADING_ENABLED=1` is not set (by design the default). |
| "Holiday list unavailable; trading paused" | The gateway couldn't reach Upstox's holiday API at start-up; it retries daily. Restart once the network is fine. |
| Broker login returns `#broker=bad-state` | The login link is valid for 10 minutes, or the gateway was restarted with a new `GATEWAY_JWT_SECRET`. Start again. |

## 9. Running the tests yourself

```bash
npm ci
npm test                              # unit, property, differential, gateway (offline, ~15 s)
npx playwright install chromium && npm run test:e2e
LIVE_PUBLIC=1 npm run test:live       # real public Upstox data, no login
UPSTOX_ACCESS_TOKEN=... npm run test:live    # read-only checks incl. our charges vs Upstox's brokerage API
UPSTOX_SANDBOX_TOKEN=... npm run test:live   # sandbox order place/modify/cancel
```

Live tests are never run in CI and never place a real order.
