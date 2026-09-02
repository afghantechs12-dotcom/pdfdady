import { createHash } from "node:crypto";
import type { ILogger } from "@/src/application/ports/Logger";
import type { ActorContext, WorkspaceService } from "./WorkspaceService";
import type { DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";
import type { DocumentVersionRepository } from "@/src/application/ports/workspaces/DocumentVersionRepository";
import type { DocumentStatisticsRepository } from "@/src/application/ports/workspaces/DocumentStatisticsRepository";
import type { ComparisonOperationRepository } from "@/src/application/ports/workspaces/ComparisonOperationRepository";
import type { ComparisonResultRepository } from "@/src/application/ports/workspaces/ComparisonResultRepository";
import type { SearchChunkRepository } from "@/src/application/ports/workspaces/SearchChunkRepository";
import type { BookmarkRepository } from "@/src/application/ports/workspaces/BookmarkRepository";
import type { AttachmentRepository } from "@/src/application/ports/workspaces/AttachmentRepository";
import type {
  ComparisonOperation,
  ComparisonResult,
  ComparisonSide,
  ComparisonType,
  DocumentStatistics,
  StatisticsCounts,
  StatisticsSource,
} from "@/src/domain/entities/DocumentStatistics";
import {
  STATISTICS_LIMITS,
  canTransitionComparison,
  compareStructural,
  compareTextual,
  computeStatistics,
  emptyCounts,
  isBoundedStatisticsId,
  isComparisonSupported,
  isComparisonType,
  isTerminalComparisonStatus,
  serializeCounts,
  statisticsListLimit,
  unsupportedComparisonReason,
  validateComparisonError,
  validateProgress,
} from "@/src/domain/entities/DocumentStatistics";
import type { DocumentRecord } from "@/src/domain/entities/DocumentRecord";
import type { DocumentVersion } from "@/src/domain/entities/DocumentVersion";
import { DomainError, NotFoundError } from "@/src/domain/errors";

/** What the comparison worker is handed when it picks up an operation. */
export interface ComparisonWorkInput {
  left: ComparisonSide;
  right: ComparisonSide;
}

/** A comparison plus its result, when it has one. */
export interface ComparisonView {
  operation: ComparisonOperation;
  result: ComparisonResult | null;
  /** Set when the requested type is not supported by this build. */
  unsupportedReason: string | null;
}

/**
 * M7.11 document statistics and version comparison.
 *
 * Three properties govern this service.
 *
 * **Statistics belong to a version, and every number is measured.** The
 * fabricated implementation this replaced returned `pageCount: 10` and
 * `textCharCount: 15000` for every document, and resolved the Workspace by
 * splitting the document id on a hyphen. Here, statistics are keyed to an
 * immutable DocumentVersion, are computed by `computeStatistics` from content
 * the caller supplies, and carry a checksum of what was measured. A count that
 * was not measured is `null`, never `0` — a document nobody scanned for images
 * must not report confidently that it has none.
 *
 * **Comparison state is a bounded, one-way machine.** Every transition goes
 * through `canTransitionComparison` and is applied as a compare-and-swap on the
 * current status, so a duplicate worker delivery finds the state already moved
 * and is refused rather than replayed. A cancelled operation can never become
 * completed; retrying creates a new operation, which keeps the cancellation an
 * honest historical fact.
 *
 * **Unsupported is a real answer.** Visual comparison has no rasteriser in this
 * build, so it is refused with an explanation rather than completing with an
 * empty diff that would read as "these pages are identical".
 *
 * Authorization runs before any row is read, and both versions are resolved
 * within the document before either is compared — a version id from another
 * Workspace or another document reads as missing, never as forbidden.
 */
export class StatisticsService {
  constructor(
    private readonly logger: ILogger,
    private readonly workspaces: WorkspaceService,
    private readonly documents: DocumentRecordRepository,
    private readonly versions: DocumentVersionRepository,
    private readonly statistics: DocumentStatisticsRepository,
    private readonly comparisons: ComparisonOperationRepository,
    private readonly results: ComparisonResultRepository,
    /**
     * Server-held extracted content, used by `recalculateFromServerContent` so a
     * client can request a recalculation without being able to supply the
     * numbers. The same chunks that feed search feed statistics, so the two
     * cannot disagree about what a document contains.
     */
    private readonly searchChunks: SearchChunkRepository,
    private readonly bookmarks: BookmarkRepository,
    private readonly attachments: AttachmentRepository,
    /** Injected so tests can pin time without touching the system clock. */
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // ---- authorization -------------------------------------------------------

  /**
   * Authorizes the Workspace and resolves the document within it.
   *
   * The order is load-bearing: a caller with no access to the Workspace learns
   * nothing about the document, and a document outside the Workspace reads as
   * missing rather than as forbidden.
   */
  private async authorize(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    write = false,
  ): Promise<{ document: DocumentRecord; organizationId: string }> {
    if (!isBoundedStatisticsId(workspaceId)) {
      throw new DomainError("A valid workspace id is required.");
    }
    if (!isBoundedStatisticsId(documentId)) {
      throw new DomainError("A valid document id is required.");
    }
    const { workspace } = await this.workspaces.get(actor, workspaceId, write);
    const document = await this.documents.getById(workspaceId, documentId);
    if (!document) throw new NotFoundError("Document not found in this workspace.");
    return { document, organizationId: workspace.organizationId };
  }

  /**
   * Resolves a version *within* a document.
   *
   * Both checks matter and neither is redundant: the Workspace check stops a
   * cross-tenant id, and the document check stops a version id belonging to
   * another document in the same Workspace from being measured or compared
   * through a document the actor happens to be able to see.
   */
  private async requireVersion(
    workspaceId: string,
    documentId: string,
    versionId: string,
  ): Promise<DocumentVersion> {
    if (!isBoundedStatisticsId(versionId)) {
      throw new DomainError("A valid version id is required.");
    }
    const version = await this.versions.getById(workspaceId, versionId);
    if (!version || version.documentId !== documentId) {
      throw new NotFoundError("Version not found for this document.");
    }
    return version;
  }

  // ---- statistics ----------------------------------------------------------

  /**
   * Reads the statistics for one version, or null when none have been computed.
   *
   * Null rather than a zeroed record: "not calculated yet" and "calculated, all
   * zero" are different states, and a panel must be able to tell them apart to
   * decide whether to offer a recalculate action.
   */
  async getStatistics(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    versionId: string,
  ): Promise<DocumentStatistics | null> {
    await this.authorize(actor, workspaceId, documentId);
    await this.requireVersion(workspaceId, documentId, versionId);
    return this.statistics.getByVersionId(workspaceId, versionId);
  }

  /** Every computed statistics row for a document, newest first. */
  async listStatistics(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    options: { limit?: number } = {},
  ): Promise<DocumentStatistics[]> {
    await this.authorize(actor, workspaceId, documentId);
    return this.statistics.listForDocument(
      workspaceId,
      documentId,
      statisticsListLimit(options.limit),
    );
  }

  /**
   * Computes and stores statistics for one version from *server-held* content.
   *
   * This is the method the HTTP surface calls, and the distinction from
   * `calculateStatistics` is a security boundary rather than a convenience.
   * `calculateStatistics` takes a `StatisticsSource` from its caller, which is
   * right for a trusted job that has just extracted a document — but exposing
   * that shape to a route would let any member with write access POST arbitrary
   * numbers and have them stored as measured fact, in a durable row every other
   * member reads. There is no way to tell a fabricated count from a real one
   * after the fact.
   *
   * So the content is assembled here, from data the server already derived: the
   * M7.8 search chunks for text and page numbers, the M7.9 bookmark and
   * attachment counts, and the version's own manifest for page count and byte
   * size. A client can ask for a recalculation; it cannot say what the answer is.
   *
   * Image and annotation counts stay `null`: no server-side extractor records
   * them yet, and reporting zero would claim a document has none when nothing
   * ever looked.
   */
  async recalculateFromServerContent(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    versionId: string,
    options: { force?: boolean } = {},
  ): Promise<DocumentStatistics> {
    // Authorize before reading any content, so an unauthorized caller learns
    // nothing about what the document contains.
    await this.authorize(actor, workspaceId, documentId, true);
    const version = await this.requireVersion(workspaceId, documentId, versionId);

    const [chunks, bookmarkCount, attachmentCount] = await Promise.all([
      this.searchChunks.listForDocument(workspaceId, documentId, STATISTICS_LIMITS.maxSegments),
      this.bookmarks.countForDocument(workspaceId, documentId),
      this.attachments.countForDocument(workspaceId, documentId),
    ]);

    const segments = chunks.map((chunk) => ({
      pageNumber: chunk.pageNumber,
      text: chunk.text,
    }));

    return this.calculateStatistics(
      actor,
      workspaceId,
      documentId,
      versionId,
      {
        segments,
        manifestPageCount: version.manifest.pageCount,
        fileSize: version.manifest.sourceByteSize,
        bookmarkCount,
        attachmentCount,
      },
      options,
    );
  }

  /**
   * Computes and stores statistics for one version.
   *
   * Idempotent by content: recomputing the same version from the same content
   * produces the same checksum and converges on the same row. When the checksum
   * already matches and the row is ready, the stored row is returned untouched
   * rather than rewritten — a recalculation that changes nothing should not
   * churn the record or move its `calculatedAt`.
   *
   * Takes its content from the caller, so it is for trusted callers only — a
   * job that has just extracted the document, or `recalculateFromServerContent`
   * above. Never call it with a request body.
   */
  async calculateStatistics(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    versionId: string,
    source: StatisticsSource,
    options: { force?: boolean } = {},
  ): Promise<DocumentStatistics> {
    const access = await this.authorize(actor, workspaceId, documentId, true);
    const version = await this.requireVersion(workspaceId, documentId, versionId);

    const computed = computeStatistics(source);
    if (!computed.ok) {
      // A failed measurement is recorded as failed rather than as zeroes, so a
      // broken extractor is distinguishable from an empty document.
      const failed = await this.statistics.upsert({
        organizationId: access.organizationId,
        workspaceId,
        documentId,
        versionId,
        schemaVersion: STATISTICS_LIMITS.schemaVersion,
        counts: emptyCounts(),
        checksum: "",
        status: "failed",
        error: validateComparisonError(computed.reason),
        calculatedAt: null,
      });
      this.logger.warn("Statistics calculation failed", {
        workspaceId,
        documentId,
        versionId,
        reason: computed.reason,
      });
      return failed;
    }

    const checksum = statisticsChecksum(version, computed.counts);
    if (options.force !== true) {
      const existing = await this.statistics.getByVersionId(workspaceId, versionId);
      if (existing && existing.status === "ready" && existing.checksum === checksum) {
        return existing;
      }
    }

    const stored = await this.statistics.upsert({
      organizationId: access.organizationId,
      workspaceId,
      documentId,
      versionId,
      schemaVersion: STATISTICS_LIMITS.schemaVersion,
      counts: computed.counts,
      checksum,
      status: "ready",
      error: null,
      calculatedAt: this.clock(),
    });
    this.logger.info("Statistics calculated", { workspaceId, documentId, versionId });
    return stored;
  }

  // ---- comparison ----------------------------------------------------------

  /**
   * Creates a comparison operation.
   *
   * Refuses an unsupported type up front rather than accepting the request and
   * failing it later: a queued operation that can only fail wastes the user's
   * wait and reads as a transient problem rather than a missing capability.
   */
  async createComparison(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    input: { leftVersionId: unknown; rightVersionId: unknown; type: unknown },
  ): Promise<ComparisonOperation> {
    const access = await this.authorize(actor, workspaceId, documentId, true);

    if (!isComparisonType(input.type)) {
      throw new DomainError("The comparison type is not supported.");
    }
    const type = input.type;
    if (!isComparisonSupported(type)) {
      // The honest refusal. `unsupportedComparisonReason` is non-null here.
      throw new DomainError(unsupportedComparisonReason(type) ?? "Unsupported comparison.");
    }

    if (!isBoundedStatisticsId(input.leftVersionId) || !isBoundedStatisticsId(input.rightVersionId)) {
      throw new DomainError("Two valid version ids are required.");
    }
    if (input.leftVersionId === input.rightVersionId) {
      throw new DomainError("Select two different versions to compare.");
    }

    // Both must belong to this document. Resolved before anything is created, so
    // an operation never exists for a pair the actor could not access.
    const left = await this.requireVersion(workspaceId, documentId, input.leftVersionId);
    const right = await this.requireVersion(workspaceId, documentId, input.rightVersionId);

    if (type === "editor" && (left.manifest.editorStateKey === null || right.manifest.editorStateKey === null)) {
      throw new DomainError(
        "Editor comparison needs both versions to carry editor state. One of these was not saved from an editing session.",
      );
    }

    const active = await this.comparisons.countActiveForDocument(workspaceId, documentId);
    if (active >= STATISTICS_LIMITS.maxActiveComparisonsPerDocument) {
      throw new DomainError(
        `This document already has ${STATISTICS_LIMITS.maxActiveComparisonsPerDocument} comparisons in progress. Wait for one to finish.`,
      );
    }

    const operation = await this.comparisons.create({
      organizationId: access.organizationId,
      workspaceId,
      documentId,
      leftVersionId: left.id,
      rightVersionId: right.id,
      type,
      requestedById: actor.userId,
    });
    this.logger.info("Comparison created", {
      workspaceId,
      documentId,
      comparisonId: operation.id,
      type,
    });
    return operation;
  }

  /** One comparison with its result, when it produced one. */
  async getComparison(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    comparisonId: string,
  ): Promise<ComparisonView> {
    await this.authorize(actor, workspaceId, documentId);
    const operation = await this.requireComparison(workspaceId, documentId, comparisonId);
    const result =
      operation.resultId === null
        ? await this.results.getByComparisonId(workspaceId, operation.id)
        : await this.results.getById(workspaceId, operation.resultId);
    return {
      operation,
      result,
      unsupportedReason: unsupportedComparisonReason(operation.type),
    };
  }

  /** A document's comparisons, newest first. */
  async listComparisons(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    options: { limit?: number } = {},
  ): Promise<ComparisonOperation[]> {
    await this.authorize(actor, workspaceId, documentId);
    return this.comparisons.list({
      workspaceId,
      documentId,
      limit: statisticsListLimit(options.limit),
    });
  }

  private async requireComparison(
    workspaceId: string,
    documentId: string,
    comparisonId: string,
  ): Promise<ComparisonOperation> {
    if (!isBoundedStatisticsId(comparisonId)) {
      throw new DomainError("A valid comparison id is required.");
    }
    const operation = await this.comparisons.getById(workspaceId, comparisonId);
    // The document check stops a comparison id from one document being read
    // through another the actor can see.
    if (!operation || operation.documentId !== documentId) {
      throw new NotFoundError("Comparison not found.");
    }
    return operation;
  }

  /**
   * Requests cancellation.
   *
   * A request rather than an instant stop: long work observes it at its next
   * checkpoint. Reporting "cancelled" the moment the button is pressed would
   * claim the work stopped when it may still be running.
   */
  async cancelComparison(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    comparisonId: string,
  ): Promise<ComparisonOperation> {
    await this.authorize(actor, workspaceId, documentId, true);
    const operation = await this.requireComparison(workspaceId, documentId, comparisonId);

    if (isTerminalComparisonStatus(operation.status)) {
      throw new DomainError("This comparison has already finished.");
    }

    const updated = await this.comparisons.requestCancellation(
      workspaceId,
      comparisonId,
      this.clock(),
    );
    if (!updated) throw new DomainError("This comparison has already finished.");

    // A pending operation has not started, so it can be cancelled outright
    // rather than waiting for a worker that will never pick it up.
    if (updated.status === "pending") {
      const cancelled = await this.comparisons.transition(
        workspaceId,
        comparisonId,
        "pending",
        "cancelled",
        { completedAt: this.clock() },
      );
      if (cancelled) return cancelled;
    }
    return updated;
  }

  /**
   * Retries a finished comparison by creating a new operation.
   *
   * Deliberately not a reset of the old one: rewriting a terminal state would
   * erase the fact that a comparison failed or was cancelled, and that history
   * is what tells a user whether the problem is recurring.
   */
  async retryComparison(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    comparisonId: string,
  ): Promise<ComparisonOperation> {
    await this.authorize(actor, workspaceId, documentId, true);
    const original = await this.requireComparison(workspaceId, documentId, comparisonId);
    if (!isTerminalComparisonStatus(original.status)) {
      throw new DomainError("This comparison is still running.");
    }
    return this.createComparison(actor, workspaceId, documentId, {
      leftVersionId: original.leftVersionId,
      rightVersionId: original.rightVersionId,
      type: original.type,
    });
  }

  // ---- worker surface ------------------------------------------------------

  /**
   * Moves an operation into `running`.
   *
   * Returns null when the operation is not `pending` — which is exactly what
   * makes a duplicate delivery safe: the second worker to arrive finds it
   * already started and does no work.
   */
  async startComparison(
    workspaceId: string,
    comparisonId: string,
  ): Promise<ComparisonOperation | null> {
    return this.comparisons.transition(workspaceId, comparisonId, "pending", "running", {
      progress: 0,
      startedAt: this.clock(),
    });
  }

  /** Records progress. Refused once terminal. */
  async reportComparisonProgress(
    workspaceId: string,
    comparisonId: string,
    progress: number,
  ): Promise<ComparisonOperation | null> {
    const bounded = validateProgress(progress);
    if (bounded === null) throw new DomainError("Progress must be between 0 and 100.");
    return this.comparisons.reportProgress(workspaceId, comparisonId, bounded);
  }

  /**
   * Runs the comparison and records its result.
   *
   * Checks the cancellation request *before* writing anything: work that
   * finished after the user cancelled must not be delivered, or "cancel" would
   * mean "cancel, unless it happened to finish first".
   */
  async completeComparison(
    workspaceId: string,
    comparisonId: string,
    work: ComparisonWorkInput,
  ): Promise<ComparisonOperation | null> {
    const operation = await this.comparisons.getById(workspaceId, comparisonId);
    if (!operation) return null;
    if (operation.status !== "running") return null;

    if (operation.cancelRequestedAt !== null) {
      return this.comparisons.transition(workspaceId, comparisonId, "running", "cancelled", {
        completedAt: this.clock(),
      });
    }

    // The versions the operation names must be the ones being compared. A
    // mismatched pair would produce a result filed against the wrong versions.
    if (
      work.left.versionId !== operation.leftVersionId ||
      work.right.versionId !== operation.rightVersionId
    ) {
      return this.failComparison(workspaceId, comparisonId, "The compared versions did not match the request.");
    }

    const computed =
      operation.type === "textual"
        ? compareTextual(work.left, work.right)
        : compareStructural(work.left, work.right);

    const result = await this.results.create({
      organizationId: operation.organizationId,
      workspaceId,
      documentId: operation.documentId,
      comparisonId: operation.id,
      type: operation.type,
      summary: computed.summary,
      differences: computed.differences,
      checksum: comparisonChecksum(operation.leftVersionId, operation.rightVersionId, operation.type),
    });

    return this.comparisons.transition(workspaceId, comparisonId, "running", "completed", {
      progress: 100,
      resultId: result.id,
      completedAt: this.clock(),
    });
  }

  /** Records a failure with a bounded reason. */
  async failComparison(
    workspaceId: string,
    comparisonId: string,
    reason: string,
  ): Promise<ComparisonOperation | null> {
    const operation = await this.comparisons.getById(workspaceId, comparisonId);
    if (!operation) return null;
    if (isTerminalComparisonStatus(operation.status)) return null;
    if (!canTransitionComparison(operation.status, "failed")) return null;
    return this.comparisons.transition(workspaceId, comparisonId, operation.status, "failed", {
      error: validateComparisonError(reason) ?? "The comparison could not be completed.",
      completedAt: this.clock(),
    });
  }

  /**
   * Fetches a comparison result for download, after re-authorizing.
   *
   * The result is returned as structured data rather than as a storage key or a
   * signed URL: a comparison result is small and bounded by construction, so
   * there is no object to hand out, and no key to leak.
   */
  async getComparisonResult(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    comparisonId: string,
  ): Promise<ComparisonResult> {
    const view = await this.getComparison(actor, workspaceId, documentId, comparisonId);
    if (view.operation.status !== "completed" || view.result === null) {
      throw new DomainError("This comparison has no result to download.");
    }
    return view.result;
  }
}

/**
 * Domain separator between hashed fields.
 *
 * A NUL cannot occur in any of the ids, checksums or type names being hashed, so
 * concatenation stays unambiguous: without it, ("ab", "c") and ("a", "bc") would
 * digest identically and two different version pairs could share a checksum.
 * Built with `String.fromCharCode` so the source file stays plain UTF-8 text and
 * never carries a raw NUL byte.
 */
const HASH_SEPARATOR = String.fromCharCode(0);

/**
 * A checksum over the version and the measured numbers.
 *
 * Binds both: the same counts measured against a different version are a
 * different fact, and the same version measured to different counts means the
 * content changed underneath. Either way the cached row is stale.
 */
function statisticsChecksum(version: DocumentVersion, counts: StatisticsCounts): string {
  return createHash("sha256")
    .update(version.id)
    .update(HASH_SEPARATOR)
    .update(version.checksum)
    .update(HASH_SEPARATOR)
    .update(serializeCounts(counts))
    .digest("hex");
}

/** A checksum identifying which two versions a result describes. */
function comparisonChecksum(left: string, right: string, type: ComparisonType): string {
  return createHash("sha256")
    .update(left)
    .update(HASH_SEPARATOR)
    .update(right)
    .update(HASH_SEPARATOR)
    .update(type)
    .digest("hex");
}
