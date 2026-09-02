import type { ILogger } from "@/src/application/ports/Logger";
import type { IQueue } from "@/src/application/ports/queue/Queue";
import type { IWorker, JobContext, JobHandlerResult } from "@/src/application/ports/queue/Worker";
import type { Job } from "@/src/domain/entities/Job";
import type { DocumentIngestionService } from "./DocumentIngestionService";

/** The queue job type this handler claims. */
export const DOCUMENT_INGESTION_JOB_TYPE = "document.ingestion";

export interface DocumentIngestionJobPayload {
  organizationId: string;
  workspaceId: string;
  documentId: string;
  ingestionId: string;
}

/**
 * Whether a payload is an ingestion job this handler can act on.
 *
 * The payload carries only ids. There is no storage key, checksum or size here
 * on purpose: the service re-reads all of those from tenant-scoped repositories,
 * so a payload that was tampered with or replayed from an older deployment
 * cannot redirect a version at bytes the document does not own.
 */
export function isDocumentIngestionJobPayload(
  payload: unknown,
): payload is DocumentIngestionJobPayload {
  if (payload === null || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  const nonEmpty = (value: unknown): boolean => typeof value === "string" && value !== "";
  return (
    nonEmpty(p.organizationId) &&
    nonEmpty(p.workspaceId) &&
    nonEmpty(p.documentId) &&
    nonEmpty(p.ingestionId)
  );
}

/**
 * Delivers upload ingestion to the M2 queue.
 *
 * This is the delivery half only: every state transition and every validation
 * lives in {@link DocumentIngestionService}, which the one-time repair path also
 * calls. The handler's whole job is to claim a job, hand the ids to the service,
 * and translate the outcome into a queue result.
 *
 * A duplicate delivery is not an error. At-least-once is the queue's normal
 * behaviour, and the service converges — it adopts an existing import version
 * rather than cutting a second one — so a replay reports `already-complete`
 * instead of failing work that actually succeeded.
 */
export class DocumentIngestionJobHandler {
  constructor(
    private readonly logger: ILogger,
    private readonly ingestion: DocumentIngestionService,
  ) {}

  /** Registers this handler on a worker. */
  register(worker: IWorker): void {
    worker.register(DOCUMENT_INGESTION_JOB_TYPE, (job, ctx) => this.handle(job, ctx));
  }

  /** Enqueues a durable job for an upload that was just accepted. */
  static async enqueue(
    queue: IQueue,
    payload: DocumentIngestionJobPayload,
  ): Promise<{ id: string }> {
    return queue.enqueue({
      type: DOCUMENT_INGESTION_JOB_TYPE,
      payload: payload satisfies DocumentIngestionJobPayload,
    });
  }

  async handle(job: Job, ctx: JobContext): Promise<JobHandlerResult> {
    const payload = job.payload;
    if (!isDocumentIngestionJobPayload(payload)) {
      // Malformed payloads are not retried: another attempt produces the same
      // result and only occupies the queue.
      this.logger.warn("Ingestion job payload was not usable", { jobId: job.id });
      return { result: { status: "rejected" } };
    }

    const { workspaceId, ingestionId } = payload;
    await ctx.progress(10, "Reading upload");

    const outcome = await this.ingestion.processIngestion(workspaceId, ingestionId);

    if (outcome.status === "failed") {
      await ctx.progress(100);
      // The service already recorded the failure on the ingestion row, and the
      // cause is a property of the bytes rather than a transient fault — so this
      // returns instead of throwing. Retrying would fail identically.
      this.logger.warn("Ingestion job completed with a failed ingestion", {
        ingestionId,
        reason: outcome.reason,
      });
      return { result: { status: "failed", reason: outcome.reason } };
    }

    if (outcome.status === "skipped") {
      await ctx.progress(100);
      return { result: { status: "skipped", detail: outcome.detail } };
    }

    await ctx.progress(100);
    return {
      result: {
        status: outcome.created ? "complete" : "already-complete",
        versionId: outcome.version.id,
        versionNumber: outcome.version.versionNumber,
      },
    };
  }
}
