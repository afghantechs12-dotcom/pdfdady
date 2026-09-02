import { describe, expect, it } from "vitest";
import {
  toComparisonOperationResponse,
  toComparisonResultResponse,
  toComparisonViewResponse,
  toDocumentStatisticsResponse,
} from "./statisticsHttp";
import { requireSameOrigin } from "./workspaceCsrf";
import type {
  ComparisonOperation,
  ComparisonResult,
  DocumentStatistics,
} from "@/src/domain/entities/DocumentStatistics";
import { STATISTICS_LIMITS } from "@/src/domain/entities/DocumentStatistics";

const NOW = new Date("2026-08-04T12:00:00.000Z");

function statistics(overrides: Partial<DocumentStatistics> = {}): DocumentStatistics {
  return {
    id: "stats-1",
    organizationId: "org-secret",
    workspaceId: "ws-1",
    documentId: "doc-1",
    versionId: "ver-1",
    schemaVersion: 1,
    counts: {
      pageCount: 12,
      textCharacterCount: 4200,
      wordCount: 700,
      imageCount: 0,
      annotationCount: null,
      bookmarkCount: 3,
      attachmentCount: null,
      fileSize: 81920,
    },
    checksum: "checksum-secret",
    status: "ready",
    error: null,
    calculatedAt: NOW,
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function operation(overrides: Partial<ComparisonOperation> = {}): ComparisonOperation {
  return {
    id: "cmp-1",
    organizationId: "org-secret",
    workspaceId: "ws-1",
    documentId: "doc-1",
    leftVersionId: "ver-1",
    rightVersionId: "ver-2",
    type: "textual",
    status: "running",
    progress: 40,
    requestedById: "user-1",
    cancelRequestedAt: null,
    error: null,
    resultId: null,
    createdAt: NOW,
    startedAt: NOW,
    completedAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function result(overrides: Partial<ComparisonResult> = {}): ComparisonResult {
  return {
    id: "res-1",
    organizationId: "org-secret",
    workspaceId: "ws-1",
    documentId: "doc-1",
    comparisonId: "cmp-1",
    type: "textual",
    summary: {
      added: 2,
      removed: 1,
      changed: 0,
      pagesAdded: [3],
      pagesRemoved: [],
      truncated: false,
    },
    differences: [{ kind: "added", pageNumber: 3, excerpt: "a new line" }],
    checksum: "checksum-secret",
    createdAt: NOW,
    ...overrides,
  };
}

describe("Document statistics serialization", () => {
  it("emits every measured count", () => {
    const body = toDocumentStatisticsResponse(statistics());
    expect(body.counts.pageCount).toBe(12);
    expect(body.counts.wordCount).toBe(700);
    expect(body.status).toBe("ready");
    expect(body.calculatedAt).toBe(NOW.toISOString());
  });

  it("keeps null distinct from zero", () => {
    // The whole point of the M7.11 domain: "measured, none" and "not measured"
    // are different facts, and coalescing here would make the panel claim a
    // document has no annotations when nobody looked.
    const body = toDocumentStatisticsResponse(statistics());
    expect(body.counts.imageCount).toBe(0);
    expect(body.counts.annotationCount).toBeNull();
    expect(body.counts.attachmentCount).toBeNull();
  });

  it("does not leak the organization id", () => {
    const body = toDocumentStatisticsResponse(statistics());
    expect(Object.keys(body)).not.toContain("organizationId");
    expect(JSON.stringify(body)).not.toContain("org-secret");
  });

  it("does not leak the internal checksum", () => {
    // An internal staleness token. A client decides nothing with it, and
    // emitting it only exposes how the server decides a row is current.
    const body = toDocumentStatisticsResponse(statistics());
    expect(JSON.stringify(body)).not.toContain("checksum-secret");
  });

  it("bounds an oversized stored error", () => {
    const body = toDocumentStatisticsResponse(
      statistics({ status: "failed", error: "x".repeat(5000), calculatedAt: null }),
    );
    expect([...(body.error ?? "")].length).toBe(STATISTICS_LIMITS.maxErrorLength);
    expect(body.calculatedAt).toBeNull();
  });

  it("reports a failed calculation as failed rather than as zeroes", () => {
    const body = toDocumentStatisticsResponse(
      statistics({ status: "failed", error: "extraction failed", calculatedAt: null }),
    );
    expect(body.status).toBe("failed");
    expect(body.error).toBe("extraction failed");
  });
});

describe("Comparison operation serialization", () => {
  it("emits the operation state a client needs", () => {
    const body = toComparisonOperationResponse(operation());
    expect(body.status).toBe("running");
    expect(body.progress).toBe(40);
    expect(body.leftVersionId).toBe("ver-1");
    expect(body.rightVersionId).toBe("ver-2");
  });

  it("does not leak the organization id or the internal result id", () => {
    const body = toComparisonOperationResponse(operation({ resultId: "res-internal" }));
    expect(Object.keys(body)).not.toContain("organizationId");
    expect(JSON.stringify(body)).not.toContain("org-secret");
    // Presence is what the client needs; the id is fetched through the
    // authorized result route rather than handed out here.
    expect(JSON.stringify(body)).not.toContain("res-internal");
    expect(body.hasResult).toBe(true);
  });

  it("reports a cancellation request as a boolean", () => {
    const body = toComparisonOperationResponse(operation({ cancelRequestedAt: NOW }));
    expect(body.cancelRequested).toBe(true);
  });

  it("bounds an oversized failure message", () => {
    const body = toComparisonOperationResponse(
      operation({ status: "failed", error: "y".repeat(5000) }),
    );
    expect([...(body.error ?? "")].length).toBe(STATISTICS_LIMITS.maxErrorLength);
  });
});

describe("Comparison result serialization", () => {
  it("emits the summary and differences", () => {
    const body = toComparisonResultResponse(result());
    expect(body.summary.added).toBe(2);
    expect(body.summary.pagesAdded).toEqual([3]);
    expect(body.differences[0].excerpt).toBe("a new line");
  });

  it("does not leak the organization id or the checksum", () => {
    const body = toComparisonResultResponse(result());
    expect(Object.keys(body)).not.toContain("organizationId");
    expect(JSON.stringify(body)).not.toContain("org-secret");
    expect(JSON.stringify(body)).not.toContain("checksum-secret");
  });

  it("bounds the difference list and says so", () => {
    const many = Array.from({ length: STATISTICS_LIMITS.maxDifferences + 25 }, (_, i) => ({
      kind: "added" as const,
      pageNumber: 1,
      excerpt: `line ${i}`,
    }));
    const body = toComparisonResultResponse(result({ differences: many }));

    expect(body.differences).toHaveLength(STATISTICS_LIMITS.maxDifferences);
    // A capped list that claimed to be complete would read as "these are all
    // the differences".
    expect(body.summary.truncated).toBe(true);
  });

  it("bounds an oversized excerpt", () => {
    const body = toComparisonResultResponse(
      result({ differences: [{ kind: "changed", pageNumber: 1, excerpt: "z".repeat(9000) }] }),
    );
    expect([...(body.differences[0].excerpt ?? "")].length).toBe(
      STATISTICS_LIMITS.maxExcerptLength,
    );
  });

  it("emits an excerpt as plain text without escaping it here", () => {
    // The client renders it as a text node; escaping at this layer would
    // double-escape at render.
    const body = toComparisonResultResponse(
      result({ differences: [{ kind: "added", pageNumber: 1, excerpt: "<script>x</script>" }] }),
    );
    expect(body.differences[0].excerpt).toBe("<script>x</script>");
  });
});

describe("Comparison view serialization", () => {
  it("carries the honest unsupported reason", () => {
    const body = toComparisonViewResponse({
      operation: operation({ type: "visual", status: "failed" }),
      result: null,
      unsupportedReason: "Visual comparison needs page rendering.",
    });
    expect(body.unsupportedReason).toBe("Visual comparison needs page rendering.");
    expect(body.result).toBeNull();
  });

  it("does not present a result before one exists", () => {
    const body = toComparisonViewResponse({
      operation: operation({ status: "running" }),
      result: null,
      unsupportedReason: null,
    });
    expect(body.comparison.status).toBe("running");
    expect(body.result).toBeNull();
    expect(body.comparison.hasResult).toBe(false);
  });
});

/**
 * Every state-changing M7.11 route calls `requireSameOrigin` before it does
 * anything else. These cases assert the rule holds for each URL shape,
 * including the nested cancel/retry paths where a missed call would be easiest
 * to overlook.
 */
describe("M7.11 mutation routes — same-origin enforcement", () => {
  const ORIGIN = "https://app.example.com";
  const paths = [
    "/api/workspaces/ws-1/documents/doc-1/statistics",
    "/api/workspaces/ws-1/documents/doc-1/comparisons",
    "/api/workspaces/ws-1/documents/doc-1/comparisons/cmp-1",
    "/api/workspaces/ws-1/documents/doc-1/comparisons/cmp-1/cancel",
    "/api/workspaces/ws-1/documents/doc-1/comparisons/cmp-1/retry",
  ];

  it("accepts a same-origin mutation on every route", () => {
    for (const path of paths) {
      const request = new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { origin: ORIGIN },
      });
      expect(requireSameOrigin(request)).toBeNull();
    }
  });

  it("rejects a cross-origin mutation on every route", () => {
    for (const path of paths) {
      const request = new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { origin: "https://evil.test" },
      });
      expect(requireSameOrigin(request)?.status).toBe(403);
    }
  });

  it("rejects a mutation with no origin evidence at all", () => {
    // An authenticated session must not bypass the check.
    for (const path of paths) {
      const request = new Request(`${ORIGIN}${path}`, { method: "DELETE" });
      expect(requireSameOrigin(request)?.status).toBe(403);
    }
  });
});
