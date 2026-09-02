import { describe, expect, it, beforeEach } from "vitest";

import { InMemoryJobRepository } from "@/src/infrastructure/persistence/InMemoryJobRepository";
import { RedisQueue } from "@/src/infrastructure/queue/RedisQueue";
import { ConsoleLogger } from "@/src/infrastructure/logging/ConsoleLogger";
import type { IJobRepository } from "@/src/application/ports/repositories/JobRepository";
import type { ILogger } from "@/src/application/ports/Logger";
import { PROCESSING_JOB_TYPE } from "./ProcessingJobService";
import { deliverQueuedJob } from "./queueHandoff";

/**
 * The shared handoff rollback, driven against the **Redis** adapter.
 *
 * The two request-path callers are covered against the in-memory adapter in
 * `ProcessingJobService.test.ts` and the sweep against both in
 * `StuckJobRecoveryService.test.ts`. What is left, and what this file exists
 * for, is the adapter that actually ships in production: `RedisQueue`, whose
 * `requeue` is a single `LPUSH` to a list that is the *only* record of a job
 * being ready. A failed push there is the strand this seam prevents.
 *
 * Environment-limited on purpose: no live Redis server is contacted. The double
 * below stands in for the wire, not for the adapter — the `requeue` and `pull`
 * under test are the real production methods, so the failure semantics proved
 * here are `RedisQueue`'s own.
 */

const logger: ILogger = new ConsoleLogger("error");

/** The two ioredis commands `RedisQueue` uses, and nothing else. */
class FakeRedis {
  readonly ready: string[] = [];
  lpushWorks = true;

  async lpush(_key: string, id: string): Promise<number> {
    // The realistic production failure is not "Redis is missing" — the adapter
    // would never have been constructed. It is a write refused mid-life: a
    // failover to a read-only replica, a hit OOM limit, a severed socket.
    if (!this.lpushWorks) throw new Error("READONLY You can't write against a read only replica.");
    this.ready.unshift(id);
    return this.ready.length;
  }

  async brpoplpush(): Promise<string | null> {
    return this.ready.pop() ?? null;
  }
}

/**
 * A real `RedisQueue` around a fake wire.
 *
 * Built without its constructor, which does `new Redis(url)` and opens a socket
 * that retries forever — a unit test must not hold one, and CI has no server to
 * answer it. This is why the adapter has had no test until now.
 */
function redisQueue(jobRepo: IJobRepository, redis: FakeRedis): RedisQueue {
  const queue = Object.create(RedisQueue.prototype) as RedisQueue;
  return Object.assign(queue, { redis, jobRepo, logger });
}

let repo: InMemoryJobRepository;
let redis: FakeRedis;
let queue: RedisQueue;

beforeEach(() => {
  repo = new InMemoryJobRepository();
  redis = new FakeRedis();
  queue = redisQueue(repo, redis);
});

/** A row that has just been written `queued`, as every caller of the seam leaves it. */
async function queuedRow(status: "failed" | "running" = "failed") {
  const job = await repo.create({
    type: PROCESSING_JOB_TYPE,
    payload: { toolSlug: "compress-pdf" },
    status: "created",
    ownerType: "user",
    ownerId: "user-1",
    toolSlug: "compress-pdf",
  });
  if (status === "running") {
    await repo.transition(job.id, "queued");
    await repo.transition(job.id, "running", { startedAt: new Date() });
    await repo.transition(job.id, "queued", {}, { recover: true });
  } else {
    await repo.transition(job.id, "queued", { queuedAt: new Date() });
  }
  return job.id;
}

describe("deliverQueuedJob against the Redis adapter", () => {
  it("hands the id to the ready list when the wire is healthy", async () => {
    const id = await queuedRow();
    await deliverQueuedJob({ jobRepo: repo, queue, logger }, id, { status: "failed" });

    expect(redis.ready).toEqual([id]);
    expect((await queue.pull(0))?.id).toBe(id);
    expect((await repo.get(id))!.status).toBe("queued");
  });

  it("rolls the row back when the LPUSH is refused, and a second delivery succeeds", async () => {
    const id = await queuedRow();
    redis.lpushWorks = false;

    await expect(
      deliverQueuedJob({ jobRepo: repo, queue, logger }, id, {
        status: "failed",
        patch: { errorCategory: "processor_timeout", queuedAt: null },
      }),
    ).rejects.toThrow("READONLY");

    // Without the rollback this row is `queued` with an empty ready list — and
    // `pull` reads only that list, so no worker in any process would ever be
    // handed the id again.
    expect(redis.ready).toEqual([]);
    const rolled = (await repo.get(id))!;
    expect(rolled.status).toBe("failed");
    expect(rolled.errorCategory).toBe("processor_timeout");

    // Recoverable: the caller can put the row back to `queued` and try the same
    // handoff again once Redis takes writes.
    redis.lpushWorks = true;
    await repo.transition(id, "queued", {}, { retry: true });
    await deliverQueuedJob({ jobRepo: repo, queue, logger }, id, { status: "failed" });
    expect((await queue.pull(0))?.id).toBe(id);
  });

  it("restores a recovered job to running, the shape the sweep's next pass finds", async () => {
    const id = await queuedRow("running");
    const before = (await repo.get(id))!;
    redis.lpushWorks = false;

    await expect(
      deliverQueuedJob({ jobRepo: repo, queue, logger }, id, {
        status: "running",
        patch: { attempts: before.attempts, startedAt: before.startedAt, queuedAt: null },
      }),
    ).rejects.toThrow("READONLY");

    // `running` rather than a terminal state, because that is the only status
    // `listStaleRunning` returns: the rollback hands the row back to the sweep
    // that produced it instead of inventing a second recovery mechanism.
    expect((await repo.get(id))!.status).toBe("running");
  });

  it("refuses to roll back over a job that moved on", async () => {
    const id = await queuedRow();
    redis.lpushWorks = false;
    // A worker claimed the id between the push failing and the rollback reading.
    // Overwriting that would kill a live attempt — `queued → running` and
    // `queued → failed` are both legal, so only the re-read stops it.
    await repo.transition(id, "running", { startedAt: new Date() });

    await expect(
      deliverQueuedJob({ jobRepo: repo, queue, logger }, id, { status: "failed" }),
    ).rejects.toThrow("READONLY");

    expect((await repo.get(id))!.status).toBe("running");
  });

  it("reports a stranded job rather than swallowing a rollback that cannot land", async () => {
    const id = await queuedRow();
    redis.lpushWorks = false;
    const stranded: string[] = [];
    const deaf: ILogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message: string) => {
        stranded.push(message);
      },
      child: () => deaf,
    };
    // The real repository, with only the rollback write broken: the re-read has
    // to still succeed, or this test would pass on the "job moved on" branch and
    // prove nothing about a failed write.
    const brokenRepo: IJobRepository = Object.assign(
      Object.create(Object.getPrototypeOf(repo) as object),
      repo,
      { transition: () => Promise.reject(new Error("database unreachable")) },
    ) as IJobRepository;
    expect((await brokenRepo.get(id))!.status).toBe("queued");

    await expect(
      deliverQueuedJob({ jobRepo: brokenRepo, queue, logger: deaf }, id, { status: "failed" }),
    ).rejects.toThrow("READONLY");

    // The one strand that was never preventable — and the operator has to hear
    // about it, because nothing else in the system will look at this row.
    expect(stranded).toEqual(["Queue handoff failed and rollback failed; job is stranded"]);
  });
});
