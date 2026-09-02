/**
 * Shape/Draw creation → persistence → export, end to end through the REAL
 * services.
 *
 * WHY THIS FILE EXISTS, separately from `SerializationService.test.ts` and
 * `PdfExportService.test.ts`. Those suites already round-trip shapes and
 * drawings, but they build their objects with hand-written test factories —
 * `makeRect()` is a 100×100 rectangle at a fixed position. That proves the
 * serializer handles A shape; it cannot prove the serializer handles the shape
 * the REPAIRED CANVAS ACTUALLY BUILDS, which is the thing that was broken.
 *
 * The distinction is not academic. The canvas defect was precisely that the
 * object it constructed did not match the gesture: `localBounds` came from the
 * factory's 120×120 default scaled by `dragExtent / 100`, so a 119×101 drag
 * committed a 143×121 object. A test using `makeRect()` would have stayed green
 * through the entire bug — and did.
 *
 * So this file constructs its objects the way `EditorCanvas.commitShape` does:
 * from `shapeCreation`'s pure geometry, with the drag rectangle passed straight
 * through as `localBounds`. Then it asserts that geometry is still intact after a
 * serialize/deserialize round trip and that the real exporter draws it. If the
 * canvas's construction ever drifts back toward a scaled default, the round-trip
 * numbers here move and this fails.
 */
import { describe, expect, it, beforeEach } from "vitest";

import {
  addObjectToPage,
  createEditorState,
  getActivePage,
} from "@/src/domain/editor/document";
import { createDrawing, createShapeObject } from "@/src/domain/editor/objectFactories";
import { resetFactory } from "@/src/domain/editor/testFactories";
import { makeBounds } from "@/src/domain/editor/geometry";
import type { DrawingObject, ShapeObject } from "@/src/domain/editor/objects";
import { SerializationService } from "@/src/application/editor/serialization/SerializationService";
import { PdfExportService } from "@/src/application/editor/export/PdfExportService";
import {
  defaultShapeSize,
  shapeClickBounds,
  shapeDragBounds,
} from "@/src/application/editor/tools/shapeCreation";

const A4 = { width: 595, height: 842 };

/**
 * Builds a shape exactly as `EditorCanvas.commitShape` does for a DRAG: the
 * normalized page rectangle becomes both the position and the local bounds, so
 * the object IS the box drawn and no scaling step exists.
 */
function shapeFromDrag(
  from: { x: number; y: number },
  to: { x: number; y: number },
): ShapeObject {
  const target = shapeDragBounds(from, to, A4);
  return createShapeObject({ x: target.x, y: target.y }, "layer-1", "rect", {
    localBounds: makeBounds(0, 0, target.width, target.height),
    name: "Rectangle",
  });
}

/** Builds a shape exactly as the canvas does for a plain CLICK. */
function shapeFromClick(at: { x: number; y: number }): ShapeObject {
  const target = shapeClickBounds(at, defaultShapeSize(A4), A4);
  return createShapeObject({ x: target.x, y: target.y }, "layer-1", "rect", {
    localBounds: makeBounds(0, 0, target.width, target.height),
    name: "Rectangle",
  });
}

/** Builds a drawing the way the canvas commits a finished freehand stroke. */
function drawingFromStroke(points: Array<{ x: number; y: number }>): DrawingObject {
  // `createDrawing` intentionally does NOT spread arbitrary overrides (opacity
  // among them), so object-level opacity is applied the way the Inspector
  // applies it: as a field on the constructed object.
  return {
    ...createDrawing({ x: 0, y: 0 }, "layer-1", points, {
      brush: "pen",
      style: {
        fill: null,
        stroke: { r: 0.2, g: 0.4, b: 0.9, a: 1 },
        strokeWidth: 3.5,
        cornerRadius: 0,
      },
    }),
    opacity: 0.8,
  };
}

function stateWith(objects: Array<ShapeObject | DrawingObject>) {
  const state = createEditorState();
  let page = getActivePage(state);
  for (const obj of objects) page = addObjectToPage(page, obj);
  return { ...state, document: { ...state.document, pages: [page] } };
}

describe("shape/draw creation → persistence", () => {
  beforeEach(() => resetFactory());

  it("round-trips a DRAGGED shape with the drag's exact geometry", () => {
    // The historical defect, in the numbers that were measured in the browser:
    // this 119×101 drag used to commit a 143×121 object (120 × 119/100).
    const shape = shapeFromDrag({ x: 80, y: 120 }, { x: 199, y: 221 });
    expect(shape.localBounds.width).toBe(119);
    expect(shape.localBounds.height).toBe(101);

    const svc = new SerializationService();
    const restored = svc.deserialize(JSON.parse(JSON.stringify(svc.serialize(stateWith([shape])))));
    const out = restored.document.pages[0].objects[shape.id] as ShapeObject;

    expect(out.kind).toBe("shape");
    expect(out.shape).toBe("rect");
    // Geometry survives byte-for-byte. Position is not a stored field: the
    // factory encodes it as the transform's TRANSLATION (makeTranslate -> e/f),
    // so that is where "where the user drew it" actually lives.
    expect(out.localBounds).toEqual(shape.localBounds);
    expect(out.transform.e).toBe(80);
    expect(out.transform.f).toBe(120);
    // Identity matrix: the object IS the drawn box, with no scaling step. The
    // old defect lived exactly here — a non-identity scale derived from a
    // factory default divided by a stale constant.
    expect(out.transform.a).toBe(1);
    expect(out.transform.d).toBe(1);
  });

  it("round-trips a shape dragged in ANY direction as the same normalized box", () => {
    // Dragging up-left must persist the same rectangle as dragging down-right.
    const downRight = shapeFromDrag({ x: 100, y: 100 }, { x: 260, y: 200 });
    const upLeft = shapeFromDrag({ x: 260, y: 200 }, { x: 100, y: 100 });
    const svc = new SerializationService();
    const restored = svc.deserialize(
      JSON.parse(JSON.stringify(svc.serialize(stateWith([downRight, upLeft])))),
    );
    const a = restored.document.pages[0].objects[downRight.id] as ShapeObject;
    const b = restored.document.pages[0].objects[upLeft.id] as ShapeObject;
    expect(a.localBounds).toEqual(b.localBounds);
    expect(a.transform.e).toBe(b.transform.e);
    expect(a.transform.f).toBe(b.transform.f);
  });

  it("round-trips a CLICK-placed shape at its default size, still on the page", () => {
    const shape = shapeFromClick({ x: 300, y: 400 });
    const svc = new SerializationService();
    const restored = svc.deserialize(JSON.parse(JSON.stringify(svc.serialize(stateWith([shape])))));
    const out = restored.document.pages[0].objects[shape.id] as ShapeObject;

    // A deliberate, legible default — not the accidental 120×120 side effect,
    // and emphatically not a 2×2 twitch artefact.
    expect(out.localBounds.width).toBeGreaterThanOrEqual(48);
    expect(out.localBounds.width).toBe(defaultShapeSize(A4));
    // Fully on the page after the round trip — the click clamp survives saving.
    expect(out.transform.e).toBeGreaterThanOrEqual(0);
    expect(out.transform.f).toBeGreaterThanOrEqual(0);
    expect(out.transform.e + out.localBounds.width).toBeLessThanOrEqual(A4.width);
    expect(out.transform.f + out.localBounds.height).toBeLessThanOrEqual(A4.height);
  });

  it("round-trips a drawn stroke's points, brush and real style settings", () => {
    const points = [
      { x: 10, y: 10 },
      { x: 30, y: 22 },
      { x: 55, y: 8 },
      { x: 80, y: 40 },
    ];
    const drawing = drawingFromStroke(points);
    const svc = new SerializationService();
    const restored = svc.deserialize(
      JSON.parse(JSON.stringify(svc.serialize(stateWith([drawing])))),
    );
    const out = restored.document.pages[0].objects[drawing.id] as DrawingObject;

    expect(out.kind).toBe("drawing");
    expect(out.points).toEqual(points);
    expect(out.brush).toBe("pen");
    // The settings the Inspector shows must be the settings that persist.
    expect(out.style.strokeWidth).toBe(3.5);
    expect(out.opacity).toBe(0.8);
    expect(out.style.stroke).toEqual({ r: 0.2, g: 0.4, b: 0.9, a: 1 });
    expect(out.localBounds.width).toBe(70);
    expect(out.localBounds.height).toBe(32);
  });

  it("survives TWO round trips unchanged (a reload of a reloaded file)", () => {
    const shape = shapeFromDrag({ x: 40, y: 60 }, { x: 200, y: 160 });
    const drawing = drawingFromStroke([
      { x: 5, y: 5 },
      { x: 45, y: 25 },
    ]);
    const svc = new SerializationService();
    const once = svc.deserialize(
      JSON.parse(JSON.stringify(svc.serialize(stateWith([shape, drawing])))),
    );
    const twice = svc.deserialize(JSON.parse(JSON.stringify(svc.serialize(once))));
    const s2 = twice.document.pages[0].objects[shape.id] as ShapeObject;
    const d2 = twice.document.pages[0].objects[drawing.id] as DrawingObject;
    expect(s2.localBounds).toEqual(shape.localBounds);
    expect(s2.transform).toEqual(shape.transform);
    expect(d2.points).toEqual(drawing.points);
    expect(d2.style.strokeWidth).toBe(3.5);
    expect(d2.opacity).toBe(0.8);
  });
});

describe("shape/draw creation → PDF export", () => {
  beforeEach(() => resetFactory());

  // TIMEOUT, not slowness: the FIRST real `exportPdf` in a worker pays pdf-lib's
  // one-time module/font initialisation. Alone this test runs in ~460ms, but under
  // full-suite CPU contention that init pushed it past the 5s default and it
  // failed while the three later exports (which reuse the warm module) passed. The
  // budget is raised; every assertion is unchanged.
  it(
    "exports a canvas-created shape and drawing to a valid PDF",
    async () => {
      const shape = shapeFromDrag({ x: 80, y: 120 }, { x: 199, y: 221 });
      const drawing = drawingFromStroke([
        { x: 10, y: 10 },
        { x: 40, y: 30 },
        { x: 70, y: 12 },
      ]);
      const svc = new PdfExportService();
      const bytes = await svc.exportPdf(stateWith([shape, drawing]));
      expect(bytes.byteLength).toBeGreaterThan(500);
      // A real PDF, not an empty buffer with a hopeful length.
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    },
    30_000,
  );

  it("exports a shape whose geometry came from the drag, not a factory default", async () => {
    // The export path consumes `localBounds` × `transform`. Spying on the drawn
    // path proves the exporter received the DRAG's rectangle: if the canvas ever
    // reverts to scaling a 120×120 default, the emitted path changes size.
    const shape = shapeFromDrag({ x: 0, y: 0 }, { x: 119, y: 101 });
    const svc = new PdfExportService();
    const bytes = await svc.exportPdf(stateWith([shape]));
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    // The object handed to the exporter carries the drag's extent verbatim.
    expect(shape.localBounds.width).toBe(119);
    expect(shape.localBounds.height).toBe(101);
    expect(shape.transform.a).toBe(1);
    expect(shape.transform.d).toBe(1);
  });

  it("exports a click-placed shape (default size) without throwing", async () => {
    const svc = new PdfExportService();
    const bytes = await svc.exportPdf(stateWith([shapeFromClick({ x: 297, y: 421 })]));
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("exports a drawing carrying its real brush settings", async () => {
    const drawing = drawingFromStroke([
      { x: 0, y: 0 },
      { x: 25, y: 18 },
      { x: 60, y: 4 },
    ]);
    expect(drawing.style.strokeWidth).toBe(3.5);
    const svc = new PdfExportService();
    const bytes = await svc.exportPdf(stateWith([drawing]));
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });
});
