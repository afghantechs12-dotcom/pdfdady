import type { Job } from "@/src/domain/entities/Job";
import type { IJobRepository } from "@/src/application/ports/repositories/JobRepository";
import type { IQueue } from "@/src/application/ports/queue/Queue";
import type { ILogger } from "@/src/application/ports/Logger";
import { safeMessageFor } from "@/src/domain/jobs/jobErrors";
import type {
  ProcessingOutcomeResult,
  UsageMeteringService,
} from "./UsageMeteringService";
import type { ProcessingJobPayload } from "./ProcessingJobService";
import { deliverQueuedJob } from "./queueHandoff";

/**
 * A positive millisecond count from the environment, or the fallback.
 *
 * `Number(process.env.X ?? d)` is NaN for anything non-numeric — "10m", a typo,
 * an empty string — and a NaN threshold is the worst failure available here: the
 * cutoff becomes an Invalid Date, which Prisma rejects outright and an in-memory
 * comparison answers false for every row. Recovery would then be silently OFF on
 * exactly the deployment whose operator was trying to tune it. Same guard shape
 * as `lib/server/concurrency.ts`, for the same reason.
 */
function positiveMs(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return raw !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * How long a `running` job may go without a write before it is presumed abandoned.
 *
 * **This number must stay comfortably above the longest processor execution
 * ceiling.** `updatedAt` is the lease, and a processor that runs for minutes
 * without reporting a stage refreshes nothing while it works — so a threshold
 * below its ceiling would reap jobs whose worker is alive and busy. The longest
 * ceiling today is `COMPRESS_PDF_TIMEOUT_MS` (180s, operator-overridable), and
 * ten minutes leaves more than triple that as slack.
 *
 * A premature recovery is not a correctness failure, only a wasted run: the
 * abandoned worker's `completeJob` is a guarded transition, and `queued →
 * completed` is not a legal move, so its output is refused and deleted rather
 * than published twice. The slack exists to avoid burning the CPU, not to hold
 * the invariant.
 */
export const DEFAULT_STALE_AFTER_MS = positiveMs(
  process.env.WORKER_STALE_JOB_AFTER_MS,
  10 * 60_000,
);

/** How often the reaper sweeps. Independent of the stale threshold. */
export const STUCK_JOB_SWEEP_MS = positiveMs(process.env.WORKER_STALE_JOB_SWEEP_MS, 60_000);

/** Rows examined per sweep. Bounded so a large backlog degrades into passes. */
export const DEFAULT_RECOVERY_LIMIT = 25;

export interface StuckJobRecoverySummary {
  examined: number;
  /** Returned to `queued` for another attempt. */
  requeued: number;
  /** Terminated `failed` because the attempt budget was spent. */
  failed: number;
  /** Terminated `cancelled` because the user had asked to cancel. */
  cancelled: number;
  /** Lost the race to another recoverer, or moved on its own meanwhile. */
  skipped: number;
}

export interface StuckJobRecoveryDeps {
  jobRepo: IJobRepository;
  queue: IQueue;
  logger: ILogger;
  /**
   * Settles the allowance a terminally-abandoned job was holding. Optional and
   * fail-open, like every other metering seam: recovery must work in a
   * deployment with no metering, and a metering error must never stop a stuck
   * job from being unstuck.
   */
  metering?: UsageMeteringService;
  staleAfterMs?: number;
  now?: () => Date;
}

/** The internal diagnostic written to the row. Never shown to a user. */
const RECOVERY_DIAGNOSTIC =
  "Recovered by the stuck-job sweep: the worker holding this job stopped writing to it.";

/**
 * Returns abandoned jobs to the queue, or terminates them when their budget is
 * spent.
 *
 * ## Why this exists
 *
 * A worker that dies between claiming a job and recording its outcome leaves the
 * row in `running` forever. Nothing else in the system moves it: `running` has no
 * ordinary edge back to `queued`, and the user-facing retry command refuses
 * anything that is not `failed` or `cancelled`. So before this service, a killed
 * container (a deploy, an OOM, a `kill -9`) meant a job that showed "processing"
 * until someone ran SQL by hand.
 *
 * ## Why it is safe to run several of these at once
 *
 * The claim is `IJobRepository.transition(..., { recover: true })` — the same
 * guarded compare-and-swap the worker uses to claim a queued job. Two sweeps that
 * both see the same stale row contend on one conditional write, so exactly one
 * wins and the other counts a `skipped`. There is no new lock, no leader
 * election, and no distributed scheduler here, because the write that must be
 * atomic already is.
 *
 * ## What it will never do
 *
 *  - **Resurrect a terminal job.** It only ever asks for `running → queued`, and
 *    `RECOVERABLE_FROM` contains only `running`. A `completed`, `failed`,
 *    `cancelled` or `expired` row is not even a candidate — `listStaleRunning`
 *    does not return it, and the transition would refuse it if it did.
 *  - **Resurrect a cancelled job.** A job whose user asked to cancel while it ran
 *    carries `cancelRequestedAt`. Requeueing that would restart work the user
 *    stopped, in a fresh process whose in-memory cancellation set is empty — so
 *    the recovery *completes* the cancellation instead.
 *  - **Loop forever.** Each recovery spends an attempt. A job that reliably kills
 *    its worker therefore exhausts its budget and lands in `failed`, rather than
 *    cycling between `running` and `queued` for the life of the deployment.
 *  - **Charge the customer twice.** It creates no reservation — the one the
 *    submission took stays on the same row, in the same payload. The only
 *    metering call it makes is the once-per-job settlement, whose claim is
 *    durable and atomic, so it cannot double-refund either.
 */
export class StuckJobRecoveryService {
  private readonly jobRepo: IJobRepository;
  private readonly queue: IQueue;
  private readonly logger: ILogger;
  private readonly metering?: UsageMeteringService;
  private readonly staleAfterMs: number;
  private readonly now: () => Date;

  constructor(deps: StuckJobRecoveryDeps) {
    this.jobRepo = deps.jobRepo;
    this.queue = deps.queue;
    this.logger = deps.logger;
    this.metering = deps.metering;
    this.staleAfterMs = deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * One bounded sweep. Oldest lease first, at most `limit` rows.
   *
   * Never throws: one unrecoverable row must not abort the pass, because the
   * remaining stuck jobs are independent and equally stuck.
   */
  async recoverStale(limit = DEFAULT_RECOVERY_LIMIT): Promise<StuckJobRecoverySummary> {
    const summary: StuckJobRecoverySummary = {
      examined: 0,
      requeued: 0,
      failed: 0,
      cancelled: 0,
      skipped: 0,
    };

    const cutoff = new Date(this.now().getTime() - this.staleAfterMs);
    const stale = await this.jobRepo.listStaleRunning(cutoff, limit);

    for (const job of stale) {
      summary.examined += 1;
      try {
        const outcome = await this.recoverOne(job);
        summary[outcome] += 1;
      } catch (err) {
        summary.skipped += 1;
        // Sanitized: the job id, its type and its tool. No payload, no
        // document name, no storage key — this text reaches log sinks.
        this.logger.error("Stuck-job recovery failed for one job", {
          jobId: job.id,
          type: job.type,
          toolSlug: job.toolSlug,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (summary.examined > 0) {
      this.logger.info("Recovered stuck jobs", { ...summary });
    }
    return summary;
  }

  /**
   * Decides and applies the outcome for one stale job.
   *
   * The attempt the dead worker was running is charged here, not merely
   * observed: it consumed real CPU and it is the reason the budget must shrink.
   * `attempts` on a `running` row still holds the count of *finished* attempts
   * (the claim does not touch it), so the abandoned one is `attempts + 1`.
   */
  private async recoverOne(
    job: Job,
  ): Promise<"requeued" | "failed" | "cancelled" | "skipped"> {
    const attempt = job.attempts + 1;
    const at = this.now();

    // The user asked to stop this job and the worker died before it could
    // confirm. Finishing the cancellation is the honest outcome; requeueing
    // would restart work that was already called off.
    if (job.cancelRequestedAt) {
      const cancelled = await this.jobRepo.transition(job.id, "cancelled", {
        attempts: attempt,
        errorCategory: "cancelled",
        safeErrorMessage: safeMessageFor("cancelled"),
        finishedAt: at,
        error: RECOVERY_DIAGNOSTIC,
      });
      if (!cancelled) return "skipped";
      await this.settle(job, "cancelled", attempt, at);
      return "cancelled";
    }

    // Budget spent. Terminating rather than requeueing is what stops a job that
    // reliably kills its worker from cycling forever.
    if (attempt >= job.maxAttempts) {
      const failed = await this.jobRepo.transition(job.id, "failed", {
        attempts: attempt,
        errorCategory: "internal_error",
        safeErrorMessage: safeMessageFor("internal_error"),
        finishedAt: at,
        error: RECOVERY_DIAGNOSTIC,
      });
      if (!failed) return "skipped";
      await this.settle(job, "failure", attempt, at);
      return "failed";
    }

    // Back to the queue for a fresh attempt, with the abandoned one charged.
    // `startedAt`/`finishedAt` are cleared and the failure fields with them: a
    // `queued` row must not describe itself with a leftover error message the
    // status view would show the user.
    const requeued = await this.jobRepo.transition(
      job.id,
      "queued",
      {
        attempts: attempt,
        startedAt: null,
        finishedAt: null,
        queuedAt: at,
        progressStage: "queued",
        errorCategory: null,
        safeErrorMessage: null,
        error: RECOVERY_DIAGNOSTIC,
      },
      { recover: true },
    );
    if (!requeued) return "skipped";

    // The status write is not the whole requeue. Adapters that hold their own
    // list of ready ids (the in-memory and Redis queues) need the id pushed
    // back, and the table-as-queue adapter needs its in-flight entry cleared
    // before it will serve the id again. Skipping this is how a job ends up
    // `queued` forever with nothing ever pulling it — the exact seam that broke
    // `retryJob` once already.
    //
    // Shared with the request-path handoffs (`queueJob`, `retryJob`), because a
    // rollback that exists in one of the three and not the others is a strand
    // waiting for whichever path was forgotten. What is specific to *this* path
    // is only where the row goes back to: `running`, with the lease, the
    // uncharged attempt and the stage it was reporting restored — which makes it
    // exactly the stale row this sweep is built to find, so the existing pass
    // retries the handoff with no new machinery. Re-detection costs one more
    // stale interval because the revert refreshes `updatedAt`; that is the same
    // wait any abandoned job already serves, and it is bounded.
    await deliverQueuedJob({ jobRepo: this.jobRepo, queue: this.queue, logger: this.logger }, job.id, {
      status: "running",
      patch: {
        attempts: job.attempts,
        startedAt: job.startedAt,
        queuedAt: job.queuedAt,
        progressStage: job.progressStage,
      },
    });
    // The attempt that died still burned CPU, and the process that burned it was
    // killed before it could say so. Recording it here is what keeps compute
    // telemetry per-attempt across a crash; `willRetry` is the designed seam for
    // exactly this and settles nothing, so the customer charge is untouched.
    await this.settle(job, "failure", attempt, at, true);
    return "requeued";
  }

  /**
   * Hands a terminally-abandoned job's outcome to metering.
   *
   * `willRetry` decides whether this is a settlement or only telemetry: true
   * records the attempt and returns without claiming, so a requeued job keeps its
   * allowance held; false is the terminal path. The settlement claim is once per
   * job and durable, so a dying worker that already settled makes this a no-op
   * rather than a second refund; and no reservation is created here either way,
   * so the customer charge stays at one per logical job.
   */
  private async settle(
    job: Job,
    result: ProcessingOutcomeResult,
    attempt: number,
    at: Date,
    willRetry = false,
  ): Promise<void> {
    if (!this.metering) return;
    const payload = (job.payload ?? {}) as Partial<ProcessingJobPayload>;
    const toolSlug = job.toolSlug ?? payload.toolSlug ?? null;
    if (!toolSlug) return;

    const reservedAt = payload.usage ? new Date(payload.usage.reservedAt) : null;
    try {
      await this.metering.settleProcessingOutcome({
        jobId: job.id,
        actor: {
          ownerType: job.ownerType ?? "system",
          ownerId: job.ownerId ?? "system",
        },
        toolSlug,
        executionMode: "remote_job",
        result,
        attempt,
        willRetry,
        inputBytes: job.inputBytes,
        outputBytes: null,
        pageCount: null,
        durationMs: null,
        errorCategory: result === "cancelled" ? "cancelled" : "internal_error",
        reservation:
          reservedAt && !Number.isNaN(reservedAt.getTime()) ? { reservedAt } : null,
        at,
      });
    } catch (err) {
      this.logger.warn("Usage settlement failed during stuck-job recovery", {
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Runs the sweep now and on a timer, returning a stop function.
 *
 * Both the standalone worker and the in-process worker need exactly this, and a
 * single implementation is the reason the startup pass and the recurring pass
 * cannot drift apart. The timer is unref'd so it never holds a process — or a
 * test runner — open on its own.
 */
export function startStuckJobRecovery(
  service: StuckJobRecoveryService,
  logger: ILogger,
  intervalMs = STUCK_JOB_SWEEP_MS,
): () => void {
  const tick = (): void => {
    void service.recoverStale().catch((err) => {
      // A failed sweep is not fatal: recovery is recovery, not a precondition
      // for serving traffic, and the next pass sees the same rows.
      logger.warn("Stuck-job sweep failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
