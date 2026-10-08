// The sister app's visual vocabulary, ported from Plain-English-Options so both apps look
// and move the same: its icon set (trend arrows, chevron, outcome-row icons, dock icons),
// the sparkline (src/lib/spark.ts), the payoff bar chart and axis (src/ui/views.ts), the
// countdown ring, and popover placement. India-only additions are marked.

export { reducedMotion, popIn, popOut, setText, fillRange } from "./motion.ts";

const svg = (d: string, w = "2"): string => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

// sister app: src/ui/app.ts CHEV / UP / DN, src/ui/views.ts UP_IC / DN_IC / MID_IC, index.html dock icons
const UP_D = '<path d="M3 17l6-6 4 4 8-8M15 7h6v6"/>';
const DN_D = '<path d="M3 7l6 6 4-4 8 8M15 17h6v-6"/>';
export const ICON = {
  chev: svg('<path d="M6 9l6 6 6-6"/>', "3"),
  up: svg(UP_D, "2.4"), // trend up (pill, outcome rows)
  down: svg(DN_D, "2.4"),
  mid: svg('<path d="M4 12h15M14 7l5 5-5 5"/>', "2.4"),
  // dock (stroke 2, as in the sister app's index.html)
  build: svg(UP_D),
  swap: svg('<path d="M7 4v16M17 4v16M3 8l4-4 4 4M13 16l4 4 4-4"/>'),
  bars: svg('<path d="M4 20h16M6 20V12h4v8M10 20V6h4v14M14 20v-9h4v9"/>'),
  history: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>'),
  shield: svg('<path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/>'), // India: Safety tab, same stroke
  search: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  play: svg('<path d="M8 5l11 7-11 7V5z"/>'),
  // the sister app's empty-state wallet icon stroke (1.8)
  wallet: svg('<path d="M20 7V5.5A1.5 1.5 0 0 0 18.5 4h-13A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V17"/><path d="M14 12h7v5h-7a2.5 2.5 0 0 1 0-5z"/>', "1.8"),
};

/** SVG path for a sparkline in a w×h box, or null when there is not enough data (sister app src/lib/spark.ts). */
export function sparkPath(values: number[], w = 64, h = 22, pad = 2): string | null {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2) return null;
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  const step = (w - pad * 2) / (v.length - 1);
  return v
    .map((x, i) => {
      const X = pad + i * step;
      const Y = hi === lo ? h / 2 : pad + (1 - (x - lo) / span) * (h - pad * 2);
      return `${i ? "L" : "M"}${X.toFixed(1)} ${Y.toFixed(1)}`;
    })
    .join("");
}

/** The whole sparkline as inline SVG, or "" when there is no real data (never a fake line). */
export function sparkSvg(values: number[] | null | undefined, w = 64, h = 22): string {
  const d = values ? sparkPath(values, w, h) : null;
  if (!d || !values) return "";
  const up = values[values.length - 1]! >= values[0]!;
  return `<svg class="x-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="${up ? "#22a45a" : "#d0453a"}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** "+1.2%" / "−0.7%" / "0.0%" (sister app changeText). */
export function changeText(ch: number): string {
  const r = (ch * 100).toFixed(1);
  const v = Number(r);
  return v > 0 ? "+" + r + "%" : v < 0 ? "−" + r.slice(1) + "%" : "0.0%";
}

/** Countdown ring inside Confirm (sister app src/ui/views.ts ringHtml). */
export function ringHtml(secs: number, total: number): string {
  const C = 2 * Math.PI * 11;
  const off = C * (1 - Math.max(0, Math.min(total, secs)) / total);
  return `<span class="x-ring" aria-label="Prices refresh in ${secs} seconds"><svg viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="11" class="x-ring__bg"/><circle cx="13" cy="13" r="11" class="x-ring__fg" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"/></svg><b>${secs}</b></span>`;
}

/** Payoff bars (sister app chartSvg): `pts` are price/profit pairs across the range. */
export function chartSvg(pts: { x: number; pl: number }[], label: (p: { x: number; pl: number }) => string): string {
  const maxUp = Math.max(1e-9, ...pts.map((p) => p.pl));
  const maxDn = Math.max(1e-9, ...pts.map((p) => -p.pl));
  const H = 160, mid = H * (maxUp / (maxUp + maxDn)), bw = 600 / pts.length;
  const bars = pts
    .map((p, i) => {
      const hgt = Math.max(3, p.pl >= 0 ? (p.pl / maxUp) * (mid - 6) : (-p.pl / maxDn) * (H - mid - 6));
      const y = p.pl >= 0 ? mid - hgt : mid;
      return `<rect data-i="${i}" style="--i:${i}" x="${(i * bw + 4).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 8).toFixed(1)}" height="${hgt.toFixed(1)}" rx="7" class="${p.pl >= 0 ? "is-up" : "is-dn"}" tabindex="0" aria-label="${label(p)}"></rect>`;
    })
    .join("");
  return `<svg viewBox="0 0 600 ${H}" role="img" aria-label="Profit or loss by price at expiry">${bars}<line x1="0" x2="600" y1="${mid.toFixed(1)}" y2="${mid.toFixed(1)}" stroke="#151515" stroke-width="2"/></svg>`;
}

/** Price labels under the chart, under the bars they describe: the range ends and both strikes (sister app axisHtml). */
export function axisHtml(from: number, to: number, lo: number, hi: number, n: number, fmt: (x: number) => string): string {
  const at = (x: number) => ((((x - from) / (to - from)) * (n - 1) + 0.5) / n) * 100;
  return (
    `<div class="x-axis" aria-hidden="true"><span style="left:0">${fmt(from)}</span>` +
    `<span class="is-mid" style="left:${at(lo).toFixed(1)}%">${fmt(lo)}</span><span class="is-mid" style="left:${at(hi).toFixed(1)}%">${fmt(hi)}</span>` +
    `<span style="right:0">${fmt(to)}</span></div>`
  );
}

/** Place a popover under its pill inside the builder (sister app openPop), then spring it in. */
export function placePopover(pop: HTMLElement, anchor: HTMLElement, container: HTMLElement): number {
  const br = container.getBoundingClientRect(), r = anchor.getBoundingClientRect(), w = pop.offsetWidth;
  const left = Math.max(0, Math.min(r.left - br.left, document.documentElement.clientWidth - 20 - br.left - w));
  pop.style.left = left + "px";
  pop.style.top = r.bottom - br.top + 8 + "px";
  return r.left - br.left - left + Math.min(r.width, w) / 2;
}

/** Close on Escape / outside pointer; returns a disposer. */
export function dismissable(pop: HTMLElement, anchor: HTMLElement, close: () => void): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      anchor.focus();
    }
  };
  const onDown = (e: PointerEvent) => {
    const t = e.target as Node;
    if (!pop.contains(t) && !anchor.contains(t)) close();
  };
  document.addEventListener("keydown", onKey);
  document.addEventListener("pointerdown", onDown, true);
  return () => {
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("pointerdown", onDown, true);
  };
}
