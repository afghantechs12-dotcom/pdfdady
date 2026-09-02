import { describe, expect, it } from "vitest";
import { tools as TOOLS } from "@/data/tools";
import {
  auditMeasurementCoverage,
  classifyTool,
  gatherEvidence,
  measurementCoverageGaps,
  type ToolCoverageEvidence,
} from "./measurementCoverage";
import { LOCAL_TOOL_SLUGS, REMOTE_JOB_TOOL_SLUGS } from "./executionPolicy";

/**
 * The measurement-coverage audit.
 *
 * Two halves, and the second is the load-bearing one.
 *
 * The first asserts the audit is currently clean. That is worth stating but it
 * is weak on its own: a classifier that returned "covered" unconditionally would
 * pass it, and so would one that quietly skipped rows.
 *
 * The second exercises `classifyTool` against tools that do not exist — an
 * unpaged local tool, a server tool with no processor, a server tool with no
 * cost profile, a local tool that acquired a server path. That is the actual
 * requirement: *a new functional tool registered without coverage must fail*, and
 * the only way to test it without registering a broken tool is to hand the
 * classifier the evidence a broken tool would produce.
 */

/** Evidence for a healthy tool, so each test can spoil exactly one field. */
function evidence(overrides: Partial<ToolCoverageEvidence> = {}): ToolCoverageEvidence {
  return {
    hasInstrumentedPage: true,
    hasServerProcessor: true,
    hasCostProfile: true,
    localFailureClassifierTotal: true,
    jobFailureClassifierTotal: true,
    ...overrides,
  };
}

const localTool = { slug: "future-local-tool", name: "Future Local", status: "functional-client" } as const;
const remoteTool = { slug: "future-server-tool", name: "Future Server", status: "functional-server" } as const;

describe("the audit covers the whole registry", () => {
  it("emits one row per registered tool, including the ones that cannot run", () => {
    const rows = auditMeasurementCoverage();
    expect(rows).toHaveLength(TOOLS.length);
    expect(rows.map((r) => r.slug).sort()).toEqual(TOOLS.map((t) => t.slug).sort());
    // Non-executable tools are present rather than filtered. A tool that
    // disappeared from the audit while "planned" would disappear again the day
    // it ships, which is precisely when it needs to be here.
    expect(rows.some((r) => r.executionMode === null)).toBe(true);
  });

  it("has no gaps", () => {
    expect(measurementCoverageGaps()).toEqual([]);
  });

  it("classifies both execution modes, so the clean result is not a filtered one", () => {
    const rows = auditMeasurementCoverage();
    const local = rows.filter((r) => r.executionMode === "local");
    const remote = rows.filter((r) => r.executionMode === "remote_job");
    expect(local).toHaveLength(LOCAL_TOOL_SLUGS.size);
    expect(remote).toHaveLength(REMOTE_JOB_TOOL_SLUGS.size);
    expect(local.length).toBeGreaterThanOrEqual(18);
    expect(remote.length).toBeGreaterThanOrEqual(14);
  });

  it("says local tools consume no server allowance, and means it as a requirement", () => {
    for (const row of auditMeasurementCoverage()) {
      if (row.executionMode !== "local") continue;
      expect(row.analyticsCoverage, `${row.slug}`).toBe("covered");
      // `not_applicable`, never `covered`: a browser tool that moved a remote
      // counter would be charging for work no server did.
      expect(row.authoritativeMeteringCoverage, `${row.slug}`).toBe("not_applicable");
      expect(row.failureTaxonomyCoverage, `${row.slug}`).toBe("covered");
    }
  });

  it("requires all three of every server tool", () => {
    for (const row of auditMeasurementCoverage()) {
      if (row.executionMode !== "remote_job") continue;
      expect(row.analyticsCoverage, `${row.slug}`).toBe("covered");
      expect(row.authoritativeMeteringCoverage, `${row.slug}`).toBe("covered");
      expect(row.failureTaxonomyCoverage, `${row.slug}`).toBe("covered");
    }
  });

  it("reads real per-slug evidence, not a constant", () => {
    // If `gatherEvidence` answered the same thing for everything, every test
    // above would still pass. A local slug must have a page and no processor; a
    // remote slug the reverse.
    const local = gatherEvidence("merge-pdf");
    expect(local.hasInstrumentedPage).toBe(true);
    expect(local.hasServerProcessor).toBe(false);
    const remote = gatherEvidence("compress-pdf");
    expect(remote.hasServerProcessor).toBe(true);
    expect(remote.hasCostProfile).toBe(true);
    // And an unregistered slug has none of it, so the fs and registry lookups
    // are really being consulted.
    const nothing = gatherEvidence("not-a-tool-at-all");
    expect(nothing.hasInstrumentedPage).toBe(false);
    expect(nothing.hasServerProcessor).toBe(false);
    expect(nothing.hasCostProfile).toBe(false);
  });
});

describe("a new functional tool without coverage fails the audit", () => {
  it("fails a local tool whose page does not mount the funnel", () => {
    const row = classifyTool(localTool, evidence({ hasInstrumentedPage: false }));
    expect(row.analyticsCoverage).toBe("missing");
    expect(row.notes.join(" ")).toContain("ToolPageTemplate");
  });

  it("fails a local tool that acquired a server processor", () => {
    // Not a bonus. The privacy claim on the page says the bytes stay put.
    const row = classifyTool(localTool, evidence({ hasServerProcessor: true }));
    expect(row.authoritativeMeteringCoverage).toBe("missing");
    expect(row.notes.join(" ")).toContain("remote allowance");
  });

  it("fails a server tool with no processor", () => {
    const row = classifyTool(remoteTool, evidence({ hasServerProcessor: false }));
    expect(row.analyticsCoverage).toBe("missing");
    expect(row.authoritativeMeteringCoverage).toBe("missing");
  });

  it("fails a server tool with no cost profile", () => {
    // It would run, it would be counted as an operation, and it would settle zero
    // compute — free work in the column the cost model is calibrated against.
    const row = classifyTool(remoteTool, evidence({ hasCostProfile: false }));
    expect(row.authoritativeMeteringCoverage).toBe("missing");
    expect(row.notes.join(" ")).toContain("zero compute");
  });

  it("fails every tool in a mode whose failure classifier stops being total", () => {
    // The one column that is not per-slug: a classifier that could return a raw
    // message would put a filename in the ledger for every tool at once.
    expect(classifyTool(localTool, evidence({ localFailureClassifierTotal: false })).failureTaxonomyCoverage).toBe("missing");
    expect(classifyTool(remoteTool, evidence({ jobFailureClassifierTotal: false })).failureTaxonomyCoverage).toBe("missing");
    // And each mode reads its OWN classifier, so a break in one is not masked by
    // the other being healthy.
    expect(classifyTool(localTool, evidence({ jobFailureClassifierTotal: false })).failureTaxonomyCoverage).toBe("covered");
    expect(classifyTool(remoteTool, evidence({ localFailureClassifierTotal: false })).failureTaxonomyCoverage).toBe("covered");
  });

  it("asks nothing of a tool that cannot run, and still lists it", () => {
    const row = classifyTool(
      { slug: "someday-tool", name: "Someday", status: "planned" },
      evidence({ hasInstrumentedPage: false, hasServerProcessor: false, hasCostProfile: false }),
    );
    expect(row.executionMode).toBeNull();
    expect([
      row.analyticsCoverage,
      row.authoritativeMeteringCoverage,
      row.failureTaxonomyCoverage,
    ]).toEqual(["not_applicable", "not_applicable", "not_applicable"]);
    expect(row.slug).toBe("someday-tool");
  });

  it("reports a gap line naming the tool, its mode and the column", () => {
    // The gap strings are what a human reads at 2am. A gap that said only
    // "coverage missing" would send them looking through 32 tools.
    const row = classifyTool(remoteTool, evidence({ hasCostProfile: false }));
    expect(row.slug).toBe("future-server-tool");
    expect(row.executionMode).toBe("remote_job");
    expect(row.notes.length).toBeGreaterThan(0);
  });
});
