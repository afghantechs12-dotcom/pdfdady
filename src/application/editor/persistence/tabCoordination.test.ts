/**
 * Two tabs, one document, one draft store.
 *
 * The failure this prevents is not exotic: a user opens the same PDF in two tabs,
 * edits in one, switches to the other and edits there. Both tabs autosave to the
 * same key. Without coordination the second write wins, the first tab's work is
 * gone, and both tabs are showing "Saved".
 *
 * Three identities are kept apart because they answer three different questions,
 * and collapsing any pair of them reintroduces a real bug:
 *
 *  - the DEVICE says which browser profile the draft store belongs to, and it must
 *    survive a refresh or every reload orphans the previous draft;
 *  - the TAB says which page load a write came from, and it must NOT survive a
 *    refresh or two tabs look like one and interleave freely;
 *  - the DOCUMENT SESSION says which opening of a document a request belongs to,
 *    and it must change even within one tab or a response issued before a close
 *    lands on the state after it.
 */

import { describe, expect, it } from "vitest";

import {
  NO_PEER_ACTIVITY,
  createDocumentSessionId,
  createTabId,
  draftLockName,
  observePeer,
  planCrossTabCommit,
  resolveDeviceId,
  unlockedDraftLock,
  type IdentityStorage,
  type PeerActivity,
  type PeerMessage,
} from "./tabCoordination";

/** A localStorage-shaped double, including the one that throws on write. */
function storage(initial: Record<string, string> = {}): IdentityStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    read: (key) => data[key] ?? null,
    write: (key, value) => {
      data[key] = value;
    },
  };
}

/** Ids long enough to pass the plausibility bound a stored value has to clear. */
function ids(prefix = "id"): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-000000-${n}`;
  };
}

const SELF = { deviceId: "device-1", tabId: "tab-1" };

function committed(overrides: Partial<Extract<PeerMessage, { kind: "draft_committed" }>> = {}): PeerMessage {
  return {
    kind: "draft_committed",
    documentKey: "guest:abc",
    draftId: "draft-1",
    generation: 4,
    revision: 12,
    deviceId: "device-1",
    tabId: "tab-2",
    at: 1_000,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */

describe("device identity", () => {
  it("is created once and reused on every later load", () => {
    const s = storage();
    const first = resolveDeviceId(s, ids("dev"));
    const second = resolveDeviceId(s, ids("other"));
    // A new id per mount would orphan the previous draft on every refresh, which
    // is the same as having no recovery at all.
    expect(first.deviceId).toBe("dev-000000-1");
    expect(second.deviceId).toBe("dev-000000-1");
    expect(second.created).toBe(false);
  });

  it("reports that it had to create one", () => {
    expect(resolveDeviceId(storage(), ids()).created).toBe(true);
  });

  it("rejects a stored value that is not a plausible id", () => {
    for (const junk of ["", "   ", "x".repeat(200)]) {
      const s = storage({ "pdfdadi.device-id": junk });
      const resolved = resolveDeviceId(s, ids("fresh"));
      expect(resolved.deviceId).toBe("fresh-000000-1");
      expect(resolved.created).toBe(true);
    }
  });

  it("still produces an id when there is nowhere to store one", () => {
    // Private browsing, blocked site data. The id becomes per-session, which loses
    // recovery across reloads — but an editor that cannot open is worse.
    const resolved = resolveDeviceId(null, ids("ephemeral"));
    expect(resolved.deviceId).toBe("ephemeral-000000-1");
    expect(resolved.persisted).toBe(false);
  });

  it("still produces an id when the write throws", () => {
    const throwing: IdentityStorage = {
      read: () => null,
      write: () => {
        throw new Error("quota");
      },
    };
    const resolved = resolveDeviceId(throwing, ids("ephemeral"));
    expect(resolved.deviceId).toBe("ephemeral-000000-1");
    expect(resolved.persisted).toBe(false);
  });

  it("still produces an id when the read throws", () => {
    const throwing: IdentityStorage = {
      read: () => {
        throw new Error("blocked");
      },
      write: () => {},
    };
    expect(resolveDeviceId(throwing, ids("e")).deviceId).toBe("e-000000-1");
  });
});

describe("tab and session identity", () => {
  it("gives every tab a different id", () => {
    const next = ids("tab");
    expect(createTabId(next)).not.toBe(createTabId(next));
  });

  it("gives every document opening a different id, in the same tab", () => {
    const next = ids("session");
    const first = createDocumentSessionId(next);
    const second = createDocumentSessionId(next);
    // Reopening the same document in the same tab is a new session, or a response
    // issued before the close lands on the state after it.
    expect(first).not.toBe(second);
  });

  it("does not make a session id out of the tab id", () => {
    const next = ids("x");
    expect(createDocumentSessionId(next)).not.toBe(SELF.tabId);
  });
});

describe("the lock name", () => {
  it("is per document, so two documents never block each other", () => {
    expect(draftLockName("guest:a")).not.toBe(draftLockName("guest:b"));
  });

  it("is stable for the same document across tabs", () => {
    expect(draftLockName("ws:w1:d1")).toBe(draftLockName("ws:w1:d1"));
  });

  it("does not let one document key's lock name prefix another's", () => {
    expect(draftLockName("guest:a")).not.toBe(draftLockName("guest:ab"));
  });
});

describe("the degraded lock", () => {
  it("reports that it is not really a lock", async () => {
    const lock = unlockedDraftLock();
    expect(lock.supported).toBe(false);
  });

  it("still runs the work, and says the work was not serialised", async () => {
    // The alternative — refusing to save at all when Web Locks is missing — would
    // turn a browser without one API into a browser with no autosave.
    const lock = unlockedDraftLock();
    const outcome = await lock.run("draft:guest:abc", async () => 42);
    expect(outcome).toEqual({ held: false, serialised: false, value: 42 });
  });

  it("lets a rejection through rather than swallowing it into a held result", async () => {
    const lock = unlockedDraftLock();
    await expect(
      lock.run("n", async () => {
        throw new Error("write failed");
      }),
    ).rejects.toThrow(/write failed/);
  });
});

describe("hearing from another tab", () => {
  it("starts out knowing nothing", () => {
    expect(NO_PEER_ACTIVITY).toEqual({
      generation: null,
      revision: null,
      tabId: null,
      at: null,
      departedTabIds: [],
    });
  });

  it("records a peer's committed generation and revision", () => {
    const activity = observePeer(NO_PEER_ACTIVITY, committed(), SELF, "guest:abc");
    expect(activity.generation).toBe(4);
    expect(activity.revision).toBe(12);
    expect(activity.tabId).toBe("tab-2");
    expect(activity.at).toBe(1_000);
  });

  it("ignores its own announcement", () => {
    // A BroadcastChannel does not echo to the sender, but a fallback transport
    // might, and a tab that treated its own commit as a peer's would immediately
    // declare a conflict with itself.
    const activity = observePeer(NO_PEER_ACTIVITY, committed({ tabId: "tab-1" }), SELF, "guest:abc");
    expect(activity).toBe(NO_PEER_ACTIVITY);
  });

  it("ignores an announcement about a different document", () => {
    const activity = observePeer(
      NO_PEER_ACTIVITY,
      committed({ documentKey: "guest:other" }),
      SELF,
      "guest:abc",
    );
    expect(activity).toBe(NO_PEER_ACTIVITY);
  });

  it("ignores an announcement from a different device", () => {
    const activity = observePeer(
      NO_PEER_ACTIVITY,
      committed({ deviceId: "device-2" }),
      SELF,
      "guest:abc",
    );
    expect(activity).toBe(NO_PEER_ACTIVITY);
  });

  it("ignores a message that arrived out of order", () => {
    const seen = observePeer(NO_PEER_ACTIVITY, committed({ generation: 5, at: 2_000 }), SELF, "guest:abc");
    const late = observePeer(seen, committed({ generation: 4, at: 1_000 }), SELF, "guest:abc");
    expect(late.generation).toBe(5);
  });

  it("ignores a message from a tab that already announced it was closing", () => {
    const departed = observePeer(
      NO_PEER_ACTIVITY,
      { kind: "tab_closing", documentKey: "guest:abc", deviceId: "device-1", tabId: "tab-2", at: 900 },
      SELF,
      "guest:abc",
    );
    expect(departed.departedTabIds).toEqual(["tab-2"]);

    // A write that was already in flight when the tab closed can still land and
    // still broadcast. Its result must not move this tab's view of the store.
    const late = observePeer(departed, committed({ at: 1_500 }), SELF, "guest:abc");
    expect(late.generation).toBeNull();
  });

  it("accepts a message from a different tab that never announced closing", () => {
    const departed = observePeer(
      NO_PEER_ACTIVITY,
      { kind: "tab_closing", documentKey: "guest:abc", deviceId: "device-1", tabId: "tab-9", at: 900 },
      SELF,
      "guest:abc",
    );
    const other = observePeer(departed, committed({ tabId: "tab-2" }), SELF, "guest:abc");
    expect(other.generation).toBe(4);
  });

  it("does not treat a closing announcement as a commit", () => {
    const activity = observePeer(
      NO_PEER_ACTIVITY,
      { kind: "tab_closing", documentKey: "guest:abc", deviceId: "device-1", tabId: "tab-2", at: 900 },
      SELF,
      "guest:abc",
    );
    expect(activity.revision).toBeNull();
  });
});

describe("deciding whether this tab may commit", () => {
  function activity(overrides: Partial<PeerActivity> = {}): PeerActivity {
    return { ...NO_PEER_ACTIVITY, ...overrides };
  }

  it("proceeds with no compare-and-swap value when nothing is known", () => {
    const plan = planCrossTabCommit({
      revision: 5,
      ownGeneration: null,
      peer: NO_PEER_ACTIVITY,
      lockHeld: true,
    });
    expect(plan).toEqual({ decision: "proceed", expectedActiveGeneration: undefined });
  });

  it("passes its own last generation as the compare-and-swap value under a lock", () => {
    const plan = planCrossTabCommit({
      revision: 5,
      ownGeneration: 3,
      peer: NO_PEER_ACTIVITY,
      lockHeld: true,
    });
    expect(plan).toEqual({ decision: "proceed", expectedActiveGeneration: 3 });
  });

  it("adopts a peer's newer generation as the compare-and-swap value", () => {
    // Two tabs, and this one has since made a newer edit. Overwriting the peer's
    // snapshot is correct — this revision supersedes it — but the write must be
    // guarded so a THIRD commit landing in between is still caught.
    const plan = planCrossTabCommit({
      revision: 20,
      ownGeneration: 3,
      peer: activity({ generation: 5, revision: 12, tabId: "tab-2", at: 1_000 }),
      lockHeld: true,
    });
    expect(plan).toEqual({ decision: "proceed", expectedActiveGeneration: 5 });
  });

  it("refuses to overwrite a peer snapshot that is ahead of this tab", () => {
    const plan = planCrossTabCommit({
      revision: 8,
      ownGeneration: 3,
      peer: activity({ generation: 5, revision: 12, tabId: "tab-2", at: 1_000 }),
      lockHeld: true,
    });
    // Last-writer-wins would silently discard four revisions of the other tab's
    // work, and both tabs would go on reading "Saved".
    expect(plan.decision).toBe("conflict");
    expect(plan).toMatchObject({ peerRevision: 12, peerTabId: "tab-2" });
  });

  it("treats an equal revision as nothing to write rather than a conflict", () => {
    // Both tabs at revision 12 means the peer already stored this exact revision;
    // there is no work to lose in either direction.
    const plan = planCrossTabCommit({
      revision: 12,
      ownGeneration: 3,
      peer: activity({ generation: 5, revision: 12, tabId: "tab-2", at: 1_000 }),
      lockHeld: true,
    });
    expect(plan.decision).toBe("already_durable");
  });

  it("always sends a compare-and-swap value when no lock is held", () => {
    // Without a lock the check is the ONLY thing standing between two tabs and a
    // silent overwrite, so it is never omitted — not even on a first commit, where
    // `null` asserts "there was no draft when I looked".
    const plan = planCrossTabCommit({
      revision: 5,
      ownGeneration: null,
      peer: NO_PEER_ACTIVITY,
      lockHeld: false,
    });
    expect(plan).toEqual({ decision: "proceed", expectedActiveGeneration: null });
  });

  it("still refuses to overwrite a newer peer snapshot when no lock is held", () => {
    const plan = planCrossTabCommit({
      revision: 8,
      ownGeneration: null,
      peer: activity({ generation: 2, revision: 30, tabId: "tab-2", at: 1_000 }),
      lockHeld: false,
    });
    expect(plan.decision).toBe("conflict");
  });

  it("does not let a departed tab's announcement block this tab forever", () => {
    // The peer is gone; its revision is still the newest thing in the store, so
    // this is still a conflict rather than a free overwrite — but `observePeer`
    // never recorded the announcement in the first place, so the state a plan sees
    // is the state before it.
    const departed = observePeer(
      NO_PEER_ACTIVITY,
      { kind: "tab_closing", documentKey: "guest:abc", deviceId: "device-1", tabId: "tab-2", at: 900 },
      SELF,
      "guest:abc",
    );
    const after = observePeer(departed, committed({ revision: 99, at: 1_000 }), SELF, "guest:abc");
    const plan = planCrossTabCommit({
      revision: 8,
      ownGeneration: 3,
      peer: after,
      lockHeld: true,
    });
    expect(plan.decision).toBe("proceed");
  });
});
