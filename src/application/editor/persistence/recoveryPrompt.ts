import type { DraftDescriptor } from "./events";

/**
 * What the user is told about a draft, before anything is restored.
 *
 * TWO PATHS, and the distinction is the whole design. When there is no ambiguity
 * — a guest document with no other copy in existence — restoring automatically is
 * strictly better than asking, because the alternative is a dialog between the
 * user and work that is unquestionably theirs. When there IS another version (a
 * workspace document that the server also holds), restoring automatically means
 * choosing for them, so the choice is presented.
 *
 * Either way the user is TOLD. Automatic recovery is followed by a persistent
 * notice, not a toast: a document restored from a draft looks exactly like a
 * normal one, and a message that vanishes after four seconds is indistinguishable
 * from never having been shown. "Your changes were restored" is information the
 * user needs while they are deciding whether to trust what is on screen.
 */
export type RecoveryActionId =
  | "restore_draft"
  /** Discard the draft and keep the version the server (or the file) holds. */
  | "open_saved_version"
  | "review_details"
  | "delete_draft";

export interface RecoveryAction {
  id: RecoveryActionId;
  label: string;
  destructive: boolean;
}

export const RECOVERY_ACTIONS: Record<RecoveryActionId, RecoveryAction> = {
  restore_draft: { id: "restore_draft", label: "Restore my changes", destructive: false },
  open_saved_version: {
    id: "open_saved_version",
    label: "Open the saved version",
    destructive: false,
  },
  review_details: { id: "review_details", label: "Review details", destructive: false },
  delete_draft: { id: "delete_draft", label: "Delete the draft", destructive: true },
};

export interface RecoveryPromptInput {
  draft: DraftDescriptor;
  /** When the version the server/file holds was last saved, if known. */
  savedVersionAt: number | null;
  /** The revision the opened document is at, before any restore. */
  openedRevision: number;
  /** True for a workspace document, where a second version genuinely exists. */
  hasAlternateVersion: boolean;
  now: number;
}

export interface RecoveryPrompt {
  /** Whether restoring needs the user's decision. */
  requiresChoice: boolean;
  headline: string;
  /** "An unsaved draft from 4 minutes ago was found." */
  summary: string;
  /**
   * Set when the draft cannot be fully restored.
   *
   * A partial recovery must say so up front. Handing back a document whose
   * original pages are missing while calling it "recovered" is worse than not
   * recovering: the user may then save that document over the good one.
   */
  caveat: string | null;
  details: RecoveryDetail[];
  actions: RecoveryAction[];
  /** The persistent notice shown after an automatic restore. */
  automaticNotice: string;
}

export interface RecoveryDetail {
  label: string;
  value: string;
}

export function buildRecoveryPrompt(input: RecoveryPromptInput): RecoveryPrompt {
  const { draft, now } = input;
  const age = describeAge(now - draft.updatedAt);
  const partial = draft.missingAssets.length > 0;
  const sourceMissing = draft.missingAssets.some((asset) => asset.startsWith("source-pdf"));

  const details: RecoveryDetail[] = [
    { label: "Draft saved", value: `${formatAbsolute(draft.updatedAt)} (${age})` },
    {
      label: "Saved version",
      value:
        input.savedVersionAt === null
          ? input.hasAlternateVersion
            ? "unknown"
            : "none — this document was never saved elsewhere"
          : `${formatAbsolute(input.savedVersionAt)} (${describeAge(now - input.savedVersionAt)})`,
    },
    { label: "Draft revision", value: String(draft.revision) },
    {
      label: "Workspace revision",
      value:
        draft.lastRemoteAcknowledgedRevision === null || draft.lastRemoteAcknowledgedRevision < 0
          ? "never synced"
          : String(draft.lastRemoteAcknowledgedRevision),
    },
    {
      label: "Recovered from",
      value: draft.fellBackToPreviousSnapshot
        ? "the previous snapshot on this device — the newest one was unreadable"
        : "the newest snapshot on this device",
    },
    {
      label: "Document data",
      value: partial
        ? `${draft.missingAssets.length} item${draft.missingAssets.length === 1 ? "" : "s"} could not be restored`
        : "complete",
    },
    {
      label: "Format",
      value:
        draft.migratedFrom === null
          ? `current (version ${draft.schemaVersion})`
          : `upgraded from version ${draft.migratedFrom}`,
    },
  ];

  const caveat = sourceMissing
    ? "The original PDF pages were not stored with this draft, so your edits can be restored but the underlying pages cannot. Open the original file to put them back."
    : partial
      ? `${draft.missingAssets.length} image${draft.missingAssets.length === 1 ? "" : "s"} could not be restored from this draft. Everything else is intact.`
      : draft.fellBackToPreviousSnapshot
        ? "The newest snapshot on this device was unreadable, so this is the one before it. A few of your most recent changes may be missing."
        : null;

  return {
    requiresChoice: input.hasAlternateVersion || partial || draft.fellBackToPreviousSnapshot,
    headline: partial ? "Unsaved changes found — partly recoverable" : "Unsaved changes found",
    summary: `An unsaved draft from ${age} was found${
      draft.revision > input.openedRevision
        ? `, with ${draft.revision - input.openedRevision} change${draft.revision - input.openedRevision === 1 ? "" : "s"} the saved version does not have`
        : ""
    }.`,
    caveat,
    details,
    actions: [
      RECOVERY_ACTIONS.restore_draft,
      ...(input.hasAlternateVersion ? [RECOVERY_ACTIONS.open_saved_version] : []),
      RECOVERY_ACTIONS.review_details,
      RECOVERY_ACTIONS.delete_draft,
    ],
    automaticNotice: partial
      ? "Recovered draft — some images could not be restored. Review your changes."
      : "Recovered draft — your changes are saved on this device.",
  };
}

/** "4 minutes ago" — coarse, because a precise age is noise in a prompt. */
export function describeAge(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000));
  if (seconds < 45) return "moments ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * An absolute local time, so "4 minutes ago" can be checked against a clock.
 *
 * Locale-dependent by design: the prompt is read by the person whose browser it
 * is, and a fixed format would be wrong for most of them.
 */
export function formatAbsolute(at: number): string {
  const date = new Date(at);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
