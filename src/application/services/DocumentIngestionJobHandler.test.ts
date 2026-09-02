import { describe, expect, it, vi } from "vitest";
import {
  DOCUMENT_INGESTION_JOB_TYPE,
  DocumentIngestionJobHandler,
  isDocumentIngestionJobPayload,
} from "./DocumentIngestionJobHandler";
import type { DocumentIngestionService } from "./DocumentIngestionService";
import type { ILogger, LogFields } from "@/src/application/ports/Logger";
import type { Job } from "@/src/domain/entities/Job";
import type { JobContext } from "@/src/application/ports/queue/Worker";

class TestLogger implements ILogger {
  readonly entries: Array<{ level: string; message: string; fields?: LogFields }> = [];
  debug(m: string, f?: LogFields) { this.entries.push({ level: "debug", message: m, fields: f }); }
  info(m: string, f?: LogFields) { this.entries.push({ level: "info", message: m, fields: f }); }
  warn(m: string, f?: LogFields) { this.entries.push({ level: "warn", message: m, fields: f }); }
  error(m: string, f?: LogFields) { this.entries.push({ level: "error", message: m, fields: f }); }
  child(): ILogger { return this; }
}

function job(payload: unknown): Job {
  return { id: "job-1", type: DOCUMENT_INGESTION_JOB_TYPE, payload } as Job;
}

function context() {
  const progress: Array<{ pct: number; detail?: string }> = [];
  const ctx: JobContext = {
    progress: async (pct, detail) => { progress.push({ pct, detail }); },
    isCancelled: () => false,
  };
  return { ctx, progress };
}

const PAYLOAD = {
  organizationId: "org-1",
  workspaceId: "ws-1",
  documentId: "doc-1",
  ingestionId: "ing-1",
};

function serviceDouble(outcome: unknown): DocumentIngestionService {
  return { processIngestion: vi.fn(async () => outcome) } as unknown as DocumentIngestionService;
}

describe("isDocumentIngestionJobPayload", () => {
  it("accepts a complete id-only payload", () => {
    expect(isDocumentIngestionJobPayload(PAYLOAD)).toBe(true);
  });

  it.each([
    ["null", null],
    ["a string", "ing-1"],
    ["a missing field", { ...PAYLOAD, ingestionId: undefined }],
    ["an empty field", { ...PAYLOAD, workspaceId: "" }],
    ["a non-string field", { ...PAYLOAD, documentId: 42 }],
  ])("rejects %s", (_label, value) => {
    expect(isDocumentIngestionJobPayload(value)).toBe(false);
  });
});

describe("DocumentIngestionJobHandler", () => {
  it("enqueues a payload of identifiers only", async () => {
    const enqueue = vi.fn(async (_input: { type: string; payload: unknown }) => ({ id: "job-1" }));
    await DocumentIngestionJobHandler.enqueue(
      { enqueue, pull: vi.fn(), requeue: vi.fn() } as never,
      PAYLOAD,
    );

    const sent = enqueue.mock.calls[0]![0];
    const payload = sent.payload as Record<string, unknown>;
    expect(sent.type).toBe(DOCUMENT_INGESTION_JOB_TYPE);
    expect(Object.keys(payload).sort()).toEqual([
      "documentId",
      "ingestionId",
      "organizationId",
      "workspaceId",
    ]);
    // No storage key, checksum, byte content or signed URL may ride along: the
    // handler re-reads all of that from tenant-scoped persistence.
    expect(JSON.stringify(payload)).not.toMatch(/key|checksum|url|bytes/i);
  });

  it("reports a completed promotion with its version", async () => {
    const service = serviceDouble({
      status: "completed",
      created: true,
      version: { id: "v1", versionNumber: 1 },
    });
    const { ctx, progress } = context();
    const result = await new DocumentIngestionJobHandler(new TestLogger(), service).handle(
      job(PAYLOAD),
      ctx,
    );

    expect(result.result).toMatchObject({ status: "complete", versionId: "v1", versionNumber: 1 });
    expect(progress.at(-1)?.pct).toBe(100);
  });

  it("reports a duplicate delivery as already-complete rather than a failure", async () => {
    const service = serviceDouble({
      status: "completed",
      created: false,
      version: { id: "v1", versionNumber: 1 },
    });
    const { ctx } = context();
    const result = await new DocumentIngestionJobHandler(new TestLogger(), service).handle(
      job(PAYLOAD),
      ctx,
    );
    expect(result.result).toMatchObject({ status: "already-complete" });
  });

  it("rejects a malformed payload without calling the service", async () => {
    const service = serviceDouble({ status: "skipped", detail: "x" });
    const { ctx } = context();
    const result = await new DocumentIngestionJobHandler(new TestLogger(), service).handle(
      job({ workspaceId: "ws-1" }),
      ctx,
    );

    expect(result.result).toMatchObject({ status: "rejected" });
    expect(service.processIngestion).not.toHaveBeenCalled();
  });

  it("returns rather than throws for deterministic content failures", async () => {
    // Retrying bad bytes produces the same result, so this must not be
    // presented to the worker as a retryable fault.
    const service = serviceDouble({ status: "failed", reason: "not-a-pdf", message: "bad" });
    const { ctx } = context();
    const result = await new DocumentIngestionJobHandler(new TestLogger(), service).handle(
      job(PAYLOAD),
      ctx,
    );
    expect(result.result).toMatchObject({ status: "failed", reason: "not-a-pdf" });
  });

  it("propagates an infrastructure fault so the worker can retry it", async () => {
    const service = {
      processIngestion: vi.fn(async () => { throw new Error("database unavailable"); }),
    } as unknown as DocumentIngestionService;
    const { ctx } = context();

    await expect(
      new DocumentIngestionJobHandler(new TestLogger(), service).handle(job(PAYLOAD), ctx),
    ).rejects.toThrow("database unavailable");
  });

  it("keeps every reported progress value within bounds", async () => {
    const service = serviceDouble({ status: "skipped", detail: "already complete" });
    const { ctx, progress } = context();
    await new DocumentIngestionJobHandler(new TestLogger(), service).handle(job(PAYLOAD), ctx);

    expect(progress.length).toBeGreaterThan(0);
    for (const entry of progress) {
      expect(entry.pct).toBeGreaterThanOrEqual(0);
      expect(entry.pct).toBeLessThanOrEqual(100);
    }
  });

  it("registers itself under the ingestion job type", () => {
    const worker = { register: vi.fn() };
    new DocumentIngestionJobHandler(
      new TestLogger(),
      serviceDouble({ status: "skipped", detail: "x" }),
    ).register(worker as never);

    expect(worker.register).toHaveBeenCalledTimes(1);
    expect(worker.register.mock.calls[0][0]).toBe(DOCUMENT_INGESTION_JOB_TYPE);
  });
});
