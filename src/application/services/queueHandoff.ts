import type { JobStatus } from "@/src/domain/entities/Job";
import type {
  IJobRepository,
  JobTransitionPatch,
} from "@/src/application/ports/repositories/JobRepository";
import type { IQueue } from "@/src/application/ports/queue/Queue";
import type { ILogger } from "@/src/application/ports/Logger";

export interface QueueHandoffDeps {
  jobRepo: IJobRepository;
  queue: IQueue;
  logger: ILogger;
}

/**
 * The row as it was before the caller wrote `queued` — where to put it back.
 *
 * `patch` must name every field the caller's own `→ queued` transition wrote,
 * with the value the row held beforehand. A field left out is a field that keeps
 * the queued row's value on a status that should never have it, and the two that
 * matter most are invisible until later: `attempts` (charging an attempt the
 * queue refused would eat a retry budget nothing spent) and `errorCategory`
 * (`retryJob` reads it to decide whether another attempt is even allowed).
 */
export interface QueueHandoffRestore {
  status: JobStatus;
  patch?: JobTransitionPatch;
}

/**
 * Hands a job id to the queue adapter, undoing the durable `queued` write if the
 * push fails.
 *
 * ## Why this seam exists
 *
 * Making a job runnable is two writes: the row moves to `queued`, then the
 * adapter is told. Whether losing the second one matters depends entirely on the
 * adapter:
 *
 *  - **`DatabaseQueue`** — safe by construction. The `queued` row *is* the queue
 *    entry (`pull` reads `listByStatus("queued")`), and `requeue` only drops an
 *    in-flight de-duplication marker, which self-heals on its TTL. It has no
 *    realistic way to throw and nothing to lose if it did.
 *  - **`InMemoryQueue` / `RedisQueue`** — can strand. Both answer `pull` from
 *    their own list of ready ids (an array; a Redis `READY` list), so a failed
 *    push leaves a row that says `queued` with nothing that will ever serve it.
 *    And nothing else in the system revisits such a row: `listStaleRunning`
 *    returns only `running`, and `retryJob` refuses anything that is not
 *    `failed`/`cancelled`. That is a permanent strand.
 *
 * So every caller that writes `queued` and then pushes must be able to take the
 * write back, and they must all take it back the same way — hence one function
 * rather than three rollbacks that can drift.
 *
 * ## What it will never do
 *
 * Roll back over somebody else. The rollback is guarded twice: the row is
 * re-read and must still be exactly the `queued` row this call wrote, and the
 * write itself goes through `jobRepo.transition`, which compare-and-swaps and
 * refuses any move the lifecycle forbids. A job the user cancelled in the
 * meantime therefore stays cancelled rather than being resurrected as `failed`.
 */
export async function deliverQueuedJob(
  deps: QueueHandoffDeps,
  jobId: string,
  restore: QueueHandoffRestore,
): Promise<void> {
  try {
    await deps.queue.requeue(jobId);
  } catch (err) {
    await rollback(deps, jobId, restore, err);
    throw err;
  }
}

/**
 * Best-effort undo. Never throws — the caller's own error is the real cause and
 * must be the one that reaches the user.
 */
async function rollback(
  deps: QueueHandoffDeps,
  jobId: string,
  restore: QueueHandoffRestore,
  cause: unknown,
): Promise<void> {
  try {
    // Re-read first. `queued → running` and `queued → failed` are both legal
    // moves, so the lifecycle alone cannot tell "put my write back" apart from
    // "overwrite the attempt a worker started a millisecond ago". This narrows
    // that window to the two awaits below; it does not close it, and it does not
    // need to — for every adapter whose push can actually fail the id was never
    // delivered, so no worker can be holding it.
    const current = await deps.jobRepo.get(jobId);
    if (current?.status !== "queued") {
      deps.logger.info("Queue handoff rollback skipped; the job moved on", {
        jobId,
        status: current?.status ?? "missing",
      });
      return;
    }

    const reverted = await deps.jobRepo.transition(jobId, restore.status, restore.patch);
    if (!reverted) {
      deps.logger.info("Queue handoff rollback refused; the job moved on", { jobId });
      return;
    }
    deps.logger.warn("Queue handoff failed; the job was rolled back", {
      jobId,
      to: restore.status,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  } catch (err) {
    // The strand this rollback exists to prevent, and the one case where it was
    // never preventable: if this write cannot land, the database is unreachable,
    // which is also the one case where the original `→ queued` CAS could not have
    // succeeded. Say it plainly rather than swallowing it — the row is `queued`
    // with nothing that will deliver it.
    deps.logger.error("Queue handoff failed and rollback failed; job is stranded", {
      jobId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
