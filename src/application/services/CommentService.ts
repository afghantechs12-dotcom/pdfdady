import type { ILogger } from "@/src/application/ports/Logger";
import type { ActorContext, WorkspaceService } from "./WorkspaceService";
import type { DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";
import type { CommentThreadRepository } from "@/src/application/ports/workspaces/CommentThreadRepository";
import type { CommentMessageRepository } from "@/src/application/ports/workspaces/CommentMessageRepository";
import type { DocumentPermissionGrantRepository } from "@/src/application/ports/workspaces/DocumentPermissionGrantRepository";
import type {
  CommentAnchor,
  CommentMessage,
  CommentThread,
  CommentThreadStatus,
  DocumentPermissionGrant,
  DocumentPermissionRole,
} from "@/src/domain/entities/Collaboration";
import {
  COLLABORATION_LIMITS,
  anchorPageNumber,
  collaborationListLimit,
  isBoundedCollaborationId,
  isDocumentPermissionRole,
  isGrantActive,
  roleAllowsComment,
  serializeAnchor,
  validateAnchor,
  validateCommentBody,
  validateGrantExpiry,
} from "@/src/domain/entities/Collaboration";
import type { DocumentRecord } from "@/src/domain/entities/DocumentRecord";
import type { WorkspaceRole } from "@/src/domain/entities/WorkspaceMembership";
import { workspaceRoleHasCapability } from "@/src/domain/entities/WorkspaceRole";
import { DomainError, NotFoundError } from "@/src/domain/errors";

/**
 * What an actor may do with one document's collaboration surface.
 *
 * Resolved once per operation and passed down, rather than re-derived at each
 * step: a capability that is recomputed in three places is a capability that can
 * disagree with itself.
 */
export interface CollaborationAccess {
  document: DocumentRecord;
  organizationId: string;
  /** Workspace membership role, when the actor is a member. */
  workspaceRole: WorkspaceRole | null;
  /** The grant that was used, when access came from one. */
  grant: DocumentPermissionGrant | null;
  canRead: boolean;
  canComment: boolean;
  /** Whether the actor may share the document with others. */
  canShare: boolean;
  /** Whether the actor may resolve or reopen anyone's thread. */
  canModerate: boolean;
}

/** A thread together with the messages a caller asked for. */
export interface CommentThreadWithMessages {
  thread: CommentThread;
  messages: CommentMessage[];
  /** True when the thread's anchor was authored against an older version. */
  stale: boolean;
}

export interface ListThreadsOptions {
  status?: CommentThreadStatus;
  pageNumber?: number;
  limit?: number;
  /** Exclusive cursor: threads created strictly before this ISO instant. */
  cursor?: string;
}

export interface ListThreadsResult {
  threads: CommentThread[];
  /** Opaque continuation cursor, or null at the end of the listing. */
  nextCursor: string | null;
}

/** A listing whose rows carry their conversation, for a panel that renders it. */
export interface ListThreadsWithMessagesResult {
  threads: CommentThreadWithMessages[];
  nextCursor: string | null;
}

/**
 * M7.10 comments, sharing and asynchronous collaboration.
 *
 * Three properties govern every method here.
 *
 * **Authorization runs before any row is read.** `authorize` resolves the
 * Workspace, then the DocumentRecord within it, then any grant — in that order.
 * A thread, message or grant can therefore never confirm a document the actor
 * cannot already see: a document outside the Workspace reads as *missing*, never
 * as forbidden, because "forbidden" tells a prober that the id is real.
 *
 * **Grants add, never override.** A DocumentPermissionGrant can only widen
 * access to one document inside the Workspace and organization that already
 * contain it. It is re-evaluated on every use (`isGrantActive`), so revocation
 * and expiry take effect at the next call rather than at the next login. A grant
 * cannot confer moderation or sharing rights, and cannot survive the Workspace
 * denying access — that precedence lives in WorkspaceService and is not
 * second-guessed here.
 *
 * **Bodies are plain text.** Nothing in this service stores, accepts or emits
 * HTML. Bodies are validated as text and rendered as React text nodes, so markup
 * in a comment is content rather than a threat. There is deliberately no
 * sanitizer: a sanitizer is a filter that can be wrong, a text node cannot
 * execute.
 *
 * M7 scope is *asynchronous* collaboration. There is no CRDT, no operational
 * transform and no live shared editing state. Concurrency is optimistic: every
 * mutation carries the revision it expects, and a losing writer is told to
 * refetch rather than having its write merged.
 */
export class CommentService {
  constructor(
    private readonly logger: ILogger,
    private readonly workspaces: WorkspaceService,
    private readonly documents: DocumentRecordRepository,
    private readonly threads: CommentThreadRepository,
    private readonly messages: CommentMessageRepository,
    private readonly grants: DocumentPermissionGrantRepository,
    /** Injected so tests can pin time without touching the system clock. */
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // ---- authorization -------------------------------------------------------

  /**
   * Resolves what the actor may do with one document.
   *
   * The order matters and is load-bearing. The Workspace is authorized first, so
   * a caller with no access to it learns nothing about the document. The
   * document is resolved within the Workspace, so a cross-Workspace id reads as
   * missing. Only then is a grant consulted, and only to *widen* what the
   * membership already allowed.
   */
  async authorize(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    options: { write?: boolean } = {},
  ): Promise<CollaborationAccess> {
    if (!isBoundedCollaborationId(workspaceId)) {
      throw new DomainError("A valid workspace id is required.");
    }
    if (!isBoundedCollaborationId(documentId)) {
      throw new DomainError("A valid document id is required.");
    }

    // Workspace membership first, and it must succeed. A non-member may hold a
    // document grant, but a grant cannot rescue a Workspace the actor cannot
    // resolve at all — there would be no organization to scope it to, and a
    // grant is only ever allowed to widen access *within* a Workspace. So this
    // throw propagates: NotFound for a Workspace in another organization, which
    // keeps a probe from confirming that it exists.
    const workspaceAccess = await this.workspaces.get(actor, workspaceId, false);
    const workspaceRole: WorkspaceRole | null = workspaceAccess.role;
    const organizationId: string | null = workspaceAccess.workspace.organizationId;

    const document = await this.documents.getById(workspaceId, documentId);
    if (!document) throw new NotFoundError("Document not found in this workspace.");

    // A trashed document is not a collaboration surface. Its threads are
    // retained, but new conversation on it would be invisible to everyone.
    const documentActive = document.lifecycleState !== "trashed";

    const grant = await this.grants.findActiveForUser(
      workspaceId,
      documentId,
      actor.userId,
      this.clock(),
    );
    // Re-checked here rather than trusted from the query, so a stale row or a
    // clock skew in the adapter cannot widen access.
    const liveGrant = grant !== null && isGrantActive(grant, this.clock()) ? grant : null;

    // A `commenter` membership is exactly the role that may comment without
    // being able to edit the document, so it belongs here alongside the two
    // stronger roles. A `viewer` may read the conversation and add nothing.
    const memberCanComment =
      workspaceRole === "owner" || workspaceRole === "editor" || workspaceRole === "commenter";
    const grantCanComment = liveGrant !== null && roleAllowsComment(liveGrant.role);

    const access: CollaborationAccess = {
      document,
      organizationId: organizationId ?? document.organizationId,
      workspaceRole,
      grant: liveGrant,
      canRead: workspaceRole !== null || liveGrant !== null,
      canComment: documentActive && (memberCanComment || grantCanComment),
      // Sharing and moderation are Workspace authorities. A grant can never
      // confer either: a shared-with user who could re-share would make
      // revocation unenforceable, and one who could resolve others' threads
      // would moderate a conversation they were merely invited to.
      //
      // Sharing maps to the existing owner-only `workspace:manage-members`
      // capability rather than to a new rule, because granting document access
      // to a person is member management by another name. An organization admin
      // inherits `editor` (INHERITED_WORKSPACE_ROLE) and so does not acquire it
      // — inherited administration must not silently gain owner-only powers.
      canShare:
        workspaceRole !== null &&
        workspaceRoleHasCapability(workspaceRole, "workspace:manage-members"),
      canModerate: workspaceRole === "owner" || workspaceRole === "editor",
    };

    if (!access.canRead) throw new NotFoundError("Document not found in this workspace.");
    if (options.write === true && !access.canComment) {
      throw new DomainError("Commenting is not permitted on this document.");
    }
    return access;
  }

  /** Resolves a thread inside an already-authorized document. */
  private async requireThread(
    workspaceId: string,
    documentId: string,
    threadId: string,
  ): Promise<CommentThread> {
    if (!isBoundedCollaborationId(threadId)) {
      throw new DomainError("A valid thread id is required.");
    }
    const thread = await this.threads.getById(workspaceId, threadId);
    // The document check is what stops a thread id from one document being used
    // to read or mutate through another document the actor *can* see.
    if (!thread || thread.documentId !== documentId) {
      throw new NotFoundError("Comment thread not found.");
    }
    return thread;
  }

  // ---- threads -------------------------------------------------------------

  /**
   * Creates a thread and its first message together.
   *
   * One call, because a thread with no messages is not a conversation — it is a
   * pin nobody can read, and it would be visible to everyone else in that state
   * if the second call failed. The message is written first so that a failure
   * leaves nothing rather than an empty thread.
   */
  async createThread(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    input: { anchor: unknown; body: unknown; versionId?: unknown },
  ): Promise<CommentThreadWithMessages> {
    const access = await this.authorize(actor, workspaceId, documentId, { write: true });

    const anchorResult = validateAnchor(input.anchor);
    if (!anchorResult.ok) throw new DomainError(anchorResult.reason);
    const anchor = anchorResult.anchor;

    const body = validateCommentBody(input.body);
    if (body === null) {
      throw new DomainError(
        `A comment body is required and may be at most ${COLLABORATION_LIMITS.maxBodyLength} characters.`,
      );
    }

    let versionId: string | null;
    if (input.versionId !== undefined && input.versionId !== null) {
      if (!isBoundedCollaborationId(input.versionId)) {
        throw new DomainError("A valid version id is required.");
      }
      versionId = input.versionId;
    } else {
      // Defaulting to the document's current version is what makes staleness
      // detectable later: a thread with no version can never be known to have
      // been written against an older one.
      versionId = access.document.currentVersionId ?? null;
    }

    const existing = await this.threads.countForDocument(workspaceId, documentId);
    if (existing >= COLLABORATION_LIMITS.maxThreadsPerDocument) {
      throw new DomainError(
        `This document has reached its limit of ${COLLABORATION_LIMITS.maxThreadsPerDocument} comment threads.`,
      );
    }

    const thread = await this.threads.create({
      organizationId: access.organizationId,
      workspaceId,
      documentId,
      versionId,
      anchorType: anchor.type,
      anchor: serializeAnchor(anchor),
      anchorSchemaVersion: COLLABORATION_LIMITS.anchorSchemaVersion,
      pageNumber: anchorPageNumber(anchor),
      createdById: actor.userId,
    });

    let message: CommentMessage;
    try {
      message = await this.messages.create({
        organizationId: access.organizationId,
        workspaceId,
        documentId,
        threadId: thread.id,
        authorId: actor.userId,
        parentMessageId: null,
        body,
      });
    } catch (error) {
      // Roll the thread back rather than leaving a pin with no words in it.
      await this.threads.delete(workspaceId, thread.id).catch(() => false);
      throw error;
    }

    this.logger.info("Comment thread created", {
      workspaceId,
      documentId,
      threadId: thread.id,
      anchorType: anchor.type,
    });

    return { thread, messages: [message], stale: this.isStale(thread, access.document) };
  }

  /** A document's threads, newest first, with a bounded cursor. */
  async listThreads(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    options: ListThreadsOptions = {},
  ): Promise<ListThreadsResult> {
    await this.authorize(actor, workspaceId, documentId);

    const limit = collaborationListLimit(options.limit);
    let createdBefore: Date | undefined;
    if (options.cursor !== undefined && options.cursor !== "") {
      const parsed = new Date(options.cursor);
      // A malformed cursor is refused rather than ignored: silently returning
      // the first page would make a paging client loop forever.
      if (Number.isNaN(parsed.getTime())) throw new DomainError("The pagination cursor is not valid.");
      createdBefore = parsed;
    }

    let pageNumber: number | undefined;
    if (options.pageNumber !== undefined) {
      if (
        !Number.isInteger(options.pageNumber) ||
        options.pageNumber < 1 ||
        options.pageNumber > COLLABORATION_LIMITS.maxPageNumber
      ) {
        throw new DomainError("The page filter is not valid.");
      }
      pageNumber = options.pageNumber;
    }

    // One extra row decides whether another page exists, without a second query
    // and without reporting a total the caller would have to trust.
    const rows = await this.threads.list({
      workspaceId,
      documentId,
      status: options.status,
      pageNumber,
      createdBefore,
      limit: Math.min(limit + 1, COLLABORATION_LIMITS.maxListLimit),
    });

    const threads = rows.slice(0, limit);
    const nextCursor =
      rows.length > limit && threads.length > 0
        ? threads[threads.length - 1].createdAt.toISOString()
        : null;
    return { threads, nextCursor };
  }

  /**
   * The listing plus each thread's messages.
   *
   * Exists because the panel renders a thread's conversation inline, so a
   * summary-only listing left it with no messages to render at all. The
   * alternative — the client fetching `/comments/{id}` per row — is exactly the
   * N+1 the comments work set out to avoid, and it would put the author-name
   * resolution back on the client.
   *
   * Messages are read per thread (the repository is keyed by `threadId`) but the
   * reads are issued CONCURRENTLY and the listing is already bounded by
   * `collaborationListLimit`, so this is a bounded fan-out rather than an
   * unbounded loop. Author identities are resolved once for the whole payload by
   * the route, not once per thread.
   */
  async listThreadsWithMessages(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    options: ListThreadsOptions = {},
  ): Promise<ListThreadsWithMessagesResult> {
    const access = await this.authorize(actor, workspaceId, documentId);
    const { threads, nextCursor } = await this.listThreads(actor, workspaceId, documentId, options);
    const entries = await Promise.all(
      threads.map(async (thread) => ({
        thread,
        messages: await this.messages.list({
          workspaceId,
          threadId: thread.id,
          limit: collaborationListLimit(undefined),
        }),
        stale: this.isStale(thread, access.document),
      })),
    );
    return { threads: entries, nextCursor };
  }

  /** One thread with its messages. */
  async getThread(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    threadId: string,
    options: { limit?: number } = {},
  ): Promise<CommentThreadWithMessages> {
    const access = await this.authorize(actor, workspaceId, documentId);
    const thread = await this.requireThread(workspaceId, documentId, threadId);
    const messages = await this.messages.list({
      workspaceId,
      threadId: thread.id,
      limit: collaborationListLimit(options.limit),
    });
    return { thread, messages, stale: this.isStale(thread, access.document) };
  }

  /**
   * Whether a thread's anchor was authored against a version other than the
   * document's current one. Reported rather than corrected: the coordinates
   * still describe the version they were written on, and silently re-pointing
   * them would move a user's comment to a place they never chose.
   */
  private isStale(thread: CommentThread, document: DocumentRecord): boolean {
    if (thread.versionId === null) return false;
    if (document.currentVersionId === null) return false;
    return thread.versionId !== document.currentVersionId;
  }

  /** Resolves a thread. */
  async resolveThread(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    threadId: string,
    expectedRevision: number,
  ): Promise<CommentThread> {
    return this.setThreadStatus(actor, workspaceId, documentId, threadId, expectedRevision, "resolved");
  }

  /** Reopens a resolved thread. */
  async reopenThread(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    threadId: string,
    expectedRevision: number,
  ): Promise<CommentThread> {
    return this.setThreadStatus(actor, workspaceId, documentId, threadId, expectedRevision, "open");
  }

  private async setThreadStatus(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    threadId: string,
    expectedRevision: number,
    status: CommentThreadStatus,
  ): Promise<CommentThread> {
    const access = await this.authorize(actor, workspaceId, documentId, { write: true });
    const thread = await this.requireThread(workspaceId, documentId, threadId);

    // The thread's author may always settle their own thread; anyone else needs
    // moderation rights. A commenter invited by a grant can contribute but
    // cannot close a conversation they did not start.
    if (!access.canModerate && thread.createdById !== actor.userId) {
      throw new DomainError("Only the thread author or a workspace editor may change its status.");
    }

    const updated = await this.threads.setStatus(
      workspaceId,
      threadId,
      this.requireRevision(expectedRevision),
      status,
      actor.userId,
      status === "resolved" ? this.clock() : null,
    );
    if (!updated) {
      throw new DomainError(
        "This thread changed since it was loaded. Refresh to see the current state.",
      );
    }
    this.logger.info("Comment thread status changed", { workspaceId, threadId, status });
    return updated;
  }

  // ---- messages ------------------------------------------------------------

  /** Adds a message, optionally as a reply to an existing one. */
  async addMessage(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    threadId: string,
    input: { body: unknown; parentMessageId?: unknown },
  ): Promise<CommentMessage> {
    const access = await this.authorize(actor, workspaceId, documentId, { write: true });
    const thread = await this.requireThread(workspaceId, documentId, threadId);

    const body = validateCommentBody(input.body);
    if (body === null) {
      throw new DomainError(
        `A comment body is required and may be at most ${COLLABORATION_LIMITS.maxBodyLength} characters.`,
      );
    }

    let parentMessageId: string | null = null;
    if (input.parentMessageId !== undefined && input.parentMessageId !== null) {
      if (!isBoundedCollaborationId(input.parentMessageId)) {
        throw new DomainError("A valid parent message id is required.");
      }
      const parent = await this.messages.getById(workspaceId, input.parentMessageId);
      // Same-thread check: a parent id from another thread would graft this
      // reply onto a conversation the caller may not even be able to see.
      if (!parent || parent.threadId !== thread.id) {
        throw new NotFoundError("The message being replied to was not found.");
      }
      if (parent.deletedAt !== null) {
        throw new DomainError("This message has been deleted and cannot receive replies.");
      }
      // One level of nesting. Threads are already the grouping construct, so
      // deeper nesting adds a tree to render and a cycle to guard for nothing.
      if (parent.parentMessageId !== null) {
        throw new DomainError("Replies may not be nested further.");
      }
      parentMessageId = parent.id;
    }

    const count = await this.messages.countForThread(workspaceId, thread.id);
    if (count >= COLLABORATION_LIMITS.maxMessagesPerThread) {
      throw new DomainError(
        `This thread has reached its limit of ${COLLABORATION_LIMITS.maxMessagesPerThread} messages.`,
      );
    }

    const message = await this.messages.create({
      organizationId: access.organizationId,
      workspaceId,
      documentId,
      threadId: thread.id,
      authorId: actor.userId,
      parentMessageId,
      body,
    });

    // Surfaces the new activity on the thread so a listing ordered by update
    // time reflects the conversation rather than only its creation.
    await this.threads.touch(workspaceId, thread.id);
    return message;
  }

  /** A thread's messages, oldest first. */
  async listMessages(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    threadId: string,
    options: { limit?: number; since?: string } = {},
  ): Promise<CommentMessage[]> {
    await this.authorize(actor, workspaceId, documentId);
    const thread = await this.requireThread(workspaceId, documentId, threadId);

    let createdAfter: Date | undefined;
    if (options.since !== undefined && options.since !== "") {
      const parsed = new Date(options.since);
      if (Number.isNaN(parsed.getTime())) throw new DomainError("The 'since' value is not valid.");
      createdAfter = parsed;
    }

    return this.messages.list({
      workspaceId,
      threadId: thread.id,
      createdAfter,
      limit: collaborationListLimit(options.limit),
    });
  }

  /**
   * Edits a message. Authorship is required — not moderation.
   *
   * A moderator who could rewrite someone else's words could put statements in
   * their mouth under their name, which no amount of audit logging makes
   * acceptable. Moderators remove; only authors edit.
   */
  async editMessage(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    threadId: string,
    messageId: string,
    input: { body: unknown; expectedRevision: number },
  ): Promise<CommentMessage> {
    await this.authorize(actor, workspaceId, documentId, { write: true });
    const thread = await this.requireThread(workspaceId, documentId, threadId);
    const message = await this.requireMessage(workspaceId, thread.id, messageId);

    if (message.authorId !== actor.userId) {
      throw new DomainError("Only the author may edit this comment.");
    }
    if (message.deletedAt !== null) {
      throw new DomainError("This comment has been deleted and cannot be edited.");
    }

    const body = validateCommentBody(input.body);
    if (body === null) {
      throw new DomainError(
        `A comment body is required and may be at most ${COLLABORATION_LIMITS.maxBodyLength} characters.`,
      );
    }

    const updated = await this.messages.updateBody(
      workspaceId,
      messageId,
      this.requireRevision(input.expectedRevision),
      body,
      this.clock(),
    );
    if (!updated) {
      throw new DomainError(
        "This comment changed since it was loaded. Refresh to see the current text.",
      );
    }
    return updated;
  }

  /**
   * Deletes a message. The author may always delete their own; a moderator may
   * delete anyone's, which is the asymmetry with editing.
   */
  async deleteMessage(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    threadId: string,
    messageId: string,
    expectedRevision: number,
  ): Promise<CommentMessage> {
    const access = await this.authorize(actor, workspaceId, documentId, { write: true });
    const thread = await this.requireThread(workspaceId, documentId, threadId);
    const message = await this.requireMessage(workspaceId, thread.id, messageId);

    if (message.authorId !== actor.userId && !access.canModerate) {
      throw new DomainError("Only the author or a workspace editor may delete this comment.");
    }
    if (message.deletedAt !== null) {
      // Already gone. Reporting success would be a lie about what this call did.
      throw new DomainError("This comment has already been deleted.");
    }

    const deleted = await this.messages.softDelete(
      workspaceId,
      messageId,
      this.requireRevision(expectedRevision),
      actor.userId,
      this.clock(),
    );
    if (!deleted) {
      throw new DomainError(
        "This comment changed since it was loaded. Refresh to see the current state.",
      );
    }
    this.logger.info("Comment message deleted", { workspaceId, threadId, messageId });
    return deleted;
  }

  private async requireMessage(
    workspaceId: string,
    threadId: string,
    messageId: string,
  ): Promise<CommentMessage> {
    if (!isBoundedCollaborationId(messageId)) {
      throw new DomainError("A valid message id is required.");
    }
    const message = await this.messages.getById(workspaceId, messageId);
    if (!message || message.threadId !== threadId) {
      throw new NotFoundError("Comment not found.");
    }
    return message;
  }

  private requireRevision(value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new DomainError("A valid revision is required.");
    }
    return value;
  }

  // ---- permission grants ---------------------------------------------------

  /** The document's grants, newest first. */
  async listGrants(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    options: { includeRevoked?: boolean; limit?: number } = {},
  ): Promise<DocumentPermissionGrant[]> {
    const access = await this.authorize(actor, workspaceId, documentId);
    // Who else can see a document is itself sensitive: a commenter invited by a
    // share should not be able to enumerate the other people it was shared with.
    if (!access.canShare) {
      throw new DomainError("Viewing document sharing requires workspace administration.");
    }
    return this.grants.list({
      workspaceId,
      documentId,
      activeOnly: options.includeRevoked === true ? false : true,
      limit: collaborationListLimit(options.limit),
    });
  }

  /**
   * Shares a document with a user.
   *
   * A repeat share for the same grantee updates the existing grant rather than
   * stacking a second one: two live grants for one person would each have to be
   * revoked separately, and missing one would leave access nobody could see in
   * the list they just cleared.
   */
  async createGrant(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    input: { granteeUserId: unknown; role: unknown; expiresAt?: unknown },
  ): Promise<DocumentPermissionGrant> {
    const access = await this.authorize(actor, workspaceId, documentId);
    if (!access.canShare) {
      throw new DomainError("Sharing this document requires workspace administration.");
    }

    if (!isBoundedCollaborationId(input.granteeUserId)) {
      throw new DomainError("A valid user id is required.");
    }
    const granteeUserId = input.granteeUserId;
    if (granteeUserId === actor.userId) {
      // Self-granting is either a no-op or an attempt to manufacture a
      // capability that outlives the membership it was issued from.
      throw new DomainError("A document cannot be shared with its own grantor.");
    }
    if (!isDocumentPermissionRole(input.role)) {
      throw new DomainError("The permission role is not supported.");
    }
    const role = input.role;

    const now = this.clock();
    const expiry = validateGrantExpiry(input.expiresAt, now);
    if (expiry === null) {
      throw new DomainError("The expiry must be a future date within the maximum grant lifetime.");
    }
    const expiresAt = expiry ?? null;

    const existing = await this.grants.findLiveForUser(workspaceId, documentId, granteeUserId);
    if (existing) {
      const updated = await this.grants.update(workspaceId, existing.id, existing.revision, {
        role,
        expiresAt,
      });
      if (!updated) {
        throw new DomainError(
          "This share changed since it was loaded. Refresh to see the current state.",
        );
      }
      this.logger.info("Document share updated", { workspaceId, documentId, grantId: updated.id });
      return updated;
    }

    const active = await this.grants.countActiveForDocument(workspaceId, documentId, now);
    if (active >= COLLABORATION_LIMITS.maxGrantsPerDocument) {
      throw new DomainError(
        `This document has reached its limit of ${COLLABORATION_LIMITS.maxGrantsPerDocument} active shares.`,
      );
    }

    const grant = await this.grants.create({
      organizationId: access.organizationId,
      workspaceId,
      documentId,
      granteeUserId,
      role,
      grantedById: actor.userId,
      expiresAt,
    });
    this.logger.info("Document shared", { workspaceId, documentId, grantId: grant.id, role });
    return grant;
  }

  /**
   * Revokes a grant. Takes effect at the next authorization call, because
   * `authorize` re-reads grants rather than trusting a cached decision.
   */
  async revokeGrant(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    grantId: string,
  ): Promise<DocumentPermissionGrant> {
    const access = await this.authorize(actor, workspaceId, documentId);
    if (!access.canShare) {
      throw new DomainError("Revoking a share requires workspace administration.");
    }
    if (!isBoundedCollaborationId(grantId)) {
      throw new DomainError("A valid grant id is required.");
    }

    const existing = await this.grants.getById(workspaceId, grantId);
    // The document check stops a grant id belonging to another document from
    // being revoked through one the actor happens to administer.
    if (!existing || existing.documentId !== documentId) {
      throw new NotFoundError("Share not found.");
    }

    const revoked = await this.grants.revoke(workspaceId, grantId, actor.userId, this.clock());
    if (!revoked) throw new NotFoundError("Share not found.");
    this.logger.info("Document share revoked", { workspaceId, documentId, grantId });
    return revoked;
  }

  /** The role a grant currently confers on a user, or null when none does. */
  async effectiveGrantRole(
    workspaceId: string,
    documentId: string,
    userId: string,
  ): Promise<DocumentPermissionRole | null> {
    const grant = await this.grants.findActiveForUser(
      workspaceId,
      documentId,
      userId,
      this.clock(),
    );
    return grant !== null && isGrantActive(grant, this.clock()) ? grant.role : null;
  }
}

export type { CommentAnchor, CommentMessage, CommentThread };
