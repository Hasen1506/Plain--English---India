// Record PUBLIC commodity and currency reference data for the demo and the tests.
//   node --experimental-strip-types --no-warnings scripts/record-mcx.ts
//
// Sources (public, no login, no broker keys):
//   - Upstox BOD instrument master, MCX and NSE files
//       https://assets.upstox.com/market-quote/instruments/exchange/MCX.json.gz
//       https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz   (NCD_FO currency rows)
//   - MCX option chain (bid/ask/LTP/OI per strike + the underlying futures price)
//       https://www.mcxindia.com/market-data/option-chain  → GET /GetOptionChain?InstrumentType=optfut&Symbol=GOLD&Expiry=30oct2026
//     mcxindia.com sits behind a bot screen that refuses plain HTTP clients, so this uses a real
//     (headless) Chromium page and calls the same endpoint the page itself calls.
//   - NSE currency option chain is tried the same way; when it does not answer, no currency prices
//     are recorded and the demo says so.
// Set HTTPS_PROXY to go through a proxy. Output lands in tests/fixtures/.

import { gunzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const OUT = join(import.meta.dirname, "..", "tests", "fixtures");
const MCX_OPT = ["GOLD", "GOLDM", "SILVER", "SILVERM", "COPPER", "ZINC", "CRUDEOIL", "CRUDEOILM", "NATURALGAS"];
const MCX_ALL = [...MCX_OPT, "ALUMINIUM", "LEAD"];
const CUR = ["USDINR", "EURINR", "GBPINR", "JPYINR"];
const EXPIRIES_PER = 2; // nearest option expiries recorded per commodity

type Row = Record<string, unknown> & { segment: string; instrument_type: string; underlying_symbol?: string; expiry?: number; strike_price?: number };

const istStamp = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().replace("T", " ").slice(0, 16) + " IST";
const istDate = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10);
const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const mcxExpiry = (date: string) => `${date.slice(8, 10)}${MON[Number(date.slice(5, 7)) - 1]}${date.slice(0, 4)}`;

function proxyOpt(): { server: string; username?: string; password?: string } | undefined {
  const p = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!p) return undefined;
  const u = new URL(p);
  return { server: `${u.protocol}//${u.hostname}:${u.port}`, username: decodeURIComponent(u.username) || undefined, password: decodeURIComponent(u.password) || undefined };
}

async function master(file: string): Promise<Row[]> {
  const r = await fetch(`https://assets.upstox.com/market-quote/instruments/exchange/${file}`);
  if (!r.ok) throw new Error(`${file} HTTP ${r.status}`);
  return JSON.parse(gunzipSync(Buffer.from(await r.arrayBuffer())).toString("utf8")) as Row[];
}

async function main(): Promise<void> {
  const recordedAt = Date.now();
  const mcx = (await master("MCX.json.gz")).filter((r) => r.segment === "MCX_FO" && MCX_ALL.includes(String(r.underlying_symbol)));
  const ncd = (await master("NSE.json.gz")).filter((r) => r.segment === "NCD_FO" && CUR.includes(String(r.underlying_symbol)));
  const optExp = new Map<string, string[]>();
  for (const u of MCX_OPT) {
    const ex = [...new Set(mcx.filter((r) => r.underlying_symbol === u && r.instrument_type === "CE").map((r) => istDate(r.expiry!)))].sort();
    optExp.set(u, ex.slice(0, EXPIRIES_PER));
  }
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined, proxy: proxyOpt() });
  const page = await browser.newPage({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" });
  await page.goto("https://www.mcxindia.com/market-data/option-chain", { waitUntil: "networkidle", timeout: 90_000 });
  const chains: Record<string, unknown> = {};
  for (const u of MCX_OPT) {
    for (const date of optExp.get(u) ?? []) {
      const path = `/GetOptionChain?InstrumentType=optfut&Symbol=${u}&Expiry=${mcxExpiry(date)}`;
      const body = await page.evaluate(async (p) => {
        const r = await fetch(p);
        return r.ok ? await r.text() : `HTTP ${r.status}`;
      }, path);
      try {
        const j = JSON.parse(body) as { Summary: { AsOn: string }; Data: Record<string, unknown>[] };
        const asOn = Number(/\d+/.exec(j.Summary.AsOn)?.[0]);
        chains[`${u}:${date}`] = { source: `https://www.mcxindia.com${path}`, asOn: istStamp(asOn), asOnMs: asOn, underlyingValue: j.Data[0]?.UnderlyingValue ?? null, rows: j.Data };
        console.log(u, date, j.Data.length, "strikes, underlying", j.Data[0]?.UnderlyingValue, istStamp(asOn));
      } catch {
        console.log(u, date, "failed:", body.slice(0, 120));
      }
    }
  }
  // NSE currency option chains (same browser: nseindia.com also refuses plain HTTP clients)
  const cur: Record<string, unknown> = {};
  await page.goto("https://www.nseindia.com/option-chain", { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const nseDate = (s: string) => { const [d, m, y] = s.split("-"); return `${y}-${String(MON.indexOf(m!.toLowerCase()) + 1).padStart(2, "0")}-${d}`; };
  for (const u of CUR) {
    const path = `/api/option-chain-currency?symbol=${u}`;
    const body = await page.evaluate(async (p) => { try { const r = await fetch(p); return r.ok ? await r.text() : `HTTP ${r.status}`; } catch (e) { return String(e); } }, path);
    try {
      const j = JSON.parse(body) as { records: { timestamp?: string; underlyingValue?: number; expiryDates: string[]; data: { expiryDate: string; strikePrice: number; CE?: Record<string, unknown>; PE?: Record<string, unknown> }[] } };
      const upExp = new Set(ncd.filter((r) => r.underlying_symbol === u && r.instrument_type === "CE").map((r) => istDate(r.expiry!)));
      const inData = [...new Set(j.records.data.map((r) => nseDate(r.expiryDate)))].sort();
      const pick = inData.find((d) => upExp.has(d));
      if (!pick) { console.log(u, "no common expiry", inData.join(",")); continue; }
      const rows = j.records.data.filter((r) => nseDate(r.expiryDate) === pick && r.CE && r.PE);
      if (rows.length < 5) { console.log(u, pick, `only ${rows.length} strikes with both sides: not recorded`); continue; }
      cur[`${u}:${pick}`] = { source: `https://www.nseindia.com${path}`, timestamp: j.records.timestamp ?? null, rows };
      optExp.set(u, [pick]);
      console.log(u, pick, rows.length, "strikes", j.records.timestamp);
    } catch {
      console.log(u, "failed:", body.slice(0, 120));
    }
  }
  if (Object.keys(cur).length) writeFileSync(join(OUT, "nse-currency-chains.json"), JSON.stringify({ recordedAt: istStamp(recordedAt), source: "https://www.nseindia.com/api/option-chain-currency (public)", chains: cur }).replace(/\},\{/g, "},\n{") + "\n");

  // master subset: every future, plus the options of the recorded expiries within ±12% of the price recorded for them
  const ref = new Map<string, number>();
  for (const [k, c] of Object.entries(chains)) if ((c as { underlyingValue: number | null }).underlyingValue) ref.set(k, (c as { underlyingValue: number }).underlyingValue);
  for (const [k, c] of Object.entries(cur)) {
    const v = (c as { rows: { CE?: { underlyingValue?: number }; PE?: { underlyingValue?: number } }[] }).rows.map((r) => r.CE?.underlyingValue ?? r.PE?.underlyingValue).find((x) => x);
    if (v) ref.set(k, v);
  }
  const keep = [...mcx, ...ncd].filter((r) => {
    if (r.instrument_type === "FUT") return true;
    const k = `${r.underlying_symbol}:${istDate(r.expiry!)}`;
    const v = ref.get(k);
    return optExp.get(String(r.underlying_symbol))?.includes(istDate(r.expiry!)) && (!v || Math.abs(Number(r.strike_price) / v - 1) <= 0.12);
  });
  writeFileSync(
    join(OUT, "upstox-instruments-mcx-cds.json"),
    JSON.stringify({ recordedAt: istStamp(recordedAt), source: ["https://assets.upstox.com/market-quote/instruments/exchange/MCX.json.gz", "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz (NCD_FO rows)"], note: `MCX metals/energy and NSE currency rows: every future, plus the strikes within 12% of the recorded price for the recorded option expiries (${keep.length} rows)`, rows: keep }).replace(/\},\{/g, "},\n{") + "\n",
  );
  console.log("master rows kept", keep.length);
  for (const k of Object.keys(chains)) {
    const c = chains[k] as { underlyingValue: number | null; rows: Record<string, number>[] };
    if (c.underlyingValue) c.rows = c.rows.filter((r) => Math.abs(r.CE_StrikePrice! / c.underlyingValue! - 1) <= 0.12);
  }
  writeFileSync(join(OUT, "mcx-chains.json"), JSON.stringify({ recordedAt: istStamp(recordedAt), source: "https://www.mcxindia.com/market-data/option-chain (public)", quantities: "lots (as MCX publishes them)", chains }).replace(/\},\{/g, "},\n{") + "\n");
  await browser.close();
}

await main();
