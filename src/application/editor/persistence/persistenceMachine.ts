import {
  isRetryable,
  type ConflictInfo,
  type DraftDescriptor,
  type PersistenceChannel,
  type PersistenceEvent,
  type PersistenceFailure,
} from "./events";

/**
 * The document persistence state machine — pure, synchronous, and the only place
 * that decides what is safe to claim about a document.
 *
 * WHY THIS IS NOT ONE STATUS ENUM. The obvious model is a single
 * `"saved" | "saving" | "error"`, and it is wrong in a way that loses documents.
 * Those three words have to answer at least four independent questions at once:
 *
 *   Has the user edited since the last capture?      (edit)
 *   Is the newest revision durable on THIS device?   (local)
 *   Is the newest revision durable on the SERVER?    (remote)
 *   Is there recovered or recoverable work pending?  (recovery)
 *
 * A flat enum forces those to collapse, and every collapse is a lie in the
 * dangerous direction. "Cloud save failed" overwrites "saved on this device" and
 * the user, believing everything is lost, closes the tab — destroying a draft
 * that was in fact safe. Or the reverse: a successful local write shows "Saved"
 * while the workspace copy is hours stale. So the four dimensions are stored
 * separately here and combined for display exactly once, in `derivedStatus.ts`.
 *
 * WHY REVISIONS TRAVEL ON EVENTS. A save response proves that *a* revision
 * reached storage. It says nothing about the revision currently on screen. The
 * canonical loss looks like this:
 *
 *   rev 10 save starts → user edits (rev 11) → rev 11 save starts →
 *   rev 11 succeeds → rev 10's response finally arrives → UI clears dirty
 *
 * The document now reads "Saved" while revision 11 exists nowhere but in memory.
 * This reducer makes that impossible with one rule, applied to every channel:
 * **a completion whose `requestId` is not the channel's `activeRequestId` is
 * ignored in full and counted as stale.** Not partially applied — ignored. That
 * single rule satisfies every "a stale result must never…" clause at once: it
 * cannot mark a newer revision saved, cannot clear dirty, cannot move a
 * timestamp, cannot dismiss a live failure, and cannot touch a document opened
 * after it was issued (the scope check below rejects that even earlier).
 *
 * The cost is that a superseded-but-successful write is not credited: if rev 11
 * fails and rev 10 succeeds late, the watermark stays below 10 and the UI reports
 * more unsaved work than strictly exists. That is the safe direction. Over-
 * reporting unsaved work costs the user one redundant save; under-reporting costs
 * them the document.
 */

/** Has the document been edited beyond what is durable where it needs to be? */
export type DocumentEditState = "clean" | "dirty";

/** The state of on-device (IndexedDB) durability. */
export type LocalDurabilityStatus =
  /** No usable storage in this context — private browsing, blocked, absent API. */
  | "unavailable"
  /** Storage works; no write in flight. */
  | "idle"
  /** A write is in flight. */
  | "writing"
  /** The most recent write completed and verified. */
  | "durable"
  /** The most recent write failed. */
  | "failed";

/** The state of server-side durability. */
export type RemoteSyncStatus =
  /** A guest document. There is no server copy to be out of date. */
  | "not_applicable"
  /** The browser reports no connection, so attempts are suspended. */
  | "offline"
  /** Reachable (or presumed so); no save in flight. */
  | "idle"
  | "saving"
  /** The most recent save was acknowledged by the server. */
  | "synced"
  | "failed"
  /** The server holds a version this client did not base its edits on. */
  | "conflict";

/** Where this session stands with respect to a recoverable draft. */
export type RecoveryStatus =
  | "none"
  | "draft_available"
  | "restoring"
  | "recovered"
  | "recovery_failed";

/**
 * Per-channel request bookkeeping.
 *
 * `latestIssuedRequestId` and `activeRequestId` are deliberately distinct.
 * *Issued* is what the scheduler has decided to do; *active* is what has actually
 * begun. A schedule that is superseded while still debounced never starts, and
 * distinguishing the two is what lets the scheduler drop it without the reducer
 * ever seeing a phantom in-flight write.
 */
export interface ChannelState {
  latestIssuedRequestId: string | null;
  activeRequestId: string | null;
  /** The revision the in-flight attempt is writing. */
  activeRevision: number | null;
  /** The newest revision the scheduler has decided to write but not yet started. */
  pendingRevision: number | null;
  /** Consecutive user- or scheduler-initiated retries since the last success. */
  retryCount: number;
  failureReason: PersistenceFailure | null;
}

export interface PersistenceState {
  /** The document under management, or null when nothing is open. */
  documentId: string | null;
  /**
   * Which *opening* of that document this is.
   *
   * A document id alone is not enough. Close a document and reopen it and a
   * request issued before the close would still match by id, letting a response
   * about the previous editing session land on the new one.
   */
  documentSessionId: string | null;
  /** The draft-store key for this document (`guest:…` or `ws:…`). */
  documentKey: string | null;
  /** False for a guest document: there is no remote to be behind. */
  remoteEnabled: boolean;
  /** The browser's last reported connectivity. A hint, never proof. */
  online: boolean;

  edit: DocumentEditState;
  local: LocalDurabilityStatus;
  remote: RemoteSyncStatus;
  recovery: RecoveryStatus;

  /** The revision on screen. Monotonic within a session. */
  currentRevision: number;
  /**
   * The revision the document was opened at — its untouched source.
   *
   * The DISTINCTION THIS EXISTS TO MAKE. A document as opened is safe to close:
   * it is byte-identical to the user's own file on disk, or to the workspace
   * version on the server, so there is nothing of theirs to lose. The tempting way
   * to encode that is to start `lastLocallyDurableRevision` at the opened revision
   * — which asserts that an IndexedDB draft of it exists on this device. It does
   * not. That claim then shows "Saved on this device" over a document this browser
   * has never stored, and survives into every later comparison.
   *
   * So safety-at-open is recorded as its own fact. `baselineRevision` answers
   * "has the user changed anything yet"; the two watermarks answer "and if so,
   * where does that change exist". Neither can stand in for the other.
   */
  baselineRevision: number;
  /**
   * Whether an authoring surface is holding characters the document does not have.
   *
   * THE ONE FACT THE REVISION WATERMARKS CANNOT CARRY. Text is authored in a DOM
   * input and only becomes a command on commit, so between the first keystroke and
   * that commit the user has visible work that `currentRevision` knows nothing
   * about — and a capture taken in that window serialises the document WITHOUT the
   * characters. Both halves of that matter, and they pull in opposite directions:
   *
   *  - the edit state must be dirty (the user has changed something), and
   *  - no durability claim may stand (what was written does not contain it).
   *
   * So this is deliberately not modelled as a revision. A phantom revision would
   * make the watermarks satisfiable by a write that does not hold the text, which
   * is the false-safe direction. Held as its own fact, it can only ever subtract
   * safety: see {@link isCurrentRevisionLocallyDurable}.
   */
  uncommittedInput: boolean;
  /** The newest revision verified durable in this browser. */
  lastLocallyDurableRevision: number;
  /** The newest revision the server has acknowledged. */
  lastRemoteAcknowledgedRevision: number;
  /**
   * The newest revision that became a workspace DOCUMENT VERSION.
   *
   * Separate from `lastRemoteAcknowledgedRevision`, which only means an autosave
   * draft was stored. The autosave route echoes the document version back
   * unchanged, so a draft that saved perfectly leaves the version a colleague sees
   * exactly where it was. Reporting the draft as though it had updated the
   * document is the difference between "your team can see this" and "your team
   * cannot", and only one of them is true.
   */
  lastCommittedRevision: number;
  /** The version number the commit produced, when the server disclosed one. */
  committedServerVersion: number | null;

  localChannel: ChannelState;
  remoteChannel: ChannelState;

  lastLocalSaveAt: number | null;
  lastRemoteSaveAt: number | null;

  /** The active local draft this session writes to. */
  draftId: string | null;
  /** The server's optimistic-concurrency version, when known. */
  serverVersion: number | null;
  etag: string | null;

  /** A draft offered to the user, before they decide. */
  draft: DraftDescriptor | null;
  /** The revision restored from a draft, retained so the notice can stay honest. */
  recoveredRevision: number | null;
  recoveredAt: number | null;
  /**
   * Whether the user has been told the document came from a recovered draft.
   *
   * The recovery notice is retired by THIS and nothing else. A successful save
   * does not retire it: saving proves the work is durable, which is a different
   * claim from "you know what you are looking at". Nor does a later status
   * change, which is the failure mode that made this field necessary — a
   * recovered workspace draft is locally durable and cloud-behind, so its save
   * status is `saved_local`, and a notice living inside that enum would be
   * displaced by it the moment recovery finished.
   */
  recoveryAcknowledged: boolean;
  /**
   * Asset roles the restored draft referenced but could not produce.
   *
   * Non-empty means the recovery was PARTIAL — most consequentially a missing
   * `source-pdf`, which leaves the annotations without the pages they annotate.
   * Retained past the restore so the notice can keep saying so.
   */
  recoveredMissingAssets: readonly string[];
  recoveryFailure: PersistenceFailure | null;
  conflict: ConflictInfo | null;

  /**
   * How many completions were discarded for being out of scope or superseded.
   *
   * Not cosmetic: a test asserts that the late response was *ignored* rather than
   * never delivered, and those two are indistinguishable from the rest of the
   * state. It also makes the failure visible in diagnostics if the count climbs.
   */
  staleResponsesIgnored: number;
}

const NOTHING_DURABLE = -1;

function emptyChannel(): ChannelState {
  return {
    latestIssuedRequestId: null,
    activeRequestId: null,
    activeRevision: null,
    pendingRevision: null,
    retryCount: 0,
    failureReason: null,
  };
}

export const INITIAL_PERSISTENCE_STATE: PersistenceState = {
  documentId: null,
  documentSessionId: null,
  documentKey: null,
  remoteEnabled: false,
  online: true,
  edit: "clean",
  local: "idle",
  remote: "not_applicable",
  recovery: "none",
  currentRevision: 0,
  baselineRevision: 0,
  uncommittedInput: false,
  lastLocallyDurableRevision: NOTHING_DURABLE,
  lastRemoteAcknowledgedRevision: NOTHING_DURABLE,
  lastCommittedRevision: NOTHING_DURABLE,
  committedServerVersion: null,
  localChannel: emptyChannel(),
  remoteChannel: emptyChannel(),
  lastLocalSaveAt: null,
  lastRemoteSaveAt: null,
  draftId: null,
  serverVersion: null,
  etag: null,
  draft: null,
  recoveredRevision: null,
  recoveredAt: null,
  recoveryAcknowledged: false,
  recoveredMissingAssets: [],
  recoveryFailure: null,
  conflict: null,
  staleResponsesIgnored: 0,
};

/** Whether an event names the document and session this state is managing. */
function inScope(
  state: PersistenceState,
  event: { documentId: string; documentSessionId: string },
): boolean {
  return (
    state.documentId === event.documentId &&
    state.documentSessionId === event.documentSessionId
  );
}

function channelOf(state: PersistenceState, channel: PersistenceChannel): ChannelState {
  return channel === "local" ? state.localChannel : state.remoteChannel;
}

function withChannel(
  state: PersistenceState,
  channel: PersistenceChannel,
  next: ChannelState,
): PersistenceState {
  return channel === "local"
    ? { ...state, localChannel: next }
    : { ...state, remoteChannel: next };
}

/** A completion is current only if it is the attempt the channel is waiting on. */
function isCurrentAttempt(
  state: PersistenceState,
  channel: PersistenceChannel,
  event: { documentId: string; documentSessionId: string; requestId: string },
): boolean {
  if (!inScope(state, event)) return false;
  return channelOf(state, channel).activeRequestId === event.requestId;
}

function ignoreStale(state: PersistenceState): PersistenceState {
  return { ...state, staleResponsesIgnored: state.staleResponsesIgnored + 1 };
}

/**
 * Recompute the document-level edit state from the revision watermarks.
 *
 * Derived rather than stored, because a stored flag is exactly what goes wrong:
 * something clears it on the wrong event and there is no way to notice. Here
 * "clean" has one meaning — every channel that applies to this document has
 * acknowledged the revision on screen — and it cannot be set by anything except
 * the watermarks moving.
 */
function reconcileEdit(state: PersistenceState): PersistenceState {
  /*
   * Nothing has been edited beyond the source the document was opened from, so
   * there is no work that could be lost. Note that this is the ONLY route to
   * "clean" that does not require a durable copy — and it is sound precisely
   * because the source itself is the durable copy.
   */
  if (state.currentRevision <= state.baselineRevision && !state.uncommittedInput) {
    return state.edit === "clean" ? state : { ...state, edit: "clean" };
  }

  /*
   * WHY `unavailable` IS NOT LISTED HERE. It reads as a terminal, quiescent state
   * — no write pending, nothing more the channel will do — which is the same
   * surface shape as `durable`, and treating the two alike is how a guest document
   * in private browsing reports itself clean, unblocks navigation, and vanishes
   * with the tab. Unavailable is the ABSENCE of durability. A document whose only
   * store refuses to open is exactly as unsaved as one whose write failed; the
   * difference is that retrying will not help, which changes what the user is
   * TOLD, never whether the work is safe.
   */
  const localSatisfied = state.lastLocallyDurableRevision >= state.currentRevision;
  const remoteSatisfied = state.lastRemoteAcknowledgedRevision >= state.currentRevision;

  /*
   * THE TWO CHANNELS ARE NOT SYMMETRIC, and which one decides depends on whether
   * the document has a remote at all.
   *
   * For a workspace document the server copy is the authority: it is what
   * collaborators see and what survives this device being lost. A revision held
   * only in IndexedDB means the workspace copy is stale, which is unsaved work no
   * matter how durable the local draft is — so `remoteSatisfied` decides, and a
   * local draft cannot substitute for it. What the local draft DOES buy is that
   * such work is not *unprotected*; see `hasUnprotectedWork`, which asks the
   * narrower question navigation protection is allowed to ask.
   *
   * For a guest document there is no server to be behind, so the local draft is
   * the only durability there is and it decides alone.
   *
   * Conversely, remote acknowledgement makes local irrelevant to this question: if
   * the server holds the revision, closing the tab loses nothing. A failed local
   * write is still reported — prominently, by `derivedStatus` — because a missing
   * safety net is worth knowing about. It is just not unsaved work.
   */
  /*
   * Uncommitted characters cannot be satisfied by any write, because no write
   * contains them. Applied here rather than only in the helpers so that `edit`
   * itself — the field every surface reads — is dirty while they exist.
   */
  const satisfied =
    !state.uncommittedInput && (state.remoteEnabled ? remoteSatisfied : localSatisfied);
  const edit: DocumentEditState = satisfied ? "clean" : "dirty";
  return state.edit === edit ? state : { ...state, edit };
}

export function persistenceReducer(
  state: PersistenceState,
  event: PersistenceEvent,
): PersistenceState {
  switch (event.type) {
    case "DOCUMENT_OPENED": {
      /*
       * Opening establishes a NEW session and discards every channel. Nothing
       * from the previous document may survive: a request still in flight from it
       * would otherwise find bookkeeping it could match against.
       *
       * THE FIVE THINGS THAT ARE NOT THE SAME, and which opening must not merge:
       *
       *   1. the untouched source the document was loaded from  → baselineRevision
       *   2. an external source file on the user's disk         → baseline, no draft
       *   3. the workspace version on the server                → remote watermark
       *   4. a draft this device persisted to IndexedDB         → local watermark
       *   5. the revision currently on screen                   → currentRevision
       *
       * At open, (1) and (5) coincide and that is the whole of what is known. (3)
       * is known too, but only for a workspace document, and only because the
       * bytes on screen came from the server. (4) is known to be ABSENT: opening a
       * document writes nothing, so no local draft exists yet. Setting the local
       * watermark here — the obvious way to express "safe to close" — would assert
       * a draft that does not exist and read out as "Saved on this device".
       *
       * Safety-at-open is therefore carried by `baselineRevision` alone.
       */
      const remoteAcked = event.remoteEnabled
        ? (event.remoteAcknowledgedRevision ?? event.revision)
        : NOTHING_DURABLE;
      const next: PersistenceState = {
        ...INITIAL_PERSISTENCE_STATE,
        documentId: event.documentId,
        documentSessionId: event.documentSessionId,
        documentKey: state.documentKey,
        remoteEnabled: event.remoteEnabled,
        online: event.online,
        local: state.local === "unavailable" ? "unavailable" : "idle",
        remote: !event.remoteEnabled
          ? "not_applicable"
          : event.online
            ? "idle"
            : "offline",
        currentRevision: event.revision,
        baselineRevision: event.revision,
        // Deliberately left at NOTHING_DURABLE (via INITIAL): opening a document
        // does not store it. Only a verified commit moves this.
        lastLocallyDurableRevision: NOTHING_DURABLE,
        lastRemoteAcknowledgedRevision: remoteAcked,
        serverVersion: event.serverVersion ?? null,
        etag: event.etag ?? null,
        /*
         * A draft discovered by the pre-open scan is carried across, because the
         * scan necessarily runs before the session exists. Recovery *status* is
         * carried too — dropping it here would silently retract an offer the user
         * is currently looking at.
         */
        draft: state.draft,
        recovery: state.recovery === "draft_available" ? "draft_available" : "none",
        staleResponsesIgnored: state.staleResponsesIgnored,
      };
      return reconcileEdit(next);
    }

    case "DOCUMENT_MUTATED": {
      if (!inScope(state, event)) return state;
      // Monotonic only. A revision that went backwards would mean the counter was
      // reset under us, and treating it as current could mark newer work durable.
      if (event.revision <= state.currentRevision) return state;
      return reconcileEdit({ ...state, currentRevision: event.revision });
    }

    case "UNCOMMITTED_INPUT_CHANGED": {
      if (!inScope(state, event)) return state;
      if (state.uncommittedInput === event.pending) return state;
      return reconcileEdit({ ...state, uncommittedInput: event.pending });
    }

    case "LOCAL_WRITE_SCHEDULED":
    case "REMOTE_SAVE_SCHEDULED": {
      if (!inScope(state, event)) return state;
      const channel: PersistenceChannel =
        event.type === "LOCAL_WRITE_SCHEDULED" ? "local" : "remote";
      const current = channelOf(state, channel);
      return withChannel(state, channel, {
        ...current,
        latestIssuedRequestId: event.requestId,
        // The newest scheduled revision wins; an older schedule still sitting in
        // the debounce window is superseded rather than queued behind it.
        pendingRevision: Math.max(current.pendingRevision ?? NOTHING_DURABLE, event.revision),
      });
    }

    case "LOCAL_WRITE_STARTED":
    case "REMOTE_SAVE_STARTED": {
      if (!inScope(state, event)) return state;
      const channel: PersistenceChannel =
        event.type === "LOCAL_WRITE_STARTED" ? "local" : "remote";
      const current = channelOf(state, channel);
      /*
       * The newest start becomes the active attempt, which is what demotes any
       * older in-flight attempt to "superseded". The previous failure is kept: a
       * retry in progress has not undone the failure it is retrying, and clearing
       * it here would flash a clean status that a second failure then re-dirties.
       */
      const withStart = withChannel(state, channel, {
        ...current,
        activeRequestId: event.requestId,
        activeRevision: event.revision,
        pendingRevision:
          current.pendingRevision !== null && current.pendingRevision <= event.revision
            ? null
            : current.pendingRevision,
      });
      return channel === "local"
        ? { ...withStart, local: "writing" }
        : { ...withStart, remote: "saving" };
    }

    case "LOCAL_WRITE_SUCCEEDED": {
      if (!isCurrentAttempt(state, "local", event)) return ignoreStale(state);
      return reconcileEdit({
        ...state,
        local: "durable",
        // `Math.max` is belt-and-braces behind the requestId check: even if a
        // future refactor let an older completion through, it could never lower
        // the watermark and claim less is safe than truly is.
        lastLocallyDurableRevision: Math.max(state.lastLocallyDurableRevision, event.revision),
        lastLocalSaveAt: event.at,
        draftId: event.draftId,
        localChannel: {
          ...state.localChannel,
          activeRequestId: null,
          activeRevision: null,
          retryCount: 0,
          failureReason: null,
        },
      });
    }

    case "LOCAL_WRITE_FAILED": {
      if (!isCurrentAttempt(state, "local", event)) return ignoreStale(state);
      /*
       * `storage_unavailable` is a different condition from a failed write, and
       * conflating them produces a Retry button that can never work. Unavailable
       * means "this browser context has no durable store" — the honest response
       * is to tell the user their work exists only in this tab, not to retry.
       */
      const local: LocalDurabilityStatus =
        event.failure.category === "storage_unavailable" ? "unavailable" : "failed";
      return reconcileEdit({
        ...state,
        local,
        localChannel: {
          ...state.localChannel,
          activeRequestId: null,
          activeRevision: null,
          failureReason: event.failure,
        },
      });
    }

    case "REMOTE_SAVE_SUCCEEDED": {
      if (!isCurrentAttempt(state, "remote", event)) return ignoreStale(state);
      return reconcileEdit({
        ...state,
        remote: "synced",
        lastRemoteAcknowledgedRevision: Math.max(
          state.lastRemoteAcknowledgedRevision,
          event.revision,
        ),
        lastRemoteSaveAt: event.at,
        serverVersion: event.serverVersion,
        etag: event.etag,
        // A success resolves the conflict this save was based on; a conflict that
        // is still live would have come back as CONFLICT_DETECTED instead.
        conflict: null,
        remoteChannel: {
          ...state.remoteChannel,
          activeRequestId: null,
          activeRevision: null,
          retryCount: 0,
          failureReason: null,
        },
      });
    }

    case "REMOTE_VERSION_COMMITTED": {
      /*
       * Scoped like every other completion, but NOT gated on `isCurrentAttempt`:
       * a commit is its own operation with its own request id, not the tail of the
       * autosave attempt the remote channel is tracking. Requiring it to match the
       * channel's active attempt would discard every commit that landed while an
       * autosave was in flight — which is most of them.
       */
      if (!inScope(state, event)) return state;
      /*
       * Fenced by the frontier it claims to move rather than by a second race
       * mechanism: a commit is accepted only when it ADVANCES the committed
       * revision, or publishes a higher version number (a second save of the same
       * revision). Anything else is an older response landing late, and letting it
       * through would overwrite a newer committed version with a stale one —
       * `Math.max` alone protected the revision but not the version number.
       */
      const advancesRevision = event.revision > state.lastCommittedRevision;
      const advancesVersion =
        event.serverVersion !== null &&
        (state.committedServerVersion === null ||
          event.serverVersion > state.committedServerVersion);
      if (!advancesRevision && !advancesVersion) return ignoreStale(state);
      // A committed version implies the server holds the bytes, so the draft
      // watermark moves too. `Math.max` because a commit of revision 8 must not
      // retract an autosave that already acknowledged 9.
      return reconcileEdit({
        ...state,
        lastCommittedRevision: Math.max(state.lastCommittedRevision, event.revision),
        // The accepted commit's own version, even when it is null: a newer commit
        // that could not quote a version must not inherit the older one's number,
        // or the status would attribute version 7 to a revision it never held.
        committedServerVersion: event.serverVersion,
        lastRemoteAcknowledgedRevision: Math.max(
          state.lastRemoteAcknowledgedRevision,
          event.revision,
        ),
        lastRemoteSaveAt: event.at,
        /*
         * The fencing token takes the DOCUMENT REVISION the commit produced, not
         * the version number it produced. The two are different counters (a rename
         * moves one and not the other), and this field is what the autosave
         * transport sends as `expectedRevision` and what `remoteSync` compares a
         * head read against. Writing the version number here made the editor's own
         * publish look, one autosave later, like a competing writer.
         *
         * Left where it was when the server did not disclose one: a stale token
         * still detects a real competing write, while a freshly read one would
         * adopt a stranger's revision and silently stop detecting anything.
         */
        serverVersion: event.documentRevision ?? state.serverVersion,
        etag: event.etag,
      });
    }

    case "REMOTE_SAVE_FAILED": {
      if (!isCurrentAttempt(state, "remote", event)) return ignoreStale(state);
      return reconcileEdit({
        ...state,
        // Offline outranks failed: "Cloud save failed — retry" invites an action
        // that cannot succeed until the connection returns, and the offline copy
        // already says the right thing.
        remote: state.online ? "failed" : "offline",
        remoteChannel: {
          ...state.remoteChannel,
          activeRequestId: null,
          activeRevision: null,
          failureReason: event.failure,
        },
      });
    }

    case "CONFLICT_DETECTED": {
      if (!isCurrentAttempt(state, "remote", event)) return ignoreStale(state);
      /*
       * Note what is NOT touched: `lastLocallyDurableRevision`, `draftId`, and
       * the local channel. The local draft is the user's only copy of the work
       * the server refused, so a conflict must leave it completely alone.
       */
      return reconcileEdit({
        ...state,
        remote: "conflict",
        conflict: event.conflict,
        serverVersion: event.conflict.actualServerVersion ?? state.serverVersion,
        remoteChannel: {
          ...state.remoteChannel,
          activeRequestId: null,
          activeRevision: null,
          failureReason: {
            category: "conflict",
            message: "The workspace copy changed while you were editing.",
            retryable: false,
          },
        },
      });
    }

    case "LOCAL_STORAGE_UNAVAILABLE": {
      /*
       * Discovered by probe, usually at open time, before a single byte has been
       * risked. `unavailable` is terminal for the session: a store that will not
       * open does not start working because time passed, and a channel that
       * flickered back to `idle` would let the status bar imply a save is coming.
       *
       * `reconcileEdit` is deliberately re-run rather than skipped. If the user
       * has already edited, this is the moment their work becomes unprotected —
       * see the note there on why `unavailable` is not a form of durability.
       */
      if (state.local === "unavailable") return state;
      return reconcileEdit({
        ...state,
        local: "unavailable",
        localChannel: {
          ...state.localChannel,
          failureReason: event.failure,
          // Nothing is in flight or queued: there is no store to write to, so
          // leaving an activeRevision set would render as a write in progress.
          activeRequestId: null,
          activeRevision: null,
          pendingRevision: null,
          // Not a retry candidate. Counting attempts against a store that cannot
          // be opened would eventually present an exhausted-retries message, which
          // implies retrying was ever the answer.
          retryCount: 0,
        },
      });
    }

    case "NETWORK_WENT_OFFLINE": {
      if (!state.online && state.remote === "offline") return state;
      return {
        ...state,
        online: false,
        // A conflict survives going offline: it needs a decision, and hiding it
        // behind "Offline" would lose the fact that the server disagreed.
        remote:
          !state.remoteEnabled || state.remote === "conflict" ? state.remote : "offline",
      };
    }

    case "NETWORK_WENT_ONLINE": {
      /*
       * `online` is a retry SIGNAL, never proof of reachability: the browser
       * reports a link, not a route to this server. So the channel returns to
       * `idle` and waits for a real acknowledgement — going to `synced` here
       * would announce a save that has not been attempted.
       */
      return {
        ...state,
        online: true,
        remote:
          !state.remoteEnabled || state.remote === "conflict" || state.remote === "failed"
            ? state.remote
            : state.remote === "offline"
              ? "idle"
              : state.remote,
      };
    }

    case "RETRY_REQUESTED": {
      const current = channelOf(state, event.channel);
      // A non-retryable failure must not pretend to accept a retry: the UI does
      // not offer one, and a stray call should not inflate the count.
      if (current.failureReason && !isRetryable(current.failureReason.category)) return state;
      return withChannel(state, event.channel, {
        ...current,
        retryCount: current.retryCount + 1,
      });
    }

    case "DRAFT_FOUND": {
      /*
       * Scoped by document key only, not by session: the scan runs before the
       * document is opened, so there is no session id yet for it to match.
       *
       * A draft found while one is already being restored is dropped — the user
       * is mid-decision and swapping the offer under them would be worse than
       * ignoring the newcomer.
       */
      if (state.recovery === "restoring" || state.recovery === "recovered") return state;
      return {
        ...state,
        documentKey: event.documentKey,
        recovery: "draft_available",
        draft: event.draft,
      };
    }

    case "RECOVERY_STARTED":
      return { ...state, recovery: "restoring", recoveryFailure: null };

    case "RECOVERY_SUCCEEDED": {
      if (!inScope(state, event)) return state;
      /*
       * Recovery restores the document; it does NOT synchronise it. The remote
       * watermark is untouched on purpose, so a recovered workspace document
       * reads as having unsaved work relative to the server — which it does. A
       * recovered draft that reported "Saved" would be the original bug wearing a
       * different hat.
       */
      return reconcileEdit({
        ...state,
        recovery: "recovered",
        recoveredRevision: event.revision,
        recoveredAt: event.at,
        recoveryAcknowledged: false,
        // Taken from the draft that was offered, which is where the restore
        // discovered them. An empty list is the normal, complete case.
        recoveredMissingAssets: state.draft?.missingAssets ?? [],
        recoveryFailure: null,
        draftId: event.draftId,
        currentRevision: Math.max(state.currentRevision, event.revision),
        lastLocallyDurableRevision: event.locallyDurable
          ? Math.max(state.lastLocallyDurableRevision, event.revision)
          : state.lastLocallyDurableRevision,
        local: event.locallyDurable && state.local !== "unavailable" ? "durable" : state.local,
      });
    }

    case "RECOVERY_FAILED":
      return {
        ...state,
        recovery: "recovery_failed",
        recoveryAcknowledged: false,
        recoveryFailure: event.failure,
      };

    case "RECOVERY_ACKNOWLEDGED": {
      // Only a notice that is actually showing can be acknowledged, and `recovery`
      // itself is left alone: the breakdown still reports where the bytes came
      // from long after the banner is gone.
      if (state.recovery !== "recovered" && state.recovery !== "recovery_failed") return state;
      if (state.recoveryAcknowledged) return state;
      return { ...state, recoveryAcknowledged: true };
    }

    case "DRAFT_DISMISSED": {
      // Only the offer currently on screen can be dismissed. A dismissal naming a
      // different draft is a stale click from a previous offer.
      if (state.recovery !== "draft_available") return state;
      if (state.draft && state.draft.draftId !== event.draftId) return state;
      return { ...state, recovery: "none", draft: null };
    }

    case "DOCUMENT_CLOSED": {
      if (!inScope(state, event)) return state;
      /*
       * Clearing the session id is what makes every in-flight request harmless:
       * `inScope` can no longer match, so a response arriving after the close is
       * discarded without touching the document opened next.
       */
      return {
        ...INITIAL_PERSISTENCE_STATE,
        local: state.local === "unavailable" ? "unavailable" : "idle",
        staleResponsesIgnored: state.staleResponsesIgnored,
      };
    }

    case "DOCUMENT_RESET":
      return { ...INITIAL_PERSISTENCE_STATE };
  }
}

/**
 * Whether the revision on screen exists in this browser's durable store.
 *
 * `uncommittedInput` vetoes every durability answer in this file, and it is the
 * only field that can. What is on screen is the document PLUS characters sitting
 * in a text input; the newest draft holds the document alone, so answering "yes"
 * would attach the word "saved" to work that exists in one DOM node.
 */
export function isCurrentRevisionLocallyDurable(state: PersistenceState): boolean {
  if (state.uncommittedInput) return false;
  return state.lastLocallyDurableRevision >= state.currentRevision;
}

/** Whether the revision on screen has been acknowledged by the server. */
export function isCurrentRevisionRemotelyAcknowledged(state: PersistenceState): boolean {
  if (!state.remoteEnabled) return false;
  if (state.uncommittedInput) return false;
  return state.lastRemoteAcknowledgedRevision >= state.currentRevision;
}

/**
 * Whether the revision on screen has been published as a workspace document
 * version.
 *
 * The stronger of the two remote claims, and the only one that answers "can
 * someone else see this". A `true` from
 * {@link isCurrentRevisionRemotelyAcknowledged} means an autosave draft is
 * stored server-side; it says nothing about the document version, because the
 * autosave route does not create one.
 *
 * Requires a disclosed version number: a commit whose version came back `null`
 * proves bytes moved but cannot be quoted, and quoting an unknown version is how
 * a status invents "version null".
 */
export function isCurrentRevisionCommitted(state: PersistenceState): boolean {
  // Deliberately NOT gated on `remoteEnabled`: the explicit "Save to Workspace"
  // path publishes a version from the standalone (guest-origin) canvas too, and a
  // commit that this canvas itself performed is its own proof that a workspace
  // holds the bytes. Gating on the flag made the committed copy unreachable on the
  // only surface that can produce a commit.
  if (state.uncommittedInput) return false;
  if (state.committedServerVersion === null) return false;
  return state.lastCommittedRevision >= state.currentRevision;
}

/**
 * Whether work exists that no durable store holds.
 *
 * The one question navigation protection is allowed to ask. Deliberately not
 * "is it dirty": dirty-but-locally-durable work survives a refresh, and blocking
 * on it trains users to click through the warning.
 */
export function hasUnprotectedWork(state: PersistenceState): boolean {
  return (
    state.documentId !== null &&
    state.edit === "dirty" &&
    !isCurrentRevisionLocallyDurable(state) &&
    !isCurrentRevisionRemotelyAcknowledged(state)
  );
}
