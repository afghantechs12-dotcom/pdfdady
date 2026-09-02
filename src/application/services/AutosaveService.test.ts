import { describe, expect, it } from "vitest";
import { AutosaveService } from "./AutosaveService";
import type { ActorContext, WorkspaceService } from "./WorkspaceService";
import type { ILogger, LogFields } from "@/src/application/ports/Logger";
import type { DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";
import type {
  AutosaveDraftRepository,
  CreateAutosaveDraftInput,
  UpdateAutosaveDraftInput,
} from "@/src/application/ports/workspaces/AutosaveDraftRepository";
import type { AutosaveDraft } from "@/src/domain/entities/AutosaveDraft";
import type { IObjectStorage } from "@/src/application/ports/storage/ObjectStorage";
import type { DocumentRecord, DocumentRecordLifecycleState } from "@/src/domain/entities/DocumentRecord";
import { InMemoryAutosaveDraftRepository } from "@/src/infrastructure/persistence/InMemoryAutosaveDraftRepository";
import { AUTOSAVE_DRAFT_LIMITS as L } from "@/src/domain/entities/AutosaveDraft";
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

/**
 * In-memory object storage with reference counting, so tests can assert which
 * keys were written and which were released. Keys can also be flagged as
 * corrupt so the checksum-verification paths are exercised without a real store.
 */
class FakeObjectStorage implements IObjectStorage {
  readonly objects = new Map<string, Buffer>();
  readonly contentType = new Map<string, string | null>();
  readonly puts: string[] = [];
  readonly deletes: string[] = [];
  readonly corrupt = new Set<string>();
  /** When set, `put` throws — simulates an object-storage outage. */
  failPuts = false;

  async put(key: string, data: Buffer, options: { contentType: string; sha256?: string }): Promise<void> {
    if (this.failPuts) throw new Error("storage unavailable");
    this.objects.set(key, Buffer.from(data));
    this.contentType.set(key, options.contentType);
    this.puts.push(key);
  }
  async get(key: string): Promise<Buffer> {
    if (this.corrupt.has(key)) return Buffer.from("corrupted-bytes");
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
      chunks.push(value);
    }
    const data = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    await this.put(key, data, options);
    return { sha256: options.sha256 ?? "", size: data.byteLength };
  }
  async head(key: string): Promise<{ key: string; size: number; contentType: string | null; exists: boolean }> {
    const data = this.objects.get(key);
    return {
      key,
      size: data?.byteLength ?? 0,
      contentType: this.contentType.get(key) ?? null,
      exists: data !== undefined,
    };
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
    this.addWorkspace(workspaceId, this.orgOf.get(workspaceId) ?? ORG);
    this.grants.get(workspaceId)!.set(userId, role);
  }
  async get(a: ActorContext, workspaceId: string, write = false) {
    this.calls += 1;
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
  get authorizationCalls(): number {
    return this.calls;
  }
}

class FakeDocumentRecordRepository {
  readonly docs = new Map<string, DocumentRecord>();

  add(
    id: string,
    workspaceId: string,
    lifecycleState: DocumentRecordLifecycleState = "active",
    revision = 1,
  ): DocumentRecord {
    const now = new Date();
    const record: DocumentRecord = {
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
    };
    this.docs.set(`${workspaceId}:${id}`, record);
    return record;
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
}

/** A mutable clock so lease expiry is exercised without real waiting. */
class TestClock {
  constructor(private current = new Date("2026-08-02T12:00:00.000Z")) {}
  now = (): Date => new Date(this.current);
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/**
 * Delegating repository, so a test can alter one behaviour without restating
 * the whole port. Subclasses below stand in for conditions that cannot be
 * produced through the public API: a writer landing between the service's read
 * and its write, a snapshot still referenced by another row, and a metadata
 * store that is down.
 */
class DelegatingDraftRepository implements AutosaveDraftRepository {
  constructor(protected readonly inner: AutosaveDraftRepository) {}
  create(input: CreateAutosaveDraftInput): Promise<AutosaveDraft> {
    return this.inner.create(input);
  }
  getById(workspaceId: string, draftId: string): Promise<AutosaveDraft | null> {
    return this.inner.getById(workspaceId, draftId);
  }
  findByDevice(
    workspaceId: string,
    documentId: string,
    userId: string,
    deviceId: string,
  ): Promise<AutosaveDraft | null> {
    return this.inner.findByDevice(workspaceId, documentId, userId, deviceId);
  }
  listByDocument(workspaceId: string, documentId: string, limit?: number): Promise<AutosaveDraft[]> {
    return this.inner.listByDocument(workspaceId, documentId, limit);
  }
  listByDocumentAndUser(
    workspaceId: string,
    documentId: string,
    userId: string,
    limit?: number,
  ): Promise<AutosaveDraft[]> {
    return this.inner.listByDocumentAndUser(workspaceId, documentId, userId, limit);
  }
  update(
    workspaceId: string,
    draftId: string,
    data: UpdateAutosaveDraftInput,
    expectedVersion?: number,
  ): Promise<AutosaveDraft | null> {
    return this.inner.update(workspaceId, draftId, data, expectedVersion);
  }
  delete(workspaceId: string, draftId: string): Promise<boolean> {
    return this.inner.delete(workspaceId, draftId);
  }
  isSnapshotReferenced(workspaceId: string, snapshotKey: string): Promise<boolean> {
    return this.inner.isSnapshotReferenced(workspaceId, snapshotKey);
  }
}

/**
 * Lands a competing write immediately before every version-checked update, so
 * the service's `expectedVersion` is stale by the time it reaches the store.
 * This is the race the version column exists for; bumping the row *before*
 * calling the service proves nothing, because the service re-reads the draft.
 */
class ConcurrentWriterRepository extends DelegatingDraftRepository {
  override async update(
    workspaceId: string,
    draftId: string,
    data: UpdateAutosaveDraftInput,
    expectedVersion?: number,
  ): Promise<AutosaveDraft | null> {
    const current = await this.inner.getById(workspaceId, draftId);
    if (current) {
      await this.inner.update(workspaceId, draftId, {}, current.version);
    }
    return this.inner.update(workspaceId, draftId, data, expectedVersion);
  }
}

/** Reports every snapshot key as still referenced by some draft. */
class AlwaysReferencedRepository extends DelegatingDraftRepository {
  override async isSnapshotReferenced(): Promise<boolean> {
    return true;
  }
}

/** A metadata store that refuses to create rows. */
class UnavailableDraftRepository extends DelegatingDraftRepository {
  override async create(): Promise<never> {
    throw new Error("db unavailable");
  }
}

interface HarnessOptions {
  leaseMs?: number;
  maxPayloadBytes?: number;
  /** Wraps the in-memory repository to simulate a store-level condition. */
  wrapDrafts?: (inner: AutosaveDraftRepository) => AutosaveDraftRepository;
}

function harness(options: HarnessOptions = {}) {
  const logger = new TestLogger();
  const workspaces = new FakeWorkspaceService();
  const drafts = new InMemoryAutosaveDraftRepository();
  const documents = new FakeDocumentRecordRepository();
  const storage = new FakeObjectStorage();
  const clock = new TestClock();

  workspaces.addWorkspace(WS_A, ORG);
  workspaces.addWorkspace(WS_B, ORG);
  workspaces.grant(WS_A, "user-1", "editor");
  workspaces.grant(WS_A, "user-2", "editor");
  workspaces.grant(WS_B, "user-3", "editor");
  documents.add(DOC, WS_A);

  const repository = options.wrapDrafts
    ? options.wrapDrafts(drafts as AutosaveDraftRepository)
    : (drafts as AutosaveDraftRepository);

  const service = new AutosaveService(
    logger,
    workspaces as unknown as WorkspaceService,
    repository,
    documents as unknown as DocumentRecordRepository,
    storage,
    { now: clock.now, leaseMs: options.leaseMs, maxPayloadBytes: options.maxPayloadBytes },
  );

  return { service, logger, workspaces, drafts, documents, storage, clock };
}

type SaveOverrides = Partial<{
  documentId: string;
  deviceId: string;
  baseVersion: number;
  expectedRevision: number;
  payload: string;
}>;

function save(
  service: AutosaveService,
  userId: string,
  overrides: SaveOverrides = {},
  workspaceId = WS_A,
) {
  return service.saveDraft(actor(userId), workspaceId, {
    documentId: overrides.documentId ?? DOC,
    deviceId: overrides.deviceId ?? "device-a",
    baseVersion: overrides.baseVersion ?? 1,
    expectedRevision: overrides.expectedRevision ?? 1,
    payload: overrides.payload ?? '{"blocks":[]}',
  });
}

describe("AutosaveService — durable drafts", () => {
  it("creates a durable dirty draft on first save", async () => {
    const { service } = harness();
    const draft = await save(service, "user-1");

    expect(draft.status).toBe("dirty");
    expect(draft.userId).toBe("user-1");
    expect(draft.deviceId).toBe("device-a");
    expect(draft.documentId).toBe(DOC);
    expect(draft.workspaceId).toBe(WS_A);
    expect(draft.version).toBe(1);
    expect(draft.snapshotKey).toContain("workspaces/ws-alpha/autosave/doc-1/user-1");
    expect(draft.snapshotGeneration).toBe(1);
    expect(draft.leaseOwnerDeviceId).toBe("device-a");
  });

  it("computes the checksum server-side and records the real byte size", async () => {
    const { service } = harness();
    const payload = '{"blocks":[{"text":"héllo"}]}';
    const draft = await save(service, "user-1", { payload });

    expect(draft.byteSize).toBe(Buffer.byteLength(payload, "utf8"));
    expect(draft.byteSize).toBeGreaterThan(payload.length - 1);
    expect(draft.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(draft.checksum).not.toBe(payload);
  });

  it("stores the snapshot bytes in object storage with the right content type", async () => {
    const { service, storage } = harness();
    const draft = await save(service, "user-1");
    const bytes = storage.objects.get(draft.snapshotKey);
    expect(bytes).toBeDefined();
    expect(bytes!.toString("utf8")).toBe('{"blocks":[]}');
    expect(storage.contentType.get(draft.snapshotKey)).toBe("application/json");
  });

  it("a second save updates the same user/device draft, versioning the snapshot", async () => {
    const { service, storage } = harness();
    const first = await save(service, "user-1", { payload: '{"blocks":[1]}' });
    const second = await save(service, "user-1", { payload: '{"blocks":[1,2]}' });

    expect(second.id).toBe(first.id);
    expect(second.snapshotGeneration).toBe(first.snapshotGeneration + 1);
    expect(second.snapshotKey).not.toBe(first.snapshotKey);
    expect(second.version).toBe(first.version + 1);
    expect(storage.objects.get(second.snapshotKey)!.toString("utf8")).toBe('{"blocks":[1,2]}');
    // The superseded snapshot is dropped once the row no longer references it.
    expect(storage.objects.has(first.snapshotKey)).toBe(false);
  });

  it("separate devices receive separate drafts", async () => {
    const { service } = harness();
    const a = await save(service, "user-1", { deviceId: "device-a" });
    const b = await save(service, "user-1", { deviceId: "device-b" });
    expect(a.id).not.toBe(b.id);
    expect(a.deviceId).toBe("device-a");
    expect(b.deviceId).toBe("device-b");
  });

  it("separate users receive separate drafts", async () => {
    const { service } = harness();
    const a = await save(service, "user-1", { deviceId: "device-a" });
    const b = await save(service, "user-2", { deviceId: "device-a" });
    expect(a.id).not.toBe(b.id);
    expect(a.userId).toBe("user-1");
    expect(b.userId).toBe("user-2");
  });

  it("a document revision mismatch preserves the payload as a conflict", async () => {
    const { service, documents } = harness();
    documents.setRevision(WS_A, DOC, 5);
    const draft = await save(service, "user-1", { expectedRevision: 3 });

    expect(draft.status).toBe("conflict");
    expect(draft.failureReason).toContain("revision");
    expect(draft.byteSize).toBe(Buffer.byteLength('{"blocks":[]}', "utf8"));
    // The conflict is with the document, not with another device: this device is
    // still the only editor, so it keeps the lease.
    expect(draft.leaseOwnerDeviceId).toBe("device-a");
  });

  it("a live lease held by another device stores the save as a conflict", async () => {
    const { service, drafts } = harness();
    await save(service, "user-1", { deviceId: "device-a" });
    const conflict = await save(service, "user-1", { deviceId: "device-b" });

    expect(conflict.status).toBe("conflict");
    expect(conflict.failureReason).toContain("lease");
    expect(conflict.snapshotGeneration).toBe(1);
    // device-b took nothing: the lease lives on the row that holds it, and that
    // row is still device-a's.
    expect(conflict.leaseOwnerDeviceId).toBeNull();
    expect(conflict.leaseExpiresAt).toBeNull();
    const holder = await drafts.findByDevice(WS_A, DOC, "user-1", "device-a");
    expect(holder!.leaseOwnerDeviceId).toBe("device-a");
  });

  it("an expired lease permits a safe takeover", async () => {
    const { service, clock } = harness();
    await save(service, "user-1", { deviceId: "device-a" });
    clock.advance(L.defaultLeaseMs + 1_000);

    const takeover = await save(service, "user-1", { deviceId: "device-b" });
    expect(takeover.status).toBe("dirty");
    expect(takeover.leaseOwnerDeviceId).toBe("device-b");
  });

  it("enforces the payload byte limit", async () => {
    const { service } = harness({ maxPayloadBytes: 64 });
    await expect(save(service, "user-1", { payload: "x".repeat(65) })).rejects.toThrow(
      /exceeds 64 bytes/,
    );
  });

  it("rejects a blank device id", async () => {
    const { service } = harness();
    await expect(save(service, "user-1", { deviceId: "   " })).rejects.toThrow(
      /deviceId is required/,
    );
  });

  it("rejects an oversized device id", async () => {
    const { service } = harness();
    await expect(save(service, "user-1", { deviceId: "d".repeat(L.maxDeviceIdLength + 1) })).rejects.toThrow(
      /exceeds \d+ characters/,
    );
  });

  it("rejects device ids containing control characters", async () => {
    const { service } = harness();
    await expect(save(service, "user-1", { deviceId: `bad${String.fromCharCode(1)}id` })).rejects.toThrow(
      /control characters/,
    );
  });

  it("rejects invalid counters", async () => {
    const { service } = harness();
    await expect(
      save(service, "user-1", { baseVersion: -1 }),
    ).rejects.toThrow(/baseVersion/);
    await expect(
      save(service, "user-1", { baseVersion: L.maxCounter + 1 }),
    ).rejects.toThrow(/baseVersion/);
    await expect(
      save(service, "user-1", { expectedRevision: 1.5 }),
    ).rejects.toThrow(/expectedRevision/);
  });
});

describe("AutosaveService — authorization", () => {
  it("rejects a non-member", async () => {
    const { service, workspaces } = harness();
    workspaces.grant(WS_A, "outsider", "editor");
    await expect(
      service.saveDraft(actor("outsider", ORG_OTHER), WS_A, {
        documentId: DOC,
        deviceId: "device-a",
        baseVersion: 1,
        expectedRevision: 1,
        payload: "{}",
      }),
    ).rejects.toThrow(/Forbidden/);
  });

  it("rejects a viewer write", async () => {
    const { service, workspaces } = harness();
    workspaces.grant(WS_A, "user-2", "viewer");
    await expect(save(service, "user-2")).rejects.toThrow(/Write access required/);
  });

  it("reports a cross-Workspace document as missing", async () => {
    const { service, workspaces } = harness();
    workspaces.addWorkspace(WS_B, ORG);
    workspaces.grant(WS_B, "user-1", "editor");
    // The document lives in WS_A; asking for it under WS_B must read as missing,
    // not forbidden — the distinction would disclose the document's existence.
    await expect(
      service.saveDraft(actor("user-1"), WS_B, {
        documentId: DOC,
        deviceId: "device-a",
        baseVersion: 1,
        expectedRevision: 1,
        payload: "{}",
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it("rejects a trashed document", async () => {
    const { service, documents } = harness();
    documents.add("doc-trash", WS_A, "trashed", 1);
    await expect(
      service.saveDraft(actor("user-1"), WS_A, {
        documentId: "doc-trash",
        deviceId: "device-a",
        baseVersion: 1,
        expectedRevision: 1,
        payload: "{}",
      }),
    ).rejects.toThrow(/archived or trashed/);
  });

  it("a member of another organization cannot act in this workspace", async () => {
    const { service } = harness();
    await expect(
      service.saveDraft(actor("other-org-user", ORG_OTHER), WS_A, {
        documentId: DOC,
        deviceId: "device-a",
        baseVersion: 1,
        expectedRevision: 1,
        payload: "{}",
      }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("AutosaveService — isolation", () => {
  it("does not list another user's drafts", async () => {
    const { service } = harness();
    await save(service, "user-1", { deviceId: "device-a" });
    const visible = await service.listDrafts(actor("user-2"), WS_A, DOC);
    expect(visible).toHaveLength(0);
  });

  it("cannot read another user's draft by device id", async () => {
    const { service } = harness();
    await save(service, "user-1", { deviceId: "device-a" });
    const draft = await service.getDraft(actor("user-2"), WS_A, DOC, "device-a");
    expect(draft).toBeNull();
  });

  it("cannot read another user's snapshot payload", async () => {
    const { service } = harness();
    await save(service, "user-1", { deviceId: "device-a" });
    await expect(
      service.readSnapshot(actor("user-2"), WS_A, DOC, "device-a"),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("AutosaveService — status transitions", () => {
  it("presents an expired dirty draft as stale", async () => {
    const { service, clock } = harness();
    const draft = await save(service, "user-1");
    clock.advance(L.defaultLeaseMs + 1_000);
    const read = await service.getDraft(actor("user-1"), WS_A, DOC, "device-a");
    expect(read!.status).toBe("stale");
    // The row is metadata only — the editor state lives in object storage and is
    // handed back by recoverDraft, never carried on a listing or a status read.
    expect("payload" in read!).toBe(false);
    expect(draft.status).toBe("dirty");
  });

  it("does not change a saved draft back to stale", async () => {
    const { service, clock } = harness();
    const draft = await save(service, "user-1");
    await service.markSaved(actor("user-1"), WS_A, DOC, "device-a");
    clock.advance(L.defaultLeaseMs + 1_000);
    const read = await service.getDraft(actor("user-1"), WS_A, DOC, "device-a");
    expect(read!.status).toBe("saved");
    expect(draft.status).toBe("dirty");
  });

  it("recovery returns the draft to dirty and hands the lease to the recovering device", async () => {
    const { service, clock } = harness();
    await save(service, "user-1", { deviceId: "device-a" });
    clock.advance(L.defaultLeaseMs + 1_000);
    const recovered = await service.recoverDraft(actor("user-1"), WS_A, DOC, "device-a");
    expect(recovered.draft.status).toBe("dirty");
    expect(recovered.draft.leaseOwnerDeviceId).toBe("device-a");
    expect(recovered.payload).toBe('{"blocks":[]}');
  });

  it("recovery of a missing draft fails", async () => {
    const { service } = harness();
    await expect(
      service.recoverDraft(actor("user-1"), WS_A, DOC, "device-none"),
    ).rejects.toThrow(NotFoundError);
  });

  it("conflict recovery returns the draft to dirty", async () => {
    const { service, documents } = harness();
    documents.setRevision(WS_A, DOC, 5);
    await save(service, "user-1", { expectedRevision: 1 });
    const recovered = await service.recoverDraft(actor("user-1"), WS_A, DOC, "device-a");
    expect(recovered.draft.status).toBe("dirty");
    expect(recovered.draft.failureReason).toBeNull();
    expect(recovered.payload).toBe('{"blocks":[]}');
  });

  it("markSaved releases the lease", async () => {
    const { service } = harness();
    const draft = await save(service, "user-1");
    const saved = await service.markSaved(actor("user-1"), WS_A, DOC, "device-a");
    expect(saved.status).toBe("saved");
    expect(saved.leaseOwnerDeviceId).toBeNull();
    expect(saved.leaseExpiresAt).toBeNull();
    expect(draft.leaseOwnerDeviceId).toBe("device-a");
  });

  it("discard deletes the draft and its snapshot", async () => {
    const { service, storage, drafts } = harness();
    const draft = await save(service, "user-1");
    const gone = await service.discardDraft(actor("user-1"), WS_A, DOC, "device-a");
    expect(gone).toBe(true);
    expect(storage.objects.has(draft.snapshotKey)).toBe(false);
    expect(await drafts.getById(WS_A, draft.id)).toBeNull();
  });

  it("a repeated discard returns false", async () => {
    const { service } = harness();
    await save(service, "user-1");
    expect(await service.discardDraft(actor("user-1"), WS_A, DOC, "device-a")).toBe(true);
    expect(await service.discardDraft(actor("user-1"), WS_A, DOC, "device-a")).toBe(false);
  });
});

describe("AutosaveService — concurrency and integrity", () => {
  it("rejects a stale write via optimistic concurrency", async () => {
    const { service } = harness({
      wrapDrafts: (inner) => new ConcurrentWriterRepository(inner),
    });
    // The first save creates the row, so no version-checked update runs yet.
    const created = await save(service, "user-1");
    expect(created.version).toBe(1);
    // The second save reads, stages, then finds the row moved on beneath it.
    await expect(
      save(service, "user-1", { payload: '{"blocks":[2]}' }),
    ).rejects.toThrow(/changed concurrently/);
  });

  it("does not leave an unreferenced snapshot behind when a concurrent write is rejected", async () => {
    const { service, drafts, storage } = harness({
      wrapDrafts: (inner) => new ConcurrentWriterRepository(inner),
    });
    const created = await save(service, "user-1");
    const putsBefore = storage.puts.length;

    await expect(save(service, "user-1", { payload: "{}" })).rejects.toThrow(/changed concurrently/);

    // Exactly one snapshot was staged, and it was released because the rejected
    // update left no row pointing at it.
    expect(storage.puts).toHaveLength(putsBefore + 1);
    const staged = storage.puts[putsBefore];
    expect(staged).not.toBe(created.snapshotKey);
    expect(storage.objects.has(staged)).toBe(false);
    expect(storage.deletes).toContain(staged);
    // The snapshot the row still references was never touched.
    expect(storage.objects.get(created.snapshotKey)!.toString("utf8")).toBe('{"blocks":[]}');
    const row = await drafts.getById(WS_A, created.id);
    expect(row!.snapshotKey).toBe(created.snapshotKey);
  });

  it("releases a staged snapshot when the metadata write fails", async () => {
    const { service, storage } = harness({
      wrapDrafts: (inner) => new UnavailableDraftRepository(inner),
    });

    await expect(save(service, "user-1")).rejects.toThrow(/db unavailable/);

    // The bytes were staged before the row was attempted, so the failed create
    // must not leave them orphaned.
    expect(storage.puts).toHaveLength(1);
    expect(storage.deletes).toEqual(storage.puts);
    expect(storage.objects.size).toBe(0);
  });

  it("every operation reauthorizes the document", async () => {
    const { service, workspaces } = harness();
    await save(service, "user-1");
    const before = workspaces.authorizationCalls;
    await service.listDrafts(actor("user-1"), WS_A, DOC);
    await service.getDraft(actor("user-1"), WS_A, DOC, "device-a");
    await expect(service.discardDraft(actor("user-1"), WS_A, DOC, "device-a")).resolves.toBe(true);
    expect(workspaces.authorizationCalls).toBe(before + 3);
  });

  it("autosave does not create or increment a DocumentVersion", async () => {
    const { service, documents } = harness();
    const documentBefore = documents.docs.get(`${WS_A}:${DOC}`)!;
    await save(service, "user-1");
    await save(service, "user-1", { payload: '{"blocks":[2]}' });
    const documentAfter = documents.docs.get(`${WS_A}:${DOC}`)!;
    expect(documentAfter.currentVersionId).toBe(documentBefore.currentVersionId);
    expect(documentAfter.revision).toBe(documentBefore.revision);
    expect(documents.docs.size).toBe(1);
  });

  it("a repository-returned mutation cannot modify persisted state", async () => {
    const { service } = harness();
    const draft = await save(service, "user-1");
    draft.snapshotKey = "tampered/key";
    draft.status = "saved";
    draft.leaseOwnerDeviceId = "attacker";
    const read = await service.getDraft(actor("user-1"), WS_A, DOC, "device-a");
    expect(read!.status).toBe("dirty");
    expect(read!.leaseOwnerDeviceId).toBe("device-a");
  });
});

describe("AutosaveService — snapshot integrity", () => {
  it("readSnapshot returns the stored payload matching its checksum", async () => {
    const { service } = harness();
    const draft = await save(service, "user-1", { payload: '{"blocks":[7]}' });
    const { draft: read, payload } = await service.readSnapshot(actor("user-1"), WS_A, DOC, "device-a");
    expect(read.id).toBe(draft.id);
    expect(payload).toBe('{"blocks":[7]}');
  });

  it("rejects a snapshot whose bytes no longer match the recorded checksum", async () => {
    const { service, storage } = harness();
    const draft = await save(service, "user-1");
    storage.corrupt.add(draft.snapshotKey);
    await expect(
      service.readSnapshot(actor("user-1"), WS_A, DOC, "device-a"),
    ).rejects.toThrow(/checksum/);
  });

  it("reports a missing snapshot rather than returning a partial draft", async () => {
    const { service, storage } = harness();
    const draft = await save(service, "user-1");
    storage.objects.delete(draft.snapshotKey);
    await expect(
      service.recoverDraft(actor("user-1"), WS_A, DOC, "device-a"),
    ).rejects.toThrow(/no longer available/);
  });

  it("a conflicted save stages a fresh key instead of overwriting the referenced snapshot", async () => {
    const { service, documents, storage } = harness();
    const draft = await save(service, "user-1", { payload: '{"blocks":[1]}' });
    documents.setRevision(WS_A, DOC, 9);
    const conflicted = await save(service, "user-1", { payload: '{"blocks":[2]}' });

    expect(conflicted.status).toBe("conflict");
    // The conflicting bytes go to a new generation, so a crash mid-save can
    // never corrupt the snapshot the row still points at.
    expect(conflicted.snapshotKey).not.toBe(draft.snapshotKey);
    expect(conflicted.snapshotGeneration).toBe(draft.snapshotGeneration + 1);
    expect(storage.objects.get(conflicted.snapshotKey)!.toString("utf8")).toBe('{"blocks":[2]}');
    // Only once the row is repointed is the superseded snapshot released.
    expect(storage.objects.has(draft.snapshotKey)).toBe(false);
    expect(storage.deletes).toContain(draft.snapshotKey);
  });

  it("never deletes a snapshot still referenced by another draft", async () => {
    // Sharing a key is unreachable through the public API, so the guard is
    // exercised by a repository that reports the key as still referenced. The
    // service must trust that answer over its own bookkeeping.
    const { service, storage } = harness({
      wrapDrafts: (inner) => new AlwaysReferencedRepository(inner),
    });
    const draft = await save(service, "user-1");

    expect(await service.discardDraft(actor("user-1"), WS_A, DOC, "device-a")).toBe(true);

    expect(storage.objects.has(draft.snapshotKey)).toBe(true);
    expect(storage.deletes).not.toContain(draft.snapshotKey);
  });

  it("a failed object-storage put surfaces as an error and writes no row", async () => {
    const { service, storage, drafts } = harness();
    storage.failPuts = true;
    await expect(save(service, "user-1")).rejects.toThrow(/storage unavailable/);
    expect(await drafts.listByDocument(WS_A, DOC)).toHaveLength(0);
  });
});
