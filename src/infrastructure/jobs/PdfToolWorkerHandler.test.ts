import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import JSZip from "jszip";

import { LocalFileStorage } from "@/src/infrastructure/storage/LocalFileStorage";
import { InMemoryStoredFileRepository } from "@/src/infrastructure/persistence/InMemoryStoredFileRepository";
import { InMemoryJobRepository } from "@/src/infrastructure/persistence/InMemoryJobRepository";
import { InMemoryWorkspaceSaveIntentRepository } from "@/src/infrastructure/persistence/InMemoryWorkspaceSaveIntentRepository";
import { InMemoryQueue } from "@/src/infrastructure/queue/InMemoryQueue";
import { InMemoryWorker } from "@/src/infrastructure/queue/InMemoryWorker";
import { InMemoryJobEvents } from "@/src/infrastructure/queue/InMemoryJobEvents";
import { InMemoryJobScheduler } from "@/src/infrastructure/queue/InMemoryJobScheduler";
import { UploadService } from "@/src/application/services/UploadService";
import {
  PdfToolJobService,
  PDF_TOOL_JOB_TYPE,
  PDF_TOOL_BATCH_JOB_TYPE,
  FILE_RETENTION_JOB_TYPE,
} from "@/src/application/services/PdfToolJobService";
import { ConsoleLogger } from "@/src/infrastructure/logging/ConsoleLogger";
import {
  ProcessingError,
  type ProcessContext,
  type ServerOutput,
} from "@/lib/server/toolProcessing";
import { CommandAbortedError } from "@/lib/server/runCommand";
import { MissingDependencyError } from "@/lib/server/dependencyCheck";
import {
  createPdfToolHandler,
  createPdfToolBatchHandler,
  createFileRetentionHandler,
  SAVE_INTENT_RETENTION_MS,
} from "./PdfToolWorkerHandler";
import type { JobContext } from "@/src/application/ports/queue/Worker";

const webStream = (data: Buffer): ReadableStream<Uint8Array> =>
  Readable.toWeb(Readable.from([data])) as ReadableStream<Uint8Array>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Fake processor: writes a fixed output file (no external binaries). */
function fakeProcessor(
  outputBytes: Buffer,
  opts: { signalPoll?: boolean } = {},
): (ctx: ProcessContext) => Promise<ServerOutput> {
  return async (ctx) => {
    if (opts.signalPoll) {
      // Poll the abort signal so a mid-run cancel surfaces as CommandAbortedError.
      const until = Date.now() + 10_000;
      while (Date.now() < until) {
        if (ctx.signal?.aborted) throw new CommandAbortedError();
        await sleep(10);
      }
    }
    const outPath = path.join(ctx.jobDir, "output.pdf");
    await fs.writeFile(outPath, outputBytes);
    return {
      outputPath: outPath,
      downloadName: `${ctx.baseName}-out.pdf`,
      mimeType: "application/pdf",
    };
  };
}

interface Env {
  storage: LocalFileStorage;
  fileMeta: InMemoryStoredFileRepository;
  jobRepo: InMemoryJobRepository;
  events: InMemoryJobEvents;
  logger: ConsoleLogger;
  upload: UploadService;
  queue: InMemoryQueue;
  scheduler: InMemoryJobScheduler;
  worker: InMemoryWorker;
  service: PdfToolJobService;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<Env> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdfdadi-jobtest-"));
  const storage = new LocalFileStorage(path.join(root, "store"));
  const fileMeta = new InMemoryStoredFileRepository();
  const jobRepo = new InMemoryJobRepository();
  const events = new InMemoryJobEvents();
  const logger = new ConsoleLogger("error");
  const upload = new UploadService(storage, fileMeta, logger);
  const queue = new InMemoryQueue(jobRepo, logger);
  const scheduler = new InMemoryJobScheduler(queue, jobRepo, logger);
  const worker = new InMemoryWorker(queue, jobRepo, logger, { events });
  const service = new PdfToolJobService(queue, jobRepo, worker);
  return {
    storage,
    fileMeta,
    jobRepo,
    events,
    logger,
    upload,
    queue,
    scheduler,
    worker,
    service,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

/** Stages an input through storage + metadata, returning the StoredFile id. */
async function stageInput(env: Env, data: Buffer): Promise<string> {
  const { file } = await env.upload.uploadStream({
    ownerType: "anon",
    ownerId: "anon",
    originalName: "in.pdf",
    mimeType: "application/pdf",
    data: webStream(data),
    key: `tool-inputs/test-${Math.random().toString(36).slice(2)}/in.pdf`,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return file.id;
}

/**
 * The job-row owner used by these tests. A specific anon id rather than the
 * shared `"anon"` storage bucket below it, because that is what production
 * stamps — `resolveJobActor` mints one uuid per visitor.
 */
const TEST_ACTOR = { ownerType: "anon", ownerId: "anon-test-owner" } as const;

const enqueue = (env: Env, inputFileId: string, inputSize: number) =>
  env.service.enqueue({
    slug: "compress-pdf",
    inputFileId,
    originalName: "in.pdf",
    ext: ".pdf",
    baseName: "in",
    inputSize,
    options: {},
    ownerType: "anon",
    ownerId: "anon",
    actor: TEST_ACTOR,
  });

describe("PdfToolWorkerHandler + PdfToolJobService", () => {
  let env: Env;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => {
    env.worker.stop();
    await env.cleanup();
  });

  it("runs a job end-to-end: streams output to storage, records result, reports progress", async () => {
    const outputBytes = Buffer.from("%PDF-fake-output");
    env.worker.register(
      PDF_TOOL_JOB_TYPE,
      createPdfToolHandler({
        storage: env.storage,
        fileMeta: env.fileMeta,
        upload: env.upload,
        jobRepo: env.jobRepo,
        logger: env.logger,
        resolveProcessor: () => fakeProcessor(outputBytes),
      }),
    );

    const inputBytes = Buffer.from("%PDF-fake-input");
    const inputFileId = await stageInput(env, inputBytes);
    const job = await enqueue(env, inputFileId, inputBytes.length);

    const progress: number[] = [];
    env.events.onProgress(job.id, (e) => {
      progress.push(e.pct);
      env.service.recordProgress(job.id, e.pct, e.detail);
    });

    env.worker.start();
    const status = await env.service.awaitCompletion(job.id, 5000, 25);

    expect(status.status).toBe("completed");
    expect(status.result?.downloadName).toBe("in-out.pdf");
    expect(status.result?.mimeType).toBe("application/pdf");
    expect(status.result?.resultSize).toBe(outputBytes.length);
    expect(status.result?.originalSize).toBe(inputBytes.length);
    // Output landed in storage under a job-scoped key and round-trips.
    expect(status.result?.outputKey.startsWith("jobs/")).toBe(true);
    expect((await env.storage.get(status.result!.outputKey)).toString()).toBe(
      outputBytes.toString(),
    );
    // Progress was streamed, including the terminal 100%.
    expect(progress).toContain(100);
    expect(progress[0]).toBeLessThanOrEqual(progress[progress.length - 1]);
  });

  it("cancels a queued job before the worker pulls it", async () => {
    const outputBytes = Buffer.from("out");
    env.worker.register(
      PDF_TOOL_JOB_TYPE,
      createPdfToolHandler({
        storage: env.storage,
        fileMeta: env.fileMeta,
        upload: env.upload,
        jobRepo: env.jobRepo,
        logger: env.logger,
        resolveProcessor: () => fakeProcessor(outputBytes),
      }),
    );

    const inputBytes = Buffer.from("in");
    const inputFileId = await stageInput(env, inputBytes);
    const job = await enqueue(env, inputFileId, inputBytes.length);

    // Mark cancelled before the worker starts, then start — the handler's first
    // isCancelled() check aborts before any work runs.
    await env.service.cancel(job.id);
    env.worker.start();

    const status = await env.service.awaitCompletion(job.id, 3000, 25);
    expect(status.status).toBe("cancelled");
    expect(status.result).toBeNull();
  });

  it("cancels a running job by aborting the processor's signal", async () => {
    const outputBytes = Buffer.from("out");
    env.worker.register(
      PDF_TOOL_JOB_TYPE,
      createPdfToolHandler({
        storage: env.storage,
        fileMeta: env.fileMeta,
        upload: env.upload,
        jobRepo: env.jobRepo,
        logger: env.logger,
        resolveProcessor: () => fakeProcessor(outputBytes, { signalPoll: true }),
        cancelPollMs: 10,
      }),
    );

    const inputBytes = Buffer.from("in");
    const inputFileId = await stageInput(env, inputBytes);
    env.worker.start();
    const job = await enqueue(env, inputFileId, inputBytes.length);

    // Let the worker pull the job and the processor enter its signal-poll loop.
    await sleep(40);
    await env.service.cancel(job.id);

    const status = await env.service.awaitCompletion(job.id, 8000, 25);
    expect(status.status).toBe("cancelled");
  });

  it("categorizes a ProcessingError into job.result.errorType", async () => {
    env.worker.register(
      PDF_TOOL_JOB_TYPE,
      createPdfToolHandler({
        storage: env.storage,
        fileMeta: env.fileMeta,
        upload: env.upload,
        jobRepo: env.jobRepo,
        logger: env.logger,
        resolveProcessor: () =>
          async () => {
            throw new ProcessingError("The PDF is corrupt.");
          },
      }),
    );

    const inputBytes = Buffer.from("in");
    const inputFileId = await stageInput(env, inputBytes);
    env.worker.start();
    const job = await enqueue(env, inputFileId, inputBytes.length);

    const status = await env.service.awaitCompletion(job.id, 3000, 25);
    expect(status.status).toBe("failed");
    expect(status.errorType).toBe("processing");
    expect(status.error).toBe("The PDF is corrupt.");
  });

  it("categorizes a MissingDependencyError as missing-dependency", async () => {
    env.worker.register(
      PDF_TOOL_JOB_TYPE,
      createPdfToolHandler({
        storage: env.storage,
        fileMeta: env.fileMeta,
        upload: env.upload,
        jobRepo: env.jobRepo,
        logger: env.logger,
        resolveProcessor: () =>
          async () => {
            throw new MissingDependencyError("gs");
          },
      }),
    );

    const inputBytes = Buffer.from("in");
    const inputFileId = await stageInput(env, inputBytes);
    env.worker.start();
    const job = await enqueue(env, inputFileId, inputBytes.length);

    const status = await env.service.awaitCompletion(job.id, 3000, 25);
    expect(status.status).toBe("failed");
    expect(status.errorType).toBe("missing-dependency");
  });

  it("getStatus returns null for an unknown job id", async () => {
    expect(await env.service.getStatus("nope")).toBeNull();
  });

  it("processes up to `concurrency` jobs in parallel", async () => {
    // A dedicated worker with concurrency = 2 (the setup() worker defaults to 1).
    const concurrentWorker = new InMemoryWorker(
      env.queue,
      env.jobRepo,
      env.logger,
      { events: env.events, concurrency: 2 },
    );
    const concurrentService = new PdfToolJobService(
      env.queue,
      env.jobRepo,
      concurrentWorker,
    );

    let inFlight = 0;
    let maxInFlight = 0;
    concurrentWorker.register(
      PDF_TOOL_JOB_TYPE,
      createPdfToolHandler({
        storage: env.storage,
        fileMeta: env.fileMeta,
        upload: env.upload,
        jobRepo: env.jobRepo,
        logger: env.logger,
        resolveProcessor: () =>
          async (ctx) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await sleep(60); // hold the slot so overlap is observable
            inFlight -= 1;
            const outPath = path.join(ctx.jobDir, "output.pdf");
            await fs.writeFile(outPath, Buffer.from("out"));
            return {
              outputPath: outPath,
              downloadName: `${ctx.baseName}-out.pdf`,
              mimeType: "application/pdf",
            };
          },
      }),
    );

    const inputBytes = Buffer.from("in");
    const inputFileId = await stageInput(env, inputBytes);
    concurrentWorker.start();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const job = await enqueue(env, inputFileId, inputBytes.length);
      ids.push(job.id);
    }

    const statuses = await Promise.all(
      ids.map((id) => concurrentService.awaitCompletion(id, 5000, 25)),
    );
    expect(statuses.every((s) => s.status === "completed")).toBe(true);
    // At least two ran at the same time, and never more than the limit of 2.
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    concurrentWorker.stop();
  });
});

describe("FileRetentionHandler", () => {
  let env: Env;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => {
    env.worker.stop();
    await env.cleanup();
  });

  it("purges expired tool files (object + metadata) and re-schedules itself", async () => {
    // An expired tool output and a non-tool (content-addressed) expired file.
    const { file: expiredTool } = await env.upload.uploadStream({
      ownerType: "anon",
      ownerId: "anon",
      originalName: "o.pdf",
      mimeType: "application/pdf",
      data: webStream(Buffer.from("out")),
      key: "jobs/old/output/o.pdf",
      expiresAt: new Date(Date.now() - 1000),
    });
    const { file: expiredCa } = await env.upload.uploadStream({
      ownerType: "anon",
      ownerId: "anon",
      originalName: "shared.pdf",
      mimeType: "application/pdf",
      data: webStream(Buffer.from("shared")),
      key: "ca/ab/cd/abcdef",
      expiresAt: new Date(Date.now() - 1000),
    });

    const handler = createFileRetentionHandler({
      storage: env.storage,
      fileMeta: env.fileMeta,
      scheduler: env.scheduler,
      saveIntents: new InMemoryWorkspaceSaveIntentRepository(),
      sessions: { pruneExpired: async () => 0 },
      logger: env.logger,
    });
    const job = await env.jobRepo.create({
      type: FILE_RETENTION_JOB_TYPE,
      payload: {},
    });
    const ctx: JobContext = {
      progress: async () => {},
      isCancelled: () => false,
    };

    const { result } = await handler(job, ctx);
    expect((result as { purged: number }).purged).toBeGreaterThanOrEqual(1);

    // Tool file: object + metadata both gone.
    expect(await env.fileMeta.get(expiredTool.id)).toBeNull();
    expect((await env.storage.head(expiredTool.key)).exists).toBe(false);
    // Content-addressed file: metadata removed, object left (shared lifecycle).
    expect(await env.fileMeta.get(expiredCa.id)).toBeNull();
    expect((await env.storage.head(expiredCa.key)).exists).toBe(true);

    // Re-scheduled a new retention job (queued).
    const queued = await env.jobRepo.listByStatus("queued");
    expect(queued.some((j) => j.type === FILE_RETENTION_JOB_TYPE)).toBe(true);
  });

  /**
   * The save-intent horizon, and why the sweep is where it is asserted.
   *
   * `workspace_save_intents` gains a row per save-to-workspace operation and no
   * other lifecycle deletes one: no cascade reaches it, and the service that
   * writes it only ever moves a status. Before this sweep learned about it the
   * table was unbounded for the life of a deployment — a userId, a workspaceId
   * and a payload checksum per save, kept forever. This test is the policy: rows
   * past the horizon go, rows inside it stay, and the count is reported.
   */
  it("prunes save intentions past the horizon and keeps the ones inside it", async () => {
    const saveIntents = new InMemoryWorkspaceSaveIntentRepository();
    const meaning = {
      workspaceId: "ws1",
      sourceKind: "local-result" as const,
      sourceIdentity: "res-1",
      payloadChecksum: "a".repeat(64),
    };
    const stale = await saveIntents.insertPending(
      { organizationId: "org1", userId: "u1", key: "k-stale" },
      meaning,
    );
    const fresh = await saveIntents.insertPending(
      { organizationId: "org1", userId: "u1", key: "k-fresh" },
      meaning,
    );
    expect(stale).not.toBeNull();
    expect(fresh).not.toBeNull();
    // Age the stale row past the horizon by rewriting the twin's clock, which is
    // the only way to be a month old inside a test that runs in milliseconds.
    Object.assign(
      (saveIntents as unknown as { rows: Map<string, { id: string; updatedAt: Date }> }).rows.get(
        "org1\u0000u1\u0000k-stale",
      )!,
      { updatedAt: new Date(Date.now() - SAVE_INTENT_RETENTION_MS - 60_000) },
    );

    const handler = createFileRetentionHandler({
      storage: env.storage,
      fileMeta: env.fileMeta,
      scheduler: env.scheduler,
      saveIntents,
      sessions: { pruneExpired: async () => 0 },
      logger: env.logger,
    });
    const job = await env.jobRepo.create({ type: FILE_RETENTION_JOB_TYPE, payload: {} });
    const { result } = await handler(job, {
      progress: async () => {},
      isCancelled: () => false,
    } as JobContext);

    expect((result as { intentsPruned: number }).intentsPruned).toBe(1);
    expect(
      await saveIntents.find({ organizationId: "org1", userId: "u1", key: "k-stale" }),
    ).toBeNull();
    // Anti-vacuity: a sweep that deleted the table would pass the line above.
    expect(
      await saveIntents.find({ organizationId: "org1", userId: "u1", key: "k-fresh" }),
    ).not.toBeNull();
  });

  /**
   * `sessions`, and why it rides the same sweep.
   *
   * A row is written on every login and removed only by an explicit logout, so
   * an abandoned tab left one behind forever — monotonic growth in an
   * authentication table, the same shape as the save-intent finding above.
   * `LocalSessionProvider.test.ts` proves the SQL against real SQLite; what is
   * asserted here is that the recurring sweep calls it with a sane clock and
   * reports what it removed.
   */
  it("prunes expired auth sessions and reports the count", async () => {
    const prunedAt: Date[] = [];
    const handler = createFileRetentionHandler({
      storage: env.storage,
      fileMeta: env.fileMeta,
      scheduler: env.scheduler,
      saveIntents: new InMemoryWorkspaceSaveIntentRepository(),
      sessions: {
        pruneExpired: async (now: Date) => {
          prunedAt.push(now);
          return 3;
        },
      },
      logger: env.logger,
    });
    const job = await env.jobRepo.create({ type: FILE_RETENTION_JOB_TYPE, payload: {} });
    const before = Date.now();
    const { result } = await handler(job, {
      progress: async () => {},
      isCancelled: () => false,
    } as JobContext);

    expect(prunedAt).toHaveLength(1);
    // Now, not a horizon: an unexpired session must survive its own sweep, so
    // the cutoff is the clock and nothing earlier.
    expect(prunedAt[0]!.getTime()).toBeGreaterThanOrEqual(before);
    expect(prunedAt[0]!.getTime()).toBeLessThanOrEqual(Date.now());
    expect((result as { sessionsPruned: number }).sessionsPruned).toBe(3);
  });

  it("still purges files and re-schedules when the session prune throws", async () => {
    const { file: expired } = await env.upload.uploadStream({
      ownerType: "anon",
      ownerId: "anon",
      originalName: "o.pdf",
      mimeType: "application/pdf",
      data: webStream(Buffer.from("out")),
      key: "jobs/old/output/o.pdf",
      expiresAt: new Date(Date.now() - 1000),
    });
    const handler = createFileRetentionHandler({
      storage: env.storage,
      fileMeta: env.fileMeta,
      scheduler: env.scheduler,
      saveIntents: new InMemoryWorkspaceSaveIntentRepository(),
      sessions: {
        pruneExpired: async () => {
          throw new Error("sessions table locked");
        },
      },
      logger: env.logger,
    });
    const job = await env.jobRepo.create({ type: FILE_RETENTION_JOB_TYPE, payload: {} });
    const { result } = await handler(job, {
      progress: async () => {},
      isCancelled: () => false,
    } as JobContext);

    // A retention sweep that dies on its newest duty stops expiring files, which
    // is a data-retention failure. It reports 0 and carries on instead.
    expect((result as { sessionsPruned: number }).sessionsPruned).toBe(0);
    expect((result as { purged: number }).purged).toBeGreaterThanOrEqual(1);
    expect(await env.fileMeta.get(expired.id)).toBeNull();
    const queued = await env.jobRepo.listByStatus("queued");
    expect(queued.some((j) => j.type === FILE_RETENTION_JOB_TYPE)).toBe(true);
  });

  it("keeps the horizon longer than any client replay window", () => {
    // The one number this policy is: shorter than a week and a legitimate retry
    // starts duplicating documents instead of answering with the first one.
    expect(SAVE_INTENT_RETENTION_MS).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000);
  });
});

describe("PdfToolBatchHandler", () => {
  let env: Env;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => {
    env.worker.stop();
    await env.cleanup();
  });

  /** Registers the batch handler with a fake processor writing distinct outputs. */
  function registerBatch(env: Env, makeOutput: (ctx: ProcessContext, i: number) => Promise<ServerOutput>) {
    let i = 0;
    env.worker.register(
      PDF_TOOL_BATCH_JOB_TYPE,
      createPdfToolBatchHandler({
        storage: env.storage,
        fileMeta: env.fileMeta,
        upload: env.upload,
        jobRepo: env.jobRepo,
        logger: env.logger,
        resolveProcessor: () => async (ctx) => makeOutput(ctx, i++),
      }),
    );
  }

  it("zips the per-input outputs into one stored archive", async () => {
    registerBatch(env, async (ctx) => {
      const idx = Number(path.basename(ctx.jobDir).replace("item-", ""));
      const outPath = path.join(ctx.jobDir, "output.pdf");
      await fs.writeFile(outPath, `out-${idx}`);
      return {
        outputPath: outPath,
        downloadName: `${ctx.baseName}-out.pdf`,
        mimeType: "application/pdf",
      };
    });

    const bytes = [Buffer.from("a"), Buffer.from("b"), Buffer.from("c")];
    const fileIds = await Promise.all(bytes.map((b) => stageInput(env, b)));
    const inputs = bytes.map((b, i) => ({
      fileId: fileIds[i],
      originalName: `in-${i}.pdf`,
      ext: ".pdf",
      baseName: `in-${i}`,
      size: b.length,
    }));

    env.worker.start();
    const job = await env.service.enqueueBatch({
      slug: "compress-pdf",
      inputs,
      options: {},
      ownerType: "anon",
      ownerId: "anon",
      actor: TEST_ACTOR,
    });
    const status = await env.service.awaitCompletion(job.id, 5000, 25);

    expect(status.status).toBe("completed");
    expect(status.result?.mimeType).toBe("application/zip");
    expect(status.result?.downloadName).toBe("processed-files.zip");
    expect(status.result?.originalSize).toBe(bytes.reduce((s, b) => s + b.length, 0));

    // The stored archive contains one entry per input, named by each output.
    const zipBuf = await env.storage.get(status.result!.outputKey);
    const zip = await JSZip.loadAsync(zipBuf);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
    expect(names).toEqual([
      "in-0-out.pdf",
      "in-1-out.pdf",
      "in-2-out.pdf",
    ]);
    expect(await zip.files["in-1-out.pdf"].async("string")).toBe("out-1");
  });

  it("fails the whole batch when one input errors (no partial zip)", async () => {
    registerBatch(env, async (ctx) => {
      const idx = Number(path.basename(ctx.jobDir).replace("item-", ""));
      if (idx === 1) throw new ProcessingError("File 1 is corrupt.");
      const outPath = path.join(ctx.jobDir, "output.pdf");
      await fs.writeFile(outPath, `ok-${idx}`);
      return {
        outputPath: outPath,
        downloadName: `${ctx.baseName}-out.pdf`,
        mimeType: "application/pdf",
      };
    });

    const bytes = [Buffer.from("a"), Buffer.from("b"), Buffer.from("c")];
    const fileIds = await Promise.all(bytes.map((b) => stageInput(env, b)));
    const inputs = bytes.map((b, i) => ({
      fileId: fileIds[i],
      originalName: `in-${i}.pdf`,
      ext: ".pdf",
      baseName: `in-${i}`,
      size: b.length,
    }));

    env.worker.start();
    const job = await env.service.enqueueBatch({
      slug: "compress-pdf",
      inputs,
      options: {},
      ownerType: "anon",
      ownerId: "anon",
      actor: TEST_ACTOR,
    });
    const status = await env.service.awaitCompletion(job.id, 5000, 25);

    expect(status.status).toBe("failed");
    expect(status.errorType).toBe("processing");
    expect(status.error).toBe("File 1 is corrupt.");
    expect(status.result).toBeNull(); // no partial output
  });

  it("reports per-file progress", async () => {
    registerBatch(env, async (ctx) => {
      const outPath = path.join(ctx.jobDir, "output.pdf");
      await fs.writeFile(outPath, "ok");
      return {
        outputPath: outPath,
        downloadName: `${ctx.baseName}-out.pdf`,
        mimeType: "application/pdf",
      };
    });

    const bytes = [Buffer.from("a"), Buffer.from("b")];
    const fileIds = await Promise.all(bytes.map((b) => stageInput(env, b)));
    const inputs = bytes.map((b, i) => ({
      fileId: fileIds[i],
      originalName: `in-${i}.pdf`,
      ext: ".pdf",
      baseName: `in-${i}`,
      size: b.length,
    }));

    const details: string[] = [];
    env.worker.start();
    const job = await env.service.enqueueBatch({
      slug: "compress-pdf",
      inputs,
      options: {},
      ownerType: "anon",
      ownerId: "anon",
      actor: TEST_ACTOR,
    });
    env.events.onProgress(job.id, (e) => {
      if (e.detail) details.push(e.detail);
    });
    const status = await env.service.awaitCompletion(job.id, 5000, 25);
    expect(status.status).toBe("completed");
    expect(details.some((d) => d.includes("1/2"))).toBe(true);
    expect(details.some((d) => d.includes("Packaging results"))).toBe(true);
  });
});
