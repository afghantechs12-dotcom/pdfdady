import { describe, expect, it } from "vitest";
import type { Point } from "@/src/domain/editor/geometry";
import { transformPoint } from "@/src/domain/editor/geometry";
import { pdfLibToPage, screenToPage, type Viewport } from "./CoordinateSpace";
import {
  pageRotationScreenTransform,
  pageRotationTransform,
  rotatePagePoint,
  rotatedPageSize,
  toMatrixString,
  unrotatePagePoint,
  type PageRotationDegrees,
} from "./PageRotation";

const ROTATIONS: PageRotationDegrees[] = [0, 90, 180, 270];
const W = 595;
const H = 842;

describe("rotatedPageSize", () => {
  it("keeps the size at 0 and 180", () => {
    expect(rotatedPageSize(0, { width: W, height: H })).toEqual({ width: W, height: H });
    expect(rotatedPageSize(180, { width: W, height: H })).toEqual({ width: W, height: H });
  });

  it("swaps width/height at 90 and 270", () => {
    expect(rotatedPageSize(90, { width: W, height: H })).toEqual({ width: H, height: W });
    expect(rotatedPageSize(270, { width: W, height: H })).toEqual({ width: H, height: W });
  });
});

describe("rotatePagePoint / unrotatePagePoint", () => {
  it("maps the page corners to the rotated extent's corners (clockwise)", () => {
    // At 90° clockwise the page's top-left corner becomes the display's
    // top-RIGHT corner (the displayed extent is H wide).
    expect(rotatePagePoint(90, W, H, { x: 0, y: 0 })).toEqual({ x: H, y: 0 });
    expect(rotatePagePoint(90, W, H, { x: W, y: 0 })).toEqual({ x: H, y: W });
    expect(rotatePagePoint(90, W, H, { x: W, y: H })).toEqual({ x: 0, y: W });
    expect(rotatePagePoint(90, W, H, { x: 0, y: H })).toEqual({ x: 0, y: 0 });
    // 180° sends top-left to bottom-right.
    expect(rotatePagePoint(180, W, H, { x: 0, y: 0 })).toEqual({ x: W, y: H });
    // 270° (counter-clockwise on screen) sends top-left to bottom-left.
    expect(rotatePagePoint(270, W, H, { x: 0, y: 0 })).toEqual({ x: 0, y: W });
  });

  it("rotated points stay inside the rotated extent", () => {
    const samples: Point[] = [
      { x: 0, y: 0 },
      { x: W, y: H },
      { x: 12.5, y: 640 },
      { x: W / 2, y: H / 2 },
    ];
    for (const rotation of ROTATIONS) {
      const ext = rotatedPageSize(rotation, { width: W, height: H });
      for (const p of samples) {
        const r = rotatePagePoint(rotation, W, H, p);
        expect(r.x).toBeGreaterThanOrEqual(-1e-9);
        expect(r.x).toBeLessThanOrEqual(ext.width + 1e-9);
        expect(r.y).toBeGreaterThanOrEqual(-1e-9);
        expect(r.y).toBeLessThanOrEqual(ext.height + 1e-9);
      }
    }
  });

  it("unrotatePagePoint is the exact inverse for every rotation", () => {
    const samples: Point[] = [
      { x: 0, y: 0 },
      { x: W, y: H },
      { x: 100.25, y: 33.75 },
      { x: 594, y: 1 },
    ];
    for (const rotation of ROTATIONS) {
      for (const p of samples) {
        expect(unrotatePagePoint(rotation, W, H, rotatePagePoint(rotation, W, H, p))).toEqual(p);
        expect(rotatePagePoint(rotation, W, H, unrotatePagePoint(rotation, W, H, p))).toEqual(p);
      }
    }
  });

  it("pageRotationTransform agrees with the closed-form rotatePagePoint", () => {
    const samples: Point[] = [
      { x: 0, y: 0 },
      { x: W, y: 0 },
      { x: W, y: H },
      { x: 77.5, y: 300 },
    ];
    for (const rotation of ROTATIONS) {
      const t = pageRotationTransform(rotation, W, H);
      for (const p of samples) {
        const viaMatrix = transformPoint(t, p);
        const closed = rotatePagePoint(rotation, W, H, p);
        expect(viaMatrix.x).toBeCloseTo(closed.x, 9);
        expect(viaMatrix.y).toBeCloseTo(closed.y, 9);
      }
    }
  });
});

describe("screen/export agreement (PDF /Rotate semantics)", () => {
  /**
   * A PDF viewer displays a /Rotate=r page rotated r degrees CLOCKWISE — the
   * exact behavior export produces via `page.setRotation(degrees(rotation))`.
   * For a w×h page, a PDF user-space point (xu, yu) (bottom-left origin, +y up)
   * therefore displays (top-left origin, +y down) at:
   *   r=0:   (xu, h − yu)
   *   r=90:  (yu, xu)
   *   r=180: (w − xu, yu)
   *   r=270: (h − yu, w − xu)
   * The canvas shows an editor page point p = pdfLibToPage(u) at
   * rotatePagePoint(r, w, h, p) — which must equal the viewer's display point
   * for screen and export to agree.
   */
  function pdfDisplayPoint(rotation: PageRotationDegrees, u: Point): Point {
    switch (rotation) {
      case 90:
        return { x: u.y, y: u.x };
      case 180:
        return { x: W - u.x, y: u.y };
      case 270:
        return { x: H - u.y, y: W - u.x };
      default:
        return { x: u.x, y: H - u.y };
    }
  }

  it("rotatePagePoint reproduces the PDF viewer's display position for every rotation", () => {
    const userSpacePoints: Point[] = [
      { x: 0, y: 0 }, // pdf bottom-left
      { x: W, y: H }, // pdf top-right
      { x: 72, y: 720 }, // a typical text position
      { x: W / 2, y: H / 2 },
    ];
    for (const rotation of ROTATIONS) {
      for (const u of userSpacePoints) {
        const editorPoint = pdfLibToPage(u, H);
        const shown = rotatePagePoint(rotation, W, H, editorPoint);
        const expected = pdfDisplayPoint(rotation, u);
        expect(shown.x).toBeCloseTo(expected.x, 9);
        expect(shown.y).toBeCloseTo(expected.y, 9);
      }
    }
  });
});

describe("pageRotationScreenTransform", () => {
  it("rotates content positioned with page*zoom+origin onto rotate(page)*zoom+origin", () => {
    const viewports: Viewport[] = [
      { zoom: 1, pan: { x: 0, y: 0 } },
      { zoom: 2, pan: { x: 48, y: 30 } },
      { zoom: 0.5, pan: { x: -10, y: 90 } },
    ];
    const samples: Point[] = [
      { x: 0, y: 0 },
      { x: W, y: H },
      { x: 123.5, y: 456.25 },
    ];
    for (const rotation of ROTATIONS) {
      for (const viewport of viewports) {
        const origin = viewport.pan;
        const g = pageRotationScreenTransform(rotation, W, H, viewport, origin);
        for (const p of samples) {
          // Where the unrotated render code puts the point on screen…
          const unrotatedScreen = {
            x: p.x * viewport.zoom + origin.x,
            y: p.y * viewport.zoom + origin.y,
          };
          // …the group transform must carry it to the rotated position.
          const rotated = rotatePagePoint(rotation, W, H, p);
          const expected = {
            x: rotated.x * viewport.zoom + origin.x,
            y: rotated.y * viewport.zoom + origin.y,
          };
          const actual = transformPoint(g, unrotatedScreen);
          expect(actual.x).toBeCloseTo(expected.x, 6);
          expect(actual.y).toBeCloseTo(expected.y, 6);
        }
      }
    }
  });

  it("is the identity at rotation 0", () => {
    const g = pageRotationScreenTransform(0, W, H, { zoom: 2, pan: { x: 5, y: 7 } }, { x: 5, y: 7 });
    expect(g.a).toBeCloseTo(1, 9);
    expect(g.b).toBeCloseTo(0, 9);
    expect(g.c).toBeCloseTo(0, 9);
    expect(g.d).toBeCloseTo(1, 9);
    expect(g.e).toBeCloseTo(0, 9);
    expect(g.f).toBeCloseTo(0, 9);
  });

  it("pointer input inverts the display mapping (screen → unrotated page)", () => {
    // The canvas maps a pointer with screenToPage (giving DISPLAY page coords)
    // then unrotatePagePoint — verify the round trip ends on the object-space
    // point whose rotated render position is under the cursor.
    const viewport: Viewport = { zoom: 1.5, pan: { x: 40, y: 20 } };
    const origin = viewport.pan;
    for (const rotation of ROTATIONS) {
      const pagePoint: Point = { x: 210, y: 512 };
      const shown = rotatePagePoint(rotation, W, H, pagePoint);
      const screen = { x: shown.x * viewport.zoom + origin.x, y: shown.y * viewport.zoom + origin.y };
      const displayPoint = screenToPage(viewport, origin, screen);
      const recovered = unrotatePagePoint(rotation, W, H, displayPoint);
      expect(recovered.x).toBeCloseTo(pagePoint.x, 9);
      expect(recovered.y).toBeCloseTo(pagePoint.y, 9);
    }
  });
});

describe("toMatrixString", () => {
  it("serializes in SVG/CSS matrix() coefficient order", () => {
    expect(toMatrixString({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 })).toBe("matrix(1,2,3,4,5,6)");
  });
});
