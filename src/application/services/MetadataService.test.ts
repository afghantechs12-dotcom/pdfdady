import { describe, expect, it } from "vitest";
import { MetadataService } from "./MetadataService";
import type { ActorContext, WorkspaceService } from "./WorkspaceService";
import type { ILogger, LogFields } from "@/src/application/ports/Logger";
import type { DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";
import type { DocumentRecord } from "@/src/domain/entities/DocumentRecord";
import type {
  IObjectStorage,
  ObjectMetadata,
  PutOptions,
  StreamPutOptions,
  StreamPutResult,
} from "@/src/application/ports/storage/ObjectStorage";
import { METADATA_LIMITS } from "@/src/domain/entities/DocumentMetadata";
import { InMemoryDocumentMetadataRepository } from "@/src/infrastructure/persistence/InMemoryDocumentMetadataRepository";
import { InMemoryBookmarkRepository } from "@/src/infrastructure/persistence/InMemoryBookmarkRepository";
import { InMemoryOutlineItemRepository } from "@/src/infrastructure/persistence/InMemoryOutlineItemRepository";
import { InMemoryAttachmentRepository } from "@/src/infrastructure/persistence/InMemoryAttachmentRepository";
import { InMemoryStoredFileRepository } from "@/src/infrastructure/persistence/InMemoryStoredFileRepository";
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

const ORG = "org-alpha";
const ORG_OTHER = "org-beta";
const WS_A = "ws-alpha";
const WS_B = "ws-beta";
const DOC_A = "doc-alpha";
const DOC_A2 = "doc-alpha-2";
const DOC_B = "doc-beta";

function actor(userId: string, organizationId = ORG): ActorContext {
  return {
    userId,
    organizationId,
    organizationRole: "member",
    organizationDefaultWorkspaceId: null,
  };
}

/**
 * Authorization double. It keeps the three refusals distinct that the service
 * must keep distinct: a Workspace in another organization is *missing* (so a
 * probe cannot confirm it exists), a non-member is refused, and a viewer is
 * refused only for writes.
 */
class FakeWorkspaceService {
  private readonly grants = new Map<string, Map<string, "admin" | "editor" | "viewer">>();
  private readonly orgOf = new Map<string, string>();

  addWorkspace(workspaceId: string, organizationId = ORG): void {
    this.orgOf.set(workspaceId, organizationId);
    if (!this.grants.has(workspaceId)) this.grants.set(workspaceId, new Map());
  }
  grant(workspaceId: string, userId: string, role: "admin" | "editor" | "viewer" = "editor"): void {
    if (!this.grants.has(workspaceId)) this.addWorkspace(workspaceId);
    this.grants.get(workspaceId)!.set(userId, role);
  }
  async get(a: ActorContext, workspaceId: string, write = false) {
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
}

class FakeDocumentRecordRepository {
  private readonly docs = new Map<string, DocumentRecord>();

  add(id: string, workspaceId: string, organizationId = ORG): void {
    const now = new Date("2026-06-01T00:00:00.000Z");
    this.docs.set(`${workspaceId}:${id}`, {
      id,
      workspaceId,
      organizationId,
      projectId: null,
      folderId: null,
      name: `${id}.pdf`,
      normalizedName: `${id}.pdf`,
      lifecycleState: "active",
      orderKey: "a0",
      currentVersionId: null,
      favorite: false,
      lastAccessedAt: null,
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

  async getById(workspaceId: string, documentId: string): Promise<DocumentRecord | null> {
    const doc = this.docs.get(`${workspaceId}:${documentId}`);
    return doc ? { ...doc } : null;
  }
}

class FakeObjectStorage implements IObjectStorage {
  readonly objects = new Map<string, Buffer>();
  readonly puts: string[] = [];
  readonly deleted: string[] = [];

  async put(key: string, data: Buffer | Uint8Array, _options: PutOptions): Promise<void> {
    this.puts.push(key);
    this.objects.set(key, Buffer.from(data));
  }
  async get(key: string): Promise<Buffer> {
    const found = this.objects.get(key);
    if (!found) throw new Error(`missing object ${key}`);
    return found;
  }
  async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const found = this.objects.get(key);
    if (!found) throw new Error(`missing object ${key}`);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(found));
        controller.close();
      },
    });
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
    return { key, size: found?.byteLength ?? 0, contentType: null, exists: found !== undefined };
  }
  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

function harness(options: {
  maxAttachmentBytes?: number;
  maxAttachmentTotalBytes?: number;
} = {}) {
  const logger = new TestLogger();
  const workspaces = new FakeWorkspaceService();
  const documents = new FakeDocumentRecordRepository();
  const metadata = new InMemoryDocumentMetadataRepository();
  const bookmarks = new InMemoryBookmarkRepository();
  const outline = new InMemoryOutlineItemRepository();
  const attachments = new InMemoryAttachmentRepository();
  const storage = new FakeObjectStorage();
  const files = new InMemoryStoredFileRepository();

  workspaces.addWorkspace(WS_A, ORG);
  workspaces.addWorkspace(WS_B, ORG_OTHER);
  workspaces.grant(WS_A, "user-1", "editor");
  workspaces.grant(WS_A, "user-2", "editor");
  workspaces.grant(WS_A, "viewer-1", "viewer");
  workspaces.grant(WS_B, "user-3", "editor");
  documents.add(DOC_A, WS_A);
  documents.add(DOC_A2, WS_A);
  documents.add(DOC_B, WS_B, ORG_OTHER);

  const service = new MetadataService(
    logger,
    workspaces as unknown as WorkspaceService,
    documents as unknown as DocumentRecordRepository,
    metadata,
    bookmarks,
    outline,
    attachments,
    storage,
    files,
    options,
  );

  return {
    service,
    logger,
    workspaces,
    documents,
    metadata,
    bookmarks,
    outline,
    attachments,
    storage,
    files,
  };
}

/** Reads a download stream to a Buffer, so the bytes can be asserted. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

describe("MetadataService — authorization", () => {
  it("refuses a document in another workspace as missing, not as forbidden", async () => {
    const { service } = harness();
    await expect(
      service.getDocumentMetadata(actor("user-1"), WS_A, DOC_B),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a workspace in another organization as missing", async () => {
    const { service } = harness();
    await expect(
      service.getDocumentMetadata(actor("user-1"), WS_B, DOC_B),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a non-member", async () => {
    const { service } = harness();
    await expect(service.getDocumentMetadata(actor("stranger"), WS_A, DOC_A)).rejects.toThrow(
      /not a member/i,
    );
  });

  it("lets a viewer read but not write", async () => {
    const { service } = harness();
    await expect(
      service.getDocumentMetadata(actor("viewer-1"), WS_A, DOC_A),
    ).resolves.toBeNull();
    await expect(
      service.setDocumentMetadata(actor("viewer-1"), WS_A, DOC_A, { author: "Ada" }),
    ).rejects.toThrow(/write access/i);
  });

  it("rejects an unbounded document id before it reaches a predicate", async () => {
    const { service } = harness();
    await expect(
      service.getDocumentMetadata(actor("user-1"), WS_A, "x".repeat(500)),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("checks the workspace before the document, so a stranger learns nothing", async () => {
    const { service } = harness();
    // A non-member naming a real document must get the membership refusal, not
    // a "document not found" that would confirm the document does not exist —
    // or worse, a success that confirms it does.
    await expect(service.getDocumentMetadata(actor("stranger"), WS_A, DOC_A)).rejects.toThrow(
      /not a member/i,
    );
  });
});

describe("MetadataService — properties", () => {
  it("persists and reads back allowlisted fields", async () => {
    const { service } = harness();
    const saved = await service.setDocumentMetadata(actor("user-1"), WS_A, DOC_A, {
      title: "Contract",
      author: "Ada Lovelace",
    });
    expect(saved.fields).toEqual({ title: "Contract", author: "Ada Lovelace" });
    expect(saved.documentId).toBe(DOC_A);
    expect(saved.workspaceId).toBe(WS_A);
    expect(saved.revision).toBe(1);

    const read = await service.getDocumentMetadata(actor("user-2"), WS_A, DOC_A);
    expect(read?.fields).toEqual({ title: "Contract", author: "Ada Lovelace" });
  });

  it("returns null when no properties have been set", async () => {
    const { service } = harness();
    await expect(service.getDocumentMetadata(actor("user-1"), WS_A, DOC_A)).resolves.toBeNull();
  });

  it("converges on one row rather than accumulating a second set", async () => {
    const { service, metadata } = harness();
    await service.setDocumentMetadata(actor("user-1"), WS_A, DOC_A, { title: "First" });
    const second = await service.setDocumentMetadata(actor("user-1"), WS_A, DOC_A, {
      title: "Second",
    });
    expect(second.revision).toBe(2);
    expect(await metadata.countForWorkspace(WS_A)).toBe(1);
    const read = await service.getDocumentMetadata(actor("user-1"), WS_A, DOC_A);
    expect(read?.fields).toEqual({ title: "Second" });
  });

  it("replaces rather than merges, so a field can be cleared", async () => {
    const { service } = harness();
    await service.setDocumentMetadata(actor("user-1"), WS_A, DOC_A, {
      title: "Contract",
      author: "Ada",
    });
    await service.setDocumentMetadata(actor("user-1"), WS_A, DOC_A, { title: "Contract" });
    const read = await service.getDocumentMetadata(actor("user-1"), WS_A, DOC_A);
    expect(read?.fields).toEqual({ title: "Contract" });
  });

  it("reports an unsupported field rather than silently dropping it", async () => {
    const { service } = harness();
    await expect(
      service.setDocumentMetadata(actor("user-1"), WS_A, DOC_A, {
        title: "Contract",
        secretFlag: "true",
      }),
    ).rejects.toThrow(/not supported.*secretFlag/i);
  });

  it("rejects a value that exceeds its bound", async () => {
    const { service } = harness();
    await expect(
      service.setDocumentMetadata(actor("user-1"), WS_A, DOC_A, {
        title: "x".repeat(METADATA_LIMITS.maxValueLength + 1),
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("rejects a value carrying a control character", async () => {
    const { service } = harness();
    await expect(
      service.setDocumentMetadata(actor("user-1"), WS_A, DOC_A, {
        title: `Contract${String.fromCharCode(0)}`,
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("keeps two documents' properties apart", async () => {
    const { service } = harness();
    await service.setDocumentMetadata(actor("user-1"), WS_A, DOC_A, { title: "A" });
    await service.setDocumentMetadata(actor("user-1"), WS_A, DOC_A2, { title: "B" });
    const a = await service.getDocumentMetadata(actor("user-1"), WS_A, DOC_A);
    const b = await service.getDocumentMetadata(actor("user-1"), WS_A, DOC_A2);
    expect(a?.fields.title).toBe("A");
    expect(b?.fields.title).toBe("B");
  });

  it("accepts a compare-and-swap replace at the current revision", async () => {
    const { service } = harness();
    const saved = await service.setDocumentMetadata(actor("user-1"), WS_A, DOC_A, {
      title: "First",
    });
    const updated = await service.replaceDocumentMetadata(
      actor("user-1"),
      WS_A,
      DOC_A,
      saved.revision,
      { title: "Second" },
    );
    expect(updated.fields.title).toBe("Second");
    expect(updated.revision).toBe(saved.revision + 1);
  });

  it("refuses a compare-and-swap replace at a stale revision", async () => {
    const { service } = harness();
    const saved = await service.setDocumentMetadata(actor("user-1"), WS_A, DOC_A, {
      title: "First",
    });
    await service.setDocumentMetadata(actor("user-1"), WS_A, DOC_A, { title: "Second" });
    await expect(
      service.replaceDocumentMetadata(actor("user-1"), WS_A, DOC_A, saved.revision, {
        title: "Third",
      }),
    ).rejects.toThrow(/changed since/i);
  });

  it("reports a missing row and a stale revision the same way", async () => {
    const { service } = harness();
    // No metadata row exists at all. The conflict message must match the stale
    // one, so a caller cannot use the difference to learn whether a document
    // has properties.
    await expect(
      service.replaceDocumentMetadata(actor("user-1"), WS_A, DOC_A, 1, { title: "x" }),
    ).rejects.toThrow(/changed since/i);
  });

  it("rejects a non-positive expected revision", async () => {
    const { service } = harness();
    await service.setDocumentMetadata(actor("user-1"), WS_A, DOC_A, { title: "First" });
    await expect(
      service.replaceDocumentMetadata(actor("user-1"), WS_A, DOC_A, 0, { title: "x" }),
    ).rejects.toThrow(/expected revision/i);
  });

  it("records who last changed the properties", async () => {
    const { service } = harness();
    await service.setDocumentMetadata(actor("user-1"), WS_A, DOC_A, { title: "First" });
    const updated = await service.setDocumentMetadata(actor("user-2"), WS_A, DOC_A, {
      title: "Second",
    });
    expect(updated.createdById).toBe("user-1");
    expect(updated.updatedById).toBe("user-2");
  });
});

describe("MetadataService — embedded capability reporting", () => {
  it("reports embedded structures as uninspected rather than as absent", async () => {
    const { service } = harness();
    const properties = await service.getDocumentProperties(actor("user-1"), WS_A, DOC_A);
    expect(properties.embedded.inspected).toBe(false);
    expect(properties.embedded.parsed).toBe(false);
    expect(properties.embedded.limitations.length).toBeGreaterThan(0);
  });

  it("reports no embedded write capability in this build", async () => {
    const { service } = harness();
    const properties = await service.getDocumentProperties(actor("user-1"), WS_A, DOC_A);
    expect(properties.embedded.writable).toEqual({
      metadata: false,
      outline: false,
      attachments: false,
    });
  });

  it("does not claim a document is signed, only whether a signature is present", async () => {
    const { service } = harness();
    const properties = await service.getDocumentProperties(actor("user-1"), WS_A, DOC_A);
    expect(properties.embedded.signaturePresent).toBe(false);
    expect(Object.keys(properties.embedded)).not.toContain("signed");
    expect(Object.keys(properties.embedded)).not.toContain("signatureValid");
  });

  it("does not fabricate counts for structures it never parsed", async () => {
    const { service } = harness();
    const properties = await service.getDocumentProperties(actor("user-1"), WS_A, DOC_A);
    expect(properties.embedded.found).toEqual({
      metadataFields: 0,
      outlineItems: 0,
      attachments: 0,
    });
  });

  it("assembles real counts and quota usage for the panel", async () => {
    const { service } = harness();
    await service.setDocumentMetadata(actor("user-1"), WS_A, DOC_A, { title: "T" });
    await service.createBookmark(actor("user-1"), WS_A, DOC_A, { pageNumber: 1, title: "B" });
    await service.createOutlineItem(actor("user-1"), WS_A, DOC_A, {
      title: "Intro",
      pageNumber: 1,
    });
    await service.createAttachment(actor("user-1"), WS_A, DOC_A, {
      name: "note.txt",
      mimeType: "text/plain",
      data: Buffer.from("hello"),
    });

    const properties = await service.getDocumentProperties(actor("user-1"), WS_A, DOC_A);
    expect(properties.counts).toEqual({ bookmarks: 1, outlineItems: 1, attachments: 1 });
    expect(properties.metadata?.fields.title).toBe("T");
    expect(properties.attachmentBytes.used).toBe(5);
    expect(properties.attachmentBytes.limit).toBe(METADATA_LIMITS.maxAttachmentTotalBytes);
  });
});

describe("MetadataService — bookmarks", () => {
  it("creates a bookmark with a validated page and title", async () => {
    const { service } = harness();
    const bookmark = await service.createBookmark(actor("user-1"), WS_A, DOC_A, {
      pageNumber: 3,
      title: "  Key clause  ",
      note: "Read this",
      anchor: { x: 0.5, y: 0.25 },
    });
    expect(bookmark.pageNumber).toBe(3);
    expect(bookmark.title).toBe("Key clause");
    expect(bookmark.note).toBe("Read this");
    expect(bookmark.anchor).toEqual({ x: 0.5, y: 0.25 });
    expect(bookmark.createdById).toBe("user-1");
  });

  it("refuses a page number below 1", async () => {
    const { service } = harness();
    await expect(
      service.createBookmark(actor("user-1"), WS_A, DOC_A, { pageNumber: 0, title: "x" }),
    ).rejects.toThrow(/page number/i);
  });

  it("refuses an empty title", async () => {
    const { service } = harness();
    await expect(
      service.createBookmark(actor("user-1"), WS_A, DOC_A, { pageNumber: 1, title: "   " }),
    ).rejects.toThrow(/title is required/i);
  });

  it("refuses an anchor outside the page", async () => {
    const { service } = harness();
    await expect(
      service.createBookmark(actor("user-1"), WS_A, DOC_A, {
        pageNumber: 1,
        title: "x",
        anchor: { x: 100, y: 200 },
      }),
    ).rejects.toThrow(/within the page/i);
  });

  it("treats an absent anchor as a whole-page bookmark", async () => {
    const { service } = harness();
    const bookmark = await service.createBookmark(actor("user-1"), WS_A, DOC_A, {
      pageNumber: 1,
      title: "x",
    });
    expect(bookmark.anchor).toBeNull();
  });

  it("lists bookmarks in a stable order", async () => {
    const { service } = harness();
    await service.createBookmark(actor("user-1"), WS_A, DOC_A, { pageNumber: 1, title: "first" });
    await service.createBookmark(actor("user-1"), WS_A, DOC_A, { pageNumber: 2, title: "second" });
    await service.createBookmark(actor("user-1"), WS_A, DOC_A, { pageNumber: 3, title: "third" });
    const listed = await service.listBookmarks(actor("user-1"), WS_A, DOC_A);
    expect(listed.map((b) => b.title)).toEqual(["first", "second", "third"]);
    const again = await service.listBookmarks(actor("user-1"), WS_A, DOC_A);
    expect(again.map((b) => b.id)).toEqual(listed.map((b) => b.id));
  });

  it("narrows a listing to one page", async () => {
    const { service } = harness();
    await service.createBookmark(actor("user-1"), WS_A, DOC_A, { pageNumber: 1, title: "p1" });
    await service.createBookmark(actor("user-1"), WS_A, DOC_A, { pageNumber: 2, title: "p2" });
    const listed = await service.listBookmarks(actor("user-1"), WS_A, DOC_A, { pageNumber: 2 });
    expect(listed.map((b) => b.title)).toEqual(["p2"]);
  });

  it("keeps two documents' bookmarks apart", async () => {
    const { service } = harness();
    await service.createBookmark(actor("user-1"), WS_A, DOC_A, { pageNumber: 1, title: "a" });
    await service.createBookmark(actor("user-1"), WS_A, DOC_A2, { pageNumber: 1, title: "b" });
    const listed = await service.listBookmarks(actor("user-1"), WS_A, DOC_A);
    expect(listed.map((b) => b.title)).toEqual(["a"]);
  });

  it("refuses to update a bookmark through a document that does not own it", async () => {
    const { service } = harness();
    const bookmark = await service.createBookmark(actor("user-1"), WS_A, DOC_A, {
      pageNumber: 1,
      title: "a",
    });
    // Same Workspace, wrong document: the id alone must not be enough.
    await expect(
      service.updateBookmark(actor("user-1"), WS_A, DOC_A2, bookmark.id, bookmark.revision, {
        title: "hijacked",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("updates only the fields supplied", async () => {
    const { service } = harness();
    const bookmark = await service.createBookmark(actor("user-1"), WS_A, DOC_A, {
      pageNumber: 1,
      title: "original",
      note: "keep me",
    });
    const updated = await service.updateBookmark(
      actor("user-1"),
      WS_A,
      DOC_A,
      bookmark.id,
      bookmark.revision,
      { title: "renamed" },
    );
    expect(updated.title).toBe("renamed");
    expect(updated.note).toBe("keep me");
    expect(updated.pageNumber).toBe(1);
  });

  it("clears a note when null is supplied explicitly", async () => {
    const { service } = harness();
    const bookmark = await service.createBookmark(actor("user-1"), WS_A, DOC_A, {
      pageNumber: 1,
      title: "x",
      note: "temporary",
    });
    const updated = await service.updateBookmark(
      actor("user-1"),
      WS_A,
      DOC_A,
      bookmark.id,
      bookmark.revision,
      { note: null },
    );
    expect(updated.note).toBeNull();
  });

  it("refuses an update at a stale revision", async () => {
    const { service } = harness();
    const bookmark = await service.createBookmark(actor("user-1"), WS_A, DOC_A, {
      pageNumber: 1,
      title: "x",
    });
    await service.updateBookmark(actor("user-1"), WS_A, DOC_A, bookmark.id, bookmark.revision, {
      title: "y",
    });
    await expect(
      service.updateBookmark(actor("user-1"), WS_A, DOC_A, bookmark.id, bookmark.revision, {
        title: "z",
      }),
    ).rejects.toThrow(/changed since/i);
  });

  it("deletes a bookmark", async () => {
    const { service } = harness();
    const bookmark = await service.createBookmark(actor("user-1"), WS_A, DOC_A, {
      pageNumber: 1,
      title: "x",
    });
    await expect(
      service.deleteBookmark(actor("user-1"), WS_A, DOC_A, bookmark.id),
    ).resolves.toBe(true);
    await expect(service.listBookmarks(actor("user-1"), WS_A, DOC_A)).resolves.toEqual([]);
  });

  it("enforces the per-document bookmark cap", async () => {
    const { service, bookmarks } = harness();
    for (let i = 0; i < METADATA_LIMITS.maxBookmarksPerDocument; i += 1) {
      await bookmarks.create({
        organizationId: ORG,
        workspaceId: WS_A,
        documentId: DOC_A,
        pageNumber: 1,
        title: `b${i}`,
        note: null,
        anchor: null,
        orderKey: `a${i}`,
        createdById: "user-1",
      });
    }
    await expect(
      service.createBookmark(actor("user-1"), WS_A, DOC_A, { pageNumber: 1, title: "one more" }),
    ).rejects.toThrow(/at most/i);
  });

  it("refuses a viewer's write", async () => {
    const { service } = harness();
    await expect(
      service.createBookmark(actor("viewer-1"), WS_A, DOC_A, { pageNumber: 1, title: "x" }),
    ).rejects.toThrow(/write access/i);
  });
});

describe("MetadataService — outline", () => {
  it("creates a root item at depth 0", async () => {
    const { service } = harness();
    const item = await service.createOutlineItem(actor("user-1"), WS_A, DOC_A, {
      title: "Introduction",
      pageNumber: 1,
    });
    expect(item.depth).toBe(0);
    expect(item.parentId).toBeNull();
    expect(item.origin).toBe("workspace");
  });

  it("derives a child's depth from its parent rather than from the caller", async () => {
    const { service } = harness();
    const parent = await service.createOutlineItem(actor("user-1"), WS_A, DOC_A, {
      title: "Chapter",
      pageNumber: 1,
    });
    const child = await service.createOutlineItem(actor("user-1"), WS_A, DOC_A, {
      title: "Section",
      pageNumber: 2,
      parentId: parent.id,
    });
    expect(child.depth).toBe(1);
    expect(child.parentId).toBe(parent.id);
  });

  it("refuses a parent belonging to another document", async () => {
    const { service } = harness();
    const parent = await service.createOutlineItem(actor("user-1"), WS_A, DOC_A, {
      title: "Chapter",
      pageNumber: 1,
    });
    await expect(
      service.createOutlineItem(actor("user-1"), WS_A, DOC_A2, {
        title: "Section",
        pageNumber: 1,
        parentId: parent.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses to nest a workspace item under an embedded one", async () => {
    const { service, outline } = harness();
    const embedded = await outline.create({
      organizationId: ORG,
      workspaceId: WS_A,
      documentId: DOC_A,
      parentId: null,
      title: "PDF chapter",
      pageNumber: 1,
      depth: 0,
      orderKey: "a0",
      origin: "embedded",
      createdById: "user-1",
    });
    await expect(
      service.createOutlineItem(actor("user-1"), WS_A, DOC_A, {
        title: "mine",
        pageNumber: 2,
        parentId: embedded.id,
      }),
    ).rejects.toThrow(/read-only/i);
  });

  it("refuses nesting deeper than the depth bound", async () => {
    const { service } = harness();
    let parentId: string | undefined;
    for (let depth = 0; depth <= METADATA_LIMITS.maxOutlineDepth; depth += 1) {
      const created = await service.createOutlineItem(actor("user-1"), WS_A, DOC_A, {
        title: `level ${depth}`,
        pageNumber: 1,
        parentId,
      });
      parentId = created.id;
    }
    await expect(
      service.createOutlineItem(actor("user-1"), WS_A, DOC_A, {
        title: "too deep",
        pageNumber: 1,
        parentId,
      }),
    ).rejects.toThrow(/levels deep/i);
  });

  it("assembles a tree with children nested under parents", async () => {
    const { service } = harness();
    const parent = await service.createOutlineItem(actor("user-1"), WS_A, DOC_A, {
      title: "Chapter",
      pageNumber: 1,
    });
    await service.createOutlineItem(actor("user-1"), WS_A, DOC_A, {
      title: "Section",
      pageNumber: 2,
      parentId: parent.id,
    });
    const tree = await service.getOutlineTree(actor("user-1"), WS_A, DOC_A);
    expect(tree).toHaveLength(1);
    expect(tree[0].title).toBe("Chapter");
    expect(tree[0].children.map((node) => node.title)).toEqual(["Section"]);
  });

  it("refuses to edit an embedded outline item", async () => {
    const { service, outline } = harness();
    const embedded = await outline.create({
      organizationId: ORG,
      workspaceId: WS_A,
      documentId: DOC_A,
      parentId: null,
      title: "PDF chapter",
      pageNumber: 1,
      depth: 0,
      orderKey: "a0",
      origin: "embedded",
      createdById: "user-1",
    });
    await expect(
      service.updateOutlineItem(actor("user-1"), WS_A, DOC_A, embedded.id, embedded.revision, {
        title: "renamed",
      }),
    ).rejects.toThrow(/part of the PDF file/i);
  });

  it("refuses to delete an embedded outline item", async () => {
    const { service, outline } = harness();
    const embedded = await outline.create({
      organizationId: ORG,
      workspaceId: WS_A,
      documentId: DOC_A,
      parentId: null,
      title: "PDF chapter",
      pageNumber: 1,
      depth: 0,
      orderKey: "a0",
      origin: "embedded",
      createdById: "user-1",
    });
    await expect(
      service.deleteOutlineItem(actor("user-1"), WS_A, DOC_A, embedded.id),
    ).rejects.toThrow(/part of the PDF file/i);
  });

  it("says why an embedded edit was refused rather than failing silently", async () => {
    const { service, outline } = harness();
    const embedded = await outline.create({
      organizationId: ORG,
      workspaceId: WS_A,
      documentId: DOC_A,
      parentId: null,
      title: "PDF chapter",
      pageNumber: 1,
      depth: 0,
      orderKey: "a0",
      origin: "embedded",
      createdById: "user-1",
    });
    await expect(
      service.updateOutlineItem(actor("user-1"), WS_A, DOC_A, embedded.id, embedded.revision, {
        title: "renamed",
      }),
    ).rejects.toThrow(/rewriting the document/i);
    // And the item is untouched, not partially applied.
    const unchanged = await outline.getById(WS_A, embedded.id);
    expect(unchanged?.title).toBe("PDF chapter");
  });

  it("deletes an item together with its descendants", async () => {
    const { service } = harness();
    const parent = await service.createOutlineItem(actor("user-1"), WS_A, DOC_A, {
      title: "Chapter",
      pageNumber: 1,
    });
    const child = await service.createOutlineItem(actor("user-1"), WS_A, DOC_A, {
      title: "Section",
      pageNumber: 2,
      parentId: parent.id,
    });
    await service.createOutlineItem(actor("user-1"), WS_A, DOC_A, {
      title: "Subsection",
      pageNumber: 3,
      parentId: child.id,
    });
    const removed = await service.deleteOutlineItem(actor("user-1"), WS_A, DOC_A, parent.id);
    expect(removed).toBe(3);
    await expect(service.listOutline(actor("user-1"), WS_A, DOC_A)).resolves.toEqual([]);
  });

  it("leaves a sibling subtree alone when deleting", async () => {
    const { service } = harness();
    const first = await service.createOutlineItem(actor("user-1"), WS_A, DOC_A, {
      title: "First",
      pageNumber: 1,
    });
    await service.createOutlineItem(actor("user-1"), WS_A, DOC_A, {
      title: "First child",
      pageNumber: 2,
      parentId: first.id,
    });
    const second = await service.createOutlineItem(actor("user-1"), WS_A, DOC_A, {
      title: "Second",
      pageNumber: 3,
    });
    await service.deleteOutlineItem(actor("user-1"), WS_A, DOC_A, second.id);
    const remaining = await service.listOutline(actor("user-1"), WS_A, DOC_A);
    expect(remaining.map((item) => item.title)).toEqual(["First", "First child"]);
  });

  it("narrows a listing to one origin", async () => {
    const { service, outline } = harness();
    await service.createOutlineItem(actor("user-1"), WS_A, DOC_A, {
      title: "Mine",
      pageNumber: 1,
    });
    await outline.create({
      organizationId: ORG,
      workspaceId: WS_A,
      documentId: DOC_A,
      parentId: null,
      title: "Theirs",
      pageNumber: 1,
      depth: 0,
      orderKey: "z0",
      origin: "embedded",
      createdById: "user-1",
    });
    const workspaceOnly = await service.listOutline(actor("user-1"), WS_A, DOC_A, {
      origin: "workspace",
    });
    expect(workspaceOnly.map((item) => item.title)).toEqual(["Mine"]);
    const embeddedOnly = await service.listOutline(actor("user-1"), WS_A, DOC_A, {
      origin: "embedded",
    });
    expect(embeddedOnly.map((item) => item.title)).toEqual(["Theirs"]);
  });
});

describe("MetadataService — attachments", () => {
  it("stores bytes and records the size and checksum it computed", async () => {
    const { service, storage } = harness();
    const attachment = await service.createAttachment(actor("user-1"), WS_A, DOC_A, {
      name: "notes.txt",
      mimeType: "text/plain",
      data: Buffer.from("hello world"),
    });
    expect(attachment.byteSize).toBe(11);
    expect(attachment.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(attachment.origin).toBe("workspace");
    expect(storage.puts).toHaveLength(1);
  });

  it("does not trust a client-declared size", async () => {
    const { service } = harness();
    const attachment = await service.createAttachment(actor("user-1"), WS_A, DOC_A, {
      name: "notes.txt",
      mimeType: "text/plain",
      // A "size" field is not part of the input at all — the byte count comes
      // from the bytes. This asserts the recorded size matches reality.
      data: Buffer.from("1234567890"),
    });
    expect(attachment.byteSize).toBe(10);
  });

  it("refuses an empty attachment", async () => {
    const { service } = harness();
    await expect(
      service.createAttachment(actor("user-1"), WS_A, DOC_A, {
        name: "empty.txt",
        mimeType: "text/plain",
        data: Buffer.alloc(0),
      }),
    ).rejects.toThrow(/must not be empty/i);
  });

  it("refuses an attachment over the single-file bound", async () => {
    const { service } = harness({ maxAttachmentBytes: 8 });
    await expect(
      service.createAttachment(actor("user-1"), WS_A, DOC_A, {
        name: "big.bin",
        mimeType: "application/octet-stream",
        data: Buffer.alloc(9),
      }),
    ).rejects.toThrow(/at most 8 bytes/i);
  });

  it("refuses an attachment that would exceed the per-document quota", async () => {
    const { service } = harness({ maxAttachmentTotalBytes: 10 });
    await service.createAttachment(actor("user-1"), WS_A, DOC_A, {
      name: "a.bin",
      mimeType: "application/octet-stream",
      data: Buffer.alloc(6),
    });
    await expect(
      service.createAttachment(actor("user-1"), WS_A, DOC_A, {
        name: "b.bin",
        mimeType: "application/octet-stream",
        data: Buffer.alloc(6),
      }),
    ).rejects.toThrow(/exceed/i);
  });

  it("does not let a configured option widen the domain quota", async () => {
    const { service } = harness({
      maxAttachmentTotalBytes: METADATA_LIMITS.maxAttachmentTotalBytes * 10,
    });
    const properties = await service.getDocumentProperties(actor("user-1"), WS_A, DOC_A);
    expect(properties.attachmentBytes.limit).toBe(METADATA_LIMITS.maxAttachmentTotalBytes);
  });

  it("refuses a name containing a path separator", async () => {
    const { service } = harness();
    await expect(
      service.createAttachment(actor("user-1"), WS_A, DOC_A, {
        name: "../../etc/passwd",
        mimeType: "text/plain",
        data: Buffer.from("x"),
      }),
    ).rejects.toThrow(/path separators/i);
  });

  it("refuses a malformed content type", async () => {
    const { service } = harness();
    await expect(
      service.createAttachment(actor("user-1"), WS_A, DOC_A, {
        name: "x.txt",
        mimeType: "text/plain\r\nX-Injected: 1",
        data: Buffer.from("x"),
      }),
    ).rejects.toThrow(/content type/i);
  });

  it("refuses a duplicate name on the same document", async () => {
    const { service } = harness();
    await service.createAttachment(actor("user-1"), WS_A, DOC_A, {
      name: "notes.txt",
      mimeType: "text/plain",
      data: Buffer.from("a"),
    });
    await expect(
      service.createAttachment(actor("user-1"), WS_A, DOC_A, {
        name: "NOTES.TXT",
        mimeType: "text/plain",
        data: Buffer.from("b"),
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it("allows the same name on two different documents", async () => {
    const { service } = harness();
    await service.createAttachment(actor("user-1"), WS_A, DOC_A, {
      name: "notes.txt",
      mimeType: "text/plain",
      data: Buffer.from("a"),
    });
    await expect(
      service.createAttachment(actor("user-1"), WS_A, DOC_A2, {
        name: "notes.txt",
        mimeType: "text/plain",
        data: Buffer.from("b"),
      }),
    ).resolves.toMatchObject({ name: "notes.txt" });
  });

  it("streams the bytes back on download", async () => {
    const { service } = harness();
    const created = await service.createAttachment(actor("user-1"), WS_A, DOC_A, {
      name: "notes.txt",
      mimeType: "text/plain",
      data: Buffer.from("hello world"),
    });
    const download = await service.getAttachmentDownload(
      actor("user-2"),
      WS_A,
      DOC_A,
      created.id,
    );
    expect(download.byteSize).toBe(11);
    expect((await drain(download.stream)).toString("utf8")).toBe("hello world");
  });

  it("serves an unlisted type as an opaque download", async () => {
    const { service } = harness();
    const created = await service.createAttachment(actor("user-1"), WS_A, DOC_A, {
      name: "page.html",
      mimeType: "text/html",
      data: Buffer.from("<script>alert(1)</script>"),
    });
    const download = await service.getAttachmentDownload(
      actor("user-1"),
      WS_A,
      DOC_A,
      created.id,
    );
    // Stored as declared, served as octet-stream: an attachment must not be
    // able to execute on our own origin.
    expect(created.mimeType).toBe("text/html");
    expect(download.contentType).toBe("application/octet-stream");
  });

  it("keeps a PDF's own content type", async () => {
    const { service } = harness();
    const created = await service.createAttachment(actor("user-1"), WS_A, DOC_A, {
      name: "related.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("%PDF-1.7"),
    });
    const download = await service.getAttachmentDownload(
      actor("user-1"),
      WS_A,
      DOC_A,
      created.id,
    );
    expect(download.contentType).toBe("application/pdf");
  });

  it("builds a Content-Disposition that cannot break the header", async () => {
    const { service } = harness();
    const created = await service.createAttachment(actor("user-1"), WS_A, DOC_A, {
      name: "Rapport été.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("%PDF-1.7"),
    });
    const download = await service.getAttachmentDownload(
      actor("user-1"),
      WS_A,
      DOC_A,
      created.id,
    );
    expect(download.contentDisposition).toBe(
      `attachment; filename="Rapport _t_.pdf"; filename*=UTF-8''Rapport%20%C3%A9t%C3%A9.pdf`,
    );
    expect(download.contentDisposition).not.toMatch(/[\r\n]/u);
  });

  it("always serves as an attachment, never inline", async () => {
    const { service } = harness();
    const created = await service.createAttachment(actor("user-1"), WS_A, DOC_A, {
      name: "image.png",
      mimeType: "image/png",
      data: Buffer.from("PNG"),
    });
    const download = await service.getAttachmentDownload(
      actor("user-1"),
      WS_A,
      DOC_A,
      created.id,
    );
    expect(download.contentDisposition.startsWith("attachment;")).toBe(true);
  });

  it("refuses to download an attachment through another document", async () => {
    const { service } = harness();
    const created = await service.createAttachment(actor("user-1"), WS_A, DOC_A, {
      name: "notes.txt",
      mimeType: "text/plain",
      data: Buffer.from("secret"),
    });
    await expect(
      service.getAttachmentDownload(actor("user-1"), WS_A, DOC_A2, created.id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("says an embedded attachment was never extracted rather than reporting it missing", async () => {
    const { service, attachments } = harness();
    const catalogued = await attachments.create({
      organizationId: ORG,
      workspaceId: WS_A,
      documentId: DOC_A,
      storedFileId: null,
      origin: "embedded",
      name: "inside.pdf",
      normalizedName: "inside.pdf",
      description: null,
      mimeType: "application/pdf",
      byteSize: 1024,
      checksum: "",
      createdById: "user-1",
    });
    await expect(
      service.getAttachmentDownload(actor("user-1"), WS_A, DOC_A, catalogued.id),
    ).rejects.toThrow(/not been extracted/i);
  });

  it("refuses to rename an embedded attachment", async () => {
    const { service, attachments } = harness();
    const catalogued = await attachments.create({
      organizationId: ORG,
      workspaceId: WS_A,
      documentId: DOC_A,
      storedFileId: null,
      origin: "embedded",
      name: "inside.pdf",
      normalizedName: "inside.pdf",
      description: null,
      mimeType: "application/pdf",
      byteSize: 1024,
      checksum: "",
      createdById: "user-1",
    });
    await expect(
      service.updateAttachment(
        actor("user-1"),
        WS_A,
        DOC_A,
        catalogued.id,
        catalogued.revision,
        { name: "renamed.pdf" },
      ),
    ).rejects.toThrow(/part of the PDF file/i);
  });

  it("refuses to delete an embedded attachment", async () => {
    const { service, attachments } = harness();
    const catalogued = await attachments.create({
      organizationId: ORG,
      workspaceId: WS_A,
      documentId: DOC_A,
      storedFileId: null,
      origin: "embedded",
      name: "inside.pdf",
      normalizedName: "inside.pdf",
      description: null,
      mimeType: "application/pdf",
      byteSize: 1024,
      checksum: "",
      createdById: "user-1",
    });
    await expect(
      service.deleteAttachment(actor("user-1"), WS_A, DOC_A, catalogued.id),
    ).rejects.toThrow(/part of the PDF file/i);
  });

  it("renames a workspace attachment", async () => {
    const { service } = harness();
    const created = await service.createAttachment(actor("user-1"), WS_A, DOC_A, {
      name: "old.txt",
      mimeType: "text/plain",
      data: Buffer.from("x"),
    });
    const updated = await service.updateAttachment(
      actor("user-1"),
      WS_A,
      DOC_A,
      created.id,
      created.revision,
      { name: "new.txt", description: "renamed" },
    );
    expect(updated.name).toBe("new.txt");
    expect(updated.normalizedName).toBe("new.txt");
    expect(updated.description).toBe("renamed");
  });

  it("refuses a rename onto an existing name", async () => {
    const { service } = harness();
    await service.createAttachment(actor("user-1"), WS_A, DOC_A, {
      name: "taken.txt",
      mimeType: "text/plain",
      data: Buffer.from("a"),
    });
    const other = await service.createAttachment(actor("user-1"), WS_A, DOC_A, {
      name: "free.txt",
      mimeType: "text/plain",
      data: Buffer.from("b"),
    });
    await expect(
      service.updateAttachment(actor("user-1"), WS_A, DOC_A, other.id, other.revision, {
        name: "taken.txt",
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it("deletes the record and its stored-file row", async () => {
    const { service, files } = harness();
    const created = await service.createAttachment(actor("user-1"), WS_A, DOC_A, {
      name: "notes.txt",
      mimeType: "text/plain",
      data: Buffer.from("x"),
    });
    const record = await service.listAttachments(actor("user-1"), WS_A, DOC_A);
    const storedFileId = record[0].storedFileId;
    expect(storedFileId).not.toBeNull();

    await expect(
      service.deleteAttachment(actor("user-1"), WS_A, DOC_A, created.id),
    ).resolves.toBe(true);
    await expect(service.listAttachments(actor("user-1"), WS_A, DOC_A)).resolves.toEqual([]);
    await expect(files.get(storedFileId as string)).resolves.toBeNull();
  });

  it("enforces the per-document attachment count cap", async () => {
    const { service, attachments } = harness();
    for (let i = 0; i < METADATA_LIMITS.maxAttachmentsPerDocument; i += 1) {
      await attachments.create({
        organizationId: ORG,
        workspaceId: WS_A,
        documentId: DOC_A,
        storedFileId: null,
        origin: "workspace",
        name: `file-${i}.txt`,
        normalizedName: `file-${i}.txt`,
        description: null,
        mimeType: "text/plain",
        byteSize: 1,
        checksum: "",
        createdById: "user-1",
      });
    }
    await expect(
      service.createAttachment(actor("user-1"), WS_A, DOC_A, {
        name: "one-more.txt",
        mimeType: "text/plain",
        data: Buffer.from("x"),
      }),
    ).rejects.toThrow(/at most/i);
  });

  it("refuses a viewer's upload", async () => {
    const { service } = harness();
    await expect(
      service.createAttachment(actor("viewer-1"), WS_A, DOC_A, {
        name: "x.txt",
        mimeType: "text/plain",
        data: Buffer.from("x"),
      }),
    ).rejects.toThrow(/write access/i);
  });
});

describe("MetadataService — indexable content", () => {
  it("collects metadata, bookmarks, outline titles and attachment names", async () => {
    const { service } = harness();
    await service.setDocumentMetadata(actor("user-1"), WS_A, DOC_A, {
      title: "Quarterly Contract",
      author: "Ada",
    });
    await service.createBookmark(actor("user-1"), WS_A, DOC_A, {
      pageNumber: 1,
      title: "Key clause",
      note: "renewal terms",
    });
    await service.createOutlineItem(actor("user-1"), WS_A, DOC_A, {
      title: "Introduction",
      pageNumber: 1,
    });
    await service.createAttachment(actor("user-1"), WS_A, DOC_A, {
      name: "appendix.txt",
      mimeType: "text/plain",
      data: Buffer.from("x"),
    });

    const segments = await service.collectIndexableContent(actor("user-1"), WS_A, DOC_A);
    const joined = segments.map((segment) => segment.text).join(" | ");
    expect(joined).toContain("Quarterly Contract");
    expect(joined).toContain("Key clause");
    expect(joined).toContain("renewal terms");
    expect(joined).toContain("Introduction");
    expect(joined).toContain("appendix.txt");
  });

  it("uses only source types the search index knows", async () => {
    const { service } = harness();
    await service.createBookmark(actor("user-1"), WS_A, DOC_A, { pageNumber: 1, title: "b" });
    await service.createOutlineItem(actor("user-1"), WS_A, DOC_A, { title: "o", pageNumber: 1 });
    const segments = await service.collectIndexableContent(actor("user-1"), WS_A, DOC_A);
    for (const segment of segments) {
      expect(["metadata", "bookmark", "outline"]).toContain(segment.sourceType);
    }
  });

  it("returns nothing for a document with no metadata of any kind", async () => {
    const { service } = harness();
    await expect(
      service.collectIndexableContent(actor("user-1"), WS_A, DOC_A),
    ).resolves.toEqual([]);
  });

  it("does not index attachment contents, only their names", async () => {
    const { service } = harness();
    await service.createAttachment(actor("user-1"), WS_A, DOC_A, {
      name: "secret.txt",
      mimeType: "text/plain",
      data: Buffer.from("CLASSIFIED PAYLOAD"),
    });
    const segments = await service.collectIndexableContent(actor("user-1"), WS_A, DOC_A);
    const joined = segments.map((segment) => segment.text).join(" ");
    expect(joined).toContain("secret.txt");
    expect(joined).not.toContain("CLASSIFIED PAYLOAD");
  });

  it("requires authorization before collecting anything", async () => {
    const { service } = harness();
    await expect(
      service.collectIndexableContent(actor("stranger"), WS_A, DOC_A),
    ).rejects.toThrow(/not a member/i);
  });
});
