/**
 * Standalone processing worker — `npm run worker`.
 *
 * ## What it is
 *
 * A separate OS process that drains `processing` jobs from the shared queue and
 * runs them through the processor registry. It shares the application's DI
 * container, repositories and storage adapters; the only thing it does not share
 * is the Next.js request lifecycle, which is the entire point. Nothing here is
 * reachable over HTTP.
 *
 * ## Lifecycle
 *
 *  1. **Boot.** Resolve the queue, worker, and job service from the container.
 *     Queue provider is config-driven: Redis when `REDIS_URL` is set, otherwise
 *     `DatabaseQueue` — the `jobs` table polled directly, because the in-memory
 *     queue's array lives in whichever process created it and would be invisible
 *     here.
 *  2. **Register.** Exactly one job type, `processing`, via the same shared
 *     function the web process uses. Types this process has no handler for are
 *     filtered out at the queue, so it cannot fail another worker's jobs.
 *  3. **Drain.** `worker.start()` loops: pull → claim → run → record. The claim
 *     is a guarded compare-and-swap, so running several copies of this process is
 *     safe: they may pull the same id, but only one can move it to `running`.
 *  4. **Sweep.** Every `EXPIRY_SWEEP_MS`, expire jobs past their `expiresAt` so
 *     completed outputs stop being downloadable when their retention window ends.
 *  5. **Recover.** Every `WORKER_STALE_JOB_SWEEP_MS`, and once at boot, jobs left
 *     `running` by a worker that stopped writing to them are returned to the
 *     queue. A restart is exactly when such rows exist, which is why the first
 *     pass is immediate.
 *  6. **Shutdown.** `SIGINT`/`SIGTERM` stop the drain loop and then WAIT for
 *     in-flight handlers, polling until the count reaches zero or
 *     `SHUTDOWN_GRACE_MS` elapses; then the process exits. Bounded in both
 *     directions: an idle worker exits at once rather than sleeping out the
 *     window, and a wedged handler cannot hold the process open past the
 *     deadline. Anything still running at the deadline is abandoned deliberately
 *     — and abandoned jobs are what the recovery sweep above exists to reclaim.
 *
 * ## Failure path
 *
 *  - **A job throws.** The handler classifies it, records a category and a
 *    user-safe message, and either schedules another attempt (retryable class,
 *    budget remaining) or leaves the job `failed` with the user's Retry button
 *    live. The worker slot is released either way.
 *  - **A job hangs.** Each processor declares its own execution ceiling; the
 *    handler aborts at that ceiling and the abort reaches the subprocess as a
 *    kill. A wedged Ghostscript cannot hold a slot forever.
 *  - **This process dies mid-job.** The job stays `running`, but only until a
 *    sweep notices that nothing has written to it for `WORKER_STALE_JOB_AFTER_MS`
 *    — then it is returned to `queued` with the abandoned attempt charged, and
 *    any worker (this one after a restart, or a sibling) picks it up. No operator
 *    action, and no schema change: `updatedAt` is the lease, refreshed by the
 *    claim and by every progress write. A job whose crash is reproducible
 *    exhausts its attempt budget and lands in `failed` rather than cycling.
 *  - **The queue provider is unreachable.** Boot fails loudly with a non-zero
 *    exit so a supervisor restarts it, rather than idling as a healthy-looking
 *    process that drains nothing.
 */
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { IWorker } from "@/src/application/ports/queue/Worker";
import type { IQueue } from "@/src/application/ports/queue/Queue";
import type { IJobRepository } from "@/src/application/ports/repositories/JobRepository";
import type { IJobEvents } from "@/src/application/ports/queue/JobEvents";
import type { ILogger } from "@/src/application/ports/Logger";
import { getConfig } from "@/src/infrastructure/config/env";
import { DatabaseQueue } from "@/src/infrastructure/queue/DatabaseQueue";
import { InMemoryWorker } from "@/src/infrastructure/queue/InMemoryWorker";
import {
  ProcessingJobService,
  PROCESSING_JOB_TYPE,
} from "@/src/application/services/ProcessingJobService";
import { registerProcessingHandler } from "@/src/infrastructure/jobs/processingBootstrap";
import {
  StuckJobRecoveryService,
  startStuckJobRecovery,
} from "@/src/application/services/StuckJobRecoveryService";
import type { UsageMeteringService } from "@/src/application/services/UsageMeteringService";

/**
 * A positive number from the environment, or the fallback.
 *
 * Every one of these three fails badly as NaN and none of them fails loudly: a
 * NaN grace period makes `Date.now() < deadline` false on the first check, so the
 * drain loop exits immediately and the shutdown kills in-flight handlers — the
 * exact defect the bounded drain replaced, reintroduced by a typo in an env var.
 * Same guard shape as `lib/server/concurrency.ts`.
 */
function positiveEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return raw !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const EXPIRY_SWEEP_MS = positiveEnv(process.env.PROCESSING_EXPIRY_SWEEP_MS, 5 * 60_000);
const SHUTDOWN_GRACE_MS = positiveEnv(process.env.WORKER_SHUTDOWN_GRACE_MS, 20_000);
const CONCURRENCY = Math.max(1, Math.floor(positiveEnv(process.env.WORKER_CONCURRENCY, 2)));

/**
 * Expires jobs whose retention window has closed.
 *
 * Runs here rather than in the web process because it is periodic background
 * work — exactly the class of thing this phase is moving out of request
 * handlers. Bounded per pass so a large backlog degrades into several passes
 * instead of one long transaction.
 */
async function sweepExpired(
  jobRepo: IJobRepository,
  jobs: ProcessingJobService,
  logger: ILogger,
): Promise<void> {
  try {
    const due = await jobRepo.listExpirable(new Date(), 100);
    let expired = 0;
    for (const job of due) {
      if (await jobs.expireJob(job.id)) expired++;
    }
    if (expired) logger.info("Expired processing jobs", { count: expired });
  } catch (err) {
    // A failed sweep must not kill the worker; outputs are purged next pass.
    logger.warn("Expiry sweep failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function runProcessingWorker(): Promise<void> {
  const logger = appContainer.resolve<ILogger>(Tokens.Logger);
  const jobRepo = appContainer.resolve<IJobRepository>(Tokens.JobRepository);
  const cfg = getConfig();

  // Redis when configured — the multi-instance production path, with real
  // blocking pops. Otherwise the table-as-queue adapter, restricted to the one
  // type this process can handle so it never touches ingestion or retention
  // jobs belonging to the web process's worker.
  let queue: IQueue;
  let worker: IWorker;
  if (cfg.queue.redisUrl) {
    queue = appContainer.resolve<IQueue>(Tokens.Queue);
    worker = appContainer.resolve<IWorker>(Tokens.Worker);
    logger.info("Processing worker using Redis queue");
  } else {
    queue = new DatabaseQueue(jobRepo, logger, { types: [PROCESSING_JOB_TYPE] });
    worker = new InMemoryWorker(queue, jobRepo, logger, {
      events: appContainer.resolve<IJobEvents>(Tokens.JobEvents),
      concurrency: CONCURRENCY,
    });
    logger.info("Processing worker using database queue", {
      note: "single-node; set REDIS_URL for multi-instance dispatch",
    });
  }

  const jobs = appContainer.resolve<ProcessingJobService>(Tokens.ProcessingJobService);
  registerProcessingHandler(worker);
  worker.start();
  logger.info("Processing worker started", {
    type: PROCESSING_JOB_TYPE,
    concurrency: CONCURRENCY,
    pid: process.pid,
  });

  void sweepExpired(jobRepo, jobs, logger);
  const sweepTimer = setInterval(() => {
    void sweepExpired(jobRepo, jobs, logger);
  }, EXPIRY_SWEEP_MS);

  // Constructed here rather than resolved from the container, because the queue
  // matters: in the non-Redis branch above this process drains a DatabaseQueue it
  // built itself, while `Tokens.Queue` is the web process's in-memory adapter.
  // Requeueing onto the wrong adapter would leave the row `queued` with nothing
  // pulling it — recovery that reports success and delivers none.
  const stopRecovery = startStuckJobRecovery(
    new StuckJobRecoveryService({
      jobRepo,
      queue,
      logger,
      metering: appContainer.resolve<UsageMeteringService>(Tokens.UsageMeteringService),
    }),
    logger,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Processing worker shutting down", { signal });
    clearInterval(sweepTimer);
    stopRecovery();
    // `stop()` ends the pull loop, so no further job is claimed — but it does not
    // touch handlers already running. Wait for those: each needs to write its
    // terminal status and remove its temp directory, and killing one mid-write is
    // how a deploy strands a job.
    worker.stop();
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (worker.activeCount > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (worker.activeCount > 0) {
      // Deliberately abandoned rather than waited on forever: a supervisor that
      // is told to stop will SIGKILL us regardless, and a shutdown that can hang
      // is worse than one that gives up on schedule. These rows are exactly what
      // the stale-job sweep reclaims.
      logger.warn("Shutdown grace expired with work in flight", {
        active: worker.activeCount,
        graceMs: SHUTDOWN_GRACE_MS,
        note: "abandoned jobs are recovered by the stale-job sweep",
      });
    }
    logger.info("Processing worker stopped");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // An unhandled rejection in a worker is a bug, not a routine event. Log it and
  // keep draining: one malformed job must not take the whole worker down.
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection in worker", { error: String(reason) });
  });

  // Hold the event loop open. The worker's own drain loop keeps it alive, but an
  // explicit keepalive makes that independent of adapter internals.
  await new Promise<void>(() => {});
  void queue;
}

// Only self-start when executed directly, so tests can import the module.
if (process.env.WORKER_NO_AUTOSTART !== "1") {
  runProcessingWorker().catch((err) => {
    // Boot failure must be loud and non-zero: a supervisor should restart this,
    // not leave a process that looks alive but drains nothing.
    console.error("[worker] failed to start:", err);
    process.exit(1);
  });
}
