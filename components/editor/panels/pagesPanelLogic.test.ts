import { describe, expect, it } from "vitest";
import {
  EMPTY_PAGES_SELECTION,
  insertionIndexFromPointer,
  moveTargetIndex,
  normalizePagesSelection,
  reducePageClick,
  type MeasuredItem,
  type PagesSelection,
} from "./pagesPanelLogic";

const PAGES = ["p1", "p2", "p3", "p4", "p5"];

describe("reducePageClick: plain click", () => {
  it("selects only the clicked page and anchors it", () => {
    const next = reducePageClick(EMPTY_PAGES_SELECTION, PAGES, "p3");
    expect(next).toEqual({ ids: ["p3"], anchorId: "p3" });
  });

  it("replaces a multi-selection", () => {
    const start: PagesSelection = { ids: ["p1", "p2", "p3"], anchorId: "p1" };
    expect(reducePageClick(start, PAGES, "p5")).toEqual({ ids: ["p5"], anchorId: "p5" });
  });
});

describe("reducePageClick: Ctrl+click", () => {
  it("adds a page and keeps document order", () => {
    const start: PagesSelection = { ids: ["p3"], anchorId: "p3" };
    expect(reducePageClick(start, PAGES, "p1", { ctrl: true })).toEqual({
      ids: ["p1", "p3"],
      anchorId: "p1",
    });
  });

  it("toggles a selected page off and re-anchors to the last remaining", () => {
    const start: PagesSelection = { ids: ["p1", "p3"], anchorId: "p3" };
    expect(reducePageClick(start, PAGES, "p3", { ctrl: true })).toEqual({
      ids: ["p1"],
      anchorId: "p1",
    });
  });

  it("toggling off a non-anchor keeps the anchor", () => {
    const start: PagesSelection = { ids: ["p1", "p2", "p3"], anchorId: "p2" };
    expect(reducePageClick(start, PAGES, "p1", { ctrl: true })).toEqual({
      ids: ["p2", "p3"],
      anchorId: "p2",
    });
  });
});

describe("reducePageClick: Shift+click", () => {
  it("range-selects between the anchor and the clicked page (forward)", () => {
    const start: PagesSelection = { ids: ["p2"], anchorId: "p2" };
    expect(reducePageClick(start, PAGES, "p4", { shift: true })).toEqual({
      ids: ["p2", "p3", "p4"],
      anchorId: "p2",
    });
  });

  it("range-selects backward and keeps the anchor for re-ranging", () => {
    const start: PagesSelection = { ids: ["p4"], anchorId: "p4" };
    const range = reducePageClick(start, PAGES, "p2", { shift: true });
    expect(range).toEqual({ ids: ["p2", "p3", "p4"], anchorId: "p4" });
    // A further shift-click re-ranges from the SAME anchor.
    expect(reducePageClick(range, PAGES, "p5", { shift: true })).toEqual({
      ids: ["p4", "p5"],
      anchorId: "p4",
    });
  });

  it("falls back to a plain select without an anchor", () => {
    expect(reducePageClick(EMPTY_PAGES_SELECTION, PAGES, "p3", { shift: true })).toEqual({
      ids: ["p3"],
      anchorId: "p3",
    });
  });
});

describe("reducePageClick: unknown ids", () => {
  it("ignores a click on a missing id (normalizes only)", () => {
    const start: PagesSelection = { ids: ["p2"], anchorId: "p2" };
    expect(reducePageClick(start, PAGES, "nope")).toEqual({ ids: ["p2"], anchorId: "p2" });
  });
});

describe("normalizePagesSelection", () => {
  it("drops deleted ids and re-anchors", () => {
    const start: PagesSelection = { ids: ["p2", "p9"], anchorId: "p9" };
    expect(normalizePagesSelection(start, PAGES)).toEqual({ ids: ["p2"], anchorId: "p2" });
  });

  it("re-sorts survivors into document order after a reorder", () => {
    const start: PagesSelection = { ids: ["p4", "p1"], anchorId: "p1" };
    const reordered = ["p4", "p3", "p2", "p1", "p5"];
    expect(normalizePagesSelection(start, reordered)).toEqual({ ids: ["p4", "p1"], anchorId: "p1" });
  });

  it("empties cleanly when nothing survives", () => {
    const start: PagesSelection = { ids: ["gone"], anchorId: "gone" };
    expect(normalizePagesSelection(start, PAGES)).toEqual({ ids: [], anchorId: null });
  });
});

describe("insertionIndexFromPointer", () => {
  // Five 100px items stacked at 0,100,200,300,400 (midpoints 50,150,…,450).
  const items: MeasuredItem[] = [0, 100, 200, 300, 400].map((top) => ({ top, height: 100 }));

  it("returns 0 above the first midpoint", () => {
    expect(insertionIndexFromPointer(0, items)).toBe(0);
    expect(insertionIndexFromPointer(49, items)).toBe(0);
  });

  it("crosses a slot at each midpoint", () => {
    expect(insertionIndexFromPointer(50, items)).toBe(1);
    expect(insertionIndexFromPointer(150, items)).toBe(2);
    expect(insertionIndexFromPointer(250, items)).toBe(3);
  });

  it("returns items.length past the last midpoint", () => {
    expect(insertionIndexFromPointer(450, items)).toBe(5);
    expect(insertionIndexFromPointer(9999, items)).toBe(5);
  });

  it("returns 0 for an empty list", () => {
    expect(insertionIndexFromPointer(100, [])).toBe(0);
  });
});

describe("moveTargetIndex", () => {
  it("is the identity when dropped into its own slot or the slot after", () => {
    expect(moveTargetIndex(2, 2)).toBe(2);
    expect(moveTargetIndex(2, 3)).toBe(2);
  });

  it("adjusts for the removal when moving down", () => {
    // Item at index 1 dropped into slot 4 (before old index 4) lands at 3.
    expect(moveTargetIndex(1, 4)).toBe(3);
  });

  it("does not adjust when moving up", () => {
    expect(moveTargetIndex(3, 1)).toBe(1);
    expect(moveTargetIndex(3, 0)).toBe(0);
  });

  it("moving to the very end", () => {
    // 5 pages, item at index 0 dropped after the last (slot 5) → index 4.
    expect(moveTargetIndex(0, 5)).toBe(4);
  });
});
