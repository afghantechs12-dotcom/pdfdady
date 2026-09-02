import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

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
  PdfToolJobService,
  type PdfToolBatchInput,
} from "@/src/application/services/PdfToolJobService";
import { UsageMeteringService } from "@/src/application/services/UsageMeteringService";
import { periodBoundsFor } from "@/src/domain/metering/periods";
import { ProcessingError, type ProcessContext, type ServerOutput } from "@/lib/server/toolProcessing";
import { CommandAbortedError } from "@/lib/server/runCommand";
import type { Job } from "@/src/domain/entities/Job";
import type { JobContext } from "@/src/application/ports/queue/Worker";
import {
  createPdfToolHandler,
  createPdfToolBatchHandler,
} from "./PdfToolWorkerHandler";

/**
 * Authoritative metering for the LEGACY server-tool path.
 *
 * All fourteen server tools run as `pdf-tool` / `pdf-tool-batch` jobs. Only
 * compress-pdf has a second path — the pilot pipeline, which it takes when the
 * `unified_processing_pipeline` flag is on and whose wiring
 * `meteringPipeline.test.ts` covers. Everything else, and compress-pdf itself
 * whenever the flag is off, arrives here. Nothing here re-tests the metering service:
 * `UsageMeteringService.test.ts` proves it settles correctly when it is called.
 * What is unproven — and what this repo has already shipped once with a green
 * suite — is that the legacy path CALLS it, with the outcome that actually
 * happened.
 *
 * Everything on the metering side is real: real service, real repository, real
 * counters, `mode: "enforce"` so a miscount surfaces as a wrong number rather
 * than being masked by observe mode letting everything through. Only the
 * processor is faked, because no external binary is installed in CI and none of
 * these assertions depend on real compression.
 *
 * The slug is `protect-pdf` rather than compress-pdf: a tool that is genuinely
 * unmigrated, so a test that passed only because the pilot handled it would fail.
 */

const ACTOR = { ownerType: "user" as const, ownerId: "user-legacy-1" };
const SLUG = "protect-pdf";
const INPUT = Buffer.from("%PDF-1.7\n% legacy input bytes\n");
const OUTPUT = Buffer.from("%PDF-1.7\n% protected\n");

const webStream = (data: Buffer): ReadableStream<Uint8Array> =>
  Readable.toWeb(Readable.from([data])) as ReadableStream<Uint8Array>;

/** Writes a fixed output file. No binaries, no network. */
function fakeProcessor(): (ctx: ProcessContext) => Promise<ServerOutput> {
  return async (ctx) => {
    const outPath = path.join(ctx.jobDir, `${ctx.baseName}-out.pdf`);
    await fs.writeFile(outPath, OUTPUT);
    return {
      outputPath: outPath,
      downloadName: `${ctx.baseName}-protected.pdf`,
      mimeType: "application/pdf",
    };
  };
}

const throwing = (err: unknown) => () => Promise.reject(err) as Promise<ServerOutput>;

interface Stack {
  jobRepo: InMemoryJobRepository;
  service: PdfToolJobService;
  usage: InMemoryUsageRepository;
  metering: UsageMeteringService;
  upload: UploadService;
  root: string;
  /** A handler wired to `metering` unless `opts.metering` overrides it. */
  handler(
    processor: (ctx: ProcessContext) => Promise<ServerOutput>,
    opts?: { metering?: UsageMeteringService | undefined; batch?: boolean },
  ): (job: Job, ctx: JobContext) => Promise<unknown>;
  ctx(jobId: string): JobContext;
  stage(data: Buffer): Promise<string>;
}

let stacks: Stack[] = [];
const cancelled = new Set<string>();

async function makeStack(): Promise<Stack> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-metering-"));
  const logger = new ConsoleLogger("error");
  const storage = new LocalFileStorage(path.join(root, "store"));
  const fileMeta = new InMemoryStoredFileRepository();
  const upload = new UploadService(storage, fileMeta, logger);
  const jobRepo = new InMemoryJobRepository();
  const queue = new InMemoryQueue(jobRepo, logger);
  const worker = new InMemoryWorker(queue, jobRepo, logger);
  const service = new PdfToolJobService(queue, jobRepo, worker);
  const usage = new InMemoryUsageRepository();
  const metering = new UsageMeteringService({
    usage,
    entitlements: new StaticEntitlementProvider("free"),
    logger,
    mode: "enforce",
  });

  const stack: Stack = {
    jobRepo,
    service,
    usage,
    metering,
    upload,
    root,
    handler: (processor, opts = {}) => {
      const deps = {
        storage,
        fileMeta,
        upload,
        jobRepo,
        logger,
        resolveProcessor: () => processor,
        metering: "metering" in opts ? opts.metering : metering,
        cancelPollMs: 10,
      };
      return (opts.batch ? createPdfToolBatchHandler(deps) : createPdfToolHandler(deps)) as (
        job: Job,
        ctx: JobContext,
      ) => Promise<unknown>;
    },
    ctx: (jobId) => ({
      progress: async () => {},
      isCancelled: () => cancelled.has(jobId),
    }),
    stage: async (data) => {
      const { file } = await stack.upload.uploadStream({
        ownerType: "anon",
        ownerId: "anon",
        originalName: "in.pdf",
        mimeType: "application/pdf",
        data: webStream(data),
        key: `tool-inputs/${Math.random().toString(36).slice(2)}/in.pdf`,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      return file.id;
    },
  };
  stacks.push(stack);
  return stack;
}

/**
 * Submits the way `submitToolJob` does: authorize FIRST, then enqueue carrying
 * the reservation, including the ISO round-trip that a refund has to survive.
 */
async function submit(s: Stack, opts: { files?: number } = {}): Promise<Job> {
  const count = opts.files ?? 1;
  const inputs: PdfToolBatchInput[] = [];
  for (let i = 0; i < count; i++) {
    inputs.push({
      fileId: await s.stage(INPUT),
      originalName: `in-${i}.pdf`,
      ext: ".pdf",
      baseName: `in-${i}`,
      size: INPUT.length,
    });
  }

  const authorization = await s.metering.authorize({
    actor: ACTOR,
    toolSlug: SLUG,
    executionMode: "remote_job",
    inputBytes: inputs.reduce((sum, i) => sum + i.size, 0),
    largestInputBytes: INPUT.length,
  });
  if (authorization.blocked) throw new Error("unexpectedly blocked");
  const usage = authorization.reservation
    ? { reservedAt: authorization.reservation.reservedAt.toISOString() }
    : null;

  if (count > 1) {
    return s.service.enqueueBatch({
      slug: SLUG,
      inputs,
      options: {},
      ownerType: "anon",
      ownerId: "anon",
      actor: ACTOR,
      usage,
    });
  }
  return s.service.enqueue({
    slug: SLUG,
    inputFileId: inputs[0].fileId,
    originalName: inputs[0].originalName,
    ext: ".pdf",
    baseName: inputs[0].baseName,
    inputSize: INPUT.length,
    options: {},
    ownerType: "anon",
    ownerId: "anon",
    actor: ACTOR,
    usage,
  });
}

/** The actor's charged operations for today. */
const operations = (s: Stack) =>
  s.usage.counterAmount({
    ...ACTOR,
    meter: "server_operations",
    periodStart: periodBoundsFor("day", new Date()).start,
  });

const computeUnits = (s: Stack) =>
  s.usage.counterAmount({
    ...ACTOR,
    meter: "compute_units",
    periodStart: periodBoundsFor("month", new Date()).start,
  });

const attempts = (s: Stack) =>
  s.usage.recordedEvents().filter((e) => e.eventName === "tool_processing_completed");

beforeEach(() => {
  stacks = [];
  cancelled.clear();
});

afterEach(async () => {
  for (const s of stacks) await fs.rm(s.root, { recursive: true, force: true });
  stacks = [];
});

// ---------------------------------------------------------------------------

describe("a legacy tool job that succeeds", () => {
  it("charges exactly one operation across submit and completion", async () => {
    const s = await makeStack();
    const job = await submit(s);
    expect(operations(s)).toBe(1);

    await s.handler(fakeProcessor())(job, s.ctx(job.id));

    // Still one: the reservation IS the charge, and completion settles it rather
    // than adding to it. Two would mean every server tool double-bills.
    expect(operations(s)).toBe(1);
    expect(attempts(s)).toHaveLength(1);
    expect(attempts(s)[0]).toMatchObject({
      toolSlug: SLUG,
      executionMode: "remote_job",
      result: "success",
      errorCategory: null,
      attempt: 1,
    });
  });

  it("records what actually happened, not an estimate", async () => {
    const s = await makeStack();
    const job = await submit(s);
    await s.handler(fakeProcessor())(job, s.ctx(job.id));

    const [event] = attempts(s);
    expect(event.inputBytes).toBe(INPUT.length);
    expect(event.outputBytes).toBe(OUTPUT.length);
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
    // Legacy processors return bytes and a name, never a page count. A number
    // here would be a fabrication in the column the cost model is calibrated on.
    expect(event.pageCount).toBeNull();
    // Compute is charged per attempt and is not the same meter as the operation.
    expect(computeUnits(s)).toBeGreaterThan(0);
  });

  it("files usage under the job row's owner, not the shared anon file bucket", async () => {
    const s = await makeStack();
    const job = await submit(s);
    await s.handler(fakeProcessor())(job, s.ctx(job.id));

    // Every legacy payload stages its input as ownerType "anon"/"anon". Settling
    // from the payload would file all usage in the world under one id.
    expect(operations(s)).toBe(1);
    expect(
      s.usage.counterAmount({
        ownerType: "anon",
        ownerId: "anon",
        meter: "server_operations",
        periodStart: periodBoundsFor("day", new Date()).start,
      }),
    ).toBe(0);
  });
});

describe("a legacy tool job that fails", () => {
  it("refunds the allowance and records the classified category", async () => {
    const s = await makeStack();
    const job = await submit(s);
    expect(operations(s)).toBe(1);

    await expect(
      s.handler(throwing(new ProcessingError("the document is not a PDF")))(job, s.ctx(job.id)),
    ).rejects.toThrow();

    // The user got nothing, so they are charged nothing.
    expect(operations(s)).toBe(0);
    const [event] = attempts(s);
    expect(event.result).toBe("failure");
    expect(event.errorCategory).toBe("processor_failed");
    // The normalized category only — never the thrown sentence.
    expect(JSON.stringify(event)).not.toContain("not a PDF");
  });

  it("counts a cancelled run as cancelled, so it is absent from the failure rate", async () => {
    const s = await makeStack();
    const job = await submit(s);
    cancelled.add(job.id);

    await expect(
      s.handler(throwing(new CommandAbortedError()))(job, s.ctx(job.id)),
    ).rejects.toThrow();

    expect(operations(s)).toBe(0);
    const [event] = attempts(s);
    expect(event.result).toBe("cancelled");
    expect(event.errorCategory).toBe("cancelled");
  });

  it("keeps the compute the attempt actually cost", async () => {
    // Infrastructure spend is not refundable: the binary ran. This is the
    // distinction between what the customer owes and what the work cost us.
    const s = await makeStack();
    const job = await submit(s);
    await expect(
      s.handler(throwing(new ProcessingError("boom")))(job, s.ctx(job.id)),
    ).rejects.toThrow();

    expect(operations(s)).toBe(0);
    expect(computeUnits(s)).toBeGreaterThan(0);
  });
});

describe("a batch submission", () => {
  it("is one customer operation, not one per file", async () => {
    const s = await makeStack();
    const job = await submit(s, { files: 3 });
    expect(operations(s)).toBe(1);

    await s.handler(fakeProcessor(), { batch: true })(job, s.ctx(job.id));

    // Three files is one thing the user asked for. Counting three would make
    // "operations" mean "files", which no plan line says.
    expect(operations(s)).toBe(1);
    expect(attempts(s)).toHaveLength(1);
    expect(attempts(s)[0].inputBytes).toBe(INPUT.length * 3);
  });

  it("refunds that one operation when the batch fails", async () => {
    const s = await makeStack();
    const job = await submit(s, { files: 3 });
    await expect(
      s.handler(throwing(new ProcessingError("boom")), { batch: true })(job, s.ctx(job.id)),
    ).rejects.toThrow();
    expect(operations(s)).toBe(0);
  });
});

describe("metering can never cost the user their result", () => {
  it("completes the job when settlement throws", async () => {
    const s = await makeStack();
    const job = await submit(s);
    const exploding = {
      settleProcessingOutcome: () => Promise.reject(new Error("meter offline")),
    } as unknown as UsageMeteringService;

    const result = await s.handler(fakeProcessor(), { metering: exploding })(
      job,
      s.ctx(job.id),
    );

    // The output is already in storage by the time settlement runs. A metering
    // outage that failed the job would make measurement a dependency of the
    // product, which is backwards.
    expect((result as { result?: { resultSize?: number } }).result?.resultSize).toBe(
      OUTPUT.length,
    );
  });

  it("completes the job when no metering service is wired at all", async () => {
    const s = await makeStack();
    const job = await submit(s);
    const result = await s.handler(fakeProcessor(), { metering: undefined })(
      job,
      s.ctx(job.id),
    );
    expect((result as { result?: { resultSize?: number } }).result?.resultSize).toBe(
      OUTPUT.length,
    );
  });

  it("still reports the failure when settlement throws on the failure path", async () => {
    const s = await makeStack();
    const job = await submit(s);
    const exploding = {
      settleProcessingOutcome: () => Promise.reject(new Error("meter offline")),
    } as unknown as UsageMeteringService;

    await expect(
      s.handler(throwing(new ProcessingError("boom")), { metering: exploding })(
        job,
        s.ctx(job.id),
      ),
    ).rejects.toThrow(/boom/);
  });
});

describe("the attempt-numbering assumption is pinned", () => {
  /**
   * `settleToolJobUsage` passes `willRetry: false` unconditionally, which is only
   * correct while these job types are enqueued with `maxAttempts: 1`. If that
   * ever changes, a retryable failure would settle — refunding an allowance for
   * a job that is about to run again — so the constant is asserted rather than
   * left as a comment.
   */
  it("enqueues single and batch legacy jobs with exactly one attempt", async () => {
    const s = await makeStack();
    const single = await submit(s);
    const batch = await submit(s, { files: 2 });
    expect(single.maxAttempts).toBe(1);
    expect(batch.maxAttempts).toBe(1);
  });
});
