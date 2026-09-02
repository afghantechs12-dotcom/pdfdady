import { describe, expect, it } from "vitest";
import {
  DRAG_CORE_MIN,
  HANDLE_HIT,
  HANDLE_INWARD_MAX,
  HANDLE_SIZE,
  MID_HANDLE_MIN_EDGE,
  ROTATE_OFFSET,
  ROTATE_ROOM,
  dragCore,
  handleCursor,
  handleHitRect,
  handleInwardExtent,
  handleVisualSize,
  rotateCentreY,
  rotateSide,
  visibleHandles,
} from "@/components/editor/canvas/selectionChrome";
import type { ResizeHandle } from "@/src/application/editor/transform/TransformService";

/**
 * The regression suite for the selection chrome geometry.
 *
 * Every number asserted here traces to a Chrome measurement of the old overlay,
 * not to a preference:
 *
 *   - a 180×120pt shape at 25% zoom is a 45×30 SCREEN box, and that box produced
 *     12 overlapping pointer-target pairs and left 1 of 25 sampled interior points
 *     able to start a move;
 *   - the canvas `<svg>` computes `overflow: hidden` and does not grow with zoom,
 *     so a rotate handle at `box.y - 28` is clipped away when the selection is
 *     near the top of the visible canvas (at 300% zoom the page top measured 657px
 *     above the svg's own top edge).
 *
 * The sweep below is deliberately wider than the sizes that were measured: the
 * point of moving this into a pure module is that the invariant can be checked
 * everywhere, not only at the two zoom levels someone happened to try.
 */

/** Sizes worth checking: degenerate, tiny, flat, square, large. */
const SWEEP: Array<[number, number]> = [
  [0, 0], [1, 1], [4, 30], [9, 9], [10, 10], [11, 11], [13, 13], [14, 14],
  [16, 16], [20, 20], [22, 22], [24, 24], [26, 26], [30, 45], [45, 30],
  [36, 36], [40, 40], [47, 47], [48, 48], [49, 49], [60, 50], [120, 20],
  [300, 20], [20, 300], [180, 120], [400, 400], [1200, 90],
];

describe("selectionChrome — the drag core survives every selection size", () => {
  it("never lets handles consume the whole interior", () => {
    /*
     * THE headline invariant, and the one the old overlay broke. If the handles'
     * inward reach ever covers the selection, a pointer-down anywhere inside it
     * starts a RESIZE and the object can no longer be moved.
     */
    for (const [w, h] of SWEEP) {
      const core = dragCore(w, h);
      if (handleInwardExtent(w, h) === 0) {
        // No handles drawn: the whole selection is its own drag core.
        expect(core, `${w}x${h}`).toEqual({ width: w, height: h });
        continue;
      }
      expect(core.width, `${w}x${h} core width`).toBeGreaterThanOrEqual(DRAG_CORE_MIN);
      expect(core.height, `${w}x${h} core height`).toBeGreaterThanOrEqual(DRAG_CORE_MIN);
    }
  });

  it("reproduces the measured case: a 45x30 screen box keeps a real interior", () => {
    // Measured before: 24 of 25 grid points inside this box hit a handle.
    const core = dragCore(45, 30);
    expect(core).toEqual({ width: 29, height: 14 });
    // And it is corners only, because neither edge reaches 48px.
    expect(visibleHandles(45, 30)).toEqual(["nw", "ne", "se", "sw"]);
  });

  it("spends nothing on handles a selection cannot host", () => {
    expect(handleInwardExtent(10, 10)).toBe(0);
    expect(visibleHandles(10, 10)).toEqual([]);
    expect(visibleHandles(6, 400)).toEqual([]); // a hairline: frame only
    // The frame still draws — `visibleHandles` is about handles, not the box.
    expect(dragCore(10, 10)).toEqual({ width: 10, height: 10 });
  });

  it("grows the inward reach monotonically and caps it", () => {
    let prev = -1;
    for (let s = 0; s <= 80; s++) {
      const inward = handleInwardExtent(s, s);
      expect(inward, `size ${s}`).toBeGreaterThanOrEqual(prev);
      expect(inward).toBeLessThanOrEqual(HANDLE_INWARD_MAX);
      prev = inward;
    }
    expect(handleInwardExtent(400, 400)).toBe(HANDLE_INWARD_MAX);
  });

  it("limits both axes by the shorter one, so a flat strip still gets handles", () => {
    // A highlight strip. The alternative to a shallow target is no target at all,
    // i.e. a highlight that cannot be resized by dragging.
    expect(handleInwardExtent(300, 20)).toBe(5);
    expect(visibleHandles(300, 20)).toEqual(["nw", "n", "ne", "se", "s", "sw"]);
    expect(dragCore(300, 20)).toEqual({ width: 290, height: 10 });
  });

  it("treats degenerate sizes as unhostable rather than throwing", () => {
    for (const bad of [0, -1, NaN]) {
      expect(handleInwardExtent(bad, 50), String(bad)).toBe(0);
      expect(visibleHandles(bad, 50), String(bad)).toEqual([]);
    }
    // Infinity is NOT degenerate here: the shorter axis governs, so an unbounded
    // width with a 50px height is an ordinary flat selection.
    expect(handleInwardExtent(Infinity, 50)).toBe(HANDLE_INWARD_MAX);
    expect(visibleHandles(Infinity, 50)).toEqual(["nw", "n", "ne", "e", "se", "s", "sw", "w"]);
  });
});

describe("selectionChrome — pointer targets do not overlap", () => {
  /** The browser measurement, reimplemented: which target pairs share pixels. */
  function overlaps(w: number, h: number): string[] {
    const inward = handleInwardExtent(w, h);
    const box = { x: 0, y: 0, width: w, height: h };
    const rects = visibleHandles(w, h).map((handle) => ({
      handle,
      ...handleHitRect(handle, box, inward),
    }));
    const found: string[] = [];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const ox = Math.min(a.x + a.size, b.x + b.size) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.size, b.y + b.size) - Math.max(a.y, b.y);
        if (ox > 0 && oy > 0) found.push(`${a.handle}/${b.handle}`);
      }
    }
    return found;
  }

  it("finds no overlapping pair at any size in the sweep", () => {
    // Measured before at 45x30: 12 overlapping pairs, including nw/n and nw/w.
    for (const [w, h] of SWEEP) {
      expect(overlaps(w, h), `${w}x${h}`).toEqual([]);
    }
  });

  it("finds no overlapping pair across a dense square sweep", () => {
    for (let s = 1; s <= 200; s++) {
      expect(overlaps(s, s), `${s}x${s}`).toEqual([]);
    }
  });

  it("keeps every target the full WCAG size even when the selection is tiny", () => {
    // The target SHRINKS ITS REACH, never its size. 24px is the accessibility
    // floor (WCAG 2.2 AA 2.5.8), so trading it away to fit small selections would
    // fix a drag bug by creating a target-size one.
    for (const [w, h] of SWEEP) {
      const inward = handleInwardExtent(w, h);
      if (inward === 0) continue;
      for (const handle of visibleHandles(w, h)) {
        const rect = handleHitRect(handle, { x: 0, y: 0, width: w, height: h }, inward);
        expect(rect.size, `${w}x${h} ${handle}`).toBe(HANDLE_HIT);
      }
    }
  });
});

describe("selectionChrome — targets reach outward", () => {
  const box = { x: 100, y: 200, width: 180, height: 120 };
  const inward = handleInwardExtent(box.width, box.height);

  it("puts most of a corner target OUTSIDE the selection", () => {
    const nw = handleHitRect("nw", box, inward);
    // Inward reach is capped; the rest hangs off the corner.
    expect(box.x - nw.x).toBe(HANDLE_HIT - inward);
    expect(nw.x + nw.size - box.x).toBe(inward);
    expect(box.y - nw.y).toBe(HANDLE_HIT - inward);
    expect(nw.y + nw.size - box.y).toBe(inward);
  });

  it("biases each corner away from the selection's centre", () => {
    const se = handleHitRect("se", box, inward);
    expect(se.x).toBe(box.x + box.width - inward);
    expect(se.y).toBe(box.y + box.height - inward);
    const ne = handleHitRect("ne", box, inward);
    expect(ne.x).toBe(box.x + box.width - inward);
    expect(ne.y).toBe(box.y - (HANDLE_HIT - inward));
  });

  it("biases a mid-edge target only along its own normal", () => {
    const n = handleHitRect("n", box, inward);
    // Centred along the edge it sits on — there is nothing to bias it away from
    // sideways — and pushed outward across it.
    expect(n.x).toBe(box.x + box.width / 2 - HANDLE_HIT / 2);
    expect(n.y).toBe(box.y - (HANDLE_HIT - inward));
    const e = handleHitRect("e", box, inward);
    expect(e.y).toBe(box.y + box.height / 2 - HANDLE_HIT / 2);
    expect(e.x).toBe(box.x + box.width - inward);
  });

  it("never draws a visual handle deeper than its own target reaches", () => {
    for (const [w, h] of SWEEP) {
      const reach = handleInwardExtent(w, h);
      const visual = handleVisualSize(reach);
      expect(visual / 2, `${w}x${h}`).toBeLessThanOrEqual(reach);
      expect(visual).toBeLessThanOrEqual(HANDLE_SIZE);
    }
    expect(handleVisualSize(0)).toBe(0);
    expect(handleVisualSize(HANDLE_INWARD_MAX)).toBe(HANDLE_SIZE);
    expect(handleVisualSize(2)).toBe(4);
  });
});

describe("selectionChrome — mid-edge handles need room", () => {
  it("adds n/s only once the width can host them clear of the corners", () => {
    expect(visibleHandles(MID_HANDLE_MIN_EDGE - 1, 200)).not.toContain("n");
    expect(visibleHandles(MID_HANDLE_MIN_EDGE, 200)).toContain("n");
    expect(visibleHandles(MID_HANDLE_MIN_EDGE, 200)).toContain("s");
  });

  it("adds e/w only once the height can host them", () => {
    expect(visibleHandles(200, MID_HANDLE_MIN_EDGE - 1)).not.toContain("e");
    expect(visibleHandles(200, MID_HANDLE_MIN_EDGE)).toContain("e");
    expect(visibleHandles(200, MID_HANDLE_MIN_EDGE)).toContain("w");
  });

  it("decides each axis independently", () => {
    // 120x20: wide enough for n/s, far too flat for e/w.
    expect(visibleHandles(120, 20)).toEqual(["nw", "n", "ne", "se", "s", "sw"]);
    // 20x300: the transpose.
    expect(visibleHandles(20, 300)).toEqual(["nw", "ne", "e", "se", "sw", "w"]);
  });

  it("returns all eight in canonical order for a normal selection", () => {
    // The order matters: later siblings win an SVG hit-test tie, so it is part of
    // the contract rather than an implementation detail.
    expect(visibleHandles(180, 120)).toEqual(["nw", "n", "ne", "e", "se", "s", "sw", "w"]);
  });

  it("gives every handle a resize cursor that matches its axis", () => {
    const expected: Record<ResizeHandle, string> = {
      n: "ns-resize", s: "ns-resize",
      e: "ew-resize", w: "ew-resize",
      ne: "nesw-resize", sw: "nesw-resize",
      nw: "nwse-resize", se: "nwse-resize",
    };
    for (const [handle, cursor] of Object.entries(expected)) {
      expect(handleCursor(handle as ResizeHandle), handle).toBe(cursor);
    }
  });
});

describe("selectionChrome — the rotate handle stays inside the canvas", () => {
  it("sits above the selection when there is room", () => {
    expect(rotateSide(400)).toBe("above");
    expect(rotateSide(ROTATE_ROOM)).toBe("above");
    expect(rotateCentreY({ y: 400, height: 100 }, "above")).toBe(400 - ROTATE_OFFSET);
  });

  it("flips below when the selection is near the top of the visible canvas", () => {
    // The clipped case: the svg is `overflow: hidden` and viewport-sized, so a
    // negative y is not "slightly off", it is gone.
    expect(rotateSide(ROTATE_ROOM - 1)).toBe("below");
    expect(rotateSide(0)).toBe("below");
    expect(rotateSide(-657)).toBe("below"); // measured at 300% zoom
    expect(rotateCentreY({ y: 10, height: 100 }, "below")).toBe(10 + 100 + ROTATE_OFFSET);
  });

  it("leaves room for the handle itself, not just its offset", () => {
    // ROTATE_ROOM must exceed ROTATE_OFFSET, or the flip triggers exactly when
    // the handle's centre is visible but its circle is already half cut off.
    expect(ROTATE_ROOM).toBeGreaterThan(ROTATE_OFFSET);
  });
});
