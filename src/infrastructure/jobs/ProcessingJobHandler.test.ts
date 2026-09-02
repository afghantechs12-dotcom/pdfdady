import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { LocalFileStorage } from "@/src/infrastructure/storage/LocalFileStorage";
import { InMemoryStoredFileRepository } from "@/src/infrastructure/persistence/InMemoryStoredFileRepository";
import { InMemoryJobRepository } from "@/src/infrastructure/persistence/InMemoryJobRepository";
import { InMemoryQueue } from "@/src/infrastructure/queue/InMemoryQueue";
import { InMemoryWorker } from "@/src/infrastructure/queue/InMemoryWorker";
import { UploadService } from "@/src/application/services/UploadService";
import { ConsoleLogger } from "@/src/infrastructure/logging/ConsoleLogger";
import {
  ProcessingJobService,
  PROCESSING_JOB_TYPE,
  type ProcessingJobResult,
} from "@/src/application/services/ProcessingJobService";
import {
  ProcessingUsageRecorder,
  type ProcessingUsageEvent,
} from "@/src/application/services/ProcessingUsageRecorder";
import type {
  IToolProcessorRegistry,
  ProcessingContext,
  ProcessingOutcome,
  ToolProcessor,
} from "@/src/application/ports/processing/ToolProcessor";
import { ProcessorNotFoundError } from "@/src/application/ports/processing/ToolProcessor";
import type { JobContext } from "@/src/application/ports/queue/Worker";
import type { Job } from "@/src/domain/entities/Job";
import type { JobProgressStage } from "@/src/domain/jobs/progressStage";
import { CommandAbortedError } from "@/lib/server/runCommand";
import { MissingDependencyError } from "@/lib/server/dependencyCheck";
import { ProcessingError } from "@/lib/server/toolProcessing";
import { processingTempRoot } from "@/lib/server/tempFiles";
import { StuckJobRecoveryService } from "@/src/application/services/StuckJobRecoveryService";
import { createProcessingJobHandler } from "./ProcessingJobHandler";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const INPUT_BYTES = Buffer.from("%PDF-1.7\n% original document bytes\n");

/**
 * Records log lines so the handler's own decisions are observable.
 *
 * Needed because the retry gate here is deliberately redundant with the one in
 * `ProcessingJobService.retryJob`: if the handler wrongly offers a permanent
 * failure for retry, the service still refuses it and the job still ends up
 * `failed`, so the final state proves nothing about which gate did the work.
 * The refusal is logged, and that log line is the difference.
 */
class CapturingLogger extends ConsoleLogger {
  readonly warnings: string[] = [];
  constructor() {
    super("error");
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.warnings.push(message);
    super.warn(message, fields);
  }
}

/** Emitted by the handler when it asked for a retry the service refused. */
const RETRY_REFUSED_LOG = "Automatic retry could not be scheduled";

/**
 * The real service with one deliberately slow write.
 *
 * Nothing is faked — `recordStage` performs the same repository update through
 * the same code path, it just takes long enough for the ordering against
 * completion to be observable. The delay is the whole point: the race is real
 * without it, but on an in-memory repository the write almost always lands the
 * harmless way, which is exactly how it survived a green suite and only appeared
 * in a browser, as a `completed` row whose stage read `finalizing`.
 */
class SlowStageService extends ProcessingJobService {
  /** Stages whose write has actually been applied, in the order they applied. */
  readonly applied: string[] = [];
  constructor(
    deps: ConstructorParameters<typeof ProcessingJobService>[0],
    private readonly delayMs: number,
  ) {
    super(deps);
  }
  async recordStage(
    jobId: string,
    stage: JobProgressStage,
    attempt: number,
  ): Promise<void> {
    await sleep(this.delayMs);
    // The attempt is forwarded, not dropped: `recordStage` is fenced on it, and
    // an override that swallowed it would quietly test an unfenced stage write.
    await super.recordStage(jobId, stage, attempt);
    this.applied.push(stage);
  }
}

/** Collects usage events instead of shipping them, so they can be asserted. */
class CapturingUsage extends ProcessingUsageRecorder {
  readonly events: ProcessingUsageEvent[] = [];
  constructor() {
    const logger = new ConsoleLogger("error");
    super(
      { track: () => {}, identify: () => {} } as never,
      {
        increment: () => {},
        histogram: () => {},
        gauge: () => {},
        timing: () => {},
      } as never,
      logger,
    );
  }
  record(event: ProcessingUsageEvent): void {
    this.events.push(event);
    super.record(event);
  }
}

/** One-processor registry; no DI container, no real tool binaries. */
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

interface ProcessorSpy {
  calls: ProcessingContext[];
  /** Paths the processor observed as existing while it ran. */
  sawInput: string[];
}

function processor(
  id: string,
  timeoutMs: number,
  body: (ctx: ProcessingContext, spy: ProcessorSpy) => Promise<ProcessingOutcome>,
): { processor: ToolProcessor; spy: ProcessorSpy } {
  const spy: ProcessorSpy = { calls: [], sawInput: [] };
  return {
    spy,
    processor: {
      id,
      timeoutMs,
      async process(ctx) {
        spy.calls.push(ctx);
        if (await fs.stat(ctx.inputPath).then(() => true, () => false)) {
          spy.sawInput.push(ctx.inputPath);
        }
        return body(ctx, spy);
      },
    },
  };
}

/** A processor that writes a plausible output and returns. */
function successBody(bytes = Buffer.from("%PDF-1.7\n% smaller\n")) {
  return async (ctx: ProcessingContext): Promise<ProcessingOutcome> => {
    const out = path.join(ctx.workDir, `${ctx.baseName}-out.pdf`);
    await fs.writeFile(out, bytes);
    return {
      outputPath: out,
      downloadName: `${ctx.baseName}-compressed.pdf`,
      mimeType: "application/pdf",
      pageCount: 3,
    };
  };
}

interface Harness {
  storage: LocalFileStorage;
  logger: CapturingLogger;
  files: InMemoryStoredFileRepository;
  upload: UploadService;
  jobRepo: InMemoryJobRepository;
  queue: InMemoryQueue;
  jobs: ProcessingJobService;
  usage: CapturingUsage;
  worker: InMemoryWorker;
  storageRoot: string;
  cancelled: Set<string>;
  ctx(jobId: string): JobContext;
  progressFrames: Array<{ pct: number; detail?: string }>;
}

let harnesses: Harness[] = [];

async function makeHarness(
  opts: { stageDelayMs?: number } = {},
): Promise<Harness> {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pjh-store-"));
  const logger = new CapturingLogger();
  const storage = new LocalFileStorage(storageRoot);
  const files = new InMemoryStoredFileRepository();
  const upload = new UploadService(storage, files, logger);
  const jobRepo = new InMemoryJobRepository();
  const queue = new InMemoryQueue(jobRepo, logger);
  const worker = new InMemoryWorker(queue, jobRepo, logger);
  const jobs = opts.stageDelayMs
    ? new SlowStageService({ jobRepo, queue, worker, logger }, opts.stageDelayMs)
    : new ProcessingJobService({ jobRepo, queue, worker, logger });
  const usage = new CapturingUsage();
  const cancelled = new Set<string>();
  const progressFrames: Array<{ pct: number; detail?: string }> = [];

  const h: Harness = {
    storage,
    logger,
    files,
    upload,
    jobRepo,
    queue,
    jobs,
    usage,
    worker,
    storageRoot,
    cancelled,
    progressFrames,
    ctx: (jobId) => ({
      progress: async (pct, detail) => {
        progressFrames.push({ pct, detail });
      },
      isCancelled: () => cancelled.has(jobId),
    }),
  };
  harnesses.push(h);
  return h;
}

/** Stages an input object and creates a queued+claimed processing job. */
async function stageJob(
  h: Harness,
  opts: { toolSlug?: string; displayName?: string; inputs?: number; maxAttempts?: number } = {},
): Promise<Job> {
  const count = opts.inputs ?? 1;
  const inputs = [];
  for (let i = 0; i < count; i++) {
    const key = `processing-inputs/test-${i}-${Math.abs(i + 7)}/in.pdf`;
    await h.storage.put(key, INPUT_BYTES, { contentType: "application/pdf" });
    inputs.push({
      key,
      displayName: opts.displayName ?? `document-${i}.pdf`,
      bytes: INPUT_BYTES.length,
    });
  }
  const job = await h.jobRepo.create({
    type: PROCESSING_JOB_TYPE,
    payload: { toolSlug: opts.toolSlug ?? "compress-pdf", inputs, options: {} },
    status: "created",
    maxAttempts: opts.maxAttempts ?? 3,
    ownerType: "user",
    ownerId: "user-1",
    toolSlug: opts.toolSlug ?? "compress-pdf",
    progressStage: "preparing",
    expiresAt: new Date(Date.now() + 3_600_000),
    inputBytes: INPUT_BYTES.length * count,
  });
  await h.jobs.queueJob(job.id);
  const claimed = await h.jobs.startJob(job.id);
  return claimed!;
}

/**
 * Work directories under /tmp/pdfdadi that this test created for `jobId`.
 *
 * Baseline-subtracted on purpose. A directory left behind by an earlier run — by
 * a crash, or by a deliberately broken build — sits in the same shared root, and
 * a bare prefix scan would report a leak this run did not cause: worse than a
 * missed leak, because it fails on the wrong build and points at the wrong code.
 *
 * Ids carry per-process entropy (see `InMemoryJobRepository`), which is what
 * keeps a *concurrent* vitest fork out of these results; the baseline covers
 * runs that finished earlier.
 */
let workDirBaseline = new Set<string>();

async function readWorkDirRoot(): Promise<string[]> {
  return fs.readdir(processingTempRoot()).catch(() => [] as string[]);
}

async function workDirsFor(jobId: string): Promise<string[]> {
  const entries = await readWorkDirRoot();
  return entries.filter((e) => e.startsWith(`${jobId}-`) && !workDirBaseline.has(e));
}

beforeEach(async () => {
  workDirBaseline = new Set(await readWorkDirRoot());
});

afterEach(async () => {
  for (const h of harnesses) {
    await fs.rm(h.storageRoot, { recursive: true, force: true });
  }
  harnesses = [];
});

// ---------------------------------------------------------------------------

describe("success path", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });

  it("materializes the input, publishes the output, and completes the job", async () => {
    const { processor: p, spy } = processor("compress-pdf", 10_000, successBody());
    const handler = createProcessingJobHandler({
      storage: h.storage,
      upload: h.upload,
      jobs: h.jobs,
      processors: new SingleProcessorRegistry(p),
      usage: h.usage,
      logger: new ConsoleLogger("error"),
      cancelPollMs: 5,
    });
    const job = await stageJob(h);

    const res = await handler(job, h.ctx(job.id));

    expect(res.terminal).toBe(true);
    // The processor was handed a real file, not an empty placeholder.
    expect(spy.sawInput).toHaveLength(1);
    expect(spy.calls[0]?.options).toEqual({});

    const row = await h.jobRepo.get(job.id);
    expect(row?.status).toBe("completed");
    expect(row?.progressStage).toBe("done");
    const result = row?.result as ProcessingJobResult;
    expect(result.output.downloadName).toBe("document-0-compressed.pdf");
    expect(result.output.bytes).toBeGreaterThan(0);
    expect(result.pageCount).toBe(3);

    // The published bytes really are in storage under the recorded key.
    const head = await h.storage.head(result.output.key);
    expect(head.exists).toBe(true);
    // And the file id resolves, so the download route has something to sign.
    expect(await h.files.get(result.output.fileId)).not.toBeNull();
  });

  it("records exactly one success usage event, with sizes but no document content", async () => {
    const { processor: p } = processor("compress-pdf", 10_000, successBody());
    const handler = createProcessingJobHandler({
      storage: h.storage,
      upload: h.upload,
      jobs: h.jobs,
      processors: new SingleProcessorRegistry(p),
      usage: h.usage,
      logger: new ConsoleLogger("error"),
      cancelPollMs: 5,
    });
    const job = await stageJob(h);
    await handler(job, h.ctx(job.id));

    expect(h.usage.events).toHaveLength(1);
    const ev = h.usage.events[0]!;
    expect(ev.result).toBe("success");
    expect(ev.attempt).toBe(1);
    expect(ev.toolSlug).toBe("compress-pdf");
    expect(ev.executionMode).toBe("remote_job");
    expect(ev.inputBytes).toBe(INPUT_BYTES.length);
    expect(ev.outputBytes).toBeGreaterThan(0);
    expect(ev.pageCount).toBe(3);
    expect(ev.errorCategory).toBeNull();

    // Nothing about the document itself, and no owner id.
    const json = JSON.stringify(ev);
    expect(json).not.toContain("document-0.pdf");
    expect(json).not.toContain("%PDF");
    expect(json).not.toContain("user-1");
    expect(json).not.toContain("/tmp");
  });

  it("reports named stages and never a fabricated intermediate percentage", async () => {
    const { processor: p } = processor("compress-pdf", 10_000, successBody());
    const handler = createProcessingJobHandler({
      storage: h.storage,
      upload: h.upload,
      jobs: h.jobs,
      processors: new SingleProcessorRegistry(p),
      usage: h.usage,
      logger: new ConsoleLogger("error"),
      cancelPollMs: 5,
    });
    const job = await stageJob(h);
    await handler(job, h.ctx(job.id));
    await sleep(10); // stage writes are fire-and-forget

    const stages = h.progressFrames.map((f) => f.detail);
    expect(stages).toContain("preparing");
    expect(stages).toContain("finalizing");
    expect(stages).toContain("done");
    // Every percentage is one of the fixed per-stage values — no interpolation,
    // so the bar cannot claim 72% when nothing measured 72%.
    const allowed = new Set(h.progressFrames.map((f) => f.pct));
    for (const pct of allowed) expect(Number.isInteger(pct)).toBe(true);
    expect(h.progressFrames.every((f) => f.pct >= 0 && f.pct <= 100)).toBe(true);
  });

  it("handles a multi-input job without letting two files collide", async () => {
    let seen: ProcessingContext | null = null;
    const { processor: p } = processor("compress-pdf", 10_000, async (ctx) => {
      seen = ctx;
      return successBody()(ctx);
    });
    const handler = createProcessingJobHandler({
      storage: h.storage,
      upload: h.upload,
      jobs: h.jobs,
      processors: new SingleProcessorRegistry(p),
      usage: h.usage,
      logger: new ConsoleLogger("error"),
      cancelPollMs: 5,
    });
    // Same displayName for both, which without the index prefix would resolve to
    // one path and silently process the same file twice.
    const job = await stageJob(h, { inputs: 2, displayName: "document.pdf" });
    await handler(job, h.ctx(job.id));

    const ctx = seen as unknown as ProcessingContext;
    expect(ctx.additionalInputPaths).toHaveLength(1);
    expect(ctx.inputPath).not.toBe(ctx.additionalInputPaths[0]);
    expect((await h.jobRepo.get(job.id))?.status).toBe("completed");
  });
});

describe("cleanup", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });

  /** The work directory the processor was actually handed, if it ran. */
  let observedWorkDir = "";

  async function runWith(
    body: (ctx: ProcessingContext) => Promise<ProcessingOutcome>,
    opts: { cancelAt?: "before" | "during"; timeoutMs?: number } = {},
  ) {
    observedWorkDir = "";
    const { processor: p } = processor("compress-pdf", opts.timeoutMs ?? 10_000, async (ctx) => {
      observedWorkDir = ctx.workDir;
      return body(ctx);
    });
    const handler = createProcessingJobHandler({
      storage: h.storage,
      upload: h.upload,
      jobs: h.jobs,
      processors: new SingleProcessorRegistry(p),
      usage: h.usage,
      logger: new ConsoleLogger("error"),
      cancelPollMs: 5,
    });
    const job = await stageJob(h);
    if (opts.cancelAt === "before") h.cancelled.add(job.id);
    await handler(job, h.ctx(job.id));
    return job;
  }

  /** Asserts nothing survives: not the exact directory, not any new sibling. */
  async function expectNothingLeftBehind(jobId: string) {
    expect(await workDirsFor(jobId)).toEqual([]);
    if (observedWorkDir) {
      expect(await fs.stat(observedWorkDir).then(() => true, () => false)).toBe(false);
    }
  }

  it("removes the work directory after success", async () => {
    const job = await runWith(successBody());
    expect(observedWorkDir).not.toBe("");
    await expectNothingLeftBehind(job.id);
  });

  it("removes the work directory after a processor failure", async () => {
    const job = await runWith(async () => {
      throw new ProcessingError("Ghostscript exited non-zero");
    });
    await expectNothingLeftBehind(job.id);
    expect((await h.jobRepo.get(job.id))?.status).not.toBe("completed");
  });

  it("removes the work directory after a cancellation", async () => {
    const job = await runWith(successBody(), { cancelAt: "before" });
    await expectNothingLeftBehind(job.id);
  });

  it("removes the work directory after the execution ceiling fires", async () => {
    const job = await runWith(
      async (ctx) => {
        // Cooperative: wait for the abort the ceiling triggers.
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) return resolve();
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new CommandAbortedError();
      },
      { timeoutMs: 20 },
    );
    await expectNothingLeftBehind(job.id);
  });

  it("removes the work directory even when the processor leaves files behind", async () => {
    const job = await runWith(async (ctx) => {
      await fs.writeFile(path.join(ctx.workDir, "scratch-1.tmp"), "junk");
      await fs.mkdir(path.join(ctx.workDir, "nested"));
      await fs.writeFile(path.join(ctx.workDir, "nested", "scratch-2.tmp"), "junk");
      throw new ProcessingError("failed after writing scratch files");
    });
    await expectNothingLeftBehind(job.id);
  });

  it("leaves no input bytes on local disk once the attempt is over", async () => {
    let observedDir = "";
    const job = await runWith(async (ctx) => {
      observedDir = ctx.workDir;
      return successBody()(ctx);
    });
    expect(observedDir).not.toBe("");
    // The directory existed while the processor ran, and does not now.
    expect(await fs.stat(observedDir).then(() => true, () => false)).toBe(false);
    await expectNothingLeftBehind(job.id);
  });
});

describe("the execution ceiling", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });

  it("aborts the processor's signal at the processor's own timeoutMs", async () => {
    let abortedWithin = false;
    const { processor: p } = processor("compress-pdf", 30, async (ctx) => {
      const start = Date.now();
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 3_000);
      });
      abortedWithin = ctx.signal.aborted && Date.now() - start < 2_000;
      throw new CommandAbortedError();
    });
    const handler = createProcessingJobHandler({
      storage: h.storage,
      upload: h.upload,
      jobs: h.jobs,
      processors: new SingleProcessorRegistry(p),
      usage: h.usage,
      logger: new ConsoleLogger("error"),
      cancelPollMs: 5,
    });
    const job = await stageJob(h);
    await handler(job, h.ctx(job.id));

    // The ceiling is enforced by the handler, not by the processor choosing to
    // stop: a hung tool cannot hold the worker slot open.
    expect(abortedWithin).toBe(true);
  });

  it("classifies a timeout as processor_timeout, not as a cancellation", async () => {
    const { processor: p } = processor("compress-pdf", 20, async (ctx) => {
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 3_000);
      });
      // A killed subprocess surfaces as an abort; only the handler knows the
      // abort came from the clock rather than from the user.
      throw new CommandAbortedError();
    });
    const handler = createProcessingJobHandler({
      storage: h.storage,
      upload: h.upload,
      jobs: h.jobs,
      processors: new SingleProcessorRegistry(p),
      usage: h.usage,
      logger: new ConsoleLogger("error"),
      cancelPollMs: 5,
    });
    const job = await stageJob(h, { maxAttempts: 1 });
    await handler(job, h.ctx(job.id));

    const row = await h.jobRepo.get(job.id);
    expect(row?.status).toBe("failed");
    expect(row?.errorCategory).toBe("processor_timeout");
    expect(h.usage.events.at(-1)?.errorCategory).toBe("processor_timeout");
  });

  it("publishes no output when the ceiling fires", async () => {
    const { processor: p } = processor("compress-pdf", 20, async (ctx) => {
      // Write a half-finished file, as a killed Ghostscript would.
      await fs.writeFile(path.join(ctx.workDir, "partial.pdf"), "%PDF-1.7\n% trunc");
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 3_000);
      });
      throw new CommandAbortedError();
    });
    const handler = createProcessingJobHandler({
      storage: h.storage,
      upload: h.upload,
      jobs: h.jobs,
      processors: new SingleProcessorRegistry(p),
      usage: h.usage,
      logger: new ConsoleLogger("error"),
      cancelPollMs: 5,
    });
    const job = await stageJob(h, { maxAttempts: 1 });
    await handler(job, h.ctx(job.id));

    const row = await h.jobRepo.get(job.id);
    expect(row?.result).toBeNull();
    // Nothing was written under this job's output prefix.
    expect(await h.files.listByOwner("user", "user-1")).toHaveLength(0);
  });
});

describe("cancellation", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });

  function build(p: ToolProcessor) {
    return createProcessingJobHandler({
      storage: h.storage,
      upload: h.upload,
      jobs: h.jobs,
      processors: new SingleProcessorRegistry(p),
      usage: h.usage,
      logger: new ConsoleLogger("error"),
      cancelPollMs: 5,
    });
  }

  it("does no work at all when cancellation landed before processing began", async () => {
    const { processor: p, spy } = processor("compress-pdf", 10_000, successBody());
    const job = await stageJob(h);
    h.cancelled.add(job.id);

    await build(p)(job, h.ctx(job.id));

    expect(spy.calls).toHaveLength(0);
    expect((await h.jobRepo.get(job.id))?.status).toBe("cancelled");
  });

  it("aborts the processor's signal when cancellation arrives mid-run", async () => {
    let sawAbort = false;
    const { processor: p } = processor("compress-pdf", 10_000, async (ctx) => {
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 3_000);
      });
      sawAbort = ctx.signal.aborted;
      throw new CommandAbortedError();
    });
    const job = await stageJob(h);
    const run = build(p)(job, h.ctx(job.id));
    await sleep(20);
    h.cancelled.add(job.id);
    await run;

    expect(sawAbort).toBe(true);
    expect((await h.jobRepo.get(job.id))?.status).toBe("cancelled");
  });

  it("records a cancellation as cancelled, never as a failure", async () => {
    const { processor: p } = processor("compress-pdf", 10_000, async (ctx) => {
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 3_000);
      });
      throw new CommandAbortedError();
    });
    const job = await stageJob(h);
    const run = build(p)(job, h.ctx(job.id));
    await sleep(20);
    h.cancelled.add(job.id);
    await run;

    const row = await h.jobRepo.get(job.id);
    expect(row?.errorCategory).toBe("cancelled");
    expect(h.usage.events.at(-1)?.result).toBe("cancelled");
    // A cancelled job must not offer a Retry button implying something broke.
    expect(h.jobs.toView(row!).errorCategory).toBe("cancelled");
  });

  it("never publishes a result when the user cancelled while the processor finished", async () => {
    // The core promise, in its hardest case: the processor succeeds and the
    // output is uploaded, but the job reached `cancelled` in between. The
    // completion must be refused and the stored bytes deleted rather than served.
    //
    // The cancellation is applied from inside the processor so it lands in
    // exactly that window — after the work, before the publish — which is the
    // ordering a real race would produce and the one a test cannot get by
    // cancelling before or after the call.
    const job = await stageJob(h);
    const { processor: p } = processor("compress-pdf", 10_000, async (ctx) => {
      const out = await successBody()(ctx);
      await h.jobs.markCancelled(job.id, 1);
      return out;
    });

    await build(p)(job, h.ctx(job.id));

    const row = await h.jobRepo.get(job.id);
    expect(row?.status).toBe("cancelled");
    expect(row?.result).toBeNull();

    // The upload did happen — that is the point — and every uploaded object was
    // then deleted, so nothing is left orphaned in storage.
    const stored = await h.files.listByOwner("user", "user-1");
    expect(stored.length).toBeGreaterThan(0);
    for (const f of stored) {
      expect((await h.storage.head(f.key)).exists).toBe(false);
    }
    expect(h.usage.events.at(-1)?.result).toBe("cancelled");
    expect(h.usage.events.at(-1)?.outputBytes).toBeNull();
  });
});

describe("failure classification and retry", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });

  function build(p: ToolProcessor) {
    return createProcessingJobHandler({
      storage: h.storage,
      upload: h.upload,
      jobs: h.jobs,
      processors: new SingleProcessorRegistry(p),
      usage: h.usage,
      logger: h.logger,
      cancelPollMs: 5,
    });
  }

  async function failWith(err: unknown, maxAttempts = 1) {
    const { processor: p } = processor("compress-pdf", 10_000, async () => {
      throw err;
    });
    const job = await stageJob(h, { maxAttempts });
    await build(p)(job, h.ctx(job.id));
    return job;
  }

  it("classifies a corrupt document as permanent and does not retry it", async () => {
    const job = await failWith(new ProcessingError("Unable to find trailer dictionary"), 3);
    const row = await h.jobRepo.get(job.id);
    expect(row?.errorCategory).toBe("corrupt_document");
    // Permanent: still `failed`, not re-queued for two more Ghostscript runs.
    expect(row?.status).toBe("failed");
    expect(h.usage.events).toHaveLength(1);
    // And the handler never even asked. Asserting the absence of the refusal log
    // is what distinguishes "the handler declined" from "the handler asked and
    // the service said no" — both leave the job `failed`, but only the first
    // means the retry policy is being read where the decision is made.
    expect(h.logger.warnings).not.toContain(RETRY_REFUSED_LOG);
  });

  it("does not ask the service to retry any permanent failure class", async () => {
    // One case per deterministic class. Each must be declined here, before the
    // service's independent refusal has to catch it.
    const cases: Array<[unknown, string]> = [
      [new ProcessingError("Unable to find trailer dictionary"), "corrupt_document"],
      [new ProcessingError("This file is encrypted"), "password_required"],
    ];
    for (const [err, expectedCategory] of cases) {
      const h2 = await makeHarness();
      const { processor: p } = processor("compress-pdf", 10_000, async () => {
        throw err;
      });
      const handler = createProcessingJobHandler({
        storage: h2.storage,
        upload: h2.upload,
        jobs: h2.jobs,
        processors: new SingleProcessorRegistry(p),
        usage: h2.usage,
        logger: h2.logger,
        cancelPollMs: 5,
      });
      const job = await stageJob(h2, { maxAttempts: 3 });
      await handler(job, h2.ctx(job.id));

      const row = await h2.jobRepo.get(job.id);
      expect(row?.errorCategory).toBe(expectedCategory);
      expect(row?.status).toBe("failed");
      expect(h2.logger.warnings).not.toContain(RETRY_REFUSED_LOG);
    }
  });

  it("does ask the service to retry a transient failure", async () => {
    // The positive control for the assertion above: the same log-based probe
    // must be able to see a retry actually being requested, or its absence in
    // the permanent cases would prove nothing.
    const job = await failWith(new MissingDependencyError("gs"), 3);
    const row = await h.jobRepo.get(job.id);
    expect(row?.status).toBe("queued");
    // Requested and granted, so no refusal was logged.
    expect(h.logger.warnings).not.toContain(RETRY_REFUSED_LOG);
  });

  it("classifies a missing binary as dependency_unavailable and retries it", async () => {
    const job = await failWith(new MissingDependencyError("gs"), 3);
    const row = await h.jobRepo.get(job.id);
    expect(row?.errorCategory).toBeNull(); // cleared by the automatic retry
    expect(row?.status).toBe("queued");
    expect(row?.attempts).toBe(1);
  });

  it("stops retrying once the attempt budget is spent", async () => {
    const { processor: p } = processor("compress-pdf", 10_000, async () => {
      throw new MissingDependencyError("gs");
    });
    const job = await stageJob(h, { maxAttempts: 1 });
    await build(p)(job, h.ctx(job.id));

    const row = await h.jobRepo.get(job.id);
    expect(row?.status).toBe("failed");
    expect(row?.errorCategory).toBe("dependency_unavailable");
  });

  it("records one usage event per attempt, with its attempt number", async () => {
    // Two attempts of the same job: the first must stay visible in telemetry.
    const { processor: p } = processor("compress-pdf", 10_000, async () => {
      throw new MissingDependencyError("gs");
    });
    const job = await stageJob(h, { maxAttempts: 2 });
    await build(p)(job, h.ctx(job.id));

    const second = await h.jobs.startJob(job.id);
    expect(second).not.toBeNull();
    await build(p)(second!, h.ctx(job.id));

    expect(h.usage.events.map((e) => e.attempt)).toEqual([1, 2]);
    expect(h.usage.events.every((e) => e.result === "failure")).toBe(true);
    expect((await h.jobRepo.get(job.id))?.status).toBe("failed");
  });

  it("stores the internal diagnostic but shows only the category's safe sentence", async () => {
    const job = await failWith(
      new ProcessingError("/tmp/pdfdadi/j-abc/in.pdf: gs -dNOPAUSE exited 1"),
    );
    const row = await h.jobRepo.get(job.id);
    // Internal field keeps the detail an operator needs.
    expect(row?.error).toContain("gs -dNOPAUSE");
    // The user-facing field does not.
    expect(row?.safeErrorMessage).toBeTruthy();
    expect(row?.safeErrorMessage).not.toContain("/tmp");
    expect(row?.safeErrorMessage).not.toContain("gs -dNOPAUSE");
    const view = JSON.stringify(h.jobs.toView(row!));
    expect(view).not.toContain("/tmp");
    expect(view).not.toContain("dNOPAUSE");
  });

  it("fails safely when no processor is registered for the slug", async () => {
    const { processor: p } = processor("some-other-tool", 10_000, successBody());
    const job = await stageJob(h, { maxAttempts: 1 });
    await build(p)(job, h.ctx(job.id));

    const row = await h.jobRepo.get(job.id);
    expect(row?.status).toBe("failed");
    expect(row?.result).toBeNull();
    // And it did not leave a work directory behind on the way out.
    expect(await workDirsFor(job.id)).toEqual([]);
  });

  it("fails safely when the staged input is missing from storage", async () => {
    const { processor: p, spy } = processor("compress-pdf", 10_000, successBody());
    const job = await h.jobRepo.create({
      type: PROCESSING_JOB_TYPE,
      payload: {
        toolSlug: "compress-pdf",
        inputs: [{ key: "processing-inputs/gone/in.pdf", displayName: "x.pdf", bytes: 10 }],
        options: {},
      },
      status: "created",
      maxAttempts: 1,
      ownerType: "user",
      ownerId: "user-1",
      toolSlug: "compress-pdf",
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await h.jobs.queueJob(job.id);
    const claimed = await h.jobs.startJob(job.id);
    await build(p)(claimed!, h.ctx(job.id));

    expect(spy.calls).toHaveLength(0);
    const row = await h.jobRepo.get(job.id);
    expect(row?.status).toBe("failed");
    expect(row?.result).toBeNull();
    expect(await workDirsFor(job.id)).toEqual([]);
  });
});

describe("path safety", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });

  it("never lets a submitted filename escape the work directory", async () => {
    let observed: ProcessingContext | null = null;
    const { processor: p } = processor("compress-pdf", 10_000, async (ctx) => {
      observed = ctx;
      return successBody()(ctx);
    });
    const handler = createProcessingJobHandler({
      storage: h.storage,
      upload: h.upload,
      jobs: h.jobs,
      processors: new SingleProcessorRegistry(p),
      usage: h.usage,
      logger: new ConsoleLogger("error"),
      cancelPollMs: 5,
    });
    const job = await stageJob(h, { displayName: "../../../../etc/passwd" });
    await handler(job, h.ctx(job.id));

    const ctx = observed as unknown as ProcessingContext;
    expect(ctx.inputPath.startsWith(ctx.workDir + path.sep)).toBe(true);
    expect(ctx.inputPath).not.toContain("..");
    expect(ctx.workDir.startsWith(processingTempRoot() + path.sep)).toBe(true);
  });

  it("derives the output name from the submitted name without trusting it", async () => {
    const { processor: p } = processor("compress-pdf", 10_000, successBody());
    const handler = createProcessingJobHandler({
      storage: h.storage,
      upload: h.upload,
      jobs: h.jobs,
      processors: new SingleProcessorRegistry(p),
      usage: h.usage,
      logger: new ConsoleLogger("error"),
      cancelPollMs: 5,
    });
    const job = await stageJob(h, { displayName: "../../secret report;rm -rf /.pdf" });
    await handler(job, h.ctx(job.id));

    const result = (await h.jobRepo.get(job.id))?.result as ProcessingJobResult;
    expect(result.output.downloadName).not.toContain("/");
    expect(result.output.downloadName).not.toContain("..");
    expect(result.output.downloadName).not.toContain(";");
    // The storage key is job-scoped, so one job cannot overwrite another's output.
    expect(result.output.key.startsWith(`jobs/${job.id}/output/`)).toBe(true);
  });

  it("puts the work directory under the dedicated processing root with a random suffix", async () => {
    let dirA = "";
    let dirB = "";
    const mk = (sink: (d: string) => void) =>
      processor("compress-pdf", 10_000, async (ctx) => {
        sink(ctx.workDir);
        return successBody()(ctx);
      });

    const a = mk((d) => (dirA = d));
    const b = mk((d) => (dirB = d));
    const jobA = await stageJob(h);
    const jobB = await stageJob(h);
    const mkHandler = (p: ToolProcessor) =>
      createProcessingJobHandler({
        storage: h.storage,
        upload: h.upload,
        jobs: h.jobs,
        processors: new SingleProcessorRegistry(p),
        usage: h.usage,
        logger: new ConsoleLogger("error"),
        cancelPollMs: 5,
      });
    await mkHandler(a.processor)(jobA, h.ctx(jobA.id));
    await mkHandler(b.processor)(jobB, h.ctx(jobB.id));

    expect(dirA).not.toBe(dirB);
    for (const d of [dirA, dirB]) {
      expect(d.startsWith(processingTempRoot() + path.sep)).toBe(true);
      // The job id alone would be guessable; mkdtemp's suffix is what makes the
      // path unpredictable to a co-tenant process.
      expect(path.basename(d).length).toBeGreaterThan(jobA.id.length);
    }
  });
});

describe("the terminal stage", () => {
  it("is not overwritten by a stage write still in flight when the job completes", async () => {
    // A completed job must describe itself as `done`. If the `finalizing` write
    // issued before the upload lands *after* `completeJob` has written `done`, the
    // row reads `completed` + `finalizing` — and the progress stream's final
    // frame then tells the user a finished job is still working. That exact row
    // is what the first browser run of this pipeline produced.
    const h = await makeHarness({ stageDelayMs: 120 });
    const { processor: p } = processor("compress-pdf", 60_000, successBody());
    const handler = createProcessingJobHandler({
      storage: h.storage,
      upload: h.upload,
      jobs: h.jobs,
      processors: new SingleProcessorRegistry(p),
      usage: h.usage,
      logger: new ConsoleLogger("error"),
      cancelPollMs: 5,
    });
    const job = await stageJob(h);

    await handler(job, h.ctx(job.id));

    const row = await h.jobRepo.get(job.id);
    expect(row?.status).toBe("completed");
    expect(row?.progressStage).toBe("done");

    // Not vacuous: the slow writes really did run, in the order they were
    // reported, and `finalizing` — the one that races completion — is the last of
    // them. Were this list empty or missing `finalizing`, the assertion above
    // would be passing because nothing ever raced.
    //
    // `processing` is absent by design: the service writes that stage as part of
    // the `running` transition in `startJob`, so it never travels through
    // `recordStage`.
    const applied = (h.jobs as SlowStageService).applied;
    expect(applied[0]).toBe("preparing");
    expect(applied).toContain("finalizing");
    expect(applied.indexOf("preparing")).toBeLessThan(applied.indexOf("finalizing"));
  });
});

describe("a superseded attempt", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });

  /** Records settlements instead of metering them. */
  function meteringSpy() {
    const calls: unknown[] = [];
    return {
      calls,
      service: {
        settleProcessingOutcome: async (args: unknown) => {
          calls.push(args);
        },
      } as never,
    };
  }

  /**
   * The stuck-job sweep, run from inside the processor: the attempt is genuinely
   * in flight when its job is recovered, which is the only ordering that can
   * produce this bug in production.
   */
  async function recoverMidAttempt(jobId: string): Promise<void> {
    const summary = await new StuckJobRecoveryService({
      jobRepo: h.jobRepo,
      queue: h.queue,
      logger: new ConsoleLogger("error"),
      staleAfterMs: 0,
    }).recoverStale();
    // Precondition, not decoration: if nothing was recovered then nothing was
    // superseded, and every assertion below would pass for the wrong reason.
    expect(summary).toMatchObject({ examined: 1, requeued: 1 });
    expect((await h.jobRepo.get(jobId))!.attempts).toBe(1);
  }

  const SUPERSEDED_LOG = "Superseded attempt wrote nothing";

  it("publishes nothing, meters nothing, and settles nothing when its work succeeded", async () => {
    const metering = meteringSpy();
    let jobId = "";
    const { processor: p } = processor("compress-pdf", 10_000, async (ctx) => {
      await recoverMidAttempt(jobId);
      return successBody()(ctx);
    });
    const handler = createProcessingJobHandler({
      storage: h.storage,
      upload: h.upload,
      jobs: h.jobs,
      processors: new SingleProcessorRegistry(p),
      usage: h.usage,
      logger: h.logger,
      metering: metering.service,
      cancelPollMs: 5,
    });
    const job = await stageJob(h);
    jobId = job.id;

    expect((await handler(job, h.ctx(job.id))).terminal).toBe(true);

    expect(h.logger.warnings).toContain(SUPERSEDED_LOG);
    const row = (await h.jobRepo.get(job.id))!;
    // The successor's row, untouched: still queued for attempt 2, with no result
    // the user could download from an attempt nobody owns.
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(1);
    expect(row.result).toBeNull();
    expect(h.usage.events).toHaveLength(0);
    expect(metering.calls).toHaveLength(0);
    // And no orphaned object: the output was written, then deleted.
    const keys = (await h.files.listByOwner("user", "user-1")).map((f) => f.key);
    for (const key of keys.filter((k) => k.includes(`jobs/${job.id}/output/`))) {
      expect((await h.storage.head(key)).exists).toBe(false);
    }
  });

  it("records no failure and triggers no refund when its work threw", async () => {
    const metering = meteringSpy();
    let jobId = "";
    const { processor: p } = processor("compress-pdf", 10_000, async () => {
      await recoverMidAttempt(jobId);
      throw new ProcessingError("boom");
    });
    const handler = createProcessingJobHandler({
      storage: h.storage,
      upload: h.upload,
      jobs: h.jobs,
      processors: new SingleProcessorRegistry(p),
      usage: h.usage,
      logger: h.logger,
      metering: metering.service,
      cancelPollMs: 5,
    });
    const job = await stageJob(h);
    jobId = job.id;

    expect((await handler(job, h.ctx(job.id))).terminal).toBe(true);

    expect(h.logger.warnings).toContain(SUPERSEDED_LOG);
    // Neither of the two lines this path would normally emit: the attempt is not
    // this worker's to report on any more.
    expect(h.logger.warnings).not.toContain("Processing attempt failed");
    expect(h.logger.warnings).not.toContain(RETRY_REFUSED_LOG);
    const row = (await h.jobRepo.get(job.id))!;
    expect(row.status).toBe("queued");
    // The sweep charged attempt 1 once. A second charge from the zombie would
    // spend the budget of a job that has only had one attempt.
    expect(row.attempts).toBe(1);
    expect(row.errorCategory).toBeNull();
    expect(h.usage.events).toHaveLength(0);
    // The refund is the money bug: this job is about to run again on worker B.
    expect(metering.calls).toHaveLength(0);
  });
});
