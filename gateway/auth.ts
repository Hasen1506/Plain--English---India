// Single-user auth for the gateway: a passphrase (stored only as an scrypt hash
// in the environment) exchanged for a short-lived HS256 JWT. No user database.
// Also: signed OAuth `state` values for the broker redirect.

import { scryptSync, randomBytes, timingSafeEqual, createHmac } from "node:crypto";

/** "scrypt$N$r$p$saltB64$hashB64" — produce with `npm run gateway:hash`. */
export function hashPassphrase(pass: string, salt = randomBytes(16), N = 16384, r = 8, p = 1): string {
  const h = scryptSync(pass.normalize("NFKC"), salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${h.toString("base64")}`;
}

export function verifyPassphrase(pass: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const want = Buffer.from(hash, "base64");
  let got: Buffer;
  try {
    got = scryptSync(String(pass).normalize("NFKC"), Buffer.from(salt, "base64"), want.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  } catch {
    return false;
  }
  return got.length === want.length && timingSafeEqual(got, want);
}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

export function signJwt(payload: Record<string, unknown>, secret: string): string {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

export function verifyJwt(token: string, secret: string, now: number): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  let h: { alg?: string };
  try {
    h = JSON.parse(Buffer.from(head, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (h.alg !== "HS256") return null; // no "none", no algorithm confusion
  const want = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof p.exp !== "number" || p.exp * 1000 <= now) return null;
  return p;
}

/** OAuth state: nonce.expiry.hmac — verifiable on the callback without server-side storage. */
export function makeState(secret: string, now: number, ttlMs = 10 * 60_000): string {
  const nonce = randomBytes(12).toString("base64url");
  const exp = String(now + ttlMs);
  const mac = createHmac("sha256", secret).update(`state.${nonce}.${exp}`).digest("base64url");
  return `${nonce}.${exp}.${mac}`;
}

export function checkState(state: string, secret: string, now: number): boolean {
  const [nonce, exp, mac] = String(state).split(".");
  if (!nonce || !exp || !mac) return false;
  const want = createHmac("sha256", secret).update(`state.${nonce}.${exp}`).digest();
  const got = Buffer.from(mac, "base64url");
  return got.length === want.length && timingSafeEqual(got, want) && Number(exp) > now;
}

/** Failed-login throttle: at most `max` failures per `windowMs` per client. */
export class LoginThrottle {
  private readonly fails = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  constructor(max = 5, windowMs = 15 * 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }
  blocked(ip: string, now: number): boolean {
    const f = (this.fails.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    this.fails.set(ip, f);
    return f.length >= this.max;
  }
  fail(ip: string, now: number): void {
    this.fails.set(ip, [...(this.fails.get(ip) ?? []), now]);
  }
  reset(ip: string): void {
    this.fails.delete(ip);
  }
}
