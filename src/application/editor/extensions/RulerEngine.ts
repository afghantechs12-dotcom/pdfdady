import type { IRulerEngine, RulerTick } from "./Extensions";

/**
 * Smart rulers — Part 4 of the editor foundation.
 *
 * {@link SmartRulerEngine} picks a "nice" tick interval (a power of ten scaled by
 * 1, 2, or 5) for a viewport span and emits a two-tier sequence of major (labeled)
 * and minor (unlabeled) ticks across it. A `pixelsPerUnit` zoom factor lets the
 * interval coarsen when zoomed out and refine when zoomed in. Pure logic: no DOM,
 * no state — the ruler UI consumes the ticks directly.
 */

/** A tiny tolerance so a tick landing exactly on `end` is included. */
const END_EPS = 1e-9;

/**
 * Chooses a "nice" tick interval — a power of ten multiplied by 1, 2, or 5 — that
 * yields roughly `targetTicks` steps across `span`. Degenerate spans (non-finite
 * or non-positive) or target counts fall back to 1 so callers never receive NaN
 * or Infinity. Exposed for direct testing and for callers that want the interval
 * without generating ticks.
 */
export function niceTickInterval(span: number, targetTicks = 10): number {
  if (!Number.isFinite(span) || span <= 0 || targetTicks <= 0) return 1;
  const raw = span / targetTicks;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalized = raw / magnitude; // in [1, 10)
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

/** Decimal places needed to label positions at `interval` spacing without FP noise. */
function decimalsFor(interval: number): number {
  return interval < 1 ? Math.max(0, -Math.floor(Math.log10(interval))) : 0;
}

/** Formats a tick position as a rounded, trailing-zero-trimmed label. */
function formatLabel(pos: number, decimals: number): string {
  const fixed = pos.toFixed(decimals);
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

/**
 * Generates ruler ticks across the page-space range [`start`, `end`]. The
 * interval is chosen from the span (adapted by `pixelsPerUnit` when supplied) and
 * every fifth tick is labeled (major); the rest are minor with empty labels.
 * `orientation` is accepted to satisfy the port contract but does not change the
 * numerics — a vertical and horizontal ruler over the same range share ticks.
 */
export class SmartRulerEngine implements IRulerEngine {
  constructor(private readonly options?: { pixelsPerUnit?: number }) {}

  ticksFor(start: number, end: number, _orientation: "vertical" | "horizontal"): RulerTick[] {
    const span = end - start;
    if (!Number.isFinite(span) || span <= 0) return [];

    const pixelsPerUnit = this.options?.pixelsPerUnit ?? 1;
    // Effective span for density: dividing by the zoom factor coarsens the
    // interval when zoomed out (fewer pixels per unit) and refines it when
    // zoomed in, so labels stay legible at every zoom level.
    const interval = niceTickInterval(span / pixelsPerUnit);
    const decimals = decimalsFor(interval);

    const firstIndex = Math.ceil(start / interval - END_EPS);
    const lastIndex = Math.floor(end / interval + END_EPS);
    const ticks: RulerTick[] = [];
    for (let idx = firstIndex; idx <= lastIndex; idx++) {
      const pos = idx * interval;
      const major = idx % 5 === 0;
      ticks.push({ position: pos, label: major ? formatLabel(pos, decimals) : "", major });
    }
    return ticks;
  }
}
