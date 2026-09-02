import type { CommentThread } from "@/src/domain/entities/Collaboration";
import { COLLABORATION_LIMITS, parseAnchor } from "@/src/domain/entities/Collaboration";
import type {
  CommentThreadListQuery,
  CommentThreadRepository,
  CreateCommentThreadInput,
} from "@/src/application/ports/workspaces/CommentThreadRepository";
import type { CommentThreadStatus } from "@/src/domain/entities/Collaboration";

let counter = 0;
function uid(): string {
  counter += 1;
  return `inmem-thread-${counter}`;
}

/** Stored in the column shape the database uses: the anchor as serialized text. */
interface StoredThread {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  versionId: string | null;
  anchorType: string;
  anchor: string;
  anchorSchemaVersion: number;
  pageNumber: number | null;
  status: string;
  createdById: string;
  resolvedById: string | null;
  resolvedAt: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * In-memory CommentThreadRepository — for tests and as a zero-dependency
 * fallback.
 *
 * Mirrors the Prisma adapter's Workspace scoping, its compare-and-swap status
 * change, its newest-first total ordering and its bounded listings. The anchor
 * is held as serialized text rather than as an object, so a row written by
 * another build degrades here exactly as it would in the database.
 */
export class InMemoryCommentThreadRepository implements CommentThreadRepository {
  private readonly rows = new Map<string, StoredThread>();
  /** Monotonic clock so two threads created in the same millisecond still order. */
  private tick = 0;

  private now(): Date {
    this.tick += 1;
    return new Date(Date.UTC(2026, 7, 3, 12, 0, 0, 0) + this.tick * 1000);
  }

  private toDomain(row: StoredThread): CommentThread {
    return {
      id: row.id,
      organizationId: row.organizationId,
      workspaceId: row.workspaceId,
      documentId: row.documentId,
      versionId: row.versionId,
      // Degraded through the same parser the adapter uses: an unreadable anchor
      // reads as document scope rather than failing the whole listing.
      anchorType: (row.anchorType === "document" ||
      row.anchorType === "page" ||
      row.anchorType === "point" ||
      row.anchorType === "rectangle" ||
      row.anchorType === "text" ||
      row.anchorType === "object"
        ? row.anchorType
        : "document") as CommentThread["anchorType"],
      anchor: parseAnchor(row.anchor),
      anchorSchemaVersion: row.anchorSchemaVersion,
      pageNumber: row.pageNumber,
      status: (row.status === "resolved" ? "resolved" : "open") as CommentThreadStatus,
      createdById: row.createdById,
      resolvedById: row.resolvedById,
      resolvedAt: row.resolvedAt === null ? null : new Date(row.resolvedAt),
      revision: row.revision,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    };
  }

  /** Newest first, id as a total tie-break — as the adapter's orderBy does. */
  private sorted(rows: StoredThread[]): StoredThread[] {
    return rows
      .slice()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
  }

  async create(input: CreateCommentThreadInput): Promise<CommentThread> {
    const now = this.now();
    const row: StoredThread = {
      id: uid(),
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      versionId: input.versionId,
      anchorType: input.anchorType,
      anchor: input.anchor,
      anchorSchemaVersion: input.anchorSchemaVersion,
      pageNumber: input.pageNumber,
      status: "open",
      createdById: input.createdById,
      resolvedById: null,
      resolvedAt: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return this.toDomain(row);
  }

  async getById(workspaceId: string, threadId: string): Promise<CommentThread | null> {
    const row = this.rows.get(threadId);
    // Scoped by Workspace as well as id: a thread from another tenant reads as
    // missing rather than as forbidden.
    if (!row || row.workspaceId !== workspaceId) return null;
    return this.toDomain(row);
  }

  async list(query: CommentThreadListQuery): Promise<CommentThread[]> {
    const matching = [...this.rows.values()].filter((row) => {
      if (row.workspaceId !== query.workspaceId) return false;
      if (row.documentId !== query.documentId) return false;
      if (query.status !== undefined && row.status !== query.status) return false;
      if (query.createdBefore !== undefined && row.createdAt.getTime() >= query.createdBefore.getTime()) {
        return false;
      }
      if (query.pageNumber !== undefined && row.pageNumber !== query.pageNumber) return false;
      return true;
    });
    return this.sorted(matching)
      .slice(0, Math.min(Math.trunc(query.limit), COLLABORATION_LIMITS.maxListLimit))
      .map((row) => this.toDomain(row));
  }

  async setStatus(
    workspaceId: string,
    threadId: string,
    expectedRevision: number,
    status: CommentThreadStatus,
    actorId: string,
    resolvedAt: Date | null,
  ): Promise<CommentThread | null> {
    const row = this.rows.get(threadId);
    if (!row || row.workspaceId !== workspaceId) return null;
    // A lost race and a missing thread are indistinguishable on purpose.
    if (row.revision !== expectedRevision) return null;
    row.status = status;
    row.resolvedById = status === "resolved" ? actorId : null;
    row.resolvedAt = status === "resolved" ? resolvedAt : null;
    row.revision += 1;
    row.updatedAt = this.now();
    return this.toDomain(row);
  }

  async touch(workspaceId: string, threadId: string): Promise<void> {
    const row = this.rows.get(threadId);
    if (!row || row.workspaceId !== workspaceId) return;
    row.revision += 1;
    row.updatedAt = this.now();
  }

  async delete(workspaceId: string, threadId: string): Promise<boolean> {
    const row = this.rows.get(threadId);
    if (!row || row.workspaceId !== workspaceId) return false;
    return this.rows.delete(threadId);
  }

  async countForDocument(workspaceId: string, documentId: string): Promise<number> {
    return [...this.rows.values()].filter(
      (row) => row.workspaceId === workspaceId && row.documentId === documentId,
    ).length;
  }
}
