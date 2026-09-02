import { ANALYTICS_EVENTS, type AnalyticsEventName } from "./events";

/**
 * WHERE the product loses people. A pure roll-up, not an ad-hoc query.
 *
 * The phase brief asks where the funnel loses users. That question is usually
 * answered by a query someone writes once, screenshots, and never validates —
 * and a funnel query is easy to get subtly wrong (counting events instead of
 * subjects, letting a later step exceed an earlier one, dividing by zero on a
 * quiet day). Putting the arithmetic here makes it a tested function that the
 * admin surface and any future export both call.
 */

/** The ordered spine for a tool that submits work to the server. Order is the definition of "drop-off". */
export const FUNNEL_STEPS: readonly AnalyticsEventName[] = [
  ANALYTICS_EVENTS.tool_view,
  ANALYTICS_EVENTS.tool_start,
  ANALYTICS_EVENTS.file_selected,
  ANALYTICS_EVENTS.job_submitted,
  ANALYTICS_EVENTS.job_succeeded,
  ANALYTICS_EVENTS.download,
];

/**
 * The spine a **local** tool can actually produce, and the reason it is a second
 * list rather than a filter of the first.
 *
 * A tool that runs in the tab submits nothing, so `job_submitted` is never
 * emitted for it. Reporting a local tool against `FUNNEL_STEPS` therefore reads
 * a structural zero at step four, and because `rollupFunnel` clamps each step to
 * the one before it, every later step collapses to zero too: a working tool
 * renders as one that nobody completes. The absent step is a property of the
 * execution mode, not a drop-off, and the only honest fix is to not ask for it.
 *
 * The order is also different, and it is the order the client genuinely fires in:
 * `file_selected` comes from the file input, `tool_start` from the button that
 * acts on those files, so a selection always precedes a start. (Remote tools open
 * with a configure step before a file, which is why the two lists disagree.)
 * Order is the definition of drop-off, so it is pinned by tests rather than
 * inferred from either list's position in this file.
 *
 * `job_failed` is deliberately NOT a step. A failure is not progress toward a
 * download, and putting it in the spine would clamp `download` to the number of
 * failures. It is reported beside the funnel instead.
 */
export const LOCAL_FUNNEL_STEPS: readonly AnalyticsEventName[] = [
  ANALYTICS_EVENTS.tool_view,
  ANALYTICS_EVENTS.file_selected,
  ANALYTICS_EVENTS.tool_start,
  ANALYTICS_EVENTS.job_succeeded,
  ANALYTICS_EVENTS.download,
];

export interface FunnelStepCount {
  step: AnalyticsEventName;
  /**
   * How many reached this step.
   *
   * The unit is the caller's to define and to state. The admin read service
   * supplies *event occurrences* over a window, deduplicated at the source by
   * `trackOnce` rather than by a `COUNT(DISTINCT subjectHash)`, and says so where
   * it reports them — a funnel labelled "visitors" that is really counting rows
   * is the kind of number that quietly justifies a roadmap.
   */
  count: number;
}

export interface FunnelStepRollup {
  step: AnalyticsEventName;
  count: number;
  /** Share of the FIRST step that reached here, 0–1. */
  conversionFromStart: number;
  /** Share of the PREVIOUS step that reached here, 0–1. */
  conversionFromPrevious: number;
  /** Subjects lost between the previous step and this one. Never negative. */
  droppedFromPrevious: number;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

/**
 * Rolls raw per-step counts into conversion and drop-off.
 *
 * Counts are **monotonically clamped**: a step can never be reported as larger
 * than the step before it. Real data violates that regularly — a visitor whose
 * `tool_view` beacon was lost on a page unload still fires `job_submitted`, and
 * the naive roll-up then reports 140% conversion, which is the number that makes
 * an entire dashboard untrustworthy. Clamping reports the defensible floor and
 * keeps every ratio in 0–1.
 */
export function rollupFunnel(
  counts: readonly FunnelStepCount[],
  /**
   * The spine to report against. Explicit rather than inferred from `counts`,
   * because a step that produced no events must still appear — a funnel derived
   * from the rows that exist can never show the step where everyone stopped.
   */
  steps: readonly AnalyticsEventName[] = FUNNEL_STEPS,
): FunnelStepRollup[] {
  const byStep = new Map(counts.map((c) => [c.step, Math.max(0, c.count)]));

  const clamped: number[] = [];
  for (const [index, step] of steps.entries()) {
    const raw = byStep.get(step) ?? 0;
    clamped.push(index === 0 ? raw : Math.min(raw, clamped[index - 1] ?? 0));
  }

  const start = clamped[0] ?? 0;
  return steps.map((step, index) => {
    const count = clamped[index] ?? 0;
    const previous = index === 0 ? count : (clamped[index - 1] ?? 0);
    return {
      step,
      count,
      conversionFromStart: index === 0 ? (start > 0 ? 1 : 0) : ratio(count, start),
      conversionFromPrevious: index === 0 ? (count > 0 ? 1 : 0) : ratio(count, previous),
      droppedFromPrevious: index === 0 ? 0 : Math.max(0, previous - count),
    };
  });
}

/**
 * The step that loses the most people in absolute terms.
 *
 * Absolute, not proportional, and on purpose: a step converting at 40% out of
 * ten visitors is noise, while one converting at 90% out of ten thousand is
 * where the product actually leaks. Ties resolve to the earliest step, because
 * fixing an earlier leak is what refills every step after it.
 */
export function worstFunnelStep(rollup: readonly FunnelStepRollup[]): FunnelStepRollup | null {
  let worst: FunnelStepRollup | null = null;
  for (const step of rollup) {
    if (step.droppedFromPrevious <= 0) continue;
    if (!worst || step.droppedFromPrevious > worst.droppedFromPrevious) worst = step;
  }
  return worst;
}
