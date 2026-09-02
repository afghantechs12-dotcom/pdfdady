import { describe, expect, it } from "vitest";
import { CONFLICT_ACTIONS, presentConflict } from "./conflictResolution";
import { INITIAL_PERSISTENCE_STATE, type PersistenceState } from "./persistenceMachine";
import type { ConflictInfo } from "./events";

/**
 * How a conflict is described to the person who has to resolve it.
 *
 * A conflict is the one persistence state where the product genuinely cannot know
 * the right answer, so the entire job of this layer is to avoid pretending
 * otherwise. Three specific lies are guarded against here:
 *
 *  - that something has already been decided ("your changes were replaced");
 *  - that the safe-looking option is safe when it is not — replacing the workspace
 *    version ends work that may belong to somebody else, and it must look like it;
 *  - that the user's own copy is safer than it is. "Your changes are stored in this
 *    browser" over a revision no draft ever captured is the sentence that makes
 *    someone close the tab.
 *
 * The presentation is also read-only in the strictest sense: describing a conflict
 * must never advance a watermark, clear the conflict, or touch the local draft.
 */

const AT = Date.UTC(2026, 7, 22, 15, 0, 0);

function conflict(overrides: Partial<ConflictInfo> = {}): ConflictInfo {
  return {
    localRevision: 12,
    expectedServerVersion: 9,
    actualServerVersion: 11,
    detail: null,
    detectedAt: AT,
    ...overrides,
  };
}

function state(overrides: Partial<PersistenceState> = {}): PersistenceState {
  return {
    ...INITIAL_PERSISTENCE_STATE,
    documentId: "doc-1",
    documentSessionId: "session-a",
    documentKey: "workspace:doc-1",
    remoteEnabled: true,
    remote: "conflict",
    currentRevision: 12,
    baselineRevision: 0,
    lastLocallyDurableRevision: 12,
    lastLocalSaveAt: AT - 1_000,
    conflict: conflict(),
    ...overrides,
  };
}

/** Non-null presentation or a thrown test failure — never an optional chain. */
function present(input: PersistenceState, override?: ConflictInfo) {
  const result = override === undefined ? presentConflict(input) : presentConflict(input, override);
  if (result === null) throw new Error("expected a conflict presentation");
  return result;
}

describe("when there is nothing to present", () => {
  it("returns null rather than an empty dialog for a state with no conflict", () => {
    expect(presentConflict(state({ conflict: null, remote: "idle" }))).toBeNull();
  });
});

describe("what the user is told is true right now", () => {
  it("states that nothing has been overwritten, because nothing has", () => {
    const view = present(state());
    expect(view.explanation).toContain("Nothing has been overwritten");
  });

  it("does not blame the user or a colleague for the state it found", () => {
    const view = present(state());
    // Both causes are named as possibilities, neither as the cause: the client
    // cannot tell a colleague's save from the user's own second tab.
    expect(view.explanation).toContain("someone else saved it");
    expect(view.explanation).toContain("another tab");
  });

  it("says the work is in this browser only when a draft actually holds it", () => {
    const view = present(state({ lastLocallyDurableRevision: 12 }));
    expect(view.safety).toContain("stored in this browser");
    expect(view.local.savedOnThisDevice).toBe(true);
  });

  it("tells the user to download a copy when no draft holds the refused revision", () => {
    /*
     * The local channel and the remote channel fail independently. A conflict with
     * a failed local write is the worst state in the system — the only copy of the
     * work is in volatile memory — and it is indistinguishable from the safe case
     * unless the safety line changes.
     */
    const view = present(state({ lastLocallyDurableRevision: 4, local: "failed" }));
    expect(view.safety).not.toContain("stored in this browser");
    expect(view.safety).toContain("only in this tab");
    expect(view.safety).toMatch(/download/i);
    expect(view.local.savedOnThisDevice).toBe(false);
  });

  it("judges durability against the refused revision, not against whatever is on screen now", () => {
    /*
     * The user kept editing while the conflict sat on screen. The question the
     * safety line answers is whether the revision the server refused is recoverable,
     * because that is the one the dialog is about.
     */
    const view = present(state({ currentRevision: 20, lastLocallyDurableRevision: 12 }));
    expect(view.local.revision).toBe(12);
    expect(view.local.savedOnThisDevice).toBe(true);
  });

  it("reports the local revision from the conflict rather than from the live editor", () => {
    const view = present(state({ currentRevision: 31 }), conflict({ localRevision: 12 }));
    expect(view.local.revision).toBe(12);
  });

  it("carries the local save time so the two versions can be compared by age", () => {
    expect(present(state()).local.at).toBe(AT - 1_000);
    expect(present(state({ lastLocalSaveAt: null })).local.at).toBeNull();
  });
});

describe("the two versions are described separately", () => {
  it("keeps the version the client expected apart from the one the server has", () => {
    const view = present(state(), conflict({ expectedServerVersion: 9, actualServerVersion: 11 }));
    expect(view.remote.expectedServerVersion).toBe(9);
    expect(view.remote.serverVersion).toBe(11);
  });

  it("does not invent a version the server declined to disclose", () => {
    // A 409 with no version in the body is common. Substituting the expected
    // version here would tell the user the conflict is with the version they
    // already had, which is the one thing it certainly is not.
    const view = present(state(), conflict({ actualServerVersion: null }));
    expect(view.remote.serverVersion).toBeNull();
    expect(view.remote.expectedServerVersion).toBe(9);
  });

  it("passes the server's own explanation through when there is one, and null when there is not", () => {
    expect(present(state(), conflict({ detail: "Edited by A. Rivera 2 minutes ago." })).detail).toBe(
      "Edited by A. Rivera 2 minutes ago.",
    );
    expect(present(state()).detail).toBeNull();
  });
});

describe("the choices offered", () => {
  it("offers every option, in one order, every time", () => {
    expect(present(state()).actions.map((action) => action.id)).toEqual([
      "review_local",
      "review_workspace",
      "save_local_copy",
      "duplicate_as_new",
      "replace_workspace",
      "cancel",
    ]);
  });

  it("marks exactly one option destructive, and requires a second confirmation for it", () => {
    const destructive = present(state()).actions.filter((action) => action.destructive);
    expect(destructive.map((action) => action.id)).toEqual(["replace_workspace"]);
    expect(destructive[0]!.requiresConfirmation).toBe(true);
  });

  it("puts the destructive option after every safe one, and before deciding later", () => {
    const ids = present(state()).actions.map((action) => action.id);
    const replace = ids.indexOf("replace_workspace");
    const safe = present(state())
      .actions.filter((action) => !action.destructive && action.id !== "cancel")
      .map((action) => ids.indexOf(action.id));
    expect(Math.max(...safe)).toBeLessThan(replace);
    expect(replace).toBeLessThan(ids.indexOf("cancel"));
  });

  it("never requires confirmation for an option that destroys nothing", () => {
    // A confirmation on a safe action trains the user to click through the one that
    // is not safe.
    for (const action of Object.values(CONFLICT_ACTIONS)) {
      if (!action.destructive) expect(action.requiresConfirmation).toBe(false);
    }
  });

  it("always offers a way out that needs neither the server nor a decision", () => {
    const download = present(state()).actions.find((action) => action.id === "save_local_copy");
    expect(download).toBeDefined();
    expect(download!.destructive).toBe(false);
    expect(download!.requiresConfirmation).toBe(false);
  });

  it("offers keeping both, so the user is never forced to pick a loser", () => {
    const both = CONFLICT_ACTIONS.duplicate_as_new;
    expect(both.destructive).toBe(false);
    expect(both.description.toLowerCase()).toContain("leave the workspace copy alone");
  });

  it("says out loud what replacing the workspace version costs", () => {
    expect(CONFLICT_ACTIONS.replace_workspace.description).toMatch(/will be lost/i);
  });

  it("warns of loss only in the description of the option that causes it", () => {
    /*
     * Matching the warning, not the word: "so it cannot be lost" is a safety
     * promise and belongs on a safe option. What must never appear on a safe
     * option is the prediction that something *will* go — that is the sentence a
     * user weighs, and putting it on the wrong row inverts the decision.
     */
    const warns = /will be lost|overwrit/i;
    for (const action of Object.values(CONFLICT_ACTIONS)) {
      if (action.destructive) continue;
      expect(action.description).not.toMatch(warns);
    }
    expect(CONFLICT_ACTIONS.replace_workspace.description).toMatch(warns);
  });

  it("describes deciding later as keeping both versions where they are", () => {
    // "Cancel" must not read as "discard my changes", which is what a bare Cancel
    // reads as in every other dialog in every other app.
    expect(CONFLICT_ACTIONS.cancel.label).toBe("Decide later");
    expect(CONFLICT_ACTIONS.cancel.description.toLowerCase()).toContain("keep both versions");
  });

  it("gives every option a label and an explanation of what it does", () => {
    for (const action of present(state()).actions) {
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.description.length).toBeGreaterThan(0);
    }
  });
});

describe("describing a conflict changes nothing", () => {
  it("does not mutate the state it was handed", () => {
    const before = state();
    const snapshot = JSON.parse(JSON.stringify(before));
    present(Object.freeze(before) as PersistenceState);
    expect(JSON.parse(JSON.stringify(before))).toEqual(snapshot);
  });

  it("produces the same presentation however many times it is asked", () => {
    const input = state();
    expect(present(input)).toEqual(present(input));
  });

  it("prefers the conflict it is given over the one in the state", () => {
    // The coordinator holds the conflict that a specific attempt hit; the state
    // holds the newest one. Resolving the dialog the user is actually looking at
    // requires the former.
    const view = present(state(), conflict({ localRevision: 3, actualServerVersion: 4 }));
    expect(view.local.revision).toBe(3);
    expect(view.remote.serverVersion).toBe(4);
  });
});
