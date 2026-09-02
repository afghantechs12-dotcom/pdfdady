import { beforeEach, describe, expect, it } from "vitest";
import { makeTranslate } from "@/src/domain/editor/geometry";
import {
  addObjectToPage,
  createEditorState,
  getActivePage,
  getObject,
} from "@/src/domain/editor/document";
import { createLayer } from "@/src/domain/editor/layers";
import { makeRect, resetFactory } from "@/src/domain/editor/testFactories";
import { CommandHistory } from "./CommandHistory";
import { CompositeCommand } from "./types";
import {
  AddLayerCommand,
  AddObjectCommand,
  ChangeSelectionCommand,
  RemoveObjectsCommand,
  ReorderLayerCommand,
  ReorderObjectCommand,
  SetPropertyCommand,
  SetActivePageCommand,
  TransformObjectsCommand,
  captureTransforms,
  moveToLayerCommand,
  removeLayerCommand,
} from "./commands";

/** Helper: add `count` rects to a fresh state's active page, return state. */
function stateWithRects(count: number) {
  const state = createEditorState();
  let page = getActivePage(state);
  for (let i = 0; i < count; i++) page = addObjectToPage(page, makeRect());
  return { state: { ...state, document: { ...state.document, pages: [page] } }, page };
}

describe("commands: concrete commands round-trip", () => {
  beforeEach(() => resetFactory());

  it("AddObjectCommand adds, invert removes", () => {
    const { state } = stateWithRects(0);
    const rect = makeRect();
    const cmd = new AddObjectCommand("Add rect", rect);
    const added = cmd.apply(state);
    expect(getObject(getActivePage(added), rect.id)).toBeDefined();
    const removed = cmd.invert(added);
    expect(getObject(getActivePage(removed), rect.id)).toBeUndefined();
  });

  it("RemoveObjectsCommand removes, invert restores", () => {
    const { state } = stateWithRects(2);
    const ids = Object.keys(getActivePage(state).objects);
    const cmd = new RemoveObjectsCommand(
      "Remove",
      ids.map((id) => getObject(getActivePage(state), id)!),
    );
    const removed = cmd.apply(state);
    expect(Object.keys(getActivePage(removed).objects)).toHaveLength(0);
    const restored = cmd.invert(removed);
    expect(Object.keys(getActivePage(restored).objects)).toHaveLength(2);
  });

  it("TransformObjectsCommand swaps before/after transforms", () => {
    const { state } = stateWithRects(1);
    const id = Object.keys(getActivePage(state).objects)[0];
    const before = captureTransforms(state, [id]);
    const after = { [id]: makeTranslate(50, 50) };
    const cmd = new TransformObjectsCommand("Move", before, after);
    const moved = cmd.apply(state);
    expect(getObject(getActivePage(moved), id)?.transform.e).toBe(50);
    const undone = cmd.invert(moved);
    expect(getObject(getActivePage(undone), id)?.transform.e).toBe(0);
  });

  it("TransformObjectsCommand.merge keeps the original before + latest after", () => {
    const { state } = stateWithRects(1);
    const id = Object.keys(getActivePage(state).objects)[0];
    const before = captureTransforms(state, [id]);
    const first = new TransformObjectsCommand("Drag", before, { [id]: makeTranslate(10, 0) }, "drag-1");
    const next = new TransformObjectsCommand("Drag", { [id]: makeTranslate(10, 0) }, { [id]: makeTranslate(20, 0) }, "drag-1");
    const merged = first.merge(next)!;
    // apply the merged command: should land at 20 (latest after).
    const moved = merged.apply(state);
    expect(getObject(getActivePage(moved), id)?.transform.e).toBe(20);
    // invert the merged command: should restore to 0 (original before).
    const undone = merged.invert(moved);
    expect(getObject(getActivePage(undone), id)?.transform.e).toBe(0);
  });

  it("SetPropertyCommand patches and restores", () => {
    const { state } = stateWithRects(1);
    const id = Object.keys(getActivePage(state).objects)[0];
    const cmd = new SetPropertyCommand("Rename", id, { name: "Rect" }, { name: "My Rect" });
    const patched = cmd.apply(state);
    expect(getObject(getActivePage(patched), id)?.name).toBe("My Rect");
    const undone = cmd.invert(patched);
    expect(getObject(getActivePage(undone), id)?.name).toBe("Rect");
  });

  it("ReorderObjectCommand moves and inverts by negating the delta", () => {
    const { state } = stateWithRects(3);
    const page = getActivePage(state);
    const firstId = page.layerStack.layers[0].objectIds[0];
    const cmd = new ReorderObjectCommand("Forward", firstId, 1);
    const moved = cmd.apply(state);
    const movedLayer = getActivePage(moved).layerStack.layers[0];
    expect(movedLayer.objectIds.indexOf(firstId)).toBe(1);
    const undone = cmd.invert(moved);
    expect(getActivePage(undone).layerStack.layers[0].objectIds.indexOf(firstId)).toBe(0);
  });

  it("MoveToLayerCommand relocates and restores via the factory-captured source", () => {
    let state = createEditorState();
    // Add a second layer, then an object on layer-1.
    let page = getActivePage(state);
    page = {
      ...page,
      layerStack: {
        layers: [createLayer("layer-1", "Bottom", []), createLayer("layer-2", "Top", [])],
      },
    };
    state = { ...state, document: { ...state.document, pages: [page] } };
    const rect = makeRect();
    const addCmd = new AddObjectCommand("Add", rect, "layer-1");
    state = addCmd.apply(state);
    const move = moveToLayerCommand(state, rect.id, "layer-2");
    const moved = move.apply(state);
    expect(getActivePage(moved).layerStack.layers[1].objectIds).toContain(rect.id);
    const undone = move.invert(moved);
    expect(getActivePage(undone).layerStack.layers[0].objectIds).toContain(rect.id);
  });

  it("ReorderLayerCommand moves a layer and inverts", () => {
    let state = createEditorState();
    let page = getActivePage(state);
    page = {
      ...page,
      layerStack: {
        layers: [createLayer("a", "A"), createLayer("b", "B"), createLayer("c", "C")],
      },
    };
    state = { ...state, document: { ...state.document, pages: [page] } };
    const cmd = new ReorderLayerCommand("Layer up", "a", 2);
    const moved = cmd.apply(state);
    expect(getActivePage(moved).layerStack.layers.map((l) => l.id)).toEqual(["b", "c", "a"]);
    const undone = cmd.invert(moved);
    expect(getActivePage(undone).layerStack.layers.map((l) => l.id)).toEqual(["a", "b", "c"]);
  });

  it("AddLayerCommand / RemoveLayerCommand round-trip via factory", () => {
    const { state } = stateWithRects(0);
    const addCmd = new AddLayerCommand("Add layer", createLayer("layer-2", "Annotations"));
    const added = addCmd.apply(state);
    expect(getActivePage(added).layerStack.layers).toHaveLength(2);
    const undone = addCmd.invert(added);
    expect(getActivePage(undone).layerStack.layers).toHaveLength(1);

    // RemoveLayerCommand captures the layer + index for exact restore.
    const removeCmd = removeLayerCommand(added, "layer-2");
    const removed = removeCmd.apply(added);
    expect(getActivePage(removed).layerStack.layers).toHaveLength(1);
    const restored = removeCmd.invert(removed);
    expect(getActivePage(restored).layerStack.layers).toHaveLength(2);
  });

  it("SetActivePageCommand and ChangeSelectionCommand round-trip", () => {
    const state = createEditorState();
    const sel = new ChangeSelectionCommand("Select", state.selection, { ids: ["x"], primaryId: "x" });
    const selected = sel.apply(state);
    expect(selected.selection.ids).toEqual(["x"]);
    expect(sel.invert(selected).selection.ids).toEqual([]);

    const page = new SetActivePageCommand("Go to page", "page-1", "page-2");
    const gone = page.apply(state);
    expect(gone.activePageId).toBe("page-2");
    expect(page.invert(gone).activePageId).toBe("page-1");
  });
});

describe("CommandHistory: undo/redo stacks", () => {
  beforeEach(() => resetFactory());

  it("execute/undo/redo with canUndo/canRedo flags", () => {
    const { state } = stateWithRects(0);
    const history = new CommandHistory();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);

    const rect = makeRect();
    let s = history.execute(new AddObjectCommand("Add", rect), state);
    expect(getObject(getActivePage(s), rect.id)).toBeDefined();
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);
    expect(history.undoLabel).toBe("Add");

    s = history.undo(s);
    expect(getObject(getActivePage(s), rect.id)).toBeUndefined();
    expect(history.canRedo).toBe(true);
    expect(history.redoLabel).toBe("Add");

    s = history.redo(s);
    expect(getObject(getActivePage(s), rect.id)).toBeDefined();
    expect(history.canRedo).toBe(false);
  });

  it("a new edit clears the redo stack (history branches)", () => {
    const { state } = stateWithRects(0);
    const history = new CommandHistory();
    let s = history.execute(new AddObjectCommand("Add 1", makeRect()), state);
    s = history.undo(s);
    expect(history.canRedo).toBe(true);
    // A new edit after undo discards the redo branch. The returned state isn't
    // needed — we only care about the side effect on the history stacks.
    history.execute(new AddObjectCommand("Add 2", makeRect()), s);
    expect(history.canRedo).toBe(false);
    expect(history.undoDepth).toBe(1);
  });

  it("coalesces consecutive same-key transform commands into one undo", () => {
    const { state } = stateWithRects(1);
    const id = Object.keys(getActivePage(state).objects)[0];
    const before = captureTransforms(state, [id]);
    const history = new CommandHistory();
    const key = "drag-1";
    let s = history.execute(
      new TransformObjectsCommand("Drag", before, { [id]: makeTranslate(10, 0) }, key),
      state,
    );
    s = history.execute(
      new TransformObjectsCommand("Drag", { [id]: makeTranslate(10, 0) }, { [id]: makeTranslate(20, 0) }, key),
      s,
    );
    s = history.execute(
      new TransformObjectsCommand("Drag", { [id]: makeTranslate(20, 0) }, { [id]: makeTranslate(30, 0) }, key),
      s,
    );
    // Three executes, but one undo entry.
    expect(history.undoDepth).toBe(1);
    // A single undo restores the original position (coalesced back to `before`).
    s = history.undo(s);
    expect(getObject(getActivePage(s), id)?.transform.e).toBe(0);
  });

  it("transactions commit as a single composite undo entry", () => {
    const { state } = stateWithRects(0);
    const history = new CommandHistory();
    history.beginTransaction("Add two rects");
    let s = history.execute(new AddObjectCommand("Add 1", makeRect()), state);
    s = history.execute(new AddObjectCommand("Add 2", makeRect()), s);
    s = history.commit(s);
    expect(history.undoDepth).toBe(1);
    expect(Object.keys(getActivePage(s).objects)).toHaveLength(2);
    // One undo removes both.
    s = history.undo(s);
    expect(Object.keys(getActivePage(s).objects)).toHaveLength(0);
  });

  it("transaction rollback inverts buffered commands and discards them", () => {
    const { state } = stateWithRects(0);
    const history = new CommandHistory();
    history.beginTransaction("Add then abort");
    let s = history.execute(new AddObjectCommand("Add", makeRect()), state);
    expect(Object.keys(getActivePage(s).objects)).toHaveLength(1);
    s = history.rollback(s);
    expect(Object.keys(getActivePage(s).objects)).toHaveLength(0);
    expect(history.canUndo).toBe(false);
  });

  it("CompositeCommand applies in order and inverts in reverse", () => {
    const { state } = stateWithRects(0);
    const r1 = makeRect();
    const r2 = makeRect();
    const composite = new CompositeCommand("Add two", [
      new AddObjectCommand("Add 1", r1),
      new AddObjectCommand("Add 2", r2),
    ]);
    const applied = composite.apply(state);
    expect(Object.keys(getActivePage(applied).objects)).toHaveLength(2);
    const undone = composite.invert(applied);
    expect(Object.keys(getActivePage(undone).objects)).toHaveLength(0);
  });

  it("CompositeCommand rejects an empty sub-command list", () => {
    expect(() => new CompositeCommand("Empty", [])).toThrow();
  });

  it("respects maxStackDepth by dropping the oldest entry", () => {
    const { state } = stateWithRects(0);
    const history = new CommandHistory({ maxStackDepth: 2 });
    history.execute(new AddObjectCommand("1", makeRect()), state);
    history.execute(new AddObjectCommand("2", makeRect()), state);
    history.execute(new AddObjectCommand("3", makeRect()), state);
    expect(history.undoDepth).toBe(2);
  });

  it("undo mid-transaction rolls back the buffered commands", () => {
    const { state } = stateWithRects(0);
    const history = new CommandHistory();
    history.beginTransaction("Add two");
    let s = history.execute(new AddObjectCommand("1", makeRect()), state);
    s = history.execute(new AddObjectCommand("2", makeRect()), s);
    s = history.undo(s); // aborts the transaction
    expect(Object.keys(getActivePage(s).objects)).toHaveLength(0);
    expect(history.inTransaction).toBe(false);
  });

  it("notifies the onChange listener after structural changes", () => {
    let calls = 0;
    const { state } = stateWithRects(0);
    const history = new CommandHistory({ onChange: () => (calls += 1) });
    history.execute(new AddObjectCommand("Add", makeRect()), state);
    history.undo(state);
    history.redo(state);
    history.clear();
    expect(calls).toBe(4);
  });
});
