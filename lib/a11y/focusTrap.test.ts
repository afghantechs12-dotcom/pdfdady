import { describe, expect, it } from "vitest";
import { nextFocusTarget } from "./focusTrap";

/** Builds N mock focusable elements (cast to HTMLElement; the logic uses no DOM). */
function mocks(n: number): HTMLElement[] {
  return Array.from({ length: n }, (_, i) => ({ id: i } as unknown as HTMLElement));
}

describe("nextFocusTarget (focus-trap tab cycle)", () => {
  it("returns null for an empty list", () => {
    expect(nextFocusTarget([], null, false)).toBeNull();
  });

  it("targets the first element when nothing is focused (Tab)", () => {
    const els = mocks(3);
    expect(nextFocusTarget(els, null, false)).toBe(els[0]);
  });

  it("targets the last element when nothing is focused (Shift+Tab)", () => {
    const els = mocks(3);
    expect(nextFocusTarget(els, null, true)).toBe(els[2]);
  });

  it("advances forward and wraps from last to first", () => {
    const els = mocks(3);
    expect(nextFocusTarget(els, els[0], false)).toBe(els[1]);
    expect(nextFocusTarget(els, els[2], false)).toBe(els[0]); // wrap
  });

  it("advances backward and wraps from first to last", () => {
    const els = mocks(3);
    expect(nextFocusTarget(els, els[1], true)).toBe(els[0]);
    expect(nextFocusTarget(els, els[0], true)).toBe(els[2]); // wrap
  });

  it("falls back to the first/last when the current element is not in the list", () => {
    const els = mocks(3);
    const outsider = { id: 99 } as unknown as HTMLElement;
    expect(nextFocusTarget(els, outsider, false)).toBe(els[0]);
    expect(nextFocusTarget(els, outsider, true)).toBe(els[2]);
  });

  it("handles a single-element list (focus stays put on Tab and Shift+Tab)", () => {
    const els = mocks(1);
    expect(nextFocusTarget(els, els[0], false)).toBe(els[0]);
    expect(nextFocusTarget(els, els[0], true)).toBe(els[0]);
  });
});
