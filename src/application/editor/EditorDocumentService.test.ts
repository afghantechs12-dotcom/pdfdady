import { beforeEach, describe, expect, it } from "vitest";
import { getActivePage, getObject } from "@/src/domain/editor/document";
import { makeRect, resetFactory } from "@/src/domain/editor/testFactories";
import { CommandHistory } from "./commands/CommandHistory";
import { SelectionService } from "./selection/SelectionService";
import { LayerService } from "./layers/LayerService";
import { SerializationService } from "./serialization/SerializationService";
import { PluginRegistry } from "./plugins/PluginRegistry";
import { EditorDocumentService } from "./EditorDocumentService";

function makeService() {
  return new EditorDocumentService({
    history: new CommandHistory(),
    selection: new SelectionService(),
    layers: new LayerService(),
    serializer: new SerializationService(),
    plugins: new PluginRegistry(),
  });
}

describe("EditorDocumentService: state + history", () => {
  beforeEach(() => resetFactory());

  it("starts with an empty document and no undo history", () => {
    const ed = makeService();
    expect(getActivePage(ed.getState()).objects).toEqual({});
    expect(ed.canUndo).toBe(false);
    expect(ed.canRedo).toBe(false);
    expect(ed.selection.ids).toEqual([]);
  });

  it("addObject adds, selects, and is undoable", () => {
    const ed = makeService();
    const rect = makeRect();
    ed.addObject(rect);
    expect(getObject(getActivePage(ed.getState()), rect.id)).toBeDefined();
    expect(ed.isSelected(rect.id)).toBe(true);
    expect(ed.canUndo).toBe(true);

    ed.undo();
    expect(getObject(getActivePage(ed.getState()), rect.id)).toBeUndefined();
    expect(ed.canRedo).toBe(true);
    ed.redo();
    expect(getObject(getActivePage(ed.getState()), rect.id)).toBeDefined();
  });

  it("removeSelected deletes the selection and clears it", () => {
    const ed = makeService();
    ed.addObject(makeRect());
    ed.removeSelected();
    expect(Object.keys(getActivePage(ed.getState()).objects)).toHaveLength(0);
    expect(ed.selection.ids).toEqual([]);
  });

  it("moveSelection coalesces a live drag into one undo", () => {
    const ed = makeService();
    const rect = makeRect();
    ed.addObject(rect);
    const key = "drag-" + rect.id;
    ed.moveSelection({ x: 10, y: 0 }, key);
    ed.moveSelection({ x: 20, y: 0 }, key);
    ed.moveSelection({ x: 30, y: 0 }, key);
    ed.undo();
    // One undo restores the original position.
    expect(getObject(getActivePage(ed.getState()), rect.id)?.transform.e).toBe(0);
  });

  it("subscribe is notified on changes", () => {
    const ed = makeService();
    let calls = 0;
    ed.subscribe(() => calls++);
    ed.addObject(makeRect());
    ed.undo();
    ed.select("anything");
    expect(calls).toBe(3);
  });
});

describe("EditorDocumentService: selection", () => {
  beforeEach(() => resetFactory());

  it("select / addToSelection / toggle / clear / setPrimary", () => {
    const ed = makeService();
    const r1 = makeRect();
    const r2 = makeRect();
    ed.addObject(r1);
    ed.addObject(r2);
    ed.clearSelection();
    ed.select(r1.id);
    expect(ed.selection.ids).toEqual([r1.id]);
    ed.addToSelection(r2.id);
    expect(ed.selection.ids).toEqual([r1.id, r2.id]);
    ed.setPrimary(r1.id);
    expect(ed.selection.primaryId).toBe(r1.id);
    ed.toggleSelection(r1.id);
    expect(ed.selection.ids).toEqual([r2.id]);
    ed.selectAll();
    expect(ed.selection.ids).toHaveLength(2);
    ed.clearSelection();
    expect(ed.selection.ids).toEqual([]);
  });

  it("selectionBounds reflects the selected objects", () => {
    const ed = makeService();
    const r = makeRect();
    ed.addObject(r);
    const bounds = ed.selectionBounds();
    expect(bounds).toEqual({ x: 0, y: 0, width: 80, height: 60 });
  });
});

describe("EditorDocumentService: serialization + reset", () => {
  beforeEach(() => resetFactory());

  it("serialize/deserialize round-trips and clears history", () => {
    const ed = makeService();
    ed.addObject(makeRect());
    expect(ed.canUndo).toBe(true);
    const serialized = ed.serialize();
    ed.deserialize(JSON.parse(JSON.stringify(serialized)));
    expect(Object.keys(getActivePage(ed.getState()).objects)).toHaveLength(1);
    // deserialize resets history.
    expect(ed.canUndo).toBe(false);
  });

  it("reset returns to an empty document", () => {
    const ed = makeService();
    ed.addObject(makeRect());
    ed.reset();
    expect(Object.keys(getActivePage(ed.getState()).objects)).toHaveLength(0);
    expect(ed.canUndo).toBe(false);
  });
});

describe("EditorDocumentService: layers + transactions", () => {
  beforeEach(() => resetFactory());

  it("addLayer adds a layer and returns its id", () => {
    const ed = makeService();
    const id = ed.addLayer("Notes");
    expect(id).toBeTruthy();
    expect(getActivePage(ed.getState()).layerStack.layers).toHaveLength(2);
  });

  it("a transaction groups multiple ops into one undo", () => {
    const ed = makeService();
    ed.beginTransaction("Add two");
    ed.addObject(makeRect());
    ed.addObject(makeRect());
    ed.commit();
    expect(Object.keys(getActivePage(ed.getState()).objects)).toHaveLength(2);
    ed.undo(); // one undo removes both
    expect(Object.keys(getActivePage(ed.getState()).objects)).toHaveLength(0);
  });

  it("rollback aborts a transaction", () => {
    const ed = makeService();
    ed.beginTransaction("Add then abort");
    ed.addObject(makeRect());
    ed.rollback();
    expect(Object.keys(getActivePage(ed.getState()).objects)).toHaveLength(0);
    expect(ed.canUndo).toBe(false);
  });

  it("bringForward reorders within a layer", () => {
    const ed = makeService();
    const r1 = makeRect();
    const r2 = makeRect();
    ed.addObject(r1);
    ed.addObject(r2);
    ed.bringForward(r1.id);
    const order = getActivePage(ed.getState()).layerStack.layers[0].objectIds;
    expect(order[order.length - 1]).toBe(r1.id);
  });
});
