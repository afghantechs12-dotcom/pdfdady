import { describe, expect, it } from "vitest";
import {
  KEYBOARD_PAN_STEP,
  KEYBOARD_PAN_STEP_BIG,
  beginPan,
  cancelPan,
  keyboardPanDelta,
  panPosition,
} from "./panTool";

describe("panTool — drag math", () => {
  it("applies the raw client delta to the starting pan", () => {
    const s = beginPan({ x: 100, y: 50 }, { x: 10, y: 20 });
    expect(panPosition(s, { x: 130, y: 45 })).toEqual({ x: 40, y: 15 });
  });

  it("is zoom-independent (screen-space translation only)", () => {
    // The math involves no zoom factor: the same drag gives the same pan
    // whether the viewport is at 25% or 400%.
    const s = beginPan({ x: 0, y: 0 }, { x: 0, y: 0 });
    const moved = panPosition(s, { x: 250, y: -80 });
    expect(moved).toEqual({ x: 250, y: -80 });
  });

  it("returns the start pan unchanged for a zero-delta move", () => {
    const s = beginPan({ x: 7, y: 7 }, { x: 3, y: 4 });
    expect(panPosition(s, { x: 7, y: 7 })).toEqual({ x: 3, y: 4 });
  });

  it("cancel restores exactly the starting pan", () => {
    const s = beginPan({ x: 100, y: 100 }, { x: -55, y: 12 });
    panPosition(s, { x: 900, y: 900 }); // any amount of dragging…
    expect(cancelPan(s)).toEqual({ x: -55, y: 12 });
  });

  it("does not alias the caller's points (immutable session)", () => {
    const client = { x: 1, y: 2 };
    const pan = { x: 3, y: 4 };
    const s = beginPan(client, pan);
    client.x = 999;
    pan.y = 999;
    expect(s.startClient).toEqual({ x: 1, y: 2 });
    expect(s.startPan).toEqual({ x: 3, y: 4 });
    expect(cancelPan(s)).not.toBe(s.startPan); // fresh object out too
  });
});

describe("panTool — keyboard alternative", () => {
  it("maps arrow keys to scrollbar-convention deltas", () => {
    expect(keyboardPanDelta("ArrowLeft", false)).toEqual({ x: KEYBOARD_PAN_STEP, y: 0 });
    expect(keyboardPanDelta("ArrowRight", false)).toEqual({ x: -KEYBOARD_PAN_STEP, y: 0 });
    expect(keyboardPanDelta("ArrowUp", false)).toEqual({ x: 0, y: KEYBOARD_PAN_STEP });
    expect(keyboardPanDelta("ArrowDown", false)).toEqual({ x: 0, y: -KEYBOARD_PAN_STEP });
  });

  it("shift uses the big step", () => {
    expect(keyboardPanDelta("ArrowLeft", true)).toEqual({ x: KEYBOARD_PAN_STEP_BIG, y: 0 });
  });

  it("returns null for non-arrow keys", () => {
    expect(keyboardPanDelta("a", false)).toBeNull();
    expect(keyboardPanDelta("Enter", true)).toBeNull();
  });
});
