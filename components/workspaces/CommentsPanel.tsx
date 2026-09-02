"use client";

import { useId, useMemo, useState } from "react";
import { AlertCircle, CornerDownRight, MessageSquare, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  actionAnnouncement,
  canSubmitComment,
  commentsPanelPhase,
  deletedMessagePlaceholder,
  editedSuffix,
  emptyStateMessage,
  initialsFromName,
  isNearBodyLimit,
  messageActions,
  relativeCommentTime,
  remainingBodyCharacters,
  sortThreadsForDisplay,
  statusFilterOptions,
  statusToggleLabel,
  summarizeThread,
  threadAriaLabel,
  validateCommentDraft,
} from "./commentLogic";
import {
  COLLABORATION_LIMITS,
  type CommentAnchor,
  type CommentThreadStatus,
} from "@/src/domain/entities/Collaboration";

/** One message as the panel receives it from the API. */
export interface CommentMessageView {
  id: string;
  authorId: string;
  /**
   * Resolved server-side (name → email → `Unknown user · {id}`), so it is always
   * a usable string. NOT optional: making it optional is what allowed the panel
   * to silently fall back to rendering `authorId`, a raw cuid, as a person's
   * name.
   */
  authorName: string;
  /** Avatar initials from the same resolution. Optional for older payloads. */
  authorInitials?: string;
  parentMessageId: string | null;
  body: string;
  deleted: boolean;
  edited: boolean;
  revision: number;
  createdAt: string;
}

/** One thread as the panel receives it from the API. */
export interface CommentThreadView {
  id: string;
  anchor: CommentAnchor;
  status: CommentThreadStatus;
  stale: boolean;
  revision: number;
  createdAt: string;
  messages: CommentMessageView[];
}

export interface CommentsPanelProps {
  threads: CommentThreadView[];
  /** The signed-in user, used to decide which controls each message offers. */
  viewerId: string;
  viewerCanComment: boolean;
  viewerCanModerate: boolean;
  loading?: boolean;
  /** Server-reported failure for the last action. */
  error?: string | null;
  onCreateThread: (input: { anchor: CommentAnchor; body: string }) => Promise<void> | void;
  onReply: (thread: CommentThreadView, body: string, parentMessageId: string | null) => Promise<void> | void;
  onEdit: (thread: CommentThreadView, message: CommentMessageView, body: string) => Promise<void> | void;
  onDelete: (thread: CommentThreadView, message: CommentMessageView) => Promise<void> | void;
  onToggleStatus: (thread: CommentThreadView) => Promise<void> | void;
  /** Optional page context, so a new comment can anchor to what is on screen. */
  currentPage?: number | null;
}

/**
 * The M7.10 comments panel.
 *
 * Every body on this screen is rendered as a React text node — `{message.body}`,
 * never `dangerouslySetInnerHTML`. A comment containing markup therefore
 * *displays* that markup as characters rather than executing it, which is why
 * the storage layer keeps bodies as plain text instead of sanitizing them.
 *
 * Errors are shown in place, in a live region, rather than through `alert()`: a
 * blocking dialog steals focus from the composer and cannot be read back by a
 * screen reader in context. The same applies to success: actions announce
 * politely and leave focus where the user put it.
 */
export function CommentsPanel({
  threads,
  viewerId,
  viewerCanComment,
  viewerCanModerate,
  loading = false,
  error = null,
  onCreateThread,
  onReply,
  onEdit,
  onDelete,
  onToggleStatus,
  currentPage = null,
}: CommentsPanelProps) {
  const [body, setBody] = useState("");
  const [filter, setFilter] = useState<CommentThreadStatus | "all">("all");
  const [replyTo, setReplyTo] = useState<{ threadId: string; messageId: string | null } | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [editing, setEditing] = useState<{ threadId: string; messageId: string } | null>(null);
  const [editBody, setEditBody] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [busy, setBusy] = useState(false);

  const composerId = useId();
  const filterId = useId();

  const visible = useMemo(() => {
    const filtered = filter === "all" ? threads : threads.filter((t) => t.status === filter);
    return sortThreadsForDisplay(filtered);
  }, [threads, filter]);

  const message = localError ?? error;
  const phase = commentsPanelPhase({
    loading,
    error: message,
    threadCount: visible.length,
  });

  async function run(action: () => Promise<void> | void, announce: string) {
    setBusy(true);
    setLocalError(null);
    try {
      await action();
      setAnnouncement(announce);
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : "That action could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  async function submitThread(event: React.FormEvent) {
    event.preventDefault();
    const check = validateCommentDraft({ body });
    if (!check.ok) {
      setLocalError(check.reason);
      return;
    }
    // Anchors to the page in view when there is one, so a comment made while
    // reading page 7 is about page 7 rather than about the document at large.
    const anchor: CommentAnchor =
      currentPage === null ? { type: "document" } : { type: "page", pageNumber: currentPage };
    await run(async () => {
      await onCreateThread({ anchor, body: check.body });
      setBody("");
    }, actionAnnouncement("posted"));
  }

  async function submitReply(thread: CommentThreadView, event: React.FormEvent) {
    event.preventDefault();
    const check = validateCommentDraft({ body: replyBody });
    if (!check.ok) {
      setLocalError(check.reason);
      return;
    }
    await run(async () => {
      await onReply(thread, check.body, replyTo?.messageId ?? null);
      setReplyBody("");
      setReplyTo(null);
    }, actionAnnouncement("replied"));
  }

  async function submitEdit(
    thread: CommentThreadView,
    target: CommentMessageView,
    event: React.FormEvent,
  ) {
    event.preventDefault();
    const check = validateCommentDraft({ body: editBody });
    if (!check.ok) {
      setLocalError(check.reason);
      return;
    }
    await run(async () => {
      await onEdit(thread, target, check.body);
      setEditing(null);
      setEditBody("");
    }, actionAnnouncement("edited"));
  }

  return (
    <section aria-labelledby={`${composerId}-title`} className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 id={`${composerId}-title`} className="text-base font-semibold">
          Comments
        </h2>
        <div className="flex items-center gap-2">
          <label htmlFor={filterId} className="text-xs text-muted-foreground">
            Show
          </label>
          <select
            id={filterId}
            value={filter}
            onChange={(event) => setFilter(event.target.value as CommentThreadStatus | "all")}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm"
          >
            {statusFilterOptions().map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Polite, in-place status. An alert() would steal focus from the composer. */}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {message !== null && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{message}</span>
        </p>
      )}

      {viewerCanComment && (
        <form onSubmit={submitThread} className="flex flex-col gap-2">
          <label htmlFor={composerId} className="text-sm font-medium">
            Add a comment
          </label>
          <textarea
            id={composerId}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={3}
            maxLength={COLLABORATION_LIMITS.maxBodyLength}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            placeholder={
              currentPage === null ? "Comment on this document" : `Comment on page ${currentPage}`
            }
          />
          <div className="flex items-center justify-between gap-3">
            <span
              className={
                isNearBodyLimit({ body })
                  ? "text-xs text-amber-600 dark:text-amber-500"
                  : "text-xs text-muted-foreground"
              }
            >
              {remainingBodyCharacters({ body })} characters left
            </span>
            <Button type="submit" disabled={!canSubmitComment({ body }, busy)}>
              Post comment
            </Button>
          </div>
        </form>
      )}

      {phase === "loading" && (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          Loading comments…
        </p>
      )}

      {phase === "empty" && (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          {emptyStateMessage(filter !== "all")}
        </p>
      )}

      {phase === "ready" && (
        <ul className="flex flex-col gap-4" role="list">
          {visible.map((thread) => {
            const view = summarizeThread({
              id: thread.id,
              status: thread.status,
              anchor: thread.anchor,
              stale: thread.stale,
              messageCount: thread.messages.length,
            });
            return (
              <li
                key={thread.id}
                aria-label={threadAriaLabel(view)}
                className="rounded-lg border border-border p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <MessageSquare aria-hidden="true" className="h-4 w-4" />
                    {view.anchorLabel}
                  </span>
                  <span className="flex items-center gap-2">
                    <span
                      className={
                        thread.status === "resolved"
                          ? "rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-400"
                          : "rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                      }
                    >
                      {view.statusLabel}
                    </span>
                    {viewerCanComment && (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          run(
                            () => onToggleStatus(thread),
                            actionAnnouncement(
                              thread.status === "resolved" ? "reopened" : "resolved",
                            ),
                          )
                        }
                      >
                        {statusToggleLabel(thread.status)}
                      </Button>
                    )}
                  </span>
                </div>

                {view.staleNote !== null && (
                  <p className="mt-2 rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-500">
                    {view.staleNote}
                  </p>
                )}

                <ul className="mt-3 flex flex-col gap-3" role="list">
                  {thread.messages.map((entry) => {
                    const actions = messageActions({
                      authorId: entry.authorId,
                      deleted: entry.deleted,
                      viewerId,
                      viewerCanModerate,
                      viewerCanComment,
                    });
                    const isEditing =
                      editing?.threadId === thread.id && editing.messageId === entry.id;
                    return (
                      <li
                        key={entry.id}
                        className={
                          entry.parentMessageId === null
                            ? "flex flex-col gap-1"
                            : "ml-5 flex flex-col gap-1 border-l border-border pl-3"
                        }
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          {/* Avatar + real name (H30). `authorName` is resolved
                              server-side for every comment endpoint, so the
                              `?? authorId` fallback that used to print a raw
                              cuid is gone. `authorInitials` comes from the same
                              resolution, so the avatar and the name agree. */}
                          <span
                            aria-hidden="true"
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[10px] font-semibold uppercase text-primary"
                          >
                            {entry.authorInitials ?? initialsFromName(entry.authorName)}
                          </span>
                          <span className="text-sm font-medium">{entry.authorName}</span>
                          {/* The machine-readable instant stays in `dateTime`;
                              the visible text is local and relative (H32). */}
                          <time dateTime={entry.createdAt} className="text-xs text-muted-foreground">
                            {relativeCommentTime(entry.createdAt)}
                          </time>
                          {editedSuffix(entry.edited) !== null && (
                            <span className="text-xs text-muted-foreground">
                              ({editedSuffix(entry.edited)})
                            </span>
                          )}
                        </div>

                        {entry.deleted ? (
                          <p className="text-sm italic text-muted-foreground">
                            {deletedMessagePlaceholder()}
                          </p>
                        ) : isEditing ? (
                          <form
                            onSubmit={(event) => submitEdit(thread, entry, event)}
                            className="flex flex-col gap-2"
                          >
                            <label className="sr-only" htmlFor={`${composerId}-edit-${entry.id}`}>
                              Edit comment
                            </label>
                            <textarea
                              id={`${composerId}-edit-${entry.id}`}
                              value={editBody}
                              onChange={(event) => setEditBody(event.target.value)}
                              rows={2}
                              maxLength={COLLABORATION_LIMITS.maxBodyLength}
                              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                            />
                            <div className="flex gap-2">
                              <Button
                                type="submit"
                                disabled={!canSubmitComment({ body: editBody }, busy)}
                              >
                                Save
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                onClick={() => {
                                  setEditing(null);
                                  setEditBody("");
                                }}
                              >
                                Cancel
                              </Button>
                            </div>
                          </form>
                        ) : (
                          // A React text node: markup in a body displays as the
                          // characters the author typed and cannot execute.
                          <p className="whitespace-pre-wrap break-words text-sm">{entry.body}</p>
                        )}

                        {!entry.deleted && !isEditing && (
                          <div className="flex flex-wrap gap-1">
                            {actions.canReply && (
                              <Button
                                type="button"
                                variant="ghost"
                                onClick={() => {
                                  setReplyTo({
                                    threadId: thread.id,
                                    messageId: entry.parentMessageId === null ? entry.id : null,
                                  });
                                  setReplyBody("");
                                }}
                              >
                                <CornerDownRight aria-hidden="true" className="mr-1 h-3 w-3" />
                                Reply
                              </Button>
                            )}
                            {actions.canEdit && (
                              <Button
                                type="button"
                                variant="ghost"
                                onClick={() => {
                                  setEditing({ threadId: thread.id, messageId: entry.id });
                                  setEditBody(entry.body);
                                }}
                              >
                                <Pencil aria-hidden="true" className="mr-1 h-3 w-3" />
                                Edit
                              </Button>
                            )}
                            {actions.canDelete && (
                              <Button
                                type="button"
                                variant="ghost"
                                disabled={busy}
                                onClick={() =>
                                  run(
                                    () => onDelete(thread, entry),
                                    actionAnnouncement("deleted"),
                                  )
                                }
                              >
                                <Trash2 aria-hidden="true" className="mr-1 h-3 w-3" />
                                Delete
                              </Button>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>

                {replyTo?.threadId === thread.id && (
                  <form
                    onSubmit={(event) => submitReply(thread, event)}
                    className="mt-3 flex flex-col gap-2"
                  >
                    <label className="sr-only" htmlFor={`${composerId}-reply-${thread.id}`}>
                      Write a reply
                    </label>
                    <textarea
                      id={`${composerId}-reply-${thread.id}`}
                      value={replyBody}
                      onChange={(event) => setReplyBody(event.target.value)}
                      rows={2}
                      maxLength={COLLABORATION_LIMITS.maxBodyLength}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      placeholder="Write a reply"
                    />
                    <div className="flex gap-2">
                      <Button
                        type="submit"
                        disabled={!canSubmitComment({ body: replyBody }, busy)}
                      >
                        Reply
                      </Button>
                      <Button type="button" variant="ghost" onClick={() => setReplyTo(null)}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
