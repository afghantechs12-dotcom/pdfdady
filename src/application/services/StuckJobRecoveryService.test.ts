import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { InMemoryJobRepository } from "@/src/infrastructure/persistence/InMemoryJobRepository";
import { InMemoryQueue } from "@/src/infrastructure/queue/InMemoryQueue";
import { DatabaseQueue } from "@/src/infrastructure/queue/DatabaseQueue";
import { InMemoryUsageRepository } from "@/src/infrastructure/persistence/InMemoryUsageRepository";
import { StaticEntitlementProvider } from "@/src/infrastructure/metering/OrganizationEntitlementProvider";
import { ConsoleLogger } from "@/src/infrastructure/logging/ConsoleLogger";
import { UsageMeteringService } from "./UsageMeteringService";
import { periodBoundsFor } from "@/src/domain/metering/periods";
import type { Job } from "@/src/domain/entities/Job";
import {
  PROCESSING_JOB_TYPE,
  type ProcessingJobPayload,
} from "./ProcessingJobService";
import {
  DEFAULT_STALE_AFTER_MS,
  StuckJobRecoveryService,
  startStuckJobRecovery,
} from "./StuckJobRecoveryService";

/**
 * Focused tests for stuck-job recovery.
 *
 * Every one of these drives the real service against the real in-memory job
 * repository and the real in-memory queue — not against a stubbed repository.
 * That is deliberate: the mechanism here is almost entirely *wiring*, and its two
 * plausible defects are a transition the state machine refuses (which a stub
 * would happily accept) and a status change that never reaches the queue adapter
 * (which a stub could not observe at all). A test suite that proved the decision
 * logic against fakes would stay green through both.
 *
 * The clock is injected everywhere. Recovery is defined by an elapsed interval,
 * so a test that waited for real time would either be slow or be lying about the
 * threshold it exercised.
 */

const TOOL = "compress-pdf";
const ACTOR = { ownerType: "user" as const, ownerId: "user-recovery" };
const T0 = new Date("2026-08-26T12:00:00.000Z");

/** Well past the stale threshold, so a job claimed at T0 is unambiguously stale. */
const LATER = new Date(T0.getTime() + DEFAULT_STALE_AFTER_MS + 60_000);

let repo: InMemoryJobRepository;
let queue: InMemoryQueue;
let usage: InMemoryUsageRepository;
let metering: UsageMeteringService;
const logger = new ConsoleLogger("error");

beforeEach(() => {
  repo = new InMemoryJobRepository();
  queue = new InMemoryQueue(repo, logger);
  usage = new InMemoryUsageRepository();
  metering = new UsageMeteringService({
    usage,
    entitlements: new StaticEntitlementProvider("free"),
    logger,
    mode: "enforce",
    now: () => T0,
  });
});

function build(now: () => Date, opts: { metering?: UsageMeteringService } = {}) {
  return new StuckJobRecoveryService({
    jobRepo: repo,
    queue,
    logger,
    metering: opts.metering,
    now,
  });
}

function payloadFor(overrides: Partial<ProcessingJobPayload> = {}): ProcessingJobPayload {
  return {
    toolSlug: TOOL,
    inputs: [{ key: "uploads/in.pdf", displayName: "in.pdf", bytes: 1_000_000 }],
    options: {},
    usage: { reservedAt: T0.toISOString() },
    ...overrides,
  } as ProcessingJobPayload;
}

/**
 * Creates a job and drives it to `running` through the real claim.
 *
 * Going through `transition` rather than writing the row directly is the point:
 * `running` is only reachable by the same compare-and-swap a worker uses, so a
 * test that hand-crafted the row could pin a state the product cannot produce.
 */
async function claimedJob(
  overrides: { attempts?: number; maxAttempts?: number; payload?: ProcessingJobPayload } = {},
): Promise<Job> {
  const created = await repo.create({
    type: PROCESSING_JOB_TYPE,
    payload: overrides.payload ?? payloadFor(),
    maxAttempts: overrides.maxAttempts ?? 3,
    ownerType: ACTOR.ownerType,
    ownerId: ACTOR.ownerId,
    toolSlug: TOOL,
    inputBytes: 1_000_000,
  });
  if (overrides.attempts !== undefined) {
    await repo.update(created.id, { attempts: overrides.attempts });
  }
  const claimed = await repo.transition(created.id, "running", { startedAt: new Date() });
  if (!claimed) throw new Error("claim was refused; the fixture is wrong");
  return claimed;
}

/**
 * The live row inside the repository.
 *
 * Reached directly for exactly one reason: `updatedAt` IS the lease, and every
 * public write refreshes it to the wall clock. "This row went quiet N minutes
 * ago" therefore has no expressible form through the port — the alternative is a
 * test that sleeps for the real threshold.
 */
function repoRow(jobId: string): Job {
  const jobs = (repo as unknown as { jobs: Map<string, Job> }).jobs;
  const row = jobs.get(jobId);
  if (!row) throw new Error("job vanished");
  return row;
}

/** Backdates the lease so the row looks abandoned, without waiting. */
function ageLease(jobId: string, to: Date): void {
  repoRow(jobId).updatedAt = to;
}

function operations(at = T0): number {
  return usage.counterAmount({
    ...ACTOR,
    meter: "server_operations",
    periodStart: periodBoundsFor("day", at).start,
  });
}

function attemptEvents(): Array<{ attempt: number | null; result: string | null }> {
  return usage
    .recordedEvents()
    .filter((e) => e.eventName === "tool_processing_completed")
    .map((e) => ({ attempt: e.attempt ?? null, result: e.result ?? null }));
}

// ---------------------------------------------------------------------------
// The invariant: a claimed job whose worker disappeared becomes claimable again
// ---------------------------------------------------------------------------

describe("a crashed worker leaves a recoverable job", () => {
  it("returns the abandoned job to the queue", async () => {
    const job = await claimedJob();
    ageLease(job.id, T0);

    // Precondition that must be observed to change: before recovery the row is
    // `running` and nothing is on the ready queue, which is exactly the stuck
    // state a killed worker leaves behind.
    expect((await repo.get(job.id))!.status).toBe("running");
    expect(await queue.pull(0)).toBeNull();

    const summary = await build(() => LATER).recoverStale();

    expect(summary).toMatchObject({ examined: 1, requeued: 1, skipped: 0 });
    expect((await repo.get(job.id))!.status).toBe("queued");
    // The status write alone is not recovery: a replacement worker pulls from the
    // queue, so the id has to be there too.
    expect((await queue.pull(0))?.id).toBe(job.id);
  });

  it("keeps the same logical job — id, payload and owner are untouched", async () => {
    const job = await claimedJob();
    ageLease(job.id, T0);

    await build(() => LATER).recoverStale();

    const after = (await repo.get(job.id))!;
    expect(after.id).toBe(job.id);
    expect(after.payload).toEqual(job.payload);
    expect(after.ownerId).toBe(ACTOR.ownerId);
    expect(after.toolSlug).toBe(TOOL);
    // No leftover failure text on a job that is about to run again — the status
    // view would show it to the user as the reason for a job that is queued.
    expect(after.safeErrorMessage).toBeNull();
    expect(after.errorCategory).toBeNull();
    expect(after.startedAt).toBeNull();
    expect(after.progressStage).toBe("queued");
  });
});

describe("the stale threshold", () => {
  it("leaves a fresh in-progress job alone", async () => {
    const job = await claimedJob();
    ageLease(job.id, T0);

    // One millisecond short of the threshold. The same fixture recovers in the
    // test above, so this is the boundary and not a vacuous pass.
    const justBefore = new Date(T0.getTime() + DEFAULT_STALE_AFTER_MS - 1);
    const summary = await build(() => justBefore).recoverStale();

    expect(summary.examined).toBe(0);
    expect((await repo.get(job.id))!.status).toBe("running");
  });

  it("recovers a job whose lease has aged past the threshold", async () => {
    const job = await claimedJob();
    ageLease(job.id, T0);

    const atThreshold = new Date(T0.getTime() + DEFAULT_STALE_AFTER_MS);
    const summary = await build(() => atThreshold).recoverStale();

    expect(summary.requeued).toBe(1);
    expect((await repo.get(job.id))!.status).toBe("queued");
  });

  it("treats a progress write as a heartbeat, so a working job is not reaped", async () => {
    // Two identically stale jobs, swept together against the real clock. The only
    // difference is that one of them reported a stage — which is what a live
    // worker does, and what refreshes `updatedAt`. If the lease were not that
    // column, both would be recovered and this test would fail on `quiet`.
    const ANCIENT = new Date("2020-01-01T00:00:00.000Z");
    const quiet = await claimedJob();
    const working = await claimedJob();
    ageLease(quiet.id, ANCIENT);
    ageLease(working.id, ANCIENT);

    await repo.update(working.id, { progressStage: "processing" });

    const summary = await build(() => new Date()).recoverStale();

    expect(summary.examined).toBe(1);
    expect((await repo.get(quiet.id))!.status).toBe("queued");
    expect((await repo.get(working.id))!.status).toBe("running");
  });
});

describe("concurrent recovery", () => {
  it("lets exactly one recoverer win", async () => {
    const job = await claimedJob();
    ageLease(job.id, T0);

    const a = build(() => LATER);
    const b = build(() => LATER);
    const [first, second] = await Promise.all([a.recoverStale(), b.recoverStale()]);

    // Both saw the row — that is the race being exercised, not avoided.
    expect(first.examined + second.examined).toBe(2);
    // But only one moved it.
    expect(first.requeued + second.requeued).toBe(1);
    expect(first.skipped + second.skipped).toBe(1);
    expect((await repo.get(job.id))!.status).toBe("queued");
    // One recovery, one queue entry: a second would run the job twice.
    expect((await queue.pull(0))?.id).toBe(job.id);
    expect(await queue.pull(0)).toBeNull();
  });

  it("charges the abandoned attempt exactly once across a contested recovery", async () => {
    const job = await claimedJob();
    ageLease(job.id, T0);

    await Promise.all([
      build(() => LATER).recoverStale(),
      build(() => LATER).recoverStale(),
    ]);

    // `attempts` counts finished attempts. One was abandoned, so one is charged —
    // not two, which would silently halve the retry budget.
    expect((await repo.get(job.id))!.attempts).toBe(1);
  });
});

describe("terminal jobs are never resurrected", () => {
  /** Drives a claimed job to a terminal status, then backdates its lease. */
  async function terminal(to: "completed" | "failed" | "cancelled"): Promise<Job> {
    const job = await claimedJob();
    const moved = await repo.transition(job.id, to, { finishedAt: new Date() });
    if (!moved) throw new Error(`could not reach ${to}; the fixture is wrong`);
    ageLease(job.id, T0);
    return moved;
  }

  it("never recovers a completed job", async () => {
    const job = await terminal("completed");
    // Precondition: the row is as old as the ones that DO get recovered above,
    // so age is not what is protecting it.
    expect(repoRow(job.id).updatedAt).toEqual(T0);

    const summary = await build(() => LATER).recoverStale();

    expect(summary.examined).toBe(0);
    expect((await repo.get(job.id))!.status).toBe("completed");
    expect(await queue.pull(0)).toBeNull();
  });

  it("never recovers a terminally failed job", async () => {
    const job = await terminal("failed");
    const summary = await build(() => LATER).recoverStale();

    expect(summary.examined).toBe(0);
    expect((await repo.get(job.id))!.status).toBe("failed");
    expect(await queue.pull(0)).toBeNull();
  });

  it("never recovers a cancelled job", async () => {
    const job = await terminal("cancelled");
    const summary = await build(() => LATER).recoverStale();

    expect(summary.examined).toBe(0);
    expect((await repo.get(job.id))!.status).toBe("cancelled");
    expect(await queue.pull(0)).toBeNull();
  });

  it("finishes the cancellation of a job the user cancelled mid-run", async () => {
    const job = await claimedJob();
    // The state a cancel request leaves while the worker is still holding the
    // job: still `running`, but marked. The worker died before it could confirm.
    await repo.update(job.id, { cancelRequestedAt: T0 });
    ageLease(job.id, T0);

    const summary = await build(() => LATER).recoverStale();

    expect(summary).toMatchObject({ examined: 1, cancelled: 1, requeued: 0 });
    expect((await repo.get(job.id))!.status).toBe("cancelled");
    // Requeueing it would restart work the user stopped, in a process whose
    // in-memory cancellation set is empty and would not stop it again.
    expect(await queue.pull(0)).toBeNull();
  });
});

describe("retry semantics", () => {
  it("charges the abandoned attempt so the budget shrinks", async () => {
    const job = await claimedJob({ attempts: 0, maxAttempts: 3 });
    ageLease(job.id, T0);

    await build(() => LATER).recoverStale();

    expect((await repo.get(job.id))!.attempts).toBe(1);
  });

  it("terminates instead of requeueing when the budget is spent", async () => {
    // Two attempts already finished; the abandoned one is the third and last.
    const job = await claimedJob({ attempts: 2, maxAttempts: 3 });
    ageLease(job.id, T0);

    const summary = await build(() => LATER).recoverStale();

    expect(summary).toMatchObject({ examined: 1, failed: 1, requeued: 0 });
    const after = (await repo.get(job.id))!;
    expect(after.status).toBe("failed");
    expect(after.attempts).toBe(3);
    expect(after.errorCategory).toBe("internal_error");
    // A user-safe sentence, not the internal diagnostic.
    expect(after.safeErrorMessage).toBe("Something went wrong on our side. Please try again.");
    expect(await queue.pull(0)).toBeNull();
  });

  it("cannot cycle forever: repeated crashes exhaust the budget", async () => {
    const job = await claimedJob({ attempts: 0, maxAttempts: 3 });
    const svc = build(() => LATER);

    // Three rounds of "claimed, then the worker died".
    for (let round = 0; round < 3; round++) {
      const current = (await repo.get(job.id))!;
      if (current.status === "queued") {
        const claimed = await repo.transition(job.id, "running", { startedAt: LATER });
        expect(claimed).not.toBeNull();
      }
      ageLease(job.id, T0);
      await svc.recoverStale();
      await queue.pull(0);
    }

    const after = (await repo.get(job.id))!;
    expect(after.status).toBe("failed");
    expect(after.attempts).toBe(3);
  });
});

describe("customer metering", () => {
  it("does not create a second customer charge when a job is recovered", async () => {
    // The submission reserved one operation. That is the customer charge.
    const admitted = await metering.authorize({
      actor: ACTOR,
      toolSlug: TOOL,
      executionMode: "remote_job",
      inputBytes: 1_000_000,
    });
    expect(admitted.allowed).toBe(true);
    expect(operations()).toBe(1);

    const job = await claimedJob();
    ageLease(job.id, T0);

    await build(() => LATER, { metering }).recoverStale();

    // Still one. Recovery reuses the row and its reservation; it has no path that
    // could admit the job a second time.
    expect(operations()).toBe(1);
    expect((await repo.get(job.id))!.status).toBe("queued");
  });

  it("records the abandoned attempt in compute telemetry when it terminates", async () => {
    const job = await claimedJob({ attempts: 2, maxAttempts: 3 });
    ageLease(job.id, T0);

    await build(() => LATER, { metering }).recoverStale();

    // One event, for attempt 3, recorded as a failure. Attempt telemetry is
    // per-attempt by design, and an abandoned attempt really did consume CPU.
    expect(attemptEvents()).toEqual([{ attempt: 3, result: "failure" }]);
  });

  it("refunds the reservation exactly once when recovery terminates the job", async () => {
    await metering.authorize({
      actor: ACTOR,
      toolSlug: TOOL,
      executionMode: "remote_job",
      inputBytes: 1_000_000,
    });
    expect(operations()).toBe(1);

    const job = await claimedJob({ attempts: 2, maxAttempts: 3 });
    ageLease(job.id, T0);
    await build(() => LATER, { metering }).recoverStale();
    expect(operations()).toBe(0);

    // A second sweep must not refund again. The job is terminal now, so it is not
    // a candidate — and even if it were, the settlement claim is once per job.
    await build(() => LATER, { metering }).recoverStale();
    expect(operations()).toBe(0);
  });

  it("does not settle a job it merely requeued", async () => {
    await metering.authorize({
      actor: ACTOR,
      toolSlug: TOOL,
      executionMode: "remote_job",
      inputBytes: 1_000_000,
    });
    const job = await claimedJob({ attempts: 0, maxAttempts: 3 });
    ageLease(job.id, T0);

    await build(() => LATER, { metering }).recoverStale();

    // The job is going to run again, so the allowance must stay held. Refunding
    // here and re-charging on the retry is how one job becomes two charges.
    expect(operations()).toBe(1);
    // Telemetry still records the attempt that died — per-attempt compute
    // accounting is not allowed to have a hole where a crash was.
    expect(attemptEvents()).toEqual([{ attempt: 1, result: "failure" }]);
  });

  it("recovers the job even when metering throws", async () => {
    const job = await claimedJob({ attempts: 2, maxAttempts: 3 });
    ageLease(job.id, T0);
    const exploding = {
      settleProcessingOutcome: async () => {
        throw new Error("metering is down");
      },
    } as unknown as UsageMeteringService;

    const summary = await build(() => LATER, { metering: exploding }).recoverStale();

    // Fail-open: an unstuck job matters more than a settled counter.
    expect(summary.failed).toBe(1);
    expect((await repo.get(job.id))!.status).toBe("failed");
  });
});

/**
 * The queue handoff — the seam between "the row says queued" and "something will
 * actually serve it".
 *
 * `recoverOne` makes a durable state change and then tells the queue adapter
 * about it. Those are two writes, and the second one can fail. Whether that
 * matters depends entirely on the adapter, so both answers are pinned here.
 */
describe("the recovery handoff cannot strand a job", () => {
  it("needs no enqueue side effect at all on the table-as-queue adapter", async () => {
    const dbQueue = new DatabaseQueue(repo, logger, { types: [PROCESSING_JOB_TYPE] });
    const job = await claimedJob();
    ageLease(job.id, T0);

    const summary = await new StuckJobRecoveryService({
      jobRepo: repo,
      queue: dbQueue,
      logger,
      now: () => LATER,
    }).recoverStale();
    expect(summary).toMatchObject({ examined: 1, requeued: 1, skipped: 0 });

    // The proof, and the reason the production worker is safe here by
    // construction: a *different* adapter instance — one that has never had
    // `requeue` called on it, never held an in-flight marker for this id, and
    // shares no state with the one the sweep used — serves the job anyway. Its
    // `queued` row IS the queue entry, so there is no second write to lose.
    const neverToldAboutIt = new DatabaseQueue(repo, logger, {
      types: [PROCESSING_JOB_TYPE],
    });
    expect((await neverToldAboutIt.pull(0))?.id).toBe(job.id);
  });

  it("rolls back to running when the ready-list push fails, and retries next pass", async () => {
    // maxAttempts 3 with one attempt already spent: the first pass charges the
    // abandoned attempt (2), which must NOT survive a failed handoff — a crash
    // the queue refused to accept has not consumed anything.
    const job = await claimedJob({ attempts: 1, maxAttempts: 3 });
    ageLease(job.id, T0);

    let handoffWorks = false;
    const push = queue.requeue.bind(queue);
    queue.requeue = async (jobId: string) => {
      if (!handoffWorks) throw new Error("queue unavailable");
      await push(jobId);
    };

    expect(await build(() => LATER).recoverStale()).toMatchObject({
      examined: 1,
      requeued: 0,
      skipped: 1,
    });

    // NOT `queued`. A `queued` row with nothing on the ready list is the strand:
    // `listStaleRunning` returns only `running`, and the user-facing retry
    // refuses anything that is not `failed`/`cancelled`, so nothing would ever
    // look at this row again.
    const rolledBack = (await repo.get(job.id))!;
    expect(rolledBack.status).toBe("running");
    expect(rolledBack.attempts).toBe(1);
    expect(rolledBack.startedAt).not.toBeNull();
    expect(await queue.pull(0)).toBeNull();

    // Once the restored lease goes stale again the sweep finds the same row and
    // completes the handoff — charging the abandoned attempt exactly once across
    // both passes, which is what proves the rollback restored the budget.
    handoffWorks = true;
    ageLease(job.id, T0);
    expect(await build(() => LATER).recoverStale()).toMatchObject({
      examined: 1,
      requeued: 1,
      skipped: 0,
    });
    expect((await repo.get(job.id))!.attempts).toBe(2);
    expect((await queue.pull(0))?.id).toBe(job.id);
  });
});

describe("the sweep is bounded", () => {
  it("examines at most the limit, oldest lease first", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const job = await claimedJob();
      // Staggered leases: the oldest must be the ones picked up.
      ageLease(job.id, new Date(T0.getTime() + i * 1_000));
      ids.push(job.id);
    }

    const summary = await build(() => LATER).recoverStale(2);

    expect(summary.examined).toBe(2);
    expect((await repo.get(ids[0]!))!.status).toBe("queued");
    expect((await repo.get(ids[1]!))!.status).toBe("queued");
    // Not touched this pass — a backlog degrades into several passes rather than
    // one sweep that rewrites the table.
    expect((await repo.get(ids[4]!))!.status).toBe("running");
  });

  it("keeps going when one job cannot be recovered", async () => {
    const good = await claimedJob();
    const bad = await claimedJob();
    ageLease(good.id, T0);
    ageLease(bad.id, new Date(T0.getTime() - 1_000));

    const svc = build(() => LATER);
    // The queue is what fails, after the status write — the realistic partial
    // failure, and the one that must not cost the remaining jobs their recovery.
    let calls = 0;
    const original = queue.requeue.bind(queue);
    queue.requeue = async (jobId: string) => {
      calls++;
      if (jobId === bad.id) throw new Error("queue unavailable");
      await original(jobId);
    };

    const summary = await svc.recoverStale();

    expect(calls).toBe(2);
    expect(summary.examined).toBe(2);
    expect(summary.requeued).toBe(1);
    expect(summary.skipped).toBe(1);
    expect((await repo.get(good.id))!.status).toBe("queued");
  });
});

describe("worker startup recovery", () => {
  it("sweeps immediately, before any timer fires", async () => {
    const job = await claimedJob();
    ageLease(job.id, T0);

    // A long interval: if the immediate pass did not happen, nothing would.
    const stop = startStuckJobRecovery(build(() => LATER), logger, 3_600_000);
    // The starter does not await its own tick (a boot must not block on a sweep),
    // so yield once for the promise chain it started.
    await new Promise((resolve) => setImmediate(resolve));
    stop();

    expect((await repo.get(job.id))!.status).toBe("queued");
  });

  it("survives a failing sweep without throwing at the caller", async () => {
    const broken = build(() => LATER);
    broken.recoverStale = async () => {
      throw new Error("database unavailable");
    };

    // Boot must not fail because recovery failed. Recovery is recovery, not a
    // precondition for serving traffic.
    const stop = startStuckJobRecovery(broken, logger, 3_600_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(() => stop()).not.toThrow();
  });
});

/**
 * The tuning knobs, which are read from the environment at module load.
 *
 * This is not paranoia about parsing: the probe run that added these tests hit it
 * for real. A non-numeric value made the threshold NaN, the cutoff an Invalid
 * Date, and the sweep a thrown query — recovery silently off, on the deployment
 * whose operator was mid-tune. A fallback is the only safe answer, because the
 * dangerous direction is "no recovery at all".
 */
describe("stale-threshold configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadWith(value: string | undefined): Promise<number> {
    vi.resetModules();
    if (value === undefined) vi.stubEnv("WORKER_STALE_JOB_AFTER_MS", undefined);
    else vi.stubEnv("WORKER_STALE_JOB_AFTER_MS", value);
    const mod = await import("./StuckJobRecoveryService");
    return mod.DEFAULT_STALE_AFTER_MS;
  }

  it("uses a valid override", async () => {
    expect(await loadWith("30000")).toBe(30_000);
  });

  it.each(["", "10m", "abc", "0", "-1", "undefined"])(
    "falls back to ten minutes for %o rather than disabling recovery",
    async (value) => {
      expect(await loadWith(value)).toBe(10 * 60_000);
    },
  );

  it("falls back when unset", async () => {
    expect(await loadWith(undefined)).toBe(10 * 60_000);
  });
});

describe("every process that drains jobs also sweeps", () => {
  /**
   * The sweep's behaviour is covered above; whether anything CALLS it is not.
   *
   * Deleting the call in `workerBootstrap.ts` leaves every test in this file
   * green and leaves the single-process production deployment — the web
   * container, which *is* the worker there — with no recovery at all. The
   * property is a call site existing in each process's startup path, so source
   * text is what it is. Comments are stripped first, so prose describing a call
   * can neither satisfy nor violate the assertion, this file's own included.
   */
  const startupOf = (rel: string): string =>
    readFileSync(join(process.cwd(), rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");

  it.each(["src/infrastructure/jobs/workerBootstrap.ts", "src/workers/processingWorker.ts"])(
    "%s starts the stale-job sweep",
    (rel) => {
      expect(startupOf(rel)).toContain("startStuckJobRecovery(");
    },
  );
});
