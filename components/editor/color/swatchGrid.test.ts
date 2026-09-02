import { describe, expect, it } from "vitest";
import { asSwatchGridKey, nextSwatchIndex } from "./swatchGrid";

// A 12-swatch row-of-6 grid: indices 0..5 on row 0, 6..11 on row 1.
const COUNT = 12;
const COLS = 6;

describe("swatchGrid: nextSwatchIndex", () => {
  it("moves one swatch left and right within a row", () => {
    expect(nextSwatchIndex(2, "ArrowRight", COUNT, COLS)).toBe(3);
    expect(nextSwatchIndex(2, "ArrowLeft", COUNT, COLS)).toBe(1);
  });

  it("wraps left/right across row boundaries so holding Right walks the whole grid", () => {
    expect(nextSwatchIndex(5, "ArrowRight", COUNT, COLS)).toBe(6);
    expect(nextSwatchIndex(6, "ArrowLeft", COUNT, COLS)).toBe(5);
  });

  it("refuses to move past the first and last swatch instead of teleporting", () => {
    // Jumping from the last swatch to the first loses the user's place.
    expect(nextSwatchIndex(0, "ArrowLeft", COUNT, COLS)).toBe(0);
    expect(nextSwatchIndex(COUNT - 1, "ArrowRight", COUNT, COLS)).toBe(COUNT - 1);
  });

  it("moves by a whole row on up/down, staying in the same column", () => {
    expect(nextSwatchIndex(8, "ArrowUp", COUNT, COLS)).toBe(2);
    expect(nextSwatchIndex(2, "ArrowDown", COUNT, COLS)).toBe(8);
  });

  it("refuses a vertical move off the grid rather than clamping into another column", () => {
    expect(nextSwatchIndex(2, "ArrowUp", COUNT, COLS)).toBe(2);
    expect(nextSwatchIndex(8, "ArrowDown", COUNT, COLS)).toBe(8);
  });

  it("refuses a down-move into a ragged final row's missing cells", () => {
    // 9 swatches, 6 columns: row 1 holds 6,7,8 only. Down from 4 would be 10.
    expect(nextSwatchIndex(4, "ArrowDown", 9, COLS)).toBe(4);
    expect(nextSwatchIndex(1, "ArrowDown", 9, COLS)).toBe(7);
  });

  it("jumps to the ends on Home and End", () => {
    expect(nextSwatchIndex(7, "Home", COUNT, COLS)).toBe(0);
    expect(nextSwatchIndex(3, "End", COUNT, COLS)).toBe(COUNT - 1);
  });

  it("returns the same index for an empty grid, so the caller cannot focus nothing", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"] as const) {
      expect(nextSwatchIndex(0, key, 0, COLS)).toBe(0);
    }
  });

  it("tolerates a current index outside the grid by clamping first", () => {
    // A palette that shrank between renders must not strand the roving index.
    expect(nextSwatchIndex(99, "ArrowLeft", COUNT, COLS)).toBe(COUNT - 2);
    expect(nextSwatchIndex(-5, "ArrowRight", COUNT, COLS)).toBe(1);
  });

  it("never returns an index outside the grid, for any key and any start", () => {
    for (let count = 1; count <= 20; count += 1) {
      for (let i = -2; i <= count + 2; i += 1) {
        for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"] as const) {
          const next = nextSwatchIndex(i, key, count, COLS);
          expect(next).toBeGreaterThanOrEqual(0);
          expect(next).toBeLessThan(count);
        }
      }
    }
  });
});

describe("swatchGrid: asSwatchGridKey", () => {
  it("accepts the six navigation keys", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]) {
      expect(asSwatchGridKey(key)).toBe(key);
    }
  });

  it("rejects keys the grid must let through, so typing and Escape still work", () => {
    // Escape must reach the popover's close handler; a letter must reach a field.
    for (const key of ["Escape", "Enter", "Tab", " ", "a", "7", "PageDown"]) {
      expect(asSwatchGridKey(key)).toBeNull();
    }
  });
});
