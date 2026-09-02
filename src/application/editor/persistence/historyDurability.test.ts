import { beforeEach, describe, expect, it } from "vitest";
import { createEditorState } from "@/src/domain/editor/document";
import { makeRect, resetFactory } from "@/src/domain/editor/testFactories";
import {
  AddObjectCommand,
  TransformObjectsCommand,
} from "@/src/application/editor/commands/commands";
import { CommandHistory } from "@/src/application/editor/commands/CommandHistory";
import { deriveSaveStatus, statusHasPendingWork } from "./derivedStatus";
import { INITIAL_PERSISTENCE_STATE, persistenceReducer, type PersistenceState } from "./persistenceMachine";
import type { PersistenceEvent } from "./events";

/**
 * The canonical save status against the REAL command history.
 *
 * This file replaces `components/editor/appBarLogic.history.test.ts`, which asked
 * the same questions of the app bar's own second save model (`saveIndicator`,
 * keyed on the last EXPORT). That model is gone — it is what let the app bar say
 * "Unsaved changes" beside a status bar saying "Saved on this device" — so the
 * questions moved here, to the one model both surfaces now render.
 *
 * The point of driving a real `CommandHistory` rather than hand-written numbers is
 * unchanged, and it is not redundant with `persistenceMachine.test.ts`: the bug
 * these paths exist for was never in the rules, it was in the SIGNAL fed to them.
 * The watermark used to be the editor's `undoDepth`, and a stack length repeats —
 * it is pinned by the depth cap, unmoved by a coalescing drag, and returns to an
 * old value after undo-then-a-different-edit. Every one of those is a real,
 * visible change to the document that left a correct rule claiming safety.
 *
 * The invariant, stated once: a status whose `tone` is `success` may stand ONLY
 * while no mutation has been applied past the durable watermark. `tone` is the
 * assertion target rather than `kind` because `tone === "success"` is exactly the
 * set of states the product presents as safe, and `statusHasPendingWork` — the one
 * predicate behind every "unsaved" affordance — is defined from it.
 */

const DOC = "doc-1";
const SESSION = "session-a";

/** A guest document: no remote channel, so the local draft is the only durability. */
function openedAt(revision: number, documentSessionId = SESSION): PersistenceState {
  return persistenceReducer(INITIAL_PERSISTENCE_STATE, {
    type: "DOCUMENT_OPENED",
    documentId: DOC,
    documentSessionId,
    revision,
    remoteEnabled: false,
    online: true,
    at: 1_000,
  });
}

/** Publishes the history's ACTUAL revision, which is the whole point of this file. */
function sync(
  state: PersistenceState,
  history: CommandHistory,
  documentSessionId = SESSION,
): PersistenceState {
  return persistenceReducer(state, {
    type: "DOCUMENT_MUTATED",
    documentId: DOC,
    documentSessionId,
    revision: history.revision,
    at: 2_000,
  });
}

/**
 * A verified local draft of the revision currently on screen — the only route to a
 * durability claim, and the analogue of the old file's "an export completed here".
 */
function savedLocally(state: PersistenceState, requestId: string): PersistenceState {
  const revision = state.currentRevision;
  const scope = { documentId: DOC, documentSessionId: SESSION, requestId, revision };
  const events: PersistenceEvent[] = [
    { ...scope, type: "LOCAL_WRITE_SCHEDULED", at: 2_100 },
    { ...scope, type: "LOCAL_WRITE_STARTED", at: 2_200 },
    { ...scope, type: "LOCAL_WRITE_SUCCEEDED", at: 2_300, draftId: "draft-1" },
  ];
  return events.reduce(persistenceReducer, state);
}

/** What the product presents as safe. */
function claimsSafe(state: PersistenceState): boolean {
  return deriveSaveStatus(state).tone === "success";
}

describe("durability claims against a real CommandHistory", () => {
  beforeEach(() => resetFactory());

  it("claims saved on this device after a write, then stops on the next edit", () => {
    const history = new CommandHistory();
    let state = createEditorState();
    state = history.execute(new AddObjectCommand("Add object", makeRect()), state);

    let p = savedLocally(sync(openedAt(0), history), "req-1");
    expect(deriveSaveStatus(p).kind).toBe("saved_local");
    expect(claimsSafe(p)).toBe(true);

    history.execute(new AddObjectCommand("Add object", makeRect()), state);
    p = sync(p, history);
    expect(claimsSafe(p)).toBe(false);
    expect(deriveSaveStatus(p).kind).toBe("unsaved");
    expect(statusHasPendingWork(deriveSaveStatus(p))).toBe(true);
  });

  /**
   * PATH 1 — the depth cap. With `undoDepth` as the watermark this claimed safety
   * forever: the stack was already full, so the depth could not move again no
   * matter how many edits followed.
   */
  it("does not claim safety after edits beyond the undo depth cap", () => {
    const history = new CommandHistory({ maxStackDepth: 3 });
    let state = createEditorState();
    for (let i = 0; i < 3; i++) {
      state = history.execute(new AddObjectCommand("Add object", makeRect()), state);
    }

    let p = savedLocally(sync(openedAt(0), history), "req-1");
    expect(claimsSafe(p)).toBe(true);

    const depthAtSave = history.undoDepth;
    for (let i = 0; i < 10; i++) {
      state = history.execute(new AddObjectCommand("Add object", makeRect()), state);
    }
    expect(history.undoDepth).toBe(depthAtSave); // pinned at 3 throughout

    p = sync(p, history);
    expect(claimsSafe(p)).toBe(false);
    expect(p.edit).toBe("dirty");
  });

  /**
   * PATH 2 — coalescing. Save mid-drag, keep dragging: the gesture merges into the
   * top undo entry, so the depth never moves while the object keeps moving.
   */
  it("does not claim safety while a coalescing drag continues after a write", () => {
    const history = new CommandHistory();
    let state = createEditorState();
    const rect = makeRect();
    state = history.execute(new AddObjectCommand("Add object", rect), state);

    const at = (x: number) => ({ [rect.id]: { a: 1, b: 0, c: 0, d: 1, e: x, f: 0 } });
    const drag = (from: number, to: number) =>
      new TransformObjectsCommand("Move", at(from), at(to), `drag:${rect.id}`);

    state = history.execute(drag(0, 10), state);
    let p = savedLocally(sync(openedAt(0), history), "req-1");
    expect(claimsSafe(p)).toBe(true);

    const depthAtSave = history.undoDepth;
    history.execute(drag(10, 120), state);
    expect(history.undoDepth).toBe(depthAtSave); // coalesced: depth unchanged

    p = sync(p, history);
    expect(claimsSafe(p)).toBe(false);
  });

  /**
   * PATH 3 — re-branching. Save, undo, make a DIFFERENT edit. The stack returns to
   * the saved depth over a document whose contents were never written anywhere.
   */
  it("does not claim safety after undo-then-a-different-edit returns to the same depth", () => {
    const history = new CommandHistory();
    let state = createEditorState();
    state = history.execute(new AddObjectCommand("Add object", makeRect()), state);
    state = history.execute(new AddObjectCommand("Add object", makeRect()), state);

    let p = savedLocally(sync(openedAt(0), history), "req-1");
    const depthAtSave = history.undoDepth;

    state = history.undo(state);
    history.execute(new AddObjectCommand("Add different object", makeRect()), state);
    expect(history.undoDepth).toBe(depthAtSave);

    p = sync(p, history);
    expect(claimsSafe(p)).toBe(false);
  });

  /** An undo alone also diverges from what was written. */
  it("does not claim safety after undoing part of the written work", () => {
    const history = new CommandHistory();
    let state = createEditorState();
    state = history.execute(new AddObjectCommand("Add object", makeRect()), state);
    state = history.execute(new AddObjectCommand("Add object", makeRect()), state);

    let p = savedLocally(sync(openedAt(0), history), "req-1");
    history.undo(state);

    p = sync(p, history);
    expect(claimsSafe(p)).toBe(false);
  });

  /**
   * T13's other half: a write after the undo re-establishes the baseline. Undo is
   * not a special case in this model — it is a mutation like any other, and the
   * same write that makes an edit safe makes an undone edit safe.
   */
  it("re-establishes safety with a write after the undo", () => {
    const history = new CommandHistory();
    let state = createEditorState();
    state = history.execute(new AddObjectCommand("Add object", makeRect()), state);
    state = history.execute(new AddObjectCommand("Add object", makeRect()), state);

    let p = savedLocally(sync(openedAt(0), history), "req-1");
    history.undo(state);
    p = sync(p, history);
    expect(claimsSafe(p)).toBe(false);

    p = savedLocally(p, "req-2");
    expect(claimsSafe(p)).toBe(true);
    expect(p.lastLocallyDurableRevision).toBe(history.revision);
  });

  /**
   * Loading a new document clears history. A watermark from the previous document
   * must not carry: the new document has no draft in this browser, so the honest
   * status is `unchanged` — nothing to lose — and specifically NOT `saved_local`,
   * which would assert a draft that does not exist.
   */
  it("does not carry a durability claim across a document load", () => {
    const history = new CommandHistory();
    const state = createEditorState();
    history.execute(new AddObjectCommand("Add object", makeRect()), state);
    let p = savedLocally(sync(openedAt(0), history), "req-1");
    expect(deriveSaveStatus(p).kind).toBe("saved_local");

    history.clear(); // a new document is opened
    expect(history.undoDepth).toBe(0);
    p = openedAt(history.revision, "session-b");

    expect(deriveSaveStatus(p).kind).toBe("unchanged");
    expect(p.lastLocallyDurableRevision).toBeLessThan(history.revision);
    expect(statusHasPendingWork(deriveSaveStatus(p))).toBe(false);
  });

  /**
   * The complement: the status must not cry wolf either. A no-op redo changes
   * nothing, so nothing decays — a status that went stale on its own would train
   * users to ignore it just as effectively as one that lies.
   */
  it("stays safe across no-op undo/redo attempts and repeated reads", () => {
    const history = new CommandHistory();
    let state = createEditorState();
    state = history.execute(new AddObjectCommand("Add object", makeRect()), state);
    const p = savedLocally(sync(openedAt(0), history), "req-1");

    history.redo(state); // empty redo stack: nothing to do, so nothing changed
    const after = sync(p, history);
    expect(after.currentRevision).toBe(p.currentRevision);
    expect(claimsSafe(after)).toBe(true);
    expect(claimsSafe(after)).toBe(true);
  });
});
