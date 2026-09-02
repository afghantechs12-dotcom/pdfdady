"use client";

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type {
  CapturedDocument,
  ConflictResolution,
  PersistenceView,
  RestoreApplied,
  RestoreOutcome,
} from "@/src/application/editor/persistence/DocumentPersistenceCoordinator";
import type { ConflictActionId } from "@/src/application/editor/persistence/conflictResolution";
import type { DocumentIdentity } from "@/src/application/editor/persistence/documentIdentity";
import type { LoadedDraft } from "@/src/application/editor/persistence/draftRepository";
import type { NavigationGuardVerdict } from "@/src/application/editor/persistence/navigationGuard";
import type { FlushResult } from "@/src/application/editor/persistence/writeScheduler";
import type { PersistenceLimitation } from "@/src/infrastructure/persistence/browser/createPersistenceRuntime";
import { PersistenceBinding } from "@/src/infrastructure/persistence/browser/persistenceBinding";

/**
 * The React binding for document persistence.
 *
 * Everything with a decision in it lives in {@link PersistenceBinding}, which has
 * no React in it and is unit-tested. This file is the glue that cannot be: the
 * suite runs in Node with no DOM, so a hook body is the one place a mistake here
 * cannot be executed by a test. It is therefore kept to the four things only React
 * can do — hold the binding for the lifetime of the mount, mirror its view into
 * render, run its effects, and tear it down — and a source-text test pins that
 * shape so the untestable part stays too small to hide a bug.
 *
 * THE ORDER OF THE EFFECTS MATTERS. `capture` is assigned during render rather
 * than in an effect, because a scheduler timer can fire between render and effects
 * and would then serialise the previous render's document. `attach` comes before
 * `syncDocument` so a tab closed during the first open still flushes.
 */

export interface UseDocumentPersistenceInput {
  /**
   * What kind of surface this is, stated up front rather than read from
   * {@link identity}.
   *
   * The binding is built on the first render, when the document has usually not
   * loaded yet and `identity` is still null. Inferring the origin from it would
   * give a workspace editor a guest runtime — no cloud transport, no autosave to
   * the workspace, and nothing anywhere reporting a problem.
   */
  origin: "guest" | "workspace";
  /** Null before a document is loaded, and after it is closed. */
  identity: DocumentIdentity | null;
  /** `CommandHistory.revision`. Every change to it is one mutation to protect. */
  revision: number;
  /**
   * One synchronous read of the whole document. MUST NOT await, and must return
   * null while the editor has nothing loadable — a capture that returns a
   * half-loaded scene would be committed as a draft of it.
   */
  capture: () => CapturedDocument | null;
  /** The workspace's current version, when the surface already knows it. */
  serverVersion?: number | null;
  etag?: string | null;
  remoteAcknowledgedRevision?: number | null;
  /** False disables persistence entirely (a read-only or preview surface). */
  enabled?: boolean;
}

export interface UseDocumentPersistenceResult {
  /** Null during server rendering and while disabled. */
  view: PersistenceView | null;
  limitations: readonly PersistenceLimitation[];
  /**
   * Work a previous guest tab left behind, when there is no document open to look
   * under — the guest refresh path.
   *
   * Exposed as a method rather than run inside the hook because only the surface
   * knows whether it has a document: after F5 a guest tab has no file, no
   * fingerprint, and possibly no session map, so the draft INDEX is enumerated and
   * the best candidate returned for the surface to open as its identity. That open
   * is what raises the recovery offer. Returns null when there is nothing worth
   * offering, which is the common case and must be silent.
   */
  findAbandonedGuestDraft: () => Promise<DocumentIdentity | null>;
  /**
   * Report that a text box holds characters the document does not have yet.
   *
   * Makes the editor dirty without inventing a revision, and suppresses every
   * durability claim while it is true — a draft written now would not contain the
   * characters, so nothing may call them saved. Call with `false` on commit,
   * cancel, or unmount.
   */
  noteUncommittedInput: (pending: boolean) => void;
  /** Bracket a drag or a multi-step gesture so it is saved once, at the end. */
  beginGesture: (label: string) => void;
  endGesture: (outcome: "commit" | "cancel") => void;
  /** Bracket a document load so it is not mistaken for the user's editing. */
  beginLoad: () => void;
  endLoad: (historyRevision: number) => void;
  restore: (
    apply: (draft: LoadedDraft) => Promise<RestoreApplied> | RestoreApplied,
  ) => Promise<RestoreOutcome>;
  dismissOffer: () => void;
  deleteOffer: () => Promise<void>;
  acknowledgeRecovery: () => void;
  resolveConflict: (
    action: ConflictActionId,
    options?: { confirmed?: boolean },
  ) => Promise<ConflictResolution>;
  retryLocal: () => void;
  retryRemote: () => void;
  /** Tell the coordinator a workspace version was committed for this revision. */
  noteVersionCommitted: (input: {
    revision: number;
    serverVersion: number | null;
    /** The document revision the commit produced — the next fencing token. */
    documentRevision?: number | null;
    etag: string | null;
  }) => void;
  saveNow: () => Promise<FlushResult>;
  /**
   * The navigation guard's verdict, read from the binding at call time.
   *
   * A METHOD, not the `view.navigation` field beside it, and the distinction is the
   * whole reason it exists. Callers ask this question after an await — "is the work
   * safe now that the flush resolved" — and `view` is the snapshot from the render
   * that STARTED the await. Reading the field there answers for the moment before
   * the write, which is the one answer that is never useful.
   */
  canNavigate: () => NavigationGuardVerdict;
}

const NO_LIMITATIONS: readonly PersistenceLimitation[] = [];
/** What a surface with no binding must be told: nothing is open, so nothing is at risk. */
const NOTHING_TO_LOSE: NavigationGuardVerdict = {
  decision: "allow",
  reason: "All changes are saved.",
  actions: [],
  armBeforeUnload: false,
};
const CANCELLED: FlushResult = {
  outcome: "cancelled",
  durableRevision: null,
  queuedRevision: null,
  failure: null,
};

export function useDocumentPersistence(
  input: UseDocumentPersistenceInput,
): UseDocumentPersistenceResult {
  const enabled = input.enabled ?? true;
  const bindingRef = useRef<PersistenceBinding | null>(null);

  /*
   * Created during render, once, and only on the client. Server rendering has no
   * IndexedDB, no Web Locks and no BroadcastChannel; building a runtime there
   * would produce a snapshot describing capabilities the page does not have yet,
   * and hydration would replace it anyway.
   *
   * The `isDisposed` half is the belt, not the trigger: the unmount cleanup below
   * nulls the ref as well as disposing it, so MEASURED IN A REAL DEV BROWSER the
   * null test is what fires both times (`createdFromNull: 2`, and the corpse branch
   * never observed).
   *
   * It is still load-bearing on its own, which was checked rather than argued. With
   * the cleanup's `bindingRef.current = null` deleted so that only this clause can
   * rebuild, the browser probe stays fully green. Deleting BOTH is what breaks the
   * editor, and it breaks it silently: a drag still puts an object on screen and the
   * probe still counts it, while the readout reads "No document" and the draft
   * generation never advances past the one the previous mount wrote. That pair of
   * results is the reason this rebuild path -- not the three disposal guards below
   * it -- is the part of this file the probe actually protects.
   */
  if (
    (bindingRef.current === null || bindingRef.current.isDisposed) &&
    enabled &&
    typeof window !== "undefined"
  ) {
    bindingRef.current = new PersistenceBinding({
      origin: input.origin,
      capture: input.capture,
      scope: window,
    });
  }
  const binding = enabled ? bindingRef.current : null;

  /*
   * Assigned on every render, deliberately, and not inside an effect: the write
   * scheduler's timer can fire between this render and the effects that follow it,
   * and a stale closure there would autosave a document the user has already
   * changed while reporting the write as durable.
   */
  if (binding) binding.setCapture(input.capture);

  const openRevisionRef = useRef(input.revision);
  openRevisionRef.current = input.revision;

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!binding) return () => {};
      /*
       * THE DEV-ONLY MOUNT THAT HANDS OUT A CORPSE.
       *
       * StrictMode runs every effect, tears it down, and runs it again — WITHOUT
       * re-rendering in between. The teardown disposes this binding, so the remount
       * re-subscribes to something whose `publish` early-returns: its cached view can
       * never change again and every method no-ops. React cannot see the problem
       * either — it re-reads `getSnapshot` after subscribing and gets the identical
       * frozen object, so it finds nothing to do.
       *
       * MEASURED, because the mechanism above is easy to assert and easy to be wrong
       * about. Instrumenting the binding in a real dev browser and reaching /editor
       * two ways gave, with these guards absent:
       *
       *   direct load of /editor   → effectCleanups 0   (hydration is NOT double-invoked)
       *   in-app click to /editor  → effectCleanups 1, disposed 1, attachOnDead 1
       *
       * So the teardown is real, but only on a CLIENT-SIDE NAVIGATION mount — which
       * is why the first five phases of `editor-persistence-probe.mjs`, which arrive
       * by navigating straight to the URL, score the same with these guards absent
       * and cannot be the thing that proves any of this. Phase 6 exists to reach this
       * mount the way a user does, by clicking a link inside the app.
       *
       * It also showed the blast radius is smaller than "persistence is dead": the
       * cleanup nulls the ref, so the next render builds a second, healthy binding
       * (`constructed: 2`, `liveAttached: 2`) and autosave recovers on its own.
       *
       * Reporting a store change is what makes that next render certain rather than
       * incidental: without it the rebuild waits on whatever unrelated state happens
       * to change next. Terminating, because the render it asks for builds a binding
       * that is not disposed, so this branch cannot be reached twice for the same one
       * (observed exactly once per navigation: `subscribeOnDead: 1`).
       *
       * Deleting this branch leaves phase 6 green, so what it buys is determinism,
       * not a fixed end state: the rebuild that recovers autosave arrives either way,
       * and this only stops it depending on an unrelated re-render to arrive at all.
       * Kept for that reason, and not described here as a repair of anything.
       */
      if (binding.isDisposed) {
        onStoreChange();
        return () => {};
      }
      return binding.subscribe(onStoreChange);
    },
    [binding],
  );
  const getSnapshot = useCallback(() => (binding ? binding.getView() : null), [binding]);
  const getServerSnapshot = useCallback(() => null, []);
  const view = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  /*
   * Before the identity effect: a tab closed while the first open is still in
   * flight has to reach the flush handlers, and those are installed here.
   */
  useEffect(() => {
    if (!binding) return;
    /*
     * `attach` does not check for disposal, and the handlers it installs reach
     * `runtime.coordinator` — so attaching a StrictMode-disposed binding puts
     * pagehide/beforeunload listeners for a torn-down runtime on the real window.
     * The guard is measured to prevent that: on an in-app navigation to /editor,
     * `attachOnDead` is 1 without the line below and 0 with it.
     *
     * Its value is bounded, and saying so here is deliberate. Those listeners are
     * removed when the binding swap makes React run this effect's own cleanup, so
     * the leak lasts one render rather than the life of the tab -- and a settled
     * window really does carry the same listener counts either way, read straight
     * off `DOMDebugger.getEventListeners` after both arrivals:
     *
     *   with the guard, and without it → pagehide 2, beforeunload 2 (both routes)
     *
     * Nothing a user can see distinguishes them, and phase 6 of the probe passes
     * with this line deleted. It stays because "handlers for a disposed runtime are
     * never installed on the window" is worth being true outright instead of true
     * for a render, but it is hygiene, not the repair of an observable defect.
     */
    if (binding.isDisposed) return;
    return binding.attach();
  }, [binding]);

  const documentKey = input.identity?.documentKey ?? null;
  const identityRef = useRef(input.identity);
  identityRef.current = input.identity;

  useEffect(() => {
    if (!binding) return;
    void binding.syncDocument({
      identity: identityRef.current,
      historyRevision: openRevisionRef.current,
      serverVersion: input.serverVersion ?? null,
      etag: input.etag ?? null,
      remoteAcknowledgedRevision: input.remoteAcknowledgedRevision ?? null,
    });
    // Keyed on the document, not on the identity object: a new object with the
    // same key arrives on every render, and reopening discards the recovery offer.
  }, [binding, documentKey, input.serverVersion, input.etag, input.remoteAcknowledgedRevision]);

  useEffect(() => {
    if (!binding) return;
    binding.noteMutation(input.revision);
  }, [binding, input.revision]);

  useEffect(() => {
    // Unmount only: the binding is created once per mount and owns a database
    // connection, a lock and a broadcast channel, none of which free themselves.
    return () => {
      bindingRef.current?.dispose();
      bindingRef.current = null;
    };
  }, []);

  return useMemo<UseDocumentPersistenceResult>(
    () => ({
      view,
      limitations: binding?.runtime.limitations ?? NO_LIMITATIONS,
      findAbandonedGuestDraft: () =>
        binding?.findAbandonedGuestDraft() ?? Promise.resolve(null),
      noteUncommittedInput: (pending) => binding?.noteUncommittedInput(pending),
      beginGesture: (label) => binding?.beginGesture(label),
      endGesture: (outcome) => binding?.endGesture(outcome),
      beginLoad: () => binding?.beginLoad(),
      endLoad: (historyRevision) => binding?.endLoad(historyRevision),
      restore: (apply) => binding?.restore(apply) ?? Promise.resolve({ kind: "no_draft" as const }),
      dismissOffer: () => binding?.dismissOffer(),
      deleteOffer: () => binding?.deleteOffer() ?? Promise.resolve(),
      acknowledgeRecovery: () => binding?.acknowledgeRecovery(),
      resolveConflict: (action, options) =>
        binding?.resolveConflict(action, options) ??
        Promise.resolve({ kind: "not_owned" as const, action }),
      retryLocal: () => binding?.retryLocal(),
      retryRemote: () => binding?.retryRemote(),
      noteVersionCommitted: (committed) => binding?.noteVersionCommitted(committed),
      saveNow: () => binding?.flushLocal() ?? Promise.resolve(CANCELLED),
      canNavigate: () => binding?.canNavigate() ?? NOTHING_TO_LOSE,
    }),
    [binding, view],
  );
}
