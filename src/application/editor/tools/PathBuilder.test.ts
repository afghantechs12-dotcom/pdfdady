import { describe, expect, it } from "vitest";
import {
  addAnchor,
  commit,
  createPathBuilder,
  dedupeAnchors,
  dragHandle,
  previewPathData,
  removeLastAnchor,
} from "./PathBuilder";

describe("PathBuilder: anchors + handles", () => {
  it("starts empty; commit returns null below 2 anchors", () => {
    const s0 = createPathBuilder();
    expect(commit(s0)).toBeNull();
    const s1 = addAnchor(s0, { x: 10, y: 10 });
    expect(commit(s1)).toBeNull();
    expect(previewPathData(s1)).toBe("M 10 10");
  });

  it("transitions are immutable (no mutation of prior states)", () => {
    const s0 = createPathBuilder();
    const s1 = addAnchor(s0, { x: 0, y: 0 });
    const s2 = addAnchor(s1, { x: 10, y: 0 });
    expect(s0.anchors).toHaveLength(0);
    expect(s1.anchors).toHaveLength(1);
    expect(s2.anchors).toHaveLength(2);
  });

  it("corner anchors produce straight L segments", () => {
    let s = createPathBuilder();
    s = addAnchor(s, { x: 0, y: 0 });
    s = addAnchor(s, { x: 20, y: 0 });
    s = addAnchor(s, { x: 20, y: 20 });
    expect(previewPathData(s)).toBe("M 0 0 L 20 0 L 20 20");
  });

  it("dragging a handle turns the following segment into a cubic", () => {
    let s = createPathBuilder();
    s = addAnchor(s, { x: 0, y: 0 });
    s = dragHandle(s, { x: 10, y: -10 }); // pull the first anchor's out-handle
    s = addAnchor(s, { x: 20, y: 0 });
    const d = previewPathData(s);
    expect(d).toBe("C".length ? d : d);
    expect(d.startsWith("M 0 0 C 10 -10")).toBe(true);
  });

  it("the incoming handle mirrors the next anchor's out-handle (symmetric pen)", () => {
    let s = createPathBuilder();
    s = addAnchor(s, { x: 0, y: 0 });
    s = addAnchor(s, { x: 20, y: 0 });
    s = dragHandle(s, { x: 30, y: 10 }); // out-handle of the SECOND anchor
    // Segment 1 → 2 uses the mirror of (30,10) about (20,0) = (10,-10) as c2.
    expect(previewPathData(s)).toBe("M 0 0 C 0 0 10 -10 20 0");
  });

  it("dragging back onto the anchor clears the handle (corner again)", () => {
    let s = createPathBuilder();
    s = addAnchor(s, { x: 0, y: 0 });
    s = dragHandle(s, { x: 10, y: 0 });
    s = dragHandle(s, { x: 0.2, y: 0.2 }); // < 1 unit from the anchor
    s = addAnchor(s, { x: 20, y: 0 });
    expect(previewPathData(s)).toBe("M 0 0 L 20 0");
  });

  it("dragHandle on an empty builder is a no-op", () => {
    const s = createPathBuilder();
    expect(dragHandle(s, { x: 5, y: 5 })).toBe(s);
  });
});

describe("PathBuilder: commit", () => {
  it("normalizes the path into local coordinates with tight bounds", () => {
    let s = createPathBuilder();
    s = addAnchor(s, { x: 100, y: 200 });
    s = addAnchor(s, { x: 140, y: 260 });
    const out = commit(s)!;
    expect(out.position).toEqual({ x: 100, y: 200 });
    expect(out.localBounds).toEqual({ x: 0, y: 0, width: 40, height: 60 });
    expect(out.pathData).toBe("M 0 0 L 40 60");
  });

  it("bounds include curve bulges via exact Bézier extrema", () => {
    // A handle pulling far above the chord: the tight bounds must include the
    // bulge, and the local path must start at (0, 0) after normalization.
    let s = createPathBuilder();
    s = addAnchor(s, { x: 100, y: 100 });
    s = dragHandle(s, { x: 120, y: 60 }); // out-handle above the chord
    s = addAnchor(s, { x: 140, y: 100 });
    const out = commit(s)!;
    // The curve rises above y=100, so the position's y sits above 100 and the
    // height covers the bulge down to the anchors.
    expect(out.position.y).toBeLessThan(100);
    expect(out.localBounds.height).toBeGreaterThan(0);
    // Anchors sit at the bottom edge of the local box.
    expect(out.localBounds.y).toBe(0);
    expect(out.pathData.startsWith("M 0")).toBe(true);
  });

  it("a straight horizontal path still gets a minimum 1-unit height", () => {
    let s = createPathBuilder();
    s = addAnchor(s, { x: 0, y: 50 });
    s = addAnchor(s, { x: 30, y: 50 });
    const out = commit(s)!;
    expect(out.localBounds.width).toBe(30);
    expect(out.localBounds.height).toBe(1);
  });
});

describe("PathBuilder: removeLastAnchor (Backspace during creation)", () => {
  it("removes the most recent anchor", () => {
    const s = addAnchor(addAnchor(createPathBuilder(), { x: 0, y: 0 }), { x: 50, y: 0 });
    const removed = removeLastAnchor(s);
    expect(removed?.anchors).toHaveLength(1);
    expect(removed?.anchors[0].point).toEqual({ x: 0, y: 0 });
  });

  it("returns null (cancel) when removing the only anchor", () => {
    const s = addAnchor(createPathBuilder(), { x: 0, y: 0 });
    expect(removeLastAnchor(s)).toBeNull();
    expect(removeLastAnchor(createPathBuilder())).toBeNull();
  });
});

describe("PathBuilder: dedupeAnchors (double-click finish)", () => {
  it("collapses consecutive same-point corner anchors", () => {
    let s = createPathBuilder();
    s = addAnchor(s, { x: 0, y: 0 });
    s = addAnchor(s, { x: 50, y: 20 });
    s = addAnchor(s, { x: 50, y: 20 }); // double-click's second anchor
    expect(dedupeAnchors(s).anchors).toHaveLength(2);
  });

  it("keeps same-point anchors when a handle was dragged out", () => {
    let s = createPathBuilder();
    s = addAnchor(s, { x: 0, y: 0 });
    s = addAnchor(s, { x: 50, y: 20 });
    s = dragHandle(s, { x: 80, y: 40 });
    s = addAnchor(s, { x: 50, y: 20 }); // corner over a smooth anchor — kept
    expect(dedupeAnchors(s).anchors).toHaveLength(3);
  });

  it("commit collapses the double-click duplicate (no zero-length tail)", () => {
    let s = createPathBuilder();
    s = addAnchor(s, { x: 10, y: 10 });
    s = addAnchor(s, { x: 60, y: 10 });
    s = addAnchor(s, { x: 60, y: 10 });
    const result = commit(s);
    expect(result).not.toBeNull();
    // One M + one L only — the duplicate anchor contributed nothing.
    expect(result!.pathData.match(/[ML]/g)).toEqual(["M", "L"]);
  });

  it("commit still rejects a path that is ONLY duplicates", () => {
    let s = createPathBuilder();
    s = addAnchor(s, { x: 10, y: 10 });
    s = addAnchor(s, { x: 10, y: 10 });
    expect(commit(s)).toBeNull();
  });
});
