import type { PrismaClient, CommentMessage as MessageRow } from "@prisma/client";
import type { CommentMessage } from "@/src/domain/entities/Collaboration";
import { COLLABORATION_LIMITS } from "@/src/domain/entities/Collaboration";
import type {
  CommentMessageListQuery,
  CommentMessageRepository,
  CreateCommentMessageInput,
} from "@/src/application/ports/workspaces/CommentMessageRepository";

function toDomain(row: MessageRow): CommentMessage {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    documentId: row.documentId,
    threadId: row.threadId,
    authorId: row.authorId,
    parentMessageId: row.parentMessageId,
    body: row.body,
    revision: Number.isFinite(row.revision) && row.revision >= 1 ? Math.trunc(row.revision) : 1,
    editedAt: row.editedAt === null ? null : new Date(row.editedAt),
    deletedAt: row.deletedAt === null ? null : new Date(row.deletedAt),
    deletedById: row.deletedById,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

/**
 * SQLite-backed CommentMessageRepository.
 *
 * Every predicate carries `workspaceId`. Edits and deletions are
 * compare-and-swap on `revision`, and both refuse to act on an already-deleted
 * message: an edit that could resurrect a deleted body would undo a removal the
 * author asked for.
 */
export class PrismaCommentMessageRepository implements CommentMessageRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateCommentMessageInput): Promise<CommentMessage> {
    const row = await this.prisma.commentMessage.create({
      data: {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        threadId: input.threadId,
        authorId: input.authorId,
        parentMessageId: input.parentMessageId,
        body: input.body,
      },
    });
    return toDomain(row);
  }

  async getById(workspaceId: string, messageId: string): Promise<CommentMessage | null> {
    const row = await this.prisma.commentMessage.findFirst({
      where: { id: messageId, workspaceId },
    });
    return row ? toDomain(row) : null;
  }

  async list(query: CommentMessageListQuery): Promise<CommentMessage[]> {
    const rows = await this.prisma.commentMessage.findMany({
      where: {
        workspaceId: query.workspaceId,
        threadId: query.threadId,
        ...(query.createdAfter === undefined ? {} : { createdAt: { gt: query.createdAfter } }),
      },
      // Oldest first: a conversation reads forwards. Id breaks ties totally.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: Math.min(Math.trunc(query.limit), COLLABORATION_LIMITS.maxListLimit),
    });
    return rows.map(toDomain);
  }

  async updateBody(
    workspaceId: string,
    messageId: string,
    expectedRevision: number,
    body: string,
    editedAt: Date,
  ): Promise<CommentMessage | null> {
    const result = await this.prisma.commentMessage.updateMany({
      // `deletedAt: null` is part of the predicate, not a check afterwards: it
      // has to be atomic with the write, or a concurrent delete could land
      // between the read and the update and be silently reversed.
      where: { id: messageId, workspaceId, revision: expectedRevision, deletedAt: null },
      data: { body, editedAt, revision: { increment: 1 } },
    });
    if (result.count === 0) return null;
    return this.getById(workspaceId, messageId);
  }

  async softDelete(
    workspaceId: string,
    messageId: string,
    expectedRevision: number,
    actorId: string,
    deletedAt: Date,
  ): Promise<CommentMessage | null> {
    const result = await this.prisma.commentMessage.updateMany({
      where: { id: messageId, workspaceId, revision: expectedRevision, deletedAt: null },
      // The body is cleared in the same write as the tombstone: "deleted" has to
      // actually remove the words, not hide them behind a flag that a later read
      // path might forget to honour.
      data: { body: "", deletedAt, deletedById: actorId, revision: { increment: 1 } },
    });
    if (result.count === 0) return null;
    return this.getById(workspaceId, messageId);
  }

  async countForThread(workspaceId: string, threadId: string): Promise<number> {
    return this.prisma.commentMessage.count({ where: { workspaceId, threadId } });
  }

  async hasReplies(workspaceId: string, messageId: string): Promise<boolean> {
    const count = await this.prisma.commentMessage.count({
      where: { workspaceId, parentMessageId: messageId },
    });
    return count > 0;
  }

  async deleteForThread(workspaceId: string, threadId: string): Promise<number> {
    const result = await this.prisma.commentMessage.deleteMany({
      where: { workspaceId, threadId },
    });
    return result.count;
  }
}
