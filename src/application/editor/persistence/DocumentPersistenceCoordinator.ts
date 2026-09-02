import type { SerializedEditorState } from "../ports/ISerializer";
import {
  presentConflict,
  type ConflictActionId,
  type ConflictPresentation,
} from "./conflictResolution";
import {
  deriveRecoveryNotice,
  deriveSaveStatus,
  deriveStatusBreakdown,
  type RecoveryNoticeView,
  type SaveStatusBreakdown,
  type SaveStatusView,
} from "./derivedStatus";
import type { Diagnostics } from "./diagnostics";
import {
  DraftError,
  buildDraftSnapshot,
  draftKeys,
  type DraftAssetBlob,
  type DraftSnapshotRecord,
} from "./draftEnvelope";
import { DraftRepository, type DraftCommitResult, type LoadedDraft } from "./draftRepository";
import {
  persistenceFailure,
  type ConflictInfo,
  type PersistenceEvent,
  type PersistenceFailure,
} from "./events";
import {
  evaluateNavigation,
  shouldArmBeforeUnload,
  type NavigationGuardVerdict,
} from "./navigationGuard";
import {
  INITIAL_PERSISTENCE_STATE,
  hasUnprotectedWork,
  persistenceReducer,
  type PersistenceState,
} from "./persistenceMachine";
import type { KeyValueStore, RemoteDocumentTransport } from "./ports";
import { buildRecoveryPrompt, type RecoveryPrompt } from "./recoveryPrompt";
import { planRemoteSnapshot, remoteSnapshotBudget } from "./remotePayload";
import { planReconnect } from "./remoteSync";
import { RevisionBridge } from "./revisionBridge";
import {
  NO_PEER_ACTIVITY,
  createDocumentSessionId,
  draftLockName,
  observePeer,
  planCrossTabCommit,
  unlockedDraftLock,
  type DraftLock,
  type PeerActivity,
  type PeerBus,
} from "./tabCoordination";
import { LockContendedError } from "../../../infrastructure/persistence/browser/WebLocksDraftLock";
import {
  WriteScheduler,
  type FlushOptions,
  type FlushResult,
  type TimerHandle,
  type WriteAttempt,
  type WriteSchedulerConfig,
} from "./writeScheduler";

/**
 * The one object that owns saving a document, and the only place the pieces meet.
 *
 * Everything it coordinates was built and tested separately: a reducer that holds
 * four independent facts, two schedulers that debounce and retry, a repository that
 * commits transactionally, a bridge that turns undo-history numbers into revisions,
 * planners for conflicts, reconnects, payload limits and sibling tabs. Each is pure
 * or nearly so. This file is where they become a behaviour, and therefore where the
 * mistakes that survive unit tests live.
 *
 * WHAT THE STRUCTURE IS DEFENDING
 *
 * 1. IDENTITY ON EVERY COMPLETION. Every asynchronous result carries the document
 *    id, the document-opening session id, the request id and the revision it was
 *    started under. The reducer discards anything that does not match what it is
 *    currently serving. Without this, closing a document while a save is in flight
 *    lets that save's completion mark the NEXT document durable — the status bar
 *    says "Saved" about bytes that were never written.
 *
 * 2. CAPTURE IS SYNCHRONOUS. `capture()` may not await. It is called inside the
 *    scheduler's `prepare`, which runs in one turn of the event loop, so no
 *    mutation can interleave between reading the revision and reading the scene.
 *    The revision and the bytes therefore always agree.
 *
 * 3. NO EXPORT EVENT EXISTS. Exporting a PDF is not a save, and the way that is
 *    guaranteed is that this class has no method, and the event union no member,
 *    that an export could reach. There is nothing to call by accident. A test
 *    walks the event names to keep it that way.
 *
 * 4. THE CHANNELS ARE INDEPENDENT. A failed cloud save never touches the local
 *    draft, and a failed local write never stops the cloud save. They share only
 *    the revision watermarks in the reducer, which are monotonic, so neither can
 *    retract the other's progress.
 *
 * 5. NOTHING IS DELETED BEFORE ITS REPLACEMENT IS PROVEN. The repository promotes
 *    a new generation only after reading it back and verifying its checksum, and
 *    prunes the previous one only after the pointer moved. The remote path never
 *    deletes anything at all.
 */

/* ------------------------------------------------------------------ */
/* What the editor hands over                                          */
/* ------------------------------------------------------------------ */

/**
 * One synchronous read of everything a draft needs.
 *
 * WHAT IS DELIBERATELY ABSENT: rendered page rasters. Page backgrounds are a
 * function of the source bytes and can be regenerated on open; storing them would
 * multiply a draft's size by the page count for no recoverable information, and
 * quota is the resource that decides whether recovery works at all.
 */
export interface CapturedDocument {
  scene: SerializedEditorState;
  /** The original file. Null once the source lives only in the workspace. */
  sourceBytes: Uint8Array | null;
  /** Where the source can be fetched from when its bytes are not carried. */
  sourceReference: string | null;
  documentName: string;
  pageCount: number;
  objectCount: number;
}

export interface OpenDocumentInput {
  /**
   * The stable identity of this document across reloads.
   *
   * It must be derived from something that survives a refresh — the workspace
   * document id, or a key persisted with the guest file. A fresh random key per
   * mount produces a draft nobody will ever find again, which is the same as no
   * autosave with extra storage used.
   */
  documentKey: string;
  documentId: string | null;
  workspaceId: string | null;
  organizationId: string | null;
  origin: "guest" | "workspace";
  /** `CommandHistory.revision` at the moment the document finished loading. */
  historyRevision: number;
  online?: boolean;
  serverVersion?: number | null;
  etag?: string | null;
  remoteAcknowledgedRevision?: number | null;
}

export interface CoordinatorPorts {
  store: KeyValueStore;
  repository: DraftRepository;
  /** Null for a guest document: there is no workspace to back up to. */
  transport: RemoteDocumentTransport | null;
  lock?: DraftLock;
  peers?: PeerBus | null;
  diagnostics: Diagnostics;
  /** MUST NOT await. See invariant 2 above. */
  capture: () => CapturedDocument | null;
  now: () => number;
  newId: () => string;
  setTimer: (callback: () => void, ms: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
  onStateChange: (state: PersistenceState) => void;
  deviceId: string;
  tabId: string;
  /** The endpoint's ceiling. Defaults to the workspace autosave route's 1 MiB. */
  maxRemotePayloadBytes?: number;
  localConfig?: Partial<WriteSchedulerConfig>;
  remoteConfig?: Partial<WriteSchedulerConfig>;
}

/** Everything a surface needs to render, computed once per state change. */
export interface PersistenceView {
  state: PersistenceState;
  status: SaveStatusView;
  breakdown: SaveStatusBreakdown;
  recoveryNotice: RecoveryNoticeView | null;
  /** The decision to put to the user, or null when there is nothing to offer. */
  recoveryOffer: RecoveryPrompt | null;
  conflict: ConflictPresentation | null;
  navigation: NavigationGuardVerdict;
  armBeforeUnload: boolean;
}

/** What the editor must tell us after it has put a restored draft on screen. */
export interface RestoreApplied {
  historyRevision: number;
}

export type RestoreOutcome =
  | { kind: "restored"; draft: LoadedDraft; revision: number; complete: boolean }
  | { kind: "no_draft" }
  | { kind: "failed"; failure: PersistenceFailure };

export type ConflictResolution =
  /** Done: the workspace now holds this tab's revision. */
  | { kind: "replaced"; serverVersion: number | null }
  /** The server moved again between the check and the write. Ask again. */
  | { kind: "still_conflicted"; conflict: ConflictInfo }
  | { kind: "failed"; failure: PersistenceFailure }
  /**
   * The action belongs to the surface, not here: downloading a copy, opening the
   * workspace version in a tab, duplicating. Returned rather than silently
   * ignored so a caller that forgets to handle one is not left with a dialog that
   * does nothing.
   */
  | { kind: "not_owned"; action: ConflictActionId };

interface CoordinatorSession {
  documentKey: string;
  /**
   * The id the reducer scopes events by.
   *
   * A guest document has no workspace document id, and scoping by null would make
   * every guest document the same document. Its key is its identity.
   */
  scopeId: string;
  documentId: string | null;
  workspaceId: string | null;
  organizationId: string | null;
  origin: "guest" | "workspace";
  documentSessionId: string;
  /**
   * Derived from `documentKey`, never random.
   *
   * `draftKeys.pointer(draftId)` is the compare-and-swap target that stops two
   * tabs overwriting each other. Two tabs that generated different draft ids for
   * the same document would write different pointers, so the swap would always
   * succeed and the guard it exists to provide would be vacuous.
   */
  draftId: string;
  remoteEnabled: boolean;
  openedAt: number;
}

interface LocalWritePayload {
  session: CoordinatorSession;
  revision: number;
  captured: CapturedDocument;
  lastLocallyDurableRevision: number;
  lastRemoteAcknowledgedRevision: number | null;
  serverVersion: number | null;
  etag: string | null;
  at: number;
}

interface RemoteWritePayload {
  session: CoordinatorSession;
  revision: number;
  record: DraftSnapshotRecord;
  assets: readonly DraftAssetBlob[];
  expectedServerVersion: number | null;
  etag: string | null;
}

/** Carries a server-detected conflict out of `perform` without string matching. */
class RemoteConflictError extends Error {
  readonly conflict: ConflictInfo;
  constructor(conflict: ConflictInfo) {
    super("The workspace copy changed while you were editing.");
    this.name = "RemoteConflictError";
    this.conflict = conflict;
  }
}

/** Carries an already-classified failure out of `perform` unchanged. */
class ClassifiedError extends Error {
  readonly failure: PersistenceFailure;
  constructor(failure: PersistenceFailure) {
    super(failure.message);
    this.name = "ClassifiedError";
    this.failure = failure;
  }
}

/** The workspace autosave route's ceiling. */
const DEFAULT_MAX_REMOTE_PAYLOAD_BYTES = 1024 * 1024;

/**
 * How many contended attempts pass before contention is reported as a failure.
 *
 * A contended lock means a sibling tab is writing THIS draft, so the work is
 * being made durable by someone — reporting a failure would be false, and the
 * scheduler's retry will pick it up. But contention that never clears is a
 * failure, and "Saving…" forever is the worst of the available lies.
 */
const CONTENTION_ATTEMPTS_TOLERATED = 2;

export class DocumentPersistenceCoordinator {
  private readonly ports: CoordinatorPorts;
  private readonly lock: DraftLock;
  private readonly bridge = new RevisionBridge();
  private readonly local: WriteScheduler<DraftCommitResult, LocalWritePayload>;
  private readonly remote: WriteScheduler<
    { serverVersion: number | null; etag: string | null },
    RemoteWritePayload
  >;
  private readonly maxRemotePayloadBytes: number;

  private state: PersistenceState = INITIAL_PERSISTENCE_STATE;
  private session: CoordinatorSession | null = null;
  private disposed = false;

  /** The generation this tab's last successful commit produced. */
  private ownGeneration: number | null = null;
  private peer: PeerActivity = NO_PEER_ACTIVITY;
  private unsubscribePeers: (() => void) | null = null;

  /** The draft found at open time, held until the user accepts or declines it. */
  private offeredDraft: LoadedDraft | null = null;
  private offeredPrompt: RecoveryPrompt | null = null;

  /**
   * Set by `classifyLocal` when the lock was contended, read by `onFailed`.
   *
   * A field rather than a return value because the scheduler's contract has no
   * channel for "this attempt did not run". It is safe because JavaScript is
   * single-threaded and the scheduler calls `classify` immediately before
   * `onFailed`, with nothing awaited in between.
   */
  private lockContended = false;

  /** A server version read fresh for an explicit conflict override. */
  private forcedExpectedServerVersion: number | null | undefined;

  constructor(ports: CoordinatorPorts) {
    this.ports = ports;
    this.lock = ports.lock ?? unlockedDraftLock();
    this.maxRemotePayloadBytes = ports.maxRemotePayloadBytes ?? DEFAULT_MAX_REMOTE_PAYLOAD_BYTES;

    this.local = new WriteScheduler<DraftCommitResult, LocalWritePayload>(
      {
        now: ports.now,
        setTimer: ports.setTimer,
        clearTimer: ports.clearTimer,
        newRequestId: ports.newId,
        prepare: (attempt) => this.prepareLocal(attempt),
        perform: (attempt, payload) => this.performLocal(attempt, payload),
        onScheduled: (attempt) =>
          this.dispatch({
            type: "LOCAL_WRITE_SCHEDULED",
            documentId: attempt.documentId,
            documentSessionId: attempt.documentSessionId,
            requestId: attempt.requestId,
            revision: attempt.revision,
            at: ports.now(),
          }),
        onStarted: (attempt) =>
          this.dispatch({ ...this.completionScope(attempt), type: "LOCAL_WRITE_STARTED", at: ports.now() }),
        onSucceeded: (attempt, result) => this.onLocalSucceeded(attempt, result),
        onFailed: (attempt, failure) => this.onLocalFailed(attempt, failure),
        classify: (error) => this.classifyLocal(error),
      },
      ports.localConfig,
    );

    this.remote = new WriteScheduler<
      { serverVersion: number | null; etag: string | null },
      RemoteWritePayload
    >(
      {
        now: ports.now,
        setTimer: ports.setTimer,
        clearTimer: ports.clearTimer,
        newRequestId: ports.newId,
        prepare: (attempt) => this.prepareRemote(attempt),
        perform: (attempt, payload) => this.performRemote(attempt, payload),
        onScheduled: (attempt) =>
          this.dispatch({
            type: "REMOTE_SAVE_SCHEDULED",
            documentId: attempt.documentId,
            documentSessionId: attempt.documentSessionId,
            requestId: attempt.requestId,
            revision: attempt.revision,
            at: ports.now(),
          }),
        onStarted: (attempt) =>
          this.dispatch({ ...this.completionScope(attempt), type: "REMOTE_SAVE_STARTED", at: ports.now() }),
        onSucceeded: (attempt, result) =>
          this.dispatch({
            ...this.completionScope(attempt),
            type: "REMOTE_SAVE_SUCCEEDED",
            serverVersion: result.serverVersion,
            etag: result.etag,
            at: ports.now(),
          }),
        onFailed: (attempt, failure) => this.onRemoteFailed(attempt, failure),
        classify: (error) => this.classifyRemote(error),
      },
      ports.remoteConfig,
    );
  }

  /* ---------------------------------------------------------------- */
  /* Reading                                                           */
  /* ---------------------------------------------------------------- */

  get view(): PersistenceView {
    return {
      state: this.state,
      status: deriveSaveStatus(this.state),
      breakdown: deriveStatusBreakdown(this.state),
      recoveryNotice: deriveRecoveryNotice(this.state),
      recoveryOffer: this.offeredPrompt,
      conflict: this.state.conflict ? presentConflict(this.state, this.state.conflict) : null,
      navigation: evaluateNavigation(this.state),
      armBeforeUnload: shouldArmBeforeUnload(this.state),
    };
  }

  get revision(): number {
    return this.bridge.revision;
  }

  get documentSessionId(): string | null {
    return this.session?.documentSessionId ?? null;
  }

  /* ---------------------------------------------------------------- */
  /* Opening and closing                                               */
  /* ---------------------------------------------------------------- */

  /**
   * Begins persisting a document. Replaces any document already open.
   *
   * A NEW session id every time, including when the same document is reopened.
   * Reusing one would let a request issued before the reopen be accepted after it,
   * against a scene that has been rebuilt underneath.
   */
  async openDocument(input: OpenDocumentInput): Promise<void> {
    if (this.disposed) return;
    if (this.session) this.closeDocument();

    const now = this.ports.now();
    const remoteEnabled =
      input.origin === "workspace" &&
      this.ports.transport !== null &&
      input.documentId !== null &&
      input.workspaceId !== null &&
      input.organizationId !== null;

    const session: CoordinatorSession = {
      documentKey: input.documentKey,
      scopeId: input.documentId ?? input.documentKey,
      documentId: input.documentId,
      workspaceId: input.workspaceId,
      organizationId: input.organizationId,
      origin: input.origin,
      documentSessionId: createDocumentSessionId(this.ports.newId),
      draftId: input.documentKey,
      remoteEnabled,
      openedAt: now,
    };
    this.session = session;
    this.ownGeneration = null;
    this.peer = NO_PEER_ACTIVITY;
    this.offeredDraft = null;
    this.offeredPrompt = null;
    this.forcedExpectedServerVersion = undefined;

    const baseline = this.bridge.beginSession({
      documentKey: session.documentKey,
      documentSessionId: session.documentSessionId,
      historyRevision: input.historyRevision,
    });

    const online = input.online ?? true;
    this.dispatch({
      type: "DOCUMENT_OPENED",
      documentId: session.scopeId,
      documentSessionId: session.documentSessionId,
      revision: baseline,
      remoteEnabled,
      online,
      serverVersion: input.serverVersion ?? null,
      etag: input.etag ?? null,
      remoteAcknowledgedRevision: input.remoteAcknowledgedRevision ?? null,
      at: now,
    });

    if (!online) this.remote.pause();
    this.subscribeToPeers(session);

    /*
     * The probe runs after the open event on purpose. `DOCUMENT_OPENED` states
     * only what the caller knows, and it does not know whether IndexedDB will
     * open; asking here means the answer comes from the store rather than from an
     * assumption, and a browser that refuses is reported as unavailable before the
     * first edit rather than after the first failed write.
     */
    await this.probeLocalStore();
  }

  /**
   * Looks for work left behind by a previous session of this document.
   *
   * Returns the prompt when the user must decide, and null when there is nothing
   * to offer. An unambiguous guest draft still returns a prompt whose
   * `requiresChoice` is false — the caller restores it without asking, then shows
   * `automaticNotice`, because a restore the user did not ask for must still be
   * something they can see and undo.
   */
  async findRecoverableDraft(): Promise<RecoveryPrompt | null> {
    const session = this.session;
    if (!session || this.disposed) return null;
    if (!this.ports.repository.available) return null;

    let loaded: LoadedDraft | null;
    try {
      loaded = await this.ports.repository.loadBest(session.documentKey);
    } catch (error) {
      const failure = this.classifyLocal(error);
      this.ports.diagnostics.emit("draft_load_failed", {
        category: failure.category,
        documentKey: session.documentKey,
      });
      this.dispatch({ type: "RECOVERY_FAILED", draftId: null, failure, at: this.ports.now() });
      return null;
    }
    if (!this.isCurrent(session)) return null;
    if (!loaded) return null;

    /*
     * A draft at or behind the revision already on screen is not recovery, it is
     * noise. Offering it invites the user to "restore" their way backwards.
     */
    if (loaded.descriptor.revision <= this.state.currentRevision) {
      this.ports.diagnostics.emit("draft_ignored_not_newer", {
        revision: loaded.descriptor.revision,
        currentRevision: this.state.currentRevision,
      });
      return null;
    }

    this.offeredDraft = loaded;
    this.dispatch({
      type: "DRAFT_FOUND",
      documentKey: session.documentKey,
      draft: loaded.descriptor,
      at: this.ports.now(),
    });
    this.offeredPrompt = buildRecoveryPrompt({
      draft: loaded.descriptor,
      savedVersionAt: this.state.lastRemoteSaveAt,
      openedRevision: this.state.currentRevision,
      hasAlternateVersion: session.origin === "workspace",
      now: this.ports.now(),
    });
    this.ports.onStateChange(this.state);
    return this.offeredPrompt;
  }

  /**
   * Puts the offered draft back on screen through the caller's `apply`.
   *
   * The coordinator cannot load a scene into the editor, so `apply` does that and
   * reports the undo-history revision it ended up at. That number is what the
   * bridge needs to keep counting from, and taking it from the caller rather than
   * assuming the draft's own revision is what stops a freshly mounted history
   * (revision 0) from being mistaken for the draft's revision 47.
   */
  async restoreOfferedDraft(
    apply: (draft: LoadedDraft) => Promise<RestoreApplied> | RestoreApplied,
  ): Promise<RestoreOutcome> {
    const session = this.session;
    const draft = this.offeredDraft;
    if (!session || !draft || this.disposed) return { kind: "no_draft" };

    this.dispatch({ type: "RECOVERY_STARTED", draftId: draft.descriptor.draftId, at: this.ports.now() });
    this.bridge.beginLoad();
    let applied: RestoreApplied;
    try {
      applied = await apply(draft);
    } catch (error) {
      const failure = this.classifyLocal(error);
      this.bridge.endLoad(this.bridge.revision);
      this.dispatch({
        type: "RECOVERY_FAILED",
        draftId: draft.descriptor.draftId,
        failure,
        at: this.ports.now(),
      });
      return { kind: "failed", failure };
    }
    if (!this.isCurrent(session)) return { kind: "no_draft" };

    this.bridge.endLoad(applied.historyRevision);
    const revision = this.bridge.adoptRecoveredRevision(
      draft.descriptor.revision,
      applied.historyRevision,
    );

    /*
     * A draft missing assets, or one read from an older generation because the
     * newest was unreadable, is on screen but is NOT the durable copy of what is
     * on screen: the bytes behind it are incomplete. Claiming durability here is
     * how a partial recovery gets saved over the good workspace version.
     */
    const complete =
      draft.descriptor.missingAssets.length === 0 && !draft.descriptor.fellBackToPreviousSnapshot;

    this.offeredDraft = null;
    this.offeredPrompt = null;
    this.dispatch({
      type: "RECOVERY_SUCCEEDED",
      documentId: session.scopeId,
      documentSessionId: session.documentSessionId,
      draftId: draft.descriptor.draftId,
      revision,
      locallyDurable: complete,
      at: this.ports.now(),
    });
    if (!complete) this.noteMutation(applied.historyRevision);
    return { kind: "restored", draft, revision, complete };
  }

  /** The user declined the draft. It is kept: declining is not deleting. */
  dismissOfferedDraft(): void {
    const draft = this.offeredDraft;
    if (!draft) return;
    this.offeredDraft = null;
    this.offeredPrompt = null;
    this.dispatch({ type: "DRAFT_DISMISSED", draftId: draft.descriptor.draftId, at: this.ports.now() });
  }

  /** The user asked for the draft to be thrown away. Only then is it deleted. */
  async deleteOfferedDraft(): Promise<void> {
    const session = this.session;
    const draft = this.offeredDraft;
    if (!session || !draft) return;
    this.offeredDraft = null;
    this.offeredPrompt = null;
    try {
      await this.ports.repository.deleteDraft(draft.descriptor.draftId, session.documentKey);
    } catch (error) {
      this.ports.diagnostics.emit("draft_delete_failed", {
        category: this.classifyLocal(error).category,
      });
    }
    this.dispatch({ type: "DRAFT_DISMISSED", draftId: draft.descriptor.draftId, at: this.ports.now() });
  }

  /** The user dismissed the "recovered" notice. */
  acknowledgeRecovery(): void {
    this.dispatch({ type: "RECOVERY_ACKNOWLEDGED", at: this.ports.now() });
  }

  /**
   * Ends the current document. Every in-flight request becomes inert.
   *
   * The schedulers are cancelled rather than flushed: a close that races a write
   * must not be able to complete it against a document that is gone. Callers who
   * want the work saved call `flushLocal()` first and wait for its verdict.
   */
  closeDocument(): void {
    const session = this.session;
    if (!session) return;

    this.local.cancel();
    this.remote.cancel();
    this.unsubscribePeers?.();
    this.unsubscribePeers = null;
    this.ports.peers?.post({
      kind: "tab_closing",
      documentKey: session.documentKey,
      deviceId: this.ports.deviceId,
      tabId: this.ports.tabId,
      at: this.ports.now(),
    });
    this.bridge.endSession();
    this.session = null;
    this.offeredDraft = null;
    this.offeredPrompt = null;
    this.dispatch({
      type: "DOCUMENT_CLOSED",
      documentId: session.scopeId,
      documentSessionId: session.documentSessionId,
      at: this.ports.now(),
    });
  }

  /** Tears everything down. After this the coordinator does nothing at all. */
  dispose(): void {
    if (this.disposed) return;
    this.closeDocument();
    this.local.dispose();
    this.remote.dispose();
    this.ports.peers?.close();
    this.disposed = true;
    this.dispatch({ type: "DOCUMENT_RESET", at: this.ports.now() });
  }

  /* ---------------------------------------------------------------- */
  /* Edits                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Reports the undo history's revision after a mutation.
   *
   * Called on every `onRevisionChange`. The bridge decides whether that number is
   * a committed mutation worth persisting; a gesture in progress, a document being
   * loaded, or a number that did not move produce nothing.
   */
  noteMutation(historyRevision: number): void {
    const session = this.session;
    if (!session || this.disposed) return;
    const revision = this.bridge.observe(historyRevision, session.documentSessionId);
    if (revision === null) return;

    this.dispatch({
      type: "DOCUMENT_MUTATED",
      documentId: session.scopeId,
      documentSessionId: session.documentSessionId,
      revision,
      at: this.ports.now(),
    });
    this.scheduleWrites(session, revision);
  }

  /**
   * An authoring surface is (or is no longer) holding characters the document does
   * not have — a text box mid-typing.
   *
   * Schedules NOTHING, on purpose. A capture right now would serialise the document
   * without those characters and report the result as durable, which is the false
   * claim this exists to prevent. The write that saves them is the one the commit
   * schedules, and until then the editor's job is only to stop saying "saved".
   */
  noteUncommittedInput(pending: boolean): void {
    const session = this.session;
    if (!session || this.disposed) return;
    this.dispatch({
      type: "UNCOMMITTED_INPUT_CHANGED",
      documentId: session.scopeId,
      documentSessionId: session.documentSessionId,
      pending,
      at: this.ports.now(),
    });
  }

  /** A drag, resize or other preview has begun. Nothing is persisted until it ends. */
  beginGesture(label: string): void {
    this.bridge.beginGesture(label);
  }

  /** Ends a gesture. Only `"commit"` can produce a revision, and therefore a write. */
  endGesture(outcome: "commit" | "cancel"): void {
    const session = this.session;
    const revision = this.bridge.endGesture(outcome);
    if (!session || revision === null) return;
    this.dispatch({
      type: "DOCUMENT_MUTATED",
      documentId: session.scopeId,
      documentSessionId: session.documentSessionId,
      revision,
      at: this.ports.now(),
    });
    this.scheduleWrites(session, revision);
  }

  /** Wraps a document load so the revisions it churns through are not persisted. */
  beginLoad(): void {
    this.bridge.beginLoad();
  }

  endLoad(historyRevision: number): void {
    this.bridge.endLoad(historyRevision);
  }

  private scheduleWrites(session: CoordinatorSession, revision: number): void {
    const target = {
      documentId: session.scopeId,
      documentSessionId: session.documentSessionId,
      revision,
    };
    if (this.state.local !== "unavailable") this.local.schedule(target);
    if (session.remoteEnabled) this.remote.schedule(target);
  }

  /* ---------------------------------------------------------------- */
  /* The local channel                                                 */
  /* ---------------------------------------------------------------- */

  private prepareLocal(attempt: WriteAttempt): { revision: number; payload: LocalWritePayload } | null {
    const session = this.sessionFor(attempt);
    if (!session) return null;
    const captured = this.ports.capture();
    if (!captured) return null;
    // Read in the same synchronous turn as the capture, so the two agree.
    const revision = this.bridge.revision;
    return {
      revision,
      payload: {
        session,
        revision,
        captured,
        lastLocallyDurableRevision: this.state.lastLocallyDurableRevision,
        lastRemoteAcknowledgedRevision:
          this.state.lastRemoteAcknowledgedRevision > 0
            ? this.state.lastRemoteAcknowledgedRevision
            : null,
        serverVersion: this.state.serverVersion,
        etag: this.state.etag,
        at: this.ports.now(),
      },
    };
  }

  private async performLocal(
    attempt: WriteAttempt,
    payload: LocalWritePayload,
  ): Promise<DraftCommitResult> {
    const { session, captured } = payload;

    const plan = planCrossTabCommit({
      revision: payload.revision,
      ownGeneration: this.ownGeneration,
      peer: this.peer,
      lockHeld: this.lock.supported,
    });

    if (plan.decision === "already_durable") {
      /*
       * A sibling tab already stored this exact revision into the same draft.
       * Writing it again would burn quota to produce a byte-identical snapshot.
       */
      this.ports.diagnostics.emit("peer_commit_observed", {
        revision: plan.peerRevision,
        generation: this.peer.generation,
        currentRevision: payload.revision,
      });
      return {
        draftId: session.draftId,
        generation: this.peer.generation ?? 0,
        previousGeneration: null,
        revision: payload.revision,
        assetsWritten: 0,
        generationsPruned: 0,
      };
    }

    if (plan.decision === "conflict") {
      /*
       * The peer's snapshot is NEWER. A compare-and-swap cannot catch this — the
       * pointer is exactly where the peer left it — so overwriting would succeed
       * and silently replace their work with an older document. Not writing, and
       * saying so, is the only honest option.
       */
      this.ports.diagnostics.emit("cross_tab_conflict", {
        currentRevision: payload.revision,
        revision: plan.peerRevision,
      });
      throw new DraftError(
        "conflict",
        "Another tab has newer changes to this document stored in this browser.",
      );
    }

    const run = await this.lock.run(draftLockName(session.documentKey), async () =>
      this.ports.repository.commit({
        draftId: session.draftId,
        documentKey: session.documentKey,
        documentId: session.documentId,
        workspaceId: session.workspaceId,
        organizationId: session.organizationId,
        documentName: captured.documentName,
        origin: session.origin,
        revision: payload.revision,
        lastLocallyDurableRevision: payload.lastLocallyDurableRevision,
        lastRemoteAcknowledgedRevision: payload.lastRemoteAcknowledgedRevision,
        serverVersion: payload.serverVersion,
        etag: payload.etag,
        scene: captured.scene,
        sourceBytes: captured.sourceBytes,
        sourceReference: captured.sourceReference,
        pageCount: captured.pageCount,
        objectCount: captured.objectCount,
        now: payload.at,
        expectedActiveGeneration: plan.expectedActiveGeneration,
      }),
    );

    if (!run.serialised) {
      this.ports.diagnostics.emit("draft_lock_unavailable", { documentKey: session.documentKey });
    }
    return run.value;
  }

  private onLocalSucceeded(attempt: WriteAttempt, result: DraftCommitResult): void {
    this.ownGeneration = result.generation;
    const session = this.sessionFor(attempt);
    if (session) {
      this.ports.peers?.post({
        kind: "draft_committed",
        documentKey: session.documentKey,
        draftId: result.draftId,
        generation: result.generation,
        revision: attempt.revision,
        deviceId: this.ports.deviceId,
        tabId: this.ports.tabId,
        at: this.ports.now(),
      });
    }
    this.dispatch({
      ...this.completionScope(attempt),
      type: "LOCAL_WRITE_SUCCEEDED",
      draftId: result.draftId,
      at: this.ports.now(),
    });
  }

  private onLocalFailed(attempt: WriteAttempt, failure: PersistenceFailure): void {
    const contended = this.lockContended;
    this.lockContended = false;

    if (contended && attempt.attempt < CONTENTION_ATTEMPTS_TOLERATED) {
      /*
       * The write never ran, and the tab holding the lock is writing the same
       * draft to the same key. "Saving…" remains true, and the armed retry will
       * pick it up. Only persistent contention becomes a reported failure.
       */
      this.ports.diagnostics.emit("draft_lock_contended", { retryCount: attempt.attempt });
      return;
    }
    this.dispatch({
      ...this.completionScope(attempt),
      type: "LOCAL_WRITE_FAILED",
      failure,
      at: this.ports.now(),
    });
  }

  private classifyLocal(error: unknown): PersistenceFailure {
    if (error instanceof LockContendedError) {
      this.lockContended = true;
      return persistenceFailure("timeout", "Another tab is saving this document right now.");
    }
    if (error instanceof DraftError) return persistenceFailure(error.category, error.message);
    if (error instanceof ClassifiedError) return error.failure;
    return this.ports.store.classifyError(error);
  }

  private async probeLocalStore(): Promise<void> {
    const session = this.session;
    if (!session) return;
    let available: boolean;
    try {
      available = await this.ports.store.isAvailable();
    } catch {
      available = false;
    }
    if (!this.isCurrent(session)) return;
    if (available) return;
    this.dispatch({
      type: "LOCAL_STORAGE_UNAVAILABLE",
      failure: persistenceFailure(
        "storage_unavailable",
        "This browser will not let the page store data, so changes cannot be saved here.",
      ),
      at: this.ports.now(),
    });
  }

  /* ---------------------------------------------------------------- */
  /* The remote channel                                                */
  /* ---------------------------------------------------------------- */

  private prepareRemote(attempt: WriteAttempt): { revision: number; payload: RemoteWritePayload } | null {
    const session = this.sessionFor(attempt);
    if (!session || !session.remoteEnabled) return null;
    const captured = this.ports.capture();
    if (!captured) return null;
    const revision = this.bridge.revision;
    const now = this.ports.now();

    /*
     * Built here, synchronously, from the same capture — not read back from the
     * local draft. Reading the draft would make the cloud copy depend on the local
     * write having landed first, so a browser with no IndexedDB would also have no
     * cloud backup.
     *
     * `generation: 0` because generations order snapshots within one browser's
     * store and mean nothing to the server.
     */
    const built = buildDraftSnapshot({
      draftId: session.draftId,
      documentKey: session.documentKey,
      documentId: session.documentId,
      workspaceId: session.workspaceId,
      organizationId: session.organizationId,
      documentName: captured.documentName,
      origin: session.origin,
      generation: 0,
      createdAt: session.openedAt,
      updatedAt: now,
      revision,
      lastLocallyDurableRevision: this.state.lastLocallyDurableRevision,
      lastRemoteAcknowledgedRevision:
        this.state.lastRemoteAcknowledgedRevision > 0
          ? this.state.lastRemoteAcknowledgedRevision
          : null,
      serverVersion: this.state.serverVersion,
      etag: this.state.etag,
      scene: captured.scene,
      sourceBytes: captured.sourceBytes,
      sourceReference: captured.sourceReference,
      pageCount: captured.pageCount,
      objectCount: captured.objectCount,
    });

    const expectedServerVersion =
      this.forcedExpectedServerVersion !== undefined
        ? this.forcedExpectedServerVersion
        : this.state.serverVersion;
    this.forcedExpectedServerVersion = undefined;

    return {
      revision,
      payload: {
        session,
        revision,
        record: built.record,
        assets: built.assets,
        expectedServerVersion,
        etag: this.state.etag,
      },
    };
  }

  private async performRemote(
    attempt: WriteAttempt,
    payload: RemoteWritePayload,
  ): Promise<{ serverVersion: number | null; etag: string | null }> {
    const transport = this.ports.transport;
    const { session } = payload;
    if (!transport || session.documentId === null || session.workspaceId === null || session.organizationId === null) {
      throw new ClassifiedError(
        persistenceFailure("rejected", "This document has no workspace to back up to."),
      );
    }

    const plan = planRemoteSnapshot({
      record: payload.record,
      assets: payload.assets,
      maxBytes: remoteSnapshotBudget(this.maxRemotePayloadBytes),
    });
    if (plan.verdict === "not_applicable") {
      throw new ClassifiedError(persistenceFailure("rejected", plan.reason));
    }
    if (plan.verdict === "unavailable") {
      /*
       * No honest cloud backup of this revision exists. Reported as a failure so
       * the status bar says the cloud copy is behind — never skipped quietly while
       * "Saved" stays on screen.
       */
      this.ports.diagnostics.emit("remote_payload_rejected", {
        reason: plan.cause,
        byteLength: plan.bytes,
        revision: payload.revision,
      });
      throw new ClassifiedError(plan.failure);
    }
    if (plan.verdict === "reduced") {
      this.ports.diagnostics.emit("remote_payload_reduced", {
        omittedCount: plan.omitted.length,
        byteLength: plan.bytes,
        revision: payload.revision,
      });
    }

    const outcome = await transport.save({
      documentId: session.documentId,
      workspaceId: session.workspaceId,
      organizationId: session.organizationId,
      deviceId: this.ports.deviceId,
      revision: payload.revision,
      expectedServerVersion: payload.expectedServerVersion,
      etag: payload.etag,
      snapshot: plan.snapshot,
      clientTimestamp: this.ports.now(),
    });

    if (outcome.kind === "saved") {
      return { serverVersion: outcome.serverVersion, etag: outcome.etag };
    }
    if (outcome.kind === "conflict") {
      const conflict: ConflictInfo = {
        localRevision: payload.revision,
        expectedServerVersion: outcome.expectedServerVersion,
        actualServerVersion: outcome.actualServerVersion,
        detail: outcome.detail,
        detectedAt: this.ports.now(),
      };
      /*
       * Stashed against this attempt's request id rather than inferred later from
       * the failure. `onFailed` receives only a classified failure, and matching
       * `category === "conflict"` there would also match a cross-tab conflict from
       * the local channel — a different event with different bytes at stake.
       */
      this.pendingConflict = { requestId: attempt.requestId, conflict };
      throw new RemoteConflictError(conflict);
    }
    throw new ClassifiedError(outcome.failure);
  }

  private onRemoteFailed(attempt: WriteAttempt, failure: PersistenceFailure): void {
    const conflict = this.pendingConflict;
    this.pendingConflict = null;
    if (conflict && conflict.requestId === attempt.requestId) {
      /*
       * A conflict is not a failure to retry: the server was right to refuse, and
       * only the user can decide what happens next. Note what this does NOT do —
       * it leaves the local draft completely alone. That draft is the only copy of
       * the work the server just refused.
       */
      this.dispatch({
        ...this.completionScope(attempt),
        type: "CONFLICT_DETECTED",
        conflict: conflict.conflict,
        at: this.ports.now(),
      });
      return;
    }
    this.dispatch({
      ...this.completionScope(attempt),
      type: "REMOTE_SAVE_FAILED",
      failure,
      at: this.ports.now(),
    });
  }

  private pendingConflict: { requestId: string; conflict: ConflictInfo } | null = null;

  private classifyRemote(error: unknown): PersistenceFailure {
    if (error instanceof RemoteConflictError) {
      return persistenceFailure("conflict", error.message);
    }
    if (error instanceof ClassifiedError) return error.failure;
    if (error instanceof DraftError) return persistenceFailure(error.category, error.message);
    if (error instanceof Error && error.name === "AbortError") {
      return persistenceFailure("network", "The cloud save was interrupted.");
    }
    return persistenceFailure("network", "The workspace could not be reached.");
  }

  /**
   * Records a version the server created from a deliberate commit.
   *
   * Only ever called for an explicit "save a version" action. Exporting a PDF is
   * not a commit: the bytes leave the browser to a file the workspace never sees,
   * and marking a version saved because of one is how "Saved to workspace" appears
   * over work the workspace does not have.
   */
  noteVersionCommitted(input: {
    revision: number;
    serverVersion: number | null;
    /** The document revision the commit produced. See the event's own comment. */
    documentRevision?: number | null;
    etag: string | null;
  }): void {
    const session = this.session;
    if (!session) return;
    this.dispatch({
      type: "REMOTE_VERSION_COMMITTED",
      documentId: session.scopeId,
      documentSessionId: session.documentSessionId,
      requestId: this.ports.newId(),
      revision: input.revision,
      serverVersion: input.serverVersion,
      documentRevision: input.documentRevision ?? null,
      etag: input.etag,
      at: this.ports.now(),
    });
  }

  /* ---------------------------------------------------------------- */
  /* Network                                                           */
  /* ---------------------------------------------------------------- */

  /** Reports a connectivity change and, on reconnect, decides what to do about it. */
  async setOnline(online: boolean): Promise<void> {
    if (this.disposed) return;
    if (online === this.state.online) return;
    const session = this.session;

    if (!online) {
      this.dispatch({ type: "NETWORK_WENT_OFFLINE", at: this.ports.now() });
      this.remote.pause();
      return;
    }
    this.dispatch({ type: "NETWORK_WENT_ONLINE", at: this.ports.now() });
    if (!session || !session.remoteEnabled) return;
    await this.reconcileWithServer(session);
  }

  /**
   * Finds out what the server holds before sending anything to it.
   *
   * The order matters: a client whose first act after an outage is to POST will
   * overwrite whatever happened during the outage. Reading first turns that into a
   * conflict the user can see.
   */
  private async reconcileWithServer(session: CoordinatorSession): Promise<void> {
    const transport = this.ports.transport;
    if (
      !transport ||
      session.documentId === null ||
      session.workspaceId === null ||
      session.organizationId === null
    ) {
      return;
    }

    let head: { serverVersion: number | null; etag: string | null } | null;
    try {
      head = await transport.readVersion({
        documentId: session.documentId,
        workspaceId: session.workspaceId,
        organizationId: session.organizationId,
        deviceId: this.ports.deviceId,
      });
    } catch {
      // The connection is back but the endpoint is not answering. Resuming would
      // send blind; staying paused keeps the status honest until the next signal.
      return;
    }
    if (!this.isCurrent(session)) return;

    const plan = planReconnect({
      state: this.state,
      serverVersion: head?.serverVersion ?? null,
      etag: head?.etag ?? null,
      now: this.ports.now(),
    });
    this.ports.diagnostics.emit("reconnect_planned", {
      operation: plan.action,
      serverVersion: head?.serverVersion ?? null,
      currentRevision: this.state.currentRevision,
      acknowledgedRevision: this.state.lastRemoteAcknowledgedRevision,
    });

    switch (plan.action) {
      case "not_applicable":
      case "nothing_to_sync":
        this.remote.resume();
        return;

      case "adopt_server_version":
        /*
         * The ONLY case where a bare token may be taken. The planner proved the
         * content did not move — a matching validator — so the new number
         * describes the same bytes this tab already has acknowledged. It is
         * carried as the next save's expectation rather than written into the
         * state, so no event claims a save that did not happen, and the very next
         * save stops being refused for quoting a stale version.
         */
        this.forcedExpectedServerVersion = plan.serverVersion;
        this.remote.resume();
        return;

      case "sync":
        /*
         * The expectation this tab already holds still matches the server, so the
         * queued revision can be sent as-is. Nothing is forced: forcing here would
         * be indistinguishable from forcing in the conflict case below.
         */
        this.remote.resume();
        this.remote.schedule({
          documentId: session.scopeId,
          documentSessionId: session.documentSessionId,
          revision: plan.revision,
        });
        return;

      case "conflict":
        /*
         * The server moved on AND this canvas holds work of the user's. The
         * expectation is deliberately left at the OLD version — the one this tab's
         * bytes were built from — so the save is refused and comes back as a
         * conflict the user is shown. Raising the expectation to the server's
         * current version would make the server accept the overwrite, which is
         * adopting a newer token while retaining an older canvas: the loss this
         * whole path exists to prevent.
         */
        this.remote.resume();
        this.remote.schedule({
          documentId: session.scopeId,
          documentSessionId: session.documentSessionId,
          revision: this.state.currentRevision,
        });
        return;

      case "reload_from_server":
        /*
         * The server is ahead and this canvas holds nothing of the user's, so the
         * workspace version supersedes what is on screen. Reloading a scene is the
         * surface's job; no save is sent, because sending one would replace the
         * newer server copy with an older identical-or-emptier one.
         */
        this.remote.resume();
        return;
    }
  }

  /* ---------------------------------------------------------------- */
  /* User actions                                                      */
  /* ---------------------------------------------------------------- */

  retryLocal(): void {
    this.dispatch({ type: "RETRY_REQUESTED", channel: "local", at: this.ports.now() });
    this.local.resume();
    this.local.retry();
  }

  retryRemote(): void {
    this.dispatch({ type: "RETRY_REQUESTED", channel: "remote", at: this.ports.now() });
    this.remote.resume();
    this.remote.retry();
  }

  /** Writes everything queued locally and reports what actually happened. */
  async flushLocal(options?: FlushOptions): Promise<FlushResult> {
    return this.honestFlush(await this.local.flush(options));
  }

  async flushRemote(options?: FlushOptions): Promise<FlushResult> {
    return this.honestFlush(await this.remote.flush(options));
  }

  /**
   * Downgrades a `durable` verdict this coordinator cannot honestly pass on.
   *
   * `WriteScheduler.flush()` answers for its own queue, where an empty queue means
   * everything it was given is written — correct for the scheduler, and a lie here
   * in the two cases where the queue is empty *because* the work was never given
   * to it:
   *
   *  - No document is open. `closeDocument` discards the queue, so a flush during
   *    teardown finds nothing outstanding and would report the unsaved edit it just
   *    dropped as durable.
   *  - The local store is unavailable. `scheduleWrites` deliberately never queues
   *    for a channel that cannot be written, so the queue is empty while the work
   *    exists nowhere.
   *
   * Both matter because `durable` is the one verdict that permits navigation away
   * from unsaved work. A caller obeying that contract would close the tab.
   */
  private honestFlush(flushed: FlushResult): FlushResult {
    if (flushed.outcome !== "durable") return flushed;
    if (this.session === null) {
      // Nothing is open, so there is nothing for the verdict to be about. The
      // scheduler already says `cancelled` to anyone who was waiting on the queue
      // when it was discarded; this says the same thing to whoever asks after.
      return { ...flushed, outcome: "cancelled" };
    }
    if (!hasUnprotectedWork(this.state)) return flushed;
    if (this.state.local === "unavailable") {
      return {
        ...flushed,
        outcome: "unavailable",
        failure:
          this.state.localChannel.failureReason ??
          persistenceFailure(
            "storage_unavailable",
            "This browser will not let the page store data, so changes cannot be saved here.",
          ),
      };
    }
    return flushed;
  }

  /**
   * Whether it is safe to leave, keyed on durability rather than undo history.
   *
   * An undo stack says the user made changes; it says nothing about whether those
   * changes are stored. A document with fifty undo steps that are all durable is
   * safe to leave, and a document with one unsaved change is not.
   */
  canNavigate(): NavigationGuardVerdict {
    return evaluateNavigation(this.state);
  }

  /**
   * Best-effort write on `pagehide` or a hidden tab.
   *
   * Reports the flush's real verdict. The temptation is to fire and forget and
   * treat the page going away as success; the result of that is a status bar that
   * said "Saved" about a write the browser killed mid-transaction.
   */
  async flushOnHide(): Promise<FlushResult> {
    // Local only: a request the browser is about to kill cannot be relied on, and
    // a failed cloud save reported during teardown reads as data loss.
    return this.honestFlush(await this.local.flush({ resumeIfPaused: true }));
  }

  /**
   * Carries out a conflict decision, for the two decisions that are ours.
   *
   * Anything that produces a file or a second document belongs to the surface —
   * the coordinator cannot download or open anything — and is returned as
   * `not_owned` rather than quietly dropped.
   */
  async resolveConflict(
    action: ConflictActionId,
    options: { confirmed?: boolean } = {},
  ): Promise<ConflictResolution> {
    const session = this.session;
    const conflict = this.state.conflict;
    if (!session || !conflict) return { kind: "not_owned", action };

    if (action !== "replace_workspace") {
      /*
       * `cancel` leaves the conflict standing on purpose: an unresolved conflict
       * that stops looking unresolved is how the workspace copy gets overwritten
       * by the next autosave.
       */
      return { kind: "not_owned", action };
    }
    if (!options.confirmed) {
      return {
        kind: "failed",
        failure: persistenceFailure(
          "rejected",
          "Replacing the workspace version needs to be confirmed first.",
        ),
      };
    }

    const transport = this.ports.transport;
    if (
      !transport ||
      session.documentId === null ||
      session.workspaceId === null ||
      session.organizationId === null
    ) {
      return {
        kind: "failed",
        failure: persistenceFailure("rejected", "This document has no workspace version to replace."),
      };
    }

    /*
     * Re-read the server immediately before overriding. The version in the
     * conflict was current when the conflict was raised, which may have been
     * minutes ago while a dialog sat open; sending it would overwrite a third
     * change nobody has seen.
     */
    let head: { serverVersion: number | null; etag: string | null } | null;
    try {
      head = await transport.readVersion({
        documentId: session.documentId,
        workspaceId: session.workspaceId,
        organizationId: session.organizationId,
        deviceId: this.ports.deviceId,
      });
    } catch {
      return {
        kind: "failed",
        failure: persistenceFailure("network", "The workspace could not be reached."),
      };
    }
    if (!this.isCurrent(session)) return { kind: "not_owned", action };

    this.forcedExpectedServerVersion = head?.serverVersion ?? null;
    this.remote.resume();
    this.remote.schedule({
      documentId: session.scopeId,
      documentSessionId: session.documentSessionId,
      revision: this.state.currentRevision,
    });
    const flushed = await this.remote.flush({ resumeIfPaused: true });

    /*
     * The local draft is untouched throughout, including on success. It is deleted
     * by nothing here: the user's own copy stays until a later autosave supersedes
     * it, so a replace that half-worked cannot cost them both copies.
     */
    if (flushed.outcome === "durable") {
      return { kind: "replaced", serverVersion: this.state.serverVersion };
    }
    if (this.state.conflict) {
      return { kind: "still_conflicted", conflict: this.state.conflict };
    }
    return {
      kind: "failed",
      failure:
        flushed.failure ?? persistenceFailure("unknown", "The workspace version was not replaced."),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Sibling tabs                                                      */
  /* ---------------------------------------------------------------- */

  private subscribeToPeers(session: CoordinatorSession): void {
    const bus = this.ports.peers;
    if (!bus) return;
    this.unsubscribePeers = bus.subscribe((message) => {
      if (!this.isCurrent(session)) return;
      const next = observePeer(
        this.peer,
        message,
        { deviceId: this.ports.deviceId, tabId: this.ports.tabId },
        session.documentKey,
      );
      // Identity, not deep equality: `observePeer` returns the same object for
      // every message it rejects.
      if (next === this.peer) return;
      this.peer = next;
      this.ports.diagnostics.emit("peer_commit_observed", {
        revision: next.revision,
        generation: next.generation,
      });
    });
  }

  /* ---------------------------------------------------------------- */
  /* Plumbing                                                          */
  /* ---------------------------------------------------------------- */

  private dispatch(event: PersistenceEvent): void {
    const next = persistenceReducer(this.state, event);
    if (next === this.state) return;
    this.state = next;
    this.ports.onStateChange(next);
  }

  private completionScope(attempt: WriteAttempt): {
    documentId: string;
    documentSessionId: string;
    requestId: string;
    revision: number;
  } {
    return {
      documentId: attempt.documentId,
      documentSessionId: attempt.documentSessionId,
      requestId: attempt.requestId,
      revision: attempt.revision,
    };
  }

  /** The session this attempt belongs to, or null once it has been superseded. */
  private sessionFor(attempt: WriteAttempt): CoordinatorSession | null {
    const session = this.session;
    if (!session || this.disposed) return null;
    if (session.documentSessionId !== attempt.documentSessionId) return null;
    return session;
  }

  /** Whether the document this async work started under is still the open one. */
  private isCurrent(session: CoordinatorSession): boolean {
    return (
      !this.disposed &&
      this.session !== null &&
      this.session.documentSessionId === session.documentSessionId
    );
  }
}

/** Exported for tests that assert the pointer guard cannot be bypassed. */
export function draftPointerKeyFor(documentKey: string): string {
  return draftKeys.pointer(documentKey);
}
