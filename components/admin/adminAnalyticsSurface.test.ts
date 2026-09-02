import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MAX_REPORT_DAYS } from "@/src/application/services/UsageAnalyticsReadService";

/**
 * What the admin analytics page is required to show, and what it may never show.
 *
 * WHY SOURCE TEXT. vitest runs `environment: "node"` with no DOM and no React
 * renderer, so this dashboard cannot be mounted here. The data it renders is
 * already covered against the real repository in `UsageAnalyticsReadService.test.ts`
 * and `usageCalibration.test.ts` — including that the serialized report contains no
 * `subjectHash` and no `ownerId`. What is left is a property of the markup:
 *
 *  - the milestone's required dimensions each have a place on the page, so a
 *    dimension the service computes cannot be invisible to the operator reading it;
 *  - the window choices stay inside the server's own clamp, so the selector cannot
 *    ask for a range the server will silently shorten;
 *  - the page names none of the identifiers the milestone forbids exposing.
 *
 * The last one is the reason this file exists rather than living as a comment. A
 * report that omits `subjectHash` is not the same guarantee as a page that cannot
 * render one: the service could gain a field, and the dashboard would happily
 * print it. Comments are stripped before matching, so prose about a card cannot
 * satisfy an assertion that the card exists.
 */

function code(...segments: string[]): string {
  return readFileSync(path.join(process.cwd(), ...segments), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");
}

const dashboard = () => code("components", "admin", "AnalyticsDashboard.tsx");

describe("the admin surface covers every required dimension", () => {
  it("shows each one", () => {
    const src = dashboard();
    // One assertion per milestone bullet, named so a failure says which bullet
    // regressed rather than "a string is missing".
    const required: Record<string, string> = {
      "bounded date ranges": "WINDOWS",
      "local vs remote": "report.execution",
      "success and failure counts": "report?.processing",
      "failure categories": "report.errorCategories",
      "top tools": "report.topTools",
      "tool funnels": "report.funnels",
      "compute usage": "Compute units",
      "byte volume": "Bytes processed",
      "would-have-blocked events": "wouldHaveBlocked",
      "readiness status": "ready_for_enforcement",
    };
    const missing = Object.entries(required)
      .filter(([, needle]) => !src.includes(needle))
      .map(([dimension]) => dimension);
    expect(missing).toEqual([]);
  });

  it("keeps every window choice inside the server's clamp", () => {
    // A 365-day option would be clamped server-side and the page would then
    // label a 90-day figure as a year. The clamp is imported rather than
    // duplicated, so raising it there is what widens the selector.
    const src = dashboard();
    const days = [...src.matchAll(/days:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(days.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...days)).toBeLessThanOrEqual(MAX_REPORT_DAYS);
  });

  it("says when the server shortened or degraded the window it is showing", () => {
    const src = dashboard();
    // Both are states the report can return. Rendering the numbers without them
    // presents a partial read as a complete one.
    expect(src).toContain("report?.window.clamped");
    expect(src).toContain("report?.degraded");
  });

  it("reads the readiness verdict rather than deciding it here", () => {
    const src = dashboard();
    // The verdict is a domain decision with published thresholds. A dashboard
    // that compared counts itself would be a second place that can disagree —
    // and the disagreeing one would be the one an operator acts on.
    expect(src).toContain("report.calibration.readiness.ready_for_enforcement");
    expect(src).not.toMatch(/MIN_OBSERVED|MIN_OBSERVATION/);
    expect(src).not.toMatch(/>=\s*500|>\s*14\b/);
  });

  it("shows every readiness figure the calibration gate actually decides on", () => {
    const src = dashboard();
    // Each threshold has a corresponding observed figure, and both halves are read
    // from the report. A page that showed the count without the requirement leaves
    // the operator to remember what "3" is being compared against; one that showed
    // the requirement without the count is a constant.
    for (const pair of [
      ["observed.days", "thresholds.minObservationDays"],
      ["observed.operations", "thresholds.minOperations"],
      ["observed.toolsObserved", "thresholds.minTools"],
    ]) {
      for (const needle of pair) {
        expect(src, `calibration card must render ${needle}`).toContain(needle);
      }
    }
    // Not a threshold, but the two figures an operator needs to judge whether the
    // window is worth trusting at all.
    expect(src).toContain("observation.limitEvents");
    expect(src).toContain("observed.wouldHaveBlocked");
  });

  it("labels the days figure as days with traffic, not the span asked for", () => {
    const src = dashboard();
    // The distinction this slice fixed. "Days observed" is satisfiable by widening
    // a date picker; "days with traffic" is not, and the label is where an operator
    // learns which one they are looking at.
    expect(src).toMatch(/Days with traffic/);
    expect(src).toContain("days with server traffic");
  });

  it("says which window the readiness figures were measured over", () => {
    const src = dashboard();
    // Calibration reads a WIDER window than the rest of the page — a 14-day
    // threshold cannot be met inside a 7-day range. Without this line the days
    // figure appears to belong to the selected range and reads as wrong.
    expect(src).toContain("report.calibration.window.days");
    expect(src).toContain("report.calibration.window.clamped");
  });

  it("never lets a degraded calibration read look complete", () => {
    const src = dashboard();
    // A failed usage query makes every figure above a floor. A floor that happens
    // to clear a threshold has measured nothing, so the state has to be visible
    // and announced, not merely absent from the numbers.
    expect(src).toContain("report.calibration.observation.degraded");
    expect(src).toMatch(/role="status"/);
    expect(src).toMatch(/minimum, not a\s+total/);
    // The verdict itself still comes from the domain judge, which refuses READY on
    // a degraded read; the page must not compute a friendlier one beside it.
    expect(src).not.toMatch(/degraded\s*(&&|\?)[^\n]*ready/i);
  });

  it("explains the operations it excluded rather than dropping them silently", () => {
    const src = dashboard();
    // Local and unknown-slug attempts consume no server capacity, so they cannot
    // authorize a server limit. Two operation counts on one page that disagree by
    // an unexplained amount is how someone concludes the ledger is broken.
    expect(src).toContain("observed.excludedOperations");
    expect(src).toMatch(/consumed no\s+server capacity/);
  });

  it("shows no suggested ceiling on the insufficient-data arm", () => {
    const src = dashboard();
    // The union has no number to print on that arm, so this is really a check
    // that the branch was not flattened into "show whatever is there".
    expect(src).toContain('rec.status === "available"');
    expect(src).toContain("insufficient data");
  });
});

describe("the admin surface exposes none of the forbidden identifiers", () => {
  it("names no visitor, owner, document or secret", () => {
    const src = dashboard();
    for (const forbidden of [
      "subjectHash",
      "ownerId",
      "fileName",
      "storageKey",
      "capabilityToken",
      "sessionToken",
      "ANALYTICS_SUBJECT_SECRET",
    ]) {
      expect(src, `dashboard must not render ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("renders aggregates, never an event row", () => {
    const src = dashboard();
    // `events` on the report is a count list, not rows. A `.map` over something
    // named `rows`/`events` with per-record fields would be the raw-row leak.
    expect(src).not.toMatch(/\.properties\b/);
    expect(src).not.toMatch(/report\.(rows|rawEvents|eventRows)\b/);
  });

  it("is a client component that reaches no server module", () => {
    const raw = readFileSync(
      path.join(process.cwd(), "components/admin/AnalyticsDashboard.tsx"),
      "utf8",
    );
    expect(raw.startsWith('"use client"')).toBe(true);
    // Types only from the service; the values come over HTTP from the guarded
    // route. A value import would pull Prisma — and the subject secret — toward
    // the browser bundle.
    for (const stmt of raw.match(/^import[\s\S]*?;$/gm) ?? []) {
      if (!stmt.includes("@/src/application/services")) continue;
      expect(stmt, `must be a type-only import: ${stmt}`).toMatch(/^import type /);
    }
    expect(raw).not.toContain("@/src/application/di");
    expect(raw).not.toContain("@/src/infrastructure");
  });
});
