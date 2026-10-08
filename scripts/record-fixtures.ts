// Re-record the offline test fixtures from PUBLIC, unauthenticated sources.
//   node --experimental-strip-types scripts/record-fixtures.ts
//
// Sources (all public, no login, no broker keys):
//   - Upstox BOD instrument master   https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz
//   - Upstox market holidays/timings https://api.upstox.com/v2/market/holidays , /v2/market/timings/{date}
//   - NSE holiday master             https://www.nseindia.com/api/holiday-master?type=trading
//   - NSE option chain (live quotes) https://www.nseindia.com/api/option-chain-v3  (used ONLY as test fixtures;
//     the app itself never reads NSE, it reads quotes from the broker through the gateway)
//
// The trimmed files land in tests/fixtures/. Nothing here is ever shipped to the browser bundle.

import { gunzipSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "..", "tests", "fixtures");
mkdirSync(OUT, { recursive: true });
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

type Row = Record<string, unknown> & {
  segment: string; instrument_type: string; instrument_key: string; trading_symbol: string;
  underlying_symbol?: string; expiry?: number; strike_price?: number; lot_size?: number;
};

const INDEX_UNDERLYINGS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"];
const STOCKS = ["RELIANCE", "TCS", "INFY", "HDFCBANK", "SBIN", "IDEA"];

function save(name: string, data: unknown): void {
  // one array element per line: small diffs, small files
  const body = JSON.stringify(data, (_k, v) => v, 0).replace(/\},\{/g, "},\n{");
  writeFileSync(join(OUT, name), body + "\n");
  console.log("wrote", name);
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...headers } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

async function nseSession(): Promise<string> {
  const r = await fetch("https://www.nseindia.com/option-chain", { headers: { "User-Agent": UA } });
  const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return cookies;
}

async function main(): Promise<void> {
  const recordedAt = new Date().toISOString();
  // ── instrument master ───────────────────────────────────────────────
  const gz = await fetch("https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz");
  const all = JSON.parse(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString("utf8")) as Row[];
  console.log("master rows", all.length);

  const fo = all.filter((r) => (r.segment === "NSE_FO" || r.segment === "BSE_FO") && ["CE", "PE", "FUT"].includes(r.instrument_type));
  // every expiry of every index underlying (for the calendar differential test)
  const expiries: Record<string, { expiry: number; weekly: boolean; types: string[] }[]> = {};
  for (const u of INDEX_UNDERLYINGS) {
    const m = new Map<number, { weekly: boolean; types: Set<string> }>();
    for (const r of fo.filter((x) => x.underlying_symbol === u)) {
      const e = m.get(r.expiry!) ?? { weekly: false, types: new Set<string>() };
      e.weekly ||= Boolean(r.weekly);
      e.types.add(r.instrument_type);
      m.set(r.expiry!, e);
    }
    expiries[u] = [...m.entries()].sort((a, b) => a[0] - b[0]).map(([expiry, v]) => ({ expiry, weekly: v.weekly, types: [...v.types].sort() }));
  }
  save("upstox-expiries.json", { recordedAt, source: "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz", expiries });

  // contract specs of every F&O underlying (lot / freeze / tick), for the rules property tests
  const specs: Record<string, { segment: string; lot: number[]; freeze: number[]; tick: number[] }> = {};
  for (const r of fo) {
    const k = `${r.segment}:${r.underlying_symbol}`;
    const s = (specs[k] ??= { segment: r.segment, lot: [], freeze: [], tick: [] });
    for (const [arr, v] of [[s.lot, r.lot_size], [s.freeze, r.freeze_quantity], [s.tick, r.tick_size]] as [number[], unknown][]) {
      if (typeof v === "number" && !arr.includes(v)) arr.push(v);
    }
  }
  save("upstox-fo-specs.json", { recordedAt, specs });

  // trimmed master: index + stock options for the nearest expiries, futures, indices and a few equities
  const keepOpt = (u: string, n: number): Row[] => {
    const exps = expiries[u]?.map((e) => e.expiry) ?? [...new Set(fo.filter((r) => r.underlying_symbol === u).map((r) => r.expiry!))].sort((a, b) => a - b);
    const near = new Set(exps.slice(0, n));
    return fo.filter((r) => r.underlying_symbol === u && near.has(r.expiry!));
  };
  const trimmed: Row[] = [
    ...keepOpt("NIFTY", 3), ...keepOpt("BANKNIFTY", 1), ...keepOpt("FINNIFTY", 1), ...keepOpt("MIDCPNIFTY", 1), ...keepOpt("SENSEX", 2),
    ...keepOpt("RELIANCE", 1),
    ...all.filter((r) => (r.segment === "NSE_EQ" && r.instrument_type === "EQ" && STOCKS.includes(r.trading_symbol)) || (r.segment === "BSE_EQ" && STOCKS.includes(r.trading_symbol))),
    ...all.filter((r) => r.segment === "NSE_INDEX" && ["Nifty 50", "Nifty Bank", "Nifty Fin Service", "NIFTY MID SELECT", "India VIX"].includes(String(r.name))),
    ...all.filter((r) => r.segment === "BSE_INDEX" && ["SENSEX", "BANKEX"].includes(r.trading_symbol)),
  ];
  save("upstox-instruments.json", { recordedAt, source: "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz", rows: trimmed });

  // ── holidays / timings ──────────────────────────────────────────────
  save("upstox-holidays.json", { recordedAt, source: "https://api.upstox.com/v2/market/holidays", body: await getJson("https://api.upstox.com/v2/market/holidays") });
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  save("upstox-timings.json", { recordedAt, date: today, source: `https://api.upstox.com/v2/market/timings/${today}`, body: await getJson(`https://api.upstox.com/v2/market/timings/${today}`) });

  // ── NSE public data (best effort; NSE sometimes blocks non-browser clients) ──
  try {
    const cookie = await nseSession();
    const h = { Cookie: cookie, Referer: "https://www.nseindia.com/option-chain" };
    const hol = (await getJson("https://www.nseindia.com/api/holiday-master?type=trading", h)) as Record<string, unknown>;
    save("nse-holidays.json", { recordedAt, source: "https://www.nseindia.com/api/holiday-master?type=trading", FO: hol.FO, CM: hol.CM });
    const chains: [string, "Indices" | "Equity", number][] = [["NIFTY", "Indices", 0], ["NIFTY", "Indices", 2], ["BANKNIFTY", "Indices", 0], ["FINNIFTY", "Indices", 0], ["RELIANCE", "Equity", 0]];
    for (const [sym, type, i] of chains) {
      const info = (await getJson(`https://www.nseindia.com/api/option-chain-contract-info?symbol=${sym}`, h)) as { expiryDates: string[] };
      const exp = info.expiryDates[i]!;
      const oc = (await getJson(`https://www.nseindia.com/api/option-chain-v3?type=${type}&symbol=${sym}&expiry=${exp}`, h)) as { records: { underlyingValue: number; timestamp: string; data: { strikePrice: number }[] } };
      const spot = oc.records.underlyingValue;
      const data = oc.records.data.filter((r) => Math.abs(r.strikePrice / spot - 1) <= 0.12);
      save(`nse-chain-${sym}-${exp}.json`, { recordedAt, source: `https://www.nseindia.com/api/option-chain-v3?type=${type}&symbol=${sym}&expiry=${exp}`, timestamp: oc.records.timestamp, underlyingValue: spot, expiry: exp, data });
    }
    const idx = (await getJson("https://www.nseindia.com/api/allIndices", h)) as { timestamp: string; data: { index: string; last: number }[] };
    save("nse-indices.json", { recordedAt, source: "https://www.nseindia.com/api/allIndices", timestamp: idx.timestamp, data: idx.data.filter((d) => ["NIFTY 50", "NIFTY BANK", "NIFTY FINANCIAL SERVICES", "NIFTY MIDCAP SELECT", "INDIA VIX"].includes(d.index)).map((d) => ({ index: d.index, last: d.last })) });
  } catch (e) {
    console.warn("NSE fixtures skipped:", (e as Error).message);
  }
}

await main();
