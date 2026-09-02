import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { IWorker } from "@/src/application/ports/queue/Worker";
import type { IJobScheduler } from "@/src/application/ports/queue/JobScheduler";
import type { IObjectStorage } from "@/src/application/ports/storage/ObjectStorage";
import type { IFileMetadataRepository } from "@/src/application/ports/storage/FileMetadataRepository";
import type { IUploadService } from "@/src/application/ports/storage/UploadService";
import type { IJobRepository } from "@/src/application/ports/repositories/JobRepository";
import type { ILogger } from "@/src/application/ports/Logger";
import type { UsageMeteringService } from "@/src/application/services/UsageMeteringService";

import {
  PDF_TOOL_JOB_TYPE,
  PDF_TOOL_BATCH_JOB_TYPE,
  FILE_RETENTION_JOB_TYPE,
} from "@/src/application/services/PdfToolJobService";
import {
  createPdfToolHandler,
  createPdfToolBatchHandler,
  createFileRetentionHandler,
  RETENTION_INTERVAL_MS,
} from "./PdfToolWorkerHandler";
import { registerProcessingHandler } from "./processingBootstrap";
import { DocumentIngestionJobHandler } from "@/src/application/services/DocumentIngestionJobHandler";
import type { DocumentIngestionService } from "@/src/application/services/DocumentIngestionService";
import {
  startStuckJobRecovery,
  type StuckJobRecoveryService,
} from "@/src/application/services/StuckJobRecoveryService";

/**
 * Starts the background worker (if not already running) and registers the
 * `pdf-tool` and `file-retention` job handlers. Called lazily from the tool/job
 * routes on first use — NOT at boot — so the app never touches the DB/queue
 * before a route actually needs it, and a deployment with no tool traffic runs
 * no background loop. Idempotent: a process-level flag makes repeat calls no-ops
 * (worker.start() is itself idempotent; register() overwrites with the same
 * handler).
 *
 * Provider-agnostic: the resolved IWorker/IJobScheduler are in-memory by default
 * or Redis when REDIS_URL is set — this function knows nothing about which.
 */
let booted = false;
let stopStuckJobRecovery: (() => void) | null = null;

export function ensureWorkerReady(): void {
  if (booted) return;
  booted = true;

  const logger = appContainer.resolve<ILogger>(Tokens.Logger);
  const worker = appContainer.resolve<IWorker>(Tokens.Worker);
  // Resolved once and handed to both tool handlers. The legacy `pdf-tool` path
  // serves every one of the fourteen server tools, so this is the wiring that makes
  // authoritative usage a property of every server tool rather than of the pilot.
  const metering = appContainer.resolve<UsageMeteringService>(
    Tokens.UsageMeteringService,
  );

  worker.register(
    PDF_TOOL_JOB_TYPE,
    createPdfToolHandler({
      storage: appContainer.resolve<IObjectStorage>(Tokens.ObjectStorage),
      fileMeta: appContainer.resolve<IFileMetadataRepository>(
        Tokens.FileMetadataRepository,
      ),
      upload: appContainer.resolve<IUploadService>(Tokens.UploadService),
      jobRepo: appContainer.resolve<IJobRepository>(Tokens.JobRepository),
      logger,
      metering,
    }),
  );

  worker.register(
    PDF_TOOL_BATCH_JOB_TYPE,
    createPdfToolBatchHandler({
      storage: appContainer.resolve<IObjectStorage>(Tokens.ObjectStorage),
      fileMeta: appContainer.resolve<IFileMetadataRepository>(
        Tokens.FileMetadataRepository,
      ),
      upload: appContainer.resolve<IUploadService>(Tokens.UploadService),
      jobRepo: appContainer.resolve<IJobRepository>(Tokens.JobRepository),
      logger,
      metering,
    }),
  );

  worker.register(
    FILE_RETENTION_JOB_TYPE,
    createFileRetentionHandler({
      storage: appContainer.resolve<IObjectStorage>(Tokens.ObjectStorage),
      fileMeta: appContainer.resolve<IFileMetadataRepository>(
        Tokens.FileMetadataRepository,
      ),
      scheduler: appContainer.resolve<IJobScheduler>(Tokens.JobScheduler),
      logger,
    }),
  );

  // The unified processing pipeline. Registered here as well as in the
  // standalone worker so a deployment that has not yet split the worker out
  // still serves processing jobs — the pipeline's benefit (the request returns
  // before the work starts) does not depend on a separate process, only on the
  // work leaving the request. `npm run worker` is how that becomes a separate
  // process; this registration is why it does not have to be one on day one.
  registerProcessingHandler(worker);

  // Upload ingestion: promotes a pending ingestion into the document's initial
  // version. Without this registration an uploaded document would stay
  // unopenable — the content route serves bytes named by a version manifest,
  // and nothing else would ever cut that version.
  const ingestionService = appContainer.resolve<DocumentIngestionService>(
    Tokens.DocumentIngestionService,
  );
  new DocumentIngestionJobHandler(logger, ingestionService).register(worker);

  worker.start();

  // Recover uploads whose job never made it onto the queue.
  //
  // The upload path keeps its rows when an enqueue fails, which is right — the
  // bytes are durable — but it means "pending" can mean "no job exists". This
  // bounded sweep is what closes that gap; without it the reliability claim
  // would rest on an enqueue that is not transactional with the write. It runs
  // after start() so promotions the sweep triggers are drained normally, and a
  // failure is logged rather than fatal: a sweep is recovery, not a
  // precondition for serving traffic.
  ingestionService.reconcileUnfinished().catch((err) => {
    logger.warn("Ingestion recovery sweep failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Return jobs abandoned by a dead worker to the queue.
  //
  // Started here, not only in the standalone worker, because this IS the worker
  // in a single-process deployment — the container image runs the web server and
  // nothing else, so a sweep that only ran under `npm run worker` would never
  // run in production. Sweeps immediately (a restart is exactly when stale rows
  // exist) and then on a timer, since a worker can die long after startup and
  // nothing would otherwise notice.
  stopStuckJobRecovery?.();
  stopStuckJobRecovery = startStuckJobRecovery(
    appContainer.resolve<StuckJobRecoveryService>(Tokens.StuckJobRecoveryService),
    logger,
  );

  // Kick off the recurring retention sweep (it re-schedules itself on each
  // completion). A rejected schedule is logged, not fatal — outputs still get
  // purged on the next successful schedule.
  const scheduler = appContainer.resolve<IJobScheduler>(Tokens.JobScheduler);
  scheduler
    .schedule(
      { type: FILE_RETENTION_JOB_TYPE, payload: {}, maxAttempts: 1 },
      new Date(Date.now() + RETENTION_INTERVAL_MS),
    )
    .catch((err) => {
      logger.warn("Failed to schedule initial retention sweep", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  logger.info("PDF tool worker ready", {
    queueType: PDF_TOOL_JOB_TYPE,
    retentionType: FILE_RETENTION_JOB_TYPE,
  });
}

/**
 * Test-only: resets the boot flag so a fresh worker can be started in tests.
 *
 * Also stops the recovery timer. It is unref'd, so leaving it would not hang a
 * run, but a stale timer holding a previous test's container would keep sweeping
 * against a repository the next test believes it owns.
 */
export function _resetWorkerBootstrapForTests(): void {
  booted = false;
  stopStuckJobRecovery?.();
  stopStuckJobRecovery = null;
}
