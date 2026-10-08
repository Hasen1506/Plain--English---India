# Test fixtures: recorded public data

Recorded on **Thu 8 Oct 2026, ~10:39 IST** (market open) from public, no-login sources. Each file
carries its `source` URL and `recordedAt`. Nothing here is invented; trims are noted.

| File | Source | Notes |
|---|---|---|
| `upstox-instruments.json` | https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz | Subset: the indices, NSE/BSE equities used in tests, and option/future rows for NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX and RELIANCE near expiries (2,328 rows). Re-record with `npm run record` |
| `upstox-expiries.json` | same master | Every listed expiry per underlying (timestamp, weekly flag, types) |
| `upstox-fo-specs.json` | same master | Lot / freeze / tick per F&O underlying (all of them) |
| `upstox-holidays.json` | https://api.upstox.com/v2/market/holidays | Full response body |
| `upstox-timings.json` | https://api.upstox.com/v2/market/timings/2026-10-08 | Full response body |
| `nse-holidays.json` | https://www.nseindia.com/api/holiday-master?type=trading | FO and CM lists |
| `nse-indices.json` | https://www.nseindia.com/api/allIndices | Subset of indices |
| `nse-chain-*.json` | https://www.nseindia.com/api/option-chain-v3 | Bid/ask/size/IV/OI per strike; the mock Upstox serves these as its option chain |

The mock Upstox server (`tests/mock/upstox-mock.ts`) adds simulated **orders, fills, positions,
holdings, funds and margin**. Those exist only in tests and are never shown by the real app.
