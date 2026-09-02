import { describe, expect, it, beforeEach } from "vitest";
import { StatisticsService } from "./StatisticsService";
import type { ActorContext, WorkspaceService } from "./WorkspaceService";
import type { ILogger, LogFields } from "@/src/application/ports/Logger";
import type { DocumentRecord } from "@/src/domain/entities/DocumentRecord";
import type { DocumentVersion, DocumentVersionManifest } from "@/src/domain/entities/DocumentVersion";
import { DOCUMENT_VERSION_MANIFEST_SCHEMA } from "@/src/domain/entities/DocumentVersion";
import type { ComparisonSide, StatisticsSource } from "@/src/domain/entities/DocumentStatistics";
import { STATISTICS_LIMITS } from "@/src/domain/entities/DocumentStatistics";
import { InMemoryDocumentVersionRepository } from "@/src/infrastructure/persistence/InMemoryDocumentVersionRepository";
import { InMemoryDocumentStatisticsRepository } from "@/src/infrastructure/persistence/InMemoryDocumentStatisticsRepository";
import { InMemoryComparisonOperationRepository } from "@/src/infrastructure/persistence/InMemoryComparisonOperationRepository";
import { InMemoryComparisonResultRepository } from "@/src/infrastructure/persistence/InMemoryComparisonResultRepository";
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

const OWNER = "user-owner";
const EDITOR = "user-editor";
const VIEWER = "user-viewer";
const OUTSIDER = "user-outsider";

function actor(userId: string, organizationId = ORG): ActorContext {
  return {
    userId,
    organizationId,
    organizationRole: "member",
    organizationDefaultWorkspaceId: null,
  };
}

/**
 * Authorization double preserving the distinctions the service depends on: a
 * Workspace in another organization and a Workspace the actor is not a member of
 * are both *missing*, so a probe cannot confirm either exists; a viewer is
 * refused only on write.
 */
class FakeWorkspaceService {
  private readonly grants = new Map<string, Map<string, "owner" | "editor" | "commenter" | "viewer">>();
  private readonly orgOf = new Map<string, string>();

  addWorkspace(workspaceId: string, organizationId = ORG): void {
    this.orgOf.set(workspaceId, organizationId);
    if (!this.grants.has(workspaceId)) this.grants.set(workspaceId, new Map());
  }
  grant(
    workspaceId: string,
    userId: string,
    role: "owner" | "editor" | "commenter" | "viewer" = "editor",
  ): void {
    if (!this.grants.has(workspaceId)) this.addWorkspace(workspaceId);
    this.grants.get(workspaceId)!.set(userId, role);
  }
  async get(a: ActorContext, workspaceId: string, write = false) {
    const organizationId = this.orgOf.get(workspaceId);
    if (!organizationId) throw new NotFoundError("Workspace not found.");
    if (organizationId !== a.organizationId) throw new NotFoundError("Workspace not found.");
    const role = this.grants.get(workspaceId)?.get(a.userId);
    if (!role) throw new NotFoundError("Workspace not found.");
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
      createdById: OWNER,
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
    return this.docs.get(`${workspaceId}:${documentId}`) ?? null;
  }
}

function manifest(overrides: Partial<DocumentVersionManifest> = {}): string {
  return JSON.stringify({
    schema: DOCUMENT_VERSION_MANIFEST_SCHEMA,
    sourceKey: "objects/source.pdf",
    sourceChecksum: "a".repeat(64),
    sourceByteSize: 2048,
    editorStateKey: null,
    editorStateChecksum: null,
    outputKey: null,
    outputChecksum: null,
    pageCount: 3,
    thumbnailKeys: [],
    ...overrides,
  });
}

/**
 * Server-held content doubles for the trusted recalculation path.
 *
 * These stand in for what the server already extracted (M7.8 chunks) and
 * counted (M7.9 bookmarks and attachments) — the data
 * `recalculateFromServerContent` measures instead of trusting a request body.
 */
class FakeSearchChunkRepository {
  private readonly chunks = new Map<string, Array<{ pageNumber: number | null; text: string }>>();

  set(workspaceId: string, documentId: string, chunks: Array<{ pageNumber: number | null; text: string }>): void {
    this.chunks.set(`${workspaceId}:${documentId}`, chunks);
  }

  async listForDocument(workspaceId: string, documentId: string, limit?: number) {
    const found = this.chunks.get(`${workspaceId}:${documentId}`) ?? [];
    return (limit === undefined ? found : found.slice(0, limit)).map((chunk, index) => ({
      id: `chunk-${index}`,
      organizationId: ORG,
      workspaceId,
      searchDocumentId: "sd-1",
      documentId,
      ordinal: index,
      sourceType: "page" as const,
      pageNumber: chunk.pageNumber,
      text: chunk.text,
      normalizedText: chunk.text.toLowerCase(),
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    }));
  }
}

class FakeCountRepository {
  private readonly counts = new Map<string, number>();

  set(workspaceId: string, documentId: string, count: number): void {
    this.counts.set(`${workspaceId}:${documentId}`, count);
  }

  async countForDocument(workspaceId: string, documentId: string): Promise<number> {
    return this.counts.get(`${workspaceId}:${documentId}`) ?? 0;
  }
}

interface Harness {
  service: StatisticsService;
  logger: TestLogger;
  workspaces: FakeWorkspaceService;
  documents: FakeDocumentRecordRepository;
  versions: InMemoryDocumentVersionRepository;
  statistics: InMemoryDocumentStatisticsRepository;
  comparisons: InMemoryComparisonOperationRepository;
  results: InMemoryComparisonResultRepository;
  chunks: FakeSearchChunkRepository;
  bookmarks: FakeCountRepository;
  attachments: FakeCountRepository;
  clockValue: { current: Date };
}

function harness(): Harness {
  const logger = new TestLogger();
  const workspaces = new FakeWorkspaceService();
  const documents = new FakeDocumentRecordRepository();
  const versions = new InMemoryDocumentVersionRepository();
  const statistics = new InMemoryDocumentStatisticsRepository();
  const comparisons = new InMemoryComparisonOperationRepository();
  const results = new InMemoryComparisonResultRepository();
  const chunks = new FakeSearchChunkRepository();
  const bookmarks = new FakeCountRepository();
  const attachments = new FakeCountRepository();

  // Pinned clock: every assertion about calculatedAt or completedAt is then a
  // statement about the service's behaviour rather than about wall time.
  const clockValue = { current: new Date("2026-08-04T09:00:00.000Z") };

  workspaces.addWorkspace(WS_A, ORG);
  workspaces.addWorkspace(WS_B, ORG_OTHER);
  workspaces.grant(WS_A, OWNER, "owner");
  workspaces.grant(WS_A, EDITOR, "editor");
  workspaces.grant(WS_A, VIEWER, "viewer");
  workspaces.grant(WS_B, OUTSIDER, "owner");

  documents.add(DOC_A, WS_A, ORG);
  documents.add(DOC_A2, WS_A, ORG);
  documents.add(DOC_B, WS_B, ORG_OTHER);

  const service = new StatisticsService(
    logger,
    workspaces as unknown as WorkspaceService,
    documents as never,
    versions,
    statistics,
    comparisons,
    results,
    chunks as never,
    bookmarks as never,
    attachments as never,
    () => clockValue.current,
  );

  return {
    service,
    logger,
    workspaces,
    documents,
    versions,
    statistics,
    comparisons,
    results,
    chunks,
    bookmarks,
    attachments,
    clockValue,
  };
}

async function makeVersion(
  h: Harness,
  documentId = DOC_A,
  workspaceId = WS_A,
  organizationId = ORG,
  manifestJson = manifest(),
): Promise<DocumentVersion> {
  return h.versions.create({
    workspaceId,
    organizationId,
    documentId,
    revision: 1,
    origin: "save",
    restoredFromVersionId: null,
    label: null,
    manifest: manifestJson,
    checksum: "b".repeat(64),
    createdById: OWNER,
  });
}

function source(overrides: Partial<StatisticsSource> = {}): StatisticsSource {
  return {
    segments: [
      { pageNumber: 1, text: "Hello world", imageCount: 2, annotationCount: 1 },
      { pageNumber: 2, text: "Second page here", imageCount: 1, annotationCount: 0 },
    ],
    manifestPageCount: 3,
    fileSize: 2048,
    bookmarkCount: 4,
    attachmentCount: 2,
    ...overrides,
  };
}

function side(
  versionId: string,
  pages: Array<[number, string]>,
  pageCount: number | null = null,
): ComparisonSide {
  return { versionId, pages: new Map(pages), pageCount };
}

describe("StatisticsService — statistics", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("calculates real values from the supplied content", async () => {
    const version = await makeVersion(h);
    const stats = await h.service.calculateStatistics(actor(EDITOR), WS_A, DOC_A, version.id, source());

    expect(stats.status).toBe("ready");
    // "Hello world" (11) + "Second page here" (16) = 27 characters, 5 words.
    expect(stats.counts.textCharacterCount).toBe(27);
    expect(stats.counts.wordCount).toBe(5);
    expect(stats.counts.imageCount).toBe(3);
    expect(stats.counts.annotationCount).toBe(1);
  });

  it("binds statistics to the immutable version they describe", async () => {
    const version = await makeVersion(h);
    const stats = await h.service.calculateStatistics(actor(EDITOR), WS_A, DOC_A, version.id, source());

    expect(stats.versionId).toBe(version.id);
    expect(stats.documentId).toBe(DOC_A);
    expect(stats.workspaceId).toBe(WS_A);
  });

  it("returns null before any calculation has run", async () => {
    const version = await makeVersion(h);
    await expect(h.service.getStatistics(actor(VIEWER), WS_A, DOC_A, version.id)).resolves.toBeNull();
  });

  it("converges rather than accumulating when the same calculation repeats", async () => {
    const version = await makeVersion(h);
    const first = await h.service.calculateStatistics(actor(EDITOR), WS_A, DOC_A, version.id, source());
    const second = await h.service.calculateStatistics(actor(EDITOR), WS_A, DOC_A, version.id, source());

    expect(second.id).toBe(first.id);
    expect(second.checksum).toBe(first.checksum);
    const listed = await h.service.listStatistics(actor(EDITOR), WS_A, DOC_A);
    expect(listed).toHaveLength(1);
  });

  it("does not rewrite calculatedAt when the checksum is unchanged", async () => {
    const version = await makeVersion(h);
    const first = await h.service.calculateStatistics(actor(EDITOR), WS_A, DOC_A, version.id, source());

    h.clockValue.current = new Date("2026-08-04T15:00:00.000Z");
    const second = await h.service.calculateStatistics(actor(EDITOR), WS_A, DOC_A, version.id, source());

    // An unchanged measurement must not churn the record or move its timestamp.
    expect(second.calculatedAt?.toISOString()).toBe(first.calculatedAt?.toISOString());
    expect(second.revision).toBe(first.revision);
  });

  it("rewrites the row when recalculation is forced", async () => {
    const version = await makeVersion(h);
    const first = await h.service.calculateStatistics(actor(EDITOR), WS_A, DOC_A, version.id, source());

    h.clockValue.current = new Date("2026-08-04T15:00:00.000Z");
    const forced = await h.service.calculateStatistics(actor(EDITOR), WS_A, DOC_A, version.id, source(), {
      force: true,
    });

    expect(forced.calculatedAt?.toISOString()).toBe("2026-08-04T15:00:00.000Z");
    expect(forced.revision).toBeGreaterThan(first.revision);
  });

  it("produces a different checksum when the measured content changes", async () => {
    const version = await makeVersion(h);
    const first = await h.service.calculateStatistics(actor(EDITOR), WS_A, DOC_A, version.id, source());
    const changed = await h.service.calculateStatistics(
      actor(EDITOR),
      WS_A,
      DOC_A,
      version.id,
      source({ segments: [{ pageNumber: 1, text: "Entirely different content now" }] }),
    );

    expect(changed.checksum).not.toBe(first.checksum);
  });

  it("leaves unmeasured values null rather than zero", async () => {
    const version = await makeVersion(h);
    // No image or annotation counts offered at all: nobody scanned for them.
    const stats = await h.service.calculateStatistics(actor(EDITOR), WS_A, DOC_A, version.id, {
      segments: [{ pageNumber: 1, text: "Text only" }],
    });

    expect(stats.counts.imageCount).toBeNull();
    expect(stats.counts.annotationCount).toBeNull();
    expect(stats.counts.bookmarkCount).toBeNull();
    expect(stats.counts.fileSize).toBeNull();
  });

  it("records a measured absence as zero", async () => {
    const version = await makeVersion(h);
    const stats = await h.service.calculateStatistics(actor(EDITOR), WS_A, DOC_A, version.id, {
      segments: [{ pageNumber: 1, text: "Text", imageCount: 0, annotationCount: 0 }],
      bookmarkCount: 0,
      attachmentCount: 0,
    });

    // Measured and found none — a different fact from "not measured".
    expect(stats.counts.imageCount).toBe(0);
    expect(stats.counts.annotationCount).toBe(0);
    expect(stats.counts.bookmarkCount).toBe(0);
    expect(stats.counts.attachmentCount).toBe(0);
  });

  it("counts text characters from the real content", async () => {
    const version = await makeVersion(h);
    const stats = await h.service.calculateStatistics(actor(EDITOR), WS_A, DOC_A, version.id, {
      segments: [
        { pageNumber: 1, text: "abcde" },
        { pageNumber: 2, text: "fgh" },
      ],
    });

    expect(stats.counts.textCharacterCount).toBe(8);
  });

  it("counts Unicode words across scripts and separators", async () => {
    const version = await makeVersion(h);
    const stats = await h.service.calculateStatistics(actor(EDITOR), WS_A, DOC_A, version.id, {
      // Ideographic space separates words; a punctuation-only token is not one.
      segments: [{ pageNumber: 1, text: "café résumé　日本 --- test" }],
    });

    expect(stats.counts.wordCount).toBe(4);
  });

  it("derives the page count from the manifest when it recorded one", async () => {
    const version = await makeVersion(h);
    const stats = await h.service.calculateStatistics(actor(EDITOR), WS_A, DOC_A, version.id, {
      // Only one page carries text, but the manifest knows there are 7 — a
      // scanned page with no extractable text still exists.
      segments: [{ pageNumber: 1, text: "Only page one has text" }],
      manifestPageCount: 7,
    });

    expect(stats.counts.pageCount).toBe(7);
  });

  it("counts images from the real segment data", async () => {
    const version = await makeVersion(h);
    const stats = await h.service.calculateStatistics(actor(EDITOR), WS_A, DOC_A, version.id, {
      segments: [
        { pageNumber: 1, imageCount: 4 },
        { pageNumber: 2, imageCount: 6 },
      ],
    });

    expect(stats.counts.imageCount).toBe(10);
  });

  it("counts annotations from the real segment data", async () => {
    const version = await makeVersion(h);
    const stats = await h.service.calculateStatistics(actor(EDITOR), WS_A, DOC_A, version.id, {
      segments: [
        { pageNumber: 1, annotationCount: 3 },
        { pageNumber: 2, annotationCount: 5 },
      ],
    });

    expect(stats.counts.annotationCount).toBe(8);
  });

  it("records the supplied bookmark and attachment counts", async () => {
    const version = await makeVersion(h);
    const stats = await h.service.calculateStatistics(actor(EDITOR), WS_A, DOC_A, version.id, {
      segments: [],
      bookmarkCount: 12,
      attachmentCount: 3,
    });

    expect(stats.counts.bookmarkCount).toBe(12);
    expect(stats.counts.attachmentCount).toBe(3);
  });

  it("validates the file size and drops an impossible one", async () => {
    const version = await makeVersion(h);
    const ok = await h.service.calculateStatistics(actor(EDITOR), WS_A, DOC_A, version.id, {
      segments: [],
      fileSize: 4096,
    });
    expect(ok.counts.fileSize).toBe(4096);

    const version2 = await makeVersion(h, DOC_A2);
    const bad = await h.service.calculateStatistics(actor(EDITOR), WS_A, DOC_A2, version2.id, {
      segments: [],
      fileSize: STATISTICS_LIMITS.maxFileSize + 1,
    });
    // Out of bounds is unmeasured, not clamped to a number nobody observed.
    expect(bad.counts.fileSize).toBeNull();
  });

  it("rejects a segment count beyond the measurable limit", async () => {
    const version = await makeVersion(h);
    const tooMany = Array.from({ length: STATISTICS_LIMITS.maxSegments + 1 }, () => ({ text: "x" }));
    const stats = await h.service.calculateStatistics(actor(EDITOR), WS_A, DOC_A, version.id, {
      segments: tooMany,
    });

    expect(stats.status).toBe("failed");
  });

  it("rejects text beyond the measurable limit", async () => {
    const version = await makeVersion(h);
    const stats = await h.service.calculateStatistics(actor(EDITOR), WS_A, DOC_A, version.id, {
      segments: [{ text: "x".repeat(STATISTICS_LIMITS.maxTextLength + 1) }],
    });

    expect(stats.status).toBe("failed");
    expect(stats.error).toContain("measurable limit");
  });

  it("persists a failed status when extraction fails", async () => {
    const version = await makeVersion(h);
    const stats = await h.service.calculateStatistics(actor(EDITOR), WS_A, DOC_A, version.id, {
      segments: [{ pageNumber: 0 }],
    });

    expect(stats.status).toBe("failed");
    expect(stats.calculatedAt).toBeNull();
    // Persisted, so the panel can distinguish a broken extractor from an empty
    // document rather than showing zeroes.
    const stored = await h.service.getStatistics(actor(EDITOR), WS_A, DOC_A, version.id);
    expect(stored?.status).toBe("failed");
  });

  it("bounds the stored failure reason", async () => {
    const version = await makeVersion(h);
    const stats = await h.service.calculateStatistics(actor(EDITOR), WS_A, DOC_A, version.id, {
      segments: [{ imageCount: -5 }],
    });

    expect(stats.status).toBe("failed");
    expect(stats.error).not.toBeNull();
    expect([...(stats.error ?? "")].length).toBeLessThanOrEqual(STATISTICS_LIMITS.maxErrorLength);
  });

  it("does not disclose a document in another Workspace", async () => {
    const version = await makeVersion(h, DOC_B, WS_B, ORG_OTHER);
    // The actor belongs to ORG and cannot see WS_B at all.
    await expect(
      h.service.getStatistics(actor(EDITOR), WS_B, DOC_B, version.id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects a version belonging to another document", async () => {
    const other = await makeVersion(h, DOC_A2);
    // Same Workspace, wrong document: still missing.
    await expect(
      h.service.getStatistics(actor(EDITOR), WS_A, DOC_A, other.id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects a version belonging to another Workspace", async () => {
    const foreign = await makeVersion(h, DOC_B, WS_B, ORG_OTHER);
    await expect(
      h.service.getStatistics(actor(EDITOR), WS_A, DOC_A, foreign.id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses recalculation by a viewer", async () => {
    const version = await makeVersion(h);
    await expect(
      h.service.calculateStatistics(actor(VIEWER), WS_A, DOC_A, version.id, source()),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("allows an authorized viewer to read statistics", async () => {
    const version = await makeVersion(h);
    await h.service.calculateStatistics(actor(EDITOR), WS_A, DOC_A, version.id, source());

    const read = await h.service.getStatistics(actor(VIEWER), WS_A, DOC_A, version.id);
    expect(read?.status).toBe("ready");
  });

  it("bounds the listing and scopes it to the Workspace", async () => {
    for (let i = 0; i < 4; i += 1) {
      const version = await makeVersion(h);
      await h.service.calculateStatistics(
        actor(EDITOR),
        WS_A,
        DOC_A,
        version.id,
        source({ fileSize: 1000 + i }),
      );
    }

    const limited = await h.service.listStatistics(actor(EDITOR), WS_A, DOC_A, { limit: 2 });
    expect(limited).toHaveLength(2);

    const capped = await h.service.listStatistics(actor(EDITOR), WS_A, DOC_A, { limit: 10_000 });
    expect(capped.length).toBeLessThanOrEqual(STATISTICS_LIMITS.maxListLimit);
    expect(capped.every((row) => row.workspaceId === WS_A && row.documentId === DOC_A)).toBe(true);
  });

  it("returns objects that cannot mutate stored state", async () => {
    const version = await makeVersion(h);
    const stats = await h.service.calculateStatistics(actor(EDITOR), WS_A, DOC_A, version.id, source());

    stats.counts.pageCount = 99_999;
    stats.calculatedAt?.setFullYear(1999);

    const reread = await h.service.getStatistics(actor(EDITOR), WS_A, DOC_A, version.id);
    expect(reread?.counts.pageCount).toBe(3);
    expect(reread?.calculatedAt?.getFullYear()).toBe(2026);
  });
});

/**
 * The trusted recalculation path.
 *
 * `recalculateFromServerContent` is what the HTTP route calls. It exists so a
 * client can ask for a recalculation without being able to supply the answer:
 * statistics are stored as fact and read by every member of the Workspace, and a
 * fabricated count is indistinguishable from a measured one afterwards.
 */
describe("StatisticsService — recalculation from server-held content", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("measures the server's own extracted content", async () => {
    const version = await makeVersion(h);
    h.chunks.set(WS_A, DOC_A, [
      { pageNumber: 1, text: "alpha beta" },
      { pageNumber: 2, text: "gamma" },
    ]);
    h.bookmarks.set(WS_A, DOC_A, 4);
    h.attachments.set(WS_A, DOC_A, 2);

    const stats = await h.service.recalculateFromServerContent(actor(EDITOR), WS_A, DOC_A, version.id);

    expect(stats.status).toBe("ready");
    expect(stats.counts.wordCount).toBe(3);
    expect(stats.counts.textCharacterCount).toBe(15);
    expect(stats.counts.bookmarkCount).toBe(4);
    expect(stats.counts.attachmentCount).toBe(2);
  });

  it("takes the page count and file size from the version manifest", async () => {
    // Not from anything a caller said: the manifest is what the server recorded
    // when the version was cut.
    const version = await makeVersion(h);
    h.chunks.set(WS_A, DOC_A, [{ pageNumber: 1, text: "only page one" }]);

    const stats = await h.service.recalculateFromServerContent(actor(EDITOR), WS_A, DOC_A, version.id);

    expect(stats.counts.pageCount).toBe(3);
    expect(stats.counts.fileSize).toBe(2048);
  });

  it("leaves image and annotation counts unmeasured", async () => {
    const version = await makeVersion(h);
    h.chunks.set(WS_A, DOC_A, [{ pageNumber: 1, text: "text" }]);

    const stats = await h.service.recalculateFromServerContent(actor(EDITOR), WS_A, DOC_A, version.id);

    // No server-side extractor records them yet, and zero would claim a
    // document has none when nothing ever looked.
    expect(stats.counts.imageCount).toBeNull();
    expect(stats.counts.annotationCount).toBeNull();
  });

  it("reads only content scoped to this document", async () => {
    const version = await makeVersion(h);
    h.chunks.set(WS_A, DOC_A, [{ pageNumber: 1, text: "mine" }]);
    h.chunks.set(WS_A, DOC_A2, [{ pageNumber: 1, text: "someone else's much longer text" }]);
    h.bookmarks.set(WS_A, DOC_A2, 99);

    const stats = await h.service.recalculateFromServerContent(actor(EDITOR), WS_A, DOC_A, version.id);

    expect(stats.counts.wordCount).toBe(1);
    expect(stats.counts.bookmarkCount).toBe(0);
  });

  it("refuses a viewer", async () => {
    const version = await makeVersion(h);
    await expect(
      h.service.recalculateFromServerContent(actor(VIEWER), WS_A, DOC_A, version.id),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("rejects a version from another document", async () => {
    const other = await makeVersion(h, DOC_A2);
    await expect(
      h.service.recalculateFromServerContent(actor(EDITOR), WS_A, DOC_A, other.id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("converges on repeat and updates when forced", async () => {
    const version = await makeVersion(h);
    h.chunks.set(WS_A, DOC_A, [{ pageNumber: 1, text: "stable text" }]);

    const first = await h.service.recalculateFromServerContent(actor(EDITOR), WS_A, DOC_A, version.id);
    h.clockValue.current = new Date("2026-08-04T15:00:00.000Z");
    const second = await h.service.recalculateFromServerContent(actor(EDITOR), WS_A, DOC_A, version.id);

    expect(second.calculatedAt?.toISOString()).toBe(first.calculatedAt?.toISOString());

    const forced = await h.service.recalculateFromServerContent(
      actor(EDITOR),
      WS_A,
      DOC_A,
      version.id,
      { force: true },
    );
    expect(forced.calculatedAt?.toISOString()).toBe("2026-08-04T15:00:00.000Z");
  });
});

describe("StatisticsService — comparison", () => {
  let h: Harness;
  let left: DocumentVersion;
  let right: DocumentVersion;

  beforeEach(async () => {
    h = harness();
    left = await makeVersion(h);
    right = await makeVersion(h);
  });

  function create(type = "textual") {
    return h.service.createComparison(actor(EDITOR), WS_A, DOC_A, {
      leftVersionId: left.id,
      rightVersionId: right.id,
      type,
    });
  }

  it("creates a real pending operation", async () => {
    const operation = await create();

    expect(operation.status).toBe("pending");
    expect(operation.progress).toBe(0);
    expect(operation.leftVersionId).toBe(left.id);
    expect(operation.rightVersionId).toBe(right.id);
    expect(operation.requestedById).toBe(EDITOR);
  });

  it("validates that both versions belong to the document", async () => {
    const foreign = await makeVersion(h, DOC_A2);
    await expect(
      h.service.createComparison(actor(EDITOR), WS_A, DOC_A, {
        leftVersionId: left.id,
        rightVersionId: foreign.id,
        type: "textual",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses to compare a version with itself", async () => {
    await expect(
      h.service.createComparison(actor(EDITOR), WS_A, DOC_A, {
        leftVersionId: left.id,
        rightVersionId: left.id,
        type: "textual",
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("rejects an invalid comparison type", async () => {
    await expect(create("telepathic")).rejects.toBeInstanceOf(DomainError);
  });

  it("refuses visual comparison honestly rather than returning an empty diff", async () => {
    await expect(create("visual")).rejects.toThrow(/page rendering/i);
  });

  it("requires editor-state artifacts for an editor comparison", async () => {
    await expect(create("editor")).rejects.toThrow(/editor state/i);

    // With editor state on both sides it is accepted.
    const withState = manifest({
      editorStateKey: "objects/state.json",
      editorStateChecksum: "c".repeat(64),
    });
    const l = await makeVersion(h, DOC_A2, WS_A, ORG, withState);
    const r = await makeVersion(h, DOC_A2, WS_A, ORG, withState);
    const operation = await h.service.createComparison(actor(EDITOR), WS_A, DOC_A2, {
      leftVersionId: l.id,
      rightVersionId: r.id,
      type: "editor",
    });
    expect(operation.type).toBe("editor");
  });

  it("enforces the active-operation limit", async () => {
    for (let i = 0; i < STATISTICS_LIMITS.maxActiveComparisonsPerDocument; i += 1) {
      await create();
    }
    await expect(create()).rejects.toThrow(/in progress/i);
  });

  it("moves a pending operation to running on start", async () => {
    const operation = await create();
    const started = await h.service.startComparison(WS_A, operation.id);

    expect(started?.status).toBe("running");
    expect(started?.startedAt).not.toBeNull();
  });

  it("idempotently refuses a duplicate start", async () => {
    const operation = await create();
    await h.service.startComparison(WS_A, operation.id);

    // The second worker finds the state already moved and does no work.
    await expect(h.service.startComparison(WS_A, operation.id)).resolves.toBeNull();
  });

  it("persists valid progress", async () => {
    const operation = await create();
    await h.service.startComparison(WS_A, operation.id);

    const updated = await h.service.reportComparisonProgress(WS_A, operation.id, 42);
    expect(updated?.progress).toBe(42);
  });

  it("rejects invalid progress", async () => {
    const operation = await create();
    await h.service.startComparison(WS_A, operation.id);

    await expect(h.service.reportComparisonProgress(WS_A, operation.id, 140)).rejects.toBeInstanceOf(
      DomainError,
    );
    await expect(h.service.reportComparisonProgress(WS_A, operation.id, -1)).rejects.toBeInstanceOf(
      DomainError,
    );
  });

  it("refuses progress on a terminal operation", async () => {
    const operation = await create();
    await h.service.startComparison(WS_A, operation.id);
    await h.service.failComparison(WS_A, operation.id, "extraction broke");

    // A slow worker must not animate a finished operation.
    await expect(h.service.reportComparisonProgress(WS_A, operation.id, 80)).resolves.toBeNull();
  });

  it("produces a real textual result", async () => {
    const operation = await create("textual");
    await h.service.startComparison(WS_A, operation.id);
    await h.service.completeComparison(WS_A, operation.id, {
      left: side(left.id, [[1, "alpha\nbeta"]]),
      right: side(right.id, [[1, "alpha\ngamma"]]),
    });

    const view = await h.service.getComparison(actor(EDITOR), WS_A, DOC_A, operation.id);
    expect(view.operation.status).toBe("completed");
    expect(view.result?.summary.added).toBe(1);
    expect(view.result?.summary.removed).toBe(1);
    expect(view.result?.differences.some((d) => d.excerpt === "gamma")).toBe(true);
  });

  it("produces a real structural result", async () => {
    const operation = await create("structural");
    await h.service.startComparison(WS_A, operation.id);
    await h.service.completeComparison(WS_A, operation.id, {
      left: side(
        left.id,
        [
          [1, "one"],
          [2, "two"],
        ],
        2,
      ),
      right: side(
        right.id,
        [
          [1, "one"],
          [2, "changed"],
          [3, "three"],
        ],
        3,
      ),
    });

    const view = await h.service.getComparison(actor(EDITOR), WS_A, DOC_A, operation.id);
    expect(view.result?.summary.changed).toBe(1);
    expect(view.result?.summary.pagesAdded).toEqual([3]);
  });

  it("binds the result checksum to both versions and the type", async () => {
    const operation = await create("textual");
    await h.service.startComparison(WS_A, operation.id);
    await h.service.completeComparison(WS_A, operation.id, {
      left: side(left.id, [[1, "a"]]),
      right: side(right.id, [[1, "b"]]),
    });
    const first = await h.service.getComparisonResult(actor(EDITOR), WS_A, DOC_A, operation.id);

    // A different type over the same pair is a different fact.
    const structural = await create("structural");
    await h.service.startComparison(WS_A, structural.id);
    await h.service.completeComparison(WS_A, structural.id, {
      left: side(left.id, [[1, "a"]]),
      right: side(right.id, [[1, "b"]]),
    });
    const second = await h.service.getComparisonResult(actor(EDITOR), WS_A, DOC_A, structural.id);

    expect(second.checksum).not.toBe(first.checksum);
  });

  it("does not duplicate a result when completion is redelivered", async () => {
    const operation = await create("textual");
    await h.service.startComparison(WS_A, operation.id);
    const work = {
      left: side(left.id, [[1, "a"]]),
      right: side(right.id, [[1, "b"]]),
    };
    await h.service.completeComparison(WS_A, operation.id, work);
    const redelivered = await h.service.completeComparison(WS_A, operation.id, work);

    // The operation already left `running`, so the second delivery does nothing.
    expect(redelivered).toBeNull();
    const view = await h.service.getComparison(actor(EDITOR), WS_A, DOC_A, operation.id);
    expect(view.result).not.toBeNull();
  });

  it("fails safely when the worker submits mismatched versions", async () => {
    const operation = await create("textual");
    await h.service.startComparison(WS_A, operation.id);
    const outcome = await h.service.completeComparison(WS_A, operation.id, {
      left: side("some-other-version", [[1, "a"]]),
      right: side(right.id, [[1, "b"]]),
    });

    // A result filed against the wrong versions would describe something else.
    expect(outcome?.status).toBe("failed");
    const view = await h.service.getComparison(actor(EDITOR), WS_A, DOC_A, operation.id);
    expect(view.result).toBeNull();
  });

  it("cancels a pending operation outright", async () => {
    const operation = await create();
    const cancelled = await h.service.cancelComparison(actor(EDITOR), WS_A, DOC_A, operation.id);

    // Nothing picked it up, so it need not wait for a worker checkpoint.
    expect(cancelled.status).toBe("cancelled");
  });

  it("records a cancellation request against a running operation", async () => {
    const operation = await create();
    await h.service.startComparison(WS_A, operation.id);
    const requested = await h.service.cancelComparison(actor(EDITOR), WS_A, DOC_A, operation.id);

    expect(requested.status).toBe("running");
    expect(requested.cancelRequestedAt).not.toBeNull();
  });

  it("observes cancellation before creating a result", async () => {
    const operation = await create("textual");
    await h.service.startComparison(WS_A, operation.id);
    await h.service.cancelComparison(actor(EDITOR), WS_A, DOC_A, operation.id);

    const outcome = await h.service.completeComparison(WS_A, operation.id, {
      left: side(left.id, [[1, "a"]]),
      right: side(right.id, [[1, "b"]]),
    });

    // "Cancel" must not mean "cancel, unless it happened to finish first".
    expect(outcome?.status).toBe("cancelled");
    const view = await h.service.getComparison(actor(EDITOR), WS_A, DOC_A, operation.id);
    expect(view.result).toBeNull();
  });

  it("refuses to complete a cancelled operation", async () => {
    const operation = await create();
    await h.service.cancelComparison(actor(EDITOR), WS_A, DOC_A, operation.id);

    await expect(
      h.service.completeComparison(WS_A, operation.id, {
        left: side(left.id, [[1, "a"]]),
        right: side(right.id, [[1, "b"]]),
      }),
    ).resolves.toBeNull();
  });

  it("refuses to cancel a completed operation", async () => {
    const operation = await create("textual");
    await h.service.startComparison(WS_A, operation.id);
    await h.service.completeComparison(WS_A, operation.id, {
      left: side(left.id, [[1, "a"]]),
      right: side(right.id, [[1, "b"]]),
    });

    await expect(h.service.cancelComparison(actor(EDITOR), WS_A, DOC_A, operation.id)).rejects.toThrow(
      /already finished/i,
    );
  });

  it("stores a bounded error on failure", async () => {
    const operation = await create();
    await h.service.startComparison(WS_A, operation.id);
    const failed = await h.service.failComparison(WS_A, operation.id, "boom ".repeat(400));

    expect(failed?.status).toBe("failed");
    expect([...(failed?.error ?? "")].length).toBeLessThanOrEqual(STATISTICS_LIMITS.maxErrorLength);
  });

  it("creates a new operation on retry", async () => {
    const operation = await create();
    await h.service.startComparison(WS_A, operation.id);
    await h.service.failComparison(WS_A, operation.id, "extraction broke");

    const retried = await h.service.retryComparison(actor(EDITOR), WS_A, DOC_A, operation.id);
    expect(retried.id).not.toBe(operation.id);
    expect(retried.status).toBe("pending");
    expect(retried.leftVersionId).toBe(operation.leftVersionId);
  });

  it("does not rewrite terminal history on retry", async () => {
    const operation = await create();
    await h.service.startComparison(WS_A, operation.id);
    await h.service.failComparison(WS_A, operation.id, "extraction broke");
    await h.service.retryComparison(actor(EDITOR), WS_A, DOC_A, operation.id);

    const original = await h.service.getComparison(actor(EDITOR), WS_A, DOC_A, operation.id);
    // The failure stays an honest historical fact.
    expect(original.operation.status).toBe("failed");
    expect(original.operation.error).toBe("extraction broke");
  });

  it("refuses to retry an operation that is still active", async () => {
    const operation = await create();
    await expect(h.service.retryComparison(actor(EDITOR), WS_A, DOC_A, operation.id)).rejects.toThrow(
      /still running/i,
    );
  });

  it("requires completed status before a result is retrievable", async () => {
    const operation = await create();
    await expect(
      h.service.getComparisonResult(actor(EDITOR), WS_A, DOC_A, operation.id),
    ).rejects.toThrow(/no result/i);
  });

  it("scopes result access to the Workspace and document", async () => {
    const operation = await create("textual");
    await h.service.startComparison(WS_A, operation.id);
    await h.service.completeComparison(WS_A, operation.id, {
      left: side(left.id, [[1, "a"]]),
      right: side(right.id, [[1, "b"]]),
    });

    // Same Workspace, wrong document.
    await expect(
      h.service.getComparisonResult(actor(EDITOR), WS_A, DOC_A2, operation.id),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Another organization entirely.
    await expect(
      h.service.getComparisonResult(actor(OUTSIDER, ORG_OTHER), WS_A, DOC_A, operation.id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("bounds the comparison listing", async () => {
    await create();
    await create();
    await create();

    const limited = await h.service.listComparisons(actor(EDITOR), WS_A, DOC_A, { limit: 2 });
    expect(limited).toHaveLength(2);

    const capped = await h.service.listComparisons(actor(EDITOR), WS_A, DOC_A, { limit: 10_000 });
    expect(capped.length).toBeLessThanOrEqual(STATISTICS_LIMITS.maxListLimit);
  });

  it("returns state that cannot mutate repository storage", async () => {
    const operation = await create();
    operation.createdAt.setFullYear(1999);
    operation.progress = 77;

    const reread = await h.service.getComparison(actor(EDITOR), WS_A, DOC_A, operation.id);
    expect(reread.operation.createdAt.getFullYear()).toBe(2026);
    expect(reread.operation.progress).toBe(0);
  });
});
