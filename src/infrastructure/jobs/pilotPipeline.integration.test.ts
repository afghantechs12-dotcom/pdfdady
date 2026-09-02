import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { LocalFileStorage } from "@/src/infrastructure/storage/LocalFileStorage";
import { LocalSignedUrlService } from "@/src/infrastructure/storage/LocalSignedUrlService";
import { InMemoryStoredFileRepository } from "@/src/infrastructure/persistence/InMemoryStoredFileRepository";
import { InMemoryJobRepository } from "@/src/infrastructure/persistence/InMemoryJobRepository";
import { DatabaseQueue } from "@/src/infrastructure/queue/DatabaseQueue";
import { InMemoryQueue } from "@/src/infrastructure/queue/InMemoryQueue";
import { InMemoryWorker } from "@/src/infrastructure/queue/InMemoryWorker";
import { UploadService } from "@/src/application/services/UploadService";
import { DownloadService } from "@/src/application/services/DownloadService";
import { ConsoleLogger } from "@/src/infrastructure/logging/ConsoleLogger";
import { ToolProcessorRegistry } from "@/src/infrastructure/processing/ToolProcessorRegistry";
import { LegacyToolProcessor } from "@/src/infrastructure/processing/LegacyToolProcessor";
import {
  ProcessingJobService,
  PROCESSING_JOB_TYPE,
  PROCESSING_OUTPUT_TTL_MS,
  JobConflictError,
} from "@/src/application/services/ProcessingJobService";
import { ProcessingUsageRecorder } from "@/src/application/services/ProcessingUsageRecorder";
import type { ProcessingUsageEvent } from "@/src/application/services/ProcessingUsageRecorder";
import { UsageMeteringService } from "@/src/application/services/UsageMeteringService";
import { InMemoryUsageRepository } from "@/src/infrastructure/persistence/InMemoryUsageRepository";
import { StaticEntitlementProvider } from "@/src/infrastructure/metering/OrganizationEntitlementProvider";
import { periodBoundsFor } from "@/src/domain/metering/periods";
import type { IQueue } from "@/src/application/ports/queue/Queue";
import type { JobActor } from "@/src/application/services/jobOwnership";
import { JobAuthorizationError } from "@/src/application/services/jobOwnership";
import {
  isJobErrorCategory,
  safeMessageFor,
  type JobErrorCategory,
} from "@/src/domain/jobs/jobErrors";
import { toStatusResponse } from "@/lib/server/processingJobApi";
import { PILOT_TOOL_SLUG } from "@/lib/server/processingPilot";
import { processingTempRoot } from "@/lib/server/tempFiles";
import { createProcessingJobHandler } from "./ProcessingJobHandler";
import {
  DEFAULT_STALE_AFTER_MS,
  StuckJobRecoveryService,
} from "@/src/application/services/StuckJobRecoveryService";

/**
 * End-to-end integration for the pilot tool, with every layer real.
 *
 * "Real" is the point. The unit suites each hold one layer still and check the
 * next: the service tests use a fake worker, the handler tests use a fake
 * processor. Both can be green while the seam between them is wrong — which is
 * exactly what happened once already in this phase, when `retryJob` performed a
 * transition the worker's `requeue` then refused, so retry silently re-queued
 * nothing and every unit test still passed.
 *
 * So this file wires the actual chain a user's file travels: storage → job row →
 * the table-as-queue → a worker process draining it → the registry → the
 * Ghostscript processor → published output → a signed download. Nothing is
 * stubbed except the clock's patience.
 */

const logger = () => new ConsoleLogger("error");

/**
 * Whether Ghostscript is installed.
 *
 * Resolved synchronously at module load, not in `beforeAll`: `describe.skipIf`
 * is evaluated while the file is being collected, so an async probe would still
 * be pending and every suite would silently skip — fourteen tests reporting
 * green without running. Vacuous green is worse than a red environment check.
 */
function ghostscriptVersion(): string | null {
  try {
    return execFileSync("gs", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const GHOSTSCRIPT_VERSION = ghostscriptVersion();
const hasGhostscript = GHOSTSCRIPT_VERSION !== null;

class CapturingUsage extends ProcessingUsageRecorder {
  readonly events: ProcessingUsageEvent[] = [];
  constructor() {
    super(
      { track: () => {}, identify: () => {} } as never,
      { increment: () => {}, histogram: () => {}, gauge: () => {}, timing: () => {} } as never,
      logger(),
    );
  }
  record(event: ProcessingUsageEvent): void {
    this.events.push(event);
    super.record(event);
  }
}

const OWNER: JobActor = { ownerType: "user", ownerId: "user-e2e" };
const INTRUDER: JobActor = { ownerType: "user", ownerId: "user-other" };

/**
 * Which queue adapter the stack runs on, because the two shapes have genuinely
 * different failure modes and one of them hides a bug the other exposes.
 *
 * `"table"` (DatabaseQueue) keeps no list: a job is runnable because its row says
 * `queued`, so `queue.requeue` is a no-op and a retry path that forgets to
 * enqueue still works by accident. `"list"` (InMemoryQueue, and RedisQueue in
 * production) holds ids separately, so a missing enqueue means the job sits in
 * `queued` and is never picked up.
 *
 * The default container gives the web process a list queue and `npm run worker`
 * a table queue, so both are real deployments and a seam test that only covers
 * one covers the wrong half.
 */
type QueueKind = "table" | "list";

interface Stack {
  storage: LocalFileStorage;
  files: InMemoryStoredFileRepository;
  upload: UploadService;
  downloads: DownloadService;
  jobRepo: InMemoryJobRepository;
  queue: IQueue;
  worker: InMemoryWorker;
  jobs: ProcessingJobService;
  usage: CapturingUsage;
  /** The allowance ledger. Written only when the stack was built `metered`. */
  allowance: InMemoryUsageRepository;
  metering?: UsageMeteringService;
  storageRoot: string;
}

let stacks: Stack[] = [];

/**
 * Builds the whole stack. `DatabaseQueue` rather than `InMemoryQueue` on purpose:
 * it is what `npm run worker` uses by default, so this exercises the queue a
 * separate worker process would actually poll.
 */
async function buildStack(
  timeoutMs = 60_000,
  queueKind: QueueKind = "table",
  opts: { metered?: boolean } = {},
): Promise<Stack> {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pilot-e2e-"));
  const log = logger();
  const storage = new LocalFileStorage(storageRoot);
  const files = new InMemoryStoredFileRepository();
  const upload = new UploadService(storage, files, log);
  const downloads = new DownloadService(
    files,
    new LocalSignedUrlService("test-secret", "http://localhost:3000"),
  );
  const jobRepo = new InMemoryJobRepository();
  const queue: IQueue =
    queueKind === "table"
      ? new DatabaseQueue(jobRepo, log, { types: [PROCESSING_JOB_TYPE], pollMs: 5 })
      : new InMemoryQueue(jobRepo, log);
  const worker = new InMemoryWorker(queue, jobRepo, log);
  const jobs = new ProcessingJobService({ jobRepo, queue, worker, logger: log });
  const usage = new CapturingUsage();
  // Opt-in, so every existing test in this file keeps running with no allowance
  // ledger at all — which is also the fail-open deployment the metering seams are
  // required to work in.
  const allowance = new InMemoryUsageRepository();
  const metering = opts.metered
    ? new UsageMeteringService({
        usage: allowance,
        entitlements: new StaticEntitlementProvider("free"),
        logger: log,
        mode: "enforce",
      })
    : undefined;

  worker.register(
    PROCESSING_JOB_TYPE,
    createProcessingJobHandler({
      storage,
      upload,
      jobs,
      processors: new ToolProcessorRegistry([
        new LegacyToolProcessor(PILOT_TOOL_SLUG, timeoutMs),
      ]),
      usage,
      metering,
      logger: log,
      cancelPollMs: 20,
    }),
  );

  const stack: Stack = {
    storage,
    files,
    upload,
    downloads,
    jobRepo,
    queue,
    worker,
    jobs,
    usage,
    allowance,
    metering,
    storageRoot,
  };
  stacks.push(stack);
  return stack;
}

/** A real, multi-page, Ghostscript-compressible PDF with an embedded image. */
async function realPdf(pages = 3): Promise<Buffer> {
  const { PDFDocument, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842]);
    // Vector content gives Ghostscript something to actually rewrite; an empty
    // page would compress to roughly itself and prove little.
    for (let y = 0; y < 40; y++) {
      page.drawRectangle({
        x: 20,
        y: 20 + y * 20,
        width: 555,
        height: 12,
        color: rgb((y % 7) / 7, (y % 5) / 5, (y % 3) / 3),
      });
    }
  }
  return Buffer.from(await doc.save());
}

/**
 * The submission half of the request, in the same order the route performs it:
 * stage the bytes, create the job `created`, then queue it. The ordering is the
 * invariant — a job is only ever runnable after its inputs are durable.
 */
async function submit(
  s: Stack,
  bytes: Buffer,
  opts: { name?: string; actor?: JobActor; idempotencyKey?: string; maxAttempts?: number } = {},
) {
  const name = opts.name ?? "quarterly report.pdf";
  const actor = opts.actor ?? OWNER;
  const { file: staged } = await s.upload.uploadStream({
    ownerType: actor.ownerType === "user" ? "user" : "anon",
    ownerId: actor.ownerId,
    originalName: name,
    mimeType: "application/pdf",
    data: new Blob([new Uint8Array(bytes)]).stream(),
    key: `processing-inputs/${Math.random().toString(36).slice(2)}/input.pdf`,
    expiresAt: new Date(Date.now() + PROCESSING_OUTPUT_TTL_MS),
  });

  // The route debits admission before the row exists and carries the reservation
  // in the payload, so the worker can settle the same one. Mirrored here rather
  // than skipped: the double-charge questions this file has to answer are about
  // *that* reservation's lifetime.
  const reservation = s.metering
    ? (
        await s.metering.authorize({
          actor: { ownerType: actor.ownerType, ownerId: actor.ownerId },
          toolSlug: PILOT_TOOL_SLUG,
          executionMode: "remote_job",
          inputBytes: bytes.length,
          largestInputBytes: bytes.length,
        })
      ).reservation
    : null;

  const { job, deduplicated } = await s.jobs.createJob({
    actor,
    toolSlug: PILOT_TOOL_SLUG,
    inputs: [{ key: staged.key, displayName: name, bytes: bytes.length }],
    options: { level: "recommended" },
    idempotencyKey: opts.idempotencyKey ?? null,
    maxAttempts: opts.maxAttempts,
    usage: reservation ? { reservedAt: reservation.reservedAt.toISOString() } : null,
  });
  const queued = deduplicated ? job : await s.jobs.queueJob(job.id);
  return { job: queued, deduplicated, inputKey: staged.key };
}

/** Runs the worker until the job leaves the active states, like a real worker. */
async function drain(s: Stack, jobId: string, timeoutMs = 90_000): Promise<void> {
  s.worker.start();
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const row = await s.jobRepo.get(jobId);
      if (row && !["created", "queued", "running"].includes(row.status)) return;
      if (Date.now() > deadline) throw new Error(`Job ${jobId} never settled`);
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    s.worker.stop();
  }
}

/** Storage keys published under this job's output prefix. */
async function outputsFor(s: Stack, jobId: string): Promise<string[]> {
  const rows = await s.files.listByOwner("user", OWNER.ownerId);
  const keys = rows.map((r) => r.key).filter((k) => k.includes(`jobs/${jobId}/output/`));
  // A metadata row without bytes behind it is not a result either way, but check
  // the bytes too so a half-published output cannot pass as "nothing published".
  const live: string[] = [];
  for (const key of keys) {
    if ((await s.storage.head(key)).exists) live.push(key);
  }
  return live;
}

/**
 * Work directories this test run created for a job, ignoring anything that was
 * already there.
 *
 * The subtraction is not tidiness. A directory abandoned by an earlier run (a
 * crash, or a deliberately-broken build) sits in the same shared root as this
 * one's, and without the baseline a genuine cleanup regression fixed hours ago
 * still shows red — and worse, the reverse: whoever sees that red learns to
 * ignore it.
 *
 * The baseline handles *earlier* runs. It cannot handle a *concurrent* one, and
 * originally that mattered: ids were a bare per-process counter, vitest runs
 * files in parallel forks, and two forks minting `inmem-job-11` made a sibling's
 * live directory match this job's prefix. This assertion failed for it — a
 * different test each run, always the cleanup, never a real leak. The id
 * generator now carries per-process entropy, so a prefix match means this
 * process, and a failure here means what it says.
 */
let workDirBaseline = new Set<string>();

async function readWorkDirRoot(): Promise<string[]> {
  return fs.readdir(processingTempRoot()).catch(() => [] as string[]);
}

/**
 * This job's leftover work directories, after giving cleanup a chance to run.
 *
 * The wait is not a fudge factor — it closes a real ordering gap. `drain` returns
 * the moment the job ROW reaches a terminal status, but the work directory is
 * removed in the handler's `finally`, which runs *after* the failure bookkeeping
 * that wrote that status. So there is a genuine window in which a settled job's
 * scratch directory still exists, and asserting inside it fails on a correct
 * build — observed only under full-suite load, where the forks compete for CPU
 * and the window widens.
 *
 * Bounded, so this still fails on a real leak: a directory that is never removed
 * is reported after ~2s rather than hidden.
 */
async function workDirsFor(jobId: string): Promise<string[]> {
  const mine = async () =>
    (await readWorkDirRoot()).filter(
      (e) => e.startsWith(`${jobId}-`) && !workDirBaseline.has(e),
    );
  let left = await mine();
  for (let i = 0; i < 40 && left.length > 0; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
    left = await mine();
  }
  return left;
}

beforeEach(async () => {
  workDirBaseline = new Set(await readWorkDirRoot());
});

afterEach(async () => {
  for (const s of stacks) {
    s.worker.stop();
    await fs.rm(s.storageRoot, { recursive: true, force: true });
  }
  stacks = [];
});

describe("pilot pipeline: the environment it needs", () => {
  it("has Ghostscript available", () => {
    // Stated as a test rather than a silent skip: if the pilot's only dependency
    // is missing, every suite below skips, and a skip that nobody notices reads
    // exactly like a pass. This one line is what makes the difference visible.
    expect(
      GHOSTSCRIPT_VERSION,
      "Ghostscript (gs) is required for the pilot tool",
    ).not.toBeNull();
  });
});

describe.skipIf(!hasGhostscript)("pilot pipeline: success path", () => {
  let s: Stack;
  let input: Buffer;

  beforeEach(async () => {
    s = await buildStack();
    input = await realPdf();
  });

  it("carries a real PDF from submission to a signed download", async () => {
    const { job } = await submit(s, input);

    // Submission has not processed anything: that is the phase's whole claim.
    expect(job.status).toBe("queued");
    expect(job.startedAt).toBeNull();

    await drain(s, job.id);

    const row = await s.jobRepo.get(job.id);
    expect(row?.status).toBe("completed");
    expect(row?.progressStage).toBe("done");
    expect(row?.errorCategory).toBeNull();

    const result = await s.jobs.getResult(job.id, OWNER);
    // The user's name survives readably — a space is a legal filename character —
    // while nothing that could escape a path or a header does. Header safety is
    // `attachmentDisposition`'s job, not the name's.
    expect(result.output.downloadName).toBe("quarterly report-compressed.pdf");
    expect(result.output.bytes).toBeGreaterThan(0);

    // The bytes are really there, and really a PDF Ghostscript wrote.
    const stored = await s.files.get(result.output.fileId);
    expect(stored).not.toBeNull();
    const head = await s.storage.head(stored!.key);
    expect(head.exists).toBe(true);
    const body = await s.storage.get(stored!.key);
    expect(body.subarray(0, 5).toString()).toBe("%PDF-");

    // And a download URL can be minted for it.
    const dl = await s.downloads.getUrl(result.output.fileId);
    expect(dl?.url).toContain("http");
  }, 120_000);

  it("preserves the document: the output has the same page count", async () => {
    // Compression that silently dropped pages would still "succeed". The pilot
    // migration must not change what the tool produces.
    const { job } = await submit(s, input);
    await drain(s, job.id);
    const result = await s.jobs.getResult(job.id, OWNER);
    const stored = await s.files.get(result.output.fileId);
    const { PDFDocument } = await import("pdf-lib");
    const out = await PDFDocument.load(await s.storage.get(stored!.key));
    expect(out.getPageCount()).toBe(3);
  }, 120_000);

  it("records one usage event with sizes but no document content", async () => {
    const { job } = await submit(s, input);
    await drain(s, job.id);

    expect(s.usage.events).toHaveLength(1);
    const event = s.usage.events[0];
    expect(event.result).toBe("success");
    expect(event.executionMode).toBe("remote_job");
    expect(event.toolSlug).toBe(PILOT_TOOL_SLUG);
    expect(event.inputBytes).toBe(input.length);
    expect(event.outputBytes).toBeGreaterThan(0);
    expect(event.durationMs).toBeGreaterThanOrEqual(0);

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("quarterly");
    expect(serialized).not.toContain("%PDF");
    expect(serialized).not.toContain(processingTempRoot());
  }, 120_000);

  it("leaves no scratch files behind", async () => {
    const { job } = await submit(s, input);
    await drain(s, job.id);
    expect(await workDirsFor(job.id)).toEqual([]);
  }, 120_000);

  it("keeps no copy of the input on local disk after the run", async () => {
    const { job } = await submit(s, input);
    await drain(s, job.id);
    // The work-dir copy of the document is what the processor read; it must not
    // outlive the attempt. (The *staged* object in storage deliberately does —
    // see the next test.)
    expect(await workDirsFor(job.id)).toEqual([]);
  }, 120_000);

  it("puts the staged input on the same retention clock as the job", async () => {
    // The staged input is not deleted the moment the job finishes, and that is a
    // decision rather than an oversight: a retry has to be able to re-read it,
    // and a job whose input vanished on first failure would have a Retry button
    // that could never work. What makes it safe is that the copy expires with the
    // job instead of lingering forever — so this asserts the clock, which is the
    // actual guarantee, rather than an immediate delete that would break retry.
    const { job, inputKey } = await submit(s, input);
    await drain(s, job.id);

    const row = await s.jobRepo.get(job.id);
    const staged = (await s.files.listByOwner("user", OWNER.ownerId)).find(
      (f) => f.key === inputKey,
    );
    expect(staged, "the staged input should still be findable for a retry").toBeDefined();
    expect(staged!.expiresAt).not.toBeNull();
    expect(row!.expiresAt).not.toBeNull();
    // Same window, within the second it took to submit.
    const drift = Math.abs(staged!.expiresAt!.getTime() - row!.expiresAt!.getTime());
    expect(drift).toBeLessThan(5_000);
  }, 120_000);

  it("exposes the wire status a client actually polls", async () => {
    const { job } = await submit(s, input);
    await drain(s, job.id);
    const wire = toStatusResponse(s.jobs.toView((await s.jobRepo.get(job.id))!));

    expect(wire.status).toBe("completed");
    expect(wire.stage).toBe("done");
    expect(wire.progress).toBe(100);
    expect(wire.resultAvailable).toBe(true);
    expect(wire.cancellable).toBe(false);
    expect(wire.error).toBeNull();
    // Nothing internal crosses the boundary.
    const serialized = JSON.stringify(wire);
    expect(serialized).not.toContain(processingTempRoot());
    expect(serialized).not.toContain("processing-inputs/");
    expect(serialized).not.toContain("gs ");
  }, 120_000);

  it("returns the same job for a replayed idempotency key without running twice", async () => {
    const first = await submit(s, input, { idempotencyKey: "submit-once" });
    await drain(s, first.job.id);

    const replay = await submit(s, input, { idempotencyKey: "submit-once" });
    expect(replay.deduplicated).toBe(true);
    expect(replay.job.id).toBe(first.job.id);
    // One run, one usage event — a double-submit did not double the Ghostscript
    // work or the billing signal.
    expect(s.usage.events).toHaveLength(1);
  }, 120_000);

  it("does not hand the result to anyone else", async () => {
    const { job } = await submit(s, input);
    await drain(s, job.id);
    await expect(s.jobs.getResult(job.id, INTRUDER)).rejects.toThrow(
      JobAuthorizationError,
    );
  }, 120_000);
});

describe.skipIf(!hasGhostscript)("pilot pipeline: failure path", () => {
  let s: Stack;

  beforeEach(async () => {
    s = await buildStack();
  });

  /**
   * Input Ghostscript genuinely cannot process.
   *
   * Finding this took measuring rather than guessing, and the result is worth
   * recording: Ghostscript 10.x *repairs* damage aggressively. A file with a
   * valid `%PDF-` header and nonsense after it, and even a real PDF truncated to
   * 40% of its bytes, both exit 0 and produce output. So "corrupt PDF" is not a
   * reliable way to make this processor fail — the only thing that does is
   * content with no PDF structure at all.
   *
   * Which also says something about production: `validateUpload` sniffs the type
   * before anything is staged, so bytes like these would normally be rejected at
   * the door with `invalid_input`. This test stages them directly, past that
   * check, precisely to exercise the path where a processor fails on input the
   * earlier layers accepted — the case the retry and cleanup policy exists for.
   */
  const NOT_A_DOCUMENT = Buffer.alloc(4096, 0x7f);

  it("fails without inventing a result", async () => {
    const { job } = await submit(s, NOT_A_DOCUMENT, { name: "broken.pdf" });
    await drain(s, job.id);

    const row = await s.jobRepo.get(job.id);
    expect(row?.status).toBe("failed");

    // No result. Not an empty one, not a zero-byte file — none.
    expect(row?.result).toBeNull();
    expect(row?.outputBytes).toBeNull();
    await expect(s.jobs.getResult(job.id, OWNER)).rejects.toThrow(JobConflictError);

    // And nothing was published to storage under this job's output prefix.
    expect(await outputsFor(s, job.id)).toEqual([]);
  }, 120_000);

  it("tells the user something true and safe about the failure", async () => {
    const { job } = await submit(s, NOT_A_DOCUMENT, { name: "broken.pdf" });
    await drain(s, job.id);
    const row = await s.jobRepo.get(job.id);

    // The column is a plain string (SQLite has no enums), so narrow it rather
    // than casting: a value the closed union does not contain is itself a bug.
    expect(isJobErrorCategory(row?.errorCategory)).toBe(true);
    const category = row!.errorCategory as JobErrorCategory;
    // The safe message is the category's fixed sentence, with no dynamic detail.
    expect(row?.safeErrorMessage).toBe(safeMessageFor(category));

    // The internal diagnostic is kept — it has to be, for debugging.
    expect(row?.error).toBeTruthy();

    const wire = JSON.stringify(toStatusResponse(s.jobs.toView(row!)));
    // ...and none of it crosses the boundary. A Ghostscript failure's internals
    // are a command line and a temp path.
    expect(wire).not.toContain(processingTempRoot());
    expect(wire).not.toContain("gs ");
    expect(wire).not.toContain("-dNOPAUSE");
    expect(wire).not.toContain("Unrecoverable");
    expect(wire).not.toContain("broken.pdf");
    expect(wire).not.toContain("processing-inputs/");
  }, 120_000);

  it("cleans up after a failed attempt too", async () => {
    const { job } = await submit(s, NOT_A_DOCUMENT, { name: "broken.pdf" });
    await drain(s, job.id);
    // Cleanup lives in a `finally`, so failure is not a leak.
    expect(await workDirsFor(job.id)).toEqual([]);
  }, 120_000);

  it("records every attempt, with a category and no document content", async () => {
    const { job } = await submit(s, NOT_A_DOCUMENT, { name: "broken.pdf", maxAttempts: 2 });
    await drain(s, job.id);

    const failures = s.usage.events.filter((e) => e.result === "failure");
    expect(failures.length).toBeGreaterThanOrEqual(1);
    for (const event of failures) {
      expect(event.errorCategory).not.toBeNull();
      expect(event.outputBytes).toBeNull();
      expect(event.executionMode).toBe("remote_job");
    }
    // Every attempt is observable, numbered from one, with no gaps.
    expect(failures.map((e) => e.attempt)).toEqual(
      failures.map((_, i) => i + 1),
    );
    expect(JSON.stringify(s.usage.events)).not.toContain("broken.pdf");
  }, 120_000);

  it("spends the attempt budget and then stops", async () => {
    // `processor_failed` is a retryable category, so this input is retried — the
    // point is that it is retried a *bounded* number of times and then left
    // alone, rather than cycling through the queue forever.
    const { job } = await submit(s, NOT_A_DOCUMENT, { name: "broken.pdf", maxAttempts: 2 });
    await drain(s, job.id);

    const row = await s.jobRepo.get(job.id);
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(2);
    expect(s.usage.events.filter((e) => e.result === "failure")).toHaveLength(2);
    // Settled: nothing of this job is still waiting to run.
    expect(await s.queue.pull(0)).toBeNull();
  }, 120_000);

  it("stops offering a retry once the budget is spent", async () => {
    const { job } = await submit(s, NOT_A_DOCUMENT, { name: "broken.pdf", maxAttempts: 2 });
    await drain(s, job.id);
    const row = await s.jobRepo.get(job.id);

    // Enforced end-to-end, not just in the service: the automatic retries used
    // the whole budget, so the UI is told there is nothing left to offer and the
    // service refuses if asked anyway.
    expect(s.jobs.toView(row!).retryable).toBe(false);
    await expect(s.jobs.retryJob(job.id, OWNER)).rejects.toThrow(JobConflictError);
    expect((await s.jobRepo.get(job.id))?.status).toBe("failed");
  }, 120_000);
});

describe.skipIf(!hasGhostscript).each(["table", "list"] as QueueKind[])(
  "pilot pipeline: retry actually re-runs the work (%s queue)",
  (queueKind) => {
  it("takes a cancelled job all the way to a downloadable result", async () => {
    // The regression test for this phase's worst bug, written as the user story
    // it broke: cancel by mistake, press Try again, get your file.
    //
    // Two independent faults have to be absent for this to pass, and both were
    // present at once earlier in this phase. First, `retryJob` has to actually
    // enqueue — it once transitioned the row to `queued` and then delegated the
    // enqueue to `worker.requeue`, whose own transition was refused because the
    // row was already `queued`, so nothing was ever queued and the job sat there
    // forever. Second, the worker's cancellation flag has to be cleared — a job
    // cancelled while queued never ran, so nothing cleaned up its flag, and the
    // revived attempt aborted on its first check.
    //
    // Both faults leave the row in a plausible-looking state, which is why every
    // unit test passed through them. Only running the whole chain shows it: this
    // test asserts a completed job with real bytes behind it, which neither fault
    // can produce.
    const s = await buildStack(60_000, queueKind);
    const { job } = await submit(s, await realPdf(2));

    await s.jobs.cancelJob(job.id, OWNER);
    expect((await s.jobRepo.get(job.id))?.status).toBe("cancelled");

    const retried = await s.jobs.retryJob(job.id, OWNER);
    expect(retried.status).toBe("queued");

    await drain(s, job.id, 60_000);

    const row = await s.jobRepo.get(job.id);
    expect(row?.status).toBe("completed");
    expect(row?.progressStage).toBe("done");

    // Not merely "not cancelled" — a real result the user can download.
    const result = await s.jobs.getResult(job.id, OWNER);
    const stored = await s.files.get(result.output.fileId);
    const body = await s.storage.get(stored!.key);
    expect(body.subarray(0, 5).toString()).toBe("%PDF-");
  }, 120_000);

  it("does not grant a fresh attempt budget on retry", async () => {
    // `worker.requeue` resets `attempts` to zero. If retry went through it, a
    // user could press Try again indefinitely and each press would buy three
    // more Ghostscript runs.
    const s = await buildStack(60_000, queueKind);
    const { job } = await submit(s, await realPdf(1), { maxAttempts: 3 });
    await s.jobs.cancelJob(job.id, OWNER);
    await s.jobRepo.update(job.id, { attempts: 2 });

    await s.jobs.retryJob(job.id, OWNER);
    expect((await s.jobRepo.get(job.id))?.attempts).toBe(2);
  }, 120_000);

  it("re-queues a job whose queue entry was already consumed by its failed run", async () => {
    // Why this test exists alongside the cancel-then-retry one above: that job
    // was cancelled *while it waited in the queue*, so its id was still sitting
    // unclaimed in the list-backed queue. A retry that forgot to enqueue would
    // still be picked up there — by the stale entry from the original submit —
    // and the test would pass while the seam was broken.
    //
    // Here the first attempt actually runs, which removes the id from the queue.
    // After that, only a fresh enqueue can make the job runnable again, and the
    // caller that needs one is the handler's own automatic retry: it records the
    // failed attempt and then asks `retryJob` to schedule another.
    //
    // A 1ms execution ceiling is what makes the attempt fail. A timeout is a
    // *retryable* category, so the handler auto-retries; a corrupt document would
    // be classified permanent and never reach the seam at all.
    const s = await buildStack(1, queueKind);
    const { job } = await submit(s, await realPdf(2), { maxAttempts: 2 });

    // Short deadline on purpose. A stranded job is diagnosable the moment the
    // queue goes quiet, and a guard that needs 90 seconds to report a bug is one
    // people learn to skip.
    await drain(s, job.id, 20_000);

    const row = await s.jobRepo.get(job.id);
    expect(row?.status).toBe("failed");
    expect(row?.errorCategory).toBe("processor_timeout");

    // The second attempt is the whole point: reaching it means the requeue after
    // attempt 1 actually put the job back on the queue. Were the enqueue skipped,
    // the row would still read `queued` with one attempt spent, and the drain
    // above would have hit its deadline instead.
    expect(row?.attempts).toBe(2);
    expect(s.usage.events.map((e) => e.attempt).sort()).toEqual([1, 2]);
    expect(s.usage.events.every((e) => e.result === "failure")).toBe(true);
  }, 90_000);
  },
);

describe.skipIf(!hasGhostscript).each(["table", "list"] as QueueKind[])(
  "pilot pipeline: worker crash recovery (%s queue)",
  (queueKind) => {
    /**
     * Simulates a worker that died immediately after claiming.
     *
     * The claim is performed through the repository with exactly the patch
     * `InMemoryWorker.process` applies, and then nothing runs — which is precisely
     * the row a `kill -9` between claim and outcome leaves behind. Killing a real
     * child process would test Node's signal handling, not this mechanism.
     */
    async function claimAndAbandon(s: Stack, jobId: string): Promise<void> {
      const claimed = await s.jobRepo.transition(jobId, "running", {
        startedAt: new Date(),
      });
      expect(claimed).not.toBeNull();
    }

    /** Backdates the lease. `updatedAt` is the lease, so there is no other lever. */
    function ageLease(s: Stack, jobId: string, ms: number): void {
      const row = (s.jobRepo as unknown as { jobs: Map<string, { updatedAt: Date }> }).jobs.get(
        jobId,
      );
      if (!row) throw new Error("job vanished");
      row.updatedAt = new Date(Date.now() - ms);
    }

    function recovery(s: Stack): StuckJobRecoveryService {
      return new StuckJobRecoveryService({
        jobRepo: s.jobRepo,
        queue: s.queue,
        logger: logger(),
      });
    }

    it("a replacement worker finishes the job the crashed one abandoned", async () => {
      const s = await buildStack(60_000, queueKind);
      const { job } = await submit(s, await realPdf(3));

      await claimAndAbandon(s, job.id);

      // The stuck state, before anything recovers it: `running`, no result, and —
      // the part that makes this a bug rather than a delay — no path back. The
      // user-facing retry command refuses a running job, so this row would sit
      // here until someone ran SQL.
      expect((await s.jobRepo.get(job.id))?.status).toBe("running");
      await expect(s.jobs.retryJob(job.id, OWNER)).rejects.toThrow(JobConflictError);

      // Not yet stale: a recovery that fired here would be reaping live workers.
      expect(await recovery(s).recoverStale()).toMatchObject({ examined: 0 });

      ageLease(s, job.id, DEFAULT_STALE_AFTER_MS + 60_000);
      expect(await recovery(s).recoverStale()).toMatchObject({
        examined: 1,
        requeued: 1,
      });

      // The replacement worker. Same stack, but this is a fresh drain: it pulls
      // from the queue, claims, and runs the real Ghostscript processor.
      await drain(s, job.id);

      const row = await s.jobRepo.get(job.id);
      expect(row?.status).toBe("completed");
      // Same logical job: same id, same owner, same tool, same payload. A recovery
      // that created a new job would break every URL the user already holds.
      expect(row?.id).toBe(job.id);
      expect(row?.ownerId).toBe(OWNER.ownerId);
      expect(row?.toolSlug).toBe(PILOT_TOOL_SLUG);
      expect(row?.payload).toEqual(job.payload);

      // The abandoned attempt was charged, and the successful one is attempt 2.
      expect(row?.attempts).toBe(2);
      expect(s.usage.events.map((e) => e.attempt)).toEqual([2]);
      expect(s.usage.events[0]?.result).toBe("success");

      // Exactly one published output. Two would mean the crashed attempt's work
      // and the recovered attempt's work both landed — the duplicate-ownership
      // failure this whole mechanism has to avoid.
      const outputs = await outputsFor(s, job.id);
      expect(outputs).toHaveLength(1);
      // And the result the user downloads is the one the surviving attempt wrote.
      const result = await s.jobs.getResult(job.id, OWNER);
      expect(outputs[0]).toBe(result.output.key);
      expect(await workDirsFor(job.id)).toEqual([]);
    }, 120_000);

    it("leaves no stranded processing row when the budget runs out", async () => {
      const s = await buildStack(60_000, queueKind);
      // One attempt only, so the crash exhausts the budget immediately.
      const { job } = await submit(s, await realPdf(2), { maxAttempts: 1 });

      await claimAndAbandon(s, job.id);
      ageLease(s, job.id, DEFAULT_STALE_AFTER_MS + 60_000);

      expect(await recovery(s).recoverStale()).toMatchObject({
        examined: 1,
        failed: 1,
        requeued: 0,
      });

      const row = await s.jobRepo.get(job.id);
      // Terminal and honest, rather than requeued into a loop that can never end.
      expect(row?.status).toBe("failed");
      expect(row?.errorCategory).toBe("internal_error");
      expect(row?.safeErrorMessage).toBe(safeMessageFor("internal_error"));
      // The user sees a finished job, not a Retry button that would be refused.
      expect(toStatusResponse(s.jobs.toView(row!)).retryable).toBe(false);
      expect(await outputsFor(s, job.id)).toEqual([]);

      // Nothing left in `running`, which is the invariant this slice exists for.
      expect(await s.jobRepo.listByStatus("running", 10)).toEqual([]);
      // And a second sweep finds nothing to do: a terminal job is never a
      // candidate, so it cannot be resurrected on the next pass.
      expect(await recovery(s).recoverStale()).toMatchObject({ examined: 0 });
    }, 120_000);
  },
);

describe.skipIf(!hasGhostscript)("pilot pipeline: cancellation", () => {
  it("never publishes a result for a job cancelled before it ran", async () => {
    const s = await buildStack();
    const { job } = await submit(s, await realPdf(2));

    // Cancelled while queued: the worker must not start it at all.
    const view = await s.jobs.cancelJob(job.id, OWNER);
    expect(view.view.status).toBe("cancelled");
    expect(view.stopped).toBe(true);

    await drain(s, job.id);

    const row = await s.jobRepo.get(job.id);
    expect(row?.status).toBe("cancelled");
    expect(row?.result).toBeNull();
    expect(row?.startedAt).toBeNull();
    await expect(s.jobs.getResult(job.id, OWNER)).rejects.toThrow(JobConflictError);
    // No output — checked by prefix rather than by "no files exist", because the
    // staged input legitimately still does.
    expect(await outputsFor(s, job.id)).toEqual([]);
    expect(await workDirsFor(job.id)).toEqual([]);
  }, 120_000);
});

describe.skipIf(!hasGhostscript).each(["table", "list"] as QueueKind[])(
  "pilot pipeline: a failed retry handoff (%s queue)",
  (queueKind) => {
    /** Net `server_operations` for the owner today. One per logical job, ever. */
    function operations(s: Stack): number {
      return s.allowance.counterAmount({
        ownerType: OWNER.ownerType,
        ownerId: OWNER.ownerId,
        meter: "server_operations",
        periodStart: periodBoundsFor("day", new Date()).start,
      });
    }

    it("keeps the job retryable, finishes it on the next retry, and charges once", async () => {
      const s = await buildStack(60_000, queueKind, { metered: true });
      const { job } = await submit(s, await realPdf(3));
      // Admission debited exactly once, before the row existed.
      expect(operations(s)).toBe(1);

      // A first attempt that failed the retryable way. Done through the service
      // rather than by breaking Ghostscript, because what is under test is the
      // handoff on the retry — this only has to produce the row a user sees a
      // Retry button on.
      expect(await s.jobs.startJob(job.id)).not.toBeNull();
      expect(await s.jobs.failJob(job.id, "processor_timeout", "diagnostic", 1)).toBe(true);
      // Drop the submission's ready-list entry: on the list adapter it is still
      // there, and leaving it would let the worker find this job without the
      // retry's push ever succeeding — the test would then pass on the strand.
      await s.queue.pull(0);

      const push = s.queue.requeue.bind(s.queue);
      let handoffWorks = false;
      s.queue.requeue = async (jobId: string) => {
        if (!handoffWorks) throw new Error("queue unavailable");
        await push(jobId);
      };

      // The user presses Retry and the queue refuses the id.
      await expect(s.jobs.retryJob(job.id, OWNER)).rejects.toThrow("queue unavailable");

      const rolled = (await s.jobRepo.get(job.id))!;
      expect(rolled.status).toBe("failed");
      expect(rolled.errorCategory).toBe("processor_timeout");
      expect(rolled.attempts).toBe(1);
      // The affordance survived, as the API itself reports it — a `queued` row
      // here would answer `retryable: false` and the job would be over.
      expect(toStatusResponse(s.jobs.toView(rolled)).retryable).toBe(true);
      // The refused handoff neither charged again nor refunded.
      expect(operations(s)).toBe(1);

      // Second retry, delivery healthy: the same logical job runs for real.
      handoffWorks = true;
      expect((await s.jobs.retryJob(job.id, OWNER)).status).toBe("queued");
      await drain(s, job.id);

      const done = (await s.jobRepo.get(job.id))!;
      expect(done.status).toBe("completed");
      expect(done.id).toBe(job.id);
      // Attempt 2, not a reset budget and not a third attempt burned by the
      // handoff the queue refused.
      expect(done.attempts).toBe(2);
      expect(await outputsFor(s, job.id)).toHaveLength(1);
      await expect(s.jobs.getResult(job.id, OWNER)).resolves.toBeTruthy();

      // Still one operation: one debit at admission, one settlement at the
      // terminal outcome, and nothing from the refused handoff. A second
      // reservation would read 2; a stray release plus the terminal settlement
      // would read 0, which is allowance minted out of a queue error.
      expect(operations(s)).toBe(1);
      // And the settlement claim is durable, so a replayed settlement is a no-op
      // rather than a second refund.
      expect(await s.allowance.claimSettlement(job.id, new Date())).toBe(false);
    }, 120_000);
  },
);
