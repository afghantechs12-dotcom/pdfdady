import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { StatisticsService, ComparisonView } from "./StatisticsService";
import type {
  ComparisonOperation,
  ComparisonResult,
  DocumentStatistics,
} from "@/src/domain/entities/DocumentStatistics";
import { STATISTICS_LIMITS } from "@/src/domain/entities/DocumentStatistics";

export function statisticsService(): StatisticsService {
  return appContainer.resolve<StatisticsService>(Tokens.StatisticsService);
}

/**
 * Serializes a statistics row for the wire.
 *
 * `organizationId` is deliberately absent, as it is on every other M7 response:
 * it is a tenant handle the client already holds from its own session, and
 * echoing it on each row only widens what a mis-scoped response could disclose.
 *
 * Counts are emitted with their nulls intact rather than coalesced to zero. The
 * distinction is the whole point of the M7.11 domain — "not measured" and
 * "measured, none" are different facts, and a serializer that flattened them
 * would make the panel claim a document has no images when nobody looked.
 */
export function toDocumentStatisticsResponse(statistics: DocumentStatistics) {
  return {
    id: statistics.id,
    workspaceId: statistics.workspaceId,
    documentId: statistics.documentId,
    versionId: statistics.versionId,
    schemaVersion: statistics.schemaVersion,
    counts: {
      pageCount: statistics.counts.pageCount,
      textCharacterCount: statistics.counts.textCharacterCount,
      wordCount: statistics.counts.wordCount,
      imageCount: statistics.counts.imageCount,
      annotationCount: statistics.counts.annotationCount,
      bookmarkCount: statistics.counts.bookmarkCount,
      attachmentCount: statistics.counts.attachmentCount,
      fileSize: statistics.counts.fileSize,
    },
    status: statistics.status,
    // Bounded on the way out as well as on the way in: an error written by an
    // older build must not become an unbounded response body.
    error: boundedMessage(statistics.error),
    calculatedAt: statistics.calculatedAt === null ? null : statistics.calculatedAt.toISOString(),
    revision: statistics.revision,
    createdAt: statistics.createdAt.toISOString(),
    updatedAt: statistics.updatedAt.toISOString(),
  };
}

/**
 * Serializes a comparison operation.
 *
 * The internal `checksum` is not emitted here and neither is any storage key:
 * a client needs to know what the comparison is doing, not how the server
 * addresses its artifacts.
 */
export function toComparisonOperationResponse(operation: ComparisonOperation) {
  return {
    id: operation.id,
    workspaceId: operation.workspaceId,
    documentId: operation.documentId,
    leftVersionId: operation.leftVersionId,
    rightVersionId: operation.rightVersionId,
    type: operation.type,
    status: operation.status,
    // Already reconciled with status by the domain, so a client never renders
    // "completed, 60%".
    progress: operation.progress,
    requestedById: operation.requestedById,
    cancelRequested: operation.cancelRequestedAt !== null,
    error: boundedMessage(operation.error),
    hasResult: operation.resultId !== null,
    createdAt: operation.createdAt.toISOString(),
    startedAt: operation.startedAt === null ? null : operation.startedAt.toISOString(),
    completedAt: operation.completedAt === null ? null : operation.completedAt.toISOString(),
    updatedAt: operation.updatedAt.toISOString(),
  };
}

/**
 * Serializes a comparison result.
 *
 * Differences are re-bounded here even though the repository bounds them on
 * write: a row written by an older build, or one whose cap has since been
 * lowered, must not be able to produce an unbounded response. `truncated` stays
 * honest about it — a capped list that claimed to be complete would read as
 * "these are all the differences".
 */
export function toComparisonResultResponse(result: ComparisonResult) {
  const differences = result.differences.slice(0, STATISTICS_LIMITS.maxDifferences);
  return {
    id: result.id,
    workspaceId: result.workspaceId,
    documentId: result.documentId,
    comparisonId: result.comparisonId,
    type: result.type,
    summary: {
      added: result.summary.added,
      removed: result.summary.removed,
      changed: result.summary.changed,
      pagesAdded: result.summary.pagesAdded.slice(0, STATISTICS_LIMITS.maxComparedPages),
      pagesRemoved: result.summary.pagesRemoved.slice(0, STATISTICS_LIMITS.maxComparedPages),
      truncated: result.summary.truncated || differences.length < result.differences.length,
    },
    differences: differences.map((difference) => ({
      kind: difference.kind,
      pageNumber: difference.pageNumber,
      // Plain text, bounded. Never markup — the client renders it as a text node.
      excerpt: boundedExcerpt(difference.excerpt),
    })),
    createdAt: result.createdAt.toISOString(),
  };
}

/** A comparison plus its result and any honest refusal, as one response. */
export function toComparisonViewResponse(view: ComparisonView) {
  return {
    comparison: toComparisonOperationResponse(view.operation),
    result: view.result === null ? null : toComparisonResultResponse(view.result),
    unsupportedReason: view.unsupportedReason,
  };
}

/** Bounds a message that reaches a client. Null stays null. */
function boundedMessage(value: string | null): string | null {
  if (value === null) return null;
  const characters = [...value];
  return characters.length <= STATISTICS_LIMITS.maxErrorLength
    ? value
    : characters.slice(0, STATISTICS_LIMITS.maxErrorLength).join("");
}

function boundedExcerpt(value: string | null): string | null {
  if (value === null) return null;
  const characters = [...value];
  return characters.length <= STATISTICS_LIMITS.maxExcerptLength
    ? value
    : characters.slice(0, STATISTICS_LIMITS.maxExcerptLength).join("");
}
