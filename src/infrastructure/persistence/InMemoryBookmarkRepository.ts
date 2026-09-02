import type { WorkspaceBookmark } from "@/src/domain/entities/DocumentMetadata";
import { METADATA_LIMITS } from "@/src/domain/entities/DocumentMetadata";
import type {
  BookmarkListQuery,
  BookmarkRepository,
  CreateBookmarkInput,
  UpdateBookmarkInput,
} from "@/src/application/ports/workspaces/BookmarkRepository";

let counter = 0;
function uid(): string {
  counter += 1;
  return `inmem-bookmark-${counter}`;
}

/** Stored in the column shape the database uses: two nullable coordinates. */
interface StoredBookmark {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  pageNumber: number;
  title: string;
  note: string | null;
  anchorX: number | null;
  anchorY: number | null;
  orderKey: string;
  createdById: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * In-memory BookmarkRepository — for tests and as a zero-dependency fallback.
 *
 * Mirrors the Prisma adapter's Workspace scoping, its compare-and-swap update,
 * its (orderKey, id) total ordering and its bounded listings. The anchor is held
 * as two nullable columns rather than as an object, so a half-written anchor
 * degrades here exactly as it would in the database.
 */
export class InMemoryBookmarkRepository implements BookmarkRepository {
  private readonly rows = new Map<string, StoredBookmark>();

  private toDomain(row: StoredBookmark): WorkspaceBookmark {
    return {
      id: row.id,
      organizationId: row.organizationId,
      workspaceId: row.workspaceId,
      documentId: row.documentId,
      pageNumber: row.pageNumber,
      title: row.title,
      note: row.note,
      anchor:
        row.anchorX === null || row.anchorY === null
          ? null
          : { x: row.anchorX, y: row.anchorY },
      orderKey: row.orderKey,
      createdById: row.createdById,
      revision: row.revision,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    };
  }

  /** Order key first, id as a total tie-break — as the adapter's orderBy does. */
  private sorted(rows: StoredBookmark[]): StoredBookmark[] {
    return rows
      .slice()
      .sort((a, b) => a.orderKey.localeCompare(b.orderKey) || a.id.localeCompare(b.id));
  }

  async create(input: CreateBookmarkInput): Promise<WorkspaceBookmark> {
    const now = new Date();
    const row: StoredBookmark = {
      id: uid(),
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      pageNumber: input.pageNumber,
      title: input.title,
      note: input.note,
      anchorX: input.anchor?.x ?? null,
      anchorY: input.anchor?.y ?? null,
      orderKey: input.orderKey,
      createdById: input.createdById,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return this.toDomain(row);
  }

  async getById(workspaceId: string, bookmarkId: string): Promise<WorkspaceBookmark | null> {
    const row = this.rows.get(bookmarkId);
    // Scoped by Workspace as well as id: a bookmark from another tenant reads as
    // missing rather than as forbidden.
    if (!row || row.workspaceId !== workspaceId) return null;
    return this.toDomain(row);
  }

  async list(query: BookmarkListQuery): Promise<WorkspaceBookmark[]> {
    const matching = [...this.rows.values()].filter(
      (row) =>
        row.workspaceId === query.workspaceId &&
        row.documentId === query.documentId &&
        (query.pageNumber === undefined || row.pageNumber === query.pageNumber),
    );
    return this.sorted(matching)
      .slice(0, Math.min(Math.trunc(query.limit), METADATA_LIMITS.maxListLimit))
      .map((row) => this.toDomain(row));
  }

  async update(
    workspaceId: string,
    bookmarkId: string,
    expectedRevision: number,
    input: UpdateBookmarkInput,
  ): Promise<WorkspaceBookmark | null> {
    const row = this.rows.get(bookmarkId);
    if (!row || row.workspaceId !== workspaceId) return null;
    if (row.revision !== expectedRevision) return null;
    // An absent key leaves the field alone; an explicit null clears it.
    if (input.pageNumber !== undefined) row.pageNumber = input.pageNumber;
    if (input.title !== undefined) row.title = input.title;
    if (input.note !== undefined) row.note = input.note;
    if (input.anchor !== undefined) {
      row.anchorX = input.anchor?.x ?? null;
      row.anchorY = input.anchor?.y ?? null;
    }
    if (input.orderKey !== undefined) row.orderKey = input.orderKey;
    row.revision += 1;
    row.updatedAt = new Date(row.updatedAt.getTime() + 1000);
    return this.toDomain(row);
  }

  async delete(workspaceId: string, bookmarkId: string): Promise<boolean> {
    const row = this.rows.get(bookmarkId);
    if (!row || row.workspaceId !== workspaceId) return false;
    return this.rows.delete(bookmarkId);
  }

  async deleteForDocument(workspaceId: string, documentId: string): Promise<number> {
    let removed = 0;
    for (const [id, row] of [...this.rows.entries()]) {
      if (row.workspaceId !== workspaceId || row.documentId !== documentId) continue;
      this.rows.delete(id);
      removed += 1;
    }
    return removed;
  }

  async countForDocument(workspaceId: string, documentId: string): Promise<number> {
    return [...this.rows.values()].filter(
      (row) => row.workspaceId === workspaceId && row.documentId === documentId,
    ).length;
  }

  async lastOrderKey(workspaceId: string, documentId: string): Promise<string | null> {
    const matching = this.sorted(
      [...this.rows.values()].filter(
        (row) => row.workspaceId === workspaceId && row.documentId === documentId,
      ),
    );
    return matching.length === 0 ? null : matching[matching.length - 1].orderKey;
  }
}
