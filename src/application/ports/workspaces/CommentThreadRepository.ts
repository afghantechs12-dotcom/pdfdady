import type {
  CommentAnchorType,
  CommentThread,
  CommentThreadStatus,
} from "@/src/domain/entities/Collaboration";

export interface CreateCommentThreadInput {
  organizationId: string;
  workspaceId: string;
  documentId: string;
  versionId: string | null;
  anchorType: CommentAnchorType;
  /** Pre-serialized, pre-validated anchor JSON. */
  anchor: string;
  anchorSchemaVersion: number;
  /**
   * The anchor's page, derived by the service from the validated anchor. Passed
   * explicitly rather than re-parsed here so the stored column and the stored
   * anchor cannot disagree.
   */
  pageNumber: number | null;
  createdById: string;
}

export interface CommentThreadListQuery {
  workspaceId: string;
  documentId: string;
  /** Absent means "both states". */
  status?: CommentThreadStatus;
  /** Absent means "any page"; a page anchor filter for the current view. */
  pageNumber?: number;
  limit: number;
  /** Exclusive: return threads created strictly before this instant. */
  createdBefore?: Date;
}

/**
 * Comment threads.
 *
 * Every method is addressed by `workspaceId` first — never by thread id alone —
 * so a caller holding an id from another tenant cannot read or mutate through
 * this port. A thread from another Workspace reads as missing rather than as
 * forbidden, because a "forbidden" answer confirms the id exists.
 *
 * Resolution is a compare-and-swap on `revision`, and a lost race is
 * indistinguishable from a missing thread on purpose: a caller must not be able
 * to probe for a thread's existence by watching which error it gets.
 */
export interface CommentThreadRepository {
  create(input: CreateCommentThreadInput): Promise<CommentThread>;

  getById(workspaceId: string, threadId: string): Promise<CommentThread | null>;

  /** Newest first, bounded by the domain listing cap. */
  list(query: CommentThreadListQuery): Promise<CommentThread[]>;

  /**
   * Compare-and-swap status change. Returns null when the expected revision no
   * longer matches *or* the thread is absent.
   */
  setStatus(
    workspaceId: string,
    threadId: string,
    expectedRevision: number,
    status: CommentThreadStatus,
    actorId: string,
    resolvedAt: Date | null,
  ): Promise<CommentThread | null>;

  /** Bumps `updatedAt`/`revision` when a message changes the conversation. */
  touch(workspaceId: string, threadId: string): Promise<void>;

  delete(workspaceId: string, threadId: string): Promise<boolean>;

  countForDocument(workspaceId: string, documentId: string): Promise<number>;
}
