import type {
  CapturedDocument,
  ConflictResolution,
  PersistenceView,
  RestoreApplied,
  RestoreOutcome,
} from "../../../application/editor/persistence/DocumentPersistenceCoordinator";
import type { ConflictActionId } from "../../../application/editor/persistence/conflictResolution";
import {
  chooseRecoverableGuestDraft,
  describeRecoveredDraft,
  type DocumentIdentity,
} from "../../../application/editor/persistence/documentIdentity";
import type { LoadedDraft } from "../../../application/editor/persistence/draftRepository";
import type { NavigationGuardVerdict } from "../../../application/editor/persistence/navigationGuard";
import type { FlushResult } from "../../../application/editor/persistence/writeScheduler";
import {
  createPersistenceRuntime,
  type PersistenceRuntime,
  type PersistenceRuntimeOptions,
} from "./createPersistenceRuntime";

/**
 * Everything the React hook would otherwise have to do, with no React in it.
 *
 * This file exists because of how this codebase can be tested: the suite runs in
 * Node with no DOM, so a hook's body is the one place a mistake cannot be caught by
 * a test. Two of the mistakes available here are silent and destroy data, so they
 * are not left in that place:
 *
 *  - A FROZEN `capture`. Every render produces a new capture closure. A binding
 *    that kept the first one would autosave the document as it looked on mount,
 *    forever, while reporting each write as durable. {@link setCapture} exists so
 *    the closure is replaced rather than captured, and a test proves the newest one
 *    is what gets called.
 *
 *  - A RECOMPUTED SNAPSHOT. `coordinator.view` is a getter that builds a fresh
 *    object on every read. Handed straight to `useSyncExternalStore` that is an
 *    infinite render loop, which is why {@link getView} returns a cached object
 *    that changes identity only when the state does.
 *
 * It also owns the page-lifecycle listeners, because the last chance to save is an
 * event and the correct set of events is not obvious: `beforeunload` is where a
 * warning can still be shown, `pagehide` is where a flush can still start, and
 * `visibilitychange` is the only one of the three that fires reliably when a mobile
 * browser discards the tab.
 */

export interface PersistenceBindingOptions extends Omit<PersistenceRuntimeOptions, "onStateChange"> {
  /** Notified after the cached view has been replaced. */
  onChange?: (view: PersistenceView) => void;
}

export interface SyncDocumentInput {
  /** Null closes whatever is open: no document means nothing to protect. */
  identity: DocumentIdentity | null;
  historyRevision: number;
  online?: boolean;
  serverVersion?: number | null;
  etag?: string | null;
  remoteAcknowledgedRevision?: number | null;
}

const LIFECYCLE_EVENTS = ["pagehide", "visibilitychange", "beforeunload", "online", "offline"] as const;

export class PersistenceBinding {
  readonly runtime: PersistenceRuntime;

  private cachedView: PersistenceView;
  private readonly listeners = new Set<() => void>();
  private capture: () => CapturedDocument | null;
  private readonly onChange: ((view: PersistenceView) => void) | undefined;
  private readonly scope: Record<string, unknown>;

  /** The identity currently open, so an unchanged one is not reopened. */
  private openKey: string | null = null;
  /**
   * The tail of the open/close chain.
   *
   * Identity changes arrive from an effect and `openDocument` is async. Without
   * serialising, a fast switch could have the second open land before the first
   * one's close, leaving the coordinator serving the document that is no longer on
   * screen.
   */
  private queue: Promise<unknown> = Promise.resolve();
  private detach: (() => void) | null = null;
  private disposed = false;
  /**
   * The same clock the runtime was given.
   *
   * Not `Date.now` directly: a draft's age decides whether it is offered at all,
   * and a test that cannot move the clock cannot cover the boundary where an
   * old draft stops being offered.
   */
  private readonly clock: () => number;

  constructor(options: PersistenceBindingOptions) {
    this.clock = options.now ?? (() => Date.now());
    this.capture = options.capture;
    this.onChange = options.onChange;
    this.scope =
      (options.scope as Record<string, unknown> | undefined) ??
      (globalThis as unknown as Record<string, unknown>);

    this.runtime = createPersistenceRuntime({
      ...options,
      // Indirected on purpose: see the class comment on frozen captures.
      capture: () => this.capture(),
      onStateChange: () => this.publish(),
    });
    this.cachedView = this.runtime.coordinator.view;
  }

  /* ---------------- reading ---------------- */

  /**
   * The current view, stable by reference until the state changes.
   *
   * `useSyncExternalStore` compares snapshots with `Object.is` on every render and
   * re-renders when they differ, so returning `coordinator.view` here — a fresh
   * object each read — would never stop rendering.
   */
  getView(): PersistenceView {
    return this.cachedView;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Replaces the capture closure. Called on every render by design. */
  setCapture(capture: () => CapturedDocument | null): void {
    this.capture = capture;
  }

  private publish(): void {
    if (this.disposed) return;
    this.cachedView = this.runtime.coordinator.view;
    for (const listener of this.listeners) listener();
    this.onChange?.(this.cachedView);
  }

  /**
   * Recomputes the view after something that changed it without a reducer event.
   *
   * The recovery offer and the peer's generation live on the coordinator rather
   * than in the reducer, so adopting or declining a draft can leave the cached
   * snapshot describing a decision the user has already made.
   */
  refresh(): void {
    this.publish();
  }

  /* ---------------- the document ---------------- */

  /**
   * Opens, closes, or switches the document.
   *
   * Returns the queue tail so a caller (and a test) can wait for the effect to
   * settle instead of guessing at a tick count.
   */
  syncDocument(input: SyncDocumentInput): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed) return;
      const nextKey = input.identity?.documentKey ?? null;

      if (nextKey === null) {
        if (this.openKey !== null) {
          this.runtime.coordinator.closeDocument();
          this.openKey = null;
          this.publish();
        }
        return;
      }

      /*
       * Reopening the same document would mint a new document-session id, discard a
       * recovery offer the user has not answered yet, and reset the revision
       * baseline — so a re-render with the same identity must be a no-op.
       */
      if (nextKey === this.openKey) return;

      const identity = input.identity as DocumentIdentity;
      await this.runtime.coordinator.openDocument({
        ...identity,
        historyRevision: input.historyRevision,
        online: input.online ?? readOnline(this.scope),
        serverVersion: input.serverVersion ?? null,
        etag: input.etag ?? null,
        remoteAcknowledgedRevision: input.remoteAcknowledgedRevision ?? null,
      });

      /*
       * Part of opening, not a step after it. A draft left by a previous session is
       * the whole point of the local channel, and looking for it here — inside the
       * same serialised task — is what stops a fast document switch from showing
       * the previous document's recovery offer over the new one.
       */
      if (this.openKeyStillWanted(nextKey)) {
        await this.runtime.coordinator.findRecoverableDraft();
      }

      this.openKey = nextKey;
      this.publish();
    });
  }

  /** The key currently open, for tests and for excluding it from a recovery offer. */
  get openDocumentKey(): string | null {
    return this.openKey;
  }

  /**
   * Whether the coordinator is still serving the document this task opened.
   *
   * Nothing else can run between the open and the probe — the queue guarantees
   * that — but `dispose` can, and probing a disposed coordinator would publish a
   * view for a document that is gone.
   */
  private openKeyStillWanted(key: string): boolean {
    return !this.disposed && this.runtime.coordinator.view.state.documentId !== null && key !== null;
  }

  /* ---------------- editing ---------------- */

  noteMutation(historyRevision: number): void {
    if (this.disposed) return;
    this.runtime.coordinator.noteMutation(historyRevision);
  }

  noteUncommittedInput(pending: boolean): void {
    if (!this.disposed) this.runtime.coordinator.noteUncommittedInput(pending);
  }

  beginGesture(label: string): void {
    if (!this.disposed) this.runtime.coordinator.beginGesture(label);
  }

  endGesture(outcome: "commit" | "cancel"): void {
    if (!this.disposed) this.runtime.coordinator.endGesture(outcome);
  }

  beginLoad(): void {
    if (!this.disposed) this.runtime.coordinator.beginLoad();
  }

  endLoad(historyRevision: number): void {
    if (!this.disposed) this.runtime.coordinator.endLoad(historyRevision);
  }

  /* ---------------- recovery and conflicts ---------------- */

  /**
   * Looks for work left behind by a tab that had no chance to say goodbye, when
   * there is no document open to look under.
   *
   * This is the guest refresh path, and it needs its own entry point because the
   * ordinary probe runs inside {@link syncDocument} — it can only find a draft for
   * a document key it already has. After F5 a guest tab has no file: the picker
   * cannot be pre-filled, the fingerprint cannot be computed, and the sessionStorage
   * map that maps file to key is per-tab and may itself be gone. So the draft INDEX
   * is enumerated instead and the best guest candidate is returned for the caller to
   * open, which is what then produces the offer.
   *
   * Returns null when there is nothing worth offering — which is the common case,
   * and must be cheap and silent.
   */
  async findAbandonedGuestDraft(): Promise<DocumentIdentity | null> {
    if (this.disposed) return null;
    return this.enqueue(async () => {
      if (this.disposed) return null;
      let drafts;
      try {
        drafts = await this.runtime.repository.listDrafts();
      } catch (error) {
        /*
         * A store that cannot be read is not an error to show anyone: the user
         * did not ask for recovery, they opened the editor. It is recorded so a
         * support conversation is possible.
         */
        this.runtime.diagnostics.emit("draft_load_failed", {
          stage: "index",
          message: error instanceof Error ? error.message : "listDrafts failed",
        });
        return null;
      }
      const chosen = chooseRecoverableGuestDraft({
        drafts,
        now: this.clock(),
        // Whatever is already open is not "left behind".
        excludeDocumentKeys: this.openKey === null ? [] : [this.openKey],
      });
      return chosen === null ? null : describeRecoveredDraft(chosen);
    });
  }

  async findRecoverableDraft(): Promise<void> {
    if (this.disposed) return;
    await this.runtime.coordinator.findRecoverableDraft();
    this.publish();
  }

  async restore(
    apply: (draft: LoadedDraft) => Promise<RestoreApplied> | RestoreApplied,
  ): Promise<RestoreOutcome> {
    if (this.disposed) return { kind: "no_draft" };
    const outcome = await this.runtime.coordinator.restoreOfferedDraft(apply);
    this.publish();
    return outcome;
  }

  dismissOffer(): void {
    if (this.disposed) return;
    this.runtime.coordinator.dismissOfferedDraft();
    this.publish();
  }

  async deleteOffer(): Promise<void> {
    if (this.disposed) return;
    await this.runtime.coordinator.deleteOfferedDraft();
    this.publish();
  }

  acknowledgeRecovery(): void {
    if (this.disposed) return;
    this.runtime.coordinator.acknowledgeRecovery();
    this.publish();
  }

  async resolveConflict(
    action: ConflictActionId,
    options: { confirmed?: boolean } = {},
  ): Promise<ConflictResolution> {
    if (this.disposed) return { kind: "not_owned", action };
    const resolution = await this.runtime.coordinator.resolveConflict(action, options);
    this.publish();
    return resolution;
  }

  retryLocal(): void {
    if (!this.disposed) this.runtime.coordinator.retryLocal();
  }

  retryRemote(): void {
    if (!this.disposed) this.runtime.coordinator.retryRemote();
  }

  noteVersionCommitted(input: {
    revision: number;
    serverVersion: number | null;
    documentRevision?: number | null;
    etag: string | null;
  }): void {
    if (!this.disposed) this.runtime.coordinator.noteVersionCommitted(input);
  }

  /* ---------------- saving on demand ---------------- */

  async flushLocal(): Promise<FlushResult> {
    if (this.disposed) return { outcome: "cancelled", durableRevision: null, queuedRevision: null, failure: null };
    return this.runtime.coordinator.flushLocal();
  }

  async flushRemote(): Promise<FlushResult> {
    if (this.disposed) return { outcome: "cancelled", durableRevision: null, queuedRevision: null, failure: null };
    return this.runtime.coordinator.flushRemote();
  }

  canNavigate(): NavigationGuardVerdict {
    return this.cachedView.navigation;
  }

  /* ---------------- page lifecycle ---------------- */

  /**
   * Installs the listeners that make a closing tab try to save.
   *
   * Idempotent: attaching twice would double every flush and double-arm the unload
   * prompt, and an effect that re-runs is normal.
   */
  attach(): () => void {
    if (this.detach) return this.detach;
    const target = this.scope as {
      addEventListener?: (type: string, listener: (event: unknown) => void) => void;
      removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
    };
    if (typeof target.addEventListener !== "function") {
      this.detach = () => {};
      return this.detach;
    }

    const handlers: Array<[string, (event: unknown) => void]> = [
      ["pagehide", () => void this.runtime.coordinator.flushOnHide()],
      [
        "visibilitychange",
        () => {
          /*
           * The reliable last event on mobile: a backgrounded tab is often
           * discarded without `pagehide` or `beforeunload` ever firing.
           */
          if ((this.scope as { document?: { visibilityState?: string } }).document?.visibilityState === "hidden") {
            void this.runtime.coordinator.flushOnHide();
          }
        },
      ],
      [
        "beforeunload",
        (event) => {
          if (!this.cachedView.armBeforeUnload) return;
          /*
           * Both, because browsers disagree about which one arms the prompt, and
           * neither is enough alone across the range this app supports.
           */
          const unloadEvent = event as { preventDefault?: () => void; returnValue?: unknown };
          unloadEvent.preventDefault?.();
          unloadEvent.returnValue = "";
          void this.runtime.coordinator.flushOnHide();
        },
      ],
      ["online", () => void this.runtime.coordinator.setOnline(true)],
      ["offline", () => void this.runtime.coordinator.setOnline(false)],
    ];

    for (const [type, handler] of handlers) target.addEventListener(type, handler);

    this.detach = () => {
      for (const [type, handler] of handlers) target.removeEventListener?.(type, handler);
      this.detach = null;
    };
    return this.detach;
  }

  dispose(): void {
    if (this.disposed) return;
    this.detach?.();
    this.disposed = true;
    this.listeners.clear();
    this.runtime.dispose();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    // `catch` on the tail so one rejected open does not wedge the chain forever.
    const next = this.queue.then(task, task);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/** What the browser says about connectivity, defaulting to online. */
export function readOnline(scope: unknown): boolean {
  const navigatorLike = (scope as { navigator?: { onLine?: unknown } } | undefined)?.navigator;
  return typeof navigatorLike?.onLine === "boolean" ? navigatorLike.onLine : true;
}

/** Names the lifecycle events this binding listens for, so a test can assert the set. */
export const PERSISTENCE_LIFECYCLE_EVENTS: readonly string[] = LIFECYCLE_EVENTS;
