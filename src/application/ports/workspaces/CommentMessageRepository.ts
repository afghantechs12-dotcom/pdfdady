import type { CommentMessage } from "@/src/domain/entities/Collaboration";

export interface CreateCommentMessageInput {
  organizationId: string;
  workspaceId: string;
  documentId: string;
  threadId: string;
  authorId: string;
  parentMessageId: string | null;
  /** Validated plain text. */
  body: string;
}

export interface CommentMessageListQuery {
  workspaceId: string;
  threadId: string;
  limit: number;
  /** Exclusive: return messages created strictly after this instant. */
  createdAfter?: Date;
}

/**
 * Comment messages.
 *
 * Separate from threads because the two have different lifetimes and different
 * authorities: a thread is resolved by whoever has the permission, a message is
 * edited only by its author. Keeping them in one table would make "edit the
 * text" and "move the anchor" the same write.
 *
 * Deletion is soft and is expressed here rather than through `delete`: a removed
 * message keeps its row so replies beneath it do not become orphans, and its
 * body is cleared rather than retained, because "deleted" must actually remove
 * the words. `delete` exists only for removing a whole thread's messages.
 */
export interface CommentMessageRepository {
  create(input: CreateCommentMessageInput): Promise<CommentMessage>;

  getById(workspaceId: string, messageId: string): Promise<CommentMessage | null>;

  /** Oldest first — a conversation reads forwards. Bounded by the domain cap. */
  list(query: CommentMessageListQuery): Promise<CommentMessage[]>;

  /**
   * Compare-and-swap body edit. Returns null when the expected revision no
   * longer matches, the message is absent, or it has been deleted.
   */
  updateBody(
    workspaceId: string,
    messageId: string,
    expectedRevision: number,
    body: string,
    editedAt: Date,
  ): Promise<CommentMessage | null>;

  /** Compare-and-swap soft delete; clears the body in the same write. */
  softDelete(
    workspaceId: string,
    messageId: string,
    expectedRevision: number,
    actorId: string,
    deletedAt: Date,
  ): Promise<CommentMessage | null>;

  countForThread(workspaceId: string, threadId: string): Promise<number>;

  /** Whether any message replies to this one. Guards reply-depth and deletion. */
  hasReplies(workspaceId: string, messageId: string): Promise<boolean>;

  /** Removes every message of a thread. Used when the thread itself is deleted. */
  deleteForThread(workspaceId: string, threadId: string): Promise<number>;
}
