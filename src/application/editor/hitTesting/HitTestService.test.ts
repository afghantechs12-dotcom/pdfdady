import { beforeEach, describe, expect, it } from "vitest";
import { makeBounds, makeTranslate, type Bounds } from "@/src/domain/editor/geometry";
import {
  addObjectToPage,
  createEditorState,
  getActivePage,
  type EditorObject,
  type EditorPage,
} from "@/src/domain/editor/document";
import { makeRect, makeTextObject, resetFactory } from "@/src/domain/editor/testFactories";
import { HitTestService } from "./HitTestService";

describe("HitTestService", () => {
  let svc: HitTestService;

  beforeEach(() => {
    resetFactory();
    svc = new HitTestService();
  });

  /** Builds a page with the given objects added in order (bottom-first). */
  const pageWith = (...objs: EditorObject[]): EditorPage => {
    let page = getActivePage(createEditorState());
    for (const obj of objs) page = addObjectToPage(page, obj);
    return page;
  };

  describe("hitTestPoint", () => {
    it("returns the topmost of two overlapping rects", () => {
      const bottom = makeRect(); // obj-1, bottom
      const top = makeRect(); // obj-2, added later → on top
      const page = pageWith(bottom, top);
      // Both occupy (0,0,80,60); a point inside both hits the topmost.
      expect(svc.hitTestPoint(page, { x: 10, y: 10 })).toBe(top.id);
    });

    it("returns null when the point is outside every object", () => {
      const page = pageWith(makeRect());
      expect(svc.hitTestPoint(page, { x: 1000, y: 1000 })).toBeNull();
    });

    it("skips hidden objects by default and honors includeHidden", () => {
      const visible = makeRect(); // obj-1, bottom
      const hidden = makeRect({ visible: false }); // obj-2, top but hidden
      const page = pageWith(visible, hidden);
      // Default skips the hidden top object → hits the visible bottom one.
      expect(svc.hitTestPoint(page, { x: 10, y: 10 })).toBe(visible.id);
      // includeHidden lets the hidden top object win.
      expect(svc.hitTestPoint(page, { x: 10, y: 10 }, { includeHidden: true })).toBe(hidden.id);
    });

    it("skips locked objects by default and honors includeLocked", () => {
      const unlocked = makeRect(); // obj-1, bottom
      const locked = makeRect({ locked: true }); // obj-2, top but locked
      const page = pageWith(unlocked, locked);
      expect(svc.hitTestPoint(page, { x: 10, y: 10 })).toBe(unlocked.id);
      expect(svc.hitTestPoint(page, { x: 10, y: 10 }, { includeLocked: true })).toBe(locked.id);
    });

    it("tolerance lets a point just outside a thin object hit it", () => {
      const thin = makeRect({ localBounds: makeBounds(0, 0, 80, 2) });
      const page = pageWith(thin);
      // World bounds y range is [0, 2); (40, 4) is just outside without tolerance.
      expect(svc.hitTestPoint(page, { x: 40, y: 4 })).toBeNull();
      // A 3px tolerance expands the box to y range [-3, 5), so (40, 4) hits.
      expect(svc.hitTestPoint(page, { x: 40, y: 4 }, { tolerance: 3 })).toBe(thin.id);
    });
  });

  describe("hitTestMarquee", () => {
    it("returns every intersecting id in paint order (bottom-first)", () => {
      const r1 = makeRect(); // obj-1, bottom, at (0,0)
      const r2 = makeRect({ transform: makeTranslate(40, 0) }); // obj-2, top, overlaps r1
      const page = pageWith(r1, r2);
      const marquee: Bounds = makeBounds(0, 0, 100, 60); // covers both
      expect(svc.hitTestMarquee(page, marquee)).toEqual([r1.id, r2.id]);
    });

    it("returns only the ids whose world bounds intersect the marquee", () => {
      const inside = makeRect();
      const outside = makeRect({ transform: makeTranslate(500, 500) });
      const page = pageWith(inside, outside);
      const marquee: Bounds = makeBounds(0, 0, 100, 60);
      expect(svc.hitTestMarquee(page, marquee)).toEqual([inside.id]);
    });

    it("skips hidden and locked objects by default", () => {
      const visible = makeRect();
      const hidden = makeRect({ visible: false });
      const locked = makeRect({ locked: true });
      const page = pageWith(visible, hidden, locked);
      const marquee: Bounds = makeBounds(0, 0, 80, 60);
      expect(svc.hitTestMarquee(page, marquee)).toEqual([visible.id]);
    });

    it("honors includeHidden and includeLocked", () => {
      const visible = makeRect();
      const hidden = makeRect({ visible: false });
      const locked = makeRect({ locked: true });
      const page = pageWith(visible, hidden, locked);
      const marquee: Bounds = makeBounds(0, 0, 80, 60);
      expect(
        svc.hitTestMarquee(page, marquee, { includeHidden: true, includeLocked: true }),
      ).toEqual([visible.id, hidden.id, locked.id]);
    });

    it("returns [] for an empty area", () => {
      const page = pageWith(makeRect());
      const marquee: Bounds = makeBounds(1000, 1000, 10, 10);
      expect(svc.hitTestMarquee(page, marquee)).toEqual([]);
    });

    it("selects a mix of shape and text objects", () => {
      const rect = makeRect();
      const text = makeTextObject(); // default translate (10,20), 100x20
      const page = pageWith(rect, text);
      const marquee: Bounds = makeBounds(0, 0, 100, 60);
      expect(svc.hitTestMarquee(page, marquee)).toEqual([rect.id, text.id]);
    });
  });
});
