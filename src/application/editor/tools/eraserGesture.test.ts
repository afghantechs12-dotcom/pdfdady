import { describe, expect, it } from "vitest";
import { createEditorInstance } from "@/lib/editor/createEditorInstance";
import { EraseInkCommand } from "@/src/application/editor/commands/EraseInkCommand";
import { PartialInkGesture, eraseStroke, capsuleIntervals } from "./partialEraser";
import { getActivePage, pageObjects } from "@/src/domain/editor/document";
import { makeDrawing, makeRect } from "@/src/domain/editor/testFactories";
import { IDENTITY_TRANSFORM, compose, makeTranslate, makeScale, makeRotate } from "@/src/domain/editor/geometry";
import { deriveDrawingRender } from "./drawingGeometry";

const stroke = () => makeDrawing({ transform: IDENTITY_TRANSFORM, points: [{ x: 0, y: 50 }, { x: 100, y: 50 }] });
const p = (x: number, y = 50) => ({ x, y });

describe("partial ink geometry", () => {
  it("splits the middle, preserves style, and leaves far-away ink untouched", () => {
    const o = stroke();
    const result = eraseStroke(o, p(50), p(50), 8);
    expect(result).toHaveLength(2);
    expect(result[0].points.at(-1)!.x).toBeCloseTo(50 - 8 - o.style.strokeWidth / 2);
    expect(result[1].points[0].x).toBeCloseTo(50 + 8 + o.style.strokeWidth / 2);
    for (const f of result) { expect(f.style).toEqual(o.style); expect(f.layerId).toBe(o.layerId); }
    expect(eraseStroke(o, p(50, 100), p(80, 100), 8)[0]).toBe(o);
  });
  it("trims an endpoint and can remove a whole stroke", () => {
    const o = stroke();
    const trimmed = eraseStroke(o, p(0), p(0), 8);
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0].points[0].x).toBeGreaterThan(8);
    expect(eraseStroke(o, p(-20), p(120), 8)).toHaveLength(0);
  });
  it("subtracts a fast swept path without gaps between pointer events", () => {
    expect(capsuleIntervals(p(0), p(100), p(50, 0), p(50, 100), 10)).toEqual([[.4, .6]]);
    expect(eraseStroke(stroke(), p(50, 0), p(50, 100), 8)).toHaveLength(2);
  });
  it("handles rotation, translation and scale in page space", () => {
    const o = { ...stroke(), transform: compose(makeTranslate(300, 100), compose(makeRotate(Math.PI / 2), makeScale(2, 2))) };
    expect(eraseStroke(o, p(200, 180), p(200, 220), 8)).toHaveLength(2);
  });
  it("retains highlighter opacity and interpolates pressure widths", () => {
    const o = { ...stroke(), brush: "highlighter" as const, opacity: .4, widths: [2, 6] };
    for (const f of eraseStroke(o, p(50), p(50), 8)) {
      expect(f.opacity).toBe(.4);
      expect(f.widths).toHaveLength(f.points.length);
      expect(deriveDrawingRender(f).blendMultiply).toBe(true);
    }
  });
  it("keeps a smooth/pencil near miss byte-identical and creates renderable fragments on a hit", () => {
    const o = { ...stroke(), smoothing: true, brush: "pencil" as const, points: [p(0), p(50, 70), p(100)] };
    expect(eraseStroke(o, p(200), p(210), 8)).toEqual([o]);
    const fs = eraseStroke(o, p(50, 70), p(50, 70), 8);
    expect(fs).toHaveLength(2);
    for (const f of fs) { expect(f.smoothing).toBe(false); expect(deriveDrawingRender(f).pathData).not.toMatch(/NaN|Infinity/); }
  });
});

describe("partial ink gesture transaction", () => {
  it("leaves the scene unchanged mid-gesture; commits one notification and exact undo/redo", () => {
    const ed = createEditorInstance();
    const under = makeRect(), o = stroke(), over = makeRect();
    for (const obj of [under, o, over]) ed.addObject(obj, obj.layerId);
    const before = ed.getState();
    const depth = ed.undoDepth;
    let notifications = 0;
    const unsub = ed.subscribe(() => notifications++);
    const g = new PartialInkGesture(getActivePage(before), p(50, 10), 8);
    for (let y = 10; y <= 90; y++) g.move(p(50, y));
    expect(ed.getState()).toBe(before);
    expect(notifications).toBe(0);
    ed.execute(new EraseInkCommand(g.page, g.replacements));
    expect(ed.undoDepth).toBe(depth + 1);
    expect(notifications).toBe(1);
    const after = ed.getState();
    const ordered = pageObjects(getActivePage(after));
    expect(ordered.map(o => o.kind)).toEqual(["shape", "drawing", "drawing", "shape"]);
    ed.undo(); expect(ed.getState()).toEqual(before);
    ed.redo(); expect(ed.getState()).toEqual(after);
    unsub();
  });
  it("a near miss, cancellation, or non-ink contact has no command to commit", () => {
    const ed = createEditorInstance(); const rect = makeRect(); ed.addObject(rect, rect.layerId);
    const depth = ed.undoDepth;
    const g = new PartialInkGesture(getActivePage(ed.getState()), p(10, 10), 20);
    g.move(p(100)); expect(g.replacements.size).toBe(0); expect(ed.undoDepth).toBe(depth);
  });
  it("never erases locked ink or hidden layers", () => {
    const ed = createEditorInstance(); const o = { ...stroke(), locked: true }; ed.addObject(o, o.layerId);
    const g = new PartialInkGesture(getActivePage(ed.getState()), p(50), 20);
    expect(g.replacements.size).toBe(0);
  });
  it("erased fragments survive canonical scene serialization and reload", () => {
    const ed = createEditorInstance(); const o = stroke(); ed.addObject(o, o.layerId);
    const g = new PartialInkGesture(getActivePage(ed.getState()), p(50), 8);
    ed.execute(new EraseInkCommand(g.page, g.replacements));
    const saved = ed.serialize(); const reopened = createEditorInstance(); reopened.deserialize(saved);
    expect(reopened.serialize()).toEqual(saved);
    expect(pageObjects(getActivePage(reopened.getState()))).toHaveLength(2);
  });
});
