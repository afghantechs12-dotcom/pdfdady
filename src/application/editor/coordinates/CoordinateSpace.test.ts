import { describe, expect, it } from "vitest";
import type { Point } from "@/src/domain/editor/geometry";
import { IDENTITY_TRANSFORM, makeTranslate } from "@/src/domain/editor/geometry";
import {
  type PageScreenOrigin,
  type Viewport,
  pdfLibToPage,
  objectToSvgMatrix,
  pageToPdfLib,
  pageToScreen,
  screenToPage,
  screenToPageDelta,
} from "./CoordinateSpace";
import {
  rotatePagePoint,
  unrotatePagePoint,
  type PageRotationDegrees,
} from "./PageRotation";

describe("CoordinateSpace", () => {
  describe("screenToPage / pageToScreen", () => {
    const zooms = [0.5, 1, 2];
    const origins: PageScreenOrigin[] = [
      { x: 0, y: 0 },
      { x: 100, y: 50 },
      { x: -20, y: 30 },
    ];

    it("screenToPage is the inverse of pageToScreen (page round-trip)", () => {
      for (const zoom of zooms) {
        for (const origin of origins) {
          const viewport: Viewport = { zoom, pan: origin };
          const page: Point = { x: 123.5, y: -67.25 };
          const rt = screenToPage(viewport, origin, pageToScreen(viewport, origin, page));
          expect(rt.x).toBeCloseTo(page.x, 10);
          expect(rt.y).toBeCloseTo(page.y, 10);
        }
      }
    });

    it("pageToScreen is the inverse of screenToPage (screen round-trip)", () => {
      for (const zoom of zooms) {
        for (const origin of origins) {
          const viewport: Viewport = { zoom, pan: origin };
          const screen: Point = { x: 400, y: 250 };
          const rt = pageToScreen(viewport, origin, screenToPage(viewport, origin, screen));
          expect(rt.x).toBeCloseTo(screen.x, 10);
          expect(rt.y).toBeCloseTo(screen.y, 10);
        }
      }
    });

    it("pageToScreen applies page * zoom + origin", () => {
      const viewport: Viewport = { zoom: 2, pan: { x: 100, y: 50 } };
      const origin: PageScreenOrigin = { x: 100, y: 50 };
      expect(pageToScreen(viewport, origin, { x: 10, y: 20 })).toEqual({ x: 120, y: 90 });
    });

    it("screenToPage applies (screen - origin) / zoom", () => {
      const viewport: Viewport = { zoom: 2, pan: { x: 100, y: 50 } };
      const origin: PageScreenOrigin = { x: 100, y: 50 };
      expect(screenToPage(viewport, origin, { x: 120, y: 90 })).toEqual({ x: 10, y: 20 });
    });
  });

  describe("screenToPageDelta", () => {
    it("divides the delta by zoom and ignores pan", () => {
      const viewport: Viewport = { zoom: 2, pan: { x: 999, y: -999 } };
      expect(screenToPageDelta(viewport, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 });
    });

    it("divides by a fractional zoom", () => {
      const viewport: Viewport = { zoom: 0.5, pan: { x: 0, y: 0 } };
      expect(screenToPageDelta(viewport, { x: 10, y: 20 })).toEqual({ x: 20, y: 40 });
    });
  });

  describe("pageToPdfLib / pdfLibToPage", () => {
    it("flips y about the page height ((10,20) at height 842 → (10,822))", () => {
      expect(pageToPdfLib({ x: 10, y: 20 }, 842)).toEqual({ x: 10, y: 822 });
    });

    it("leaves x unchanged", () => {
      expect(pageToPdfLib({ x: 333, y: 0 }, 842).x).toBe(333);
    });

    it("pdfLibToPage inverts the y flip ((10,822) → (10,20))", () => {
      expect(pdfLibToPage({ x: 10, y: 822 }, 842)).toEqual({ x: 10, y: 20 });
    });

    it("pageToPdfLib and pdfLibToPage round-trip", () => {
      const p: Point = { x: 55, y: 210 };
      expect(pdfLibToPage(pageToPdfLib(p, 842), 842)).toEqual(p);
    });
  });

  describe("integration with page rotation (M6)", () => {
    it("screen → display page → unrotated page round-trips through the viewport for every rotation", () => {
      const w = 595;
      const h = 842;
      const rotations: PageRotationDegrees[] = [0, 90, 180, 270];
      const viewport: Viewport = { zoom: 2, pan: { x: 30, y: 40 } };
      const origin: PageScreenOrigin = viewport.pan;
      const pagePoint: Point = { x: 120.5, y: 333 };
      for (const rotation of rotations) {
        // Render side: unrotated page point → displayed point → screen.
        const displayed = rotatePagePoint(rotation, w, h, pagePoint);
        const screen = pageToScreen(viewport, origin, displayed);
        // Input side: screen → displayed point → unrotated page point.
        const back = unrotatePagePoint(rotation, w, h, screenToPage(viewport, origin, screen));
        expect(back.x).toBeCloseTo(pagePoint.x, 10);
        expect(back.y).toBeCloseTo(pagePoint.y, 10);
      }
    });
  });

  describe("objectToSvgMatrix", () => {
    it("identity transform at zoom 1, origin (0,0) is the identity matrix", () => {
      const viewport: Viewport = { zoom: 1, pan: { x: 0, y: 0 } };
      const origin: PageScreenOrigin = { x: 0, y: 0 };
      expect(objectToSvgMatrix({ transform: IDENTITY_TRANSFORM }, viewport, origin)).toBe(
        "matrix(1,0,0,1,0,0)",
      );
    });

    it("identity transform at zoom 2 doubles the scale components", () => {
      const viewport: Viewport = { zoom: 2, pan: { x: 0, y: 0 } };
      const origin: PageScreenOrigin = { x: 0, y: 0 };
      expect(objectToSvgMatrix({ transform: IDENTITY_TRANSFORM }, viewport, origin)).toBe(
        "matrix(2,0,0,2,0,0)",
      );
    });

    it("puts the object's translate in e/f at zoom 1, origin (0,0)", () => {
      const viewport: Viewport = { zoom: 1, pan: { x: 0, y: 0 } };
      const origin: PageScreenOrigin = { x: 0, y: 0 };
      expect(objectToSvgMatrix({ transform: makeTranslate(10, 20) }, viewport, origin)).toBe(
        "matrix(1,0,0,1,10,20)",
      );
    });

    it("scales the translate by zoom (translate 10,20 at zoom 2 → e=20,f=40)", () => {
      const viewport: Viewport = { zoom: 2, pan: { x: 0, y: 0 } };
      const origin: PageScreenOrigin = { x: 0, y: 0 };
      expect(objectToSvgMatrix({ transform: makeTranslate(10, 20) }, viewport, origin)).toBe(
        "matrix(2,0,0,2,20,40)",
      );
    });

    it("adds the page origin to e/f (identity at zoom 1, origin (100,50))", () => {
      const viewport: Viewport = { zoom: 1, pan: { x: 100, y: 50 } };
      const origin: PageScreenOrigin = { x: 100, y: 50 };
      expect(objectToSvgMatrix({ transform: IDENTITY_TRANSFORM }, viewport, origin)).toBe(
        "matrix(1,0,0,1,100,50)",
      );
    });
  });
});
