import type { PrismaClient, CommentThread as ThreadRow } from "@prisma/client";
import type {
  CommentAnchorType,
  CommentThread,
  CommentThreadStatus,
} from "@/src/domain/entities/Collaboration";
import {
  COLLABORATION_LIMITS,
  isCommentAnchorType,
  isCommentThreadStatus,
  parseAnchor,
} from "@/src/domain/entities/Collaboration";
import type {
  CommentThreadListQuery,
  CommentThreadRepository,
  CreateCommentThreadInput,
} from "@/src/application/ports/workspaces/CommentThreadRepository";

function toDomain(row: ThreadRow): CommentThread {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    documentId: row.documentId,
    versionId: row.versionId,
    // A row written by another build may hold a type or status this build does
    // not know. Both degrade to the safest reading — document scope, still open
    // — rather than being trusted or failing the listing.
    anchorType: (isCommentAnchorType(row.anchorType)
      ? row.anchorType
      : "document") as CommentAnchorType,
    anchor: parseAnchor(row.anchor),
    anchorSchemaVersion:
      Number.isFinite(row.anchorSchemaVersion) && row.anchorSchemaVersion >= 1
        ? Math.trunc(row.anchorSchemaVersion)
        : 1,
    pageNumber: row.pageNumber,
    status: (isCommentThreadStatus(row.status) ? row.status : "open") as CommentThreadStatus,
    createdById: row.createdById,
    resolvedById: row.resolvedById,
    resolvedAt: row.resolvedAt === null ? null : new Date(row.resolvedAt),
    revision: Number.isFinite(row.revision) && row.revision >= 1 ? Math.trunc(row.revision) : 1,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

/**
 * SQLite-backed CommentThreadRepository.
 *
 * Every predicate carries `workspaceId`, so a thread addressed from another
 * Workspace reads as missing. Status changes are compare-and-swap on `revision`,
 * and a lost race is indistinguishable from a missing row on purpose — a caller
 * must not be able to probe for a thread by watching which error comes back.
 */
export class PrismaCommentThreadRepository implements CommentThreadRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateCommentThreadInput): Promise<CommentThread> {
    const row = await this.prisma.commentThread.create({
      data: {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        versionId: input.versionId,
        anchorType: input.anchorType,
        anchor: input.anchor,
        anchorSchemaVersion: input.anchorSchemaVersion,
        pageNumber: input.pageNumber,
        createdById: input.createdById,
      },
    });
    return toDomain(row);
  }

  async getById(workspaceId: string, threadId: string): Promise<CommentThread | null> {
    const row = await this.prisma.commentThread.findFirst({
      where: { id: threadId, workspaceId },
    });
    return row ? toDomain(row) : null;
  }

  async list(query: CommentThreadListQuery): Promise<CommentThread[]> {
    const rows = await this.prisma.commentThread.findMany({
      where: {
        workspaceId: query.workspaceId,
        documentId: query.documentId,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.pageNumber === undefined ? {} : { pageNumber: query.pageNumber }),
        ...(query.createdBefore === undefined ? {} : { createdAt: { lt: query.createdBefore } }),
      },
      // Newest first, id as a total tie-break: two threads may share a
      // millisecond, and a listing that reorders between reads makes a
      // keyboard-navigated panel jump under the user.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.min(Math.trunc(query.limit), COLLABORATION_LIMITS.maxListLimit),
    });
    return rows.map(toDomain);
  }

  async setStatus(
    workspaceId: string,
    threadId: string,
    expectedRevision: number,
    status: CommentThreadStatus,
    actorId: string,
    resolvedAt: Date | null,
  ): Promise<CommentThread | null> {
    const result = await this.prisma.commentThread.updateMany({
      where: { id: threadId, workspaceId, revision: expectedRevision },
      data: {
        status,
        // Reopening clears the resolution rather than leaving a stale resolver
        // attached to an open thread.
        resolvedById: status === "resolved" ? actorId : null,
        resolvedAt: status === "resolved" ? resolvedAt : null,
        revision: { increment: 1 },
      },
    });
    if (result.count === 0) return null;
    return this.getById(workspaceId, threadId);
  }

  async touch(workspaceId: string, threadId: string): Promise<void> {
    await this.prisma.commentThread.updateMany({
      where: { id: threadId, workspaceId },
      data: { revision: { increment: 1 } },
    });
  }

  async delete(workspaceId: string, threadId: string): Promise<boolean> {
    const result = await this.prisma.commentThread.deleteMany({
      where: { id: threadId, workspaceId },
    });
    return result.count > 0;
  }

  async countForDocument(workspaceId: string, documentId: string): Promise<number> {
    return this.prisma.commentThread.count({ where: { workspaceId, documentId } });
  }
}
