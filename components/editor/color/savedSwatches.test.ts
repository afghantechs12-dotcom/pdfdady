import { describe, expect, it } from "vitest";
import {
  SAVED_SWATCH_LIMIT,
  addSavedSwatch,
  parseSavedSwatches,
  removeSavedSwatch,
  savedSwatchesFull,
  serializeSavedSwatches,
} from "./savedSwatches";
import { formatHex } from "@/src/domain/editor/colorModel";
import type { EditorColor } from "@/src/domain/editor/objects";

const RED: EditorColor = { r: 1, g: 0, b: 0, a: 1 };
const BLUE: EditorColor = { r: 0, g: 0, b: 1, a: 1 };

describe("savedSwatches: parsing persisted state", () => {
  it("reads a stored hex list back as colours", () => {
    expect(parseSavedSwatches('["#FF0000","#0000FF"]').map((c) => formatHex(c))).toEqual([
      "#FF0000",
      "#0000FF",
    ]);
  });

  it("returns an empty palette for a missing key", () => {
    expect(parseSavedSwatches(null)).toEqual([]);
  });

  it("survives malformed JSON without throwing, rather than breaking the editor", () => {
    // A corrupt localStorage key must not be able to crash the colour popover.
    for (const raw of ["", "{", "not json", "undefined"]) {
      expect(parseSavedSwatches(raw)).toEqual([]);
    }
  });

  it("ignores a payload of the wrong shape", () => {
    for (const raw of ['{"a":1}', '"#FF0000"', "42", "null"]) {
      expect(parseSavedSwatches(raw)).toEqual([]);
    }
  });

  it("drops individual unreadable entries but keeps the readable ones", () => {
    const parsed = parseSavedSwatches('["#FF0000", 7, null, "nope", "#0000FF"]');
    expect(parsed.map((c) => formatHex(c))).toEqual(["#FF0000", "#0000FF"]);
  });

  it("caps a tampered oversized payload at the documented limit", () => {
    const huge = JSON.stringify(Array.from({ length: 200 }, (_, i) => `#${i.toString(16).padStart(6, "0")}`));
    expect(parseSavedSwatches(huge)).toHaveLength(SAVED_SWATCH_LIMIT);
  });

  it("round-trips through serialize/parse", () => {
    const palette = [RED, BLUE, { r: 0.5, g: 0.25, b: 0.75, a: 1 }];
    const restored = parseSavedSwatches(serializeSavedSwatches(palette));
    expect(restored.map((c) => formatHex(c))).toEqual(palette.map((c) => formatHex(c)));
  });

  it("serialises as hex strings, so the payload is inspectable and version-proof", () => {
    expect(serializeSavedSwatches([RED])).toBe('["#FF0000"]');
  });
});

describe("savedSwatches: mutation", () => {
  it("appends rather than prepending, so a saved palette keeps its arrangement", () => {
    // Reordering on every save would move the swatch the user is aiming at.
    const palette = addSavedSwatch(addSavedSwatch([], RED), BLUE);
    expect(palette.map((c) => formatHex(c))).toEqual(["#FF0000", "#0000FF"]);
  });

  it("treats saving an existing colour as a no-op and preserves array identity", () => {
    const palette = addSavedSwatch([], RED);
    expect(addSavedSwatch(palette, RED)).toBe(palette);
  });

  it("ignores alpha when saving, since a saved swatch is a hue choice", () => {
    const palette = addSavedSwatch(addSavedSwatch([], RED), { ...RED, a: 0.3 });
    expect(palette).toHaveLength(1);
    expect(palette[0].a).toBe(1);
  });

  it("refuses to grow past the limit and reports the palette as full", () => {
    let palette: EditorColor[] = [];
    for (let i = 0; i < SAVED_SWATCH_LIMIT; i += 1) {
      palette = addSavedSwatch(palette, { r: i / SAVED_SWATCH_LIMIT, g: 0, b: 0, a: 1 });
    }
    expect(savedSwatchesFull(palette)).toBe(true);
    expect(addSavedSwatch(palette, BLUE)).toBe(palette);
  });

  it("reports a non-full palette as not full so the save control stays enabled", () => {
    expect(savedSwatchesFull([])).toBe(false);
    expect(savedSwatchesFull([RED])).toBe(false);
  });

  it("removes a saved swatch by colour", () => {
    const palette = addSavedSwatch(addSavedSwatch([], RED), BLUE);
    expect(removeSavedSwatch(palette, RED).map((c) => formatHex(c))).toEqual(["#0000FF"]);
  });

  it("removes by colour regardless of the alpha passed in", () => {
    const palette = addSavedSwatch([], RED);
    expect(removeSavedSwatch(palette, { ...RED, a: 0.2 })).toEqual([]);
  });

  it("treats removing an absent colour as a no-op and preserves array identity", () => {
    const palette = addSavedSwatch([], RED);
    expect(removeSavedSwatch(palette, BLUE)).toBe(palette);
  });

  it("does not mutate the palette it is given", () => {
    const palette = addSavedSwatch([], RED);
    const before = [...palette];
    addSavedSwatch(palette, BLUE);
    removeSavedSwatch(palette, RED);
    expect(palette).toEqual(before);
  });
});
