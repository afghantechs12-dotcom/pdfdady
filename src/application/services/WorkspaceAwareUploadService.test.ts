import { beforeEach, describe, expect, it } from "vitest";
import { WorkspaceAwareUploadService } from "./WorkspaceAwareUploadService";
import type { ActorContext, WorkspaceService } from "./WorkspaceService";
import type { ILogger, LogFields } from "@/src/application/ports/Logger";
import type {
  IObjectStorage,
  ObjectMetadata,
  PutOptions,
  StreamPutOptions,
  StreamPutResult,
} from "@/src/application/ports/storage/ObjectStorage";
import type { DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";
import type { FolderRepository } from "@/src/application/ports/workspaces/FolderRepository";
import type { ProjectRepository } from "@/src/application/ports/workspaces/ProjectRepository";
import type { DocumentRecord, DocumentRecordLifecycleState } from "@/src/domain/entities/DocumentRecord";
import type { Folder, FolderLifecycleState } from "@/src/domain/entities/Folder";
import type { Project } from "@/src/domain/entities/Project";
import { InMemoryStoredFileRepository } from "@/src/infrastructure/persistence/InMemoryStoredFileRepository";
import { InMemoryDocumentIngestionRepository } from "@/src/infrastructure/persistence/InMemoryDocumentIngestionRepository";
import { DOCUMENT_INGESTION_LIMITS as L } from "@/src/domain/entities/DocumentIngestion";
import { DomainError, NotFoundError } from "@/src/domain/errors";

/** Complete ILogger double. */
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
const WS_A = "ws-alpha";
const WS_B = "ws-beta";

/** A minimal but genuinely valid PDF byte sequence (correct %PDF- signature). */
function pdfBytes(body = "one"): Buffer {
  return Buffer.concat([Buffer.from("%PDF-1.7\n", "ascii"), Buffer.from(body, "utf8")]);
}

function actor(userId: string, organizationId = ORG): ActorContext {
  return {
    userId,
    organizationId,
    organizationRole: "member",
    organizationDefaultWorkspaceId: null,
  };
}

/** In-memory object storage that records every call, so rollback is observable. */
class FakeObjectStorage implements IObjectStorage {
  readonly objects = new Map<string, Buffer>();
  readonly deleted: string[] = [];
  readonly puts: string[] = [];

  async put(key: string, data: Buffer | Uint8Array, _options: PutOptions): Promise<void> {
    this.puts.push(key);
    this.objects.set(key, Buffer.from(data));
  }
  async get(key: string): Promise<Buffer> {
    const found = this.objects.get(key);
    if (!found) throw new Error(`missing object ${key}`);
    return found;
  }
  async getStream(): Promise<ReadableStream<Uint8Array>> {
    throw new Error("not used in these tests");
  }
  async putStream(
    key: string,
    _stream: ReadableStream<Uint8Array>,
    _options: StreamPutOptions,
  ): Promise<StreamPutResult> {
    this.objects.set(key, Buffer.alloc(0));
    return { sha256: "stream-sha", size: 0 };
  }
  async head(key: string): Promise<ObjectMetadata> {
    const found = this.objects.get(key);
    return {
      key,
      size: found?.byteLength ?? 0,
      contentType: null,
      exists: found !== undefined,
    };
  }
  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

/** Authorization double mirroring WorkspaceService.get. */
class FakeWorkspaceService {
  private readonly grants = new Map<string, Map<string, "admin" | "editor" | "viewer">>();
  private readonly orgOf = new Map<string, string>();

  addWorkspace(workspaceId: string, organizationId = ORG): void {
    this.orgOf.set(workspaceId, organizationId);
    if (!this.grants.has(workspaceId)) this.grants.set(workspaceId, new Map());
  }
  grant(workspaceId: string, userId: string, role: "admin" | "editor" | "viewer" = "editor"): void {
    this.addWorkspace(workspaceId, this.orgOf.get(workspaceId) ?? ORG);
    this.grants.get(workspaceId)!.set(userId, role);
  }
  async get(a: ActorContext, workspaceId: string, write = false) {
    const organizationId = this.orgOf.get(workspaceId);
    if (!organizationId) throw new NotFoundError("Workspace not found.");
    if (organizationId !== a.organizationId) throw new DomainError("Forbidden.");
    const role = this.grants.get(workspaceId)?.get(a.userId);
    if (!role) throw new DomainError("You are not a member of this workspace.");
    if (write && role === "viewer") throw new DomainError("Write access required.");
    return { workspace: { id: workspaceId, organizationId }, role } as Awaited<
      ReturnType<WorkspaceService["get"]>
    >;
  }
}

/** Workspace-scoped DocumentRecord double covering only what the service uses. */
class FakeDocumentRecordRepository implements Pick<
  DocumentRecordRepository,
  "getById" | "create" | "setLifecycle" | "maxOrderKey"
> {
  readonly docs = new Map<string, DocumentRecord>();
  /** When set, create() throws — used to drive the rollback path. */
  failCreate: Error | null = null;
  private seq = 0;

  async maxOrderKey(workspaceId: string, folderId: string | null): Promise<string | null> {
    const keys = [...this.docs.values()]
      .filter((d) => d.workspaceId === workspaceId && d.folderId === folderId)
      .map((d) => d.orderKey)
      .sort();
    return keys.length ? keys[keys.length - 1]! : null;
  }

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
    if (this.failCreate) throw this.failCreate;
    this.seq += 1;
    const now = new Date();
    const record: DocumentRecord = {
      id: `doc-${this.seq}`,
      workspaceId: input.workspaceId,
      organizationId: input.organizationId,
      projectId: input.projectId ?? null,
      folderId: input.folderId ?? null,
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
    };
    this.docs.set(record.id, record);
    return { ...record };
  }

  async getById(workspaceId: string, documentId: string): Promise<DocumentRecord | null> {
    const d = this.docs.get(documentId);
    if (!d || d.workspaceId !== workspaceId) return null;
    return { ...d };
  }

  async setLifecycle(
    workspaceId: string,
    documentId: string,
    state: DocumentRecordLifecycleState,
    actorId: string,
  ): Promise<DocumentRecord> {
    const d = this.docs.get(documentId);
    if (!d || d.workspaceId !== workspaceId) throw new NotFoundError("Document not found.");
    const updated = {
      ...d,
      lifecycleState: state,
      trashedById: state === "trashed" ? actorId : d.trashedById,
      trashedAt: state === "trashed" ? new Date() : d.trashedAt,
    };
    this.docs.set(documentId, updated);
    return { ...updated };
  }
}

/** Workspace-scoped Folder double. */
class FakeFolderRepository implements Pick<FolderRepository, "getById"> {
  private readonly folders = new Map<string, Folder>();

  add(id: string, workspaceId: string, lifecycleState: FolderLifecycleState = "active"): void {
    const now = new Date();
    this.folders.set(id, {
      id,
      workspaceId,
      organizationId: ORG,
      projectId: null,
      parentId: null,
      name: id,
      normalizedName: id,
      orderKey: "a0",
      lifecycleState,
      createdById: "user-1",
      revision: 1,
      depth: 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      trashedAt: null,
      archivedById: null,
      trashedById: null,
    });
  }

  async getById(workspaceId: string, folderId: string): Promise<Folder | null> {
    const f = this.folders.get(folderId);
    if (!f || f.workspaceId !== workspaceId) return null;
    return { ...f };
  }
}

/** Workspace-scoped Project double. */
class FakeProjectRepository implements Pick<ProjectRepository, "getById"> {
  private readonly projects = new Map<string, Project>();

  add(id: string, workspaceId: string): void {
    const now = new Date();
    this.projects.set(id, {
      id,
      workspaceId,
      organizationId: ORG,
      name: id,
      normalizedName: id,
      slug: id,
      normalizedSlug: id,
      description: null,
      status: "active",
      lifecycleState: "active",
      orderKey: "a0",
      createdById: "user-1",
      revision: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      trashedAt: null,
      archivedById: null,
      trashedById: null,
    });
  }

  async getById(workspaceId: string, projectId: string): Promise<Project | null> {
    const p = this.projects.get(projectId);
    if (!p || p.workspaceId !== workspaceId) return null;
    return { ...p };
  }
}

function harness() {
  const storage = new FakeObjectStorage();
  const meta = new InMemoryStoredFileRepository();
  const logger = new TestLogger();
  const workspaces = new FakeWorkspaceService();
  const documents = new FakeDocumentRecordRepository();
  const folders = new FakeFolderRepository();
  const projects = new FakeProjectRepository();
  const ingestions = new InMemoryDocumentIngestionRepository();

  workspaces.addWorkspace(WS_A, ORG);
  workspaces.addWorkspace(WS_B, ORG);
  workspaces.grant(WS_A, "user-1", "editor");
  workspaces.grant(WS_B, "user-2", "editor");

  const service = new WorkspaceAwareUploadService(
    storage,
    meta,
    logger,
    workspaces as unknown as WorkspaceService,
    documents as unknown as DocumentRecordRepository,
    folders as unknown as FolderRepository,
    projects as unknown as ProjectRepository,
    ingestions,
  );

  return { service, storage, meta, logger, workspaces, documents, folders, projects, ingestions };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    ownerType: "org" as const,
    ownerId: ORG,
    data: pdfBytes(),
    mimeType: "application/pdf",
    originalName: "report.pdf",
    ...overrides,
  };
}

describe("WorkspaceAwareUploadService.uploadToWorkspace", () => {
  beforeEach(() => {
    // Nothing global is mutated between tests — each harness() call builds a
    // fresh set of doubles, and InMemory* adapters keep their own rows.
  });

  it("uploads a valid PDF end to end: bytes, file, document, pending ingestion", async () => {
    const h = harness();
    const data = pdfBytes("unique-body");

    const result = await h.service.uploadToWorkspace(actor("user-1"), WS_A, baseInput({ data }));

    expect(result.deduplicated).toBe(false);
    // Every id comes from real persistence — none are hard-coded.
    expect(result.file.id).toMatch(/^inmem-file-/);
    expect(result.document.id).toMatch(/^doc-/);
    expect(result.ingestion.id).toMatch(/^inmem-ingestion-/);
    expect(result.document.workspaceId).toBe(WS_A);
    expect(result.ingestion.status).toBe("pending");
    expect(result.ingestion.checksum.length).toBe(64);

    // The content-addressed key is derived from the actual sha256.
    const expectedKey = `ca/${result.ingestion.checksum.slice(0, 2)}/${result.ingestion.checksum.slice(2, 4)}/${result.ingestion.checksum}`;
    expect(result.file.key).toBe(expectedKey);
    expect(h.storage.objects.get(result.file.key)?.equals(data)).toBe(true);

    // The document row exists with real fields.
    const doc = await h.documents.getById(WS_A, result.document.id);
    expect(doc).not.toBeNull();
    expect(doc?.name).toBe("report.pdf");
    expect(doc?.orderKey).toBeTruthy();

    // The ingestion row is durable and scoped.
    const ingestion = await h.ingestions.getById(WS_A, result.ingestion.id);
    expect(ingestion?.storedFileId).toBe(result.file.id);
    expect(ingestion?.documentId).toBe(result.document.id);
    expect(ingestion?.originalName).toBe("report.pdf");
  });

  it("applies the custom document name when supplied", async () => {
    const h = harness();
    const result = await h.service.uploadToWorkspace(
      actor("user-1"),
      WS_A,
      baseInput({ name: "Quarterly Report" }),
    );
    expect(result.document.name).toBe("Quarterly Report");
  });

  it("places the document in the supplied folder and project", async () => {
    const h = harness();
    h.folders.add("folder-1", WS_A);
    h.projects.add("project-1", WS_A);

    const result = await h.service.uploadToWorkspace(
      actor("user-1"),
      WS_A,
      baseInput({ folderId: "folder-1", projectId: "project-1" }),
    );
    expect(result.document.folderId).toBe("folder-1");
    expect(result.document.projectId).toBe("project-1");
  });

  it("is idempotent for duplicate uploads — returns the same document, deduplicated", async () => {
    const h = harness();
    const data = pdfBytes("dedup-me");
    const first = await h.service.uploadToWorkspace(actor("user-1"), WS_A, baseInput({ data }));
    const second = await h.service.uploadToWorkspace(actor("user-1"), WS_A, baseInput({ data }));

    expect(second.deduplicated).toBe(true);
    expect(second.document.id).toBe(first.document.id);
    expect(second.ingestion.id).toBe(first.ingestion.id);
    // No extra rows, no extra object.
    expect(h.documents.docs.size).toBe(1);
    expect(h.storage.puts.length).toBe(1);
  });

  it("re-uploads bytes that were trashed, creating a fresh document", async () => {
    const h = harness();
    const data = pdfBytes("trash-me");
    const first = await h.service.uploadToWorkspace(actor("user-1"), WS_A, baseInput({ data }));
    await h.documents.setLifecycle(WS_A, first.document.id, "trashed", "user-1");

    const second = await h.service.uploadToWorkspace(actor("user-1"), WS_A, baseInput({ data }));
    expect(second.deduplicated).toBe(false);
    expect(second.document.id).not.toBe(first.document.id);
  });
});

describe("WorkspaceAwareUploadService destination validation", () => {
  it("rejects a folder from another workspace", async () => {
    const h = harness();
    h.folders.add("folder-foreign", WS_B); // lives in WS_B

    await expect(
      h.service.uploadToWorkspace(actor("user-1"), WS_A, baseInput({ folderId: "folder-foreign" })),
    ).rejects.toThrow(NotFoundError);
  });

  it("rejects a project from another workspace", async () => {
    const h = harness();
    h.projects.add("project-foreign", WS_B);

    await expect(
      h.service.uploadToWorkspace(actor("user-1"), WS_A, baseInput({ projectId: "project-foreign" })),
    ).rejects.toThrow(NotFoundError);
  });

  it("rejects an archived folder even when it belongs to this workspace", async () => {
    const h = harness();
    h.folders.add("folder-archived", WS_A, "archived");

    await expect(
      h.service.uploadToWorkspace(actor("user-1"), WS_A, baseInput({ folderId: "folder-archived" })),
    ).rejects.toThrow(DomainError);
  });

  it("rejects a missing folder", async () => {
    const h = harness();
    await expect(
      h.service.uploadToWorkspace(actor("user-1"), WS_A, baseInput({ folderId: "does-not-exist" })),
    ).rejects.toThrow(NotFoundError);
  });

  it("validateDestination returns false for a foreign folder and true for a good one", async () => {
    const h = harness();
    h.folders.add("folder-good", WS_A);
    h.folders.add("folder-foreign", WS_B);

    await expect(
      h.service.validateDestination(actor("user-1"), WS_A, "folder-foreign", null),
    ).resolves.toBe(false);
    await expect(
      h.service.validateDestination(actor("user-1"), WS_A, "folder-good", null),
    ).resolves.toBe(true);
  });
});

describe("WorkspaceAwareUploadService payload validation", () => {
  it("rejects an empty file", async () => {
    const h = harness();
    // Asserted on the specific reason: an empty buffer would also fail the
    // signature check, so a bare DomainError assertion would not prove the
    // empty-file guard runs at all.
    await expect(
      h.service.uploadToWorkspace(actor("user-1"), WS_A, baseInput({ data: Buffer.alloc(0) })),
    ).rejects.toThrow(/empty file/i);
  });

  it("rejects a file over the size limit", async () => {
    const h = harness();
    const oversized = Buffer.concat([pdfBytes(), Buffer.alloc(L.maxUploadBytes + 1)]);
    await expect(
      h.service.uploadToWorkspace(actor("user-1"), WS_A, baseInput({ data: oversized })),
    ).rejects.toThrow(DomainError);
  });

  it("rejects an unsupported MIME type", async () => {
    const h = harness();
    await expect(
      h.service.uploadToWorkspace(actor("user-1"), WS_A, baseInput({ mimeType: "application/x-msdownload" })),
    ).rejects.toThrow(DomainError);
  });

  it("rejects bytes that do not match the declared MIME signature", async () => {
    const h = harness();
    // Declared as PDF but the bytes are an MZ executable header.
    const notPdf = Buffer.from("MZ\x90\x00executable-payload", "latin1");
    await expect(
      h.service.uploadToWorkspace(actor("user-1"), WS_A, baseInput({ data: notPdf })),
    ).rejects.toThrow(/do not match/i);
  });

  it("rejects a blank or missing original filename", async () => {
    const h = harness();
    await expect(
      h.service.uploadToWorkspace(actor("user-1"), WS_A, baseInput({ originalName: "   " })),
    ).rejects.toThrow(DomainError);
  });

  it("rejects a filename containing a path separator", async () => {
    const h = harness();
    await expect(
      h.service.uploadToWorkspace(actor("user-1"), WS_A, baseInput({ originalName: "a/b.pdf" })),
    ).rejects.toThrow(DomainError);
  });

  it("rejects a filename with control characters", async () => {
    const h = harness();
    await expect(
      h.service.uploadToWorkspace(actor("user-1"), WS_A, baseInput({ originalName: "a\u0000b.pdf" })),
    ).rejects.toThrow(DomainError);
  });

  it("rejects an embedded data: URL as the document name", async () => {
    const h = harness();
    await expect(
      h.service.uploadToWorkspace(actor("user-1"), WS_A, baseInput({ name: "data:text/html,x" })),
    ).rejects.toThrow(DomainError);
  });

  it("rejects a document name over the limit", async () => {
    const h = harness();
    await expect(
      h.service.uploadToWorkspace(actor("user-1"), WS_A, baseInput({ name: "x".repeat(L.maxNameLength + 1) })),
    ).rejects.toThrow(DomainError);
  });
});

describe("WorkspaceAwareUploadService authorization and tenant isolation", () => {
  it("rejects a non-member of the workspace", async () => {
    const h = harness();
    await expect(
      h.service.uploadToWorkspace(actor("user-nobody"), WS_A, baseInput()),
    ).rejects.toThrow(DomainError);
    expect(h.documents.docs.size).toBe(0);
    expect(h.storage.puts.length).toBe(0);
  });

  it("rejects a viewer — upload requires write access", async () => {
    const h = harness();
    h.workspaces.grant(WS_A, "user-viewer", "viewer");
    await expect(
      h.service.uploadToWorkspace(actor("user-viewer"), WS_A, baseInput()),
    ).rejects.toThrow(/write access/i);
  });

  it("rejects an unknown workspace without disclosing whether it exists", async () => {
    const h = harness();
    await expect(
      h.service.uploadToWorkspace(actor("user-1"), "ws-unknown", baseInput()),
    ).rejects.toThrow(NotFoundError);
  });

  it("rejects an actor from another organization", async () => {
    const h = harness();
    await expect(
      h.service.uploadToWorkspace(actor("user-1", ORG_OTHER), WS_A, baseInput()),
    ).rejects.toThrow(DomainError);
  });

  it("rejects a cross-organization workspace even if the authorizer allows it", async () => {
    // The real WorkspaceService already scopes by organization, so the service's
    // own organization check is defense in depth. Drive it directly with an
    // authorizer that hands back a workspace belonging to another organization.
    const h = harness();
    const leaky = {
      get: async () => ({
        workspace: { id: WS_A, organizationId: ORG_OTHER },
        role: "editor",
      }) as unknown as Awaited<ReturnType<WorkspaceService["get"]>>,
    };
    const service = new WorkspaceAwareUploadService(
      h.storage,
      h.meta,
      h.logger,
      leaky as unknown as WorkspaceService,
      h.documents as unknown as DocumentRecordRepository,
      h.folders as unknown as FolderRepository,
      h.projects as unknown as ProjectRepository,
      h.ingestions,
    );

    await expect(
      service.uploadToWorkspace(actor("user-1"), WS_A, baseInput()),
    ).rejects.toThrow(/cross-organization/i);
    expect(h.documents.docs.size).toBe(0);
    expect(h.storage.puts.length).toBe(0);
  });

  it("does not disclose that another workspace already holds the same bytes", async () => {
    const h = harness();
    const data = pdfBytes("shared-across-tenants");

    // WS_B (a different tenant's workspace) uploads the bytes first.
    const inB = await h.service.uploadToWorkspace(actor("user-2"), WS_B, baseInput({ data }));
    expect(inB.deduplicated).toBe(false);

    // WS_A uploads the identical bytes. It must look like a brand new upload.
    const inA = await h.service.uploadToWorkspace(actor("user-1"), WS_A, baseInput({ data }));
    expect(inA.deduplicated).toBe(false);
    expect(inA.document.id).not.toBe(inB.document.id);
    expect(inA.ingestion.id).not.toBe(inB.ingestion.id);
    expect(inA.file.id).not.toBe(inB.file.id);
    expect(inA.document.workspaceId).toBe(WS_A);

    // Each workspace sees only its own ingestion row.
    expect(await h.ingestions.getById(WS_A, inB.ingestion.id)).toBeNull();
    expect(await h.ingestions.getById(WS_B, inA.ingestion.id)).toBeNull();

    // The bytes themselves are stored once — dedup at the object layer is fine,
    // because it is invisible to both tenants.
    expect(h.storage.puts.length).toBe(1);
    expect(inA.file.key).toBe(inB.file.key);
  });
});

describe("WorkspaceAwareUploadService partial-failure rollback", () => {
  it("removes the stored file and the object when document creation fails", async () => {
    const h = harness();
    h.documents.failCreate = new Error("database unavailable");

    await expect(
      h.service.uploadToWorkspace(actor("user-1"), WS_A, baseInput()),
    ).rejects.toThrow("database unavailable");

    // The object this call wrote was removed again.
    expect(h.storage.puts.length).toBe(1);
    expect(h.storage.deleted).toEqual(h.storage.puts);
    expect(h.storage.objects.size).toBe(0);

    // No orphaned metadata row survived.
    expect(await h.meta.listByOwner("org", ORG)).toEqual([]);
    expect(h.documents.docs.size).toBe(0);
  });

  it("leaves a pre-existing shared object in place when rolling back", async () => {
    const h = harness();
    const data = pdfBytes("shared-object");

    // WS_B stores these bytes successfully first.
    const ok = await h.service.uploadToWorkspace(actor("user-2"), WS_B, baseInput({ data }));
    h.storage.deleted.length = 0;

    // WS_A's attempt at the same bytes fails after the object already exists.
    h.documents.failCreate = new Error("database unavailable");
    await expect(
      h.service.uploadToWorkspace(actor("user-1"), WS_A, baseInput({ data })),
    ).rejects.toThrow("database unavailable");

    // The rollback must not delete bytes that WS_B still depends on.
    expect(h.storage.deleted).toEqual([]);
    expect(h.storage.objects.has(ok.file.key)).toBe(true);
  });

  it("does not leave a failed upload behind as a resumable ingestion", async () => {
    const h = harness();
    h.documents.failCreate = new Error("database unavailable");
    await expect(
      h.service.uploadToWorkspace(actor("user-1"), WS_A, baseInput()),
    ).rejects.toThrow();

    // A retry after the fault clears must behave like a first upload.
    h.documents.failCreate = null;
    const retry = await h.service.uploadToWorkspace(actor("user-1"), WS_A, baseInput());
    expect(retry.deduplicated).toBe(false);
    expect(retry.ingestion.status).toBe("pending");
  });
});

describe("WorkspaceAwareUploadService low-level upload", () => {
  it("stores bytes under a content-addressed key and records metadata", async () => {
    const h = harness();
    const data = pdfBytes("low-level");
    const result = await h.service.upload({
      ownerType: "user",
      ownerId: "user-1",
      data,
      mimeType: "application/pdf",
      originalName: "low.pdf",
    });

    expect(result.deduplicated).toBe(false);
    expect(result.file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.file.key).toBe(
      `ca/${result.file.sha256!.slice(0, 2)}/${result.file.sha256!.slice(2, 4)}/${result.file.sha256}`,
    );
    expect(result.file.size).toBe(data.byteLength);
    expect(h.storage.objects.get(result.file.key)?.equals(data)).toBe(true);
  });

  it("deduplicates a repeat upload by the same owner without re-storing bytes", async () => {
    const h = harness();
    const data = pdfBytes("repeat");
    const first = await h.service.upload({
      ownerType: "user",
      ownerId: "user-1",
      data,
      mimeType: "application/pdf",
      originalName: "a.pdf",
    });
    const second = await h.service.upload({
      ownerType: "user",
      ownerId: "user-1",
      data,
      mimeType: "application/pdf",
      originalName: "a.pdf",
    });

    expect(second.deduplicated).toBe(true);
    expect(second.file.id).toBe(first.file.id);
    expect(h.storage.puts.length).toBe(1);
  });

  it("gives a different owner its own metadata row for identical bytes", async () => {
    const h = harness();
    const data = pdfBytes("cross-owner");
    const a = await h.service.upload({
      ownerType: "user",
      ownerId: "user-1",
      data,
      mimeType: "application/pdf",
      originalName: "a.pdf",
    });
    const b = await h.service.upload({
      ownerType: "user",
      ownerId: "user-2",
      data,
      mimeType: "application/pdf",
      originalName: "a.pdf",
    });

    expect(b.deduplicated).toBe(false);
    expect(b.file.id).not.toBe(a.file.id);
    // Bytes stored once; the second call saw the object already present.
    expect(h.storage.puts.length).toBe(1);
  });
});
