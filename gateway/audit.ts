// Append-only audit log (JSON lines) with a SHA-256 hash chain: each entry carries
// the hash of the previous one, so any edit or deletion is detectable with verify().
// Secrets (tokens, passphrases, api secret) are never written.

import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

export interface AuditEntry {
  seq: number;
  ts: number;
  type: string;
  data: unknown;
  prev: string;
  hash: string;
}

const SECRET_KEYS = /token|secret|passphrase|password|^pin$|totp|authorization/i; // never pass an OAuth code to the log

export function redact(v: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(x, depth + 1);
    return o;
  }
  return v;
}

const digest = (e: Omit<AuditEntry, "hash">): string => createHash("sha256").update(JSON.stringify([e.seq, e.ts, e.type, e.data, e.prev])).digest("hex");

export class AuditLog {
  private last = "GENESIS";
  private seq = 0;
  private readonly memory: AuditEntry[] = [];
  private readonly path: string | null;

  constructor(path: string | null) {
    this.path = path;
    if (path) {
      mkdirSync(dirname(path), { recursive: true });
      if (existsSync(path)) {
        const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
        for (const l of lines.slice(-2000)) this.memory.push(JSON.parse(l) as AuditEntry);
        const tail = this.memory[this.memory.length - 1];
        if (tail) [this.last, this.seq] = [tail.hash, tail.seq];
      }
    }
  }

  append(type: string, data: unknown, ts: number): AuditEntry {
    const base = { seq: this.seq + 1, ts, type, data: redact(data), prev: this.last };
    const e: AuditEntry = { ...base, hash: digest(base) };
    if (this.path) appendFileSync(this.path, JSON.stringify(e) + "\n", { mode: 0o600 });
    this.memory.push(e);
    if (this.memory.length > 5000) this.memory.splice(0, this.memory.length - 5000);
    this.last = e.hash;
    this.seq = e.seq;
    return e;
  }

  recent(limit = 100): AuditEntry[] {
    return this.memory.slice(-limit).reverse();
  }

  /** Verify a full log file: every hash matches and links to its predecessor. */
  static verify(lines: string[]): { ok: boolean; badAt: number | null } {
    let prev = "GENESIS";
    for (let i = 0; i < lines.length; i++) {
      const e = JSON.parse(lines[i]!) as AuditEntry;
      const { hash, ...rest } = e;
      if (e.prev !== prev || digest(rest) !== hash) return { ok: false, badAt: i };
      prev = hash;
    }
    return { ok: true, badAt: null };
  }
}
