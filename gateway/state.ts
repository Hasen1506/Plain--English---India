// Small persistent state for the gateway: risk settings, kill switch, the paper
// book, and the broker session (access token encrypted at rest with a key derived
// from GATEWAY_JWT_SECRET). Memory-only when dataDir is null (tests).

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { emptyPaper, type PaperState } from "../src/core/paper.ts";
import type { BrokerSession } from "./brokers/types.ts";

export interface PersistedState {
  perTradeCap: number | null;
  dailyLossCap: number | null;
  killSwitch: boolean;
  paper: PaperState;
}

export const defaultState = (): PersistedState => ({ perTradeCap: null, dailyLossCap: null, killSwitch: false, paper: emptyPaper() });

function writeAtomic(path: string, body: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, path);
}

export class StateStore {
  private readonly dir: string | null;
  private readonly key: Buffer;
  state: PersistedState;

  constructor(dir: string | null, jwtSecret: string) {
    this.dir = dir;
    this.key = Buffer.from(hkdfSync("sha256", jwtSecret, "plain-english-india", "broker-token-v1", 32));
    if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.state = this.read();
  }

  private read(): PersistedState {
    if (!this.dir) return defaultState();
    const p = join(this.dir, "state.json");
    if (!existsSync(p)) return defaultState();
    try {
      return { ...defaultState(), ...(JSON.parse(readFileSync(p, "utf8")) as Partial<PersistedState>) };
    } catch {
      return defaultState();
    }
  }

  save(): void {
    if (this.dir) writeAtomic(join(this.dir, "state.json"), JSON.stringify(this.state));
  }

  saveBroker(token: string | null, session: BrokerSession | null): void {
    if (!this.dir) return;
    const p = join(this.dir, "broker-session.json");
    if (!token || !session) {
      writeAtomic(p, "{}");
      return;
    }
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([c.update(token, "utf8"), c.final()]);
    writeAtomic(p, JSON.stringify({ session, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), token: enc.toString("base64") }));
  }

  loadBroker(now: number): { token: string; session: BrokerSession } | null {
    if (!this.dir) return null;
    const p = join(this.dir, "broker-session.json");
    if (!existsSync(p)) return null;
    try {
      const j = JSON.parse(readFileSync(p, "utf8")) as { session?: BrokerSession; iv?: string; tag?: string; token?: string };
      if (!j.session || !j.iv || !j.tag || !j.token || j.session.expiresAt <= now) return null;
      const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(j.iv, "base64"));
      d.setAuthTag(Buffer.from(j.tag, "base64"));
      const token = Buffer.concat([d.update(Buffer.from(j.token, "base64")), d.final()]).toString("utf8");
      return { token, session: j.session };
    } catch {
      return null;
    }
  }
}
