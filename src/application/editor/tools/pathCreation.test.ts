import { describe, expect, it } from "vitest";
import { createEditorInstance } from "@/lib/editor/createEditorInstance";
import {
  addAnchor,
  commit as commitPath,
  createPathBuilder,
  dragHandle,
} from "@/src/application/editor/tools/PathBuilder";
import { getActivePage } from "@/src/domain/editor/document";
import { createShapeObject } from "@/src/domain/editor/objectFactories";
import { isObjectKind } from "@/src/domain/editor/objects";
import { shapePathData } from "@/src/domain/editor/shapeGeometry";

/**
 * Path creation end-to-end (M6.10): the canvas commits PathBuilder anchors
 * into ONE undoable path shape. These tests drive the same calls the canvas
 * makes and verify history, serialization round-trip, and that the stored
 * pathData is exactly what the renderer/exporter geometry source consumes.
 */

function buildCurvedPath() {
  let s = createPathBuilder();
  s = addAnchor(s, { x: 100, y: 100 });
  s = addAnchor(s, { x: 200, y: 100 });
  s = dragHandle(s, { x: 240, y: 160 }); // smooth anchor with an out-handle
  s = addAnchor(s, { x: 300, y: 220 });
  return commitPath(s)!;
}

describe("path creation through the editor service", () => {
  it("creates one undoable path object with normalized local geometry", () => {
    const ed = createEditorInstance();
    const committed = buildCurvedPath();
    expect(committed).not.toBeNull();

    const layerId = getActivePage(ed.getState()).layerStack.layers.at(-1)!.id;
    const obj = createShapeObject(committed.position, layerId, "path", {
      pathData: committed.pathData,
      localBounds: committed.localBounds,
    });
    ed.addObject(obj, obj.layerId);

    const page = getActivePage(ed.getState());
    const stored = page.objects[obj.id];
    expect(stored).toBeDefined();
    expect(isObjectKind(stored!, "shape") && stored.shape === "path").toBe(true);
    // Normalized: tight local bounds at (0,0), placed at the page position.
    expect(stored!.localBounds.x).toBe(0);
    expect(stored!.localBounds.y).toBe(0);
    expect(stored!.transform.e).toBeCloseTo(100);

    // One undo removes it; redo restores it.
    ed.undo();
    expect(getActivePage(ed.getState()).objects[obj.id]).toBeUndefined();
    ed.redo();
    expect(getActivePage(ed.getState()).objects[obj.id]).toBeDefined();
  });

  it("round-trips the created path through serialization v6", () => {
    const ed = createEditorInstance();
    const committed = buildCurvedPath();
    const layerId = getActivePage(ed.getState()).layerStack.layers.at(-1)!.id;
    const obj = createShapeObject(committed.position, layerId, "path", {
      pathData: committed.pathData,
      localBounds: committed.localBounds,
    });
    ed.addObject(obj, obj.layerId);

    const data = ed.serialize();
    const ed2 = createEditorInstance();
    ed2.deserialize(data);

    const restored = getActivePage(ed2.getState()).objects[obj.id];
    expect(restored).toBeDefined();
    if (!isObjectKind(restored!, "shape")) throw new Error("expected shape");
    expect(restored.shape).toBe("path");
    expect(restored.pathData).toBe(committed.pathData);
    expect(restored.localBounds).toEqual(committed.localBounds);
  });

  it("feeds the renderer/exporter the same canonical geometry it stored", () => {
    const committed = buildCurvedPath();
    const layerId = "layer-1";
    const obj = createShapeObject(committed.position, layerId, "path", {
      pathData: committed.pathData,
      localBounds: committed.localBounds,
    });
    // shapePathData is the single geometry source consumed by BOTH the SVG
    // renderer and the PDF exporter — for a path shape it must be exactly the
    // stored pathData (WYSIWYG by construction).
    expect(shapePathData(obj)).toBe(committed.pathData);
  });
});
