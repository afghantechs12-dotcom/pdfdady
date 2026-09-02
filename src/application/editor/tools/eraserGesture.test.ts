import { describe, expect, it } from "vitest";
import { createEditorInstance } from "@/lib/editor/createEditorInstance";
import { RemoveObjectsCommand } from "@/src/application/editor/commands/commands";
import { topmostErasableAt } from "@/src/application/editor/tools/eraserHitTest";
import { getActivePage, pageObjects } from "@/src/domain/editor/document";
import { makeDrawing, makeRect } from "@/src/domain/editor/testFactories";

/**
 * Eraser gesture integration (M6.9): the canvas erases through the command +
 * transaction architecture — one drag = one history transaction of
 * RemoveObjectsCommands. These tests drive the same service calls the canvas
 * makes, so undo/redo, grouping, and rollback are covered without a DOM.
 */

/** Simulates the canvas's erase drag over a series of page points. */
function eraseDrag(
  service: ReturnType<typeof createEditorInstance>,
  points: Array<{ x: number; y: number }>,
  radius = 8,
): { erased: string[]; began: boolean } {
  const erased = new Set<string>();
  let began = false;
  for (const p of points) {
    const page = getActivePage(service.getState());
    const id = topmostErasableAt(pageObjects(page), p, radius, erased);
    if (!id) continue;
    const obj = page.objects[id];
    if (!obj) continue;
    if (!began) {
      service.beginTransaction("Erase");
      began = true;
    }
    service.execute(new RemoveObjectsCommand("Erase", [obj]));
    erased.add(id);
  }
  if (began) service.commit();
  return { erased: [...erased], began };
}

describe("eraser gesture through the command architecture", () => {
  it("erases two objects in one drag as ONE undo entry, restored together", () => {
    const ed = createEditorInstance();
    const a = makeRect({ id: "a" }); // 0,0 80x60
    const b = makeRect({ id: "b", transform: { a: 1, b: 0, c: 0, d: 1, e: 200, f: 0 } });
    ed.addObject(a, a.layerId);
    ed.addObject(b, b.layerId);

    const drag = eraseDrag(ed, [
      { x: 10, y: 10 },
      { x: 210, y: 10 },
    ]);
    expect(drag.erased.sort()).toEqual(["a", "b"]);
    expect(Object.keys(getActivePage(ed.getState()).objects)).toHaveLength(0);

    // One undo restores BOTH (transaction grouping)…
    ed.undo();
    expect(Object.keys(getActivePage(ed.getState()).objects).sort()).toEqual(["a", "b"]);
    // …and redo removes both again.
    ed.redo();
    expect(Object.keys(getActivePage(ed.getState()).objects)).toHaveLength(0);
  });

  it("does not open a transaction (no history entry) over empty space", () => {
    const ed = createEditorInstance();
    const before = ed.undoDepth;
    const drag = eraseDrag(ed, [{ x: 400, y: 400 }]);
    expect(drag.began).toBe(false);
    expect(ed.undoDepth).toBe(before);
  });

  it("never erases the same object twice in one gesture", () => {
    const ed = createEditorInstance();
    const a = makeRect({ id: "a" });
    ed.addObject(a, a.layerId);
    // Two samples over the same object: the second must be suppressed
    // (the object is gone from state anyway, but the exclude set guarantees
    // no duplicate RemoveObjectsCommand even within one event batch).
    const drag = eraseDrag(ed, [
      { x: 10, y: 10 },
      { x: 12, y: 12 },
    ]);
    expect(drag.erased).toEqual(["a"]);
  });

  it("skips locked and hidden objects entirely", () => {
    const ed = createEditorInstance();
    const locked = makeRect({ id: "locked", locked: true });
    const hidden = makeDrawing({ id: "hidden", visible: false });
    ed.addObject(locked, locked.layerId);
    ed.addObject(hidden, hidden.layerId);
    const drag = eraseDrag(ed, [{ x: 10, y: 10 }, { x: 25, y: 25 }]);
    expect(drag.began).toBe(false);
    expect(Object.keys(getActivePage(ed.getState()).objects).sort()).toEqual(["hidden", "locked"]);
  });

  it("rollback (Escape cancel) restores everything erased mid-gesture", () => {
    const ed = createEditorInstance();
    const a = makeRect({ id: "a" });
    ed.addObject(a, a.layerId);
    const depthBefore = ed.undoDepth;

    ed.beginTransaction("Erase");
    ed.execute(new RemoveObjectsCommand("Erase", [a]));
    expect(Object.keys(getActivePage(ed.getState()).objects)).toHaveLength(0);
    ed.rollback();

    expect(Object.keys(getActivePage(ed.getState()).objects)).toEqual(["a"]);
    expect(ed.undoDepth).toBe(depthBefore); // no history entry from a cancel
  });
});
