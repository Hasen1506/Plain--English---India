import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { signJwt, verifyJwt, makeState, checkState, hashPassphrase, verifyPassphrase } from "../../gateway/auth.ts";
import { loadConfig, ConfigError } from "../../gateway/config.ts";
import { stubAdapter, STUB_BROKERS } from "../../gateway/brokers/stubs.ts";
import { NotImplementedError } from "../../gateway/brokers/types.ts";
import { upstoxExpiry, orderState } from "../../gateway/brokers/upstox/adapter.ts";
import { decodeFeed, feedType } from "../../gateway/brokers/upstox/feed.ts";
import { redact } from "../../gateway/audit.ts";
import { istMs } from "../../src/core/ist.ts";

const SECRET = "x".repeat(40);

describe("gateway auth primitives", () => {
  it("JWT: valid, expired, tampered, alg=none", () => {
    const now = 1_800_000_000_000;
    const t = signJwt({ sub: "owner", exp: now / 1000 + 60 }, SECRET);
    expect(verifyJwt(t, SECRET, now)).toMatchObject({ sub: "owner" });
    expect(verifyJwt(t, SECRET, now + 61_000)).toBeNull();
    expect(verifyJwt(t, "y".repeat(40), now)).toBeNull();
    const [h, b] = t.split(".");
    const forged = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${b}.`;
    expect(verifyJwt(forged, SECRET, now)).toBeNull();
    const body2 = Buffer.from(JSON.stringify({ sub: "owner", exp: now / 1000 + 1e6 })).toString("base64url");
    expect(verifyJwt(`${h}.${body2}.${t.split(".")[2]}`, SECRET, now)).toBeNull();
  });
  it("JWT round-trips any payload (property)", () => {
    fc.assert(fc.property(fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }).filter((k) => k !== "exp" && k !== "__proto__"), fc.string()), (p) => {
      const t = signJwt({ ...p, exp: 2e9 }, SECRET);
      expect(verifyJwt(t, SECRET, 1e12)).toMatchObject(p);
    }), { numRuns: 50 });
  });
  it("OAuth state: signed, expiring, unforgeable", () => {
    const s = makeState(SECRET, 1000);
    expect(checkState(s, SECRET, 2000)).toBe(true);
    expect(checkState(s, SECRET, 1000 + 11 * 60_000)).toBe(false);
    const [n, e, mac] = s.split(".") as [string, string, string];
    expect(checkState(`${n}.${e}.${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`, SECRET, 2000)).toBe(false);
    // a changed last character that decodes to the same bytes (unused low bits) is still refused
    for (const c of "ABCD") expect(checkState(`${n}.${e}.${mac.slice(0, -1)}${c}`, SECRET, 2000)).toBe(mac.endsWith(c));
    expect(checkState("a.b", SECRET, 0)).toBe(false);
  });
  it("passphrase hashing (scrypt) verifies only the right passphrase", () => {
    const h = hashPassphrase("long enough passphrase", Buffer.alloc(16, 1), 1024);
    expect(verifyPassphrase("long enough passphrase", h)).toBe(true);
    expect(verifyPassphrase("long enough passphrasE", h)).toBe(false);
    expect(verifyPassphrase("x", "plaintext")).toBe(false);
  });
  it("audit redaction removes tokens and secrets but keeps rule codes", () => {
    expect(redact({ access_token: "a", nested: { client_secret: "b", ok: 1 }, rule: "kill-switch", code: "risk" })).toEqual({ access_token: "[redacted]", nested: { client_secret: "[redacted]", ok: 1 }, rule: "kill-switch", code: "risk" });
  });
});

describe("gateway configuration", () => {
  const base = { UPSTOX_API_KEY: "k", UPSTOX_API_SECRET: "s", UPSTOX_REDIRECT_URI: "https://gw.example/auth/broker/callback", GATEWAY_PASSPHRASE_HASH: hashPassphrase("a long passphrase", Buffer.alloc(16), 1024), GATEWAY_JWT_SECRET: SECRET, CORS_ORIGINS: "https://me.github.io" };
  it("defaults: live trading OFF, 5 orders/s, caps off", () => {
    const c = loadConfig(base);
    expect(c.liveTrading).toBe(false);
    expect(c.risk.maxOrdersPerSecond).toBe(5);
    expect(c.risk.perTradeCap).toBeNull();
    expect(c.risk.dailyLossCap).toBeNull();
  });
  it.each([
    [{ GATEWAY_JWT_SECRET: "short" }, /32 characters/],
    [{ GATEWAY_PASSPHRASE_HASH: "hunter2" }, /gateway:hash/],
    [{ CORS_ORIGINS: "" }, /CORS_ORIGINS/],
    [{ RISK_MAX_ORDERS_PER_SEC: "10" }, /1…9/],
    [{ BROKER: "zerodha" }, /stub/],
    [{ ALLOWED_SEGMENTS: "MCX_FO" }, /unknown segment/],
    [{ GATEWAY_FAKE_NOW: "1", NODE_ENV: "test" }, /tests only/], // real Upstox URLs → refused
    [{ UPSTOX_API_SECRET: "" }, /UPSTOX_API_SECRET/],
  ])("refuses %j", (over, re) => {
    expect(() => loadConfig({ ...base, ...over })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, ...over })).toThrow(re);
  });
});

describe("broker adapters", () => {
  it("Zerodha, Dhan, Fyers, Angel are stubs that throw NotImplementedError", async () => {
    expect(STUB_BROKERS.sort()).toEqual(["angel", "dhan", "fyers", "zerodha"]);
    for (const b of STUB_BROKERS) {
      const a = stubAdapter(b);
      expect(a.info.status).toBe("not-implemented");
      expect(a.session()).toBeNull();
      expect(() => a.place({} as never)).toThrow(NotImplementedError);
      expect(() => a.optionChain({} as never, "NIFTY", "2026-10-13")).toThrow(/not implemented/);
    }
  });
  it("Upstox token expiry is 03:30 IST the next day (or the same day before 03:30)", () => {
    expect(upstoxExpiry(istMs("2026-10-08", 20, 0))).toBe(istMs("2026-10-09", 3, 30));
    expect(upstoxExpiry(istMs("2026-10-08", 2, 30))).toBe(istMs("2026-10-08", 3, 30));
    expect(upstoxExpiry(istMs("2026-10-08", 9, 15))).toBe(istMs("2026-10-09", 3, 30));
  });
  it("Upstox order statuses map to terminal/non-terminal states", () => {
    expect(orderState("complete")).toBe("complete");
    expect(orderState("rejected")).toBe("rejected");
    expect(orderState("cancelled")).toBe("cancelled");
    expect(orderState("open")).toBe("open");
    expect(orderState("trigger pending")).toBe("open");
    expect(orderState("validation pending")).toBe("pending");
    expect(orderState(undefined)).toBe("pending");
  });
  it("Upstox V3 market-data feed: protobuf frames decode into quotes", () => {
    const T = feedType();
    const msg = T.fromObject({
      type: 1,
      currentTs: 1791436140000,
      feeds: {
        "NSE_FO|44443": { fullFeed: { marketFF: { ltpc: { ltp: 73, cp: 44.7 }, marketLevel: { bidAskQuote: [{ bidQ: 1755, bidP: 73.05, askQ: 585, askP: 73.25 }] }, iv: 0.1413, oi: 85568 } } },
        "NSE_INDEX|Nifty 50": { fullFeed: { indexFF: { ltpc: { ltp: 22454.65, cp: 22500 } } } },
        "NSE_FO|1": { ltpc: { ltp: 12.5 } },
      },
    });
    const out = decodeFeed(T.encode(msg).finish(), 42);
    expect(out["NSE_FO|44443"]).toMatchObject({ ltp: 73, bid: 73.05, ask: 73.25, bidQty: 1755, askQty: 585, oi: 85568, ts: 42 });
    expect(out["NSE_FO|44443"]!.iv).toBeCloseTo(0.1413);
    expect(out["NSE_INDEX|Nifty 50"]).toMatchObject({ ltp: 22454.65 });
    expect(out["NSE_FO|1"]).toMatchObject({ ltp: 12.5 });
  });
});
