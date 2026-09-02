/**
 * WORKER RECOVERY PROBE — a real worker process is killed mid-job, and a
 * replacement worker finishes the same job.
 *
 * WHY THIS EXISTS. The recovery mechanism has a unit suite and an integration
 * suite behind it, and neither can make the claim this probe makes:
 *
 *  - Both SIMULATE the crash by writing the row a crash would leave. That is the
 *    right thing for a test, but it assumes the row a killed process leaves looks
 *    the way we think it does. Here a real child process is `SIGKILL`ed between
 *    claim and outcome, and the row is read back from SQLite.
 *  - Both run on `InMemoryJobRepository`. The lease is Prisma's `@updatedAt`, a
 *    column no in-memory repository has. Whether `updateMany` bumps it is the
 *    single assumption the whole design rests on, and only Prisma can answer it.
 *  - Neither starts a worker process, so neither exercises the startup sweep that
 *    is how a restarted deployment actually reclaims its stranded work, nor the
 *    SIGTERM path that decides whether a deploy strands more of it.
 *
 * WHAT IT PINS, as the mutations it was run against:
 *
 *  - `@updatedAt` not bumped by the claim (or the lease read from `startedAt`):
 *    section 3's lease check fails, because the row's lease would still equal its
 *    creation time.
 *  - No startup sweep (drop the immediate `tick()`): section 5 fails on the
 *    deadline — the replacement worker boots, drains nothing, and the row stays
 *    `running` with the probe reporting it parked there.
 *  - Stale age ignored: section 4 fails, because the freshly-claimed row is
 *    recovered while the worker holding it is still alive.
 *  - Recovery refunds/settles the requeued attempt: section 6 fails on
 *    `server_operations`, which is the customer charge.
 *  - The attempt fence dropped from the `updateMany` WHERE clause (or `update`
 *    left unconditional): section 8 fails — a worker whose attempt was recovered
 *    lands its `failJob` on a job another worker owns, and its progress write
 *    refreshes that job's lease.
 *
 * THE HAZARD IT IS BUILT AGAINST is a vacuous pass, so every claim is paired
 * with a precondition that must be observed to CHANGE: the job must be seen
 * `running` under a live worker before that worker is killed, the fresh-lease
 * sweep must be observed to find nothing while the stale sweep finds exactly
 * this row, and the delivered output must be real PDF bytes rather than a
 * metadata row.
 *
 * Usage — no server, no build, no dev data touched (its own SQLite file and
 * storage root in a temp dir):
 *
 *   npx tsx scripts/worker-recovery-probe.mts [--keep]
 *
 * Requires Ghostscript (`gs`), because the recovered attempt does real work.
 */
/* global process, console, Buffer, setTimeout */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const KEEP = process.argv.includes("--keep");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let passed = 0;
const failures: string[] = [];
function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const section = (n: number, title: string) => console.log(`\n── ${n}. ${title}`);

// ---- environment -----------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), "worker-recovery-probe-"));
const DB_URL = `file:${join(root, "probe.db")}`;
const STORAGE_ROOT = join(root, "storage");
// Set BEFORE any app module is imported: the config module reads process.env at
// import time, so a static import here would bind the developer's own database.
const CHILD_ENV = {
  ...process.env,
  NODE_ENV: "development",
  DATABASE_URL: DB_URL,
  STORAGE_LOCAL_ROOT: STORAGE_ROOT,
  ADMIN_SECRET: "worker-recovery-probe-secret-0123456789abcdef",
  USAGE_LIMIT_MODE: "observe",
  REDIS_URL: "",
  // Only the startup sweep should fire. A recurring sweep with a one-second
  // threshold would reap the replacement worker's OWN in-flight job between
  // progress writes — a real misconfiguration, but not what this probe is about.
  WORKER_STALE_JOB_SWEEP_MS: "3600000",
  PROCESSING_EXPIRY_SWEEP_MS: "3600000",
  WORKER_CONCURRENCY: "1",
} as NodeJS.ProcessEnv;
Object.assign(process.env, CHILD_ENV);
// Deleted rather than set to undefined: assigning undefined to process.env stores
// the STRING "undefined", which is how this probe first discovered that a
// non-numeric threshold silently disabled the sweep.
delete process.env.WORKER_STALE_JOB_AFTER_MS;

const children: ChildProcess[] = [];
/** Everything each worker printed, so assertions can rest on the worker's own log. */
const logs: Record<string, string> = {};
function spawnWorker(name: string, staleAfterMs: number): ChildProcess {
  // `node --import tsx`, not `npx tsx` and not the `tsx` CLI: both of those put a
  // wrapper process in between, and a signal sent to the wrapper leaves the
  // worker running as an orphan. That is how the first run of this probe
  // "SIGKILLed" a worker which then calmly finished the job, and why its SIGTERM
  // observed `signal=SIGTERM` from the wrapper instead of the worker's exit(0).
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/workers/processingWorker.ts"],
    {
      env: { ...CHILD_ENV, WORKER_STALE_JOB_AFTER_MS: String(staleAfterMs) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(child);
  logs[name] = "";
  const tag = (line: string) => `    [${name}] ${line}`;
  const sink = (b: Buffer) => {
    logs[name] += b.toString();
    b.toString().split("\n").filter(Boolean).forEach((l) => console.log(tag(l)));
  };
  child.stdout?.on("data", sink);
  child.stderr?.on("data", sink);
  return child;
}

async function main(): Promise<void> {
  section(0, "Environment");
  let gs = "";
  try {
    gs = execFileSync("gs", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    /* reported below */
  }
  check("Ghostscript is installed", gs !== "", "the recovered attempt does real work");
  if (!gs) return;

  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: CHILD_ENV,
    stdio: "ignore",
  });
  console.log(`  ok   migrated a fresh SQLite database (gs ${gs})`);

  // Imported now, after the environment is set, so these resolve against the
  // probe's own database rather than the developer's.
  const { appContainer } = await import("@/src/application/di/container");
  const { Tokens } = await import("@/src/application/di/tokens");
  const { PROCESSING_OUTPUT_TTL_MS, PROCESSING_JOB_TYPE } = await import(
    "@/src/application/services/ProcessingJobService"
  );
  const { StuckJobRecoveryService, DEFAULT_STALE_AFTER_MS } = await import(
    "@/src/application/services/StuckJobRecoveryService"
  );
  const { DatabaseQueue } = await import("@/src/infrastructure/queue/DatabaseQueue");
  const { executionModeForSlug } = await import("@/lib/tools/executionPolicy");
  const { bufferToWebStream } = await import("@/lib/server/toolJobSubmit");
  const { PILOT_TOOL_SLUG } = await import("@/lib/server/processingPilot");
  type Prisma = import("@prisma/client").PrismaClient;
  type JobRepo = import("@/src/application/ports/repositories/JobRepository").IJobRepository;
  type Files =
    import("@/src/application/ports/storage/FileMetadataRepository").IFileMetadataRepository;
  type Storage = import("@/src/application/ports/storage/ObjectStorage").IObjectStorage;
  type Upload = import("@/src/application/ports/storage/UploadService").IUploadService;
  type Logger = import("@/src/application/ports/Logger").ILogger;
  type Jobs = import("@/src/application/services/ProcessingJobService").ProcessingJobService;
  type Metering = import("@/src/application/services/UsageMeteringService").UsageMeteringService;

  const prisma = appContainer.resolve<Prisma>(Tokens.PrismaClient);
  const jobRepo = appContainer.resolve<JobRepo>(Tokens.JobRepository);
  const jobs = appContainer.resolve<Jobs>(Tokens.ProcessingJobService);
  const metering = appContainer.resolve<Metering>(Tokens.UsageMeteringService);
  const upload = appContainer.resolve<Upload>(Tokens.UploadService);
  const files = appContainer.resolve<Files>(Tokens.FileMetadataRepository);
  const storage = appContainer.resolve<Storage>(Tokens.ObjectStorage);
  const logger = appContainer.resolve<Logger>(Tokens.Logger);

  // ---- 1. submit -----------------------------------------------------------

  section(1, "Submit, exactly as lib/server/processingJobSubmit.ts does it");
  const OWNER = { ownerType: "user" as const, ownerId: "probe-user" };
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // Big enough that Ghostscript is still working when the SIGKILL arrives: at
  // four pages the compress finished in ~100ms and the "crash" interrupted
  // nothing, which the preconditions in section 3 caught.
  for (let p = 0; p < 48; p++) {
    const page = doc.addPage([612, 792]);
    for (let row = 0; row < 40; row++) {
      page.drawText(`Page ${p + 1} line ${row + 1} — quarterly financial summary text`, {
        x: 40, y: 740 - row * 18, size: 11, font, color: rgb(0.1, 0.1, 0.25),
      });
    }
    for (let b = 0; b < 60; b++) {
      page.drawRectangle({
        x: 40 + (b % 12) * 45, y: 40 + Math.floor(b / 12) * 12,
        width: 40, height: 8, color: rgb((b % 7) / 7, (b % 5) / 5, (b % 3) / 3),
      });
    }
  }
  const bytes = Buffer.from(await doc.save());

  const authorization = await metering.authorize({
    actor: OWNER,
    toolSlug: PILOT_TOOL_SLUG,
    executionMode: executionModeForSlug(PILOT_TOOL_SLUG),
    inputBytes: bytes.length,
    largestInputBytes: bytes.length,
  });
  check("submission is admitted and holds one reservation", !!authorization.reservation);
  const expiresAt = new Date(Date.now() + PROCESSING_OUTPUT_TTL_MS);
  const { file: staged } = await upload.uploadStream({
    ownerType: "user",
    ownerId: OWNER.ownerId,
    originalName: "probe.pdf",
    mimeType: "application/pdf",
    data: bufferToWebStream(bytes),
    key: `processing-inputs/probe/${Date.now()}-probe.pdf`,
    expiresAt,
  });
  const created = await jobs.createJob({
    actor: OWNER,
    toolSlug: PILOT_TOOL_SLUG,
    inputs: [{ key: staged.key, displayName: "probe.pdf", bytes: bytes.length }],
    options: { level: "recommended" },
    idempotencyKey: "probe-recovery-key",
    usage: authorization.reservation
      ? { reservedAt: authorization.reservation.reservedAt.toISOString() }
      : null,
  });
  const job = await jobs.queueJob(created.job.id);
  const JOB_ID = job.id;
  check("job is persisted and queued", job.status === "queued", `status=${job.status}`);
  const createdRow = await jobRepo.get(JOB_ID);
  const leaseAtQueue = createdRow!.updatedAt.getTime();

  // ---- 2. a real worker claims it ------------------------------------------

  section(2, "Worker A claims the job, then is killed with SIGKILL");
  const workerA = spawnWorker("A", 600_000);
  let claimed = null as Awaited<ReturnType<JobRepo["get"]>>;
  const claimDeadline = Date.now() + 90_000;
  while (Date.now() < claimDeadline) {
    const row = await jobRepo.get(JOB_ID);
    if (row?.status === "running") {
      claimed = row;
      break;
    }
    await sleep(25);
  }
  check("a real worker process claimed the job", claimed !== null, "never reached running");
  if (!claimed) return;
  check("the claim recorded startedAt", claimed.startedAt !== null);
  check(
    "attempts is not consumed by the claim",
    claimed.attempts === 0,
    `attempts=${claimed.attempts}`,
  );

  // ---- 3. the lease -------------------------------------------------------

  section(3, "The lease is Prisma's updatedAt, and the claim refreshes it");
  check(
    "the claim bumped updatedAt through updateMany",
    claimed.updatedAt.getTime() > leaseAtQueue,
    `queued=${new Date(leaseAtQueue).toISOString()} claimed=${claimed.updatedAt.toISOString()}`,
  );

  const killed = new Promise<{ code: number | null; signal: string | null }>((r) =>
    workerA.once("exit", (code, signal) => r({ code, signal })),
  );
  workerA.kill("SIGKILL");
  const exitA = await killed;
  check("worker A died without running a shutdown handler", exitA.signal === "SIGKILL",
    `code=${exitA.code} signal=${exitA.signal}`);

  const stranded = await jobRepo.get(JOB_ID);
  check(
    "the row is left claimed, with no terminal status",
    stranded?.status === "running",
    `status=${stranded?.status}`,
  );
  check("the row has no result", stranded?.resultRef == null);
  await jobs
    .retryJob(JOB_ID, OWNER)
    .then(() => check("the user-facing retry cannot rescue it", false, "retryJob succeeded"))
    .catch(() => check("the user-facing retry cannot rescue it", true));

  // ---- 4. the fresh lease is not reaped ------------------------------------

  section(4, "A fresh lease is not recovered");
  const sweep = (staleAfterMs: number) =>
    new StuckJobRecoveryService({
      jobRepo,
      queue: new DatabaseQueue(jobRepo, logger, { types: [PROCESSING_JOB_TYPE] }),
      logger,
      staleAfterMs,
    });
  // Read the row FIRST: "examined 0" only means anything if there was a running
  // row available to examine.
  check(
    "the row is still claimed going into the sweep",
    (await jobRepo.get(JOB_ID))?.status === "running",
  );
  const fresh = await sweep(DEFAULT_STALE_AFTER_MS).recoverStale();
  check(
    "the default threshold finds nothing seconds after a claim",
    fresh.examined === 0,
    JSON.stringify(fresh),
  );
  check(
    "and the row is untouched by that pass",
    (await jobRepo.get(JOB_ID))?.status === "running",
  );

  // ---- 5. the replacement worker ------------------------------------------

  section(5, "Worker B's startup sweep recovers the job and finishes it");
  // The lease has to be older than worker B's threshold when B boots, and one
  // second is the shortest wait that is unambiguous.
  await sleep(1_500);
  const workerB = spawnWorker("B", 1_000);
  let terminal = null as Awaited<ReturnType<JobRepo["get"]>>;
  const runDeadline = Date.now() + 180_000;
  let sawQueued = false;
  while (Date.now() < runDeadline) {
    const row = await jobRepo.get(JOB_ID);
    if (row?.status === "queued") sawQueued = true;
    if (row && ["completed", "failed", "cancelled", "expired"].includes(row.status)) {
      terminal = row;
      break;
    }
    await sleep(150);
  }
  // Worker B's own sanitized log line is the evidence. A status poll can blink
  // past `queued`, and "it ended up completed" is satisfied by a job that was
  // never recovered at all — which is exactly how this check passed vacuously
  // when the SIGKILL was still hitting a wrapper process.
  check(
    "worker B's startup sweep requeued exactly one job",
    /Recovered stuck jobs/.test(logs.B) && /"requeued":1/.test(logs.B),
    `sawQueued=${sawQueued} log=${/Recovered stuck jobs.*/.exec(logs.B)?.[0] ?? "no such line"}`,
  );
  check("the recovered job reached a terminal state", terminal !== null, "still non-terminal");
  if (!terminal) return;
  check("it completed", terminal.status === "completed", `status=${terminal.status} cat=${terminal.errorCategory}`);

  section(6, "Same logical job, one customer charge, no stranded work");
  check("same job id", terminal.id === JOB_ID);
  check("same owner", terminal.ownerId === OWNER.ownerId);
  check("same tool", terminal.toolSlug === PILOT_TOOL_SLUG);
  check("same idempotency key", terminal.idempotencyKey === "probe-recovery-key");
  check(
    "same payload, so every URL the user already holds still resolves",
    JSON.stringify(terminal.payload) === JSON.stringify(job.payload),
  );
  check(
    "the abandoned attempt was charged and the successful one is attempt 2",
    terminal.attempts === 2,
    `attempts=${terminal.attempts}`,
  );

  const result = await jobs.getResult(JOB_ID, OWNER);
  const owned = await files.listByOwner("user", OWNER.ownerId);
  const outputs: string[] = [];
  for (const row of owned) {
    if (!row.key.includes(`jobs/${JOB_ID}/output/`)) continue;
    if ((await storage.head(row.key)).exists) outputs.push(row.key);
  }
  check("exactly one published output", outputs.length === 1, `keys=${outputs.length}`);
  check("and it is the one the user downloads", outputs[0] === result.output.key);
  const head = await storage.head(result.output.key);
  check("the output has real bytes", (head.size ?? 0) > 0, `size=${head.size}`);

  const running = await jobRepo.listByStatus("running", 10);
  check("no stranded processing row is left", running.length === 0, `rows=${running.length}`);
  const again = await sweep(1_000).recoverStale();
  check(
    "a later sweep does not resurrect the finished job",
    again.examined === 0,
    JSON.stringify(again),
  );

  const settlements = await prisma.usageSettlement.count({ where: { key: JOB_ID } });
  check("settled exactly once", settlements === 1, `rows=${settlements}`);
  const counters = await prisma.usageCounter.findMany({ where: { ownerId: OWNER.ownerId } });
  const operations = counters
    .filter((c) => c.meter === "server_operations")
    .reduce((sum, c) => sum + c.amount, 0);
  check(
    "one logical job is one customer charge",
    operations === 1,
    `server_operations=${operations}`,
  );
  const attempts = await prisma.usageEvent.findMany({
    where: { eventName: "tool_processing_completed" },
    orderBy: { attempt: "asc" },
    select: { attempt: true, result: true },
  });
  check(
    "compute telemetry records both attempts, the abandoned one as a failure",
    JSON.stringify(attempts) ===
      JSON.stringify([
        { attempt: 1, result: "failure" },
        { attempt: 2, result: "success" },
      ]),
    JSON.stringify(attempts),
  );

  // ---- 7. graceful shutdown ------------------------------------------------

  section(7, "SIGTERM on an idle worker exits promptly and cleanly");
  const stopped = new Promise<{ code: number | null; signal: string | null }>((r) =>
    workerB.once("exit", (code, signal) => r({ code, signal })),
  );
  const t0 = Date.now();
  workerB.kill("SIGTERM");
  const exitB = await stopped;
  const elapsed = Date.now() - t0;
  check("exited zero", exitB.code === 0, `code=${exitB.code} signal=${exitB.signal}`);
  check(
    "and it exited through the shutdown handler",
    /Processing worker shutting down/.test(logs.B) && /Processing worker stopped/.test(logs.B),
  );
  // Bounded in both directions: the grace period is 20s, and an idle worker must
  // not sleep it out — the defect this replaced did exactly that.
  check("exited without waiting out the grace period", elapsed < 5_000, `${elapsed}ms`);

  // ---- 8. the attempt fence ------------------------------------------------

  section(8, "A worker whose attempt was recovered cannot write to the job");
  // A second job, claimed and then recovered out from under its holder. Only
  // Prisma can answer the two questions this section asks: whether `updateMany`
  // honours `attempts` in its WHERE clause, and whether a refused write leaves
  // `@updatedAt` — the lease itself — alone.
  const zombieJob = await jobs.createJob({
    actor: OWNER,
    toolSlug: PILOT_TOOL_SLUG,
    inputs: [{ key: staged.key, displayName: "probe.pdf", bytes: bytes.length }],
    options: { level: "recommended" },
    idempotencyKey: "probe-fence-key",
    usage: null,
  });
  const FENCED_ID = zombieJob.job.id;
  await jobs.queueJob(FENCED_ID);
  const held = await jobs.startJob(FENCED_ID);
  check("the fence subject is claimed for attempt 1", held?.status === "running",
    `status=${held?.status} attempts=${held?.attempts}`);
  await sleep(5);
  const recovered = await sweep(0).recoverStale();
  check(
    "the sweep hands attempt 2 to someone else",
    recovered.requeued === 1,
    JSON.stringify(recovered),
  );
  const handedOver = await jobRepo.get(FENCED_ID);
  check(
    "and charges the abandoned attempt, which is the fence",
    handedOver?.status === "queued" && handedOver?.attempts === 1,
    `status=${handedOver?.status} attempts=${handedOver?.attempts}`,
  );

  // The zombie wakes up. `queued → failed` is a legal move, so nothing but the
  // fence stops it from failing a job another worker is about to run.
  const zombieFailed = await jobs.failJob(FENCED_ID, "processor_failed", "zombie", 1);
  const afterFail = await jobRepo.get(FENCED_ID);
  check("its failJob is refused", zombieFailed === false);
  check(
    "and the row is still queued for attempt 2",
    afterFail?.status === "queued" && afterFail?.attempts === 1,
    `status=${afterFail?.status} attempts=${afterFail?.attempts} cat=${afterFail?.errorCategory}`,
  );
  const zombieCancelled = await jobs.markCancelled(FENCED_ID, 1);
  check(
    "its markCancelled is refused too",
    zombieCancelled === false && (await jobRepo.get(FENCED_ID))?.status === "queued",
  );

  await sleep(5);
  await jobs.recordStage(FENCED_ID, "finalizing", 1);
  const afterStage = await jobRepo.get(FENCED_ID);
  check(
    "its progress write moves nothing",
    afterStage?.progressStage === afterFail?.progressStage,
    `stage=${afterStage?.progressStage}`,
  );
  check(
    "and does not refresh the lease, which is what would hide the job from the sweep",
    afterStage?.updatedAt.getTime() === afterFail?.updatedAt.getTime(),
    `before=${afterFail?.updatedAt.toISOString()} after=${afterStage?.updatedAt.toISOString()}`,
  );

  // The pairing: the same three calls from the worker that DOES own attempt 2.
  // Without these, a fence that refused everyone would pass every check above.
  await jobs.startJob(FENCED_ID);
  await sleep(5);
  await jobs.recordStage(FENCED_ID, "finalizing", 2);
  const live = await jobRepo.get(FENCED_ID);
  check("the successor's progress write lands", live?.progressStage === "finalizing",
    `stage=${live?.progressStage}`);
  check(
    "and it does refresh the lease",
    (live?.updatedAt.getTime() ?? 0) > (afterStage?.updatedAt.getTime() ?? 0),
    `before=${afterStage?.updatedAt.toISOString()} after=${live?.updatedAt.toISOString()}`,
  );
  const finished = await jobs.completeJob(FENCED_ID, { output: result.output }, 2);
  check(
    "and the successor can finish the job",
    finished === true && (await jobRepo.get(FENCED_ID))?.status === "completed",
  );

  await prisma.$disconnect();
}

main()
  .catch((err) => {
    failures.push(`probe threw: ${err instanceof Error ? err.stack : String(err)}`);
  })
  .finally(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    if (KEEP) console.log(`\nkept: ${root}`);
    else rmSync(root, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.log(`  FAIL ${f}`);
    process.exit(failures.length ? 1 : 0);
  });
