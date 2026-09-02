import type { ILogger } from "@/src/application/ports/Logger";
import type { IQueue } from "@/src/application/ports/queue/Queue";
import type { IWorker, JobContext, JobHandlerResult } from "@/src/application/ports/queue/Worker";
import type { Job } from "@/src/domain/entities/Job";
import type { StatisticsService, ComparisonWorkInput } from "./StatisticsService";

/** The queue job type this handler claims. */
export const COMPARISON_JOB_TYPE = "document.comparison";

export interface ComparisonJobPayload {
  workspaceId: string;
  comparisonId: string;
}

/**
 * Resolves the content of the two versions a comparison names.
 *
 * Injected rather than reached for directly: the handler's job is the queue
 * contract — claim, run, report, converge — and the content path differs between
 * a local disk and object storage.
 */
export type ComparisonContentResolver = (
  workspaceId: string,
  comparisonId: string,
) => Promise<ComparisonWorkInput>;

/** Whether a payload is a comparison job this handler can act on. */
export function isComparisonJobPayload(payload: unknown): payload is ComparisonJobPayload {
  if (payload === null || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.workspaceId === "string" &&
    p.workspaceId !== "" &&
    typeof p.comparisonId === "string" &&
    p.comparisonId !== ""
  );
}

/**
 * Connects the M7.11 comparison worker surface to the M2 queue.
 *
 * The M7.11 service already owns every state transition and refuses anything the
 * comparison state machine disallows. This adds the *delivery* half: enqueueing
 * a durable job when a comparison is created, and draining it in a handler that
 * calls the same trusted methods.
 *
 * Idempotency comes from the service, not from this handler. `startComparison`
 * transitions `pending → running` and returns null when the operation has already
 * moved, so a duplicate delivery finds the work claimed and stops. That is why a
 * second delivery is *not* an error here: at-least-once delivery is the queue's
 * normal behaviour, and treating a duplicate as a failure would fail work that
 * actually succeeded.
 *
 * The handler never reports a comparison completed on its own authority. It
 * hands the computed content to `completeComparison`, which re-checks the
 * cancellation request and the version pair before recording anything.
 */
export class ComparisonJobHandler {
  constructor(
    private readonly logger: ILogger,
    private readonly statistics: StatisticsService,
    private readonly resolveContent: ComparisonContentResolver,
  ) {}

  /** Registers this handler on a worker. */
  register(worker: IWorker): void {
    worker.register(COMPARISON_JOB_TYPE, (job, ctx) => this.handle(job, ctx));
  }

  /** Enqueues a durable job for a comparison that was just created. */
  static async enqueue(
    queue: IQueue,
    workspaceId: string,
    comparisonId: string,
  ): Promise<{ id: string }> {
    return queue.enqueue({
      type: COMPARISON_JOB_TYPE,
      payload: { workspaceId, comparisonId } satisfies ComparisonJobPayload,
    });
  }

  async handle(job: Job, ctx: JobContext): Promise<JobHandlerResult> {
    const payload = job.payload;
    if (!isComparisonJobPayload(payload)) {
      // Malformed payloads are not retried: another attempt produces the same
      // result and only occupies the queue.
      this.logger.warn("Comparison job payload was not usable", { jobId: job.id });
      return { result: { status: "rejected" } };
    }
    const { workspaceId, comparisonId } = payload;

    const claimed = await this.statistics.startComparison(workspaceId, comparisonId);
    if (claimed === null) {
      // Already claimed, already finished, or gone. A duplicate delivery lands
      // here and converges rather than reporting a failure.
      this.logger.debug("Comparison job was already claimed", { comparisonId });
      return { result: { status: "already-claimed" } };
    }

    try {
      await this.statistics.reportComparisonProgress(workspaceId, comparisonId, 10);
      await ctx.progress(10, "Reading versions");

      const work = await this.resolveContent(workspaceId, comparisonId);

      if (ctx.isCancelled()) {
        // The service records the cancellation; the handler does not decide it.
        await this.statistics.failComparison(
          workspaceId,
          comparisonId,
          "The comparison was cancelled.",
        );
        return { result: { status: "cancelled" } };
      }

      await this.statistics.reportComparisonProgress(workspaceId, comparisonId, 60);
      await ctx.progress(60, "Comparing");

      // completeComparison re-checks cancellation and the version pair before
      // writing, so a result is never filed against versions the operation did
      // not name.
      const completed = await this.statistics.completeComparison(workspaceId, comparisonId, work);
      await ctx.progress(100);

      return { result: { status: completed?.status ?? "unchanged" } };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "The comparison could not be completed.";
      await this.statistics.failComparison(workspaceId, comparisonId, reason);
      // Rethrown so the worker applies its own retry policy — the durable job
      // and the comparison row both record the failure.
      throw error;
    }
  }
}
