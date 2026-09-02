import { beforeEach, describe, expect, it } from "vitest";
import { makeTextObject, resetFactory } from "./testFactories";
import { isReadonlySourceText, shouldDrawTextObject } from "./importedTextRendering";
import type { TextObject } from "./objects";

/**
 * Tests for the shared draw decision.
 *
 * This is the invariant that kills the duplication defect: for any imported text
 * run, the number of visible copies is exactly one. The original counts as a
 * copy — it lives in the page raster on screen and in the source page on export
 * — so "we draw it too" means two.
 *
 * Because the canvas renderer and the PDF exporter both call this function, a
 * test here covers both. That is the point of it being shared: there is no way
 * for the screen and the export to disagree.
 */

/** A readonly imported run — the default for text extracted from a PDF. */
function readonlyRun(overrides: Partial<TextObject> = {}): TextObject {
  return makeTextObject({
    text: "Original line",
    background: null,
    sourceText: { fontName: "Helvetica", rotation: 0, mode: "readonly", reason: "unsupported" },
    ...overrides,
  });
}

/** A replacement run — the original was removed and this stands in for it. */
function replacementRun(overrides: Partial<TextObject> = {}): TextObject {
  return makeTextObject({
    text: "My replacement",
    background: { r: 1, g: 1, b: 1, a: 1 },
    sourceText: { fontName: "Helvetica", rotation: 0, mode: "replace", originalText: "Original line" },
    ...overrides,
  });
}

describe("shouldDrawTextObject", () => {
  beforeEach(() => resetFactory());

  it("does NOT draw a readonly run — the original is the one visible copy", () => {
    expect(shouldDrawTextObject(readonlyRun())).toBe(false);
  });

  it("does NOT draw a directly-edited run — the rewritten operator already shows it", () => {
    const direct = readonlyRun({
      sourceText: { fontName: "Helvetica", rotation: 0, mode: "direct" },
    });
    expect(shouldDrawTextObject(direct)).toBe(false);
  });

  it("DOES draw a replacement run — it is the one visible copy", () => {
    expect(shouldDrawTextObject(replacementRun())).toBe(true);
  });

  it("always draws editor-authored text", () => {
    expect(shouldDrawTextObject(makeTextObject({ text: "I typed this", sourceText: null }))).toBe(true);
  });

  it("treats a legacy marker with no mode as not-drawn", () => {
    // A legacy copy that somehow reached the renderer before normalization must
    // fail SAFE (invisible) rather than duplicating the original. Normalization
    // classifies it properly on load; this is the belt-and-braces case.
    const legacy = readonlyRun({ sourceText: { fontName: "Helvetica", rotation: 0 } });
    expect(shouldDrawTextObject(legacy)).toBe(false);
  });

  it("is independent of selection, lock, and visibility state", () => {
    // The old behavior hid the duplicate only in certain interaction states, so
    // clicking a run made a second copy appear. The decision must be a property
    // of the document, not of the interaction.
    for (const locked of [true, false]) {
      for (const visible of [true, false]) {
        expect(shouldDrawTextObject(readonlyRun({ locked, visible }))).toBe(false);
        expect(shouldDrawTextObject(replacementRun({ locked, visible }))).toBe(true);
      }
    }
  });

  it("is independent of opacity — a faded run is still not a second copy", () => {
    expect(shouldDrawTextObject(readonlyRun({ opacity: 0.5 }))).toBe(false);
    expect(shouldDrawTextObject(readonlyRun({ opacity: 1 }))).toBe(false);
  });

  it("yields exactly one visible copy per run across every mode", () => {
    // The invariant stated directly: original-visible + we-draw = 1, always.
    const cases: Array<{ obj: TextObject; originalStillVisible: boolean }> = [
      { obj: readonlyRun(), originalStillVisible: true },
      { obj: replacementRun(), originalStillVisible: false },
      {
        obj: readonlyRun({ sourceText: { fontName: "Helvetica", rotation: 0, mode: "direct" } }),
        originalStillVisible: true,
      },
    ];
    for (const { obj, originalStillVisible } of cases) {
      const visibleCopies = (originalStillVisible ? 1 : 0) + (shouldDrawTextObject(obj) ? 1 : 0);
      expect(visibleCopies).toBe(1);
    }
  });
});

describe("isReadonlySourceText", () => {
  beforeEach(() => resetFactory());

  it("identifies readonly and direct runs as not user-editable here", () => {
    expect(isReadonlySourceText(readonlyRun())).toBe(true);
    expect(
      isReadonlySourceText(readonlyRun({ sourceText: { fontName: "Helvetica", rotation: 0, mode: "direct" } })),
    ).toBe(true);
  });

  it("does not flag a replacement run", () => {
    expect(isReadonlySourceText(replacementRun())).toBe(false);
  });

  it("does not flag editor-authored text", () => {
    expect(isReadonlySourceText(makeTextObject({ sourceText: null }))).toBe(false);
  });

  it("agrees with shouldDrawTextObject for every imported run", () => {
    // The two predicates must never contradict: anything readonly is not drawn.
    for (const obj of [readonlyRun(), replacementRun()]) {
      if (isReadonlySourceText(obj)) expect(shouldDrawTextObject(obj)).toBe(false);
    }
  });
});
