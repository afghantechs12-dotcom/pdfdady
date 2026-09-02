import { beforeEach, describe, expect, it } from "vitest";
import {
  DocumentIngestionService,
  type IngestionOutcome,
} from "./DocumentIngestionService";
import type { ILogger, LogFields } from "@/src/application/ports/Logger";
import type {
  IObjectStorage,
  ObjectMetadata,
  StreamPutOptions,
  StreamPutResult,
} from "@/src/application/ports/storage/ObjectStorage";
import type { DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";
import type { DocumentRecord } from "@/src/domain/entities/DocumentRecord";
import { InMemoryStoredFileRepository } from "@/src/infrastructure/persistence/InMemoryStoredFileRepository";
import { InMemoryDocumentIngestionRepository } from "@/src/infrastructure/persistence/InMemoryDocumentIngestionRepository";
import { InMemoryDocumentVersionRepository } from "@/src/infrastructure/persistence/InMemoryDocumentVersionRepository";

class TestLogger implements ILogger {
  readonly entries: Array<{ level: string; message: string; fields?: LogFields }> = [];
  debug(message: string, fields?: LogFields): void {
    this.entries.push({ level: "debug", message, fields });
  }
  info(message: string, fields?: LogFields): void {
    this.entries.push({ level: "info", message, fields });
  }
  warn(message: string, fields?: LogFields): void {
    this.entries.push({ level: "warn", message, fields });
  }
  error(message: string, fields?: LogFields): void {
    this.entries.push({ level: "error", message, fields });
  }
  child(): ILogger {
    return this;
  }
}

const ORG = "org-alpha";
const ORG_OTHER = "org-beta";
const WS = "ws-alpha";
const DOC = "doc-1";
const USER = "user-1";

function pdfBytes(body = "hello"): Buffer {
  return Buffer.concat([Buffer.from("%PDF-1.7\n", "ascii"), Buffer.from(body, "utf8")]);
}

/**
 * An ObjectStorage double backed by a Map.
 *
 * `getStream` deliberately emits the object in *small chunks* and records
 * whether the reader cancelled: the signature probe must work when a store
 * hands back fewer bytes than the signature needs, and must not drain a whole
 * object to read five bytes. Both are properties this double can observe.
 */
class TestStorage implements IObjectStorage {
  readonly objects = new Map<string, Buffer>();
  chunkSize = 2;
  bytesRead = 0;
  cancelled = 0;

  async put(key: string, data: Buffer | Uint8Array): Promise<void> {
    this.objects.set(key, Buffer.from(data));
  }
  async get(key: string): Promise<Buffer> {
    const value = this.objects.get(key);
    if (!value) throw new Error("missing object");
    return value;
  }
  async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const value = this.objects.get(key);
    if (!value) throw new Error("missing object");
    let offset = 0;
    const record = (read: number) => {
      this.bytesRead += read;
    };
    const noteCancel = () => {
      this.cancelled += 1;
    };
    const chunkSize = this.chunkSize;
    return new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (offset >= value.length) {
          controller.close();
          return;
        }
        const chunk = value.subarray(offset, offset + chunkSize);
        offset += chunk.length;
        record(chunk.length);
        controller.enqueue(new Uint8Array(chunk));
      },
      cancel: () => {
        noteCancel();
      },
    });
  }
  async putStream(
    _key: string,
    _stream: ReadableStream<Uint8Array>,
    _options: StreamPutOptions,
  ): Promise<StreamPutResult> {
    throw new Error("not used");
  }
  async head(key: string): Promise<ObjectMetadata> {
    const value = this.objects.get(key);
    return {
      key,
      size: value?.length ?? 0,
      contentType: "application/pdf",
      exists: value !== undefined,
    };
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

/** A DocumentRecord store that honours the conditional pointer update. */
class TestDocuments implements Partial<DocumentRecordRepository> {
  readonly rows = new Map<string, DocumentRecord>();
  /** Runs before each conditional pointer write — used to simulate a race. */
  beforeSetCurrent: (() => void) | null = null;

  add(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
    const row = {
      id: DOC,
      workspaceId: WS,
      organizationId: ORG,
      projectId: null,
      folderId: null,
      name: "Doc.pdf",
      normalizedName: "doc.pdf",
      orderKey: "a0",
      favorite: false,
      lifecycleState: "active",
      currentVersionId: null,
      revision: 1,
      ...overrides,
    } as DocumentRecord;
    this.rows.set(row.id, row);
    return row;
  }

  async getById(workspaceId: string, documentId: string): Promise<DocumentRecord | null> {
    const row = this.rows.get(documentId);
    if (!row || row.workspaceId !== workspaceId) return null;
    return { ...row };
  }

  async setCurrentVersionIfUnset(
    workspaceId: string,
    documentId: string,
    versionId: string,
  ): Promise<boolean> {
    this.beforeSetCurrent?.();
    const row = this.rows.get(documentId);
    if (!row || row.workspaceId !== workspaceId) return false;
    if (row.currentVersionId !== null) return false;
    this.rows.set(documentId, { ...row, currentVersionId: versionId, revision: row.revision + 1 });
    return true;
  }
}

interface Harness {
  service: DocumentIngestionService;
  ingestions: InMemoryDocumentIngestionRepository;
  documents: TestDocuments;
  versions: InMemoryDocumentVersionRepository;
  files: InMemoryStoredFileRepository;
  storage: TestStorage;
  logger: TestLogger;
}

async function harness(): Promise<Harness> {
  const logger = new TestLogger();
  const ingestions = new InMemoryDocumentIngestionRepository();
  const documents = new TestDocuments();
  const versions = new InMemoryDocumentVersionRepository();
  const files = new InMemoryStoredFileRepository();
  const storage = new TestStorage();

  const service = new DocumentIngestionService(
    logger,
    ingestions,
    documents as unknown as DocumentRecordRepository,
    versions,
    files,
    storage,
    { now: () => new Date("2026-08-05T00:00:00.000Z") },
  );

  return { service, ingestions, documents, versions, files, storage, logger };
}

/** Seeds a complete, valid pending upload and returns its ingestion id. */
async function seedUpload(
  h: Harness,
  opts: { bytes?: Buffer; ownerType?: "anon" | "user" | "org"; ownerId?: string } = {},
): Promise<string> {
  const bytes = opts.bytes ?? pdfBytes();
  const checksum = "a".repeat(64);
  const key = `ca/aa/bb/${checksum}`;
  await h.storage.put(key, bytes);

  h.documents.add();
  const file = await h.files.create({
    ownerType: opts.ownerType ?? "org",
    ownerId: opts.ownerId ?? ORG,
    key,
    sha256: checksum,
    size: bytes.length,
    mimeType: "application/pdf",
    originalName: "Doc.pdf",
  });

  const ingestion = await h.ingestions.create({
    workspaceId: WS,
    organizationId: ORG,
    documentId: DOC,
    storedFileId: file.id,
    status: "pending",
    checksum,
    byteSize: bytes.length,
    mimeType: "application/pdf",
    originalName: "Doc.pdf",
    uploadedById: USER,
  });
  return ingestion.id;
}

describe("DocumentIngestionService", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  it("promotes a pending ingestion into an initial import version", async () => {
    const id = await seedUpload(h);
    const outcome = await h.service.processIngestion(WS, id);

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.created).toBe(true);
    expect(outcome.version.origin).toBe("import");
    expect(outcome.version.versionNumber).toBe(1);
    expect(outcome.version.documentId).toBe(DOC);
  });

  it("marks the ingestion complete and points the document at the new version", async () => {
    const id = await seedUpload(h);
    const outcome = await h.service.processIngestion(WS, id);
    if (outcome.status !== "completed") throw new Error("expected completion");

    const ingestion = await h.ingestions.getById(WS, id);
    expect(ingestion?.status).toBe("complete");
    expect(ingestion?.completedAt).not.toBeNull();

    const doc = await h.documents.getById(WS, DOC);
    expect(doc?.currentVersionId).toBe(outcome.version.id);
  });

  it("writes a manifest the content resolver can serve from", async () => {
    const id = await seedUpload(h);
    const outcome = await h.service.processIngestion(WS, id);
    if (outcome.status !== "completed") throw new Error("expected completion");

    const { resolveDocumentContent } = await import("./documentContent");
    const resolved = resolveDocumentContent({ documentId: DOC, version: outcome.version });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.byteSize).toBe(pdfBytes().length);
    expect(h.storage.objects.has(resolved.sourceKey)).toBe(true);
  });

  it("adopts an existing import version instead of creating a second one", async () => {
    const id = await seedUpload(h);
    await h.service.processIngestion(WS, id);

    // Re-open the ingestion so the promotion path runs again for the same doc.
    await h.ingestions.update(WS, id, { status: "pending", completedAt: null });
    const again = await h.service.processIngestion(WS, id);

    expect(again.status).toBe("completed");
    if (again.status !== "completed") return;
    expect(again.created).toBe(false);
    expect(await h.versions.countForDocument(WS, DOC)).toBe(1);
  });

  it("converges on duplicate delivery without cutting another version", async () => {
    const id = await seedUpload(h);
    const first = await h.service.processIngestion(WS, id);
    const second = await h.service.processIngestion(WS, id);

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    if (second.status !== "completed") return;
    expect(second.created).toBe(false);
    expect(await h.versions.countForDocument(WS, DOC)).toBe(1);
  });

  it("does not replace a newer currentVersionId chosen after the read", async () => {
    const id = await seedUpload(h);
    // A save lands between the document read and the pointer write. The
    // conditional update must decline rather than drag the document back.
    h.documents.beforeSetCurrent = () => {
      const row = h.documents.rows.get(DOC)!;
      h.documents.rows.set(DOC, { ...row, currentVersionId: "newer-version" });
      h.documents.beforeSetCurrent = null;
    };

    const outcome = await h.service.processIngestion(WS, id);
    expect(outcome.status).toBe("completed");

    const doc = await h.documents.getById(WS, DOC);
    expect(doc?.currentVersionId).toBe("newer-version");
    // The ingestion still closes: its version exists, it is simply not current.
    expect((await h.ingestions.getById(WS, id))?.status).toBe("complete");
  });

  it("skips a failed ingestion until it is explicitly retried", async () => {
    const id = await seedUpload(h);
    await h.ingestions.update(WS, id, { status: "failed", failureReason: "nope" });

    const outcome = await h.service.processIngestion(WS, id);
    expect(outcome.status).toBe("skipped");
    expect(await h.versions.countForDocument(WS, DOC)).toBe(0);
  });

  it("retries only a failed ingestion, never a completed one", async () => {
    const id = await seedUpload(h);
    await h.service.processIngestion(WS, id);
    expect(await h.service.markRetryable(WS, id)).toBe(false);

    await h.ingestions.update(WS, id, { status: "failed" });
    expect(await h.service.markRetryable(WS, id)).toBe(true);
    expect((await h.ingestions.getById(WS, id))?.status).toBe("pending");
  });

  it("fails safely when the document record is gone", async () => {
    const id = await seedUpload(h);
    h.documents.rows.delete(DOC);

    const outcome = await h.service.processIngestion(WS, id);
    expect(outcome).toMatchObject({ status: "failed", reason: "missing-document" });
    expect((await h.ingestions.getById(WS, id))?.status).toBe("failed");
  });

  it("fails safely when the stored file row is missing", async () => {
    const id = await seedUpload(h);
    const ingestion = await h.ingestions.getById(WS, id);
    await h.files.delete(ingestion!.storedFileId);

    const outcome = await h.service.processIngestion(WS, id);
    expect(outcome).toMatchObject({ status: "failed", reason: "missing-stored-file" });
  });

  it("rejects a stored file owned by another organization", async () => {
    const id = await seedUpload(h, { ownerId: ORG_OTHER });
    const outcome = await h.service.processIngestion(WS, id);
    expect(outcome).toMatchObject({ status: "failed", reason: "foreign-stored-file" });
    expect(await h.versions.countForDocument(WS, DOC)).toBe(0);
  });

  it("rejects a stored file that is not org-owned even when the id matches", async () => {
    // An allow-list check is what makes this fail; a "not a foreign org" check
    // would accept it, letting a document name bytes uploaded outside the org.
    const id = await seedUpload(h, { ownerType: "user", ownerId: ORG });
    const outcome = await h.service.processIngestion(WS, id);
    expect(outcome).toMatchObject({ status: "failed", reason: "foreign-stored-file" });
  });

  it("fails safely when the object is no longer in storage", async () => {
    const id = await seedUpload(h);
    h.storage.objects.clear();

    const outcome = await h.service.processIngestion(WS, id);
    expect(outcome).toMatchObject({ status: "failed", reason: "missing-object" });
  });

  it("fails on a checksum mismatch between the row and the ingestion", async () => {
    const id = await seedUpload(h);
    const ingestion = await h.ingestions.getById(WS, id);
    const file = await h.files.get(ingestion!.storedFileId);
    // Rewrite the row so its hash no longer matches what was uploaded.
    await h.files.delete(file!.id);
    const drifted = await h.files.create({
      ownerType: "org",
      ownerId: ORG,
      key: file!.key,
      sha256: "b".repeat(64),
      size: file!.size,
      mimeType: "application/pdf",
      originalName: "Doc.pdf",
    });
    await h.ingestions.update(WS, id, {});
    const rows = h.ingestions as unknown as { rows: Map<string, { storedFileId: string }> };
    rows.rows.get(id)!.storedFileId = drifted.id;

    const outcome = await h.service.processIngestion(WS, id);
    expect(outcome).toMatchObject({ status: "failed", reason: "checksum-mismatch" });
  });

  it("fails on a byte-size mismatch", async () => {
    const id = await seedUpload(h);
    const rows = h.ingestions as unknown as { rows: Map<string, { byteSize: number }> };
    rows.rows.get(id)!.byteSize = 999_999;

    const outcome = await h.service.processIngestion(WS, id);
    expect(outcome).toMatchObject({ status: "failed", reason: "size-mismatch" });
  });

  it("rejects bytes that do not carry a PDF signature", async () => {
    const id = await seedUpload(h, { bytes: Buffer.from("not a pdf at all", "utf8") });
    const outcome = await h.service.processIngestion(WS, id);
    expect(outcome).toMatchObject({ status: "failed", reason: "not-a-pdf" });
    expect(await h.versions.countForDocument(WS, DOC)).toBe(0);
  });

  it("reads only the signature and releases the stream", async () => {
    const big = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64 * 1024, 0x41)]);
    const id = await seedUpload(h, { bytes: big });
    await h.service.processIngestion(WS, id);

    // Five bytes of signature, read two at a time: the whole object is never
    // transferred, and the stream is cancelled rather than left open.
    expect(h.storage.bytesRead).toBeLessThan(64);
    expect(h.storage.cancelled).toBeGreaterThan(0);
  });

  it("returns a version whose mutation cannot reach persisted state", async () => {
    const id = await seedUpload(h);
    const outcome = await h.service.processIngestion(WS, id);
    if (outcome.status !== "completed") throw new Error("expected completion");

    outcome.version.manifest.sourceKey = "tampered";
    const reread = await h.versions.getById(WS, outcome.version.id);
    expect(reread?.manifest.sourceKey).not.toBe("tampered");
  });

  it("reports a missing ingestion as skipped rather than throwing", async () => {
    const outcome: IngestionOutcome = await h.service.processIngestion(WS, "nope");
    expect(outcome.status).toBe("skipped");
  });

  describe("reconcileUnfinished", () => {
    it("promotes an upload whose job was never enqueued", async () => {
      const id = await seedUpload(h);
      const summary = await h.service.reconcileUnfinished();

      expect(summary).toMatchObject({ examined: 1, promoted: 1, failed: 0 });
      expect((await h.ingestions.getById(WS, id))?.status).toBe("complete");
      expect((await h.documents.getById(WS, DOC))?.currentVersionId).not.toBeNull();
    });

    it("is idempotent across repeated sweeps", async () => {
      await seedUpload(h);
      await h.service.reconcileUnfinished();
      const second = await h.service.reconcileUnfinished();

      expect(second.examined).toBe(0);
      expect(await h.versions.countForDocument(WS, DOC)).toBe(1);
    });

    it("does not examine terminal ingestions", async () => {
      const id = await seedUpload(h);
      await h.ingestions.update(WS, id, { status: "failed" });

      const summary = await h.service.reconcileUnfinished();
      expect(summary.examined).toBe(0);
    });

    it("bounds how many rows one sweep examines", async () => {
      // Three unfinished rows across distinct documents, limit of two.
      for (let i = 0; i < 3; i += 1) {
        h.documents.add({ id: `doc-${i}`, name: `Doc ${i}` });
        const file = await h.files.create({
          ownerType: "org",
          ownerId: ORG,
          key: `ca/xx/yy/${i}`,
          sha256: String(i).repeat(64).slice(0, 64),
          size: 10,
          mimeType: "application/pdf",
          originalName: "d.pdf",
        });
        await h.ingestions.create({
          workspaceId: WS,
          organizationId: ORG,
          documentId: `doc-${i}`,
          storedFileId: file.id,
          status: "pending",
          checksum: String(i).repeat(64).slice(0, 64),
          byteSize: 10,
          mimeType: "application/pdf",
          originalName: "d.pdf",
          uploadedById: USER,
        });
      }

      const summary = await h.service.reconcileUnfinished(2);
      expect(summary.examined).toBe(2);
    });

    it("continues the batch when one row cannot be promoted", async () => {
      await seedUpload(h);
      h.documents.add({ id: "doc-broken" });
      const file = await h.files.create({
        ownerType: "org",
        ownerId: ORG,
        key: "ca/zz/zz/missing",
        sha256: "c".repeat(64),
        size: 5,
        mimeType: "application/pdf",
        originalName: "b.pdf",
      });
      await h.ingestions.create({
        workspaceId: WS,
        organizationId: ORG,
        documentId: "doc-broken",
        storedFileId: file.id,
        status: "pending",
        checksum: "c".repeat(64),
        byteSize: 5,
        mimeType: "application/pdf",
        originalName: "b.pdf",
        uploadedById: USER,
      });

      const summary = await h.service.reconcileUnfinished();
      expect(summary.examined).toBe(2);
      expect(summary.promoted).toBe(1);
      expect(summary.failed).toBe(1);
    });
  });
});
