// Decode Upstox Market Data Feed V3 frames (protobuf) into partial quotes.
import protobuf from "protobufjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Quote } from "../../../src/core/chain.ts";

let FeedResponse: protobuf.Type | null = null;
function type(): protobuf.Type {
  if (!FeedResponse) {
    const root = protobuf.parse(readFileSync(join(import.meta.dirname, "MarketDataFeedV3.proto"), "utf8"), { keepCase: true }).root;
    FeedResponse = root.lookupType("com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse");
  }
  return FeedResponse;
}

export function feedType(): protobuf.Type {
  return type();
}

interface Ltpc { ltp?: number; cp?: number }
interface Lvl { bidQ?: number | string; bidP?: number; askQ?: number | string; askP?: number }
interface FeedObj {
  feeds?: Record<string, {
    ltpc?: Ltpc;
    fullFeed?: { marketFF?: { ltpc?: Ltpc; marketLevel?: { bidAskQuote?: Lvl[] }; iv?: number; oi?: number }; indexFF?: { ltpc?: Ltpc } };
    firstLevelWithGreeks?: { ltpc?: Ltpc; firstDepth?: Lvl; iv?: number; oi?: number };
  }>;
}

const n = (x: unknown): number | undefined => (x === undefined || x === null ? undefined : Number(x));

/** One protobuf frame → { instrumentKey: partial quote }. */
export function decodeFeed(buf: Uint8Array, now: number): Record<string, Partial<Quote>> {
  const t = type();
  const obj = t.toObject(t.decode(buf), { longs: Number, defaults: false }) as FeedObj;
  const out: Record<string, Partial<Quote>> = {};
  for (const [key, f] of Object.entries(obj.feeds ?? {})) {
    const q: Partial<Quote> = { ts: now };
    const mff = f.fullFeed?.marketFF, iff = f.fullFeed?.indexFF, flg = f.firstLevelWithGreeks;
    const ltpc = f.ltpc ?? mff?.ltpc ?? iff?.ltpc ?? flg?.ltpc;
    if (ltpc?.ltp) q.ltp = ltpc.ltp;
    const lvl = mff?.marketLevel?.bidAskQuote?.[0] ?? flg?.firstDepth;
    if (lvl) {
      q.bid = lvl.bidP && lvl.bidP > 0 ? lvl.bidP : null;
      q.ask = lvl.askP && lvl.askP > 0 ? lvl.askP : null;
      q.bidQty = n(lvl.bidQ) ?? 0;
      q.askQty = n(lvl.askQ) ?? 0;
    }
    const iv = mff?.iv ?? flg?.iv;
    if (iv && iv > 0) q.iv = iv > 3 ? iv / 100 : iv; // the feed reports IV as a fraction or percent depending on mode
    const oi = mff?.oi ?? flg?.oi;
    if (oi !== undefined) q.oi = oi;
    out[key] = q;
  }
  return out;
}
