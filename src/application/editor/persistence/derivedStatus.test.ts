import { describe, expect, it } from "vitest";
import {
  SAVE_STATUS_LABELS,
  deriveRecoveryNotice,
  deriveSaveStatus,
  deriveStatusBreakdown,
  formatSavedAgo,
} from "./derivedStatus";
import { INITIAL_PERSISTENCE_STATE, type PersistenceState } from "./persistenceMachine";
import { persistenceFailure } from "./events";

/**
 * What the user is TOLD, which is a separate question from what is true.
 *
 * Two failure modes are guarded here. The first is a status that overstates
 * safety — "Saved on this device" over a document this browser never stored. The
 * second is a status that hides provenance: recovery is not a save state, it is a
 * fact about where the bytes on screen came from, and it has to survive being
 * displaced by whatever the save status happens to be saying.
 */

function state(overrides: Partial<PersistenceState> = {}): PersistenceState {
  return {
    ...INITIAL_PERSISTENCE_STATE,
    documentId: "doc-1",
    documentSessionId: "session-a",
    documentKey: "guest:abc",
    ...overrides,
  };
}

/** A guest document with real, locally stored edits. */
function guestSaved(overrides: Partial<PersistenceState> = {}): PersistenceState {
  return state({
    currentRevision: 5,
    baselineRevision: 0,
    lastLocallyDurableRevision: 5,
    local: "durable",
    edit: "clean",
    ...overrides,
  });
}

describe("no false claim of a local copy", () => {
  it("does not say 'Saved on this device' for a document that was only opened", () => {
    const view = deriveSaveStatus(state({ currentRevision: 0, baselineRevision: 0 }));
    expect(view.kind).toBe("unchanged");
    expect(view.label).not.toContain("Saved");
    expect(view.detail.toLowerCase()).not.toContain("stored in this browser");
  });

  it("says nothing needs saving, which is the honest version of 'safe'", () => {
    const view = deriveSaveStatus(state({ currentRevision: 7, baselineRevision: 7 }));
    expect(view.kind).toBe("unchanged");
    expect(view.tone).toBe("neutral");
    expect(view.retry).toBeNull();
    expect(view.needsResolution).toBe(false);
  });

  it("does say it once a draft has actually been written", () => {
    const view = deriveSaveStatus(guestSaved());
    expect(view.kind).toBe("saved_local");
    expect(view.label).toBe("Saved on this device");
  });

  it("reports an untouched workspace document as saved, because the server holds it", () => {
    const view = deriveSaveStatus(
      state({
        remoteEnabled: true,
        remote: "idle",
        currentRevision: 4,
        baselineRevision: 4,
        lastRemoteAcknowledgedRevision: 4,
        serverVersion: 9,
      }),
    );
    expect(view.kind).toBe("saved");
  });
});

describe("independence of the two channels", () => {
  it("keeps local durability visible when the cloud save failed", () => {
    const view = deriveSaveStatus(
      state({
        remoteEnabled: true,
        remote: "failed",
        local: "durable",
        edit: "dirty",
        currentRevision: 41,
        lastLocallyDurableRevision: 41,
        remoteChannel: {
          ...INITIAL_PERSISTENCE_STATE.remoteChannel,
          failureReason: persistenceFailure("network", "No connection to the workspace."),
        },
      }),
    );
    expect(view.kind).toBe("remote_failed");
    expect(view.label).toContain("safe on this device");
    expect(view.retry).toBe("remote");
  });

  it("says the work is safe in the workspace when only the local write failed", () => {
    const view = deriveSaveStatus(
      state({
        remoteEnabled: true,
        remote: "synced",
        local: "failed",
        edit: "clean",
        currentRevision: 41,
        lastRemoteAcknowledgedRevision: 41,
        localChannel: {
          ...INITIAL_PERSISTENCE_STATE.localChannel,
          failureReason: persistenceFailure("quota_exceeded", "out of space"),
        },
      }),
    );
    expect(view.kind).toBe("local_failed");
    expect(view.detail).toContain("saved in your workspace");
    expect(view.needsResolution).toBe(false);
    // Quota is not retryable, so no button that cannot work.
    expect(view.retry).toBeNull();
  });

  it("asks the user to act when neither channel holds the work", () => {
    const view = deriveSaveStatus(
      state({
        local: "unavailable",
        edit: "dirty",
        currentRevision: 3,
        baselineRevision: 0,
      }),
    );
    expect(view.kind).toBe("no_local_storage");
    expect(view.needsResolution).toBe(true);
    expect(view.retry).toBeNull();
    expect(view.detail).toContain("before closing");
  });
});

describe("saving states", () => {
  it("does not present a stale in-flight save as nearly done", () => {
    const view = deriveSaveStatus(
      state({
        remoteEnabled: true,
        remote: "saving",
        edit: "dirty",
        currentRevision: 11,
        remoteChannel: { ...INITIAL_PERSISTENCE_STATE.remoteChannel, activeRevision: 10 },
      }),
    );
    expect(view.kind).toBe("saving_remote");
    expect(view.label).toContain("new changes pending");
  });

  it("never announces a status that changes on every keystroke", () => {
    const unsaved = deriveSaveStatus(
      state({ edit: "dirty", currentRevision: 9, baselineRevision: 0, local: "idle" }),
    );
    expect(unsaved.kind).toBe("unsaved");
    expect(unsaved.announce).toBe(false);
    const savingLocal = deriveSaveStatus(state({ local: "writing", edit: "dirty", currentRevision: 9 }));
    expect(savingLocal.announce).toBe(false);
  });
});

describe("defect D — recovery provenance is not a save state", () => {
  const recovered = state({
    remoteEnabled: true,
    recovery: "recovered",
    recoveredRevision: 80,
    recoveredAt: 5_000,
    currentRevision: 80,
    lastLocallyDurableRevision: 80,
    local: "durable",
    edit: "dirty",
  });

  it("shows the notice while the workspace sync is still pending", () => {
    // The save status here is `saved_local`: locally durable, cloud behind. That is
    // correct, and it is also exactly what would displace a recovery notice that
    // lived inside the same enum.
    expect(deriveSaveStatus(recovered).kind).toBe("saved_local");

    const notice = deriveRecoveryNotice(recovered);
    expect(notice).not.toBeNull();
    expect(notice?.label).toBe("Recovered draft — review changes");
  });

  it("shows the notice while the workspace sync is failing", () => {
    const notice = deriveRecoveryNotice({
      ...recovered,
      remote: "failed",
      remoteChannel: {
        ...INITIAL_PERSISTENCE_STATE.remoteChannel,
        failureReason: persistenceFailure("network", "offline"),
      },
    });
    expect(notice).not.toBeNull();
  });

  it("shows the notice while a conflict is unresolved", () => {
    const notice = deriveRecoveryNotice({ ...recovered, remote: "conflict" });
    expect(notice).not.toBeNull();
  });

  it("is persistent, not a toast", () => {
    const notice = deriveRecoveryNotice(recovered);
    expect(notice?.persistent).toBe(true);
    expect(notice?.dismissible).toBe(true);
  });

  it("never implies the workspace version was updated", () => {
    const notice = deriveRecoveryNotice(recovered);
    expect(notice?.detail).not.toMatch(/saved to your workspace|workspace (?:was |is )updated/i);
    expect(notice?.detail).toMatch(/draft on this device/i);
  });

  it("names the revision it restored", () => {
    expect(deriveRecoveryNotice(recovered)?.detail).toContain("80");
  });

  it("disappears only once acknowledged", () => {
    expect(deriveRecoveryNotice({ ...recovered, recoveryAcknowledged: true })).toBeNull();
  });

  it("keeps provenance in the breakdown even after acknowledgement", () => {
    const breakdown = deriveStatusBreakdown({ ...recovered, recoveryAcknowledged: true });
    expect(breakdown.recovery).toContain("80");
  });

  it("reports a failed recovery as a notice too", () => {
    const notice = deriveRecoveryNotice(
      state({
        recovery: "recovery_failed",
        recoveryFailure: persistenceFailure("corrupt_snapshot", "unreadable"),
      }),
    );
    expect(notice?.kind).toBe("recovery_failed");
    expect(notice?.dismissible).toBe(true);
  });

  it("offers a discovered draft as a decision, not a statement", () => {
    const notice = deriveRecoveryNotice(
      state({
        recovery: "draft_available",
        draft: {
          draftId: "d1",
          documentKey: "guest:abc",
          documentId: null,
          documentName: "Report.pdf",
          revision: 42,
          updatedAt: 1_000,
          schemaVersion: 1,
          fellBackToPreviousSnapshot: false,
          missingAssets: [],
          migratedFrom: null,
          serverVersion: null,
          lastRemoteAcknowledgedRevision: null,
        },
      }),
    );
    expect(notice?.kind).toBe("draft_available");
    expect(notice?.needsDecision).toBe(true);
  });

  it("returns nothing when there is no recovery history at all", () => {
    expect(deriveRecoveryNotice(guestSaved())).toBeNull();
  });

  it("warns when the restored draft was missing assets", () => {
    const notice = deriveRecoveryNotice({
      ...recovered,
      recoveredMissingAssets: ["source-pdf"],
    });
    expect(notice?.kind).toBe("recovered_partial");
    expect(notice?.detail).toMatch(/original pages|source/i);
  });
});

describe("breakdown", () => {
  it("states each dimension on its own terms", () => {
    const breakdown = deriveStatusBreakdown(
      state({
        remoteEnabled: true,
        remote: "failed",
        local: "durable",
        currentRevision: 41,
        lastLocallyDurableRevision: 41,
        lastRemoteAcknowledgedRevision: 38,
        lastLocalSaveAt: 1_700,
        remoteChannel: {
          ...INITIAL_PERSISTENCE_STATE.remoteChannel,
          failureReason: persistenceFailure("network", "No connection."),
        },
      }),
    );
    expect(breakdown.local).toContain("41");
    expect(breakdown.remote).toContain("38");
    expect(breakdown.lastLocalSaveAt).toBe(1_700);
  });

  it("says 'none' rather than '-1' when nothing was ever stored", () => {
    const breakdown = deriveStatusBreakdown(state({ currentRevision: 2, baselineRevision: 0 }));
    expect(breakdown.local).toContain("none");
    expect(breakdown.local).not.toContain("-1");
  });
});

describe("timestamps", () => {
  it("stays coarse", () => {
    expect(formatSavedAgo(1_000, 1_000)).toBe("just now");
    expect(formatSavedAgo(0, 30_000)).toBe("30 seconds ago");
    expect(formatSavedAgo(0, 120_000)).toBe("2 minutes ago");
    expect(formatSavedAgo(null, 1)).toBeNull();
  });

  it("never reports a negative age from a clock that moved backwards", () => {
    expect(formatSavedAgo(5_000, 1_000)).toBe("just now");
  });
});

describe("stable layout", () => {
  it("lists every label a status can produce, so the width can be reserved", () => {
    const produced = new Set<string>();
    const cases: Partial<PersistenceState>[] = [
      { documentId: null, recovery: "none" },
      { currentRevision: 0, baselineRevision: 0 },
      { edit: "dirty", currentRevision: 3, baselineRevision: 0 },
      { local: "writing", edit: "dirty", currentRevision: 3 },
      guestSaved(),
      { remoteEnabled: true, remote: "saving", edit: "dirty", currentRevision: 3 },
      {
        remoteEnabled: true,
        remote: "saving",
        edit: "dirty",
        currentRevision: 11,
        remoteChannel: { ...INITIAL_PERSISTENCE_STATE.remoteChannel, activeRevision: 10 },
      },
      { remoteEnabled: true, remote: "synced", currentRevision: 3, lastRemoteAcknowledgedRevision: 3 },
      {
        remoteEnabled: true,
        online: false,
        edit: "dirty",
        currentRevision: 3,
        lastLocallyDurableRevision: 3,
      },
      { remoteEnabled: true, online: false, edit: "dirty", currentRevision: 3 },
      {
        remoteEnabled: true,
        remote: "failed",
        edit: "dirty",
        currentRevision: 3,
        lastLocallyDurableRevision: 3,
      },
      { remoteEnabled: true, remote: "failed", edit: "dirty", currentRevision: 3 },
      {
        remoteEnabled: true,
        remote: "failed",
        edit: "clean",
        currentRevision: 3,
        lastLocallyDurableRevision: 3,
        remoteChannel: {
          ...INITIAL_PERSISTENCE_STATE.remoteChannel,
          failureReason: persistenceFailure("payload_too_large", "too large"),
        },
      },
      {
        remoteEnabled: true,
        remote: "failed",
        edit: "dirty",
        currentRevision: 3,
        remoteChannel: {
          ...INITIAL_PERSISTENCE_STATE.remoteChannel,
          failureReason: persistenceFailure("payload_too_large", "too large"),
        },
      },
      { local: "failed", edit: "dirty", currentRevision: 3 },
      {
        local: "failed",
        remoteEnabled: true,
        edit: "clean",
        currentRevision: 3,
        lastRemoteAcknowledgedRevision: 3,
      },
      { local: "unavailable", edit: "dirty", currentRevision: 3 },
      {
        local: "unavailable",
        remoteEnabled: true,
        edit: "dirty",
        currentRevision: 3,
        lastRemoteAcknowledgedRevision: 2,
      },
      { remoteEnabled: true, remote: "conflict", edit: "dirty", currentRevision: 3 },
      { recovery: "recovery_failed" },
      {
        recovery: "recovered",
        recoveredRevision: 8,
        currentRevision: 8,
        lastLocallyDurableRevision: 8,
        edit: "clean",
      },
    ];
    for (const override of cases) produced.add(deriveSaveStatus(state(override)).label);
    for (const label of produced) expect(SAVE_STATUS_LABELS).toContain(label);
  });
});

/**
 * Defect I. Four different things are all called "saved" in casual speech, and the
 * user makes different decisions depending on which one is true:
 *
 *   1. stored in this browser        — survives a refresh, dies with the profile;
 *   2. backed up as a workspace draft — survives this machine, but is NOT the
 *      document anybody else opens;
 *   3. committed as a workspace document version — the copy a colleague sees;
 *   4. exported as a file            — outside the app entirely.
 *
 * The autosave route deliberately does not create a document version (it echoes
 * the base version straight back), so a status that says "saved to your workspace
 * as version 9" over an autosave draft is describing something that did not
 * happen. And the same route has a real ~1 MiB ceiling, which a document with a
 * few photos exceeds — that must read as "no cloud backup for this document", not
 * as a transient failure with a Retry button that cannot ever work.
 */
describe("defect I — a workspace draft backup is not a document version", () => {
  const backedUpAsDraft = state({
    remoteEnabled: true,
    remote: "synced",
    local: "durable",
    edit: "clean",
    currentRevision: 12,
    lastLocallyDurableRevision: 12,
    lastRemoteAcknowledgedRevision: 12,
    serverVersion: 9,
  });

  it("does not claim the workspace document version was updated by an autosave draft", () => {
    const view = deriveSaveStatus(backedUpAsDraft);
    expect(view.kind).toBe("saved");
    // The bytes really are off this machine, so the headline claim stands.
    expect(view.label).toBe("Saved");
    // What must not stand is the stronger claim about version 9.
    expect(view.detail).not.toContain("version 9");
    expect(view.detail).toContain("draft");
  });

  it("says so plainly once a version really was committed", () => {
    const view = deriveSaveStatus({
      ...backedUpAsDraft,
      lastCommittedRevision: 12,
      committedServerVersion: 10,
    });
    expect(view.kind).toBe("saved");
    expect(view.detail).toContain("version 10");
  });

  it("does not credit a committed version older than what is on screen", () => {
    const view = deriveSaveStatus({
      ...backedUpAsDraft,
      currentRevision: 14,
      lastLocallyDurableRevision: 14,
      lastRemoteAcknowledgedRevision: 14,
      lastCommittedRevision: 12,
      committedServerVersion: 10,
    });
    expect(view.detail).not.toContain("version 10");
    expect(view.detail).toContain("draft");
  });

  it("keeps the two facts apart in the breakdown", () => {
    const draftOnly = deriveStatusBreakdown(backedUpAsDraft);
    expect(draftOnly.remote).toContain("draft");
    expect(draftOnly.remote).not.toMatch(/committed/i);

    const committed = deriveStatusBreakdown({
      ...backedUpAsDraft,
      lastCommittedRevision: 12,
      committedServerVersion: 10,
    });
    expect(committed.remote).toMatch(/committed/i);
    expect(committed.remote).toContain("10");
  });

  it("never mentions exporting as a thing that has happened", () => {
    // Export is not in the reducer at all (invariant), so no breakdown line may
    // imply a file was written. A user who reads "exported" and closes the tab on
    // the strength of it has lost the document.
    for (const s of [backedUpAsDraft, guestSaved()]) {
      const breakdown = deriveStatusBreakdown(s);
      expect(breakdown.local).not.toMatch(/exported/i);
      expect(breakdown.remote ?? "").not.toMatch(/exported/i);
    }
  });
});

describe("defect I — cloud backup that can never succeed", () => {
  function oversized(overrides: Partial<PersistenceState> = {}): PersistenceState {
    return state({
      remoteEnabled: true,
      remote: "failed",
      local: "durable",
      edit: "clean",
      currentRevision: 20,
      lastLocallyDurableRevision: 20,
      lastRemoteAcknowledgedRevision: -1,
      remoteChannel: {
        ...INITIAL_PERSISTENCE_STATE.remoteChannel,
        failureReason: persistenceFailure(
          "payload_too_large",
          "This document is too large for cloud autosave (3204 KB, limit 1024 KB).",
        ),
      },
      ...overrides,
    });
  }

  it("distinguishes a permanent capacity refusal from a failed attempt", () => {
    const view = deriveSaveStatus(oversized());
    expect(view.kind).toBe("remote_unavailable");
    expect(view.kind).not.toBe("remote_failed");
  });

  it("never reads as 'Saved', because the cloud copy was skipped", () => {
    const view = deriveSaveStatus(oversized());
    expect(view.label).not.toBe("Saved");
    expect(view.short).not.toBe("Saved");
    // The local truth is still stated — the work is not at risk, only unbacked.
    expect(view.label).toContain("Saved on this device");
    expect(view.detail).toContain("too large");
  });

  it("offers no retry, because the identical bytes will be refused identically", () => {
    expect(deriveSaveStatus(oversized()).retry).toBeNull();
  });

  it("tells the user how to get a copy off this device instead", () => {
    const detail = deriveSaveStatus(oversized()).detail.toLowerCase();
    expect(detail).toContain("export");
  });

  it("asks the user to act when the oversized document is not stored locally either", () => {
    const view = deriveSaveStatus(
      oversized({ local: "idle", edit: "dirty", lastLocallyDurableRevision: 17 }),
    );
    expect(view.kind).toBe("remote_unavailable");
    expect(view.tone).toBe("danger");
    expect(view.needsResolution).toBe(true);
    expect(view.retry).toBeNull();
  });

  it("reports the workspace as unbacked in the breakdown without disturbing the local line", () => {
    const breakdown = deriveStatusBreakdown(oversized());
    expect(breakdown.local).toContain("20");
    expect(breakdown.remote).toMatch(/too large/i);
    expect(breakdown.remote).not.toMatch(/retry/i);
  });

  it("still treats an expired session as a retryable failure rather than a capacity limit", () => {
    const view = deriveSaveStatus(
      oversized({
        remoteChannel: {
          ...INITIAL_PERSISTENCE_STATE.remoteChannel,
          failureReason: persistenceFailure("unauthorized", "Your session has expired."),
        },
      }),
    );
    expect(view.kind).toBe("remote_failed");
  });
});
