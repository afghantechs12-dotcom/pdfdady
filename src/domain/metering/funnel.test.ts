import { describe, expect, it } from "vitest";
import { ANALYTICS_EVENTS } from "./events";
import {
  FUNNEL_STEPS,
  LOCAL_FUNNEL_STEPS,
  rollupFunnel,
  worstFunnelStep,
  type FunnelStepCount,
} from "./funnel";

function counts(map: Partial<Record<string, number>>): FunnelStepCount[] {
  return FUNNEL_STEPS.map((step) => ({ step, count: map[step] ?? 0 }));
}

/**
 * A funnel roll-up is easy to get subtly wrong in ways that make a whole
 * dashboard untrustworthy — above-100% conversion, a later step outnumbering an
 * earlier one, a divide-by-zero on a quiet day. These tests pin each of those.
 */
describe("roll-up", () => {
  it("computes conversion from start and from the previous step", () => {
    const rollup = rollupFunnel(
      counts({
        tool_view: 1000,
        tool_start: 800,
        file_selected: 600,
        job_submitted: 500,
        job_succeeded: 450,
        download: 400,
      }),
    );
    expect(rollup[0].conversionFromStart).toBe(1);
    expect(rollup[1].conversionFromStart).toBeCloseTo(0.8);
    expect(rollup[1].conversionFromPrevious).toBeCloseTo(0.8);
    expect(rollup[2].conversionFromPrevious).toBeCloseTo(0.75);
    expect(rollup[1].droppedFromPrevious).toBe(200);
  });

  /**
   * Real data does this constantly: a lost `tool_view` beacon on page unload,
   * then a `job_submitted` that outnumbers it. The naive roll-up reports 140%;
   * clamping reports the defensible floor and keeps ratios in 0–1.
   */
  it("clamps a step that outnumbers the one before it", () => {
    const rollup = rollupFunnel(
      counts({ tool_view: 100, tool_start: 50, file_selected: 200 }),
    );
    const fileSelected = rollup.find((r) => r.step === "file_selected")!;
    expect(fileSelected.count).toBe(50); // clamped down to tool_start
    expect(fileSelected.conversionFromPrevious).toBeLessThanOrEqual(1);
    expect(fileSelected.conversionFromStart).toBeLessThanOrEqual(1);
  });

  it("never divides by zero on an empty dataset", () => {
    const rollup = rollupFunnel(counts({}));
    for (const step of rollup) {
      expect(Number.isFinite(step.conversionFromStart)).toBe(true);
      expect(Number.isFinite(step.conversionFromPrevious)).toBe(true);
      expect(step.count).toBe(0);
    }
  });

  it("treats a negative count as zero", () => {
    const rollup = rollupFunnel(counts({ tool_view: -5, tool_start: 3 }));
    expect(rollup[0].count).toBe(0);
    expect(rollup[1].count).toBe(0); // clamped to the zero above it
  });

  it("keeps every ratio within 0–1", () => {
    const rollup = rollupFunnel(
      counts({
        tool_view: 10,
        tool_start: 30,
        file_selected: 5,
        job_submitted: 40,
        job_succeeded: 2,
        download: 100,
      }),
    );
    for (const step of rollup) {
      expect(step.conversionFromStart).toBeGreaterThanOrEqual(0);
      expect(step.conversionFromStart).toBeLessThanOrEqual(1);
      expect(step.conversionFromPrevious).toBeGreaterThanOrEqual(0);
      expect(step.conversionFromPrevious).toBeLessThanOrEqual(1);
    }
  });
});

describe("worst step", () => {
  it("finds the step with the largest absolute drop", () => {
    const rollup = rollupFunnel(
      counts({
        tool_view: 1000,
        tool_start: 950,
        file_selected: 500, // biggest absolute loss: 450
        job_submitted: 480,
        job_succeeded: 470,
        download: 460,
      }),
    );
    expect(worstFunnelStep(rollup)?.step).toBe("file_selected");
  });

  /**
   * Absolute, not proportional: a 90%-converting step out of ten thousand leaks
   * more real users than a 40%-converting step out of ten.
   */
  it("prefers a big absolute loss over a worse-looking ratio on tiny numbers", () => {
    const rollup = rollupFunnel(
      counts({
        tool_view: 10_000,
        tool_start: 6_000, // loses 4000
        file_selected: 20, // ratio far worse, but only loses ~5980... still bigger
        job_submitted: 18,
        job_succeeded: 17,
        download: 16,
      }),
    );
    // file_selected loses 5980 vs tool_start's 4000 — the later absolute loss wins.
    expect(worstFunnelStep(rollup)?.step).toBe("file_selected");
  });

  it("returns null when nobody is lost", () => {
    const rollup = rollupFunnel(
      counts({
        tool_view: 5,
        tool_start: 5,
        file_selected: 5,
        job_submitted: 5,
        job_succeeded: 5,
        download: 5,
      }),
    );
    expect(worstFunnelStep(rollup)).toBeNull();
  });
});

/**
 * The local spine. Order IS the definition of drop-off, so it is pinned here
 * rather than trusted to whoever next edits the array.
 */
describe("local spine", () => {
  it("is the order a browser tool actually fires in", () => {
    expect([...LOCAL_FUNNEL_STEPS]).toEqual([
      ANALYTICS_EVENTS.tool_view,
      ANALYTICS_EVENTS.file_selected,
      ANALYTICS_EVENTS.tool_start,
      ANALYTICS_EVENTS.job_succeeded,
      ANALYTICS_EVENTS.download,
    ]);
  });

  it("omits job_submitted, which a local tool never emits", () => {
    // With it in the spine, the structural zero at that step clamps every later
    // step to zero and a working tool renders as one nobody completes.
    expect(LOCAL_FUNNEL_STEPS).not.toContain(ANALYTICS_EVENTS.job_submitted);
    const rollup = rollupFunnel(
      [
        { step: ANALYTICS_EVENTS.tool_view, count: 100 },
        { step: ANALYTICS_EVENTS.file_selected, count: 80 },
        { step: ANALYTICS_EVENTS.tool_start, count: 70 },
        { step: ANALYTICS_EVENTS.job_succeeded, count: 65 },
        { step: ANALYTICS_EVENTS.download, count: 60 },
      ],
      LOCAL_FUNNEL_STEPS,
    );
    expect(rollup.map((s) => s.count)).toEqual([100, 80, 70, 65, 60]);
    // The same counts against the server spine collapse — the failure this
    // second list exists to prevent.
    const wrong = rollupFunnel([
      { step: ANALYTICS_EVENTS.tool_view, count: 100 },
      { step: ANALYTICS_EVENTS.file_selected, count: 80 },
      { step: ANALYTICS_EVENTS.tool_start, count: 70 },
      { step: ANALYTICS_EVENTS.job_succeeded, count: 65 },
      { step: ANALYTICS_EVENTS.download, count: 60 },
    ]);
    expect(wrong.at(-1)?.count).toBe(0);
  });

  it("excludes job_failed, which is not progress toward a download", () => {
    expect(LOCAL_FUNNEL_STEPS).not.toContain(ANALYTICS_EVENTS.job_failed);
  });

  it("reports every step of the chosen spine even with no data for it", () => {
    const rollup = rollupFunnel([{ step: ANALYTICS_EVENTS.tool_view, count: 9 }], LOCAL_FUNNEL_STEPS);
    // A funnel derived from the rows that exist can never show the step where
    // everyone stopped.
    expect(rollup.map((s) => s.step)).toEqual([...LOCAL_FUNNEL_STEPS]);
    expect(rollup.slice(1).every((s) => s.count === 0)).toBe(true);
  });

  it("defaults to the server spine when no steps are named", () => {
    expect(rollupFunnel([]).map((s) => s.step)).toEqual([...FUNNEL_STEPS]);
  });
});
