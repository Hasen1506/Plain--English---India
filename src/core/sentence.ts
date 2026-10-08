// Plain English in, structured view out (and back again).
//
//   "I think Nifty stays above 25,000 till Tuesday's expiry, risking ₹5,000"
//   → { underlying: NIFTY, dir: above, mode: stays, level: 25000, expiry: <Tue>, risk: 5000 }
//
// The parser is deliberately small and deterministic: regexes over a normalised
// string. Anything it cannot read is reported in `missing`, never guessed.

import { INDICES, COMMODITIES, CURRENCIES, displayName } from "./instruments.ts";
import type { Direction, Mode, View } from "./strategy.ts";
import type { ExpiryInfo } from "./instruments.ts";
import { addDays, istDate, shortDate, weekday, longWeekday } from "./ist.ts";
import { inr, num, parseRupees } from "./money.ts";

export interface ParsedView {
  underlying: string | null;
  dir: Direction | null;
  mode: Mode | null;
  level: number | null;
  expiryDate: string | null;
  risk: number | null;
  missing: ("underlying" | "direction" | "level" | "expiry" | "risk")[];
  notes: string[];
}

interface VerbRule {
  re: RegExp;
  dir: Direction;
  mode: Mode;
}

// Order matters: negations before the plain verbs they contain.
const VERBS: VerbRule[] = [
  { re: /\b(?:won'?t|will not|does ?n'?t|doesn'?t|not|never|wont)\s+(?:fall|drop|go|close|end|slip|break)\s+(?:below|under|beneath)\b/, dir: "above", mode: "stays" },
  { re: /\b(?:won'?t|will not|does ?n'?t|doesn'?t|not|never|wont)\s+(?:rise|go|close|end|cross|break)\s+(?:above|over|past|beyond)\b/, dir: "below", mode: "stays" },
  { re: /\b(?:won'?t|will not|doesn'?t|not|never|wont)\s+(?:cross|reach|hit)\b/, dir: "below", mode: "stays" },
  { re: /\b(?:stays?|staying|remains?|remaining|holds?|holding|closes?|closing|ends?|ending|settles?|settling|expires?|stay|to stay|to remain|to hold|to close|to end|to settle)\s+(?:at or\s+)?(?:above|over)\b/, dir: "above", mode: "stays" },
  { re: /\b(?:stays?|staying|remains?|remaining|holds?|holding|closes?|closing|ends?|ending|settles?|settling|expires?|to stay|to remain|to hold|to close|to end|to settle)\s+(?:at or\s+)?(?:below|under|beneath)\b/, dir: "below", mode: "stays" },
  { re: /\b(?:goes|go|going|rises?|rising|climbs?|climbing|rall(?:y|ies)|moves?|moving|gets?|getting|jumps?|shoots?|runs?)\s+(?:up\s+)?(?:to|above|over|past|beyond|till|until)\b/, dir: "above", mode: "reaches" },
  { re: /\b(?:hits?|hitting|reach(?:es)?|reaching|cross(?:es)?|crossing|breaks? (?:out )?above|tops?|touch(?:es)?)\b/, dir: "above", mode: "reaches" },
  { re: /\b(?:falls?|falling|drops?|dropping|declines?|slips?|slipping|sinks?|crash(?:es)?|tanks?|goes down|go down|going down|comes? down|dips?)\s+(?:to|below|under|till|until|beneath)\b/, dir: "below", mode: "reaches" },
  { re: /\b(?:breaks?|goes|go|going|moves?|trades?)\s+(?:below|under|beneath)\b/, dir: "below", mode: "reaches" },
  { re: /\b(?:above|over)\b/, dir: "above", mode: "stays" },
  { re: /\b(?:below|under)\b/, dir: "below", mode: "stays" },
];

const RISK_RE = /\b(?:risk(?:ing)?|max(?:imum)?\s+loss(?:\s+of)?|lose\s+(?:at most|up to|max(?:imum)?)?|losing\s+(?:at most|up to)?|with|budget(?:\s+of)?|spend(?:ing)?|using|put(?:ting)?\s+in|invest(?:ing)?)\s*(?:of\s+)?(?:up to\s+|at most\s+)?((?:₹|rs\.?\s*|inr\s*)?\d[\d,]*(?:\.\d+)?\s*(?:k|thousand|lakhs?|lac|l|crores?|cr)?)\b/;
const NUM_RE = /(?:₹|rs\.?\s*)?(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(k|thousand)?\b/g;

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const WEEKDAYS: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, tue: 2, tues: 2, thu: 4, thur: 4, thurs: 4, mon: 1, wed: 3, fri: 5 };

function normalise(s: string): string {
  return s.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
}

/** Find the underlying: index aliases, then any known option underlying (stocks) by symbol. */
export function findUnderlying(t: string, known: string[]): { id: string; at: number; len: number } | null {
  const cands: { id: string; alias: string }[] = [];
  for (const d of INDICES) if (known.includes(d.id)) for (const a of [...d.aliases, d.id.toLowerCase()]) cands.push({ id: d.id, alias: a });
  for (const d of [...COMMODITIES, ...CURRENCIES]) if (known.includes(d.id)) for (const a of [...d.aliases, d.id.toLowerCase()]) cands.push({ id: d.id, alias: a });
  for (const k of known) if (!INDICES.some((d) => d.id === k)) cands.push({ id: k, alias: k.toLowerCase() });
  cands.sort((a, b) => b.alias.length - a.alias.length);
  for (const c of cands) {
    const re = new RegExp(`(?:^|[^a-z0-9])(${c.alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![a-z0-9])`);
    const m = re.exec(t);
    if (m) return { id: c.id, at: m.index + m[0].length - m[1]!.length, len: m[1]!.length };
  }
  return null;
}

function parseNumberToken(raw: string, k?: string): number {
  const n = Number(raw.replace(/,/g, ""));
  return k ? n * 1000 : n;
}

/** Resolve an expiry phrase against the listed expiries. */
export function resolveExpiry(t: string, expiries: ExpiryInfo[], now: number): { date: string | null; note: string | null } {
  if (!expiries.length) return { date: null, note: null };
  const today = istDate(now);
  const live = expiries.filter((e) => e.date >= today);
  if (!live.length) return { date: null, note: null };

  // explicit ISO or d/m dates
  let m = /\b(20\d\d)-(\d\d)-(\d\d)\b/.exec(t);
  let target: string | null = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  if (!target) {
    m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?(?:\s+(20\d\d))?\b/.exec(t);
    const m2 = m ? null : /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d\d))?\b/.exec(t);
    const m3 = m || m2 ? null : /\b(\d{1,2})\/(\d{1,2})(?:\/(20\d\d))?\b/.exec(t);
    const y0 = Number(today.slice(0, 4));
    let d: number | null = null, mo: number | null = null, y: number | null = null;
    if (m) [d, mo, y] = [Number(m[1]), MONTHS[m[2]!]!, m[3] ? Number(m[3]) : null];
    else if (m2) [d, mo, y] = [Number(m2[2]), MONTHS[m2[1]!]!, m2[3] ? Number(m2[3]) : null];
    else if (m3) [d, mo, y] = [Number(m3[1]), Number(m3[2]), m3[3] ? Number(m3[3]) : null];
    if (d && mo && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      let yy = y ?? y0;
      let cand = `${yy}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      if (!y && cand < today) cand = `${++yy}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      target = cand;
    }
  }
  if (target) {
    const exact = live.find((e) => e.date === target);
    if (exact) return { date: exact.date, note: null };
    const before = live.filter((e) => e.date <= target!);
    const pick = before.length ? before[before.length - 1]! : live[0]!;
    return { date: pick.date, note: `No contract expires on ${shortDate(target)}; using the ${shortDate(pick.date)} expiry${before.length ? " (the last one before it)" : " (the nearest)"}.` };
  }

  const monthly = live.filter((e) => e.kind === "monthly");
  if (/\bnext month/.test(t)) {
    const thisMonth = today.slice(0, 7);
    const nm = monthly.find((e) => e.date.slice(0, 7) > thisMonth);
    if (nm) return { date: nm.date, note: null };
  }
  if (/\b(?:monthly|this month|month[- ]end|end of (?:the )?month|month'?s expiry)\b/.test(t)) {
    if (monthly[0]) return { date: monthly[0].date, note: null };
  }
  const weekOf = (date: string): string => addDays(date, -((weekday(date) + 6) % 7)); // Monday of that week
  if (/\bnext week/.test(t)) {
    const nextMon = addDays(weekOf(today), 7);
    const e = live.find((x) => weekOf(x.date) === nextMon);
    if (e) return { date: e.date, note: null };
    return { date: live.find((x) => x.date >= nextMon)?.date ?? live[0]!.date, note: "No expiry next week; using the next one after it." };
  }
  if (/\b(?:this week|weekly|week'?s expiry)\b/.test(t)) {
    const e = live.find((x) => weekOf(x.date) === weekOf(today));
    if (e) return { date: e.date, note: null };
  }
  for (const [name, wd] of Object.entries(WEEKDAYS)) {
    const wm = new RegExp(`\\b(next\\s+)?${name}(?:'s)?\\b`).exec(t);
    if (wm) {
      // "Thursday" = the first Thursday expiry from today; "next Thursday" = the first one after today
      const e = live.find((x) => weekday(x.date) === wd && (wm[1] ? x.date > today : true));
      if (e) return { date: e.date, note: null };
      return { date: live[0]!.date, note: `No ${longWeekday(wd)} expiry is listed; using the nearest (${shortDate(live[0]!.date)}).` };
    }
  }
  if (/\b(?:expiry|expires|today|tomorrow)\b/.test(t)) {
    if (/\btomorrow\b/.test(t)) {
      const e = live.find((x) => x.date === addDays(today, 1));
      if (e) return { date: e.date, note: null };
    }
    if (/\btoday\b/.test(t)) {
      const e = live.find((x) => x.date === today);
      if (e) return { date: e.date, note: null };
    }
    return { date: live[0]!.date, note: null };
  }
  return { date: null, note: null };
}

export interface ParseContext {
  known: string[]; // option underlyings available (from the instrument master)
  expiriesFor: (underlying: string) => ExpiryInfo[];
  now: number;
}

export function parseView(input: string, ctx: ParseContext): ParsedView {
  const t = normalise(input);
  const notes: string[] = [];
  const u = findUnderlying(t, ctx.known);
  // risk first, then blank it out so its amount is not taken as the level
  let rest = t;
  let risk: number | null = null;
  const rm = RISK_RE.exec(t);
  if (rm) {
    risk = parseRupees(rm[1]!);
    rest = t.slice(0, rm.index) + " ".repeat(rm[0].length) + t.slice(rm.index + rm[0].length);
  }
  // also strip explicit dates so "13 oct" is not read as a level
  rest = rest.replace(/\b(20\d\d)-(\d\d)-(\d\d)\b/g, " ").replace(/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?(?:\s+20\d\d)?\b/g, " ").replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+20\d\d)?\b/g, " ").replace(/\b\d{1,2}\/\d{1,2}(?:\/20\d\d)?\b/g, " ");
  if (u) rest = rest.slice(0, u.at) + " ".repeat(u.len) + rest.slice(u.at + u.len);

  let dir: Direction | null = null, mode: Mode | null = null, verbEnd = -1;
  for (const v of VERBS) {
    const m = v.re.exec(rest);
    if (m) {
      dir = v.dir;
      mode = v.mode;
      verbEnd = m.index + m[0].length;
      break;
    }
  }
  let level: number | null = null;
  NUM_RE.lastIndex = 0;
  const nums: { v: number; at: number }[] = [];
  for (let m = NUM_RE.exec(rest); m; m = NUM_RE.exec(rest)) nums.push({ v: parseNumberToken(m[1]!, m[2]), at: m.index });
  const after = nums.find((n) => n.at >= verbEnd && n.v >= 10);
  level = (after ?? nums.find((n) => n.v >= 10))?.v ?? null;

  const expiries = u ? ctx.expiriesFor(u.id) : [];
  const ex = resolveExpiry(t, expiries, ctx.now);
  if (ex.note) notes.push(ex.note);
  if (mode === "reaches") notes.push("Options pay on where the index settles on expiry day, not on whether it touches the level before.");
  const missing: ParsedView["missing"] = [];
  if (!u) missing.push("underlying");
  if (!dir) missing.push("direction");
  if (level === null) missing.push("level");
  if (!ex.date) missing.push("expiry");
  if (risk === null) missing.push("risk");
  return { underlying: u?.id ?? null, dir, mode, level, expiryDate: ex.date, risk, missing, notes };
}

export function isComplete(p: ParsedView): p is ParsedView & { underlying: string; dir: Direction; mode: Mode; level: number; expiryDate: string; risk: number } {
  return p.missing.length === 0;
}

export function toView(p: ParsedView): View | null {
  return isComplete(p) ? { underlying: p.underlying, dir: p.dir, mode: p.mode, level: p.level, expiryDate: p.expiryDate, risk: p.risk } : null;
}

const VERB_TEXT: Record<`${Direction}-${Mode}`, string> = {
  "above-stays": "stays above",
  "above-reaches": "goes above",
  "below-stays": "stays below",
  "below-reaches": "falls below",
};

/** The canonical sentence for a view (what the pills show). parseView(sentence(v)) === v. */
export function sentence(v: View): string {
  const lvl = num(v.level, Number.isInteger(v.level) ? 0 : 2);
  return `I think ${displayName(v.underlying)} ${VERB_TEXT[`${v.dir}-${v.mode}`]} ${lvl} by the ${shortDate(v.expiryDate)} expiry, risking ${inr(v.risk, Number.isInteger(v.risk) ? 0 : 2)}`;
}
