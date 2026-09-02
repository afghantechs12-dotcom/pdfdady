import { describe, expect, it } from "vitest";
import { InMemoryQueue } from "./InMemoryQueue";
import { InMemoryWorker } from "./InMemoryWorker";
import { InMemoryJobScheduler } from "./InMemoryJobScheduler";
import { InMemoryJobEvents } from "./InMemoryJobEvents";
import { InMemoryJobRepository } from "@/src/infrastructure/persistence/InMemoryJobRepository";
import { ConsoleLogger } from "@/src/infrastructure/logging/ConsoleLogger";

const logger = () => new ConsoleLogger("error");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function setup() {
  const repo = new InMemoryJobRepository();
  const queue = new InMemoryQueue(repo, logger());
  const events = new InMemoryJobEvents();
  const worker = new InMemoryWorker(queue, repo, logger(), {
    events,
    backoffMs: () => 0,
  });
  const scheduler = new InMemoryJobScheduler(queue, repo, logger());
  return { repo, queue, events, worker, scheduler };
}

describe("queue: cancellation, requeue (DLQ), progress, scheduling", () => {
  it("cancels a running job when cancel() is called", async () => {
    const { repo, queue, worker } = setup();
    worker.register("long", async (_job, ctx) => {
      for (let i = 0; i < 100; i++) {
        if (ctx.isCancelled()) throw new Error("cancelled");
        await sleep(2);
      }
      return { result: "done" };
    });
    const job = await queue.enqueue({ type: "long", payload: null });
    const processing = worker.drainOnce();
    await sleep(10);
    await worker.cancel(job.id);
    await processing;
    const final = await repo.get(job.id);
    expect(final?.status).toBe("cancelled");
  });

  it("requeues a failed (dead-letter) job and it succeeds on the second run", async () => {
    const { repo, queue, worker } = setup();
    let calls = 0;
    worker.register("flaky", async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return { result: "ok" };
    });
    const job = await queue.enqueue({ type: "flaky", payload: null, maxAttempts: 1 });
    await worker.drainOnce();
    expect((await repo.get(job.id))?.status).toBe("failed");

    await worker.requeue(job.id);
    await worker.drainOnce();
    const final = await repo.get(job.id);
    expect(final?.status).toBe("completed");
    expect(calls).toBe(2);
  });

  it("emits progress events via IJobEvents", async () => {
    const { queue, events, worker } = setup();
    const received: number[] = [];
    worker.register("progress", async (_job, ctx) => {
      await ctx.progress(10);
      await ctx.progress(50);
      await ctx.progress(100);
      return { result: "done" };
    });
    const job = await queue.enqueue({ type: "progress", payload: null });
    const unsub = events.onProgress(job.id, (e) => received.push(e.pct));
    await worker.drainOnce();
    unsub();
    expect(received).toEqual([10, 50, 100]);
  });

  it("schedules a job to become eligible after a delay", async () => {
    const { repo, worker, scheduler } = setup();
    worker.register("delayed", async () => ({ result: "ran" }));
    const runAt = new Date(Date.now() + 50);
    const job = await scheduler.schedule({ type: "delayed", payload: null }, runAt);
    expect((await repo.get(job.id))?.status).toBe("queued");
    await sleep(80); // timer fires → queue.requeue
    await worker.drainOnce();
    expect((await repo.get(job.id))?.status).toBe("completed");
  });

  it("a scheduled job can be cancelled before it runs", async () => {
    const { repo, scheduler } = setup();
    const runAt = new Date(Date.now() + 1000);
    const job = await scheduler.schedule({ type: "x", payload: null }, runAt);
    await scheduler.cancel(job.id);
    expect((await repo.get(job.id))?.status).toBe("cancelled");
  });
});
