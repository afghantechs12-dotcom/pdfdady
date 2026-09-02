import type { PrismaClient, WorkspaceBookmark as BookmarkRow } from "@prisma/client";
import type { WorkspaceBookmark } from "@/src/domain/entities/DocumentMetadata";
import { METADATA_LIMITS } from "@/src/domain/entities/DocumentMetadata";
import type {
  BookmarkListQuery,
  BookmarkRepository,
  CreateBookmarkInput,
  UpdateBookmarkInput,
} from "@/src/application/ports/workspaces/BookmarkRepository";

function toDomain(row: BookmarkRow): WorkspaceBookmark {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    documentId: row.documentId,
    pageNumber: row.pageNumber,
    title: row.title,
    note: row.note,
    // Both coordinates or neither: a half-written anchor cannot address a
    // point, so it reads as a whole-page bookmark rather than as (x, 0).
    anchor:
      row.anchorX === null || row.anchorY === null
        ? null
        : { x: row.anchorX, y: row.anchorY },
    orderKey: row.orderKey,
    createdById: row.createdById,
    revision:
      Number.isFinite(row.revision) && row.revision >= 1 ? Math.trunc(row.revision) : 1,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

/**
 * SQLite-backed BookmarkRepository.
 *
 * Every predicate carries `workspaceId`, so a bookmark addressed from another
 * Workspace reads as missing. Updates are compare-and-swap on `revision`, and a
 * lost race is indistinguishable from a missing row on purpose.
 */
export class PrismaBookmarkRepository implements BookmarkRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateBookmarkInput): Promise<WorkspaceBookmark> {
    const row = await this.prisma.workspaceBookmark.create({
      data: {
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
      },
    });
    return toDomain(row);
  }

  async getById(workspaceId: string, bookmarkId: string): Promise<WorkspaceBookmark | null> {
    const row = await this.prisma.workspaceBookmark.findFirst({
      where: { id: bookmarkId, workspaceId },
    });
    return row ? toDomain(row) : null;
  }

  async list(query: BookmarkListQuery): Promise<WorkspaceBookmark[]> {
    const rows = await this.prisma.workspaceBookmark.findMany({
      where: {
        workspaceId: query.workspaceId,
        documentId: query.documentId,
        ...(query.pageNumber === undefined ? {} : { pageNumber: query.pageNumber }),
      },
      // Order key first, id as a total tie-break: two bookmarks may share a key
      // after a concurrent append, and a listing that reorders between reads
      // makes a keyboard-navigated list jump under the user.
      orderBy: [{ orderKey: "asc" }, { id: "asc" }],
      take: Math.min(Math.trunc(query.limit), METADATA_LIMITS.maxListLimit),
    });
    return rows.map(toDomain);
  }

  async update(
    workspaceId: string,
    bookmarkId: string,
    expectedRevision: number,
    input: UpdateBookmarkInput,
  ): Promise<WorkspaceBookmark | null> {
    // An absent key means "leave it alone"; an explicit null means "clear it".
    // Spreading conditionally is what keeps those apart — a plain assignment
    // would turn every partial update into a wipe of the fields it omitted.
    const result = await this.prisma.workspaceBookmark.updateMany({
      where: { id: bookmarkId, workspaceId, revision: expectedRevision },
      data: {
        ...(input.pageNumber === undefined ? {} : { pageNumber: input.pageNumber }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.anchor === undefined
          ? {}
          : { anchorX: input.anchor?.x ?? null, anchorY: input.anchor?.y ?? null }),
        ...(input.orderKey === undefined ? {} : { orderKey: input.orderKey }),
        revision: { increment: 1 },
      },
    });
    if (result.count === 0) return null;
    return this.getById(workspaceId, bookmarkId);
  }

  async delete(workspaceId: string, bookmarkId: string): Promise<boolean> {
    const result = await this.prisma.workspaceBookmark.deleteMany({
      where: { id: bookmarkId, workspaceId },
    });
    return result.count > 0;
  }

  async deleteForDocument(workspaceId: string, documentId: string): Promise<number> {
    const result = await this.prisma.workspaceBookmark.deleteMany({
      where: { workspaceId, documentId },
    });
    return result.count;
  }

  async countForDocument(workspaceId: string, documentId: string): Promise<number> {
    return this.prisma.workspaceBookmark.count({ where: { workspaceId, documentId } });
  }

  async lastOrderKey(workspaceId: string, documentId: string): Promise<string | null> {
    const rows = await this.prisma.workspaceBookmark.findMany({
      where: { workspaceId, documentId },
      orderBy: [{ orderKey: "desc" }, { id: "desc" }],
      take: 1,
    });
    return rows[0]?.orderKey ?? null;
  }
}
