import type { CommentMessage } from "@/src/domain/entities/Collaboration";
import { COLLABORATION_LIMITS } from "@/src/domain/entities/Collaboration";
import type {
  CommentMessageListQuery,
  CommentMessageRepository,
  CreateCommentMessageInput,
} from "@/src/application/ports/workspaces/CommentMessageRepository";

let counter = 0;
function uid(): string {
  counter += 1;
  return `inmem-message-${counter}`;
}

interface StoredMessage {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  threadId: string;
  authorId: string;
  parentMessageId: string | null;
  body: string;
  revision: number;
  editedAt: Date | null;
  deletedAt: Date | null;
  deletedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * In-memory CommentMessageRepository — for tests and as a zero-dependency
 * fallback.
 *
 * Mirrors the Prisma adapter's Workspace scoping, its compare-and-swap edit and
 * soft delete, and its oldest-first ordering. Soft deletion clears the body here
 * exactly as the adapter does, so a test cannot pass against an in-memory store
 * that quietly retains text the database would have erased.
 */
export class InMemoryCommentMessageRepository implements CommentMessageRepository {
  private readonly rows = new Map<string, StoredMessage>();
  private tick = 0;

  private now(): Date {
    this.tick += 1;
    return new Date(Date.UTC(2026, 7, 3, 12, 0, 0, 0) + this.tick * 1000);
  }

  private toDomain(row: StoredMessage): CommentMessage {
    return {
      id: row.id,
      organizationId: row.organizationId,
      workspaceId: row.workspaceId,
      documentId: row.documentId,
      threadId: row.threadId,
      authorId: row.authorId,
      parentMessageId: row.parentMessageId,
      body: row.body,
      revision: row.revision,
      editedAt: row.editedAt === null ? null : new Date(row.editedAt),
      deletedAt: row.deletedAt === null ? null : new Date(row.deletedAt),
      deletedById: row.deletedById,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    };
  }

  /** Oldest first, id as a total tie-break — a conversation reads forwards. */
  private sorted(rows: StoredMessage[]): StoredMessage[] {
    return rows
      .slice()
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  }

  async create(input: CreateCommentMessageInput): Promise<CommentMessage> {
    const now = this.now();
    const row: StoredMessage = {
      id: uid(),
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      threadId: input.threadId,
      authorId: input.authorId,
      parentMessageId: input.parentMessageId,
      body: input.body,
      revision: 1,
      editedAt: null,
      deletedAt: null,
      deletedById: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return this.toDomain(row);
  }

  async getById(workspaceId: string, messageId: string): Promise<CommentMessage | null> {
    const row = this.rows.get(messageId);
    if (!row || row.workspaceId !== workspaceId) return null;
    return this.toDomain(row);
  }

  async list(query: CommentMessageListQuery): Promise<CommentMessage[]> {
    const matching = [...this.rows.values()].filter((row) => {
      if (row.workspaceId !== query.workspaceId) return false;
      if (row.threadId !== query.threadId) return false;
      if (query.createdAfter !== undefined && row.createdAt.getTime() <= query.createdAfter.getTime()) {
        return false;
      }
      return true;
    });
    return this.sorted(matching)
      .slice(0, Math.min(Math.trunc(query.limit), COLLABORATION_LIMITS.maxListLimit))
      .map((row) => this.toDomain(row));
  }

  async updateBody(
    workspaceId: string,
    messageId: string,
    expectedRevision: number,
    body: string,
    editedAt: Date,
  ): Promise<CommentMessage | null> {
    const row = this.rows.get(messageId);
    if (!row || row.workspaceId !== workspaceId) return null;
    if (row.revision !== expectedRevision) return null;
    // A deleted message has no body to edit; restoring one through an edit would
    // resurrect text the author removed.
    if (row.deletedAt !== null) return null;
    row.body = body;
    row.editedAt = editedAt;
    row.revision += 1;
    row.updatedAt = this.now();
    return this.toDomain(row);
  }

  async softDelete(
    workspaceId: string,
    messageId: string,
    expectedRevision: number,
    actorId: string,
    deletedAt: Date,
  ): Promise<CommentMessage | null> {
    const row = this.rows.get(messageId);
    if (!row || row.workspaceId !== workspaceId) return null;
    if (row.revision !== expectedRevision) return null;
    if (row.deletedAt !== null) return null;
    // The body is cleared in the same write: "deleted" has to actually remove
    // the words, not hide them behind a flag a later read might ignore.
    row.body = "";
    row.deletedAt = deletedAt;
    row.deletedById = actorId;
    row.revision += 1;
    row.updatedAt = this.now();
    return this.toDomain(row);
  }

  async countForThread(workspaceId: string, threadId: string): Promise<number> {
    return [...this.rows.values()].filter(
      (row) => row.workspaceId === workspaceId && row.threadId === threadId,
    ).length;
  }

  async hasReplies(workspaceId: string, messageId: string): Promise<boolean> {
    return [...this.rows.values()].some(
      (row) => row.workspaceId === workspaceId && row.parentMessageId === messageId,
    );
  }

  async deleteForThread(workspaceId: string, threadId: string): Promise<number> {
    let removed = 0;
    for (const [id, row] of [...this.rows.entries()]) {
      if (row.workspaceId !== workspaceId || row.threadId !== threadId) continue;
      this.rows.delete(id);
      removed += 1;
    }
    return removed;
  }
}
