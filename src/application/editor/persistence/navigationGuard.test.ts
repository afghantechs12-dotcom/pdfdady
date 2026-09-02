import { describe, expect, it } from "vitest";
import { NAVIGATION_ACTION_LABELS, evaluateNavigation, shouldArmBeforeUnload } from "./navigationGuard";
import { INITIAL_PERSISTENCE_STATE, persistenceReducer, type PersistenceState } from "./persistenceMachine";
import { persistenceFailure, type PersistenceEvent } from "./events";

/**
 * What leaving costs, and what to offer instead.
 *
 * The claim under test is that protection is keyed on DURABILITY and not on
 * dirtiness — which is the same claim `dirty = canUndo` in the editor gets wrong
 * in both directions at once. Blocking on undo history nags a user whose work is
 * already in IndexedDB (so they learn the dialog is noise) and stays silent
 * during the one window that matters: the seconds between a mutation and the
 * write that captures it.
 *
 * The other thing asserted here is that every offered action can actually be
 * carried out. "Save locally and leave" over a browser that will not open
 * IndexedDB is worse than no offer at all — the user clicks it, the dialog
 * closes, and they believe something happened.
 */

const DOC = "doc-1";
const SESSION = "session-a";

function open(overrides: Partial<Extract<PersistenceEvent, { type: "DOCUMENT_OPENED" }>> = {}): PersistenceState {
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

function edit(state: PersistenceState, revision: number): PersistenceState {
  return persistenceReducer(state, {
    type: "DOCUMENT_MUTATED",
    documentId: DOC,
    documentSessionId: SESSION,
    revision,
    at: 2_000,
  });
}

function startLocal(state: PersistenceState, revision: number, requestId = "req-l"): PersistenceState {
  const scheduled = persistenceReducer(state, {
    type: "LOCAL_WRITE_SCHEDULED",
    documentId: DOC,
    documentSessionId: SESSION,
    requestId,
    revision,
    at: 2_100,
  });
  return persistenceReducer(scheduled, {
    type: "LOCAL_WRITE_STARTED",
    documentId: DOC,
    documentSessionId: SESSION,
    requestId,
    revision,
    at: 2_200,
  });
}

function localDone(state: PersistenceState, revision: number, requestId = "req-l"): PersistenceState {
  return persistenceReducer(state, {
    type: "LOCAL_WRITE_SUCCEEDED",
    documentId: DOC,
    documentSessionId: SESSION,
    requestId,
    revision,
    at: 2_300,
    draftId: "draft-1",
  });
}

function localFailed(
  state: PersistenceState,
  revision: number,
  category: Parameters<typeof persistenceFailure>[0],
  requestId = "req-l",
): PersistenceState {
  return persistenceReducer(state, {
    type: "LOCAL_WRITE_FAILED",
    documentId: DOC,
    documentSessionId: SESSION,
    requestId,
    revision,
    at: 2_300,
    failure: persistenceFailure(category, "failed"),
  });
}

function remoteDone(state: PersistenceState, revision: number): PersistenceState {
  let next = persistenceReducer(state, {
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
    serverVersion: 5,
    etag: "etag-5",
  });
}

describe("durability, not dirtiness", () => {
  it("allows leaving a document that was never opened", () => {
    expect(evaluateNavigation(INITIAL_PERSISTENCE_STATE).decision).toBe("allow");
  });

  it("allows leaving an untouched document", () => {
    expect(evaluateNavigation(open({ revision: 7 })).decision).toBe("allow");
  });

  it("allows leaving after the newest revision is stored locally", () => {
    /*
     * The case an undo-history guard gets wrong: there IS undo history, the
     * document HAS been edited, and leaving costs nothing.
     */
    const state = localDone(startLocal(edit(open(), 1), 1), 1);
    const verdict = evaluateNavigation(state);
    expect(verdict.decision).toBe("allow");
    expect(verdict.armBeforeUnload).toBe(false);
  });

  it("blocks in the window between a mutation and its write", () => {
    // The case an undo-history guard also gets wrong, by being silent.
    const verdict = evaluateNavigation(edit(open(), 1));
    expect(verdict.decision).toBe("block");
    expect(verdict.armBeforeUnload).toBe(true);
  });

  it("still blocks while the write is in flight", () => {
    const verdict = evaluateNavigation(startLocal(edit(open(), 1), 1));
    expect(verdict.decision).toBe("block");
    expect(verdict.actions[0]).toBe("wait_for_save");
    expect(verdict.reason).toMatch(/still being stored/i);
  });

  it("blocks again once a newer edit outruns the last durable revision", () => {
    let state = localDone(startLocal(edit(open(), 1), 1), 1);
    expect(evaluateNavigation(state).decision).toBe("allow");
    state = edit(state, 2);
    expect(evaluateNavigation(state).decision).toBe("block");
  });
});

describe("a local copy is not a workspace copy", () => {
  it("warns rather than blocking when only the workspace is behind", () => {
    const state = localDone(startLocal(edit(open({ remoteEnabled: true, serverVersion: 4 }), 1), 1), 1);
    const verdict = evaluateNavigation(state);
    expect(verdict.decision).toBe("warn");
    expect(verdict.actions).toContain("retry_cloud_save");
    // The work survives, so the native dialog is not warranted.
    expect(verdict.armBeforeUnload).toBe(false);
    expect(verdict.reason).toMatch(/workspace/i);
  });

  it("allows leaving once the workspace has acknowledged the revision", () => {
    const state = remoteDone(edit(open({ remoteEnabled: true, serverVersion: 4 }), 1), 1);
    expect(evaluateNavigation(state).decision).toBe("allow");
  });

  it("offers a cloud retry inside a block when the workspace save failed", () => {
    let state = edit(open({ remoteEnabled: true, serverVersion: 4 }), 1);
    state = persistenceReducer(state, {
      type: "REMOTE_SAVE_SCHEDULED",
      documentId: DOC,
      documentSessionId: SESSION,
      requestId: "req-r",
      revision: 1,
      at: 2_100,
    });
    state = persistenceReducer(state, {
      type: "REMOTE_SAVE_STARTED",
      documentId: DOC,
      documentSessionId: SESSION,
      requestId: "req-r",
      revision: 1,
      at: 2_200,
    });
    state = persistenceReducer(state, {
      type: "REMOTE_SAVE_FAILED",
      documentId: DOC,
      documentSessionId: SESSION,
      requestId: "req-r",
      revision: 1,
      at: 2_300,
      failure: persistenceFailure("network", "offline"),
    });
    const verdict = evaluateNavigation(state);
    expect(verdict.decision).toBe("block");
    expect(verdict.actions).toContain("retry_cloud_save");
  });
});

describe("a browser that cannot store anything", () => {
  /** Guest document, real edits, IndexedDB refuses to open. */
  function noStore(): PersistenceState {
    return localFailed(startLocal(edit(open(), 1), 1), 1, "storage_unavailable");
  }

  it("blocks, because closing the tab really does end the document", () => {
    const verdict = evaluateNavigation(noStore());
    expect(verdict.decision).toBe("block");
    expect(verdict.armBeforeUnload).toBe(true);
  });

  it("says that this browser will not store a copy, not merely that a save is pending", () => {
    /*
     * The reason text is the whole value of this branch. "Your changes are not
     * stored anywhere yet" invites the user to wait; nothing is coming. They need
     * to know the only way out is to export.
     */
    const verdict = evaluateNavigation(noStore());
    expect(verdict.reason).toMatch(/will not store|cannot store/i);
  });

  it("does not offer to save locally, which cannot work", () => {
    const verdict = evaluateNavigation(noStore());
    expect(verdict.actions).not.toContain("save_locally_and_leave");
    expect(verdict.actions).not.toContain("wait_for_save");
  });

  it("does not offer a cloud retry for a document with no workspace", () => {
    const verdict = evaluateNavigation(noStore());
    expect(verdict.actions).not.toContain("retry_cloud_save");
    expect(verdict.actions).toEqual(["leave_and_discard", "cancel"]);
  });

  it("offers the workspace as the way out when there is one", () => {
    const state = localFailed(
      startLocal(edit(open({ remoteEnabled: true, serverVersion: 4 }), 1), 1),
      1,
      "storage_unavailable",
    );
    const verdict = evaluateNavigation(state);
    expect(verdict.decision).toBe("block");
    expect(verdict.actions).toContain("retry_cloud_save");
  });

  it("allows leaving when the workspace holds the revision despite no local store", () => {
    let state = edit(open({ remoteEnabled: true, serverVersion: 4 }), 1);
    state = localFailed(startLocal(state, 1), 1, "storage_unavailable");
    state = remoteDone(state, 1);
    expect(evaluateNavigation(state).decision).toBe("allow");
  });

  it("allows leaving an untouched document even with no local store", () => {
    // Nothing of the user's has been created, so there is nothing to protect.
    const state = persistenceReducer(open({ revision: 7 }), {
      type: "LOCAL_STORAGE_UNAVAILABLE",
      at: 1_100,
      failure: persistenceFailure("storage_unavailable", "no store"),
    });
    expect(evaluateNavigation(state).decision).toBe("allow");
  });
});

describe("the offered actions", () => {
  it("never puts the destructive action first, and always offers cancel last", () => {
    const verdict = evaluateNavigation(edit(open(), 1));
    expect(verdict.actions[0]).not.toBe("leave_and_discard");
    expect(verdict.actions.at(-1)).toBe("cancel");
    expect(verdict.actions.indexOf("leave_and_discard")).toBe(verdict.actions.length - 2);
  });

  it("labels every action it can offer", () => {
    const states: PersistenceState[] = [
      edit(open(), 1),
      startLocal(edit(open(), 1), 1),
      localFailed(startLocal(edit(open(), 1), 1), 1, "storage_unavailable"),
      localDone(startLocal(edit(open({ remoteEnabled: true, serverVersion: 4 }), 1), 1), 1),
    ];
    for (const state of states) {
      for (const action of evaluateNavigation(state).actions) {
        expect(NAVIGATION_ACTION_LABELS[action]).toBeTruthy();
      }
    }
  });

  it("offers no actions when leaving is safe", () => {
    expect(evaluateNavigation(open()).actions).toEqual([]);
  });
});

describe("beforeunload is the last resort, not the mechanism", () => {
  it("is armed only when the work would actually be destroyed", () => {
    expect(shouldArmBeforeUnload(open())).toBe(false);
    expect(shouldArmBeforeUnload(edit(open(), 1))).toBe(true);
    expect(shouldArmBeforeUnload(localDone(startLocal(edit(open(), 1), 1), 1))).toBe(false);
  });

  it("is not armed for a workspace document that is merely behind", () => {
    /*
     * The native dialog cannot be worded, so spending it on "your colleague has
     * not seen this yet" trains the user to dismiss it — and then it is gone when
     * the work really is at risk.
     */
    const state = localDone(startLocal(edit(open({ remoteEnabled: true, serverVersion: 4 }), 1), 1), 1);
    expect(shouldArmBeforeUnload(state)).toBe(false);
  });
});
