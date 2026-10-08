// Rupee formatting (Indian digit grouping: 1,23,45,678) and paise-exact rounding.

/** Round half away from zero to 2 decimals without binary drift (12.345 → 12.35). */
export function round2(x: number): number {
  if (!Number.isFinite(x)) return x;
  const s = Math.sign(x) || 1;
  return (s * Math.round(Math.abs(x) * 100 + 1e-7)) / 100;
}

export const toPaise = (rupees: number): number => Math.round(rupees * 100);
export const fromPaise = (paise: number): number => paise / 100;

function group(intPart: string): string {
  // Indian grouping: last three digits, then pairs
  if (intPart.length <= 3) return intPart;
  const last3 = intPart.slice(-3);
  const rest = intPart.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return rest + "," + last3;
}

/** ₹1,23,456.50 — `dp` decimals (default: 2 below ₹100, whole rupees from ₹100 up). */
export function inr(v: number, dp?: number): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const d = dp ?? (a >= 100 ? 0 : 2);
  const fixed = round2(a).toFixed(d);
  const [i, f] = fixed.split(".") as [string, string | undefined];
  return (v < 0 ? "−₹" : "₹") + group(i) + (f ? "." + f : "");
}

/** Always two decimals: ₹73.25 */
export const inr2 = (v: number): string => inr(v, 2);

export const signedInr = (v: number, dp?: number): string => (v > 0 ? "+" : v < 0 ? "−" : "") + inr(Math.abs(v), dp);

/** Plain number with Indian grouping: 22,454.65 */
export function num(v: number, dp = 2): string {
  if (!Number.isFinite(v)) return "—";
  const fixed = Math.abs(v).toFixed(dp);
  const [i, f] = fixed.split(".") as [string, string | undefined];
  return (v < 0 ? "−" : "") + group(i) + (f ? "." + f : "");
}

export const pct = (p: number, dp = 0): string => (Number.isFinite(p) ? (p * 100).toFixed(dp) + "%" : "—");

/** Parse "₹5,000", "5k", "1.5 lakh", "2 cr", "5000" → rupees. null when not a number. */
export function parseRupees(s: string): number | null {
  const t = s.trim().toLowerCase().replace(/₹|\brs\.?|\binr\b|,|\s/g, "");
  const m = /^(\d+(?:\.\d+)?)(k|thousand|l|lac|lakh|lakhs|cr|crore|crores)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  const mult = !m[2] ? 1 : m[2] === "k" || m[2] === "thousand" ? 1e3 : m[2].startsWith("l") ? 1e5 : 1e7;
  const v = n * mult;
  return Number.isFinite(v) ? v : null;
}

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
