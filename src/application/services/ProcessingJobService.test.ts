import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryJobRepository } from "@/src/infrastructure/persistence/InMemoryJobRepository";
import { InMemoryQueue } from "@/src/infrastructure/queue/InMemoryQueue";
import { DatabaseQueue } from "@/src/infrastructure/queue/DatabaseQueue";
import { InMemoryWorker } from "@/src/infrastructure/queue/InMemoryWorker";
import { ConsoleLogger } from "@/src/infrastructure/logging/ConsoleLogger";
import { InvalidJobTransitionError } from "@/src/domain/jobs/jobStateMachine";
import { StuckJobRecoveryService } from "./StuckJobRecoveryService";
import { ToolExecutionModeError } from "@/lib/tools/executionPolicy";
import { JobAuthorizationError, type JobActor } from "./jobOwnership";
import {
  JobConflictError,
  JobNotFoundError,
  MAX_PROCESSING_ATTEMPTS,
  PROCESSING_JOB_TYPE,
  PROCESSING_OUTPUT_TTL_MS,
  ProcessingJobService,
  type ProcessingJobResult,
} from "./ProcessingJobService";
import type { JobErrorCategory } from "@/src/domain/jobs/jobErrors";

const OWNER: JobActor = { ownerType: "user", ownerId: "user-1" };
const INTRUDER: JobActor = { ownerType: "user", ownerId: "user-2" };

const INPUT = { key: "processing-inputs/abc/doc.pdf", displayName: "doc.pdf", bytes: 1024 };

function outputResult(bytes = 512): ProcessingJobResult {
  return {
    output: {
      key: "jobs/j/output/doc-compressed.pdf",
      fileId: "file-1",
      downloadName: "doc-compressed.pdf",
      mimeType: "application/pdf",
      bytes,
    },
  };
}

/**
 * Real InMemoryWorker, plus a log of the two control calls the service makes on
 * it. Subclassed rather than mocked so the recorded calls still have their real
 * effects — a mock would let a propagation test pass while the flag never moved.
 */
class RecordingWorker extends InMemoryWorker {
  readonly cancelCalls: string[] = [];
  readonly clearCalls: string[] = [];

  async cancel(jobId: string): Promise<void> {
    this.cancelCalls.push(jobId);
    await super.cancel(jobId);
  }

  async clearCancellation(jobId: string): Promise<void> {
    this.clearCalls.push(jobId);
    await super.clearCancellation(jobId);
  }
}

interface Harness {
  service: ProcessingJobService;
  jobRepo: InMemoryJobRepository;
  queue: InMemoryQueue;
  worker: RecordingWorker;
  clock: { now: Date };
  advance(ms: number): void;
}

function harness(): Harness {
  const logger = new ConsoleLogger("error");
  const jobRepo = new InMemoryJobRepository();
  const queue = new InMemoryQueue(jobRepo, logger);
  const worker = new RecordingWorker(queue, jobRepo, logger);
  const clock = { now: new Date("2026-01-01T00:00:00.000Z") };
  const service = new ProcessingJobService({
    jobRepo,
    queue,
    worker,
    logger,
    now: () => clock.now,
  });
  return {
    service,
    jobRepo,
    queue,
    worker,
    clock,
    advance: (ms) => {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
}

async function submit(h: Harness, over: Partial<Parameters<ProcessingJobService["submitJob"]>[0]> = {}) {
  return h.service.submitJob({
    actor: OWNER,
    toolSlug: "compress-pdf",
    inputs: [INPUT],
    options: {},
    ...over,
  });
}

// ---------------------------------------------------------------------------

describe("createJob — the tool allowlist", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("creates a job for an allowlisted remote tool", async () => {
    const { job, deduplicated } = await h.service.createJob({
      actor: OWNER,
      toolSlug: "compress-pdf",
      inputs: [INPUT],
      options: {},
    });
    expect(deduplicated).toBe(false);
    expect(job.type).toBe(PROCESSING_JOB_TYPE);
    expect(job.status).toBe("created");
    expect(job.toolSlug).toBe("compress-pdf");
  });

  it("refuses a tool that runs locally in the browser", async () => {
    // The allowlist is not decoration: a local slug reaching the pipeline would
    // mean documents being uploaded for work that never needed to leave the
    // device.
    await expect(
      h.service.createJob({ actor: OWNER, toolSlug: "merge-pdf", inputs: [INPUT], options: {} }),
    ).rejects.toThrow(ToolExecutionModeError);
  });

  it("refuses an unknown slug and an injection-shaped slug", async () => {
    for (const slug of ["", "unknown-tool", "../../etc/passwd", "compress-pdf; rm -rf /"]) {
      await expect(
        h.service.createJob({ actor: OWNER, toolSlug: slug, inputs: [INPUT], options: {} }),
      ).rejects.toThrow(ToolExecutionModeError);
    }
  });

  it("checks the allowlist before anything is written", async () => {
    await expect(
      h.service.createJob({ actor: OWNER, toolSlug: "merge-pdf", inputs: [INPUT], options: {} }),
    ).rejects.toThrow();
    expect(await h.jobRepo.listByStatus("created")).toHaveLength(0);
    expect(await h.jobRepo.listByStatus("queued")).toHaveLength(0);
  });

  it("refuses a submission with no inputs", async () => {
    await expect(
      h.service.createJob({ actor: OWNER, toolSlug: "compress-pdf", inputs: [], options: {} }),
    ).rejects.toThrow(JobConflictError);
  });

  it("records the owner, workspace and input size on the row", async () => {
    const { job } = await h.service.createJob({
      actor: { ownerType: "user", ownerId: "user-1", workspaceId: "ws-9" },
      toolSlug: "compress-pdf",
      inputs: [INPUT, { ...INPUT, bytes: 2048 }],
      options: { level: "high" },
    });
    expect(job.ownerType).toBe("user");
    expect(job.ownerId).toBe("user-1");
    expect(job.workspaceId).toBe("ws-9");
    expect(job.inputBytes).toBe(3072);
    expect(job.maxAttempts).toBe(MAX_PROCESSING_ATTEMPTS);
  });

  it("sets an expiry from the retention window", async () => {
    const { job } = await h.service.createJob({
      actor: OWNER,
      toolSlug: "compress-pdf",
      inputs: [INPUT],
      options: {},
    });
    expect(job.expiresAt?.getTime()).toBe(h.clock.now.getTime() + PROCESSING_OUTPUT_TTL_MS);
  });

  it("keeps document bytes out of the job record", async () => {
    // The payload carries storage keys and sizes. If bytes ever leaked into the
    // row they would sit in the database and in every queue message.
    const { job } = await h.service.createJob({
      actor: OWNER,
      toolSlug: "compress-pdf",
      inputs: [INPUT],
      options: {},
    });
    const serialized = JSON.stringify(job.payload);
    expect(serialized).toContain(INPUT.key);
    expect(serialized).not.toMatch(/%PDF/);
    expect(serialized).not.toMatch(/base64/i);
  });
});

describe("submitJob — queueing", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("queues the job and puts only the id on the queue", async () => {
    const { job } = await submit(h);
    expect(job.status).toBe("queued");
    expect(job.queuedAt).not.toBeNull();
    expect(job.progressStage).toBe("queued");

    const pulled = await h.queue.pull(0);
    expect(pulled?.id).toBe(job.id);
  });

  it("queueJob is idempotent for an already-queued job", async () => {
    const { job } = await submit(h);
    const again = await h.service.queueJob(job.id);
    expect(again.id).toBe(job.id);
    expect(again.status).toBe("queued");
  });

  it("refuses to queue a job that has already finished", async () => {
    const { job } = await submit(h);
    await h.service.startJob(job.id);
    await h.service.completeJob(job.id, outputResult(), 1);
    await expect(h.service.queueJob(job.id)).rejects.toThrow(InvalidJobTransitionError);
  });

  it("cannot publish a result for a job that never started", async () => {
    // `queued -> completed` skips the claim, so a stray completion for a job no
    // worker ever ran is refused rather than silently accepted.
    const { job } = await submit(h);
    expect(await h.service.completeJob(job.id, outputResult(), 1)).toBe(false);
    expect((await h.jobRepo.get(job.id))?.result).toBeNull();
  });

  it("raises JobNotFoundError for an unknown id", async () => {
    await expect(h.service.queueJob("nope")).rejects.toThrow(JobNotFoundError);
  });
});

describe("idempotency", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("returns the original job for a replayed key without creating a second one", async () => {
    const first = await submit(h, { idempotencyKey: "key-1" });
    const second = await submit(h, { idempotencyKey: "key-1" });

    expect(second.deduplicated).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(await h.jobRepo.listByStatus("queued")).toHaveLength(1);
  });

  it("does not re-queue on a replay", async () => {
    await submit(h, { idempotencyKey: "key-1" });
    await h.queue.pull(0); // drain the single legitimate entry

    await submit(h, { idempotencyKey: "key-1" });
    // A second queue entry would mean the same document processed twice — the
    // exact double-charge a disabled button cannot prevent.
    expect(await h.queue.pull(0)).toBeNull();
  });

  it("scopes keys to the actor, so two visitors can use the same key", async () => {
    const mine = await submit(h, { idempotencyKey: "shared" });
    const theirs = await submit(h, { actor: INTRUDER, idempotencyKey: "shared" });

    expect(theirs.deduplicated).toBe(false);
    expect(theirs.job.id).not.toBe(mine.job.id);
    expect(theirs.job.ownerId).toBe("user-2");
  });

  it("never hands one visitor another visitor's job through a guessed key", async () => {
    const mine = await submit(h, { idempotencyKey: "guessable-123" });
    const theirs = await submit(h, { actor: INTRUDER, idempotencyKey: "guessable-123" });
    expect(theirs.job.id).not.toBe(mine.job.id);
    // And the freshly created job is genuinely theirs, not a view onto mine.
    await expect(h.service.getJob(theirs.job.id, INTRUDER)).resolves.toBeTruthy();
    await expect(h.service.getJob(mine.job.id, INTRUDER)).rejects.toThrow(JobAuthorizationError);
  });

  it("treats a missing key as no de-duplication at all", async () => {
    const a = await submit(h);
    const b = await submit(h);
    expect(b.job.id).not.toBe(a.job.id);
  });
});

describe("authorization", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("lets the owner read their job", async () => {
    const { job } = await submit(h);
    const view = await h.service.getJob(job.id, OWNER);
    expect(view.jobId).toBe(job.id);
    expect(view.toolSlug).toBe("compress-pdf");
  });

  it("refuses a read by another user", async () => {
    const { job } = await submit(h);
    await expect(h.service.getJob(job.id, INTRUDER)).rejects.toThrow(JobAuthorizationError);
  });

  it("refuses a cancel by another user", async () => {
    const { job } = await submit(h);
    await expect(h.service.cancelJob(job.id, INTRUDER)).rejects.toThrow(JobAuthorizationError);
    // And the job is untouched — a failed authorization must not have side effects.
    expect((await h.jobRepo.get(job.id))?.status).toBe("queued");
  });

  it("refuses a retry by another user", async () => {
    const { job } = await submit(h);
    await h.service.startJob(job.id);
    await h.service.failJob(job.id, "processor_timeout", "internal detail", 1);
    await expect(h.service.retryJob(job.id, INTRUDER)).rejects.toThrow(JobAuthorizationError);
    expect((await h.jobRepo.get(job.id))?.status).toBe("failed");
  });

  it("refuses a result read (download) by another user", async () => {
    const { job } = await submit(h);
    await h.service.startJob(job.id);
    await h.service.completeJob(job.id, outputResult(), 1);
    await expect(h.service.getResult(job.id, INTRUDER)).rejects.toThrow(JobAuthorizationError);
  });

  it("reports a missing job the same way as someone else's job", async () => {
    // Identical error type for both, so the endpoint cannot be used to learn
    // which job ids exist.
    const { job } = await submit(h);
    const missing = h.service.getJob("inmem-job-does-not-exist", OWNER);
    const forbidden = h.service.getJob(job.id, INTRUDER);
    await expect(missing).rejects.toThrow(JobAuthorizationError);
    await expect(forbidden).rejects.toThrow(JobAuthorizationError);
  });

  it("refuses to serve a non-processing job through this service", async () => {
    // A legacy `pdf-tool` row has different semantics and no owner columns;
    // reading it here would apply this service's rules to data that never
    // agreed to them.
    const legacy = await h.jobRepo.create({
      type: "pdf-tool",
      payload: {},
      ownerType: "user",
      ownerId: "user-1",
    });
    await expect(h.service.getJob(legacy.id, OWNER)).rejects.toThrow(JobAuthorizationError);
  });

  it("enforces workspace scope", async () => {
    const { job } = await submit(h, {
      actor: { ownerType: "user", ownerId: "user-1", workspaceId: "ws-1" },
    });
    await expect(
      h.service.getJob(job.id, { ownerType: "user", ownerId: "user-1", workspaceId: "ws-2" }),
    ).rejects.toThrow(JobAuthorizationError);
    await expect(
      h.service.getJob(job.id, { ownerType: "user", ownerId: "user-1", workspaceId: "ws-1" }),
    ).resolves.toBeTruthy();
  });

  it("separates anon visitors from users with the same id string", async () => {
    const { job } = await submit(h, { actor: { ownerType: "anon", ownerId: "shared-id" } });
    await expect(
      h.service.getJob(job.id, { ownerType: "user", ownerId: "shared-id" }),
    ).rejects.toThrow(JobAuthorizationError);
  });
});

describe("getResult — result availability", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("returns the result for a completed job", async () => {
    const { job } = await submit(h);
    await h.service.startJob(job.id);
    await h.service.completeJob(job.id, outputResult(777), 1);
    const result = await h.service.getResult(job.id, OWNER);
    expect(result.output.bytes).toBe(777);
    expect(result.output.fileId).toBe("file-1");
  });

  it("refuses before the job has finished", async () => {
    const { job } = await submit(h);
    await expect(h.service.getResult(job.id, OWNER)).rejects.toMatchObject({
      name: "JobConflictError",
      reason: "not_ready",
    });
    await h.service.startJob(job.id);
    await expect(h.service.getResult(job.id, OWNER)).rejects.toMatchObject({
      reason: "not_ready",
    });
  });

  it("refuses for a failed job", async () => {
    const { job } = await submit(h);
    await h.service.startJob(job.id);
    await h.service.failJob(job.id, "corrupt_document", "gs: internal", 1);
    await expect(h.service.getResult(job.id, OWNER)).rejects.toThrow(JobConflictError);
  });

  it("refuses for a cancelled job", async () => {
    const { job } = await submit(h);
    await h.service.startJob(job.id);
    await h.service.markCancelled(job.id, 1);
    await expect(h.service.getResult(job.id, OWNER)).rejects.toMatchObject({
      reason: "not_ready",
    });
  });

  it("refuses once the retention window has passed, even while status is completed", async () => {
    const { job } = await submit(h);
    await h.service.startJob(job.id);
    await h.service.completeJob(job.id, outputResult(), 1);
    h.advance(PROCESSING_OUTPUT_TTL_MS + 1);
    await expect(h.service.getResult(job.id, OWNER)).rejects.toMatchObject({
      reason: "expired",
    });
  });

  it("refuses for an expired job", async () => {
    const { job } = await submit(h);
    await h.service.startJob(job.id);
    await h.service.completeJob(job.id, outputResult(), 1);
    await h.service.expireJob(job.id);
    await expect(h.service.getResult(job.id, OWNER)).rejects.toMatchObject({
      reason: "expired",
    });
  });
});

describe("cancellation", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("cancels a queued job outright and says so", async () => {
    const { job } = await submit(h);
    const { view, stopped } = await h.service.cancelJob(job.id, OWNER);
    expect(stopped).toBe(true);
    expect(view.status).toBe("cancelled");
    expect(view.errorCategory).toBe("cancelled");
  });

  it("records the request for a running job without claiming it stopped", async () => {
    const { job } = await submit(h);
    await h.service.startJob(job.id);
    const { view, stopped } = await h.service.cancelJob(job.id, OWNER);
    // Honest: the subprocess is still alive at this instant.
    expect(stopped).toBe(false);
    expect(view.status).toBe("running");
    expect((await h.jobRepo.get(job.id))?.cancelRequestedAt).not.toBeNull();
  });

  it("propagates a running job's cancellation to the worker", async () => {
    // The worker's flag is what the handler polls. Without this call the request
    // would sit in the database as a timestamp while the subprocess ran to
    // completion — a Cancel button that does nothing.
    const { job } = await submit(h);
    await h.service.startJob(job.id);
    await h.service.cancelJob(job.id, OWNER);
    expect(h.worker.cancelCalls).toEqual([job.id]);
  });

  it("also tells the worker when it cancels a job that was only queued", async () => {
    // Belt and braces: the worker may have pulled the id between our read and
    // our write, in which case the transition lost the race and the flag is the
    // only thing that stops the run.
    const { job } = await submit(h);
    await h.service.cancelJob(job.id, OWNER);
    expect(h.worker.cancelCalls).toEqual([job.id]);
  });

  it("stops a flagged job from being dispatched at all", async () => {
    // End-to-end through the real worker: a cancelled job that is still sitting
    // on the queue must not reach a handler.
    const { job } = await submit(h);
    let handlerRuns = 0;
    h.worker.register(PROCESSING_JOB_TYPE, async () => {
      handlerRuns += 1;
      return { terminal: true };
    });

    await h.service.cancelJob(job.id, OWNER);
    await h.worker.drainOnce();

    expect(handlerRuns).toBe(0);
    expect((await h.jobRepo.get(job.id))?.status).toBe("cancelled");
  });

  it("refuses to cancel a job that already finished", async () => {
    const { job } = await submit(h);
    await h.service.startJob(job.id);
    await h.service.completeJob(job.id, outputResult(), 1);
    await expect(h.service.cancelJob(job.id, OWNER)).rejects.toMatchObject({
      reason: "already_finished",
    });
  });

  it("never publishes a result after a successful cancellation", async () => {
    // The guarantee the brief asks for, exercised end to end at the service
    // level: a cancelled job refuses completion, so a worker that finishes late
    // cannot turn the cancellation into a download.
    const { job } = await submit(h);
    await h.service.startJob(job.id);
    await h.service.markCancelled(job.id, 1);

    const published = await h.service.completeJob(job.id, outputResult(), 1);
    expect(published).toBe(false);

    const after = await h.jobRepo.get(job.id);
    expect(after?.status).toBe("cancelled");
    expect(after?.result).toBeNull();
    await expect(h.service.getResult(job.id, OWNER)).rejects.toThrow(JobConflictError);
  });
});

describe("retry", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  async function failedWith(category: JobErrorCategory, attempt = 1) {
    const { job } = await submit(h);
    await h.service.startJob(job.id);
    // The row has to have actually consumed the earlier attempts. A worker's
    // writes are fenced on the attempt it reports, so a fixture that jumps
    // straight to attempt 3 from zero is refused and leaves the job `running` —
    // and the assertions below would then be reading a job that never failed.
    if (attempt > 1) await h.jobRepo.update(job.id, { attempts: attempt - 1 });
    const recorded = await h.service.failJob(
      job.id,
      category,
      "internal diagnostic",
      attempt,
    );
    expect(recorded).toBe(true);
    return job;
  }

  it("re-queues a retryable failure", async () => {
    const job = await failedWith("processor_timeout");
    const view = await h.service.retryJob(job.id, OWNER);
    expect(view.status).toBe("queued");
    expect(view.errorCategory).toBeNull();
    expect(view.errorMessage).toBeNull();
    expect(view.stage).toBe("queued");
  });

  it("does not reset the attempt counter", async () => {
    // Resetting would make the budget meaningless: a user could retry forever.
    const job = await failedWith("dependency_unavailable", 1);
    const view = await h.service.retryJob(job.id, OWNER);
    expect(view.attempt).toBe(1);
    expect(view.maxAttempts).toBe(MAX_PROCESSING_ATTEMPTS);
  });

  it("refuses a permanent failure with reason permanent_failure", async () => {
    const permanent: JobErrorCategory[] = [
      "corrupt_document",
      "unsupported_format",
      "invalid_input",
      "password_required",
      "file_too_large",
    ];
    for (const category of permanent) {
      const job = await failedWith(category);
      await expect(h.service.retryJob(job.id, OWNER)).rejects.toMatchObject({
        reason: "permanent_failure",
      });
    }
  });

  it("refuses when the attempt budget is spent", async () => {
    const job = await failedWith("processor_failed", MAX_PROCESSING_ATTEMPTS);
    await expect(h.service.retryJob(job.id, OWNER)).rejects.toMatchObject({
      reason: "attempts_exhausted",
    });
  });

  it("refuses when the staged input has expired", async () => {
    const job = await failedWith("processor_timeout");
    h.advance(PROCESSING_OUTPUT_TTL_MS + 1);
    await expect(h.service.retryJob(job.id, OWNER)).rejects.toMatchObject({
      reason: "expired",
    });
  });

  it("refuses for a job already marked expired", async () => {
    // A `failed` row cannot be expired (the lifecycle gives it no outgoing
    // moves), so build the expired case from the state it is actually reachable
    // from: a queued job whose staged input outlived it.
    const { job } = await submit(h);
    h.advance(PROCESSING_OUTPUT_TTL_MS + 1);
    expect(await h.service.expireJob(job.id)).toBe(true);
    await expect(h.service.retryJob(job.id, OWNER)).rejects.toMatchObject({
      reason: "expired",
    });
  });

  it("refuses to retry a job that is still running or already completed", async () => {
    const { job } = await submit(h);
    await expect(h.service.retryJob(job.id, OWNER)).rejects.toMatchObject({
      reason: "not_retryable_status",
    });
    await h.service.startJob(job.id);
    await expect(h.service.retryJob(job.id, OWNER)).rejects.toMatchObject({
      reason: "not_retryable_status",
    });
    await h.service.completeJob(job.id, outputResult(), 1);
    await expect(h.service.retryJob(job.id, OWNER)).rejects.toMatchObject({
      reason: "not_retryable_status",
    });
  });

  it("allows retrying a cancelled job", async () => {
    const { job } = await submit(h);
    const { stopped } = await h.service.cancelJob(job.id, OWNER);
    expect(stopped).toBe(true);
    const view = await h.service.retryJob(job.id, OWNER);
    expect(view.status).toBe("queued");
  });

  it("puts the job back on the queue", async () => {
    const job = await failedWith("processor_timeout");
    await h.queue.pull(0); // drain the original submission entry
    await h.service.retryJob(job.id, OWNER);
    // Without this the job would sit in `queued` forever: status says runnable,
    // but no worker is ever handed the id.
    expect((await h.queue.pull(0))?.id).toBe(job.id);
  });

  it("clears the stale cancellation flag so the revived attempt actually runs", async () => {
    // A job cancelled while queued was never processed, so nothing cleared the
    // worker's flag. Retrying without clearing it produces a job that dies on
    // its first `isCancelled()` check — a "Try again" that looks like a second,
    // unexplained failure.
    const { job } = await submit(h);
    await h.service.cancelJob(job.id, OWNER);

    let handlerRuns = 0;
    h.worker.register(PROCESSING_JOB_TYPE, async () => {
      handlerRuns += 1;
      return { terminal: true };
    });

    await h.service.retryJob(job.id, OWNER);
    expect(h.worker.clearCalls).toEqual([job.id]);

    await h.worker.drainOnce();
    expect(handlerRuns).toBe(1);
    expect((await h.jobRepo.get(job.id))?.status).toBe("running");
  });
});

describe("expiry sweep", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("expires a completed job whose retention window has passed", async () => {
    const { job } = await submit(h);
    await h.service.startJob(job.id);
    await h.service.completeJob(job.id, outputResult(), 1);

    h.advance(PROCESSING_OUTPUT_TTL_MS + 1);
    const expirable = await h.jobRepo.listExpirable(h.clock.now);
    expect(expirable.map((j) => j.id)).toContain(job.id);

    expect(await h.service.expireJob(job.id)).toBe(true);
    expect((await h.jobRepo.get(job.id))?.status).toBe("expired");
  });

  it("expires a job whose staged input outlived the work", async () => {
    const { job } = await submit(h);
    h.advance(PROCESSING_OUTPUT_TTL_MS + 1);
    expect(await h.service.expireJob(job.id)).toBe(true);
  });

  it("leaves an already-expired job alone and reports the refusal", async () => {
    const { job } = await submit(h);
    await h.service.expireJob(job.id);
    expect(await h.service.expireJob(job.id)).toBe(false);
  });

  it("never offers the sweep a row the lifecycle cannot expire", async () => {
    // Otherwise the oldest-first, fixed-size batch fills with permanently
    // refused `failed`/`cancelled` rows and the sweep stops reaching the
    // completed jobs that still hold bytes.
    const failed = (await submit(h)).job;
    await h.service.startJob(failed.id);
    await h.service.failJob(failed.id, "corrupt_document", "d", 1);

    const cancelled = (await submit(h)).job;
    await h.service.cancelJob(cancelled.id, OWNER);

    const completed = (await submit(h)).job;
    await h.service.startJob(completed.id);
    await h.service.completeJob(completed.id, outputResult(), 1);

    h.advance(PROCESSING_OUTPUT_TTL_MS + 1);
    const due = await h.jobRepo.listExpirable(h.clock.now);
    const ids = due.map((j) => j.id);
    expect(ids).toContain(completed.id);
    expect(ids).not.toContain(failed.id);
    expect(ids).not.toContain(cancelled.id);

    // And every row it does offer can actually be expired, so a sweep converges.
    for (const j of due) expect(await h.service.expireJob(j.id)).toBe(true);
    expect(await h.jobRepo.listExpirable(h.clock.now)).toHaveLength(0);
  });

  it("returns false for an unknown job rather than throwing", async () => {
    expect(await h.service.expireJob("nope")).toBe(false);
  });

  it("stops listing a job once it is expired, so the sweep terminates", async () => {
    const { job } = await submit(h);
    h.advance(PROCESSING_OUTPUT_TTL_MS + 1);
    await h.service.expireJob(job.id);
    const again = await h.jobRepo.listExpirable(h.clock.now);
    expect(again.map((j) => j.id)).not.toContain(job.id);
  });
});

describe("toView — the only serialization path", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("exposes no storage keys, payload or internal diagnostics", async () => {
    const { job } = await submit(h);
    await h.service.startJob(job.id);
    await h.service.failJob(
      job.id,
      "processor_failed",
      "/tmp/pdfdadi/job_1/in.pdf: gs --dQUIET exited 1",
      1,
    );
    const view = await h.service.getJob(job.id, OWNER);
    const json = JSON.stringify(view);

    expect(json).not.toContain("/tmp");
    expect(json).not.toContain("gs ");
    expect(json).not.toContain("--dQUIET");
    expect(json).not.toContain(INPUT.key);
    expect(view).not.toHaveProperty("payload");
    expect(view).not.toHaveProperty("error");
    // What the user does get is the category's own safe sentence.
    expect(view.errorCategory).toBe("processor_failed");
    expect(view.errorMessage).toBeTruthy();
  });

  it("marks a completed job's result available and not cancellable", async () => {
    const { job } = await submit(h);
    await h.service.startJob(job.id);
    await h.service.completeJob(job.id, outputResult(999), 1);
    const view = await h.service.getJob(job.id, OWNER);
    expect(view.resultAvailable).toBe(true);
    expect(view.cancellable).toBe(false);
    expect(view.retryable).toBe(false);
    expect(view.outputBytes).toBe(999);
    expect(view.stage).toBe("done");
  });

  it("marks an active job cancellable and its result unavailable", async () => {
    const { job } = await submit(h);
    const queuedView = await h.service.getJob(job.id, OWNER);
    expect(queuedView.cancellable).toBe(true);
    expect(queuedView.resultAvailable).toBe(false);

    await h.service.startJob(job.id);
    const runningView = await h.service.getJob(job.id, OWNER);
    expect(runningView.cancellable).toBe(true);
    expect(runningView.resultAvailable).toBe(false);
    expect(runningView.stage).toBe("processing");
  });

  it("reports retryable only when the category is transient and budget remains", async () => {
    const { job } = await submit(h);
    await h.service.startJob(job.id);
    await h.service.failJob(job.id, "processor_timeout", "d", 1);
    expect((await h.service.getJob(job.id, OWNER)).retryable).toBe(true);

    const other = (await submit(h)).job;
    await h.service.startJob(other.id);
    await h.service.failJob(other.id, "corrupt_document", "d", 1);
    expect((await h.service.getJob(other.id, OWNER)).retryable).toBe(false);

    // The budget has to be spent on the ROW, not merely named in the call: a
    // worker's writes are fenced on the attempt it is reporting, so a `failJob`
    // that jumps straight to the last attempt is refused and leaves the job
    // `running` — where `retryable` is false for an unrelated reason and this
    // assertion would pass without testing anything.
    const spent = (await submit(h)).job;
    await h.service.startJob(spent.id);
    await h.jobRepo.update(spent.id, { attempts: MAX_PROCESSING_ATTEMPTS - 1 });
    expect(
      await h.service.failJob(spent.id, "processor_timeout", "d", MAX_PROCESSING_ATTEMPTS),
    ).toBe(true);
    expect((await h.service.getJob(spent.id, OWNER)).retryable).toBe(false);
  });

  it("stops reporting a result as available once retention lapses", async () => {
    const { job } = await submit(h);
    await h.service.startJob(job.id);
    await h.service.completeJob(job.id, outputResult(), 1);
    h.advance(PROCESSING_OUTPUT_TTL_MS + 1);
    const view = await h.service.getJob(job.id, OWNER);
    // The UI must not offer a Download button for bytes that are gone.
    expect(view.resultAvailable).toBe(false);
    expect(view.retryable).toBe(false);
  });
});

describe("startJob — the claim", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("claims a queued job exactly once", async () => {
    const { job } = await submit(h);
    expect(await h.service.startJob(job.id)).not.toBeNull();
    // The second caller is the second worker racing for the same id. It must
    // lose, or Ghostscript runs twice on one document.
    expect(await h.service.startJob(job.id)).toBeNull();
  });

  it("refuses to start a job cancelled while it waited in the queue", async () => {
    const { job } = await submit(h);
    await h.service.cancelJob(job.id, OWNER);
    expect(await h.service.startJob(job.id)).toBeNull();
  });

  it("returns null for an unknown id", async () => {
    expect(await h.service.startJob("nope")).toBeNull();
  });
});

describe("attempt fencing — a worker whose job was recovered writes nothing", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  /**
   * The real race, driven by the real sweep rather than a hand-written row:
   * worker A claims attempt 1, the lease goes stale, recovery requeues the job
   * and charges attempt 1, and worker B owns attempt 2. Every assertion below is
   * paired with the same call SUCCEEDING for worker B, because a refusal that
   * refuses everyone is not a fence.
   */
  async function supersede() {
    const { job } = await submit(h);
    await h.service.startJob(job.id);
    const recovery = new StuckJobRecoveryService({
      jobRepo: h.jobRepo,
      queue: h.queue,
      logger: new ConsoleLogger("error"),
      staleAfterMs: 0,
    });
    const summary = await recovery.recoverStale();
    // Without this the whole suite is vacuous: nothing was superseded, and the
    // "refused" writes below would be refused for want of a running row.
    expect(summary).toMatchObject({ examined: 1, requeued: 1 });
    expect((await h.jobRepo.get(job.id))!.attempts).toBe(1);
    return job.id;
  }

  it("refuses the stale attempt's completion and lets the successor's land", async () => {
    const id = await supersede();
    await h.service.startJob(id);
    expect(await h.service.completeJob(id, outputResult(), 1)).toBe(false);
    expect((await h.jobRepo.get(id))!.status).toBe("running");
    expect(await h.service.completeJob(id, outputResult(), 2)).toBe(true);
  });

  it("refuses the stale attempt's failure — the hole this slice closes", async () => {
    const id = await supersede();
    // Still `queued`: worker A wakes up before worker B has even claimed the
    // retry. `queued → failed` is a legal move, so only the fence stops it.
    expect((await h.jobRepo.get(id))!.status).toBe("queued");
    expect(await h.service.failJob(id, "processor_failed", "d", 1)).toBe(false);
    expect((await h.jobRepo.get(id))!.status).toBe("queued");
    await h.service.startJob(id);
    expect(await h.service.failJob(id, "processor_failed", "d", 2)).toBe(true);
  });

  it("refuses the stale attempt's cancellation", async () => {
    const id = await supersede();
    await h.service.startJob(id);
    expect(await h.service.markCancelled(id, 1)).toBe(false);
    expect((await h.jobRepo.get(id))!.status).toBe("running");
    expect(await h.service.markCancelled(id, 2)).toBe(true);
  });

  it("refuses the stale attempt's progress write, so it cannot refresh the lease", async () => {
    const id = await supersede();
    const claimed = (await h.service.startJob(id))!;
    await h.service.recordStage(id, "finalizing", 1);
    const after = (await h.jobRepo.get(id))!;
    // `updatedAt` IS the lease. A stale write that only bumped the timestamp
    // would keep a job nobody is running out of the sweep's reach forever.
    expect(after.progressStage).toBe(claimed.progressStage);
    expect(after.updatedAt.getTime()).toBe(claimed.updatedAt.getTime());
    await h.service.recordStage(id, "finalizing", 2);
    expect((await h.jobRepo.get(id))!.progressStage).toBe("finalizing");
  });

  it("tells a refused worker whether it was superseded or merely beaten to a terminal state", async () => {
    const id = await supersede();
    // Superseded: someone else owns the live attempt, so this worker owes the
    // job nothing — no retry, no refund.
    expect(await h.service.ownsAttempt(id, 1)).toBe(false);
    await h.service.startJob(id);
    expect(await h.service.ownsAttempt(id, 2)).toBe(true);

    // Beaten, but still the owner: the user cancelled while attempt 2 ran. The
    // attempt that went terminal is this worker's, and the settlement it owes
    // is the one that refunds the user.
    expect(await h.service.markCancelled(id, 2)).toBe(true);
    expect(await h.service.ownsAttempt(id, 2)).toBe(true);
  });
});

describe("queue handoff — a delivery failure must not strand the job", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  /**
   * Deterministic broken delivery: the status write lands, the push does not.
   *
   * Same shape as the recovery suite's adapter — the real queue with `requeue`
   * wrapped — because the failure being modelled is precisely "the second write
   * of a two-write handoff was lost", and a fully stubbed queue could not show
   * that the first one still landed.
   */
  function breakDelivery() {
    const push = h.queue.requeue.bind(h.queue);
    let works = false;
    const calls: string[] = [];
    h.queue.requeue = async (jobId: string) => {
      calls.push(jobId);
      if (!works) throw new Error("queue unavailable");
      await push(jobId);
    };
    return {
      calls,
      fix: () => {
        works = true;
      },
    };
  }

  /** A retryable `failed` row with its submission entry drained off the queue. */
  async function failedJob(category: JobErrorCategory = "processor_timeout") {
    const { job } = await submit(h);
    await h.queue.pull(0);
    await h.service.startJob(job.id);
    expect(await h.service.failJob(job.id, category, "internal diagnostic", 1)).toBe(true);
    return job.id;
  }

  it("does not leave a submission queued when its delivery fails", async () => {
    const delivery = breakDelivery();
    await expect(submit(h)).rejects.toThrow("queue unavailable");
    expect(delivery.calls).toHaveLength(1);

    // A `queued` row nothing will ever serve is the strand: no sweep looks at it
    // (`listStaleRunning` returns only `running`) and `retryJob` refuses anything
    // that is not `failed`/`cancelled`.
    expect(await h.jobRepo.listByStatus("queued")).toEqual([]);
    expect(await h.queue.pull(0)).toBeNull();

    const [row] = await h.jobRepo.listByStatus("failed");
    expect(row?.errorCategory).toBe("internal_error");
    // Nothing ran, so nothing is charged against the budget, and the two fields
    // the `→ queued` write touched are back as they were.
    expect(row?.attempts).toBe(0);
    expect(row?.queuedAt).toBeNull();
    expect(row?.progressStage).toBe("preparing");
  });

  it("leaves that submission in a state the existing retry path can act on", async () => {
    const delivery = breakDelivery();
    await expect(submit(h)).rejects.toThrow("queue unavailable");
    const id = (await h.jobRepo.listByStatus("failed"))[0]!.id;

    // The reason the rollback target is `failed`/`internal_error` and not
    // `created`: `internal_error` is retryable, so the affordance the user
    // already has is the recovery path. `created` is actionable by nothing.
    delivery.fix();
    expect((await h.service.retryJob(id, OWNER)).status).toBe("queued");
    expect((await h.queue.pull(0))?.id).toBe(id);
  });

  it("puts a retry back to its original failure, so another retry is still possible", async () => {
    const id = await failedJob("processor_timeout");
    const before = (await h.jobRepo.get(id))!;

    const delivery = breakDelivery();
    await expect(h.service.retryJob(id, OWNER)).rejects.toThrow("queue unavailable");

    // NOT `queued`. `queued` is exactly what `retryJob` refuses, so a queued row
    // left behind here would make every further retry impossible — the failure
    // this path must never produce, because it destroys the affordance the user
    // just pressed.
    const rolled = (await h.jobRepo.get(id))!;
    expect(rolled.status).toBe("failed");
    // The category has to come back too: `retryJob` reads it, and a null one
    // reads as `internal_error` — retryable by luck rather than by restoration.
    expect(rolled.errorCategory).toBe("processor_timeout");
    expect(rolled.error).toBe(before.error);
    expect(rolled.safeErrorMessage).toBe(before.safeErrorMessage);
    expect(rolled.finishedAt?.getTime()).toBe(before.finishedAt?.getTime());
    expect(rolled.startedAt?.getTime()).toBe(before.startedAt?.getTime());
    // The refused attempt consumed nothing.
    expect(rolled.attempts).toBe(1);
    expect(await h.queue.pull(0)).toBeNull();

    delivery.fix();
    const view = await h.service.retryJob(id, OWNER);
    expect(view.status).toBe("queued");
    expect(view.attempt).toBe(1);
    expect(view.maxAttempts).toBe(MAX_PROCESSING_ATTEMPTS);
    expect((await h.queue.pull(0))?.id).toBe(id);
  });

  it("puts a retried cancellation back to cancelled, not failed", async () => {
    const { job } = await submit(h);
    await h.queue.pull(0);
    expect((await h.service.cancelJob(job.id, OWNER)).stopped).toBe(true);
    const before = (await h.jobRepo.get(job.id))!;

    const delivery = breakDelivery();
    await expect(h.service.retryJob(job.id, OWNER)).rejects.toThrow("queue unavailable");

    // Restoring `failed` here would be wrong twice over: it misreports what the
    // user did, and it leaves `errorCategory: "cancelled"`, which
    // `isRetryableCategory` calls permanent — so the retry would be refused for
    // good rather than merely having failed once.
    const rolled = (await h.jobRepo.get(job.id))!;
    expect(rolled.status).toBe("cancelled");
    expect(rolled.errorCategory).toBe("cancelled");
    expect(rolled.cancelRequestedAt?.getTime()).toBe(before.cancelRequestedAt?.getTime());

    delivery.fix();
    expect((await h.service.retryJob(job.id, OWNER)).status).toBe("queued");
  });

  it("does not resurrect a job the user cancelled while the delivery was failing", async () => {
    const id = await failedJob("processor_failed");
    h.queue.requeue = async () => {
      // The user presses Cancel on the row that is `queued` for the moment the
      // push is in flight. `queued → cancelled` is legal, so the rollback's only
      // defence is that it re-reads before writing.
      await h.service.cancelJob(id, OWNER);
      throw new Error("queue unavailable");
    };

    await expect(h.service.retryJob(id, OWNER)).rejects.toThrow("queue unavailable");
    expect((await h.jobRepo.get(id))!.status).toBe("cancelled");
  });

  it("needs no rollback at all on the table-as-queue adapter", async () => {
    const logger = new ConsoleLogger("error");
    const jobRepo = new InMemoryJobRepository();
    const queue = new DatabaseQueue(jobRepo, logger, { types: [PROCESSING_JOB_TYPE] });
    const service = new ProcessingJobService({
      jobRepo,
      queue,
      worker: new RecordingWorker(queue, jobRepo, logger),
      logger,
    });

    const { job } = await service.submitJob({
      actor: OWNER,
      toolSlug: "compress-pdf",
      inputs: [INPUT],
      options: {},
    });
    expect(job.status).toBe("queued");

    // A different adapter instance — never told about this id, holding no
    // in-flight marker for it, sharing no state with the one the submission used
    // — serves it anyway. The `queued` row IS the entry here, so there is no
    // second write for a rollback to protect, and the fix cannot have weakened
    // what was already safe by construction.
    const neverToldAboutIt = new DatabaseQueue(jobRepo, logger, {
      types: [PROCESSING_JOB_TYPE],
    });
    expect((await neverToldAboutIt.pull(0))?.id).toBe(job.id);
  });
});
