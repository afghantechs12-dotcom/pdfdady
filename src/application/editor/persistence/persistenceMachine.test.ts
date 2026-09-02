import { describe, expect, it } from "vitest";
import {
  INITIAL_PERSISTENCE_STATE,
  hasUnprotectedWork,
  isCurrentRevisionCommitted,
  isCurrentRevisionLocallyDurable,
  isCurrentRevisionRemotelyAcknowledged,
  persistenceReducer,
  type PersistenceState,
} from "./persistenceMachine";
import { PERSISTENCE_EVENT_TYPES, persistenceFailure, type PersistenceEvent } from "./events";

/**
 * The reducer's safety claims, and the two that a plausible-looking
 * implementation gets backwards.
 *
 * The first is `local === "unavailable"`. It is tempting to read "there is no
 * store" as "the store has nothing left to do", because in both cases no write is
 * outstanding — and that reading is how a guest document in private browsing
 * reports itself clean, unblocks navigation, and disappears when the tab closes.
 * Unavailable is the ABSENCE of durability, never a substitute for it.
 *
 * The second is what opening a document proves. A document as opened is safe to
 * close, and the obvious way to encode that is to set the local watermark to the
 * opened revision — which then asserts, falsely, that an IndexedDB draft exists.
 * The distinction those two collapse is the difference between "nothing to lose"
 * and "already saved", and the user is told them apart: one has no draft on this
 * device and the other does.
 *
 * So the model here keeps `baselineRevision` — the untouched source — apart from
 * `lastLocallyDurableRevision`, which moves only when a write is verified.
 */

const DOC = "doc-1";
const SESSION = "session-a";

function opened(overrides: Partial<Extract<PersistenceEvent, { type: "DOCUMENT_OPENED" }>> = {}) {
  return persistenceReducer(INITIAL_PERSISTENCE_STATE, {
    type: "DOCUMENT_OPENED",
    documentId: DOC,
    documentSessionId: SESSION,
    revision: 0,
    remoteEnabled: false,
    online: true,
    at: 1_000,
    ...overrides,
  });
}

/** Applies a list of events in order, for the multi-step scenarios. */
function run(state: PersistenceState, ...events: PersistenceEvent[]): PersistenceState {
  return events.reduce(persistenceReducer, state);
}

function mutate(state: PersistenceState, revision: number, at = 2_000): PersistenceState {
  return persistenceReducer(state, {
    type: "DOCUMENT_MUTATED",
    documentId: DOC,
    documentSessionId: SESSION,
    revision,
    at,
  });
}

/** Schedules and starts a local write, which is what makes a completion current. */
function startLocal(state: PersistenceState, requestId: string, revision: number) {
  return run(
    state,
    { type: "LOCAL_WRITE_SCHEDULED", documentId: DOC, documentSessionId: SESSION, requestId, revision, at: 2_100 },
    { type: "LOCAL_WRITE_STARTED", documentId: DOC, documentSessionId: SESSION, requestId, revision, at: 2_200 },
  );
}

function startRemote(state: PersistenceState, requestId: string, revision: number) {
  return run(
    state,
    { type: "REMOTE_SAVE_SCHEDULED", documentId: DOC, documentSessionId: SESSION, requestId, revision, at: 2_100 },
    { type: "REMOTE_SAVE_STARTED", documentId: DOC, documentSessionId: SESSION, requestId, revision, at: 2_200 },
  );
}

function localSucceeded(state: PersistenceState, requestId: string, revision: number, at = 2_300) {
  return persistenceReducer(state, {
    type: "LOCAL_WRITE_SUCCEEDED",
    documentId: DOC,
    documentSessionId: SESSION,
    requestId,
    revision,
    at,
    draftId: "draft-1",
  });
}

function remoteSucceeded(state: PersistenceState, requestId: string, revision: number, at = 2_400) {
  return persistenceReducer(state, {
    type: "REMOTE_SAVE_SUCCEEDED",
    documentId: DOC,
    documentSessionId: SESSION,
    requestId,
    revision,
    at,
    serverVersion: 7,
    etag: "etag-7",
  });
}

describe("event vocabulary", () => {
  it("enumerates every event type exactly once", () => {
    expect(new Set(PERSISTENCE_EVENT_TYPES).size).toBe(PERSISTENCE_EVENT_TYPES.length);
  });
});

describe("defect A — local storage unavailable is not durability", () => {
  /**
   * The scenario in full: a guest document (no remote channel at all), an edit
   * the user can see on screen, and a browser that will not open IndexedDB.
   * Nothing anywhere holds revision 1.
   */
  function guestWithUnavailableStorage(): PersistenceState {
    const state = mutate(opened(), 1);
    const requestId = "req-local-1";
    const started = startLocal(state, requestId, 1);
    return persistenceReducer(started, {
      type: "LOCAL_WRITE_FAILED",
      documentId: DOC,
      documentSessionId: SESSION,
      requestId,
      revision: 1,
      at: 2_300,
      failure: persistenceFailure("storage_unavailable", "No local storage in this context."),
    });
  }

  it("reports the document as dirty, not clean", () => {
    const state = guestWithUnavailableStorage();
    expect(state.local).toBe("unavailable");
    expect(state.edit).toBe("dirty");
  });

  it("reports unprotected work, so navigation is blocked", () => {
    expect(hasUnprotectedWork(guestWithUnavailableStorage())).toBe(true);
  });

  it("does not claim the current revision is locally durable", () => {
    const state = guestWithUnavailableStorage();
    expect(isCurrentRevisionLocallyDurable(state)).toBe(false);
    expect(state.lastLocallyDurableRevision).toBeLessThan(state.currentRevision);
  });

  it("still lets a workspace document be safe when the server acknowledged it", () => {
    /*
     * The other direction, and the reason this is not simply "unavailable means
     * unsafe": a remotely acknowledged revision IS durable. Local unavailability
     * removes one guarantee; it does not remove the other.
     */
    let state = opened({ remoteEnabled: true, serverVersion: 4 });
    state = mutate(state, 1);
    state = startLocal(state, "req-l", 1);
    state = persistenceReducer(state, {
      type: "LOCAL_WRITE_FAILED",
      documentId: DOC,
      documentSessionId: SESSION,
      requestId: "req-l",
      revision: 1,
      at: 2_300,
      failure: persistenceFailure("storage_unavailable", "No local storage in this context."),
    });
    state = startRemote(state, "req-r", 1);
    state = remoteSucceeded(state, "req-r", 1);

    expect(state.local).toBe("unavailable");
    expect(state.edit).toBe("clean");
    expect(hasUnprotectedWork(state)).toBe(false);
  });
});

describe("defect B — opening a document fabricates no local draft", () => {
  it("leaves the local watermark below the opened revision", () => {
    const state = opened({ revision: 12 });
    expect(state.currentRevision).toBe(12);
    // The document exists; a draft of it on THIS device does not.
    expect(state.lastLocallyDurableRevision).toBeLessThan(12);
    expect(isCurrentRevisionLocallyDurable(state)).toBe(false);
  });

  it("treats an untouched guest document as safe without claiming a draft", () => {
    const state = opened({ revision: 12 });
    expect(state.edit).toBe("clean");
    expect(hasUnprotectedWork(state)).toBe(false);
    expect(state.baselineRevision).toBe(12);
  });

  it("treats an untouched workspace document as remotely safe", () => {
    const state = opened({ revision: 3, remoteEnabled: true, serverVersion: 9 });
    expect(state.edit).toBe("clean");
    expect(isCurrentRevisionRemotelyAcknowledged(state)).toBe(true);
    expect(hasUnprotectedWork(state)).toBe(false);
    // …and still no local draft.
    expect(isCurrentRevisionLocallyDurable(state)).toBe(false);
  });

  it("going offline before the first local write claims nothing about this device", () => {
    const state = persistenceReducer(opened({ remoteEnabled: true, revision: 2, serverVersion: 1 }), {
      type: "NETWORK_WENT_OFFLINE",
      at: 1_500,
    });
    expect(state.local).toBe("idle");
    expect(isCurrentRevisionLocallyDurable(state)).toBe(false);
  });

  it("makes the first edit unprotected until a write completes", () => {
    const state = mutate(opened({ revision: 12 }), 13);
    expect(state.edit).toBe("dirty");
    expect(hasUnprotectedWork(state)).toBe(true);
  });

  it("advances the local watermark on a verified commit, and only then", () => {
    let state = mutate(opened({ revision: 12 }), 13);
    expect(hasUnprotectedWork(state)).toBe(true);
    state = startLocal(state, "req-1", 13);
    // In flight is not durable.
    expect(hasUnprotectedWork(state)).toBe(true);
    state = localSucceeded(state, "req-1", 13);
    expect(state.lastLocallyDurableRevision).toBe(13);
    expect(state.edit).toBe("clean");
    expect(hasUnprotectedWork(state)).toBe(false);
    expect(state.draftId).toBe("draft-1");
  });

  it("keeps the baseline out of a NEW session's watermarks", () => {
    // Opening a different document must not inherit the previous one's baseline.
    const first = mutate(opened({ revision: 12 }), 13);
    const second = persistenceReducer(first, {
      type: "DOCUMENT_OPENED",
      documentId: "doc-2",
      documentSessionId: "session-b",
      revision: 0,
      remoteEnabled: false,
      online: true,
      at: 5_000,
    });
    expect(second.baselineRevision).toBe(0);
    expect(second.currentRevision).toBe(0);
    expect(second.edit).toBe("clean");
  });
});

describe("stale completions", () => {
  it("ignores a completion whose request is not the active attempt", () => {
    let state = mutate(opened(), 10);
    state = startLocal(state, "req-10", 10);
    state = mutate(state, 11);
    state = startLocal(state, "req-11", 11);

    const before = state.lastLocallyDurableRevision;
    const after = localSucceeded(state, "req-10", 10);

    expect(after.lastLocallyDurableRevision).toBe(before);
    expect(after.staleResponsesIgnored).toBe(state.staleResponsesIgnored + 1);
  });

  it("cannot acknowledge a NEWER revision than the attempt actually wrote", () => {
    let state = mutate(opened(), 10);
    state = startLocal(state, "req-10", 10);
    state = mutate(state, 11);
    // The attempt that completes wrote 10. 11 must remain unprotected.
    state = localSucceeded(state, "req-10", 10);
    expect(state.lastLocallyDurableRevision).toBe(10);
    expect(state.currentRevision).toBe(11);
    expect(hasUnprotectedWork(state)).toBe(true);
  });

  it("ignores a completion from a closed session", () => {
    let state = mutate(opened(), 10);
    state = startLocal(state, "req-10", 10);
    state = persistenceReducer(state, {
      type: "DOCUMENT_CLOSED",
      documentId: DOC,
      documentSessionId: SESSION,
      at: 3_000,
    });
    const after = localSucceeded(state, "req-10", 10);
    expect(after.lastLocallyDurableRevision).toBe(INITIAL_PERSISTENCE_STATE.lastLocallyDurableRevision);
    expect(after.staleResponsesIgnored).toBeGreaterThan(0);
  });

  it("ignores a completion addressed to a different document", () => {
    let state = mutate(opened(), 10);
    state = startLocal(state, "req-10", 10);
    const after = persistenceReducer(state, {
      type: "LOCAL_WRITE_SUCCEEDED",
      documentId: "other-doc",
      documentSessionId: SESSION,
      requestId: "req-10",
      revision: 10,
      at: 2_300,
      draftId: "draft-x",
    });
    expect(after.lastLocallyDurableRevision).toBeLessThan(10);
  });

  it("keeps local durability when a remote save fails", () => {
    let state = mutate(opened({ remoteEnabled: true, serverVersion: 2 }), 5);
    state = startLocal(state, "req-l", 5);
    state = localSucceeded(state, "req-l", 5);
    state = startRemote(state, "req-r", 5);
    state = persistenceReducer(state, {
      type: "REMOTE_SAVE_FAILED",
      documentId: DOC,
      documentSessionId: SESSION,
      requestId: "req-r",
      revision: 5,
      at: 2_500,
      failure: persistenceFailure("network", "offline"),
    });
    expect(state.lastLocallyDurableRevision).toBe(5);
    expect(isCurrentRevisionLocallyDurable(state)).toBe(true);
    expect(hasUnprotectedWork(state)).toBe(false);
  });

  it("keeps remote acknowledgement when a local write fails", () => {
    let state = mutate(opened({ remoteEnabled: true, serverVersion: 2 }), 5);
    state = startRemote(state, "req-r", 5);
    state = remoteSucceeded(state, "req-r", 5);
    state = startLocal(state, "req-l", 5);
    state = persistenceReducer(state, {
      type: "LOCAL_WRITE_FAILED",
      documentId: DOC,
      documentSessionId: SESSION,
      requestId: "req-l",
      revision: 5,
      at: 2_600,
      failure: persistenceFailure("quota_exceeded", "full"),
    });
    expect(state.lastRemoteAcknowledgedRevision).toBe(5);
    expect(hasUnprotectedWork(state)).toBe(false);
  });
});

describe("conflict", () => {
  it("leaves the local draft and watermark untouched", () => {
    let state = mutate(opened({ remoteEnabled: true, serverVersion: 2 }), 5);
    state = startLocal(state, "req-l", 5);
    state = localSucceeded(state, "req-l", 5);
    state = startRemote(state, "req-r", 5);
    state = persistenceReducer(state, {
      type: "CONFLICT_DETECTED",
      documentId: DOC,
      documentSessionId: SESSION,
      requestId: "req-r",
      revision: 5,
      at: 2_700,
      conflict: {
        localRevision: 5,
        expectedServerVersion: 2,
        actualServerVersion: 6,
        detail: null,
        detectedAt: 2_700,
      },
    });
    expect(state.remote).toBe("conflict");
    expect(state.lastLocallyDurableRevision).toBe(5);
    expect(state.draftId).toBe("draft-1");
    expect(state.serverVersion).toBe(6);
  });

  it("survives going offline", () => {
    let state = mutate(opened({ remoteEnabled: true, serverVersion: 2 }), 5);
    state = startRemote(state, "req-r", 5);
    state = persistenceReducer(state, {
      type: "CONFLICT_DETECTED",
      documentId: DOC,
      documentSessionId: SESSION,
      requestId: "req-r",
      revision: 5,
      at: 2_700,
      conflict: { localRevision: 5, expectedServerVersion: 2, actualServerVersion: 6, detail: null, detectedAt: 2_700 },
    });
    state = persistenceReducer(state, { type: "NETWORK_WENT_OFFLINE", at: 2_800 });
    expect(state.remote).toBe("conflict");
  });
});

describe("recovery", () => {
  it("restores the revision and marks it locally durable", () => {
    let state = opened({ revision: 0 });
    state = persistenceReducer(state, {
      type: "RECOVERY_STARTED",
      draftId: "draft-9",
      at: 3_000,
    });
    state = persistenceReducer(state, {
      type: "RECOVERY_SUCCEEDED",
      documentId: DOC,
      documentSessionId: SESSION,
      draftId: "draft-9",
      revision: 80,
      locallyDurable: true,
      at: 3_100,
    });
    expect(state.currentRevision).toBe(80);
    expect(state.lastLocallyDurableRevision).toBe(80);
    expect(state.recovery).toBe("recovered");
    expect(state.recoveredRevision).toBe(80);
  });

  it("does not mark a recovered workspace draft as remotely synced", () => {
    let state = opened({ revision: 0, remoteEnabled: true, serverVersion: 3 });
    state = persistenceReducer(state, {
      type: "RECOVERY_SUCCEEDED",
      documentId: DOC,
      documentSessionId: SESSION,
      draftId: "draft-9",
      revision: 80,
      locallyDurable: true,
      at: 3_100,
    });
    expect(isCurrentRevisionRemotelyAcknowledged(state)).toBe(false);
    expect(state.edit).toBe("dirty");
  });

  it("does not claim local durability when the restore had to repair the snapshot", () => {
    let state = opened({ revision: 0 });
    state = persistenceReducer(state, {
      type: "RECOVERY_SUCCEEDED",
      documentId: DOC,
      documentSessionId: SESSION,
      draftId: "draft-9",
      revision: 80,
      locallyDurable: false,
      at: 3_100,
    });
    expect(isCurrentRevisionLocallyDurable(state)).toBe(false);
    expect(hasUnprotectedWork(state)).toBe(true);
  });

  it("advances the baseline so a recovered document is not permanently dirty-by-baseline", () => {
    /*
     * The recovered revision IS the document now. It is locally durable, so the
     * baseline follows it — otherwise every later comparison would measure the
     * user's edits from a revision that no longer exists anywhere.
     */
    let state = opened({ revision: 0 });
    state = persistenceReducer(state, {
      type: "RECOVERY_SUCCEEDED",
      documentId: DOC,
      documentSessionId: SESSION,
      draftId: "draft-9",
      revision: 80,
      locallyDurable: true,
      at: 3_100,
    });
    expect(state.edit).toBe("clean");
    expect(hasUnprotectedWork(state)).toBe(false);
  });
});

describe("retry", () => {
  it("refuses to count a retry of a non-retryable failure", () => {
    let state = mutate(opened(), 5);
    state = startLocal(state, "req-l", 5);
    state = persistenceReducer(state, {
      type: "LOCAL_WRITE_FAILED",
      documentId: DOC,
      documentSessionId: SESSION,
      requestId: "req-l",
      revision: 5,
      at: 2_300,
      failure: persistenceFailure("quota_exceeded", "full"),
    });
    const after = persistenceReducer(state, { type: "RETRY_REQUESTED", channel: "local", at: 2_400 });
    expect(after.localChannel.retryCount).toBe(0);
  });

  it("counts a retry of a retryable failure", () => {
    let state = mutate(opened(), 5);
    state = startLocal(state, "req-l", 5);
    state = persistenceReducer(state, {
      type: "LOCAL_WRITE_FAILED",
      documentId: DOC,
      documentSessionId: SESSION,
      requestId: "req-l",
      revision: 5,
      at: 2_300,
      failure: persistenceFailure("transaction_aborted", "aborted"),
    });
    const after = persistenceReducer(state, { type: "RETRY_REQUESTED", channel: "local", at: 2_400 });
    expect(after.localChannel.retryCount).toBe(1);
  });
});

describe("defect I — a stored autosave draft is not a published version", () => {
  function workspaceOpen() {
    return opened({ remoteEnabled: true, revision: 4, serverVersion: 9, etag: "etag-9" });
  }

  function committed(
    state: PersistenceState,
    revision: number,
    serverVersion: number | null,
    documentRevision: number | null = null,
    at = 3_000,
  ) {
    return persistenceReducer(state, {
      type: "REMOTE_VERSION_COMMITTED",
      documentId: DOC,
      documentSessionId: SESSION,
      requestId: "commit-1",
      revision,
      serverVersion,
      documentRevision,
      etag: "etag-10",
      at,
    });
  }

  it("does not claim a version was published just because an autosave draft landed", () => {
    let s = mutate(workspaceOpen(), 6);
    s = startRemote(s, "r1", 6);
    s = remoteSucceeded(s, "r1", 6);
    expect(isCurrentRevisionRemotelyAcknowledged(s)).toBe(true);
    // The stronger claim is not made, because the route did not make it: it echoed
    // the base version back rather than creating one.
    expect(isCurrentRevisionCommitted(s)).toBe(false);
    expect(s.lastCommittedRevision).toBe(-1);
    expect(s.committedServerVersion).toBeNull();
  });

  it("records the published version when a commit really happens", () => {
    const s = committed(mutate(workspaceOpen(), 6), 6, 10, 13);
    expect(isCurrentRevisionCommitted(s)).toBe(true);
    expect(s.committedServerVersion).toBe(10);
    // A published version necessarily means the server holds the bytes.
    expect(s.lastRemoteAcknowledgedRevision).toBe(6);
    /*
     * The two numbers this event carries are NOT the same number, and this is the
     * one place both are stored. `committedServerVersion` is what a user is shown —
     * "document version 10". `serverVersion` is the compare-and-swap token, so it
     * takes the document revision the publish produced: 13, which the server
     * reported and which is neither the version number nor the 9 this document was
     * opened at. Storing 10 here is the own-write conflict — see
     * `ownWriteConflict.test.ts` for what it costs a user.
     */
    expect(s.serverVersion).toBe(13);
  });

  it("leaves the compare-and-swap token alone when the commit discloses no revision", () => {
    // A server that does not report the revision it produced cannot be guessed at:
    // not from the version number, and not from zero. The token stays where the
    // last read put it, and the next write is fenced against that.
    const s = committed(mutate(workspaceOpen(), 6), 6, 10);
    expect(s.committedServerVersion).toBe(10);
    expect(s.serverVersion).toBe(9);
  });

  it("will not quote a version the server did not disclose", () => {
    const s = committed(mutate(workspaceOpen(), 6), 6, null);
    expect(s.lastCommittedRevision).toBe(6);
    // The revision is recorded; the claim that depends on a quotable number is not.
    expect(isCurrentRevisionCommitted(s)).toBe(false);
  });

  it("does not let a commit of an older revision retract a newer acknowledgement", () => {
    let s = mutate(workspaceOpen(), 9);
    s = remoteSucceeded(startRemote(s, "r1", 9), "r1", 9);
    s = committed(s, 6, 10);
    expect(s.lastRemoteAcknowledgedRevision).toBe(9);
    // And the older commit does not satisfy the newer revision.
    expect(isCurrentRevisionCommitted(s)).toBe(false);
  });

  it("goes stale-blind to a commit from another document session", () => {
    const s = committed(
      { ...mutate(workspaceOpen(), 6), documentSessionId: "session-b" },
      6,
      10,
    );
    expect(s.lastCommittedRevision).toBe(-1);
  });

  it("forgets a published version when a different document is opened", () => {
    const s = persistenceReducer(committed(mutate(workspaceOpen(), 6), 6, 10), {
      type: "DOCUMENT_OPENED",
      documentId: "doc-2",
      documentSessionId: "session-b",
      revision: 0,
      remoteEnabled: true,
      online: true,
      at: 4_000,
    });
    expect(s.lastCommittedRevision).toBe(-1);
    expect(s.committedServerVersion).toBeNull();
  });

  it("has no event by which exporting a file could reach the save state", () => {
    /*
     * The export invariant, asserted where it can actually be enforced. Exporting
     * writes a PDF to the user's downloads and proves nothing about either
     * durability channel — the editor state is unchanged and the workspace has not
     * been told. An `EXPORT_*` event here would inevitably be reduced into a
     * watermark, and "Saved" over an exported-but-unsaved document is the exact
     * false claim this module exists to prevent.
     */
    for (const type of PERSISTENCE_EVENT_TYPES) {
      expect(type).not.toMatch(/EXPORT/i);
      expect(type).not.toMatch(/DOWNLOAD/i);
    }
  });
});
