import { beforeEach, describe, expect, it } from "vitest";
import { createEditorState } from "@/src/domain/editor/document";
import { makeRect, resetFactory } from "@/src/domain/editor/testFactories";
import { AddObjectCommand, TransformObjectsCommand } from "./commands";
import { CommandHistory } from "./CommandHistory";

/**
 * `revision` — a monotonic edit counter, and why `undoDepth` could not do its job.
 *
 * The app bar's save indicator needs to answer one question: "does the document
 * on screen still match the copy the user exported?" It answered it by recording
 * `undoDepth` at export time and comparing later (the "watermark").
 *
 * That is unsound, because `undoDepth` is the LENGTH of the undo stack, not an
 * identifier of document state. Three distinct paths make the length repeat while
 * the document keeps changing, and every one of them produces a FALSE SAFE — the
 * indicator says "Exported" over a document that has unexported edits. That is
 * the precise failure mode the honesty contract exists to prevent: a user who
 * believes it closes the tab and loses work.
 *
 * `revision` increments on every applied mutation and never decreases, so equal
 * revisions really do mean "no edits since". These tests pin all three paths.
 */
describe("CommandHistory: revision is a sound save watermark", () => {
  beforeEach(() => resetFactory());

  it("starts at 0 and increments once per pushed command", () => {
    const history = new CommandHistory();
    let state = createEditorState();
    expect(history.revision).toBe(0);

    state = history.execute(new AddObjectCommand("Add object", makeRect()), state);
    expect(history.revision).toBe(1);
    history.execute(new AddObjectCommand("Add object", makeRect()), state);
    expect(history.revision).toBe(2);
  });

  /**
   * PATH 1 — the depth cap.
   *
   * `pushUndo` shifts the oldest entry once the stack exceeds `maxStackDepth`, so
   * beyond the cap `undoDepth` is PINNED at its maximum forever. Export at the
   * cap and every subsequent edit leaves the watermark matching: the indicator
   * would claim "Exported" for the rest of the session, no matter how much the
   * user changed.
   */
  it("keeps advancing after the undo stack hits its depth cap", () => {
    const history = new CommandHistory({ maxStackDepth: 3 });
    let state = createEditorState();
    for (let i = 0; i < 3; i++) {
      state = history.execute(new AddObjectCommand("Add object", makeRect()), state);
    }
    expect(history.undoDepth).toBe(3);
    const revisionAtExport = history.revision;

    // Five more real edits. The stack is full, so depth cannot move.
    for (let i = 0; i < 5; i++) {
      state = history.execute(new AddObjectCommand("Add object", makeRect()), state);
    }
    expect(history.undoDepth).toBe(3); // the trap: identical to the export moment
    expect(history.revision).toBeGreaterThan(revisionAtExport); // the fix
  });

  /**
   * PATH 2 — coalescing.
   *
   * A drag merges into the top undo entry instead of pushing, so `undoDepth` does
   * not move. Export mid-drag (or export, then continue dragging the same object)
   * and the watermark still matches while the object keeps moving.
   */
  it("advances when a command coalesces into the top entry", () => {
    const history = new CommandHistory();
    let state = createEditorState();
    const rect = makeRect();
    state = history.execute(new AddObjectCommand("Add object", rect), state);

    // A live drag: every frame shares one coalesce key so the gesture is a single
    // undo entry.
    const at = (x: number) => ({ [rect.id]: { a: 1, b: 0, c: 0, d: 1, e: x, f: 0 } });
    const drag = (from: number, to: number) =>
      new TransformObjectsCommand("Move", at(from), at(to), `drag:${rect.id}`);

    state = history.execute(drag(0, 10), state);
    const depthAfterFirstMove = history.undoDepth;
    const revisionAfterFirstMove = history.revision;

    // Continue the same drag: coalesces, so the stack does not grow.
    state = history.execute(drag(10, 20), state);
    history.execute(drag(20, 30), state);

    expect(history.undoDepth).toBe(depthAfterFirstMove); // the trap
    expect(history.revision).toBeGreaterThan(revisionAfterFirstMove); // the fix
  });

  /**
   * PATH 3 — re-branching.
   *
   * Export at depth N, undo, then make a DIFFERENT edit. The new edit clears redo
   * and pushes, returning the stack to depth N — but the document is not the one
   * that was exported. Equal depth, different content: a false safe.
   */
  it("advances when an undo is followed by a different edit back to the same depth", () => {
    const history = new CommandHistory();
    let state = createEditorState();
    state = history.execute(new AddObjectCommand("Add object", makeRect()), state);
    state = history.execute(new AddObjectCommand("Add object", makeRect()), state);

    const depthAtExport = history.undoDepth;
    const revisionAtExport = history.revision;

    state = history.undo(state);
    history.execute(new AddObjectCommand("Add different object", makeRect()), state);

    expect(history.undoDepth).toBe(depthAtExport); // the trap
    expect(history.revision).toBeGreaterThan(revisionAtExport); // the fix
  });

  /**
   * Undo/redo are edits too, in the sense that matters here: they change what is
   * on screen relative to the exported copy, so they must bump the revision. A
   * counter that only moved forward on `execute` would let "export → undo" read
   * as "Exported" while showing a document missing the last change.
   */
  it("advances on undo and on redo", () => {
    const history = new CommandHistory();
    let state = createEditorState();
    state = history.execute(new AddObjectCommand("Add object", makeRect()), state);

    const afterEdit = history.revision;
    state = history.undo(state);
    expect(history.revision).toBeGreaterThan(afterEdit);

    const afterUndo = history.revision;
    history.redo(state);
    expect(history.revision).toBeGreaterThan(afterUndo);
  });

  it("advances on a jumpTo that actually moves, and is stable when it does not", () => {
    const history = new CommandHistory();
    let state = createEditorState();
    for (let i = 0; i < 3; i++) {
      state = history.execute(new AddObjectCommand("Add object", makeRect()), state);
    }
    const before = history.revision;

    state = history.jumpTo(state, 1);
    const afterJump = history.revision;
    expect(afterJump).toBeGreaterThan(before);

    // A jump to the depth already current changes nothing, so it is not an edit.
    history.jumpTo(state, 1);
    expect(history.revision).toBe(afterJump);
  });

  /**
   * A no-op must not advance the counter, or the indicator would decay to
   * "unsaved" on its own with the user doing nothing — crying wolf, which trains
   * users to ignore the indicator just as effectively as lying to them.
   */
  it("does not advance on an undo or redo with nothing to do", () => {
    const history = new CommandHistory();
    const state = createEditorState();
    expect(history.revision).toBe(0);
    history.undo(state);
    expect(history.revision).toBe(0);
    history.redo(state);
    expect(history.revision).toBe(0);
  });

  /**
   * `clear()` runs from `loadState`, which swaps the whole document. The counter
   * must ADVANCE, not reset and not hold: a stale export watermark from the
   * previous document would otherwise still compare equal to the fresh
   * document's counter and read as "Exported" for a file never exported.
   */
  it("advances the revision when history is cleared on load", () => {
    const history = new CommandHistory();
    const state = createEditorState();
    history.execute(new AddObjectCommand("Add object", makeRect()), state);
    const before = history.revision;

    history.clear();
    expect(history.undoDepth).toBe(0);
    expect(history.revision).toBeGreaterThan(before);
  });

  /** A committed transaction is one undo entry, but still a real edit. */
  it("advances once for a committed transaction and reverts a rollback", () => {
    const history = new CommandHistory();
    let state = createEditorState();
    const before = history.revision;

    history.beginTransaction("Multi");
    state = history.execute(new AddObjectCommand("Add object", makeRect()), state);
    state = history.execute(new AddObjectCommand("Add object", makeRect()), state);
    state = history.commit(state);

    expect(history.undoDepth).toBe(1);
    expect(history.revision).toBeGreaterThan(before);

    // A rolled-back transaction leaves the document where it started, but the
    // counter still moved (it is monotonic, not a content hash) — which errs
    // toward "unsaved", the safe direction.
    const beforeRollback = history.revision;
    history.beginTransaction("Aborted");
    state = history.execute(new AddObjectCommand("Add object", makeRect()), state);
    history.rollback(state);
    expect(history.revision).toBeGreaterThanOrEqual(beforeRollback);
  });
});
