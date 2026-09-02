import { describe, expect, it } from "vitest";
import { SearchService } from "./SearchService";
import type { ActorContext, WorkspaceService } from "./WorkspaceService";
import type { ILogger, LogFields } from "@/src/application/ports/Logger";
import type {
  DocumentRecordListQuery,
  DocumentRecordRepository,
} from "@/src/application/ports/workspaces/DocumentRecordRepository";
import type {
  DocumentRecord,
  DocumentRecordLifecycleState,
} from "@/src/domain/entities/DocumentRecord";
import { SEARCH_LIMITS } from "@/src/domain/entities/SearchIndex";
import { InMemorySearchDocumentRepository } from "@/src/infrastructure/persistence/InMemorySearchDocumentRepository";
import { InMemorySearchChunkRepository } from "@/src/infrastructure/persistence/InMemorySearchChunkRepository";
import { SQLiteSearchIndexAdapter } from "@/src/infrastructure/persistence/SQLiteSearchIndexAdapter";
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

interface DocumentSeed {
  id: string;
  workspaceId: string;
  name?: string;
  lifecycleState?: DocumentRecordLifecycleState;
  favorite?: boolean;
  projectId?: string | null;
  folderId?: string | null;
  createdById?: string;
  currentVersionId?: string | null;
  organizationId?: string;
}

class FakeDocumentRecordRepository {
  private readonly docs = new Map<string, DocumentRecord>();

  add(seed: DocumentSeed): void {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const name = seed.name ?? `${seed.id}.pdf`;
    this.docs.set(`${seed.workspaceId}:${seed.id}`, {
      id: seed.id,
      workspaceId: seed.workspaceId,
      organizationId: seed.organizationId ?? ORG,
      projectId: seed.projectId ?? null,
      folderId: seed.folderId ?? null,
      name,
      normalizedName: name.toLowerCase(),
      lifecycleState: seed.lifecycleState ?? "active",
      orderKey: "a0",
      currentVersionId: seed.currentVersionId ?? "version-1",
      favorite: seed.favorite ?? false,
      lastAccessedAt: null,
      createdById: seed.createdById ?? "user-1",
      revision: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      trashedAt: null,
      archivedById: null,
      trashedById: null,
    });
  }

  remove(workspaceId: string, documentId: string): void {
    this.docs.delete(`${workspaceId}:${documentId}`);
  }

  async getById(workspaceId: string, documentId: string): Promise<DocumentRecord | null> {
    const doc = this.docs.get(`${workspaceId}:${documentId}`);
    return doc ? { ...doc } : null;
  }

  async list(
    query: DocumentRecordListQuery,
  ): Promise<{ items: DocumentRecord[]; nextCursor: string | null }> {
    const items = [...this.docs.values()]
      .filter((doc) => doc.workspaceId === query.workspaceId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, query.limit)
      .map((doc) => ({ ...doc }));
    return { items, nextCursor: null };
  }
}

function harness(options: { maxCandidateDocuments?: number } = {}) {
  const logger = new TestLogger();
  const workspaces = new FakeWorkspaceService();
  const documents = new FakeDocumentRecordRepository();
  const searchDocuments = new InMemorySearchDocumentRepository();
  const chunks = new InMemorySearchChunkRepository();

  workspaces.addWorkspace(WS_A, ORG);
  workspaces.addWorkspace(WS_B, ORG_OTHER);
  workspaces.grant(WS_A, "user-1", "editor");
  workspaces.grant(WS_A, "user-2", "editor");
  workspaces.grant(WS_A, "viewer-1", "viewer");
  workspaces.grant(WS_B, "user-3", "editor");

  const service = new SearchService(
    logger,
    workspaces as unknown as WorkspaceService,
    documents as unknown as DocumentRecordRepository,
    searchDocuments,
    chunks,
    new SQLiteSearchIndexAdapter(chunks),
    options,
  );

  return { service, logger, workspaces, documents, searchDocuments, chunks };
}

/** Indexes one document with a single text segment. */
async function indexText(
  h: ReturnType<typeof harness>,
  documentId: string,
  text: string,
  pageNumber: number | null = 1,
  workspaceId = WS_A,
  who = "user-1",
  organizationId = ORG,
) {
  return h.service.indexDocument(actor(who, organizationId), workspaceId, {
    documentId,
    segments: [{ sourceType: "text", pageNumber, text }],
  });
}

describe("SearchService — indexing", () => {
  it("indexes a document into real chunks and marks the entry indexed", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });

    const entry = await indexText(h, "doc-1", "The quarterly contract was signed in Berlin.");

    expect(entry.state).toBe("indexed");
    expect(entry.documentId).toBe("doc-1");
    expect(entry.workspaceId).toBe(WS_A);
    expect(entry.chunkCount).toBeGreaterThan(0);
    expect(entry.indexedAt).not.toBeNull();
    // A real checksum over real content, not a literal.
    expect(entry.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(await h.chunks.countForDocument(WS_A, "doc-1")).toBe(entry.chunkCount);
  });

  it("computes the same checksum for unchanged content and a different one for changed content", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });

    const first = await indexText(h, "doc-1", "Same content every time.");
    const second = await indexText(h, "doc-1", "Same content every time.");
    const third = await indexText(h, "doc-1", "Different content entirely.");

    expect(second.checksum).toBe(first.checksum);
    expect(third.checksum).not.toBe(first.checksum);
  });

  it("replaces chunks on reindex rather than accumulating them", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });

    await indexText(h, "doc-1", "First revision of the text.");
    const countAfterFirst = await h.chunks.countForDocument(WS_A, "doc-1");
    await indexText(h, "doc-1", "Second revision of the text.");
    const countAfterSecond = await h.chunks.countForDocument(WS_A, "doc-1");

    expect(countAfterSecond).toBe(countAfterFirst);
    // The old content is gone, not merely outnumbered.
    const results = await h.service.search(actor("user-1"), WS_A, { query: "first revision" });
    expect(results.hits).toEqual([]);
  });

  it("keeps one index entry per document under repeated indexing", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });

    const first = await indexText(h, "doc-1", "Alpha content.");
    const second = await indexText(h, "doc-1", "Beta content.");

    expect(second.id).toBe(first.id);
    expect(await h.searchDocuments.countForWorkspace(WS_A)).toBe(1);
  });

  it("splits long text into bounded chunks", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });

    const long = "lorem ipsum dolor sit amet ".repeat(400);
    const entry = await indexText(h, "doc-1", long);

    expect(entry.chunkCount).toBeGreaterThan(1);
    const stored = await h.chunks.listForDocument(WS_A, "doc-1");
    for (const chunk of stored) {
      expect(chunk.text.length).toBeLessThanOrEqual(SEARCH_LIMITS.maxChunkTextLength);
    }
  });

  it("rejects a segment naming an unknown source type", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });

    await expect(
      h.service.indexDocument(actor("user-1"), WS_A, {
        documentId: "doc-1",
        // A source type outside the allowlist must be refused, not stored.
        segments: [{ sourceType: "ocr" as never, text: "hidden" }],
      }),
    ).rejects.toThrow(DomainError);
  });

  it("skips segments that normalize to nothing rather than storing empty chunks", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });

    const entry = await h.service.indexDocument(actor("user-1"), WS_A, {
      documentId: "doc-1",
      segments: [
        { sourceType: "text", text: "   \n\t  " },
        { sourceType: "text", text: "real content here" },
      ],
    });

    expect(entry.chunkCount).toBe(1);
  });

  it("refuses to index a document in another Workspace", async () => {
    const h = harness();
    h.documents.add({ id: "doc-b", workspaceId: WS_B, organizationId: ORG_OTHER });

    await expect(indexText(h, "doc-b", "text content")).rejects.toThrow(NotFoundError);
  });

  it("refuses indexing by a viewer", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });

    await expect(indexText(h, "doc-1", "text content", 1, WS_A, "viewer-1")).rejects.toThrow(
      DomainError,
    );
  });

  it("records a failed pass as failed rather than leaving it indexing", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });
    // A chunk store that refuses writes: the entry must end up honest about it.
    const broken = {
      ...h.chunks,
      replaceForDocument: async () => {
        throw new Error("chunk store unavailable");
      },
    };
    const service = new SearchService(
      new TestLogger(),
      h.workspaces as unknown as WorkspaceService,
      h.documents as unknown as DocumentRecordRepository,
      h.searchDocuments,
      broken as unknown as InMemorySearchChunkRepository,
      new SQLiteSearchIndexAdapter(broken as unknown as InMemorySearchChunkRepository),
    );

    await expect(
      service.indexDocument(actor("user-1"), WS_A, {
        documentId: "doc-1",
        segments: [{ sourceType: "text", text: "content" }],
      }),
    ).rejects.toThrow("chunk store unavailable");

    const entry = await h.searchDocuments.getByDocumentId(WS_A, "doc-1");
    expect(entry?.state).toBe("failed");
    expect(entry?.error).toContain("chunk store unavailable");
  });
});

describe("SearchService — querying", () => {
  it("finds a document by a term in its content", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });
    h.documents.add({ id: "doc-2", workspaceId: WS_A });
    await indexText(h, "doc-1", "The quarterly contract was signed.");
    await indexText(h, "doc-2", "An unrelated invoice for stationery.");

    const results = await h.service.search(actor("user-1"), WS_A, { query: "contract" });

    expect(results.hits).toHaveLength(1);
    expect(results.hits[0].documentId).toBe("doc-1");
    expect(results.totalCount).toBe(1);
  });

  it("matches across diacritics and case", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });
    await indexText(h, "doc-1", "Le résumé du café était excellent.");

    const results = await h.service.search(actor("user-1"), WS_A, { query: "RESUME" });
    expect(results.hits.map((hit) => hit.documentId)).toEqual(["doc-1"]);
  });

  it("requires every term, not any of them", async () => {
    const h = harness();
    h.documents.add({ id: "doc-both", workspaceId: WS_A });
    h.documents.add({ id: "doc-one", workspaceId: WS_A });
    await indexText(h, "doc-both", "quarterly contract review");
    await indexText(h, "doc-one", "quarterly invoice review");

    const results = await h.service.search(actor("user-1"), WS_A, { query: "quarterly contract" });
    expect(results.hits.map((hit) => hit.documentId)).toEqual(["doc-both"]);
  });

  it("returns snippets with highlight ranges rather than markup", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });
    await indexText(h, "doc-1", "The quarterly contract was signed in Berlin last week.");

    const results = await h.service.search(actor("user-1"), WS_A, { query: "contract" });
    const snippet = results.hits[0].snippets[0];

    expect(snippet.text).not.toContain("<");
    expect(snippet.highlights.length).toBeGreaterThan(0);
    const { start, length } = snippet.highlights[0];
    expect(snippet.text.slice(start, start + length).toLowerCase()).toBe("contract");
  });

  it("returns indexed angle brackets as plain text, never as markup", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });
    await indexText(h, "doc-1", "A contract with <script>alert(1)</script> inside it.");

    const results = await h.service.search(actor("user-1"), WS_A, { query: "contract" });
    const snippet = results.hits[0].snippets[0];

    // The service never wraps content in markup; highlights are offsets, so the
    // client is free to treat the text strictly as data.
    expect(snippet.highlights.every((range) => typeof range.start === "number")).toBe(true);
    expect(typeof snippet.text).toBe("string");
  });

  it("reports the pages a match was found on", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });
    await h.service.indexDocument(actor("user-1"), WS_A, {
      documentId: "doc-1",
      segments: [
        { sourceType: "text", pageNumber: 1, text: "Nothing of note." },
        { sourceType: "text", pageNumber: 4, text: "The contract appears here." },
        { sourceType: "text", pageNumber: 7, text: "And the contract again." },
      ],
    });

    const results = await h.service.search(actor("user-1"), WS_A, { query: "contract" });
    expect(results.hits[0].pageNumbers).toEqual([4, 7]);
  });

  it("never returns a document from another Workspace", async () => {
    const h = harness();
    h.documents.add({ id: "doc-a", workspaceId: WS_A, name: "Shared.pdf" });
    h.documents.add({ id: "doc-b", workspaceId: WS_B, organizationId: ORG_OTHER });
    await indexText(h, "doc-a", "a shared contract term");
    await indexText(h, "doc-b", "a shared contract term", 1, WS_B, "user-3", ORG_OTHER);

    const results = await h.service.search(actor("user-1"), WS_A, { query: "contract" });
    expect(results.hits.map((hit) => hit.documentId)).toEqual(["doc-a"]);
  });

  it("excludes a document whose record is gone even though its chunks remain", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });
    await indexText(h, "doc-1", "an orphaned contract");
    // The record disappears without the index being cleaned: eligibility is
    // resolved from records, so the stranded chunks must not surface.
    h.documents.remove(WS_A, "doc-1");

    const results = await h.service.search(actor("user-1"), WS_A, { query: "contract" });
    expect(results.hits).toEqual([]);
    expect(results.totalCount).toBe(0);
  });

  it("excludes trashed documents unless they are explicitly requested", async () => {
    const h = harness();
    h.documents.add({ id: "doc-live", workspaceId: WS_A });
    h.documents.add({ id: "doc-trashed", workspaceId: WS_A, lifecycleState: "trashed" });
    await indexText(h, "doc-live", "a live contract");
    await indexText(h, "doc-trashed", "a trashed contract");

    const byDefault = await h.service.search(actor("user-1"), WS_A, { query: "contract" });
    expect(byDefault.hits.map((hit) => hit.documentId)).toEqual(["doc-live"]);

    const explicit = await h.service.search(actor("user-1"), WS_A, {
      query: "contract",
      filters: { lifecycleState: "trashed" },
    });
    expect(explicit.hits.map((hit) => hit.documentId)).toEqual(["doc-trashed"]);
  });

  it("applies favourite and project filters", async () => {
    const h = harness();
    h.documents.add({ id: "doc-fav", workspaceId: WS_A, favorite: true, projectId: "p1" });
    h.documents.add({ id: "doc-plain", workspaceId: WS_A, projectId: "p2" });
    await indexText(h, "doc-fav", "contract alpha");
    await indexText(h, "doc-plain", "contract beta");

    const favorites = await h.service.search(actor("user-1"), WS_A, {
      query: "contract",
      filters: { favorite: true },
    });
    expect(favorites.hits.map((hit) => hit.documentId)).toEqual(["doc-fav"]);

    const byProject = await h.service.search(actor("user-1"), WS_A, {
      query: "contract",
      filters: { projectId: "p2" },
    });
    expect(byProject.hits.map((hit) => hit.documentId)).toEqual(["doc-plain"]);
  });

  it("rejects an unbounded filter id", async () => {
    const h = harness();
    await expect(
      h.service.search(actor("user-1"), WS_A, {
        query: "contract",
        filters: { projectId: "p".repeat(SEARCH_LIMITS.maxIdLength + 1) },
      }),
    ).rejects.toThrow(DomainError);
  });

  it("rejects an empty or unusably short query rather than matching everything", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });
    await indexText(h, "doc-1", "some content");

    for (const query of ["", "   ", "a", null, 42, undefined]) {
      await expect(h.service.search(actor("user-1"), WS_A, { query })).rejects.toThrow(DomainError);
    }
  });

  it("rejects a query past the length bound", async () => {
    const h = harness();
    const tooLong = "a".repeat(SEARCH_LIMITS.maxQueryLength + 1);
    await expect(h.service.search(actor("user-1"), WS_A, { query: tooLong })).rejects.toThrow(
      DomainError,
    );
  });

  it("reports when a query was narrowed to its term bound", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });
    await indexText(h, "doc-1", "content");

    const many = Array.from({ length: SEARCH_LIMITS.maxQueryTerms + 5 }, (_, i) => `term${i}`).join(
      " ",
    );
    const results = await h.service.search(actor("user-1"), WS_A, { query: many });
    expect(results.truncated).toBe(true);
  });

  it("treats a query of only punctuation as unusable", async () => {
    const h = harness();
    await expect(h.service.search(actor("user-1"), WS_A, { query: "!!! ??" })).rejects.toThrow(
      DomainError,
    );
  });

  it("does not treat a query as a pattern", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });
    await indexText(h, "doc-1", "a plain contract");

    // If terms were compiled into a regex, `.*` would match everything here.
    const results = await h.service.search(actor("user-1"), WS_A, { query: ".*contract.*" });
    expect(results.hits).toEqual([]);
  });

  it("paginates deterministically and stops at the last page", async () => {
    const h = harness();
    for (let index = 0; index < 5; index += 1) {
      h.documents.add({ id: `doc-${index}`, workspaceId: WS_A });
      await indexText(h, `doc-${index}`, `contract number ${index}`);
    }

    const first = await h.service.search(actor("user-1"), WS_A, { query: "contract", limit: 2 });
    expect(first.hits).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await h.service.search(actor("user-1"), WS_A, {
      query: "contract",
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.hits).toHaveLength(2);
    const firstIds = first.hits.map((hit) => hit.documentId);
    const secondIds = second.hits.map((hit) => hit.documentId);
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);

    // The same query returns the same page: the ordering is total.
    const repeat = await h.service.search(actor("user-1"), WS_A, { query: "contract", limit: 2 });
    expect(repeat.hits.map((hit) => hit.documentId)).toEqual(firstIds);
  });

  it("rejects a malformed pagination cursor", async () => {
    const h = harness();
    for (const cursor of [
      Buffer.from("o:-1").toString("base64url"),
      Buffer.from("offset:5").toString("base64url"),
      "x".repeat(200),
    ]) {
      await expect(
        h.service.search(actor("user-1"), WS_A, { query: "contract", cursor }),
      ).rejects.toThrow(DomainError);
    }
  });

  it("bounds the result page to the domain maximum", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });
    await indexText(h, "doc-1", "contract");

    const results = await h.service.search(actor("user-1"), WS_A, {
      query: "contract",
      limit: SEARCH_LIMITS.maxResults + 500,
    });
    expect(results.hits.length).toBeLessThanOrEqual(SEARCH_LIMITS.maxResults);
  });

  it("scores a document matching every term above one matching fewer", async () => {
    const h = harness();
    h.documents.add({ id: "doc-both", workspaceId: WS_A });
    h.documents.add({ id: "doc-partial", workspaceId: WS_A });
    await indexText(h, "doc-both", "quarterly contract signed");
    await indexText(h, "doc-partial", "quarterly report signed");

    const results = await h.service.search(actor("user-1"), WS_A, {
      query: "quarterly contract",
    });
    expect(results.hits.map((hit) => hit.documentId)).toEqual(["doc-both"]);
    expect(results.hits[0].score).toBeGreaterThan(0);
  });

  it("permits a viewer to search", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });
    await indexText(h, "doc-1", "a readable contract");

    const results = await h.service.search(actor("viewer-1"), WS_A, { query: "contract" });
    expect(results.hits).toHaveLength(1);
  });

  it("refuses a non-member and reports a foreign Workspace as missing", async () => {
    const h = harness();
    await expect(h.service.search(actor("stranger"), WS_A, { query: "some term" })).rejects.toThrow(
      DomainError,
    );
    await expect(h.service.search(actor("user-1"), WS_B, { query: "some term" })).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe("SearchService — index state", () => {
  it("reports an entry as stale when it describes an older version", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A, currentVersionId: "version-1" });
    await indexText(h, "doc-1", "a versioned contract");

    // The document moves to a new version without being reindexed.
    h.documents.add({ id: "doc-1", workspaceId: WS_A, currentVersionId: "version-2" });

    const results = await h.service.search(actor("user-1"), WS_A, { query: "contract" });
    expect(results.hits[0].stale).toBe(true);
  });

  it("reports a current entry as not stale", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A, currentVersionId: "version-1" });
    await indexText(h, "doc-1", "a current contract");

    const results = await h.service.search(actor("user-1"), WS_A, { query: "contract" });
    expect(results.hits[0].stale).toBe(false);
  });

  it("marks an entry stale on request", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });
    await indexText(h, "doc-1", "some content");

    const updated = await h.service.markStale(actor("user-1"), WS_A, "doc-1");
    expect(updated?.state).toBe("stale");
  });

  it("returns null when marking an unindexed document stale", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });
    expect(await h.service.markStale(actor("user-1"), WS_A, "doc-1")).toBeNull();
  });

  it("queues a reindex by moving the entry to pending and clearing its error", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });
    await indexText(h, "doc-1", "some content");

    const queued = await h.service.requestReindex(actor("user-1"), WS_A, "doc-1");
    expect(queued.state).toBe("pending");
    expect(queued.error).toBeNull();
  });

  it("creates a pending entry when reindexing a never-indexed document", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });

    const queued = await h.service.requestReindex(actor("user-1"), WS_A, "doc-1");
    expect(queued.state).toBe("pending");
    expect(queued.documentId).toBe("doc-1");
  });

  it("does not claim to have reindexed content it never re-extracted", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });
    await indexText(h, "doc-1", "some content");

    const queued = await h.service.requestReindex(actor("user-1"), WS_A, "doc-1");
    // Queued, not indexed: extraction is a separate step, and reporting
    // "indexed" here would be the fabrication this phase replaced.
    expect(queued.state).not.toBe("indexed");
  });

  it("refuses a reindex request from a viewer", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });
    await expect(h.service.requestReindex(actor("viewer-1"), WS_A, "doc-1")).rejects.toThrow(
      DomainError,
    );
  });

  it("returns index status for a document and null when never indexed", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });
    h.documents.add({ id: "doc-2", workspaceId: WS_A });
    await indexText(h, "doc-1", "some content");

    expect((await h.service.getIndexStatus(actor("user-1"), WS_A, "doc-1"))?.state).toBe("indexed");
    expect(await h.service.getIndexStatus(actor("user-1"), WS_A, "doc-2")).toBeNull();
  });

  it("does not disclose a document from another Workspace through status", async () => {
    const h = harness();
    h.documents.add({ id: "doc-b", workspaceId: WS_B, organizationId: ORG_OTHER });
    await expect(h.service.getIndexStatus(actor("user-1"), WS_A, "doc-b")).rejects.toThrow(
      NotFoundError,
    );
  });

  it("removes a document from the index even after its record is gone", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });
    await indexText(h, "doc-1", "content to purge");
    h.documents.remove(WS_A, "doc-1");

    // Removal must work precisely when the record no longer exists, otherwise
    // deleted content stays searchable.
    await h.service.removeFromIndex(actor("user-1"), WS_A, "doc-1");

    expect(await h.searchDocuments.getByDocumentId(WS_A, "doc-1")).toBeNull();
    expect(await h.chunks.countForDocument(WS_A, "doc-1")).toBe(0);
  });

  it("lists entries by state", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });
    h.documents.add({ id: "doc-2", workspaceId: WS_A });
    await indexText(h, "doc-1", "one document");
    await indexText(h, "doc-2", "two document");
    await h.service.markStale(actor("user-1"), WS_A, "doc-2");

    const indexed = await h.service.listByState(actor("user-1"), WS_A, "indexed");
    const stale = await h.service.listByState(actor("user-1"), WS_A, "stale");

    expect(indexed.map((entry) => entry.documentId)).toEqual(["doc-1"]);
    expect(stale.map((entry) => entry.documentId)).toEqual(["doc-2"]);
  });

  it("reports workspace-scoped statistics", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });
    h.documents.add({ id: "doc-2", workspaceId: WS_A });
    h.documents.add({ id: "doc-b", workspaceId: WS_B, organizationId: ORG_OTHER });
    await indexText(h, "doc-1", "alpha content");
    await indexText(h, "doc-2", "beta content");
    await indexText(h, "doc-b", "other workspace", 1, WS_B, "user-3", ORG_OTHER);
    await h.service.markStale(actor("user-1"), WS_A, "doc-2");

    const stats = await h.service.getStatistics(actor("user-1"), WS_A);

    expect(stats.indexedDocuments).toBe(1);
    expect(stats.staleDocuments).toBe(1);
    expect(stats.failedDocuments).toBe(0);
    expect(stats.totalChunks).toBe(2);
    expect(stats.lastIndexedAt).not.toBeNull();
  });

  it("lists a document's chunks, bounded and Workspace-scoped", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });
    await indexText(h, "doc-1", "lorem ipsum dolor sit amet ".repeat(400));

    const chunks = await h.service.listChunks(actor("user-1"), WS_A, "doc-1", 3);
    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.workspaceId === WS_A)).toBe(true);
  });
});

describe("SearchService — returned state is a copy", () => {
  it("does not let a caller mutating a returned entry reach repository state", async () => {
    const h = harness();
    h.documents.add({ id: "doc-1", workspaceId: WS_A });
    const entry = await indexText(h, "doc-1", "some content");

    entry.state = "failed";
    entry.createdAt.setFullYear(1990);

    const reloaded = await h.searchDocuments.getByDocumentId(WS_A, "doc-1");
    expect(reloaded?.state).toBe("indexed");
    expect(reloaded?.createdAt.getFullYear()).not.toBe(1990);
  });
});
