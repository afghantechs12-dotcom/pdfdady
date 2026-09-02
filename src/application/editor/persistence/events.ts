/**
 * The event vocabulary of document persistence.
 *
 * Every asynchronous completion in this system carries four identifiers, and the
 * reducer refuses to act on an event missing or mismatching any of them:
 *
 *  - `documentId`        — which document the work belongs to;
 *  - `documentSessionId` — which *opening* of that document it belongs to. Two
 *    tabs, or the same document closed and reopened, are different sessions. An
 *    id per document is not enough: reopening the same document would otherwise
 *    let a request issued before the close land on the state after it;
 *  - `requestId`         — which attempt it belongs to, so a slow attempt cannot
 *    be mistaken for the fast one that superseded it;
 *  - `revision`          — which version of the document it actually wrote.
 *
 * The last two are what make "Saved" honest. A save response proves that *some*
 * revision reached storage; it says nothing about the revision on screen. Without
 * the revision travelling on the event, a response to revision 10 arriving after
 * the user reached revision 11 would clear the dirty flag over unsaved work — the
 * single failure this module exists to prevent.
 */

/** Which durability channel an event belongs to. */
export type PersistenceChannel = "local" | "remote";

/**
 * Why a write failed, in categories the UI can act on and diagnostics can count.
 *
 * Categories, not messages: the message is for a human and may contain document
 * detail, while the category decides whether a retry is offered, whether the
 * failure is the user's to resolve (quota), and whether it is worth retrying at
 * all. `unknown` exists so an unrecognised fault is still surfaced rather than
 * dropped — an unclassified error must never read as success.
 */
export type PersistenceFailureCategory =
  /** IndexedDB (or the whole storage API) is not available in this context. */
  | "storage_unavailable"
  /** The browser refused the write for lack of space. */
  | "quota_exceeded"
  /** A transaction aborted or was rolled back by the browser. */
  | "transaction_aborted"
  /** Bytes were written but did not read back intact. */
  | "integrity_failed"
  /** A stored draft could not be parsed or failed validation. */
  | "corrupt_snapshot"
  /** A stored draft names an asset that is no longer present. */
  | "missing_asset"
  /** A stored draft is a schema version this build cannot read. */
  | "unsupported_schema"
  /** A migration existed but threw. */
  | "migration_failed"
  /** The request never reached the server. */
  | "network"
  /** The server rejected the caller. */
  | "unauthorized"
  /** The server accepted the shape but refused the operation. */
  | "rejected"
  /**
   * The snapshot is larger than the remote endpoint will ever accept.
   *
   * Distinct from `rejected` because it is NOT retryable: the same bytes will be
   * refused every time, so offering a Retry button would be a lie. The document
   * has to get smaller (or the server's limit larger) first.
   */
  | "payload_too_large"
  /** The server's version no longer matches the one the client expected. */
  | "conflict"
  /** The attempt exceeded its time budget. */
  | "timeout"
  | "unknown";

export interface PersistenceFailure {
  category: PersistenceFailureCategory;
  /**
   * A short, non-sensitive summary safe to show and to log.
   *
   * Never document content: this string reaches both the status UI and the
   * diagnostics sink, and the diagnostics contract forbids document text.
   */
  message: string;
  /** Whether trying the same write again could plausibly succeed. */
  retryable: boolean;
}

/** Identity carried by every event that can arrive late. */
export interface PersistenceEventScope {
  documentId: string;
  documentSessionId: string;
}

/** Identity carried by every asynchronous completion. */
export interface PersistenceCompletionScope extends PersistenceEventScope {
  requestId: string;
  /** The revision the completed attempt actually wrote. */
  revision: number;
}

/** What a discovered draft tells the user before they decide to restore it. */
export interface DraftDescriptor {
  draftId: string;
  documentKey: string;
  /** The workspace document this draft belongs to, or null for a guest draft. */
  documentId: string | null;
  documentName: string;
  /** The revision the draft snapshot holds. */
  revision: number;
  updatedAt: number;
  /** The draft schema version the snapshot was written at. */
  schemaVersion: number;
  /** True when the newest snapshot was unusable and the previous one was taken. */
  fellBackToPreviousSnapshot: boolean;
  /**
   * Roles the draft references but could not produce (e.g. "source-pdf").
   *
   * Non-empty means recovery is PARTIAL. The user is told what is missing rather
   * than handed a document that silently lost its original pages.
   */
  missingAssets: string[];
  /** Set when the snapshot needed a migration to be read at all. */
  migratedFrom: number | null;
  /** Remote bookkeeping the draft carried, for a workspace document. */
  serverVersion: number | null;
  lastRemoteAcknowledgedRevision: number | null;
}

/** What the server said when it refused a save on concurrency grounds. */
export interface ConflictInfo {
  /** The revision the client was trying to save. */
  localRevision: number;
  /** The server version the client expected to be writing over. */
  expectedServerVersion: number | null;
  /** The server version actually found, when the server disclosed it. */
  actualServerVersion: number | null;
  /** The server's own bounded explanation, when it sent one. */
  detail: string | null;
  detectedAt: number;
}

export type PersistenceEvent =
  /**
   * A document became the subject of persistence. Establishes the session and
   * resets every channel: nothing from a previous document may survive this.
   */
  | (PersistenceEventScope & {
      type: "DOCUMENT_OPENED";
      revision: number;
      /** False for a guest document, which has no remote to synchronise with. */
      remoteEnabled: boolean;
      online: boolean;
      /** Known server bookkeeping at open time, when the caller has it. */
      serverVersion?: number | null;
      etag?: string | null;
      /** The revision the server has already acknowledged, when known. */
      remoteAcknowledgedRevision?: number | null;
      at: number;
    })
  /** A committed document mutation advanced the revision. */
  | (PersistenceEventScope & { type: "DOCUMENT_MUTATED"; revision: number; at: number })
  /**
   * An authoring surface started or stopped holding characters the document does
   * not have — a text box being typed into, before the commit that turns it into a
   * command.
   *
   * Not a mutation: it advances no revision, precisely because no write can contain
   * what it describes. It is reported so the editor cannot claim the document is
   * unchanged, or saved, while the user is looking at their own typing.
   */
  | (PersistenceEventScope & { type: "UNCOMMITTED_INPUT_CHANGED"; pending: boolean; at: number })
  | (PersistenceEventScope & {
      type: "LOCAL_WRITE_SCHEDULED";
      requestId: string;
      revision: number;
      at: number;
    })
  | (PersistenceCompletionScope & { type: "LOCAL_WRITE_STARTED"; at: number })
  | (PersistenceCompletionScope & {
      type: "LOCAL_WRITE_SUCCEEDED";
      at: number;
      draftId: string;
    })
  | (PersistenceCompletionScope & {
      type: "LOCAL_WRITE_FAILED";
      at: number;
      failure: PersistenceFailure;
    })
  | (PersistenceEventScope & {
      type: "REMOTE_SAVE_SCHEDULED";
      requestId: string;
      revision: number;
      at: number;
    })
  | (PersistenceCompletionScope & { type: "REMOTE_SAVE_STARTED"; at: number })
  | (PersistenceCompletionScope & {
      type: "REMOTE_SAVE_SUCCEEDED";
      at: number;
      serverVersion: number | null;
      etag: string | null;
    })
  | (PersistenceCompletionScope & {
      type: "REMOTE_SAVE_FAILED";
      at: number;
      failure: PersistenceFailure;
    })
  /**
   * A workspace *document version* was created from this canvas.
   *
   * NOT the same event as `REMOTE_SAVE_SUCCEEDED`, and the distinction is the
   * point. The autosave route stores a draft blob and echoes the document's
   * version straight back — `AutosaveService` does not increment it, because an
   * autosave draft is not a revision of the document. So a successful autosave
   * means "these bytes are off this machine", while this event means "these bytes
   * are what a colleague opening the document now sees". Users decide differently
   * on those two facts, and collapsing them makes the status claim the stronger
   * one on the strength of the weaker one.
   *
   * Adopting `serverVersion` here is safe in the one way it is never safe on a
   * reconnect: this version was created FROM the canvas that is on screen, so the
   * claim "my canvas is that version" is true by construction rather than assumed.
   *
   * Emitted only by an explicit commit. An export writes a file and produces no
   * event at all — see the export invariant.
   */
  | (PersistenceCompletionScope & {
      type: "REMOTE_VERSION_COMMITTED";
      at: number;
      /** The version the server created. Null when it did not disclose one. */
      serverVersion: number | null;
      /**
       * The DOCUMENT REVISION that commit produced — a different counter from the
       * version number, and the one a later write is fenced against.
       *
       * They are reported separately because they diverge: a rename advances the
       * revision and creates no version. While this event carried only
       * `serverVersion`, the version number became the fencing token, so the next
       * autosave after a publish was compared against a number the server had
       * never used as a revision — and the editor conflicted with its own write.
       *
       * Optional because a server that does not disclose it leaves the token where
       * it was. It is never DEFAULTED: guessing `revision + 1` is arithmetic on a
       * column this client does not own.
       */
      documentRevision?: number | null;
      etag: string | null;
    })
  | (PersistenceCompletionScope & {
      type: "CONFLICT_DETECTED";
      at: number;
      conflict: ConflictInfo;
    })
  /**
   * The local store cannot be opened at all, discovered by probing rather than by
   * a failed write.
   *
   * WHY THIS IS NOT JUST A `LOCAL_WRITE_FAILED`. Availability is knowable at open
   * time — `KeyValueStore.isAvailable()` answers it synchronously — and the answer
   * matters before the user's first edit, because it changes what they must be
   * told to do (export) rather than what they should wait for (a retry). Without
   * this event the only way to record it is to let a write fail, which means the
   * first thing lost is the first thing the user typed.
   *
   * Carries the failure so the reason survives into the status text; private
   * browsing, a blocked-cookies setting and a corrupt database read identically
   * from the outside but not to the user.
   */
  | { type: "LOCAL_STORAGE_UNAVAILABLE"; at: number; failure: PersistenceFailure }
  | { type: "NETWORK_WENT_OFFLINE"; at: number }
  | { type: "NETWORK_WENT_ONLINE"; at: number }
  /** The user asked for another attempt on one channel. */
  | { type: "RETRY_REQUESTED"; channel: PersistenceChannel; at: number }
  /**
   * A usable draft was found for this document. Scoped by document only: the
   * search happens BEFORE a session exists for the recovered document, so a
   * session id would have nothing to match against.
   */
  | { type: "DRAFT_FOUND"; documentKey: string; draft: DraftDescriptor; at: number }
  | { type: "RECOVERY_STARTED"; draftId: string; at: number }
  | (PersistenceEventScope & {
      type: "RECOVERY_SUCCEEDED";
      draftId: string;
      /** The revision the restored document now sits at. */
      revision: number;
      /**
       * Whether that revision is already durable on this device.
       *
       * True in the normal case — it was read back out of the draft store, so it
       * is durable by construction. False when the restore had to repair or
       * migrate the snapshot, because the repaired form has not been written yet.
       */
      locallyDurable: boolean;
      at: number;
    })
  | { type: "RECOVERY_FAILED"; draftId: string | null; failure: PersistenceFailure; at: number }
  /**
   * The user has seen and acknowledged that the document on screen came from a
   * recovered draft.
   *
   * Separate from `DRAFT_DISMISSED`, which declines a draft BEFORE restoring it.
   * This one runs after, and it is the only thing that retires the recovery
   * notice: provenance is not a transient state that some later save can clear,
   * because "these bytes came from a draft, not from the file you opened" stays
   * true until the user has been told.
   */
  | { type: "RECOVERY_ACKNOWLEDGED"; at: number }
  /** The user dismissed a discovered draft without restoring it. */
  | { type: "DRAFT_DISMISSED"; draftId: string; at: number }
  /** The document was closed or replaced. Every in-flight request is orphaned. */
  | (PersistenceEventScope & { type: "DOCUMENT_CLOSED"; at: number })
  /** Persistence was torn down entirely (unmount, hard reset). */
  | { type: "DOCUMENT_RESET"; at: number };

/** The event names, for exhaustiveness checks in tests. */
export const PERSISTENCE_EVENT_TYPES = [
  "DOCUMENT_OPENED",
  "DOCUMENT_MUTATED",
  "LOCAL_WRITE_SCHEDULED",
  "LOCAL_WRITE_STARTED",
  "LOCAL_WRITE_SUCCEEDED",
  "LOCAL_WRITE_FAILED",
  "REMOTE_SAVE_SCHEDULED",
  "REMOTE_SAVE_STARTED",
  "REMOTE_SAVE_SUCCEEDED",
  "REMOTE_SAVE_FAILED",
  "REMOTE_VERSION_COMMITTED",
  "CONFLICT_DETECTED",
  "LOCAL_STORAGE_UNAVAILABLE",
  "NETWORK_WENT_OFFLINE",
  "NETWORK_WENT_ONLINE",
  "RETRY_REQUESTED",
  "DRAFT_FOUND",
  "RECOVERY_STARTED",
  "RECOVERY_SUCCEEDED",
  "RECOVERY_FAILED",
  "RECOVERY_ACKNOWLEDGED",
  "DRAFT_DISMISSED",
  "DOCUMENT_CLOSED",
  "DOCUMENT_RESET",
] as const satisfies readonly PersistenceEvent["type"][];

/** Builds a failure with the retry policy its category implies. */
export function persistenceFailure(
  category: PersistenceFailureCategory,
  message: string,
): PersistenceFailure {
  return { category, message, retryable: isRetryable(category) };
}

/**
 * Whether retrying the identical write could plausibly succeed.
 *
 * Quota and schema faults are NOT retryable: repeating them burns battery and,
 * worse, makes the UI offer a Retry button that is guaranteed to fail, which
 * teaches the user that retrying does nothing. A conflict is not retryable
 * either — it needs a decision, not another attempt.
 */
export function isRetryable(category: PersistenceFailureCategory): boolean {
  switch (category) {
    case "network":
    case "timeout":
    case "transaction_aborted":
    case "integrity_failed":
    case "rejected":
    case "unknown":
      return true;
    case "storage_unavailable":
    case "quota_exceeded":
    case "payload_too_large":
    case "corrupt_snapshot":
    case "missing_asset":
    case "unsupported_schema":
    case "migration_failed":
    case "unauthorized":
    case "conflict":
      return false;
  }
}
