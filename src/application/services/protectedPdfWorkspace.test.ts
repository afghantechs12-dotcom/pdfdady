/**
 * C6 — the protected-PDF decision, proved by behaviour rather than asserted.
 *
 * `protect-pdf` was excluded from Workspace because the EDITOR cannot open an
 * encrypted PDF (`workspaceSupported: output.editorOpenable`). That is the
 * editor's answer wearing the Workspace's name, and the closeout brief refuses
 * it: "Do not exclude `protect-pdf` from Workspace merely because the editor
 * cannot open an encrypted PDF. Prove the actual Workspace behavior."
 *
 * So this file runs the real path with real bytes: `WorkspaceAwareUploadService`
 * (the only Workspace byte-write in the product) into a real `LocalFileStorage`,
 * then `DocumentIngestionService.processIngestion` (the only thing that turns an upload
 * into a document), and then reads the object back. Nothing is mocked except the
 * authorization boundary and the two Prisma repositories that have in-memory
 * twins already.
 *
 * The verdict it establishes: **Workspace-saveable: true, Editor-openable:
 * false** — one logical document, one `import` version, bytes back byte-for-byte,
 * and a parser that still refuses the file. Both halves matter: if the store had
 * corrupted or rejected the bytes, `workspaceSaveableOutput` would have to be
 * false and this file would say so.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { afterAll, describe, expect, it } from "vitest";
import { WorkspaceAwareUploadService } from "./WorkspaceAwareUploadService";
import { DocumentIngestionService } from "./DocumentIngestionService";
import type { ActorContext, WorkspaceService } from "./WorkspaceService";
import type { ILogger, LogFields } from "@/src/application/ports/Logger";
import type { DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";
import type { FolderRepository } from "@/src/application/ports/workspaces/FolderRepository";
import type { ProjectRepository } from "@/src/application/ports/workspaces/ProjectRepository";
import type { DocumentRecord, DocumentRecordLifecycleState } from "@/src/domain/entities/DocumentRecord";
import { InMemoryStoredFileRepository } from "@/src/infrastructure/persistence/InMemoryStoredFileRepository";
import { InMemoryDocumentIngestionRepository } from "@/src/infrastructure/persistence/InMemoryDocumentIngestionRepository";
import { InMemoryDocumentVersionRepository } from "@/src/infrastructure/persistence/InMemoryDocumentVersionRepository";
import { LocalFileStorage } from "@/src/infrastructure/storage/LocalFileStorage";
import { capabilityForSlug } from "@/lib/tools/capability";
import { DomainError, NotFoundError } from "@/src/domain/errors";

const ORG = "org-alpha";
const WS = "ws-alpha";
const USER = "user-1";

class SilentLogger implements ILogger {
  readonly entries: Array<{ level: string; message: string; fields?: LogFields }> = [];
  debug(m: string, f?: LogFields) { this.entries.push({ level: "debug", message: m, fields: f }); }
  info(m: string, f?: LogFields) { this.entries.push({ level: "info", message: m, fields: f }); }
  warn(m: string, f?: LogFields) { this.entries.push({ level: "warn", message: m, fields: f }); }
  error(m: string, f?: LogFields) { this.entries.push({ level: "error", message: m, fields: f }); }
  child(): ILogger { return this; }
}

/**
 * A PDF that really is a PDF and really requires a password.
 *
 * `qpdf` is what `protect-pdf` runs and it is not installed here, so the
 * encryption marker is written into a genuine pdf-lib document instead: a valid
 * one-page file whose trailer carries `/Encrypt`. That marker is the whole reason
 * the editor cannot open the tool's output — asserted below — and it leaves the
 * `%PDF-` signature, the byte stream and the checksum exactly as real output
 * would.
 *
 * ponytail: trailer marker instead of a real 256-bit RC4/AES dictionary; swap in
 * a qpdf-produced fixture if the binaries ever land in CI.
 */
async function encryptedPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const plain = Buffer.from(await doc.save({ useObjectStreams: false })).toString("latin1");
  const patched = plain.replace(/trailer\n<<\n/, "trailer\n<<\n/Encrypt 1 0 R\n");
  expect(patched, "the trailer marker was not applied").not.toBe(plain);
  return Buffer.from(patched, "latin1");
}

class FakeWorkspaces {
  async get(actor: ActorContext, workspaceId: string, write = false) {
    if (workspaceId !== WS) throw new NotFoundError("Workspace not found.");
    if (actor.organizationId !== ORG) throw new DomainError("Forbidden.");
    if (write && actor.userId !== USER) throw new DomainError("Write access required.");
    return { workspace: { id: WS, organizationId: ORG }, role: "editor" } as Awaited<
      ReturnType<WorkspaceService["get"]>
    >;
  }
}

/** The one repository both services write to. Honours the conditional pointer. */
class Documents implements Partial<DocumentRecordRepository> {
  readonly rows = new Map<string, DocumentRecord>();
  private seq = 0;

  async maxOrderKey(): Promise<string | null> { return null; }

  async create(input: {
    workspaceId: string;
    organizationId: string;
    projectId?: string | null;
    folderId?: string | null;
    name: string;
    normalizedName: string;
    orderKey: string;
    createdById: string;
  }): Promise<DocumentRecord> {
    this.seq += 1;
    const now = new Date();
    const row = {
      id: `doc-${this.seq}`,
      workspaceId: input.workspaceId,
      organizationId: input.organizationId,
      projectId: null,
      folderId: null,
      name: input.name,
      normalizedName: input.normalizedName,
      lifecycleState: "active",
      orderKey: input.orderKey,
      currentVersionId: null,
      favorite: false,
      lastAccessedAt: null,
      createdById: input.createdById,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      trashedAt: null,
      archivedById: null,
      trashedById: null,
    } as DocumentRecord;
    this.rows.set(row.id, row);
    return { ...row };
  }

  async getById(workspaceId: string, documentId: string): Promise<DocumentRecord | null> {
    const row = this.rows.get(documentId);
    if (!row || row.workspaceId !== workspaceId) return null;
    return { ...row };
  }

  async setLifecycle(
    workspaceId: string,
    documentId: string,
    state: DocumentRecordLifecycleState,
  ): Promise<DocumentRecord> {
    const row = this.rows.get(documentId);
    if (!row) throw new NotFoundError("Document not found.");
    const next = { ...row, lifecycleState: state };
    this.rows.set(documentId, next);
    return { ...next };
  }

  async setCurrentVersionIfUnset(
    workspaceId: string,
    documentId: string,
    versionId: string,
  ): Promise<boolean> {
    const row = this.rows.get(documentId);
    if (!row || row.workspaceId !== workspaceId || row.currentVersionId !== null) return false;
    this.rows.set(documentId, { ...row, currentVersionId: versionId, revision: row.revision + 1 });
    return true;
  }
}

const roots: string[] = [];

async function harness() {
  // mkdtemp, not a shared constant path: two suites sharing one storage root is a
  // cross-test collision this repo has already been bitten by.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdfdadi-protect-"));
  roots.push(root);
  const storage = new LocalFileStorage(root);
  const files = new InMemoryStoredFileRepository();
  const ingestions = new InMemoryDocumentIngestionRepository();
  const versions = new InMemoryDocumentVersionRepository();
  const documents = new Documents();
  const logger = new SilentLogger();

  const uploads = new WorkspaceAwareUploadService(
    storage,
    files,
    logger,
    new FakeWorkspaces() as unknown as WorkspaceService,
    documents as unknown as DocumentRecordRepository,
    { async getById() { return null; } } as unknown as FolderRepository,
    { async getById() { return null; } } as unknown as ProjectRepository,
    ingestions,
  );
  const ingestionService = new DocumentIngestionService(
    logger,
    ingestions,
    documents as unknown as DocumentRecordRepository,
    versions,
    files,
    storage,
    { now: () => new Date("2026-09-02T00:00:00.000Z") },
  );
  return { root, storage, files, ingestions, versions, documents, uploads, ingestionService, logger };
}

afterAll(async () => {
  await Promise.all(roots.map((r) => fs.rm(r, { recursive: true, force: true })));
});

const ACTOR: ActorContext = {
  userId: USER,
  organizationId: ORG,
  organizationRole: "member",
  organizationDefaultWorkspaceId: null,
};

describe("C6 — an encrypted PDF in a Workspace", () => {
  it("no parser here can open it, which is why the editor flag is false", async () => {
    const bytes = await encryptedPdf();
    await expect(PDFDocument.load(bytes)).rejects.toThrow(/encrypted/i);
    // …and the same bytes ARE a PDF, so the refusal is about the password.
    expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    await expect(
      PDFDocument.load(bytes, { ignoreEncryption: true }),
    ).resolves.toBeInstanceOf(PDFDocument);
  });

  it("stores, ingests and hands back the exact bytes as ONE document with ONE import version", async () => {
    const h = await harness();
    const bytes = await encryptedPdf();
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");

    const saved = await h.uploads.uploadToWorkspace(ACTOR, WS, {
      ownerType: "org",
      ownerId: ORG,
      data: bytes,
      mimeType: "application/pdf",
      originalName: "quarterly-report-protected.pdf",
      name: "quarterly-report-protected.pdf",
    });

    // Accepted: the signature check is what the upload path enforces, and an
    // encrypted PDF still carries `%PDF-`.
    expect(saved.deduplicated).toBe(false);
    expect(saved.ingestion.checksum).toBe(sha);
    expect(saved.file.key).toBe(`ca/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`);
    expect(saved.ingestion.status).toBe("pending");

    // Ingestion promotes it. `processIngestion` verifies ownership, size,
    // checksum and the header — and never parses the document, which is the fact
    // the whole decision rests on.
    const outcome = await h.ingestionService.processIngestion(WS, saved.ingestion.id);
    expect(outcome.status, JSON.stringify(outcome)).toBe("completed");

    // One logical document, with an initial `import` version pointed at.
    expect([...h.documents.rows.values()]).toHaveLength(1);
    const doc = (await h.documents.getById(WS, saved.document.id))!;
    const versions = await h.versions.list({ workspaceId: WS, documentId: doc.id, limit: 10 });
    expect(await h.versions.countForDocument(WS, doc.id)).toBe(1);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.origin).toBe("import");
    expect(versions[0]!.versionNumber).toBe(1);
    expect(doc.currentVersionId).toBe(versions[0]!.id);

    // Downloadable, uncorrupted: byte-for-byte what the tool produced.
    const readBack = await h.storage.get(saved.file.key);
    expect(crypto.createHash("sha256").update(readBack).digest("hex")).toBe(sha);
    expect(readBack.equals(bytes)).toBe(true);
    // And still encrypted after the round trip — the store did not rewrite it.
    await expect(PDFDocument.load(readBack)).rejects.toThrow(/encrypted/i);
  });

  it("so the capability record says saveable-but-not-openable, and means it", () => {
    const cap = capabilityForSlug("protect-pdf")!;
    expect(cap.outputKind).toBe("pdf");
    expect(cap.workspaceSaveableOutput).toBe(true);
    expect(cap.editorOpenableOutput).toBe(false);
  });
});
