import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { LocalFileStorage } from "@/src/infrastructure/storage/LocalFileStorage";
import { InMemoryStoredFileRepository } from "@/src/infrastructure/persistence/InMemoryStoredFileRepository";
import { InMemoryJobRepository } from "@/src/infrastructure/persistence/InMemoryJobRepository";
import { InMemoryQueue } from "@/src/infrastructure/queue/InMemoryQueue";
import { InMemoryWorker } from "@/src/infrastructure/queue/InMemoryWorker";
import { InMemoryUsageRepository } from "@/src/infrastructure/persistence/InMemoryUsageRepository";
import { StaticEntitlementProvider } from "@/src/infrastructure/metering/OrganizationEntitlementProvider";
import { UploadService } from "@/src/application/services/UploadService";
import { ConsoleLogger } from "@/src/infrastructure/logging/ConsoleLogger";
import {
  ProcessingJobService,
  PROCESSING_JOB_TYPE,
} from "@/src/application/services/ProcessingJobService";
import { ProcessingUsageRecorder } from "@/src/application/services/ProcessingUsageRecorder";
import { UsageMeteringService } from "@/src/application/services/UsageMeteringService";
import type {
  IToolProcessorRegistry,
  ProcessingContext,
  ProcessingOutcome,
  ToolProcessor,
} from "@/src/application/ports/processing/ToolProcessor";
import { ProcessorNotFoundError } from "@/src/application/ports/processing/ToolProcessor";
import type { JobContext } from "@/src/application/ports/queue/Worker";
import type { Job } from "@/src/domain/entities/Job";
import { MissingDependencyError } from "@/lib/server/dependencyCheck";
import { ProcessingError } from "@/lib/server/toolProcessing";
import { periodBoundsFor } from "@/src/domain/metering/periods";
import { createProcessingJobHandler } from "./ProcessingJobHandler";

/**
 * The seam between the worker and the metering service.
 *
 * `UsageMeteringService.test.ts` proves the service settles correctly when it is
 * *called*. This file proves the pipeline calls it — with the right result, the
 * right attempt number, and the reservation the submission actually took. Those
 * are separate failures: a handler that never wires `metering` leaves every
 * service test green while nothing in production is ever metered, which is the
 * shape of bug this repo has already shipped once with a green suite.
 *
 * The processor is faked (no Ghostscript) because nothing here depends on real
 * compression. Everything on the metering side is real: real service, real
 * repository, real counters.
 */

const INPUT_BYTES = Buffer.from("%PDF-1.7\n% original document bytes\n");
const ACTOR = { ownerType: "user" as const, ownerId: "user-1" };

class SingleProcessorRegistry implements IToolProcessorRegistry {
  constructor(private readonly processor: ToolProcessor) {}
  get(slug: string) {
    return slug === this.processor.id ? this.processor : undefined;
  }
  require(slug: string) {
    const p = this.get(slug);
    if (!p) throw new ProcessorNotFoundError(slug);
    return p;
  }
  has(slug: string) {
    return this.get(slug) !== undefined;
  }
  ids() {
    return [this.processor.id];
  }
}

function processor(
  body: (ctx: ProcessingContext) => Promise<ProcessingOutcome>,
): ToolProcessor {
  return { id: "compress-pdf", timeoutMs: 10_000, process: (ctx) => body(ctx) };
}

const succeed = () =>
  processor(async (ctx) => {
    const out = path.join(ctx.workDir, `${ctx.baseName}-out.pdf`);
    await fs.writeFile(out, Buffer.from("%PDF-1.7\n% smaller\n"));
    return {
      outputPath: out,
      downloadName: `${ctx.baseName}-compressed.pdf`,
      mimeType: "application/pdf",
      pageCount: 3,
    };
  });

/** Fails in a way the retry policy considers worth another attempt. */
const failRetryably = () =>
  processor(async () => {
    throw new MissingDependencyError("gs");
  });

/** Fails in a way no further attempt could fix. */
const failPermanently = () =>
  processor(async () => {
    throw new ProcessingError("the document is not a PDF");
  });

interface Stack {
  storage: LocalFileStorage;
  jobRepo: InMemoryJobRepository;
  jobs: ProcessingJobService;
  usage: InMemoryUsageRepository;
  metering: UsageMeteringService;
  storageRoot: string;
  cancelled: Set<string>;
  handler(p: ToolProcessor): ReturnType<typeof createProcessingJobHandler>;
  ctx(jobId: string): JobContext;
}

let stacks: Stack[] = [];

async function makeStack(): Promise<Stack> {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "metering-wiring-"));
  const logger = new ConsoleLogger("error");
  const storage = new LocalFileStorage(storageRoot);
  const files = new InMemoryStoredFileRepository();
  const upload = new UploadService(storage, files, logger);
  const jobRepo = new InMemoryJobRepository();
  const queue = new InMemoryQueue(jobRepo, logger);
  const worker = new InMemoryWorker(queue, jobRepo, logger);
  const jobs = new ProcessingJobService({ jobRepo, queue, worker, logger });
  const usage = new InMemoryUsageRepository();
  const metering = new UsageMeteringService({
    usage,
    entitlements: new StaticEntitlementProvider("free"),
    logger,
    // Enforcing, so a miscounted meter shows up as a wrong number here rather
    // than being masked by observe mode letting everything through.
    mode: "enforce",
  });
  const cancelled = new Set<string>();

  const stack: Stack = {
    storage,
    jobRepo,
    jobs,
    usage,
    metering,
    storageRoot,
    cancelled,
    handler: (p) =>
      createProcessingJobHandler({
        storage,
        upload,
        jobs,
        processors: new SingleProcessorRegistry(p),
        usage: new ProcessingUsageRecorder(
          { track: () => {}, identify: () => {} } as never,
          {
            increment: () => {},
            histogram: () => {},
            gauge: () => {},
            timing: () => {},
          } as never,
          logger,
        ),
        metering,
        logger,
        cancelPollMs: 20,
      }),
    ctx: (jobId) => ({
      progress: async () => {},
      isCancelled: () => cancelled.has(jobId),
    }),
  };
  stacks.push(stack);
  return stack;
}

/**
 * Submits the way the route does: reserve first, then create the job carrying
 * the reservation, then queue it.
 *
 * This is the real `UsageMeteringService.authorize`, and the payload's `usage`
 * field is written from its reservation exactly as `submitProcessingJob` writes
 * it — including the ISO round-trip, which is where a Date silently becoming a
 * string would otherwise go unnoticed until a refund landed in the wrong day.
 */
async function submit(
  s: Stack,
  opts: {
    maxAttempts?: number;
    skipReservation?: boolean;
    /** Overrides the instant the reservation claims to have been taken. */
    reservedAt?: Date;
    /** Extra client-controlled payload fields, for the spoofing tests. */
    options?: Record<string, string>;
  } = {},
): Promise<Job> {
  const key = `processing-inputs/${Math.random().toString(36).slice(2)}/in.pdf`;
  await s.storage.put(key, INPUT_BYTES, { contentType: "application/pdf" });

  const authorization = opts.skipReservation
    ? null
    : await s.metering.authorize({
        actor: ACTOR,
        toolSlug: "compress-pdf",
        executionMode: "remote_job",
        inputBytes: INPUT_BYTES.length,
        largestInputBytes: INPUT_BYTES.length,
      });
  if (authorization?.blocked) throw new Error("unexpectedly blocked");

  const { job } = await s.jobs.createJob({
    actor: ACTOR,
    toolSlug: "compress-pdf",
    inputs: [{ key, displayName: "document.pdf", bytes: INPUT_BYTES.length }],
    options: opts.options ?? {},
    idempotencyKey: null,
    maxAttempts: opts.maxAttempts ?? 3,
    usage: authorization?.reservation
      ? {
          reservedAt: (
            opts.reservedAt ?? authorization.reservation.reservedAt
          ).toISOString(),
        }
      : null,
  });
  await s.jobs.queueJob(job.id);
  const claimed = await s.jobs.startJob(job.id);
  if (!claimed) throw new Error("job could not be claimed");
  return claimed;
}

/** The actor's charged operations for today. */
function operations(s: Stack): number {
  return s.usage.counterAmount({
    ...ACTOR,
    meter: "server_operations",
    periodStart: periodBoundsFor("day", new Date()).start,
  });
}

function computeUnits(s: Stack): number {
  return s.usage.counterAmount({
    ...ACTOR,
    meter: "compute_units",
    periodStart: periodBoundsFor("month", new Date()).start,
  });
}

function attemptEvents(s: Stack) {
  return s.usage
    .recordedEvents()
    .filter((e) => e.eventName === "tool_processing_completed");
}

beforeEach(() => {
  stacks = [];
});

afterEach(async () => {
  for (const s of stacks) {
    await fs.rm(s.storageRoot, { recursive: true, force: true });
  }
  stacks = [];
});

// ---------------------------------------------------------------------------

describe("a successful job", () => {
  it("consumes exactly one operation across submit and completion", async () => {
    const s = await makeStack();
    const job = await submit(s);
    expect(operations(s)).toBe(1);

    await s.handler(succeed())(job, s.ctx(job.id));

    expect((await s.jobRepo.get(job.id))?.status).toBe("completed");
    // Still one. The submission's reservation IS the charge; completion settles
    // it rather than adding to it.
    expect(operations(s)).toBe(1);
    expect(attemptEvents(s)).toHaveLength(1);
  });

  it("is not charged again if the worker settles the same job twice", async () => {
    const s = await makeStack();
    const job = await submit(s);

    const handler = s.handler(succeed());
    await handler(job, s.ctx(job.id));
    // A redelivered job — the same completion arriving a second time, which a
    // queue at-least-once delivery guarantee makes ordinary rather than exotic.
    await s.metering.settleProcessingOutcome({
      jobId: job.id,
      actor: ACTOR,
      toolSlug: "compress-pdf",
      executionMode: "remote_job",
      result: "success",
      attempt: 1,
      willRetry: false,
      inputBytes: INPUT_BYTES.length,
      outputBytes: 100,
      pageCount: 3,
      durationMs: 10,
      errorCategory: null,
      reservation: null,
    });

    expect(operations(s)).toBe(1);
    expect(attemptEvents(s)).toHaveLength(1);
  });
});

describe("a retried job", () => {
  it("charges one customer operation for two worker attempts", async () => {
    const s = await makeStack();
    const job = await submit(s, { maxAttempts: 2 });
    const handler = s.handler(failRetryably());

    await handler(job, s.ctx(job.id));
    // The first attempt failed retryably, so the job is queued again and the
    // allowance stays held: the user still asked for one operation.
    expect((await s.jobRepo.get(job.id))?.status).toBe("queued");
    expect(operations(s)).toBe(1);

    const second = await s.jobs.startJob(job.id);
    await s.handler(succeed())(second!, s.ctx(job.id));

    expect((await s.jobRepo.get(job.id))?.status).toBe("completed");
    // Two attempts, one operation. Charging per attempt would bill a user for
    // our own infrastructure flapping.
    expect(operations(s)).toBe(1);
  });

  it("keeps both attempts visible, and costs compute for both", async () => {
    const s = await makeStack();
    const job = await submit(s, { maxAttempts: 2 });

    await s.handler(failRetryably())(job, s.ctx(job.id));
    const afterFirst = computeUnits(s);
    const second = await s.jobs.startJob(job.id);
    await s.handler(succeed())(second!, s.ctx(job.id));

    expect(attemptEvents(s).map((e) => e.attempt)).toEqual([1, 2]);
    expect(attemptEvents(s).map((e) => e.result)).toEqual(["failure", "success"]);
    // The second run really consumed a worker slot and a Ghostscript process, so
    // the infrastructure meter has to see it even though the customer meter does
    // not.
    expect(afterFirst).toBeGreaterThan(0);
    expect(computeUnits(s)).toBeGreaterThan(afterFirst);
  });
});

describe("a permanently failed job", () => {
  it("refunds the operation", async () => {
    const s = await makeStack();
    const job = await submit(s, { maxAttempts: 1 });
    expect(operations(s)).toBe(1);

    await s.handler(failPermanently())(job, s.ctx(job.id));

    expect((await s.jobRepo.get(job.id))?.status).toBe("failed");
    // Nothing was delivered, so nothing is owed.
    expect(operations(s)).toBe(0);
    // The attempt still happened and still cost us compute.
    expect(attemptEvents(s)).toHaveLength(1);
    expect(computeUnits(s)).toBeGreaterThan(0);
  });

  it("refunds when the last attempt of a retryable failure is spent", async () => {
    const s = await makeStack();
    const job = await submit(s, { maxAttempts: 1 });

    await s.handler(failRetryably())(job, s.ctx(job.id));

    expect((await s.jobRepo.get(job.id))?.status).toBe("failed");
    expect(operations(s)).toBe(0);
  });
});

describe("a cancelled job", () => {
  it("refunds the operation", async () => {
    const s = await makeStack();
    const job = await submit(s);
    s.cancelled.add(job.id);

    await s.handler(succeed())(job, s.ctx(job.id));

    expect((await s.jobRepo.get(job.id))?.status).toBe("cancelled");
    expect(operations(s)).toBe(0);
  });
});

describe("the reservation carried in the payload", () => {
  it("is what the refund credits, not the settlement's own clock", async () => {
    const s = await makeStack();
    const yesterday = new Date(Date.now() - 26 * 3_600_000);
    // A reservation taken in a previous window, the way a long-queued job's would
    // read. The charge itself lands in today's counter, because the reservation
    // really was taken now — only the payload's recorded instant is backdated,
    // which is exactly the state the worker sees for a job that spanned midnight.
    const job = await submit(s, { maxAttempts: 1, reservedAt: yesterday });
    expect(operations(s)).toBe(1);

    await s.handler(failPermanently())(job, s.ctx(job.id));

    // Today is untouched: the refund went to the window the charge was in.
    // Crediting today instead would leave the old window permanently
    // over-counted and hand out an extra operation today.
    expect(operations(s)).toBe(1);
    expect(
      s.usage.counterAmount({
        ...ACTOR,
        meter: "server_operations",
        periodStart: periodBoundsFor("day", yesterday).start,
      }),
    ).toBe(0);
  });

  it("is absent on a job created before this seam existed, and settles harmlessly", async () => {
    const s = await makeStack();
    // No reservation at all — a job already in the queue when metering shipped.
    const job = await submit(s, { maxAttempts: 1, skipReservation: true });
    expect(operations(s)).toBe(0);

    await s.handler(failPermanently())(job, s.ctx(job.id));

    // No refund invented for a charge that never happened.
    expect(operations(s)).toBe(0);
    expect((await s.jobRepo.get(job.id))?.status).toBe("failed");
  });
});

describe("ownership", () => {
  it("charges the job row's owner, which the browser never wrote", async () => {
    const s = await makeStack();
    // One attempt, so the failure below is terminal and actually settles rather
    // than parking the allowance for a retry. `options` is the genuinely
    // client-controlled part of the payload — a form field is how a spoofed owner
    // would actually arrive — and the handler reads `job.ownerId`, a column the
    // server wrote from the session, so the payload cannot redirect the charge.
    const job = await submit(s, {
      maxAttempts: 1,
      options: {
        ownerId: "victim-user",
        ownerType: "user",
        actor: JSON.stringify({ ownerType: "user", ownerId: "victim-user" }),
      },
    });

    await s.handler(failPermanently())(job, s.ctx(job.id));

    // The refund landed on the real owner, and the impersonated user's meters
    // were never touched in either direction.
    expect(operations(s)).toBe(0);
    expect(
      s.usage.counterAmount({
        ownerType: "user",
        ownerId: "victim-user",
        meter: "server_operations",
        periodStart: periodBoundsFor("day", new Date()).start,
      }),
    ).toBe(0);
    expect(s.usage.recordedEvents().every((e) => e.ownerType === "user")).toBe(true);
  });
});

describe("a metering outage", () => {
  it("does not fail the job it was measuring", async () => {
    const s = await makeStack();
    const job = await submit(s);
    // Every metering write now throws, mid-job.
    s.metering.settleProcessingOutcome = async () => {
      throw new Error("usage database is unreachable");
    };

    await s.handler(succeed())(job, s.ctx(job.id));

    // The user still gets their compressed PDF. Metering is bookkeeping; it is
    // never a reason to lose completed work.
    const row = await s.jobRepo.get(job.id);
    expect(row?.status).toBe("completed");
    expect(row?.result).toBeTruthy();
  });
});
