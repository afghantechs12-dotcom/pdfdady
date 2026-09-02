/**
 * Presentation rules for restoring a document version (Phase H, H35–H37).
 *
 * Separated from `DocumentInspector` so the decisions that matter — when Restore
 * is offered, what a failure says, and whether a failure may be retried
 * automatically — are testable in Node without a DOM.
 *
 * ## The compare-and-swap contract this module exists to protect
 *
 * `POST .../versions/{n}/restore` takes an `expectedRevision` and refuses when it
 * does not equal the document's current revision (`VersionService.restoreVersion`
 * → `DomainError` → HTTP 409 `WORKSPACE_OPERATION_REJECTED`). That check is the
 * only thing standing between two editors and a lost restore, so this module
 * deliberately provides **no** way to retry a conflict silently: see
 * {@link restoreFailure} and its `offerReload` flag.
 *
 * ## Where `expectedRevision` comes from — and where it must NOT come from
 *
 * It comes from `GET .../documents/{id}` → `document.revision`.
 *
 * It must not be derived from the version list. `VersionService.commit` writes the
 * version row at `revision` and then advances the document to `revision + 1`, so
 * the newest version's own `revision` is always exactly one behind the document's
 * current revision. Using it would make every restore fail with a conflict that
 * looks like a race but is really an off-by-one. {@link expectedRevisionFrom}
 * accepts only a document record for that reason.
 */

/** The sentence shown next to the confirm control. */
export const RESTORE_HELPER_TEXT = "Creates a new version from this one. History is kept.";

/**
 * Shown when the document record could not be read.
 *
 * Restore is blocked rather than attempted with a guessed revision: a guess would
 * either fail confusingly or, if it happened to be right, apply a restore on top
 * of a state the user never saw.
 */
export const REVISION_UNKNOWN_REASON =
  "The document's current revision could not be read, so a restore cannot be attempted safely.";

export const CURRENT_VERSION_REASON = "This is already the current version.";

export const DEGRADED_VERSION_REASON =
  "This version's details could not be read fully, so it cannot be restored.";

export const READ_ONLY_REASON = "You do not have permission to change this document.";

/** The minimum a row needs for an eligibility verdict. */
export interface RestoreCandidate {
  id: string;
  manifestDegraded: boolean;
}

/** The minimum a document record needs to supply a compare-and-swap revision. */
export interface RestoreDocumentState {
  revision: number;
  currentVersionId: string | null;
}

/**
 * The `expectedRevision` to post, or `null` when it is not known.
 *
 * `null` is a real answer, not a failure to compute one — the caller must block
 * Restore rather than substitute a value. Non-integer and negative revisions are
 * rejected too: the route's schema bounds `expectedRevision` to a non-negative
 * integer, so anything else would be refused as invalid input anyway, and
 * pretending we have a usable revision would produce a 422 instead of an honest
 * "unknown".
 */
export function expectedRevisionFrom(document: RestoreDocumentState | null): number | null {
  if (!document) return null;
  const { revision } = document;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) return null;
  return revision;
}

/**
 * Whether a version is the one the document currently points at.
 *
 * Uses the document's `currentVersionId` rather than "the first row in the list".
 * The list is newest-first and paginated (`before=`), so position is only a proxy
 * for currency on the first page; the pointer is the authority on every page.
 */
export function isCurrentVersion(
  version: Pick<RestoreCandidate, "id">,
  document: RestoreDocumentState | null,
): boolean {
  if (!document || document.currentVersionId === null) return false;
  return document.currentVersionId === version.id;
}

export interface RestoreEligibility {
  enabled: boolean;
  /** Why not, for a `title` on the disabled control. Absent when enabled. */
  reason?: string;
}

/**
 * Whether Restore may be offered for a row, and if not, why.
 *
 * Order matters: the most specific and permanent reason wins, so a degraded
 * current version reads as "already current" rather than switching explanations
 * once the pointer moves. A busy state reports no reason — the control is
 * transiently inert, and a tooltip explaining a spinner is noise.
 */
export function restoreEligibility(input: {
  version: RestoreCandidate;
  document: RestoreDocumentState | null;
  canWrite: boolean;
  busy: boolean;
}): RestoreEligibility {
  const { version, document, canWrite, busy } = input;
  if (!canWrite) return { enabled: false, reason: READ_ONLY_REASON };
  if (isCurrentVersion(version, document)) return { enabled: false, reason: CURRENT_VERSION_REASON };
  if (version.manifestDegraded) return { enabled: false, reason: DEGRADED_VERSION_REASON };
  if (expectedRevisionFrom(document) === null) {
    return { enabled: false, reason: REVISION_UNKNOWN_REASON };
  }
  if (busy) return { enabled: false };
  return { enabled: true };
}

export interface RestoreFailure {
  message: string;
  /**
   * Whether to offer "Reload versions", which refetches the list AND the document
   * record. Set for a stale-state failure, where a reload is the genuine fix.
   *
   * This is a *manual* affordance by design. Reloading and re-posting
   * automatically would turn the server's compare-and-swap into a no-op: the
   * second attempt would carry a revision the user still never saw, which is the
   * exact overwrite the 409 exists to prevent.
   */
  offerReload: boolean;
}

/**
 * How a failed restore reads.
 *
 * The server's own message is preferred wherever it sent one — for 409 it already
 * names both revisions and says "Reload and retry", which is more useful than
 * anything invented here. The fallbacks exist only for a response with no body.
 */
export function restoreFailure(status: number, serverMessage: string | null): RestoreFailure {
  const message = typeof serverMessage === "string" && serverMessage.trim() !== ""
    ? serverMessage.trim()
    : null;

  if (status === 409) {
    return {
      message:
        message ??
        "This document changed since the version list was loaded. Reload and try again.",
      offerReload: true,
    };
  }
  if (status === 404) {
    return {
      message: message ?? "That version no longer exists.",
      // History moved on beneath the panel; the list on screen is wrong.
      offerReload: true,
    };
  }
  if (status === 401 || status === 403) {
    // Reloading cannot grant permission, so it is not offered as a fix.
    return { message: message ?? "You do not have permission to restore this version.", offerReload: false };
  }
  return { message: message ?? "The version could not be restored.", offerReload: false };
}

/** The live-region sentence after a successful restore. */
export function restoreAnnouncement(restoredFrom: number, created: number): string {
  return `Restored version ${restoredFrom} as new version ${created}.`;
}
