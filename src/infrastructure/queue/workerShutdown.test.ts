import { describe, expect, it } from "vitest";
import { InMemoryQueue } from "./InMemoryQueue";
import { InMemoryWorker } from "./InMemoryWorker";
import { InMemoryJobRepository } from "@/src/infrastructure/persistence/InMemoryJobRepository";
import { ConsoleLogger } from "@/src/infrastructure/logging/ConsoleLogger";
import {
  DEFAULT_STALE_AFTER_MS,
  StuckJobRecoveryService,
} from "@/src/application/services/StuckJobRecoveryService";

/**
 * Graceful shutdown, at the seam that actually decides whether it is graceful.
 *
 * The standalone worker's SIGTERM path is three steps: stop accepting work, wait
 * for what is in flight up to a deadline, exit. Two of those depend on the
 * worker adapter and are what this file pins:
 *
 *   - `stop()` must prevent the NEXT claim. If it only stopped the loop's
 *     bookkeeping, a shutdown would keep pulling jobs it had no intention of
 *     finishing, and every one of them would be stranded by the exit.
 *   - `activeCount` must actually report in-flight work. It is the only signal
 *     the drain loop has; if it were wrong in either direction the shutdown would
 *     either exit instantly through live work or hang until the deadline every
 *     time.
 *
 * The third — that anything abandoned at the deadline is recoverable — is
 * asserted here too, because "we gave up on schedule" is only acceptable if the
 * jobs come back.
 */

const logger = () => new ConsoleLogger("error");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function setup() {
  const repo = new InMemoryJobRepository();
  const queue = new InMemoryQueue(repo, logger());
  const worker = new InMemoryWorker(queue, repo, logger(), { backoffMs: () => 0 });
  return { repo, queue, worker };
}

describe("worker shutdown", () => {
  it("stops claiming new work once stop() is called", async () => {
    const { repo, queue, worker } = setup();
    const started: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });

    worker.register("slow", async (job) => {
      started.push(job.id);
      await gate;
      return { result: "done" };
    });

    const first = await queue.enqueue({ type: "slow", payload: null });
    const second = await queue.enqueue({ type: "slow", payload: null });

    worker.start();
    // Wait until the first job is genuinely in flight. Calling stop() before the
    // loop had claimed anything would prove nothing about stopping claims.
    while (started.length === 0) await sleep(2);
    expect(worker.activeCount).toBe(1);

    worker.stop();
    // Generous window: the loop polls, so "did not claim" has to mean "had every
    // opportunity to and did not".
    await sleep(60);

    expect(started).toEqual([first.id]);
    expect((await repo.get(second.id))?.status).toBe("queued");

    release();
    while (worker.activeCount > 0) await sleep(2);
    expect((await repo.get(first.id))?.status).toBe("completed");
  });

  it("reports zero active only after in-flight work finishes", async () => {
    const { queue, worker } = setup();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    worker.register("slow", async () => {
      await gate;
      return { result: "done" };
    });
    await queue.enqueue({ type: "slow", payload: null });

    expect(worker.activeCount).toBe(0);
    worker.start();
    while (worker.activeCount === 0) await sleep(2);

    worker.stop();
    // The drain loop the worker process runs is exactly this condition. If
    // `activeCount` dropped to zero at `stop()`, the process would exit here and
    // kill the handler mid-write.
    expect(worker.activeCount).toBe(1);

    release();
    const deadline = Date.now() + 1_000;
    while (worker.activeCount > 0 && Date.now() < deadline) await sleep(2);
    expect(worker.activeCount).toBe(0);
  });

  it("makes work abandoned at the shutdown deadline recoverable", async () => {
    const { repo, queue, worker } = setup();
    // A handler that never finishes: the case the grace period gives up on.
    worker.register("wedged", async () => {
      await new Promise<void>(() => {});
      return { result: "never" };
    });
    const job = await queue.enqueue({ type: "wedged", payload: null });

    worker.start();
    while (worker.activeCount === 0) await sleep(2);
    worker.stop();

    // The process would exit here, leaving the row exactly like this: claimed,
    // with a lease that stops being refreshed the moment the process dies.
    expect((await repo.get(job.id))?.status).toBe("running");

    const row = (repo as unknown as { jobs: Map<string, { updatedAt: Date }> }).jobs.get(job.id);
    row!.updatedAt = new Date(Date.now() - DEFAULT_STALE_AFTER_MS - 60_000);

    const summary = await new StuckJobRecoveryService({
      jobRepo: repo,
      queue,
      logger: logger(),
    }).recoverStale();

    expect(summary).toMatchObject({ examined: 1, requeued: 1 });
    expect((await repo.get(job.id))?.status).toBe("queued");
    // Back on the ready queue, so the next worker actually gets it.
    expect((await queue.pull(0))?.id).toBe(job.id);
  });
});
