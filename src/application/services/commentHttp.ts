import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { CommentService } from "./CommentService";
import type {
  CommentMessage,
  CommentThread,
  DocumentPermissionGrant,
} from "@/src/domain/entities/Collaboration";
import { describeAnchor } from "@/src/domain/entities/Collaboration";
import {
  memberDisplayName,
  memberIdentities,
  memberInitials,
  withCreatedByIdentities,
} from "@/src/application/services/memberDirectory";

export function commentService(): CommentService {
  return appContainer.resolve<CommentService>(Tokens.CommentService);
}

/**
 * Serializes a thread for the wire.
 *
 * `organizationId` is deliberately absent: it is a tenant handle the client
 * already knows from its own session, and echoing it back on every row only
 * widens what a mis-scoped response could disclose. The anchor is emitted as
 * validated structure plus a human label, so a client never has to parse the
 * stored JSON itself.
 */
export function toCommentThreadResponse(thread: CommentThread, stale = false) {
  return {
    id: thread.id,
    workspaceId: thread.workspaceId,
    documentId: thread.documentId,
    versionId: thread.versionId,
    anchorType: thread.anchorType,
    anchor: thread.anchor,
    anchorLabel: describeAnchor(thread.anchor),
    anchorSchemaVersion: thread.anchorSchemaVersion,
    pageNumber: thread.pageNumber,
    status: thread.status,
    /** True when the anchor was authored against an older version. */
    stale,
    createdById: thread.createdById,
    resolvedById: thread.resolvedById,
    resolvedAt: thread.resolvedAt === null ? null : thread.resolvedAt.toISOString(),
    revision: thread.revision,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

/**
 * Serializes a message.
 *
 * A deleted message keeps its position and its identity but carries no body:
 * the row survives so replies beneath it do not become orphans, and the words
 * are gone because that is what deletion means. `deleted` is reported explicitly
 * so a client renders a tombstone rather than an empty comment.
 */
export function toCommentMessageResponse(message: CommentMessage) {
  const deleted = message.deletedAt !== null;
  return {
    id: message.id,
    threadId: message.threadId,
    documentId: message.documentId,
    authorId: message.authorId,
    parentMessageId: message.parentMessageId,
    // Plain text. Never HTML, and never escaped here — the client renders it as
    // a text node, and escaping at this layer would double-escape at render.
    body: deleted ? "" : message.body,
    deleted,
    edited: message.editedAt !== null,
    editedAt: message.editedAt === null ? null : message.editedAt.toISOString(),
    deletedAt: message.deletedAt === null ? null : message.deletedAt.toISOString(),
    revision: message.revision,
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
  };
}

/**
 * Serializes a permission grant.
 *
 * `active` is computed rather than left to the client: expiry is a comparison
 * against the server's clock, and a client that decided for itself would show a
 * share as live for as long as its own clock was wrong.
 */export function toDocumentPermissionGrantResponse(
  grant: DocumentPermissionGrant,
  now: Date = new Date(),
) {
  const expired = grant.expiresAt !== null && grant.expiresAt.getTime() <= now.getTime();
  return {
    id: grant.id,
    workspaceId: grant.workspaceId,
    documentId: grant.documentId,
    granteeUserId: grant.granteeUserId,
    role: grant.role,
    grantedById: grant.grantedById,
    expiresAt: grant.expiresAt === null ? null : grant.expiresAt.toISOString(),
    revokedAt: grant.revokedAt === null ? null : grant.revokedAt.toISOString(),
    revokedById: grant.revokedById,
    active: grant.revokedAt === null && !expired,
    expired,
    revision: grant.revision,
    createdAt: grant.createdAt.toISOString(),
    updatedAt: grant.updatedAt.toISOString(),
  };
}

/**
 * Attaches author display identities to a page of serialized messages.
 *
 * WHY THIS IS A SEPARATE STEP: `toCommentMessageResponse` is a pure function
 * over a `CommentMessage`. Making it async and DB-aware to look up a name would
 * push identity resolution into the serializer, where it would run once per
 * message — a 30-message thread issuing 30 queries. This resolves every distinct
 * author in ONE batched query (`memberIdentities`) and then decorates.
 *
 * The panel used to render a raw `authorId` (a cuid) as the author's name, which
 * is an internal identifier shown to a normal user. `memberDisplayName` is the
 * existing precedent for the fallback order — name → email → `Unknown user ·
 * {id}` — and is reused rather than reinvented so every surface that names a
 * person agrees.
 *
 * Best-effort by inheritance: `memberIdentities` returns an empty map on failure,
 * so a directory outage degrades to the id fallback instead of failing the
 * comment list. `authorName` is therefore always a usable string, and
 * `authorEmail` is nullable because not every identity resolves.
 *
 * TENANT SAFETY: this looks up only ids that already appear as authors on
 * messages the caller was authorized to read, so it cannot be used to probe for
 * users outside the caller's scope. Only `{id, email, name}` is selected —
 * never `passwordHash`.
 */
export async function withCommentAuthors<T extends { authorId: string }>(
  messages: T[],
): Promise<Array<T & { authorName: string; authorEmail: string | null; authorInitials: string }>> {
  const identities = await memberIdentities(messages.map((m) => m.authorId));
  return messages.map((message) => {
    const identity = identities.get(message.authorId);
    return {
      ...message,
      authorName: memberDisplayName(identity, message.authorId),
      authorEmail: identity?.email ?? null,
      authorInitials: memberInitials(identity, message.authorId),
    };
  });
}

/**
 * The same treatment for thread creators (H35's author column also needs it).
 *
 * Separate from {@link withCommentAuthors} because a thread's identity field is
 * `createdById`, not `authorId`. The body is now shared with version history via
 * `withCreatedByIdentities`, so a thread author and a version author can never
 * be named by two different fallback orders.
 */
export async function withThreadAuthors<T extends { createdById: string }>(
  threads: T[],
): Promise<Array<T & { createdByName: string; createdByInitials: string }>> {
  return withCreatedByIdentities(threads);
}
