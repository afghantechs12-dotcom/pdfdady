import { beforeEach, describe, expect, it } from "vitest";
import { createEditorInstance } from "@/lib/editor/createEditorInstance";
import { getActivePage, worldBounds } from "@/src/domain/editor/document";
import { makeRect, makeTextObject, resetFactory } from "@/src/domain/editor/testFactories";
import { makeTranslate } from "@/src/domain/editor/geometry";
import { isObjectKind, type TextObject } from "@/src/domain/editor/objects";

/**
 * Tests for the M4 additions to the editor facade: multi-select, layer property
 * + duplicate, flip, set size, align/distribute, and history navigation. These
 * complement the M3.e facade test (which covers the original surface).
 */
describe("EditorDocumentService: M4 additions", () => {
  beforeEach(() => resetFactory());

  it("selectMany replaces the selection with several ids", () => {
    const ed = createEditorInstance();
    const r1 = makeRect();
    const r2 = makeRect();
    ed.addObject(r1);
    ed.addObject(r2);
    ed.selectMany([r1.id, r2.id]);
    expect(ed.selection.ids).toEqual([r1.id, r2.id]);
    expect(ed.selection.primaryId).toBe(r2.id);
  });

  it("setLayerProperty patches a layer + is undoable", () => {
    const ed = createEditorInstance();
    const layerId = getActivePage(ed.getState()).layerStack.layers[0].id;
    ed.setLayerProperty(layerId, { name: "Background", locked: true });
    let layer = getActivePage(ed.getState()).layerStack.layers[0];
    expect(layer.name).toBe("Background");
    expect(layer.locked).toBe(true);
    ed.undo();
    layer = getActivePage(ed.getState()).layerStack.layers[0];
    expect(layer.name).toBe("Layer 1");
    expect(layer.locked).toBe(false);
  });

  it("duplicateLayer adds a cloned layer + objects and returns the new id", () => {
    const ed = createEditorInstance();
    ed.addObject(makeRect());
    const sourceLayer = getActivePage(ed.getState()).layerStack.layers[0].id;
    const newId = ed.duplicateLayer(sourceLayer);
    const layers = getActivePage(ed.getState()).layerStack.layers;
    expect(layers.some((l) => l.id === newId)).toBe(true);
    const newLayer = layers.find((l) => l.id === newId);
    expect(newLayer?.objectIds.length).toBe(1);
    // Original + cloned objects present.
    expect(Object.keys(getActivePage(ed.getState()).objects).length).toBe(2);
  });

  it("flipSelection mirrors the selected object's transform", () => {
    const ed = createEditorInstance();
    const r = makeRect();
    ed.addObject(r);
    ed.flipSelection("x");
    // A flip about x folds a reflection into the transform → decompose.scale.y < 0.
    const after = getActivePage(ed.getState()).objects[r.id];
    const det = after.transform.a * after.transform.d - after.transform.b * after.transform.c;
    expect(det).toBeLessThan(0);
  });

  it("setObjectSize resizes the displayed size about the local origin", () => {
    const ed = createEditorInstance();
    const t = makeTextObject({ localBounds: { x: 0, y: 0, width: 200, height: 20 } });
    ed.addObject(t);
    ed.setObjectSize(t.id, 400, 40);
    const after = getActivePage(ed.getState()).objects[t.id];
    const wb = worldBounds(after);
    expect(Math.round(wb.width)).toBe(400);
    expect(Math.round(wb.height)).toBe(40);
  });

  it("alignSelection aligns two objects' left edges", () => {
    const ed = createEditorInstance();
    const r1 = makeRect({ transform: makeTranslate(50, 50) });
    const r2 = makeRect({ transform: makeTranslate(120, 80) });
    ed.addObject(r1);
    ed.addObject(r2);
    ed.selectMany([r1.id, r2.id]);
    ed.alignSelection("left");
    const page = getActivePage(ed.getState());
    expect(Math.round(worldBounds(page.objects[r1.id]).x)).toBe(Math.round(worldBounds(page.objects[r2.id]).x));
  });

  it("distributeSelection spaces three objects evenly", () => {
    const ed = createEditorInstance();
    const r1 = makeRect({ transform: makeTranslate(0, 0) });
    const r2 = makeRect({ transform: makeTranslate(50, 0) });
    const r3 = makeRect({ transform: makeTranslate(300, 0) });
    ed.addObject(r1);
    ed.addObject(r2);
    ed.addObject(r3);
    ed.selectMany([r1.id, r2.id, r3.id]);
    ed.distributeSelection("horizontal");
    const page = getActivePage(ed.getState());
    const xs = [r1, r2, r3].map((r) => worldBounds(page.objects[r.id]).x);
    const gap1 = xs[1] - xs[0];
    const gap2 = xs[2] - xs[1];
    expect(Math.abs(gap1 - gap2)).toBeLessThan(0.5);
  });

  it("history navigation: jumpTo + undo/redo labels", () => {
    const ed = createEditorInstance();
    ed.addObject(makeRect());
    ed.addObject(makeRect());
    expect(ed.undoLabels()).toEqual(["Add object", "Add object"]);
    ed.jumpTo(1);
    expect(Object.keys(getActivePage(ed.getState()).objects).length).toBe(1);
    expect(ed.redoLabels()).toEqual(["Add object"]);
    ed.jumpTo(2);
    expect(Object.keys(getActivePage(ed.getState()).objects).length).toBe(2);
  });

  it("a text object round-trips through the facade with letterSpacing preserved", () => {
    const ed = createEditorInstance();
    const t = makeTextObject({ letterSpacing: 2 });
    ed.addObject(t);
    ed.setLayerProperty(getActivePage(ed.getState()).layerStack.layers[0].id, { name: "L" });
    const snap = ed.serialize();
    const ed2 = createEditorInstance();
    ed2.deserialize(JSON.parse(JSON.stringify(snap)));
    const restored = Object.values(getActivePage(ed2.getState()).objects).find((o): o is TextObject => isObjectKind(o, "text"));
    expect(restored?.letterSpacing).toBe(2);
  });
});
