import { beforeEach, describe, expect, it } from "vitest";
import {
  IDENTITY_TRANSFORM,
  compose,
  makeBounds,
  makeRotate,
  makeTranslate,
  transformPoint,
} from "@/src/domain/editor/geometry";
import {
  addObjectToPage,
  createEditorState,
  getActivePage,
  getObject,
  worldBounds,
} from "@/src/domain/editor/document";
import { makeImage, makeRect, resetFactory } from "@/src/domain/editor/testFactories";
import { CommandHistory } from "../commands/CommandHistory";
import {
  flipObject,
  moveCommand,
  moveObject,
  oppositeHandle,
  resizeCommand,
  resizeObject,
  resizeSelection,
  rotateObject,
  type ResizeHandle,
} from "./TransformService";

describe("transform: move + rotate", () => {
  beforeEach(() => resetFactory());

  it("moveObject translates the transform", () => {
    const rect = makeRect(); // identity transform
    const moved = moveObject(rect, { x: 30, y: 40 });
    expect(moved.e).toBe(30);
    expect(moved.f).toBe(40);
  });

  it("rotateObject keeps the center fixed", () => {
    const rect = makeRect({ transform: makeTranslate(10, 10) }); // 80x60 at (10,10)
    const center = { x: 50, y: 40 }; // center of the placed rect
    const rotated = rotateObject(rect, center, Math.PI / 2);
    // The center maps to itself under rotation about itself.
    expect(transformPoint(rotated, { x: 40, y: 30 })).toEqual(center);
  });
});

describe("transform: resize (single object)", () => {
  beforeEach(() => resetFactory());

  it("SE handle doubles the box and keeps NW fixed (no rotation)", () => {
    const rect = makeRect(); // 80x60 at origin, identity transform
    const newT = resizeObject(rect, "se", { x: 160, y: 120 });
    // NW corner (local 0,0) stays at origin.
    expect(transformPoint(newT, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    // SE corner (local 80,60) lands on the drag target.
    expect(transformPoint(newT, { x: 80, y: 60 })).toEqual({ x: 160, y: 120 });
    expect(worldBounds({ ...rect, transform: newT })).toEqual({ x: 0, y: 0, width: 160, height: 120 });
  });

  it("E edge handle scales only x, keeps the left edge fixed", () => {
    const rect = makeRect(); // 80x60 at origin
    const newT = resizeObject(rect, "e", { x: 200, y: 30 });
    // Left edge (local x=0) stays at x=0; height unchanged.
    expect(transformPoint(newT, { x: 0, y: 0 }).x).toBe(0);
    expect(worldBounds({ ...rect, transform: newT }).width).toBe(200);
    expect(worldBounds({ ...rect, transform: newT }).height).toBe(60);
  });

  it("resize honors rotation: opposite stays fixed, dragged lands on target", () => {
    const rect = makeRect({ transform: makeRotate(Math.PI / 3) });
    const fixedWorld = transformPoint(rect.transform, { x: 0, y: 0 });
    const target = { x: 200, y: 150 };
    const newT = resizeObject(rect, "se", target);
    // Opposite (NW, local 0,0) unchanged.
    expect(transformPoint(newT, { x: 0, y: 0 })).toEqual(fixedWorld);
    // Dragged corner (SE, local 80,60) lands on target.
    const landed = transformPoint(newT, { x: 80, y: 60 });
    expect(landed.x).toBeCloseTo(target.x, 6);
    expect(landed.y).toBeCloseTo(target.y, 6);
  });

  it("resize enforces a min size (won't collapse through the anchor)", () => {
    const rect = makeRect(); // 80x60
    // Drag the SE handle past the NW anchor (negative width).
    const newT = resizeObject(rect, "se", { x: -100, y: -100 });
    const wb = worldBounds({ ...rect, transform: newT });
    // Width/height are clamped to the min (>= 1), not allowed to hit 0.
    expect(wb.width).toBeGreaterThanOrEqual(1);
    expect(wb.height).toBeGreaterThanOrEqual(1);
  });

  it("oppositeHandle pairs corners and edges", () => {
    expect(oppositeHandle("nw")).toBe("se");
    expect(oppositeHandle("se")).toBe("nw");
    expect(oppositeHandle("n")).toBe("s");
    expect(oppositeHandle("e")).toBe("w");
  });
});

describe("transform: resize with the aspect ratio locked", () => {
  beforeEach(() => resetFactory());

  /*
   * The defect: a corner drag scaled x and y independently, so an inserted photo
   * came out stretched. Locked resizes project the drag onto the handle's original
   * diagonal, so the ratio survives every drag direction — including the ones that
   * used to distort worst (dragging mostly sideways from a corner).
   */
  const ratio = (b: { width: number; height: number }) => b.width / b.height;

  it("keeps a 200x100 image's 2:1 ratio through a lopsided corner drag", () => {
    const img = makeImage(); // 200x100, identity transform
    const free = worldBounds({ ...img, transform: resizeObject(img, "se", { x: 400, y: 110 }) });
    const locked = worldBounds({ ...img, transform: resizeObject(img, "se", { x: 400, y: 110 }, 1, true) });
    // Free scaling distorts: nearly twice as wide, barely taller.
    expect(ratio(free)).toBeGreaterThan(3.5);
    expect(ratio(locked)).toBeCloseTo(2, 6);
  });

  it("keeps the anchor corner fixed, like the free resize does", () => {
    const img = makeImage();
    const newT = resizeObject(img, "se", { x: 400, y: 110 }, 1, true);
    expect(transformPoint(newT, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  it("puts the dragged corner on the pointer's projection onto the diagonal", () => {
    const img = makeImage(); // diagonal direction (200,100), |d|^2 = 50000
    // Drag to (400, 110): s = (400*200 + 110*100) / 50000 = 1.82.
    const wb = worldBounds({ ...img, transform: resizeObject(img, "se", { x: 400, y: 110 }, 1, true) });
    expect(wb.width).toBeCloseTo(364, 6);
    expect(wb.height).toBeCloseTo(182, 6);
  });

  it("scales BOTH axes from an edge handle when locked", () => {
    // An edge drag is the other way an image got stretched. The projection
    // degenerates to that edge's own scale and applies it to both axes.
    const img = makeImage();
    const wb = worldBounds({ ...img, transform: resizeObject(img, "e", { x: 300, y: 50 }, 1, true) });
    expect(wb.width).toBeCloseTo(300, 6);
    expect(wb.height).toBeCloseTo(150, 6);
    expect(ratio(wb)).toBeCloseTo(2, 6);
  });

  it("still honors rotation: the anchor holds and the ratio survives", () => {
    const img = makeImage({ transform: makeRotate(Math.PI / 5) });
    const fixedWorld = transformPoint(img.transform, { x: 200, y: 100 }); // SE anchor for a NW drag
    const newT = resizeObject(img, "nw", { x: -40, y: -30 }, 1, true);
    const landed = transformPoint(newT, { x: 200, y: 100 });
    expect(landed.x).toBeCloseTo(fixedWorld.x, 6);
    expect(landed.y).toBeCloseTo(fixedWorld.y, 6);
    // Local extents scaled by one factor, so the rendered ratio is unchanged.
    const w = transformPoint(newT, { x: 200, y: 0 });
    const nw = transformPoint(newT, { x: 0, y: 0 });
    const h = transformPoint(newT, { x: 0, y: 100 });
    const width = Math.hypot(w.x - nw.x, w.y - nw.y);
    const height = Math.hypot(h.x - nw.x, h.y - nw.y);
    expect(width / height).toBeCloseTo(2, 6);
  });

  it("mirrors rather than sticking when dragged past the anchor", () => {
    const img = makeImage();
    const newT = resizeObject(img, "se", { x: -300, y: -150 }, 1, true);
    const wb = worldBounds({ ...img, transform: newT });
    // A flip, not a collapse: real extent, and the box now sits above-left of it.
    expect(wb.width).toBeGreaterThan(100);
    expect(ratio(wb)).toBeCloseTo(2, 6);
    expect(wb.x).toBeLessThan(0);
  });

  it("enforces the min size on the TIGHTER axis, so neither collapses", () => {
    const img = makeImage(); // 200x100 — height is the tighter axis
    const wb = worldBounds({ ...img, transform: resizeObject(img, "se", { x: 0.2, y: 0.1 }, 1, true) });
    expect(wb.height).toBeGreaterThanOrEqual(1);
    expect(wb.width).toBeGreaterThanOrEqual(2);
    expect(ratio(wb)).toBeCloseTo(2, 6);
  });

  it("is unchanged from the free path when the object is already square", () => {
    const square = makeImage({ localBounds: makeBounds(0, 0, 100, 100), naturalWidth: 100, naturalHeight: 100 });
    const locked = worldBounds({ ...square, transform: resizeObject(square, "se", { x: 250, y: 250 }, 1, true) });
    const free = worldBounds({ ...square, transform: resizeObject(square, "se", { x: 250, y: 250 }) });
    expect(locked).toEqual(free);
  });
});

describe("transform: resize selection (multi-object)", () => {
  beforeEach(() => resetFactory());

  it("scales every object about the anchor corner", () => {
    const r1 = makeRect({ transform: makeTranslate(0, 0) }); // 80x60 at (0,0)
    const r2 = makeRect({ transform: makeTranslate(100, 0) }); // 80x60 at (100,0)
    const selectionBounds = { x: 0, y: 0, width: 180, height: 60 };
    // Drag the SE handle so the box doubles: new opposite corner at (360,120).
    const after = resizeSelection([r1, r2], selectionBounds, "se", { x: 360, y: 120 });
    // r1's top-left (local 0,0) was at (0,0); scaled 2× about the NW anchor (0,0) → still (0,0).
    expect(transformPoint(after[r1.id], { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    // r2's top-left was at (100,0); scaled 2× about (0,0) → (200,0).
    expect(transformPoint(after[r2.id], { x: 0, y: 0 })).toEqual({ x: 200, y: 0 });
  });
});

describe("transform: flip", () => {
  beforeEach(() => resetFactory());

  it("flipObject mirrors about the object's center", () => {
    const rect = makeRect({ transform: makeTranslate(100, 100) }); // 80x60 at (100,100)
    const flipped = flipObject(rect, "x");
    // A flip about x negates the local x axis about the center; the center stays.
    const center = transformPoint(rect.transform, { x: 40, y: 30 });
    expect(transformPoint(flipped, { x: 40, y: 30 })).toEqual(center);
  });
});

describe("transform: command builders + history", () => {
  beforeEach(() => resetFactory());

  it("moveCommand produces an undoable, coalesceable move", () => {
    let state = createEditorState();
    let page = getActivePage(state);
    const rect = makeRect();
    page = addObjectToPage(page, rect);
    state = { ...state, document: { ...state.document, pages: [page] } };

    const history = new CommandHistory();
    const key = "drag-" + rect.id;
    const c1 = moveCommand(state, [rect.id], { x: 10, y: 0 }, key);
    state = history.execute(c1, state);
    const c2 = moveCommand(state, [rect.id], { x: 20, y: 0 }, key);
    state = history.execute(c2, state);
    expect(history.undoDepth).toBe(1); // coalesced
    state = history.undo(state);
    expect(getObject(getActivePage(state), rect.id)?.transform.e).toBe(0);
  });

  it("resizeCommand builds a working resize command", () => {
    let state = createEditorState();
    let page = getActivePage(state);
    const rect = makeRect();
    page = addObjectToPage(page, rect);
    state = { ...state, document: { ...state.document, pages: [page] } };
    const cmd = resizeCommand(state, rect.id, "se" as ResizeHandle, { x: 160, y: 120 });
    const next = cmd.apply(state);
    expect(worldBounds(getObject(getActivePage(next), rect.id)!).width).toBe(160);
  });

  it("moveCommand with identity delta yields the same transform", () => {
    let state = createEditorState();
    let page = getActivePage(state);
    const rect = makeRect({ transform: compose(makeTranslate(5, 7), IDENTITY_TRANSFORM) });
    page = addObjectToPage(page, rect);
    state = { ...state, document: { ...state.document, pages: [page] } };
    const cmd = moveCommand(state, [rect.id], { x: 0, y: 0 });
    const next = cmd.apply(state);
    expect(getObject(getActivePage(next), rect.id)?.transform.e).toBe(5);
  });
});
