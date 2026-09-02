import { describe, expect, it } from "vitest";
import {
  MIN_OBSERVATION_DAYS,
  MIN_OBSERVED_OPERATIONS,
  MIN_OBSERVED_TOOLS,
  RECOMMENDATION_HEADROOM_FACTOR,
  assessEnforcementReadiness,
  guestShareOf,
  recommendLimits,
  type CalibrationObservation,
  type ToolObservation,
} from "./readiness";
import { ENFORCEABLE_METERS } from "./meters";
import { ALL_PLAN_IDS } from "./plans";

/**
 * The readiness verdict.
 *
 * The assertions worth having here are the refusals. A test that only checked
 * "enough data → ready" would pass against a function that returned `true`
 * unconditionally, which is precisely the shape this module exists to prevent
 * someone from shipping. So every threshold is tested at the boundary from BOTH
 * sides, and there is a test for each way the observation can be untrustworthy
 * while still looking numerically sufficient.
 */

function tool(overrides: Partial<ToolObservation> = {}): ToolObservation {
  return {
    toolSlug: "compress-pdf",
    executionMode: "remote_job",
    operations: 100,
    failures: 3,
    failureRate: 0.03,
    computeUnits: 400,
    inputBytes: 1_000_000,
    averageDurationMs: 900,
    durationSamples: 100,
    ...overrides,
  };
}

/** One part of `total` split `parts` ways, remainder spread over the first ones. */
function share(total: number, parts: number, index: number): number {
  return Math.floor(total / parts) + (index < total % parts ? 1 : 0);
}

/** An observation that clears every threshold. Each test spoils exactly one thing. */
function sufficient(overrides: Partial<CalibrationObservation> = {}): CalibrationObservation {
  const operations = overrides.operations ?? MIN_OBSERVED_OPERATIONS;
  return {
    days: MIN_OBSERVATION_DAYS,
    limitMode: "observe",
    operations,
    // The per-tool breakdown SUMS to `operations`, because the verdict counts
    // server operations from the breakdown rather than trusting the scalar (see
    // `serverOperationsOf`). A fixture whose two halves disagreed would exercise a
    // state the ledger cannot produce, and would then pass or fail for a reason no
    // test named. A test that means to break the agreement overrides `tools` too.
    tools: [0, 1, 2].map((i) =>
      tool({
        toolSlug: ["compress-pdf", "ocr-pdf", "protect-pdf"][i],
        operations: share(operations, 3, i),
      }),
    ),
    inputSizeBuckets: [{ label: "<1MB", count: 400 }, { label: "1-5MB", count: 100 }],
    population: [{ label: "anon", count: 300 }, { label: "user", count: 200 }],
    limitEvents: 12,
    degraded: false,
    ...overrides,
  };
}

describe("assessEnforcementReadiness", () => {
  it("is ready only when every threshold is cleared in observe mode", () => {
    const verdict = assessEnforcementReadiness(sufficient());
    expect(verdict.ready_for_enforcement).toBe(true);
    expect(verdict.reason).toBe("observation_sufficient");
    expect(verdict.gaps).toEqual([]);
  });

  it("refuses a window shorter than the minimum, and names the shortfall", () => {
    const verdict = assessEnforcementReadiness(
      sufficient({ days: MIN_OBSERVATION_DAYS - 1 }),
    );
    expect(verdict.ready_for_enforcement).toBe(false);
    expect(verdict.reason).toBe("insufficient_observation_data");
    // The number, not just "not enough": an operator has to be able to tell
    // "come back tomorrow" from "come back next quarter".
    expect(verdict.gaps.join(" ")).toContain(String(MIN_OBSERVATION_DAYS - 1));
  });

  it("refuses too few operations", () => {
    const verdict = assessEnforcementReadiness(
      sufficient({ operations: MIN_OBSERVED_OPERATIONS - 1 }),
    );
    expect(verdict.ready_for_enforcement).toBe(false);
    expect(verdict.reason).toBe("insufficient_observation_data");
  });

  it("refuses when one tool carries all the traffic", () => {
    // Volume alone is not coverage. A ceiling calibrated on compression is wrong
    // for OCR in one direction and wrong for unlock in the other.
    const verdict = assessEnforcementReadiness(
      sufficient({ tools: [tool({ operations: 10_000 })] }),
    );
    expect(verdict.ready_for_enforcement).toBe(false);
    expect(verdict.observed.toolsObserved).toBe(1);
    expect(verdict.gaps.join(" ")).toContain(String(MIN_OBSERVED_TOOLS));
  });

  it("does not count a registered tool that did nothing", () => {
    // Three rows, two with traffic. The registry is not the measurement.
    const verdict = assessEnforcementReadiness(
      sufficient({
        tools: [tool(), tool({ toolSlug: "ocr-pdf" }), tool({ toolSlug: "repair-pdf", operations: 0 })],
      }),
    );
    expect(verdict.observed.toolsObserved).toBe(2);
    expect(verdict.ready_for_enforcement).toBe(false);
  });

  it("does not let in-browser work authorize a server ceiling", () => {
    // The meters being calibrated count work the SERVER did. A fortnight of local
    // merges consumes none of it, and yet those attempts reach the same ledger —
    // so without this filter they would clear the threshold guarding a ceiling on
    // server jobs.
    const verdict = assessEnforcementReadiness(
      sufficient({
        operations: 10_000,
        tools: [
          tool({ toolSlug: "merge-pdf", executionMode: "local", operations: 9_000 }),
          tool({ toolSlug: "split-pdf", executionMode: "local", operations: 900 }),
          tool({ toolSlug: "compress-pdf", operations: 100 }),
        ],
      }),
    );
    expect(verdict.observed.operations).toBe(100);
    expect(verdict.observed.excludedOperations).toBe(9_900);
    expect(verdict.observed.toolsObserved).toBe(1);
    expect(verdict.ready_for_enforcement).toBe(false);
  });

  it("excludes a slug the registry no longer knows, rather than trusting it", () => {
    // A null execution mode is unattributable traffic — the settlement path records
    // an attempt row for an unknown slug before it discovers the tool is unmetered.
    // It cannot vouch for server capacity it was never measured against.
    const verdict = assessEnforcementReadiness(
      sufficient({
        operations: 5_000,
        tools: [tool({ toolSlug: "unknown", executionMode: null, operations: 5_000 })],
      }),
    );
    expect(verdict.observed.operations).toBe(0);
    expect(verdict.observed.excludedOperations).toBe(5_000);
    expect(verdict.ready_for_enforcement).toBe(false);
  });

  it("reports every gap at once, not the first one", () => {
    // An operator fixing them one at a time would otherwise need three reports to
    // find out there were three problems.
    const verdict = assessEnforcementReadiness(
      sufficient({ days: 1, operations: 2, tools: [tool({ operations: 2 })] }),
    );
    expect(verdict.gaps).toHaveLength(3);
  });

  it("never claims readiness from a degraded read, however large the numbers", () => {
    // The dangerous case: every threshold cleared, but the counts are floors from
    // a partial query. Checked BEFORE the thresholds so a failed query cannot
    // produce the report that authorizes enforcement.
    const verdict = assessEnforcementReadiness(
      sufficient({ degraded: true, operations: 10_000_000, days: 365 }),
    );
    expect(verdict.ready_for_enforcement).toBe(false);
    expect(verdict.reason).toBe("observation_degraded");
  });

  it("reports degradation ahead of the thresholds, so the cause is the real one", () => {
    // Both orders answer `false`, so the ordering is only observable in `reason` —
    // and that is what an operator acts on. "insufficient data" says wait a
    // fortnight; "degraded" says fix the query. Reporting the first for the second
    // sends someone away for two weeks from a broken dashboard.
    const verdict = assessEnforcementReadiness(sufficient({ degraded: true, days: 1 }));
    expect(verdict.reason).toBe("observation_degraded");
    expect(verdict.gaps).toEqual([
      "at least one usage query failed; the counts are floors, not totals",
    ]);
  });

  it("refuses when the limit decision is not even running", () => {
    // `off` skips the decision entirely, so there are no would-have-blocked rows
    // behind the totals and nothing has been calibrated against.
    const verdict = assessEnforcementReadiness(sufficient({ limitMode: "off" }));
    expect(verdict.ready_for_enforcement).toBe(false);
    expect(verdict.reason).toBe("not_observing");
  });

  it("reports enforcement already live as its own state, not as readiness", () => {
    const verdict = assessEnforcementReadiness(sufficient({ limitMode: "enforce" }));
    expect(verdict.ready_for_enforcement).toBe(false);
    expect(verdict.reason).toBe("already_enforcing");
  });

  it("counts would-have-blocked events only while observing", () => {
    expect(assessEnforcementReadiness(sufficient()).observed.wouldHaveBlocked).toBe(12);
    // In `enforce` those rows are real refusals and in `off` the decision never
    // ran. Either way calling them "would have blocked" is a category error, so
    // the field is null rather than a number that means something else.
    for (const limitMode of ["enforce", "off"] as const) {
      expect(
        assessEnforcementReadiness(sufficient({ limitMode })).observed.wouldHaveBlocked,
      ).toBeNull();
    }
  });

  it("reports a mean per day, and survives a zero-day window", () => {
    const verdict = assessEnforcementReadiness(sufficient({ days: 0, operations: 70 }));
    // No Infinity and no NaN reaching a UI: `days` floors at 1.
    expect(verdict.observed.operationsPerDay).toBe(70);
    expect(Number.isFinite(verdict.observed.operationsPerDay)).toBe(true);
  });

  it("publishes the thresholds it judged against", () => {
    // A verdict whose thresholds are invisible is a verdict nobody can audit.
    expect(assessEnforcementReadiness(sufficient()).thresholds).toEqual({
      minObservationDays: MIN_OBSERVATION_DAYS,
      minOperations: MIN_OBSERVED_OPERATIONS,
      minTools: MIN_OBSERVED_TOOLS,
    });
  });
});

describe("guestShareOf", () => {
  it("splits guests from authenticated traffic", () => {
    expect(guestShareOf([{ label: "anon", count: 3 }, { label: "user", count: 1 }])).toBe(0.75);
  });

  it("distinguishes an empty ledger from a product with no guests", () => {
    // 0 would report an ingest outage as "nobody is anonymous".
    expect(guestShareOf([])).toBeNull();
    expect(guestShareOf([{ label: "user", count: 5 }])).toBe(0);
  });

  it("ignores buckets that are neither, rather than folding them into guests", () => {
    // `system` is our own work. Counting it as a guest would inflate the share
    // that a guest allowance is calibrated from.
    expect(
      guestShareOf([
        { label: "anon", count: 1 },
        { label: "user", count: 1 },
        { label: "system", count: 2 },
      ]),
    ).toBe(0.25);
  });
});

describe("recommendLimits", () => {
  it("recommends nothing at all when the data is insufficient", () => {
    const recs = recommendLimits(sufficient({ operations: 1 }));
    expect(recs.length).toBeGreaterThan(0);
    for (const rec of recs) {
      expect(rec.status).toBe("insufficient_data");
      // Not "a number with a low-confidence flag": the union has no numeric
      // suggestion on this arm, so there is no field to misread as evidence.
      expect(rec).not.toHaveProperty("suggestedPerDay");
    }
  });

  it("covers every plan and every enforceable meter, so a gap is visible", () => {
    const recs = recommendLimits(sufficient());
    expect(recs).toHaveLength(ALL_PLAN_IDS.length * ENFORCEABLE_METERS.length);
  });

  it("suggests a per-day operations ceiling with the arithmetic that produced it", () => {
    const observation = sufficient({ operations: 700, days: 14 });
    const rec = recommendLimits(observation).find(
      (r) => r.meter === "server_operations" && r.plan === "free",
    );
    expect(rec?.status).toBe("available");
    if (rec?.status !== "available") throw new Error("expected an available recommendation");
    expect(rec.basisPerDay).toBe(50);
    expect(rec.headroomFactor).toBe(RECOMMENDATION_HEADROOM_FACTOR);
    // Headroom, not the mean: a ceiling at the mean refuses about half of all days.
    expect(rec.suggestedPerDay).toBe(500);
    expect(rec.suggestedPerDay).toBeGreaterThan(rec.basisPerDay);
  });

  it("declines to recommend a byte ceiling it has no per-day basis for", () => {
    // The aggregate has input bytes per TOOL, not per owner per day. Borrowing the
    // operations figure and calling it bytes would be an invented number.
    const byteRecs = recommendLimits(sufficient()).filter(
      (r) => r.meter !== "server_operations",
    );
    expect(byteRecs.length).toBeGreaterThan(0);
    for (const rec of byteRecs) expect(rec.status).toBe("insufficient_data");
  });

  it("shows today's configured allowance beside every verdict", () => {
    // The comparison is the point of the report: "we allow 100/day and observe 50"
    // is actionable, and a suggestion with nothing to compare it to is not.
    const rec = recommendLimits(sufficient()).find(
      (r) => r.meter === "server_operations" && r.plan === "free",
    );
    expect(rec?.currentLimit).toBe(100);
  });

  it("derives its gate from the readiness verdict rather than its own thresholds", () => {
    // Passing a hand-made "ready" verdict must change the output — proving there is
    // one decision point, not two that can disagree.
    const observation = sufficient({ operations: 1, days: 1 });
    const forced = { ...assessEnforcementReadiness(sufficient()), ready_for_enforcement: true };
    const recs = recommendLimits(observation, forced);
    expect(recs.some((r) => r.status === "available")).toBe(true);
  });
});
