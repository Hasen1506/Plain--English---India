// Gateway configuration from environment variables. See docs/SETUP.md and .env.example.
// The gateway refuses to start when a required secret is missing or weak.

import type { BrokerId } from "./brokers/types.ts";
import { DEFAULT_RISK, OPS_HARD_LIMIT, type RiskConfig } from "../src/core/risk.ts";
import type { Segment } from "../src/core/instruments.ts";

export interface GatewayConfig {
  host: string;
  port: number;
  dataDir: string | null; // audit log + state; null = memory only (tests)
  broker: BrokerId;
  upstox: {
    apiKey: string;
    apiSecret: string;
    redirectUri: string;
    sandboxToken: string | null;
    baseUrl?: string;
    hftUrl?: string;
    assetsUrl?: string;
    loginUrl?: string;
    sandboxUrl?: string;
    algoName: string | null;
  };
  passphraseHash: string;
  jwtSecret: string;
  jwtTtlMs: number;
  corsOrigins: string[];
  frontendUrl: string | null;
  trustProxy: boolean;
  liveTrading: boolean; // LIVE_TRADING_ENABLED=1: without it, only paper orders are possible
  risk: RiskConfig;
  fakeNow: number | null; // test only
}

export class ConfigError extends Error {}

const SEGMENTS: Segment[] = ["NSE_EQ", "BSE_EQ", "NSE_FO", "BSE_FO", "MCX_FO", "NCD_FO"];

export function loadConfig(env: Record<string, string | undefined>): GatewayConfig {
  const need = (k: string): string => {
    const v = env[k]?.trim();
    if (!v) throw new ConfigError(`${k} is required`);
    return v;
  };
  const broker = (env.BROKER ?? "upstox").toLowerCase() as BrokerId;
  if (broker !== "upstox") throw new ConfigError(`BROKER=${broker}: only "upstox" is implemented; ${broker} is a stub (see gateway/brokers/stubs.ts)`);
  const jwtSecret = need("GATEWAY_JWT_SECRET");
  if (jwtSecret.length < 32) throw new ConfigError("GATEWAY_JWT_SECRET must be at least 32 characters (openssl rand -hex 32)");
  const passphraseHash = need("GATEWAY_PASSPHRASE_HASH");
  if (!passphraseHash.startsWith("scrypt$")) throw new ConfigError("GATEWAY_PASSPHRASE_HASH must come from `npm run gateway:hash`");
  const ops = Number(env.RISK_MAX_ORDERS_PER_SEC ?? DEFAULT_RISK.maxOrdersPerSecond);
  if (!(ops >= 1 && ops <= OPS_HARD_LIMIT)) throw new ConfigError(`RISK_MAX_ORDERS_PER_SEC must be 1…${OPS_HARD_LIMIT} (SEBI retail threshold is 10/s)`);
  const segs = (env.ALLOWED_SEGMENTS ?? "NSE_FO,BSE_FO,NSE_EQ,BSE_EQ,MCX_FO,NCD_FO").split(",").map((s) => s.trim()).filter(Boolean) as Segment[];
  for (const s of segs) if (!SEGMENTS.includes(s)) throw new ConfigError(`ALLOWED_SEGMENTS: unknown segment ${s}`);
  const liveTrading = env.LIVE_TRADING_ENABLED === "1";
  const fakeNow = env.GATEWAY_FAKE_NOW ? Number(env.GATEWAY_FAKE_NOW) : null;
  // a fake clock is only ever allowed in tests against a local mock broker
  const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
  if (fakeNow !== null && (env.NODE_ENV !== "test" || !local.test(env.UPSTOX_BASE_URL ?? "") || !local.test(env.UPSTOX_HFT_URL ?? "")))
    throw new ConfigError("GATEWAY_FAKE_NOW is for tests only (NODE_ENV=test and UPSTOX_BASE_URL/UPSTOX_HFT_URL on localhost)");
  const cors = (env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
  if (!cors.length) throw new ConfigError("CORS_ORIGINS is required (e.g. https://<you>.github.io)");
  return {
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 8080),
    dataDir: env.DATA_DIR === "" ? null : (env.DATA_DIR ?? "./gateway/data"),
    broker,
    upstox: {
      apiKey: need("UPSTOX_API_KEY"),
      apiSecret: need("UPSTOX_API_SECRET"),
      redirectUri: need("UPSTOX_REDIRECT_URI"),
      sandboxToken: env.UPSTOX_SANDBOX_TOKEN?.trim() || null,
      baseUrl: env.UPSTOX_BASE_URL || undefined,
      hftUrl: env.UPSTOX_HFT_URL || undefined,
      assetsUrl: env.UPSTOX_ASSETS_URL || undefined,
      loginUrl: env.UPSTOX_LOGIN_URL || undefined,
      sandboxUrl: env.UPSTOX_SANDBOX_URL || undefined,
      algoName: env.UPSTOX_ALGO_NAME?.trim() || null,
    },
    passphraseHash,
    jwtSecret,
    jwtTtlMs: Number(env.GATEWAY_SESSION_HOURS ?? 12) * 3600_000,
    corsOrigins: cors,
    frontendUrl: env.FRONTEND_URL?.trim() || null,
    trustProxy: env.TRUST_PROXY === "1",
    liveTrading,
    risk: { ...DEFAULT_RISK, maxOrdersPerSecond: ops, allowedSegments: segs },
    fakeNow,
  };
}
