import { describe, expect, it } from "vitest";
import { VersionService } from "./VersionService";
import type { ActorContext, WorkspaceService } from "./WorkspaceService";
import type { ILogger, LogFields } from "@/src/application/ports/Logger";
import type { DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";
import type {
  CreateDocumentVersionInput,
  DocumentVersionListQuery,
  DocumentVersionRepository,
} from "@/src/application/ports/workspaces/DocumentVersionRepository";
import type { IObjectStorage } from "@/src/application/ports/storage/ObjectStorage";
import type { DocumentRecord, DocumentRecordLifecycleState } from "@/src/domain/entities/DocumentRecord";
import {
  DOCUMENT_VERSION_LIMITS as L,
  type DocumentVersion,
} from "@/src/domain/entities/DocumentVersion";
import { InMemoryDocumentVersionRepository } from "@/src/infrastructure/persistence/InMemoryDocumentVersionRepository";
import { DomainError, NotFoundError } from "@/src/domain/errors";

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

class FakeObjectStorage implements IObjectStorage {
  readonly objects = new Map<string, Buffer>();
  readonly deletes: string[] = [];

  async put(key: string, data: Buffer | Uint8Array): Promise<void> {
    this.objects.set(key, Buffer.from(data));
  }
  async get(key: string): Promise<Buffer> {
    const data = this.objects.get(key);
    if (!data) throw new Error(`object ${key} does not exist`);
    return Buffer.from(data);
  }
  async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const data = await this.get(key);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(data));
        controller.close();
      },
    });
  }
  async putStream(
    key: string,
    stream: ReadableStream<Uint8Array>,
    options: { contentType: string; sha256?: string },
  ): Promise<{ sha256: string; size: number }> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const data = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    await this.put(key, data);
    return { sha256: options.sha256 ?? "", size: data.byteLength };
  }
  async head(key: string): Promise<{ key: string; size: number; contentType: string | null; exists: boolean }> {
    const data = this.objects.get(key);
    return { key, size: data?.byteLength ?? 0, contentType: null, exists: data !== undefined };
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
    this.deletes.push(key);
  }
}

const ORG = "org-alpha";
const ORG_OTHER = "org-beta";
const WS_A = "ws-alpha";
const WS_B = "ws-beta";
const DOC = "doc-1";

function actor(userId: string, organizationId = ORG): ActorContext {
  return {
    userId,
    organizationId,
    organizationRole: "member",
    organizationDefaultWorkspaceId: null,
  };
}

class FakeWorkspaceService {
  private readonly grants = new Map<string, Map<string, "admin" | "editor" | "viewer">>();
  private readonly orgOf = new Map<string, string>();
  private calls = 0;

  addWorkspace(workspaceId: string, organizationId = ORG): void {
    this.orgOf.set(workspaceId, organizationId);
    if (!this.grants.has(workspaceId)) this.grants.set(workspaceId, new Map());
  }
  grant(workspaceId: string, userId: string, role: "admin" | "editor" | "viewer" = "editor"): void {
    if (!this.grants.has(workspaceId)) this.addWorkspace(workspaceId);
    this.grants.get(workspaceId)!.set(userId, role);
  }
  async get(a: ActorContext, workspaceId: string, write = false) {
    this.calls += 1;
    const organizationId = this.orgOf.get(workspaceId);
    if (!organizationId) throw new NotFoundError("Workspace not found.");
    if (organizationId !== a.organizationId) throw new NotFoundError("Workspace not found.");
    const role = this.grants.get(workspaceId)?.get(a.userId);
    if (!role) throw new DomainError("You are not a member of this workspace.");
    if (write && role === "viewer") throw new DomainError("Write access required.");
    return { workspace: { id: workspaceId, organizationId }, role } as unknown as Awaited<
      ReturnType<WorkspaceService["get"]>
    >;
  }
  get authorizationCalls(): number {
    return this.calls;
  }
}

class FakeDocumentRecordRepository {
  private readonly docs = new Map<string, DocumentRecord>();
  /** When set, `update` throws — simulates the pointer write failing after the version landed. */
  failUpdates = false;

  add(
    id: string,
    workspaceId: string,
    lifecycleState: DocumentRecordLifecycleState = "active",
    revision = 1,
  ): void {
    const now = new Date();
    this.docs.set(`${workspaceId}:${id}`, {
      id,
      workspaceId,
      organizationId: ORG,
      projectId: null,
      folderId: null,
      name: `${id}.pdf`,
      normalizedName: `${id}.pdf`,
      lifecycleState,
      orderKey: "a0",
      currentVersionId: null,
      favorite: false,
      lastAccessedAt: null,
      createdById: "user-1",
      revision,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      trashedAt: null,
      archivedById: null,
      trashedById: null,
    });
  }

  setRevision(workspaceId: string, id: string, revision: number): void {
    const key = `${workspaceId}:${id}`;
    const doc = this.docs.get(key);
    if (doc) this.docs.set(key, { ...doc, revision });
  }

  async getById(workspaceId: string, documentId: string): Promise<DocumentRecord | null> {
    const doc = this.docs.get(`${workspaceId}:${documentId}`);
    return doc ? { ...doc } : null;
  }

  /**
   * Mirrors `PrismaDocumentRecordRepository.update`, deliberately: `data.revision`
   * is the EXPECTED CURRENT revision (a WHERE-clause guard) and the store
   * increments the column itself.
   *
   * This fake used to spread `data` over the row, so a `revision` in the patch was
   * taken as the value to store. Under those semantics `commit`'s `revision + 1`
   * looked correct and every test here passed — while the real adapter matched no
   * row and failed every save after the first. The fake was the bug's hiding place.
   */
  async update(
    workspaceId: string,
    documentId: string,
    data: Partial<Pick<DocumentRecord, "currentVersionId" | "revision">>,
  ): Promise<DocumentRecord> {
    if (this.failUpdates) throw new Error("document store unavailable");
    const key = `${workspaceId}:${documentId}`;
    const doc = this.docs.get(key);
    if (!doc) throw new NotFoundError("Document not found.");
    if (data.revision !== undefined && data.revision !== doc.revision) {
      throw new Error("Document update conflict.");
    }
    const next = { ...doc, ...data, revision: doc.revision + 1 };
    this.docs.set(key, next);
    return { ...next };
  }
}

/** Delegates every method, so a test can alter one behaviour without restating the port. */
class DelegatingVersionRepository implements DocumentVersionRepository {
  constructor(protected readonly inner: DocumentVersionRepository) {}
  create(input: CreateDocumentVersionInput): Promise<DocumentVersion> {
    return this.inner.create(input);
  }
  getById(workspaceId: string, versionId: string): Promise<DocumentVersion | null> {
    return this.inner.getById(workspaceId, versionId);
  }
  getByNumber(
    workspaceId: string,
    documentId: string,
    versionNumber: number,
  ): Promise<DocumentVersion | null> {
    return this.inner.getByNumber(workspaceId, documentId, versionNumber);
  }
  list(query: DocumentVersionListQuery): Promise<DocumentVersion[]> {
    return this.inner.list(query);
  }
  latest(workspaceId: string, documentId: string): Promise<DocumentVersion | null> {
    return this.inner.latest(workspaceId, documentId);
  }
  countForDocument(workspaceId: string, documentId: string): Promise<number> {
    return this.inner.countForDocument(workspaceId, documentId);
  }
  isArtifactReferenced(
    workspaceId: string,
    key: string,
    excludingVersionId?: string,
  ): Promise<boolean> {
    return this.inner.isArtifactReferenced(workspaceId, key, excludingVersionId);
  }
  delete(workspaceId: string, versionId: string): Promise<boolean> {
    return this.inner.delete(workspaceId, versionId);
  }
}

/** Reports every artifact as still referenced, so pruning must not delete bytes. */
class AlwaysReferencedRepository extends DelegatingVersionRepository {
  override async isArtifactReferenced(): Promise<boolean> {
    return true;
  }
}

/** A version store that is down. */
class UnavailableVersionRepository extends DelegatingVersionRepository {
  override async create(): Promise<DocumentVersion> {
    throw new Error("version store unavailable");
  }
}

interface HarnessOptions {
  maxVersionsPerDocument?: number;
  wrapVersions?: (inner: DocumentVersionRepository) => DocumentVersionRepository;
}

function harness(options: HarnessOptions = {}) {
  const logger = new TestLogger();
  const workspaces = new FakeWorkspaceService();
  const documents = new FakeDocumentRecordRepository();
  const storage = new FakeObjectStorage();
  const inner = new InMemoryDocumentVersionRepository();
  const versions = options.wrapVersions ? options.wrapVersions(inner) : inner;

  workspaces.addWorkspace(WS_A, ORG);
  workspaces.addWorkspace(WS_B, ORG_OTHER);
  workspaces.grant(WS_A, "user-1", "editor");
  workspaces.grant(WS_A, "user-2", "editor");
  workspaces.grant(WS_A, "viewer-1", "viewer");
  workspaces.grant(WS_B, "user-3", "editor");
  documents.add(DOC, WS_A);

  const service = new VersionService(
    logger,
    workspaces as unknown as WorkspaceService,
    versions,
    documents as unknown as DocumentRecordRepository,
    storage,
    { maxVersionsPerDocument: options.maxVersionsPerDocument },
  );
  return { service, logger, workspaces, documents, storage, versions: inner };
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceKey: "workspaces/ws-alpha/sources/doc-1/v1.pdf",
    sourceChecksum: "a".repeat(64),
    sourceByteSize: 2048,
    pageCount: 3,
    thumbnailKeys: ["workspaces/ws-alpha/thumbs/doc-1/1.png"],
    ...overrides,
  };
}

/** Creates a version, reading the document's current revision so the CAS matches. */
async function save(
  service: VersionService,
  documents: FakeDocumentRecordRepository,
  userId = "user-1",
  overrides: Record<string, unknown> = {},
): Promise<DocumentVersion> {
  const doc = await documents.getById(WS_A, DOC);
  return service.createVersion(actor(userId), WS_A, {
    documentId: DOC,
    expectedRevision: doc!.revision,
    manifest: manifest(overrides),
  });
}

describe("VersionService — durable creation", () => {
  it("creates a durable version with a server-computed checksum", async () => {
    const { service, documents } = harness();
    const version = await save(service, documents);

    expect(version.versionNumber).toBe(1);
    expect(version.origin).toBe("save");
    expect(version.createdById).toBe("user-1");
    // 64 hex characters — a real sha256, not the "mock-checksum" placeholder the
    // fabricated implementation returned.
    expect(version.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(version.checksum).not.toContain("mock");
    expect(version.manifestDegraded).toBe(false);
  });

  it("persists the version so it survives the call that made it", async () => {
    const { service, documents, versions } = harness();
    const created = await save(service, documents);

    const stored = await versions.getById(WS_A, created.id);
    expect(stored).not.toBeNull();
    expect(stored!.versionNumber).toBe(1);
    expect(stored!.manifest.sourceKey).toBe(manifest().sourceKey);
  });

  it("allocates monotonic version numbers across repeated saves", async () => {
    const { service, documents } = harness();
    const first = await save(service, documents);
    const second = await save(service, documents);
    const third = await save(service, documents);

    expect([first.versionNumber, second.versionNumber, third.versionNumber]).toEqual([1, 2, 3]);
  });

  it("advances the document's revision and current-version pointer", async () => {
    const { service, documents } = harness();
    const before = await documents.getById(WS_A, DOC);
    const version = await save(service, documents);
    const after = await documents.getById(WS_A, DOC);

    expect(after!.currentVersionId).toBe(version.id);
    expect(after!.revision).toBe(before!.revision + 1);
  });

  it("records a trimmed label when one is given", async () => {
    const { service, documents } = harness();
    const doc = await documents.getById(WS_A, DOC);
    const version = await service.createVersion(actor("user-1"), WS_A, {
      documentId: DOC,
      expectedRevision: doc!.revision,
      label: "  Before redaction  ",
      manifest: manifest(),
    });

    expect(version.label).toBe("Before redaction");
  });

  it("records an explicit checkpoint origin", async () => {
    const { service, documents } = harness();
    const doc = await documents.getById(WS_A, DOC);
    const version = await service.createVersion(actor("user-1"), WS_A, {
      documentId: DOC,
      expectedRevision: doc!.revision,
      origin: "checkpoint",
      manifest: manifest(),
    });

    expect(version.origin).toBe("checkpoint");
  });

  it("refuses a caller-claimed restore origin", async () => {
    const { service, documents } = harness();
    const doc = await documents.getById(WS_A, DOC);

    // Provenance is not a client-supplied field: a save must not be able to
    // record itself as a restore of something it never restored.
    await expect(
      service.createVersion(actor("user-1"), WS_A, {
        documentId: DOC,
        expectedRevision: doc!.revision,
        origin: "restore",
        manifest: manifest(),
      }),
    ).rejects.toThrow(DomainError);
  });
});

describe("VersionService — compare-and-swap", () => {
  it("rejects a save whose expected revision is stale", async () => {
    const { service, documents } = harness();
    documents.setRevision(WS_A, DOC, 7);

    await expect(
      service.createVersion(actor("user-1"), WS_A, {
        documentId: DOC,
        expectedRevision: 3,
        manifest: manifest(),
      }),
    ).rejects.toThrow(DomainError);
  });

  it("creates no version when the compare-and-swap fails", async () => {
    const { service, documents, versions } = harness();
    documents.setRevision(WS_A, DOC, 7);

    await expect(
      service.createVersion(actor("user-1"), WS_A, {
        documentId: DOC,
        expectedRevision: 3,
        manifest: manifest(),
      }),
    ).rejects.toThrow(DomainError);
    // A rejected save leaves no half-written history behind.
    expect(await versions.countForDocument(WS_A, DOC)).toBe(0);
  });

  it("leaves the document untouched when the compare-and-swap fails", async () => {
    const { service, documents } = harness();
    documents.setRevision(WS_A, DOC, 7);
    const before = await documents.getById(WS_A, DOC);

    await expect(
      service.createVersion(actor("user-1"), WS_A, {
        documentId: DOC,
        expectedRevision: 3,
        manifest: manifest(),
      }),
    ).rejects.toThrow(DomainError);

    const after = await documents.getById(WS_A, DOC);
    expect(after!.revision).toBe(before!.revision);
    expect(after!.currentVersionId).toBe(before!.currentVersionId);
  });

  it("a second save may not reuse the revision the first one consumed", async () => {
    const { service, documents } = harness();
    const first = await save(service, documents);

    // Re-using the pre-save revision is exactly the lost update the CAS prevents.
    await expect(
      service.createVersion(actor("user-1"), WS_A, {
        documentId: DOC,
        expectedRevision: first.revision,
        manifest: manifest(),
      }),
    ).rejects.toThrow(DomainError);
  });

  it("rejects a negative or fractional expected revision", async () => {
    const { service } = harness();

    await expect(
      service.createVersion(actor("user-1"), WS_A, {
        documentId: DOC,
        expectedRevision: -1,
        manifest: manifest(),
      }),
    ).rejects.toThrow(DomainError);
    await expect(
      service.createVersion(actor("user-1"), WS_A, {
        documentId: DOC,
        expectedRevision: 1.5,
        manifest: manifest(),
      }),
    ).rejects.toThrow(DomainError);
  });
});

describe("VersionService — immutability and restore", () => {
  it("restores by creating a new version rather than rewinding", async () => {
    const { service, documents } = harness();
    const first = await save(service, documents, "user-1", {
      sourceKey: "workspaces/ws-alpha/sources/doc-1/v1.pdf",
    });
    await save(service, documents, "user-1", {
      sourceKey: "workspaces/ws-alpha/sources/doc-1/v2.pdf",
    });

    const doc = await documents.getById(WS_A, DOC);
    const restored = await service.restoreVersion(
      actor("user-1"),
      WS_A,
      DOC,
      first.versionNumber,
      doc!.revision,
    );

    expect(restored.versionNumber).toBe(3);
    expect(restored.origin).toBe("restore");
    expect(restored.restoredFromVersionId).toBe(first.id);
    expect(restored.manifest.sourceKey).toBe("workspaces/ws-alpha/sources/doc-1/v1.pdf");
  });

  it("leaves the restored version's own row untouched", async () => {
    const { service, documents, versions } = harness();
    const first = await save(service, documents);
    await save(service, documents);
    const doc = await documents.getById(WS_A, DOC);
    await service.restoreVersion(actor("user-1"), WS_A, DOC, first.versionNumber, doc!.revision);

    const stillThere = await versions.getById(WS_A, first.id);
    expect(stillThere).not.toBeNull();
    expect(stillThere!.versionNumber).toBe(1);
    expect(stillThere!.origin).toBe("save");
    expect(stillThere!.restoredFromVersionId).toBeNull();
  });

  it("keeps every earlier version after a restore", async () => {
    const { service, documents, versions } = harness();
    const first = await save(service, documents);
    await save(service, documents);
    const doc = await documents.getById(WS_A, DOC);
    await service.restoreVersion(actor("user-1"), WS_A, DOC, first.versionNumber, doc!.revision);

    // History grew; nothing was overwritten.
    expect(await versions.countForDocument(WS_A, DOC)).toBe(3);
  });

  it("points the document at the newly created restore version", async () => {
    const { service, documents } = harness();
    const first = await save(service, documents);
    await save(service, documents);
    const doc = await documents.getById(WS_A, DOC);
    const restored = await service.restoreVersion(
      actor("user-1"),
      WS_A,
      DOC,
      first.versionNumber,
      doc!.revision,
    );

    const after = await documents.getById(WS_A, DOC);
    expect(after!.currentVersionId).toBe(restored.id);
    expect(after!.currentVersionId).not.toBe(first.id);
  });

  it("rejects a restore whose expected revision is stale", async () => {
    const { service, documents } = harness();
    const first = await save(service, documents);

    await expect(
      service.restoreVersion(actor("user-1"), WS_A, DOC, first.versionNumber, 99),
    ).rejects.toThrow(DomainError);
  });

  it("fails to restore a version that does not exist", async () => {
    const { service, documents } = harness();
    await save(service, documents);
    const doc = await documents.getById(WS_A, DOC);

    await expect(
      service.restoreVersion(actor("user-1"), WS_A, DOC, 99, doc!.revision),
    ).rejects.toThrow(NotFoundError);
  });

  it("refuses a viewer's restore", async () => {
    const { service, documents } = harness();
    const first = await save(service, documents);
    const doc = await documents.getById(WS_A, DOC);

    await expect(
      service.restoreVersion(actor("viewer-1"), WS_A, DOC, first.versionNumber, doc!.revision),
    ).rejects.toThrow(DomainError);
  });

  it("exposes no way to modify a stored version", () => {
    const { versions } = harness();
    // Immutability is enforced by the port's shape, not by a runtime guard: if an
    // update method ever appears, this fails and the invariant gets revisited.
    expect("update" in versions).toBe(false);
  });

  it("a repository-returned version cannot modify persisted state", async () => {
    const { service, documents, versions } = harness();
    const created = await save(service, documents);

    created.label = "tampered";
    created.manifest.sourceKey = "workspaces/ws-beta/stolen.pdf";
    created.manifest.thumbnailKeys.push("workspaces/ws-beta/stolen.png");
    created.createdAt.setFullYear(1990);

    const stored = await versions.getById(WS_A, created.id);
    expect(stored!.label).toBeNull();
    expect(stored!.manifest.sourceKey).toBe(manifest().sourceKey);
    expect(stored!.manifest.thumbnailKeys).toHaveLength(1);
    expect(stored!.createdAt.getFullYear()).toBeGreaterThan(2000);
  });
});

describe("VersionService — manifest validation", () => {
  it("rejects a manifest with no source artifact", async () => {
    const { service, documents } = harness();
    const doc = await documents.getById(WS_A, DOC);

    await expect(
      service.createVersion(actor("user-1"), WS_A, {
        documentId: DOC,
        expectedRevision: doc!.revision,
        manifest: { pageCount: 2 },
      }),
    ).rejects.toThrow(DomainError);
  });

  it("rejects an artifact key that carries no checksum", async () => {
    const { service, documents } = harness();
    const doc = await documents.getById(WS_A, DOC);

    // A key without its checksum records where bytes live but not what they are.
    await expect(
      service.createVersion(actor("user-1"), WS_A, {
        documentId: DOC,
        expectedRevision: doc!.revision,
        manifest: manifest({ outputKey: "workspaces/ws-alpha/out/doc-1.pdf" }),
      }),
    ).rejects.toThrow(DomainError);
  });

  it("rejects a key containing control characters", async () => {
    const { service, documents } = harness();
    const doc = await documents.getById(WS_A, DOC);

    await expect(
      service.createVersion(actor("user-1"), WS_A, {
        documentId: DOC,
        expectedRevision: doc!.revision,
        manifest: manifest({ sourceKey: `bad${String.fromCharCode(1)}key` }),
      }),
    ).rejects.toThrow(DomainError);
  });

  it("rejects an oversized key", async () => {
    const { service, documents } = harness();
    const doc = await documents.getById(WS_A, DOC);

    await expect(
      service.createVersion(actor("user-1"), WS_A, {
        documentId: DOC,
        expectedRevision: doc!.revision,
        manifest: manifest({ sourceKey: "k".repeat(L.maxKeyLength + 1) }),
      }),
    ).rejects.toThrow(DomainError);
  });

  it("rejects more thumbnails than the bound allows", async () => {
    const { service, documents } = harness();
    const doc = await documents.getById(WS_A, DOC);
    const tooMany = Array.from({ length: L.maxThumbnailKeys + 1 }, (_, i) => `thumbs/${i}.png`);

    await expect(
      service.createVersion(actor("user-1"), WS_A, {
        documentId: DOC,
        expectedRevision: doc!.revision,
        manifest: manifest({ thumbnailKeys: tooMany }),
      }),
    ).rejects.toThrow(DomainError);
  });

  it("rejects an oversized label", async () => {
    const { service, documents } = harness();
    const doc = await documents.getById(WS_A, DOC);

    await expect(
      service.createVersion(actor("user-1"), WS_A, {
        documentId: DOC,
        expectedRevision: doc!.revision,
        label: "x".repeat(L.maxLabelLength + 1),
        manifest: manifest(),
      }),
    ).rejects.toThrow(DomainError);
  });

  it("rejects a label containing control characters", async () => {
    const { service, documents } = harness();
    const doc = await documents.getById(WS_A, DOC);

    await expect(
      service.createVersion(actor("user-1"), WS_A, {
        documentId: DOC,
        expectedRevision: doc!.revision,
        label: `bad${String.fromCharCode(1)}label`,
        manifest: manifest(),
      }),
    ).rejects.toThrow(DomainError);
  });

  it("rejects a negative artifact size", async () => {
    const { service, documents } = harness();
    const doc = await documents.getById(WS_A, DOC);

    await expect(
      service.createVersion(actor("user-1"), WS_A, {
        documentId: DOC,
        expectedRevision: doc!.revision,
        manifest: manifest({ sourceByteSize: -1 }),
      }),
    ).rejects.toThrow(DomainError);
  });

  it("rejects a non-hex checksum", async () => {
    const { service, documents } = harness();
    const doc = await documents.getById(WS_A, DOC);

    await expect(
      service.createVersion(actor("user-1"), WS_A, {
        documentId: DOC,
        expectedRevision: doc!.revision,
        manifest: manifest({ sourceChecksum: "not-a-checksum!" }),
      }),
    ).rejects.toThrow(DomainError);
  });

  it("does not store unknown manifest fields", async () => {
    const { service, documents } = harness();
    const doc = await documents.getById(WS_A, DOC);
    const version = await service.createVersion(actor("user-1"), WS_A, {
      documentId: DOC,
      expectedRevision: doc!.revision,
      manifest: manifest({ injected: "surprise", schema: 999 }),
    });

    // The manifest is rebuilt from known fields, so a caller cannot smuggle extra
    // state into a row that other code will later read back and trust.
    expect((version.manifest as unknown as Record<string, unknown>).injected).toBeUndefined();
    expect(version.manifest.schema).toBe(1);
  });

  it("accepts a manifest carrying every optional artifact", async () => {
    const { service, documents } = harness();
    const doc = await documents.getById(WS_A, DOC);
    const version = await service.createVersion(actor("user-1"), WS_A, {
      documentId: DOC,
      expectedRevision: doc!.revision,
      manifest: manifest({
        editorStateKey: "workspaces/ws-alpha/state/doc-1.json",
        editorStateChecksum: "b".repeat(64),
        outputKey: "workspaces/ws-alpha/out/doc-1.pdf",
        outputChecksum: "c".repeat(64),
      }),
    });

    expect(version.manifest.editorStateKey).toBe("workspaces/ws-alpha/state/doc-1.json");
    expect(version.manifest.outputChecksum).toBe("c".repeat(64));
  });

  it("verifies a version against its recorded checksum", async () => {
    const { service, documents } = harness();
    const created = await save(service, documents);
    const result = await service.verifyVersion(actor("user-1"), WS_A, DOC, created.versionNumber);

    expect(result.intact).toBe(true);
    expect(result.version.id).toBe(created.id);
  });

  it("gives two identical manifests the same checksum", async () => {
    const { service, documents } = harness();
    const first = await save(service, documents);
    const second = await save(service, documents);

    // The checksum is a function of manifest content, not of insertion order.
    expect(second.checksum).toBe(first.checksum);
  });
});

describe("VersionService — authorization and tenancy", () => {
  it("refuses a non-member", async () => {
    const { service, documents } = harness();
    const doc = await documents.getById(WS_A, DOC);

    await expect(
      service.createVersion(actor("outsider"), WS_A, {
        documentId: DOC,
        expectedRevision: doc!.revision,
        manifest: manifest(),
      }),
    ).rejects.toThrow(DomainError);
  });

  it("refuses a viewer's write", async () => {
    const { service, documents } = harness();
    const doc = await documents.getById(WS_A, DOC);

    await expect(
      service.createVersion(actor("viewer-1"), WS_A, {
        documentId: DOC,
        expectedRevision: doc!.revision,
        manifest: manifest(),
      }),
    ).rejects.toThrow(DomainError);
  });

  it("allows a viewer to read history", async () => {
    const { service, documents } = harness();
    await save(service, documents);
    const history = await service.listVersions(actor("viewer-1"), WS_A, DOC);

    expect(history).toHaveLength(1);
  });

  it("reports a document from another Workspace as missing", async () => {
    const { service } = harness();

    // Not "forbidden": that answer would itself confirm the document exists.
    await expect(
      service.createVersion(actor("user-3", ORG_OTHER), WS_B, {
        documentId: DOC,
        expectedRevision: 1,
        manifest: manifest(),
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it("never returns one Workspace's versions to another", async () => {
    const { service, documents, versions } = harness();
    await save(service, documents);

    const leaked = await versions.list({ workspaceId: WS_B, documentId: DOC, limit: 10 });
    expect(leaked).toHaveLength(0);
  });

  it("refuses to version a trashed document", async () => {
    const { service, documents } = harness();
    documents.add("doc-trashed", WS_A, "trashed");

    await expect(
      service.createVersion(actor("user-1"), WS_A, {
        documentId: "doc-trashed",
        expectedRevision: 1,
        manifest: manifest(),
      }),
    ).rejects.toThrow(DomainError);
  });

  it("refuses to version an archived document", async () => {
    const { service, documents } = harness();
    documents.add("doc-archived", WS_A, "archived");

    await expect(
      service.createVersion(actor("user-1"), WS_A, {
        documentId: "doc-archived",
        expectedRevision: 1,
        manifest: manifest(),
      }),
    ).rejects.toThrow(DomainError);
  });

  it("re-authorizes on every operation", async () => {
    const { service, documents, workspaces } = harness();
    const before = workspaces.authorizationCalls;

    const created = await save(service, documents);
    await service.getVersion(actor("user-1"), WS_A, DOC, created.versionNumber);
    await service.listVersions(actor("user-1"), WS_A, DOC);
    await service.getLatestVersion(actor("user-1"), WS_A, DOC);

    // Four operations, four authorizations: none of them trusts a prior check.
    expect(workspaces.authorizationCalls - before).toBeGreaterThanOrEqual(4);
  });

  it("lets a colleague in the same Workspace read another's versions", async () => {
    const { service, documents } = harness();
    await save(service, documents, "user-1");
    const history = await service.listVersions(actor("user-2"), WS_A, DOC);

    // Versions are shared document history, so Workspace membership is the
    // boundary — unlike M7.5 drafts, which stay private to their author.
    expect(history).toHaveLength(1);
    expect(history[0].createdById).toBe("user-1");
  });

  it("stores the resolved organization rather than inferring it from an id", async () => {
    const { service, documents } = harness();
    const version = await save(service, documents);

    expect(version.organizationId).toBe(ORG);
    expect(version.workspaceId).toBe(WS_A);
  });
});

describe("VersionService — history reads", () => {
  it("lists newest first", async () => {
    const { service, documents } = harness();
    await save(service, documents);
    await save(service, documents);
    await save(service, documents);

    const history = await service.listVersions(actor("user-1"), WS_A, DOC);
    expect(history.map((v) => v.versionNumber)).toEqual([3, 2, 1]);
  });

  it("caps a listing at the domain maximum", async () => {
    const { service, documents } = harness();
    for (let i = 0; i < 3; i += 1) await save(service, documents);

    const history = await service.listVersions(actor("user-1"), WS_A, DOC, 9_999);
    expect(history.length).toBeLessThanOrEqual(L.maxListLimit);
  });

  it("pages backwards from a version number", async () => {
    const { service, documents } = harness();
    for (let i = 0; i < 4; i += 1) await save(service, documents);

    const page = await service.listVersions(actor("user-1"), WS_A, DOC, 2, 3);
    expect(page.map((v) => v.versionNumber)).toEqual([2, 1]);
  });

  it("returns the latest version", async () => {
    const { service, documents } = harness();
    await save(service, documents);
    const last = await save(service, documents);

    const latest = await service.getLatestVersion(actor("user-1"), WS_A, DOC);
    expect(latest!.id).toBe(last.id);
  });

  it("returns null when a document has no versions", async () => {
    const { service } = harness();
    expect(await service.getLatestVersion(actor("user-1"), WS_A, DOC)).toBeNull();
  });

  it("returns null for a version number that does not exist", async () => {
    const { service, documents } = harness();
    await save(service, documents);
    expect(await service.getVersion(actor("user-1"), WS_A, DOC, 42)).toBeNull();
  });

  it("rejects an invalid version number rather than coercing it", async () => {
    const { service } = harness();
    await expect(service.getVersion(actor("user-1"), WS_A, DOC, -1)).rejects.toThrow(DomainError);
    await expect(service.getVersion(actor("user-1"), WS_A, DOC, 1.5)).rejects.toThrow(DomainError);
  });
});

describe("VersionService — retention", () => {
  it("keeps all history when retention is disabled", async () => {
    const { service, documents, versions } = harness();
    for (let i = 0; i < 5; i += 1) await save(service, documents);

    expect(await versions.countForDocument(WS_A, DOC)).toBe(5);
  });

  it("prunes the oldest versions past the retention bound", async () => {
    const { service, documents, versions } = harness({ maxVersionsPerDocument: 3 });
    for (let i = 0; i < 5; i += 1) {
      await save(service, documents, "user-1", { sourceKey: `sources/doc-1/v${i}.pdf` });
    }

    const remaining = await versions.list({ workspaceId: WS_A, documentId: DOC, limit: 50 });
    expect(remaining).toHaveLength(3);
    expect(remaining.map((v) => v.versionNumber)).toEqual([5, 4, 3]);
  });

  it("deletes the pruned version's artifacts", async () => {
    const { service, documents, storage } = harness({ maxVersionsPerDocument: 2 });
    for (let i = 0; i < 4; i += 1) {
      await save(service, documents, "user-1", {
        sourceKey: `sources/doc-1/v${i}.pdf`,
        thumbnailKeys: [`thumbs/doc-1/v${i}.png`],
      });
    }

    expect(storage.deletes).toContain("sources/doc-1/v0.pdf");
    expect(storage.deletes).toContain("thumbs/doc-1/v0.png");
  });

  it("never deletes an artifact another version still references", async () => {
    const { service, documents, storage } = harness({ maxVersionsPerDocument: 2 });
    // Every version cut from the same source bytes — deduplication, in practice.
    for (let i = 0; i < 4; i += 1) await save(service, documents);

    // The shared source is still referenced by the surviving versions, so it must
    // outlive the rows that were pruned.
    expect(storage.deletes).not.toContain(manifest().sourceKey);
  });

  it("keeps bytes when the reference check says they are still in use", async () => {
    const { service, documents, storage } = harness({
      maxVersionsPerDocument: 1,
      wrapVersions: (inner) => new AlwaysReferencedRepository(inner),
    });
    for (let i = 0; i < 3; i += 1) {
      await save(service, documents, "user-1", { sourceKey: `sources/doc-1/v${i}.pdf` });
    }

    expect(storage.deletes).toHaveLength(0);
  });

  it("does not let a failed retention sweep fail the save", async () => {
    const { service, documents, storage } = harness({ maxVersionsPerDocument: 1 });
    storage.delete = async () => {
      throw new Error("storage unavailable");
    };

    // Housekeeping must not cost the author their save.
    for (let i = 0; i < 3; i += 1) {
      await expect(
        save(service, documents, "user-1", { sourceKey: `sources/doc-1/v${i}.pdf` }),
      ).resolves.toBeDefined();
    }
  });
});

describe("VersionService — failure handling", () => {
  it("surfaces a version-store failure rather than fabricating a version", async () => {
    const { service, documents } = harness({
      wrapVersions: (inner) => new UnavailableVersionRepository(inner),
    });
    const doc = await documents.getById(WS_A, DOC);

    await expect(
      service.createVersion(actor("user-1"), WS_A, {
        documentId: DOC,
        expectedRevision: doc!.revision,
        manifest: manifest(),
      }),
    ).rejects.toThrow(/version store unavailable/);
  });

  it("leaves the document unchanged when the version could not be written", async () => {
    const { service, documents } = harness({
      wrapVersions: (inner) => new UnavailableVersionRepository(inner),
    });
    const before = await documents.getById(WS_A, DOC);

    await expect(save(service, documents)).rejects.toThrow();

    const after = await documents.getById(WS_A, DOC);
    expect(after!.revision).toBe(before!.revision);
    expect(after!.currentVersionId).toBeNull();
  });

  it("keeps the version when the document pointer update fails", async () => {
    const { service, documents, versions } = harness();
    documents.failUpdates = true;

    await expect(save(service, documents)).rejects.toThrow(DomainError);

    // The version is real history that was genuinely written. Deleting it to tidy
    // up would destroy the artifacts the caller just committed.
    expect(await versions.countForDocument(WS_A, DOC)).toBe(1);
  });

  it("logs the pointer failure rather than swallowing it", async () => {
    const { service, documents, logger } = harness();
    documents.failUpdates = true;

    await expect(save(service, documents)).rejects.toThrow(DomainError);
    expect(logger.entries.some((entry) => entry.level === "error")).toBe(true);
  });
});
