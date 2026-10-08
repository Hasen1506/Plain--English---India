// Closing chosen positions (the Portfolio's "Close" on one spread). Pure: the gateway and the demo
// run the same plan, then close each leg with reduce-only protective limits (execution.ts).
//
// Defined risk stays defined: a close may never leave a sold option less covered than it was,
// so closing only the bought leg of a spread is refused, and shorts are bought back first.

import type { Instrument } from "./instruments.ts";

export type ClosePlan = { ok: true; legs: { inst: Instrument; netQty: number }[] } | { ok: false; code: "keys" | "unknown-instrument" | "equity" | "flat" | "naked"; message: string };

const MAX_KEYS = 10;
const isOption = (i: Instrument | undefined): i is Instrument => i?.type === "CE" || i?.type === "PE";
const groupOf = (i: Instrument): string => `${i.underlying}|${i.expiryDate}|${i.type}`;

/** Sold quantity not covered by a bought option of the same underlying, expiry and type, per group. */
function uncovered(net: Record<string, number>, get: (k: string) => Instrument | undefined): Map<string, number> {
  const g = new Map<string, { long: number; short: number }>();
  for (const [k, q] of Object.entries(net)) {
    const i = get(k);
    if (!q || !isOption(i)) continue;
    const x = g.get(groupOf(i)) ?? { long: 0, short: 0 };
    if (q > 0) x.long += q;
    else x.short -= q;
    g.set(groupOf(i), x);
  }
  return new Map([...g].map(([k, x]) => [k, Math.max(0, x.short - x.long)]));
}

export function planClose(keys: unknown, netQtyByKey: Record<string, number>, get: (k: string) => Instrument | undefined): ClosePlan {
  if (!Array.isArray(keys) || !keys.length || keys.length > MAX_KEYS || keys.some((k) => typeof k !== "string")) return { ok: false, code: "keys", message: `Choose 1–${MAX_KEYS} positions to close` };
  const uniq = [...new Set(keys as string[])];
  const legs: { inst: Instrument; netQty: number }[] = [];
  for (const k of uniq) {
    const inst = get(k);
    if (!inst) return { ok: false, code: "unknown-instrument", message: `Not in today's instrument master: ${k}` };
    if (inst.type === "EQ") return { ok: false, code: "equity", message: `Sell ${inst.symbol} shares from the Stocks screen` };
    const q = netQtyByKey[k] ?? 0;
    if (!q) return { ok: false, code: "flat", message: `No open position in ${inst.symbol}` };
    legs.push({ inst, netQty: q });
  }
  const before = uncovered(netQtyByKey, get);
  const after = uncovered({ ...netQtyByKey, ...Object.fromEntries(uniq.map((k) => [k, 0])) }, get);
  for (const [g, u] of after) {
    if (u > (before.get(g) ?? 0)) {
      const [und, exp, type] = g.split("|");
      return { ok: false, code: "naked", message: `That would leave a sold ${und} ${exp} ${type} without its hedge. Close the whole spread (or the sold leg first).` };
    }
  }
  // buy back sold options first: they carry the open-ended risk
  return { ok: true, legs: [...legs.filter((l) => l.netQty < 0), ...legs.filter((l) => l.netQty > 0)] };
}
