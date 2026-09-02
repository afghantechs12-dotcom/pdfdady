import type { Job } from "@/src/domain/entities/Job";
import type { IQueue, EnqueueInput } from "@/src/application/ports/queue/Queue";
import type { IJobRepository } from "@/src/application/ports/repositories/JobRepository";
import type { ILogger } from "@/src/application/ports/Logger";

export interface DatabaseQueueOptions {
  /**
   * Job types this queue will serve. A worker must only be handed types it has a
   * handler for: the generic worker fails a job it cannot dispatch, so an
   * unfiltered poll would let a processing worker destroy every ingestion job it
   * happened to see. Empty/omitted means "all types" (single-worker deployments).
   */
  types?: readonly string[];
  /** Gap between polls while the queue is empty. */
  pollMs?: number;
  /** How long a just-served id is withheld from a second `pull`. */
  inflightTtlMs?: number;
}

const DEFAULT_POLL_MS = 500;
const DEFAULT_INFLIGHT_TTL_MS = 30_000;

/**
 * IQueue backed by the `jobs` table itself: "queued" *is* the queue.
 *
 * This exists so `npm run worker` runs as a genuinely separate OS process
 * against the default SQLite setup. The in-memory queue cannot do that — its
 * array lives in the web process's heap, so a job enqueued by a request would be
 * invisible to a worker in another process. Redis solves it too, and stays the
 * recommended multi-instance path, but requiring an extra service before a
 * separate worker can exist at all would push every developer back into
 * in-request processing, which is the thing this phase is removing.
 *
 * It introduces no new storage: no new table, no new column, no schema change.
 * The queue is a *view* over rows the JobRepository already writes.
 *
 * **Correctness rests on the claim, not on the poll.** `pull` does not remove
 * anything; it reports candidates. Two workers can therefore return the same job
 * from `pull`, and that is safe because the worker's next act is the guarded
 * compare-and-swap into `running` (`IJobRepository.transition`), which exactly
 * one caller can win. The loser logs a refused claim and polls again. The
 * in-flight set below is only a de-duplication courtesy that stops a single
 * process from burning CPU re-serving an id it is already working on — remove it
 * and the queue is still correct, just noisier.
 *
 * Trade-offs, stated rather than hidden:
 *  - Latency is bounded by `pollMs` (~500ms), not push-instant. For jobs that
 *    take seconds to minutes this is irrelevant; for sub-second dispatch use the
 *    Redis adapter.
 *  - Each poll is one indexed `SELECT ... WHERE status = 'queued'`. Cheap, but it
 *    is a constant trickle of queries — the reason this is the *dev/single-node*
 *    default and Redis is the production path.
 */
export class DatabaseQueue implements IQueue {
  private readonly types: readonly string[];
  private readonly pollMs: number;
  private readonly inflightTtlMs: number;
  /** jobId → epoch ms after which the id may be served again. */
  private readonly inflight = new Map<string, number>();

  constructor(
    private readonly jobRepo: IJobRepository,
    private readonly logger: ILogger,
    options: DatabaseQueueOptions = {},
  ) {
    this.types = options.types ?? [];
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.inflightTtlMs = options.inflightTtlMs ?? DEFAULT_INFLIGHT_TTL_MS;
  }

  async enqueue(input: EnqueueInput): Promise<Job> {
    const job = await this.jobRepo.create({
      type: input.type,
      payload: input.payload,
      maxAttempts: input.maxAttempts,
      // Ownership is part of creating the record, not a later patch: a row that
      // exists unowned for even a moment is a row an ownership check must deny.
      ownerType: input.ownerType ?? null,
      ownerId: input.ownerId ?? null,
      workspaceId: input.workspaceId ?? null,
      toolSlug: input.toolSlug ?? null,
    });
    this.logger.debug("Job enqueued", { jobId: job.id, type: job.type });
    return job;
  }

  async pull(timeoutMs = 1_000): Promise<Job | null> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const candidate = await this.next();
      if (candidate) return candidate;
      if (Date.now() >= deadline) return null;
      await sleep(Math.min(this.pollMs, Math.max(0, deadline - Date.now())));
    }
  }

  /**
   * No-op by design: a requeue is expressed by the job's status returning to
   * `queued`, which every caller of this method has already done through the
   * repository. There is no separate list to push onto — that is the whole point
   * of using the table as the queue, and it means a requeue cannot drift out of
   * sync with the row.
   */
  async requeue(jobId: string): Promise<void> {
    this.inflight.delete(jobId);
    this.logger.debug("Job requeued", { jobId });
  }

  private async next(): Promise<Job | null> {
    const now = Date.now();
    for (const [id, until] of this.inflight) {
      if (until <= now) this.inflight.delete(id);
    }

    // Over-fetch relative to what we return: the head of the queue may be ids
    // this process is already running, and a `take: 1` would then report an
    // empty queue while work waited behind it.
    const queued = await this.jobRepo.listByStatus("queued", 25);
    for (const job of queued) {
      if (this.types.length && !this.types.includes(job.type)) continue;
      if (this.inflight.has(job.id)) continue;
      this.inflight.set(job.id, now + this.inflightTtlMs);
      return job;
    }
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
