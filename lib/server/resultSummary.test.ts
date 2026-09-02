import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { toStatusResponse } from "@/lib/server/processingJobApi";
import type { JobView } from "@/src/application/services/ProcessingJobService";

/**
 * The result summary: "1.2 MB → 950 KB (21% smaller)".
 *
 * This exists because the pilot shipped without it and nothing failed. The job
 * record held the real numbers — a browser run wrote `inputBytes=10250,
 * outputBytes=8118` — the service's `JobView` carried them, and then two
 * independent places dropped them on the floor:
 *
 *   1. `toStatusResponse` did not project them onto the wire shape, so the
 *      client never received them.
 *   2. `PipelineToolRunner` passed `outputBytes={null}` as a literal, so even a
 *      client that received them would not have rendered them.
 *
 * `JobStatePanel` guards its size display on `outputBytes != null`, so the
 * failure mode was silence: a compression job that saved 21% rendered as a bare
 * "Your file is ready" with no numbers, while the legacy `ServerToolRunner` it
 * replaces computes and shows the comparison from its own terminal frame. A
 * user-visible regression that the feature flag would have shipped, with a green
 * suite and no console error.
 *
 * Two layers, because either one alone stays green through the bug: the
 * projection test passes while the runner discards the field, and the wiring
 * test passes while the field never arrives.
 */

const REPO = process.cwd();

function view(over: Partial<JobView> = {}): JobView {
  return {
    jobId: "job_1",
    toolSlug: "compress-pdf",
    status: "completed",
    stage: "done",
    attempt: 1,
    maxAttempts: 3,
    resultAvailable: true,
    errorCategory: null,
    errorMessage: null,
    retryable: false,
    cancellable: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    queuedAt: null,
    startedAt: null,
    finishedAt: null,
    expiresAt: null,
    inputBytes: 10_250,
    outputBytes: 8_118,
    outputFileName: "quarterly_report-compressed.pdf",
    outputMimeType: "application/pdf",
    ...over,
  };
}

describe("the status projection", () => {
  it("carries the byte counts the summary is computed from", () => {
    const res = toStatusResponse(view());

    expect(res.inputBytes).toBe(10_250);
    expect(res.outputBytes).toBe(8_118);
  });

  it("passes null through rather than substituting a zero", () => {
    // A zero is a claim ("this file is empty"); null is the absence of one. The
    // panel branches on `!= null`, so a 0 here would render "8.1 KB → 0 B
    // (100% smaller)" for a job whose processor had not produced output yet.
    const res = toStatusResponse(view({ status: "running", outputBytes: null }));

    expect(res.outputBytes).toBeNull();
    expect(res.inputBytes).toBe(10_250);
  });

  it("still withholds everything that is not a size", () => {
    // Widening this boundary is the moment to re-assert what it is for. A byte
    // count is metadata; a storage key, an owner id or a processor message is
    // not, and none of them acquire a route to the client by way of this change.
    const keys = Object.keys(toStatusResponse(view()));

    for (const leak of [
      "storageKey",
      "outputKey",
      "ownerId",
      "userId",
      "workspaceId",
      "payload",
      "result",
      "processorMessage",
    ]) {
      expect(keys).not.toContain(leak);
    }
  });
});

describe("the pilot runner", () => {
  const src = readFileSync(
    path.join(REPO, "components/tools/runners/PipelineToolRunner.tsx"),
    "utf8",
  );

  it("feeds the panel the job's own output size, not a hardcoded null", () => {
    // The exact shape of the original bug: the prop was present and wired to a
    // literal, which type-checks, renders, and silently disables the display.
    expect(src).not.toMatch(/outputBytes=\{null\}/);
    expect(src).toMatch(/outputBytes=\{job\.outputBytes\}/);
  });

  it("prefers the server's input size over the local upload size", () => {
    // Both are correct while the file is in hand; only the server's survives a
    // remount, so the local one is the fallback and not the source.
    expect(src).toMatch(/inputBytes=\{job\.inputBytes \?\? inputBytes\}/);
  });

  it("is not vacuous: the panel really does gate its display on those props", () => {
    // If the panel stopped guarding on `outputBytes`, the two assertions above
    // would keep passing while proving nothing about what a user sees.
    const panel = readFileSync(
      path.join(REPO, "components/jobs/JobStatePanel.tsx"),
      "utf8",
    );
    expect(panel).toMatch(/showSizeComparison && inputBytes != null && outputBytes != null/);
    expect(panel).toMatch(/outputBytes != null && \(/);
  });
});
