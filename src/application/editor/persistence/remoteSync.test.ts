import { describe, expect, it } from "vitest";
import { isFullySynced, planReconnect, type ReconnectAction } from "./remoteSync";
import { INITIAL_PERSISTENCE_STATE, persistenceReducer, type PersistenceState } from "./persistenceMachine";
import { persistenceFailure, type PersistenceEvent } from "./events";

/**
 * Coming back from an outage, which is the moment a client is most confidently
 * wrong about the world.
 *
 * The tempting shortcut is to treat the server's version number as a token to be
 * refreshed: read the current version, store it, carry on saving. That is
 * catastrophic precisely because it succeeds — the next save presents a version
 * the client never actually read the content of, the server's optimistic check
 * passes, and a colleague's committed version is overwritten by a canvas that
 * predates it. No conflict is raised, because the client asserted it was up to
 * date.
 *
 * A version token may therefore only be adopted with the bytes it describes. Any
 * other case is either a reload (the canvas holds nothing of the user's, so
 * replacing it costs nothing) or a decision the user has to make.
 */

const DOC = "doc-1";
const SESSION = "session-a";

function open(overrides: Partial<Extract<PersistenceEvent, { type: "DOCUMENT_OPENED" }>> = {}): PersistenceState {
  return persistenceReducer(INITIAL_PERSISTENCE_STATE, {
    type: "DOCUMENT_OPENED",
    documentId: DOC,
    documentSessionId: SESSION,
    revision: 0,
    remoteEnabled: true,
    online: true,
    serverVersion: 4,
    etag: "etag-4",
    at: 1_000,
    ...overrides,
  });
}

function edit(state: PersistenceState, revision: number): PersistenceState {
  return persistenceReducer(state, {
    type: "DOCUMENT_MUTATED",
    documentId: DOC,
    documentSessionId: SESSION,
    revision,
    at: 2_000,
  });
}

/** Edits, then gets the server to acknowledge them at its current version. */
function editAndSync(state: PersistenceState, revision: number): PersistenceState {
  let next = edit(state, revision);
  next = persistenceReducer(next, {
    type: "REMOTE_SAVE_SCHEDULED",
    documentId: DOC,
    documentSessionId: SESSION,
    requestId: "req-r",
    revision,
    at: 2_100,
  });
  next = persistenceReducer(next, {
    type: "REMOTE_SAVE_STARTED",
    documentId: DOC,
    documentSessionId: SESSION,
    requestId: "req-r",
    revision,
    at: 2_200,
  });
  return persistenceReducer(next, {
    type: "REMOTE_SAVE_SUCCEEDED",
    documentId: DOC,
    documentSessionId: SESSION,
    requestId: "req-r",
    revision,
    at: 2_300,
    serverVersion: state.serverVersion ?? 4,
    etag: state.etag,
  });
}

function plan(state: PersistenceState, serverVersion: number | null, etag: string | null): ReconnectAction {
  return planReconnect({ state, serverVersion, etag, now: 9_000 });
}

describe("nothing has changed on either side", () => {
  it("does nothing for an untouched document on the same version", () => {
    expect(plan(open(), 4, "etag-4")).toEqual({ action: "nothing_to_sync" });
  });

  it("sends the queued revision when the server has not moved", () => {
    const state = edit(open(), 5);
    expect(plan(state, 4, "etag-4")).toEqual({
      action: "sync",
      revision: 5,
      expectedServerVersion: 4,
    });
  });

  it("does not apply to a guest document", () => {
    const state = edit(open({ remoteEnabled: false, serverVersion: undefined }), 5);
    expect(plan(state, 9, null).action).toBe("not_applicable");
  });

  it("treats an unreadable server version as unknown rather than as divergence", () => {
    /*
     * A read that came back without a version proves nothing. Reporting a conflict
     * here would make every reconnect on a flaky link demand a decision the user
     * has no way to make correctly.
     */
    const state = edit(open(), 5);
    expect(plan(state, null, null).action).toBe("sync");
  });
});

describe("defect H — a version token is never adopted apart from its bytes", () => {
  it("does not adopt a newer server version while keeping the older canvas", () => {
    /*
     * The scenario. The tab was offline; a collaborator committed a new document
     * version; this tab's canvas is still the version it opened. Adopting 6 would
     * make the next save assert "I edited version 6", and the server would accept
     * it — silently replacing the collaborator's version with content that never
     * contained their work.
     */
    const state = open({ revision: 0, serverVersion: 4, etag: "etag-4" });
    const action = plan(state, 6, "etag-6");
    expect(action.action).not.toBe("adopt_server_version");
    expect(action.action).not.toBe("sync");
    expect(action.action).toBe("reload_from_server");
    if (action.action === "reload_from_server") {
      expect(action.serverVersion).toBe(6);
    }
  });

  it("reloads rather than prompting when the canvas holds nothing of the user's", () => {
    // Untouched: the reload costs the user nothing, so it needs no decision.
    const action = plan(open({ revision: 3 }), 6, "etag-6");
    expect(action.action).toBe("reload_from_server");
  });

  it("adopts the new version when the server proves the bytes are unchanged", () => {
    /*
     * The one safe adoption. A matching validator means the version number moved
     * without the content moving — a rename, a metadata touch, a re-save of
     * identical bytes. The canvas is already that content.
     */
    const state = open({ revision: 3, serverVersion: 4, etag: "etag-shared" });
    const action = plan(state, 6, "etag-shared");
    expect(action).toEqual({
      action: "adopt_server_version",
      serverVersion: 6,
      etag: "etag-shared",
    });
  });

  it("will not adopt on a matching validator it invented", () => {
    // Both unknown is not equality. `null === null` must not read as proof.
    const state = open({ revision: 3, serverVersion: 4, etag: undefined });
    const action = plan(state, 6, null);
    expect(action.action).not.toBe("adopt_server_version");
  });

  it("asks the user when the canvas has their edits and the server has moved", () => {
    const state = edit(open(), 5);
    const action = plan(state, 6, "etag-6");
    expect(action.action).toBe("conflict");
    if (action.action === "conflict") {
      expect(action.conflict.localRevision).toBe(5);
      expect(action.conflict.expectedServerVersion).toBe(4);
      expect(action.conflict.actualServerVersion).toBe(6);
    }
  });

  it("still asks when the user's edits were already backed up as a draft", () => {
    /*
     * The subtle one. Every local edit reached the server as an autosave draft, so
     * `isCurrentRevisionRemotelyAcknowledged` is true and nothing is "unsynced" —
     * but the DOCUMENT version moved underneath those drafts. A reload would throw
     * away edits the user can see; an adoption would let them overwrite a version
     * they never saw. Neither may happen without asking.
     */
    const state = editAndSync(open(), 5);
    expect(state.lastRemoteAcknowledgedRevision).toBe(5);
    const action = plan(state, 6, "etag-6");
    expect(action.action).toBe("conflict");
  });

  it("asks when a recovered draft is on screen and the server has moved", () => {
    let state = open({ revision: 0 });
    state = persistenceReducer(state, {
      type: "RECOVERY_SUCCEEDED",
      documentId: DOC,
      documentSessionId: SESSION,
      draftId: "draft-9",
      revision: 80,
      locallyDurable: true,
      at: 3_000,
    });
    const action = plan(state, 6, "etag-6");
    // A recovered draft is the user's work by definition. Never silently replaced.
    expect(action.action).toBe("conflict");
  });

  it("describes an offline divergence in terms of what happened", () => {
    const action = plan(edit(open(), 5), 6, "etag-6");
    if (action.action !== "conflict") throw new Error("expected a conflict");
    expect(action.conflict.detail).toMatch(/offline/i);
    expect(action.conflict.detectedAt).toBe(9_000);
  });
});

/**
 * T12 — the session's own publish, seen from the other consumer of the token.
 *
 * `planReconnect` compares a fresh head read against `state.serverVersion`, so it
 * asks the same question the server's compare-and-swap does: has the document moved
 * since we last knew where it was? A publish moves it, and the publishing tab is
 * told the new value. If it stored the version NUMBER instead — the number it shows
 * the user — the very next head read would look like somebody else's write, and this
 * planner would demand a decision about a conflict the tab caused itself.
 */
describe("a publish this tab made is not a divergence (T12)", () => {
  /** The publish: a version number for the user, a revision for the fence. */
  function published(
    state: PersistenceState,
    revision: number,
    serverVersion: number,
    documentRevision: number,
  ): PersistenceState {
    return persistenceReducer(state, {
      type: "REMOTE_VERSION_COMMITTED",
      documentId: DOC,
      documentSessionId: SESSION,
      requestId: "commit-1",
      revision,
      serverVersion,
      documentRevision,
      etag: null,
      at: 2_500,
    });
  }

  it("plans nothing to sync after reading back the revision its own publish produced", () => {
    // Opened at revision 4, edited, published: the server now reports 12 — because
    // this tab put it there. Version 9 is what the user was shown.
    const state = published(edit(open(), 5), 5, 9, 12);
    expect(state.serverVersion).toBe(12);
    const action = plan(state, 12, null);
    expect(action.action).not.toBe("conflict");
    expect(action.action).not.toBe("reload_from_server");
    // The publish acknowledged revision 5, so there is nothing left to send.
    expect(action.action).toBe("nothing_to_sync");
  });

  it("still asks the user when the revision moved past its own publish", () => {
    /*
     * Anti-vacuity for the test above, and the constraint that made the fix
     * non-trivial: 13 is a write this tab did not make. Weakening the token — or
     * dropping it — would turn this case into a silent overwrite.
     */
    const state = edit(published(edit(open(), 5), 5, 9, 12), 6);
    const action = plan(state, 13, null);
    expect(action.action).toBe("conflict");
    if (action.action === "conflict") {
      expect(action.conflict.expectedServerVersion).toBe(12);
      expect(action.conflict.actualServerVersion).toBe(13);
    }
  });
});

describe("isFullySynced is the only permission to say Saved", () => {
  it("is false for a guest document, which has no remote to be synced with", () => {
    expect(isFullySynced(edit(open({ remoteEnabled: false }), 5))).toBe(false);
  });

  it("is false while a save is queued", () => {
    expect(isFullySynced(edit(open(), 5))).toBe(false);
  });

  it("is true once the current revision is acknowledged", () => {
    expect(isFullySynced(editAndSync(open(), 5))).toBe(true);
  });

  it("is false in conflict even though a request completed", () => {
    let state = edit(open(), 5);
    state = persistenceReducer(state, {
      type: "REMOTE_SAVE_SCHEDULED",
      documentId: DOC,
      documentSessionId: SESSION,
      requestId: "req-r",
      revision: 5,
      at: 2_100,
    });
    state = persistenceReducer(state, {
      type: "REMOTE_SAVE_STARTED",
      documentId: DOC,
      documentSessionId: SESSION,
      requestId: "req-r",
      revision: 5,
      at: 2_200,
    });
    state = persistenceReducer(state, {
      type: "CONFLICT_DETECTED",
      documentId: DOC,
      documentSessionId: SESSION,
      requestId: "req-r",
      revision: 5,
      at: 2_300,
      conflict: {
        localRevision: 5,
        expectedServerVersion: 4,
        actualServerVersion: 6,
        detail: null,
        detectedAt: 2_300,
      },
    });
    expect(isFullySynced(state)).toBe(false);
  });

  it("is false after a failure even if an older revision was acknowledged", () => {
    let state = editAndSync(open(), 5);
    state = edit(state, 6);
    state = persistenceReducer(state, {
      type: "REMOTE_SAVE_SCHEDULED",
      documentId: DOC,
      documentSessionId: SESSION,
      requestId: "req-2",
      revision: 6,
      at: 3_000,
    });
    state = persistenceReducer(state, {
      type: "REMOTE_SAVE_STARTED",
      documentId: DOC,
      documentSessionId: SESSION,
      requestId: "req-2",
      revision: 6,
      at: 3_100,
    });
    state = persistenceReducer(state, {
      type: "REMOTE_SAVE_FAILED",
      documentId: DOC,
      documentSessionId: SESSION,
      requestId: "req-2",
      revision: 6,
      at: 3_200,
      failure: persistenceFailure("network", "offline"),
    });
    expect(isFullySynced(state)).toBe(false);
  });
});
