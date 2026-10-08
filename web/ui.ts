// Small DOM helpers for the redesigned UI: icons, popover placement, count-up numbers,
// pill width morphing and sparklines. No framework; everything respects
// prefers-reduced-motion.

export const reducedMotion = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const svg = (d: string, extra = ""): string => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;

export const ICON = {
  trend: svg('<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>'),
  bag: svg('<path d="M6 7h12l1 13H5L6 7z"/><path d="M9 7a3 3 0 0 1 6 0"/>'),
  pie: svg('<path d="M12 3v9h9"/><path d="M20.5 15A9 9 0 1 1 9 3.5"/>'),
  list: svg('<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r=".8"/><circle cx="3.5" cy="12" r=".8"/><circle cx="3.5" cy="18" r=".8"/>'),
  shield: svg('<path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/>'),
  chev: svg('<path d="M6 9l6 6 6-6"/>', 'stroke-width="3"'),
  arrow: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  up: svg('<path d="M7 17L17 7M9 7h8v8"/>'),
  down: svg('<path d="M7 7l10 10M17 9v8H9"/>'),
  flat: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  play: svg('<path d="M8 5l11 7-11 7V5z"/>'),
};

/** A tiny sparkline from real closes, or "" when there are fewer than two points (never a fake line). */
export function sparkline(closes: number[] | null | undefined, w = 64, h = 22): string {
  if (!closes || closes.length < 2) return "";
  const lo = Math.min(...closes), hi = Math.max(...closes);
  const span = hi - lo || 1;
  const pts = closes.map((c, i) => `${((i / (closes.length - 1)) * w).toFixed(1)},${(h - 2 - ((c - lo) / span) * (h - 4)).toFixed(1)}`).join(" ");
  const up = closes[closes.length - 1]! >= closes[0]!;
  return `<svg class="x-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${up ? "#22a45a" : "#d1453b"}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

const raf = (f: FrameRequestCallback): number => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(f) : window.setTimeout(() => f(performance.now()), 16));

/** Animate a number in `el` from its previous value to `to` (about 320 ms, ease-out). */
export function countTo(el: HTMLElement | null, to: number, fmt: (v: number) => string): void {
  if (!el) return;
  const from = Number(el.dataset.val);
  el.dataset.val = String(to);
  if (!Number.isFinite(from) || from === to || reducedMotion() || !Number.isFinite(to)) {
    el.textContent = fmt(to);
    return;
  }
  const t0 = performance.now(), dur = 320;
  const tick = (t: number) => {
    if (el.dataset.val !== String(to)) return; // superseded
    const k = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (k < 1) raf(tick);
  };
  raf(tick);
}

/** Replace a pill's content and animate its width from the old to the new size. */
export function morph(el: HTMLElement | null, html: string): void {
  if (!el) return;
  if (el.innerHTML === html) return;
  if (reducedMotion() || !el.isConnected) {
    el.innerHTML = html;
    return;
  }
  const w0 = el.getBoundingClientRect().width;
  el.style.width = "";
  el.innerHTML = html;
  const w1 = el.getBoundingClientRect().width;
  if (Math.abs(w1 - w0) < 1) return;
  el.style.width = `${w0}px`;
  void el.offsetWidth;
  el.classList.add("is-morph");
  el.style.width = `${w1}px`;
  const done = () => {
    el.style.width = "";
    el.classList.remove("is-morph");
    el.removeEventListener("transitionend", done);
  };
  el.addEventListener("transitionend", done);
  window.setTimeout(done, 400);
}

/** Place a popover under its anchor, inside the container; on phones CSS turns it into a bottom sheet. */
export function placePopover(pop: HTMLElement, anchor: HTMLElement, container: HTMLElement): void {
  const a = anchor.getBoundingClientRect(), c = container.getBoundingClientRect();
  const w = pop.offsetWidth || 320;
  let left = a.left - c.left;
  left = Math.max(0, Math.min(left, c.width - w));
  pop.style.left = `${left}px`;
  pop.style.top = `${a.bottom - c.top + 10}px`;
  pop.style.setProperty("--ox", `${Math.max(16, Math.min(w - 16, a.left - c.left - left + a.width / 2))}px`);
}

/** Close on Escape / outside click; returns a disposer. */
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

/** Countdown ring (SVG) for the quote freshness. `frac` 0..1 remaining. */
export function ring(frac: number, label: string): string {
  const r = 10, C = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, frac));
  return `<span class="x-ring" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="${r}" fill="none" stroke="currentColor" stroke-opacity=".3" stroke-width="2"/><circle cx="12" cy="12" r="${r}" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${(C * (1 - f)).toFixed(2)}" transform="rotate(-90 12 12)" stroke-linecap="round"/></svg><b>${label}</b></span>`;
}
