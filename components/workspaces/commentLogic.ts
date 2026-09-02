import {
  COLLABORATION_LIMITS,
  DOCUMENT_PERMISSION_ROLES,
  describeAnchor,
  isDocumentPermissionRole,
  validateCommentBody,
  validateGrantExpiry,
  type CommentAnchor,
  type CommentAnchorType,
  type CommentThreadStatus,
  type DocumentPermissionRole,
} from "@/src/domain/entities/Collaboration";

/**
 * Presentation logic for the M7.10 collaboration panels.
 *
 * Separated from the React components so the rules can be tested without a DOM:
 * what a composer accepts, what a thread's status line says, which actions a
 * given viewer may see, and how a share's remaining lifetime reads. The
 * components stay declarative and this module carries the decisions.
 *
 * Nothing here produces HTML. Bodies travel as plain strings and are rendered as
 * React text nodes by the components, so a comment containing markup displays as
 * the characters the author typed. There is no sanitizer and no
 * `dangerouslySetInnerHTML` anywhere in this feature.
 */

// ---- comment composer -------------------------------------------------------

export interface CommentDraftState {
  body: string;
}

export function emptyCommentDraft(): CommentDraftState {
  return { body: "" };
}

/**
 * Validates a composer draft against the same domain rule the service applies.
 *
 * Shared validation rather than a parallel client rule: a client that accepted
 * something the server refuses produces a submit button that always fails, and
 * one that refused something the server accepts silently removes a capability.
 */
export function validateCommentDraft(
  draft: CommentDraftState,
): { ok: true; body: string } | { ok: false; reason: string } {
  const body = validateCommentBody(draft.body);
  if (body === null) {
    if (draft.body.trim() === "") return { ok: false, reason: "Enter a comment before posting." };
    return {
      ok: false,
      reason: `A comment must be at most ${COLLABORATION_LIMITS.maxBodyLength} characters and cannot contain control characters.`,
    };
  }
  return { ok: true, body };
}

/** Whether the composer's submit control should be enabled. */
export function canSubmitComment(draft: CommentDraftState, busy: boolean): boolean {
  if (busy) return false;
  return validateCommentDraft(draft).ok;
}

/** Characters still available, for a live counter. Never negative. */
export function remainingBodyCharacters(draft: CommentDraftState): number {
  return Math.max(0, COLLABORATION_LIMITS.maxBodyLength - [...draft.body].length);
}

/** Whether a counter should be styled as a warning. */
export function isNearBodyLimit(draft: CommentDraftState): boolean {
  return remainingBodyCharacters(draft) <= 100;
}

// ---- thread presentation ----------------------------------------------------

export interface ThreadSummaryView {
  id: string;
  statusLabel: string;
  anchorLabel: string;
  /** Set when the anchor was authored against an older version. */
  staleNote: string | null;
  messageCountLabel: string;
}

/** The status text shown on a thread. */
export function threadStatusLabel(status: CommentThreadStatus): string {
  return status === "resolved" ? "Resolved" : "Open";
}

/**
 * The note shown on a stale thread.
 *
 * Says what it means for the reader rather than only that it is stale: the
 * coordinates still describe the version the comment was written on, so the
 * highlight may no longer line up with what is on screen.
 */
export function staleAnchorNote(stale: boolean): string | null {
  return stale
    ? "This comment was made on an earlier version, so its position may not match the current document."
    : null;
}

/** A bounded, human-readable message count. */
export function messageCountLabel(count: number): string {
  if (count <= 0) return "No replies";
  if (count === 1) return "1 message";
  if (count > COLLABORATION_LIMITS.maxMessagesPerThread) {
    return `${COLLABORATION_LIMITS.maxMessagesPerThread}+ messages`;
  }
  return `${count} messages`;
}

export function summarizeThread(input: {
  id: string;
  status: CommentThreadStatus;
  anchor: CommentAnchor;
  stale: boolean;
  messageCount: number;
}): ThreadSummaryView {
  return {
    id: input.id,
    statusLabel: threadStatusLabel(input.status),
    anchorLabel: describeAnchor(input.anchor),
    staleNote: staleAnchorNote(input.stale),
    messageCountLabel: messageCountLabel(input.messageCount),
  };
}

/** The label for the button that toggles a thread's status. */
export function statusToggleLabel(status: CommentThreadStatus): string {
  return status === "resolved" ? "Reopen" : "Resolve";
}

/** An icon-free grouping key so a panel can section open threads before resolved. */
export function threadGroupOrder(status: CommentThreadStatus): number {
  return status === "open" ? 0 : 1;
}

// ---- per-message capabilities ----------------------------------------------

export interface MessageActionContext {
  authorId: string;
  deleted: boolean;
  /** The signed-in user. */
  viewerId: string;
  /** Whether the viewer holds Workspace moderation rights. */
  viewerCanModerate: boolean;
  /** Whether the viewer may write at all (a viewer-role user may not). */
  viewerCanComment: boolean;
}

export interface MessageActions {
  canEdit: boolean;
  canDelete: boolean;
  canReply: boolean;
}

/**
 * Which actions a viewer may take on one message.
 *
 * Mirrors the service exactly, including its asymmetry: only an author may edit
 * (nobody should be able to put words in someone else's mouth), while a
 * moderator may delete anyone's message. Computed here so the UI never offers a
 * control the server will refuse — an enabled button that always errors is worse
 * than an absent one.
 */
export function messageActions(context: MessageActionContext): MessageActions {
  if (context.deleted) {
    // A tombstone has nothing to act on. Replying beneath one would attach a
    // response to words nobody can read.
    return { canEdit: false, canDelete: false, canReply: false };
  }
  const isAuthor = context.authorId === context.viewerId;
  return {
    canEdit: context.viewerCanComment && isAuthor,
    canDelete: context.viewerCanComment && (isAuthor || context.viewerCanModerate),
    canReply: context.viewerCanComment,
  };
}

/** The text shown in place of a deleted message. */
export function deletedMessagePlaceholder(): string {
  return "This comment was deleted.";
}

/** A short suffix marking an edited message. */
export function editedSuffix(edited: boolean): string | null {
  return edited ? "edited" : null;
}

// ---- sharing ----------------------------------------------------------------

export interface GrantDraftState {
  granteeUserId: string;
  role: string;
  /** Empty means "no expiry". */
  expiresAt: string;
}

export function emptyGrantDraft(): GrantDraftState {
  return { granteeUserId: "", role: "viewer", expiresAt: "" };
}

export interface ValidGrantDraft {
  granteeUserId: string;
  role: DocumentPermissionRole;
  expiresAt: string | null;
}

/**
 * Validates a share form.
 *
 * The expiry is parsed rather than trusted: a datetime input yields a local
 * string, and an unparseable or past value must be reported instead of becoming
 * a permanent grant — the same distinction `validateGrantExpiry` enforces
 * server-side.
 */
export function validateGrantDraft(
  draft: GrantDraftState,
  now: Date = new Date(),
): { ok: true; draft: ValidGrantDraft } | { ok: false; field: keyof GrantDraftState; reason: string } {
  const granteeUserId = draft.granteeUserId.trim();
  if (granteeUserId === "") {
    return { ok: false, field: "granteeUserId", reason: "Enter the person to share with." };
  }
  if (granteeUserId.length > COLLABORATION_LIMITS.maxIdLength) {
    return { ok: false, field: "granteeUserId", reason: "That identifier is too long." };
  }
  if (!isDocumentPermissionRole(draft.role)) {
    return { ok: false, field: "role", reason: "Choose one of the available access levels." };
  }
  if (draft.expiresAt.trim() === "") {
    return { ok: true, draft: { granteeUserId, role: draft.role, expiresAt: null } };
  }
  const parsed = new Date(draft.expiresAt);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, field: "expiresAt", reason: "Enter a valid date and time, or leave blank." };
  }
  const expiry = validateGrantExpiry(parsed, now);
  if (expiry === null || expiry === undefined) {
    return {
      ok: false,
      field: "expiresAt",
      reason: "Choose a future date within one year, or leave blank for no expiry.",
    };
  }
  return {
    ok: true,
    draft: { granteeUserId, role: draft.role, expiresAt: expiry.toISOString() },
  };
}

export function canSubmitGrant(draft: GrantDraftState, busy: boolean, now: Date = new Date()): boolean {
  if (busy) return false;
  return validateGrantDraft(draft, now).ok;
}

/** The selectable access levels, strongest last, with what each one permits. */
export function grantRoleOptions(): Array<{ value: DocumentPermissionRole; label: string; description: string }> {
  return DOCUMENT_PERMISSION_ROLES.map((role) => {
    switch (role) {
      case "viewer":
        return { value: role, label: "Can view", description: "Read the document and its comments." };
      case "commenter":
        return { value: role, label: "Can comment", description: "Also start and reply to comments." };
      case "editor":
        return { value: role, label: "Can edit", description: "Also change the document itself." };
    }
  });
}

/**
 * How a share's lifetime reads in the list.
 *
 * Revocation is reported before expiry because it is the stronger fact: a
 * revoked grant that also happens to have expired is revoked, and saying
 * "expired" would suggest it might be renewed by extending it.
 */
export function grantStatusLabel(
  grant: { expiresAt: string | null; revokedAt: string | null },
  now: Date = new Date(),
): string {
  if (grant.revokedAt !== null) return "Revoked";
  if (grant.expiresAt === null) return "No expiry";
  const expiry = new Date(grant.expiresAt);
  if (Number.isNaN(expiry.getTime())) return "Unknown expiry";
  if (expiry.getTime() <= now.getTime()) return "Expired";
  return `Expires ${formatExpiry(expiry)}`;
}

function formatExpiry(expiry: Date): string {
  return expiry.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/** Whether a revoke control should be offered for a grant. */
export function canRevokeGrant(grant: { revokedAt: string | null }): boolean {
  return grant.revokedAt === null;
}

// ---- panel state ------------------------------------------------------------

export type CommentsPanelPhase = "loading" | "ready" | "empty" | "error";

/**
 * Resolves which of the four panel states to render.
 *
 * Order matters: an error during a refresh is reported even when stale threads
 * are still on screen, because silently showing old data as if it were current
 * is the failure mode that makes a user act on the wrong information.
 */
export function commentsPanelPhase(input: {
  loading: boolean;
  error: string | null;
  threadCount: number;
}): CommentsPanelPhase {
  if (input.error !== null) return "error";
  if (input.loading) return "loading";
  return input.threadCount === 0 ? "empty" : "ready";
}

/** The message shown when a document has no comments yet. */
export function emptyStateMessage(filtered: boolean): string {
  return filtered
    ? "No comments match this filter."
    : "No comments yet. Select text or a page to start a conversation.";
}

/**
 * The status text announced to assistive technology after an action.
 *
 * Announced rather than shown in an alert: a blocking dialog interrupts the
 * keyboard user mid-flow, while a polite live region reports the outcome without
 * moving focus away from the composer.
 */
export function actionAnnouncement(
  action: "posted" | "replied" | "edited" | "deleted" | "resolved" | "reopened" | "shared" | "revoked",
): string {
  switch (action) {
    case "posted":
      return "Comment posted.";
    case "replied":
      return "Reply posted.";
    case "edited":
      return "Comment updated.";
    case "deleted":
      return "Comment deleted.";
    case "resolved":
      return "Thread resolved.";
    case "reopened":
      return "Thread reopened.";
    case "shared":
      return "Document shared.";
    case "revoked":
      return "Access revoked.";
  }
}

/**
 * Turns a failed request into text a person can act on.
 *
 * A revision conflict gets its own wording because the remedy is specific and
 * not obvious: the user must reload to see what changed, and retrying the same
 * submission would only fail again.
 */
export function describeActionError(status: number, message: string | null): string {
  if (status === 409 || (message !== null && /changed since/i.test(message))) {
    return "Someone else changed this first. Refresh to see the latest, then try again.";
  }
  if (status === 403) return "You do not have permission to do that.";
  if (status === 404) return "That comment is no longer available.";
  if (status === 422) return message ?? "That input was not accepted.";
  if (status >= 500) return "Something went wrong on our side. Try again in a moment.";
  return message ?? "That action could not be completed.";
}

/** Groups threads for display: open first, then resolved, each newest first. */
export function sortThreadsForDisplay<T extends { status: CommentThreadStatus; createdAt: string }>(
  threads: readonly T[],
): T[] {
  return threads
    .slice()
    .sort(
      (a, b) =>
        threadGroupOrder(a.status) - threadGroupOrder(b.status) ||
        b.createdAt.localeCompare(a.createdAt),
    );
}

/** The filter options a panel offers over thread status. */
export function statusFilterOptions(): Array<{ value: CommentThreadStatus | "all"; label: string }> {
  return [
    { value: "all", label: "All" },
    { value: "open", label: "Open" },
    { value: "resolved", label: "Resolved" },
  ];
}

/** The accessible label for a thread's list item. */
export function threadAriaLabel(view: ThreadSummaryView): string {
  const parts = [view.anchorLabel, view.statusLabel, view.messageCountLabel];
  if (view.staleNote !== null) parts.push("position may have changed");
  return parts.join(", ");
}

/** Anchor types a user may create from the panel, in the order offered. */
export function composableAnchorTypes(): CommentAnchorType[] {
  return ["document", "page"];
}

/**
 * A human timestamp for a comment (H32).
 *
 * The panel used to render `createdAt.slice(0, 16).replace("T", " ")` — a sliced
 * ISO string, in UTC, so a comment posted a minute ago read "2026-08-17 09:42"
 * while the user's clock said 10:42. Wrong timezone AND no sense of recency.
 *
 * Deliberately coarse: "now", minutes, hours, then a real date. Precision below
 * a minute is noise on a comment thread, and a live-ticking "37 seconds ago"
 * would need a timer for no benefit. `now` is injected so this stays pure and
 * testable rather than reading the clock itself.
 *
 * A future timestamp (clock skew between server and client) reads as "now"
 * rather than "in 3 minutes", which would look like a bug to the user.
 */
export function relativeCommentTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const ms = then.getTime();
  if (!Number.isFinite(ms)) return "";

  const diffMs = now.getTime() - ms;
  const diffMinutes = Math.floor(diffMs / 60_000);

  if (diffMinutes < 1) return "now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24 && then.toDateString() === now.toDateString()) {
    // Same calendar day: the local wall-clock time is the most useful form.
    return `Today, ${then.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (then.toDateString() === yesterday.toDateString()) {
    return `Yesterday, ${then.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  }

  // Older than that: a date, with the year only when it differs from this one.
  const sameYear = then.getFullYear() === now.getFullYear();
  return then.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * Avatar initials derived from an already-resolved display name.
 *
 * A fallback only: the server sends `authorInitials` alongside `authorName`, and
 * that is what the panel prefers. This exists so a payload from an older
 * deployment (name but no initials) still renders an avatar instead of a blank
 * circle. It deliberately does NOT re-implement the id fallback — by the time a
 * name reaches the client it is already `memberDisplayName`'s output.
 */
export function initialsFromName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") return "?";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}
