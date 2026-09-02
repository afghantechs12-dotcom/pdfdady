import { describe, expect, it } from "vitest";
import { InMemoryQueue } from "./InMemoryQueue";
import { InMemoryWorker } from "./InMemoryWorker";
import { InMemoryJobRepository } from "@/src/infrastructure/persistence/InMemoryJobRepository";
import { ConsoleLogger } from "@/src/infrastructure/logging/ConsoleLogger";

const logger = () => new ConsoleLogger("error");

describe("InMemoryQueue + InMemoryWorker", () => {
  it("enqueues and pulls a job; pull returns null when empty", async () => {
    const repo = new InMemoryJobRepository();
    const queue = new InMemoryQueue(repo, logger());
    const job = await queue.enqueue({ type: "echo", payload: { x: 1 } });
    expect(job.status).toBe("queued");
    expect(job.type).toBe("echo");

    const pulled = await queue.pull(0);
    expect(pulled?.id).toBe(job.id);
    expect(await queue.pull(0)).toBeNull();
  });

  it("processes a job via the worker and records the result", async () => {
    const repo = new InMemoryJobRepository();
    const queue = new InMemoryQueue(repo, logger());
    const worker = new InMemoryWorker(queue, repo, logger());
    worker.register("echo", async (job) => ({
      result: (job.payload as { x: number }).x + 1,
    }));

    const job = await queue.enqueue({ type: "echo", payload: { x: 41 } });
    await worker.drainOnce();

    const final = await repo.get(job.id);
    expect(final?.status).toBe("completed");
    expect(final?.result).toBe(42);
    expect(final?.attempts).toBe(1);
  });

  it("retries a failing handler up to maxAttempts then marks failed", async () => {
    const repo = new InMemoryJobRepository();
    const queue = new InMemoryQueue(repo, logger());
    // No backoff sleeps in the test.
    const worker = new InMemoryWorker(queue, repo, logger(), {
      backoffMs: () => 0,
    });
    let calls = 0;
    worker.register("fail", async () => {
      calls += 1;
      throw new Error("nope");
    });

    const job = await queue.enqueue({ type: "fail", payload: null, maxAttempts: 3 });
    await worker.drainOnce();

    const final = await repo.get(job.id);
    expect(final?.status).toBe("failed");
    expect(final?.attempts).toBe(3);
    expect(final?.error).toBe("nope");
    expect(calls).toBe(3);
  });

  it("records the owner on the row when the enqueue carries one", async () => {
    // The legacy authorization fix depends on this exact hop: an owner passed to
    // enqueue must land on the persisted row, because `/api/jobs/[id]` checks the
    // row, not the payload. Before EnqueueInput carried these fields the adapter
    // dropped them and every legacy row was born unowned.
    const repo = new InMemoryJobRepository();
    const queue = new InMemoryQueue(repo, logger());
    const job = await queue.enqueue({
      type: "pdf-tool",
      payload: { x: 1 },
      ownerType: "anon",
      ownerId: "anon-abc",
      workspaceId: null,
      toolSlug: "compress-pdf",
    });

    const stored = await repo.get(job.id);
    expect(stored?.ownerType).toBe("anon");
    expect(stored?.ownerId).toBe("anon-abc");
    expect(stored?.toolSlug).toBe("compress-pdf");
  });

  it("leaves the owner null when the enqueue omits it (infrastructure jobs)", async () => {
    // The retention sweep, ingestion and the scheduler enqueue without an owner
    // and are never addressed by id. Null must stay null — not coerced to a
    // shared bucket that an ownership check would then treat as "everyone".
    const repo = new InMemoryJobRepository();
    const queue = new InMemoryQueue(repo, logger());
    const job = await queue.enqueue({ type: "echo", payload: null });

    const stored = await repo.get(job.id);
    expect(stored?.ownerType).toBeNull();
    expect(stored?.ownerId).toBeNull();
    expect(stored?.toolSlug).toBeNull();
  });

  it("marks a job with no handler as failed", async () => {
    const repo = new InMemoryJobRepository();
    const queue = new InMemoryQueue(repo, logger());
    const worker = new InMemoryWorker(queue, repo, logger());

    const job = await queue.enqueue({ type: "orphan", payload: null });
    await worker.drainOnce();

    const final = await repo.get(job.id);
    expect(final?.status).toBe("failed");
    expect(final?.error).toContain("No handler");
  });
});
