import { beforeEach, describe, expect, it, vi } from "vitest";

import { Tokens } from "@/src/application/di/tokens";
import type { IWorker, JobHandler } from "@/src/application/ports/queue/Worker";
import {
  FILE_RETENTION_JOB_TYPE,
  PDF_TOOL_JOB_TYPE,
  PDF_TOOL_BATCH_JOB_TYPE,
} from "@/src/application/services/PdfToolJobService";
import { DOCUMENT_INGESTION_JOB_TYPE } from "@/src/application/services/DocumentIngestionJobHandler";

/**
 * Whether the recurring sweep is WIRED, which no test asked before.
 *
 * `PdfToolWorkerHandler.test.ts` proves what the retention handler does when it is
 * called; mutation P1 proves that test is the guard for the save-intent prune. Both
 * of them stay green in a deployment where `file-retention` is never registered and
 * never scheduled — and then nothing expires: not a stored output, not an
 * intention row. That is the shape of failure this repository has already been
 * bitten by (a policy with green tests and a consumer that never called it), so
 * the assertion here is behavioural rather than "register was called": the handler
 * the bootstrap actually registered is RUN, and it has to prune.
 *
 * Three modules are faked and no more: the container (a token→fake map), the
 * processing bootstrap, and the stuck-job sweep. Everything else — the handler
 * factories, the ingestion handler, the schedule call — is the real code path.
 */

const registered = new Map<string, JobHandler>();
const scheduled: Array<{ type: string; runAt: Date }> = [];
const pruneCutoffs: Date[] = [];
let started = 0;

const worker: IWorker = {
  register: (type, handler) => void registered.set(type, handler),
  start: () => void (started += 1),
  stop: () => {},
  running: false,
  activeCount: 0,
  cancel: async () => {},
  clearCancellation: async () => {},
  requeue: async () => {},
};

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };

/** Every token `ensureWorkerReady` resolves, and nothing else. */
const fakes = new Map<symbol, unknown>([
  [Tokens.Logger, logger],
  [Tokens.Worker, worker],
  [Tokens.UsageMeteringService, {}],
  [Tokens.ObjectStorage, { delete: async () => {} }],
  [Tokens.FileMetadataRepository, { listExpired: async () => [], delete: async () => {} }],
  [Tokens.UploadService, {}],
  [Tokens.JobRepository, {}],
  [
    Tokens.WorkspaceSaveIntentRepository,
    {
      pruneBefore: async (cutoff: Date) => {
        pruneCutoffs.push(cutoff);
        return 0;
      },
    },
  ],
  [
    Tokens.JobScheduler,
    {
      schedule: async (job: { type: string }, runAt: Date) => {
        scheduled.push({ type: job.type, runAt });
      },
    },
  ],
  [Tokens.DocumentIngestionService, { reconcileUnfinished: async () => {} }],
  [Tokens.StuckJobRecoveryService, { recoverStale: async () => {} }],
]);

vi.mock("@/src/application/di/container", () => ({
  appContainer: {
    resolve: (token: symbol) => {
      if (!fakes.has(token)) throw new Error(`unexpected token: ${String(token)}`);
      return fakes.get(token);
    },
  },
}));
vi.mock("./processingBootstrap", () => ({ registerProcessingHandler: () => {} }));
vi.mock("@/src/application/services/StuckJobRecoveryService", () => ({
  startStuckJobRecovery: () => () => {},
}));

async function boot() {
  const mod = await import("./workerBootstrap");
  mod._resetWorkerBootstrapForTests();
  mod.ensureWorkerReady();
  return mod;
}

describe("ensureWorkerReady wires the recurring retention sweep", () => {
  beforeEach(async () => {
    registered.clear();
    scheduled.length = 0;
    pruneCutoffs.length = 0;
    started = 0;
    await boot();
  });

  it("registers every job type the product depends on, and starts the worker", () => {
    expect([...registered.keys()].sort()).toEqual(
      [
        DOCUMENT_INGESTION_JOB_TYPE,
        FILE_RETENTION_JOB_TYPE,
        PDF_TOOL_BATCH_JOB_TYPE,
        PDF_TOOL_JOB_TYPE,
      ].sort(),
    );
    expect(started).toBe(1);
  });

  it("schedules the first sweep, in the future rather than immediately", () => {
    const sweep = scheduled.find((s) => s.type === FILE_RETENTION_JOB_TYPE);
    expect(sweep).toBeDefined();
    expect(sweep!.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("registered a handler that really prunes save intentions and re-schedules itself", async () => {
    const handler = registered.get(FILE_RETENTION_JOB_TYPE);
    expect(handler).toBeDefined();

    await handler!({ id: "j1", type: FILE_RETENTION_JOB_TYPE, payload: {} } as never, {
      progress: async () => {},
      isCancelled: () => false,
    } as never);

    // The prune ran, with a cutoff in the past — a horizon of zero would purge
    // intentions that are still in flight.
    expect(pruneCutoffs).toHaveLength(1);
    expect(pruneCutoffs[0]!.getTime()).toBeLessThan(Date.now());
    // And the sweep recurs: the initial schedule plus the handler's own.
    expect(scheduled.filter((s) => s.type === FILE_RETENTION_JOB_TYPE)).toHaveLength(2);
  });
});
