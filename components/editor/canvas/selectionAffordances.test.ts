import { describe, expect, it, beforeEach } from "vitest";

import {
  affordanceWhileEditing,
  resolveSelectionAffordance,
  isSourceTextSelection,
  supportsInlineTextEditing,
} from "@/components/editor/canvas/selectionAffordances";
import {
  makeTextObject,
  makeRect,
  makeImage,
  makeAnnotation,
  resetFactory,
} from "@/src/domain/editor/testFactories";
import type { TextObject } from "@/src/domain/editor/objects";

/**
 * The contract these tests defend: the canvas may not offer a transform
 * affordance for text it refuses to let the user transform. This is the
 * regression that produced the "purple resize box over un-editable PDF text"
 * report, so both directions are asserted — read-only text loses the handles,
 * and editable text KEEPS them (silencing the chrome for everything would
 * "fix" the contradiction by breaking the editor).
 */
describe("resolveSelectionAffordance", () => {
  beforeEach(resetFactory);

  const readonlyRun = (overrides: Partial<TextObject> = {}) =>
    makeTextObject({
      sourceText: { fontName: "Helvetica", rotation: 0, mode: "readonly", reason: "unsupported" },
      ...overrides,
    });

  describe("read-only imported PDF text", () => {
    it("is classified as a source-text selection", () => {
      expect(resolveSelectionAffordance([readonlyRun()]).kind).toBe("source-text");
      expect(isSourceTextSelection([readonlyRun()])).toBe(true);
    });

    it("exposes NO resize handles and NO rotate handle", () => {
      const a = resolveSelectionAffordance([readonlyRun()]);
      expect(a.showHandles).toBe(false);
      expect(a.showRotate).toBe(false);
    });

    it("disallows geometry editing, so the inspector hides position/size/flip", () => {
      expect(resolveSelectionAffordance([readonlyRun()]).allowsGeometry).toBe(false);
    });

    it("treats a `direct` run as read-only too (the page already shows the edit)", () => {
      const direct = readonlyRun({
        sourceText: { fontName: "Helvetica", rotation: 0, mode: "direct" },
      });
      expect(resolveSelectionAffordance([direct]).kind).toBe("source-text");
    });

    it("treats a legacy run with no mode as read-only (conservative default)", () => {
      const legacy = readonlyRun({ sourceText: { fontName: "Helvetica", rotation: 0 } });
      expect(resolveSelectionAffordance([legacy]).showHandles).toBe(false);
    });
  });

  describe("editable objects keep their full transform chrome", () => {
    it("editor-authored text gets handles and rotate", () => {
      const a = resolveSelectionAffordance([makeTextObject({ sourceText: null })]);
      expect(a.kind).toBe("transform");
      expect(a.showHandles).toBe(true);
      expect(a.showRotate).toBe(true);
      expect(a.allowsGeometry).toBe(true);
    });

    it("a `replace` run is editable — the replacement IS the visible copy", () => {
      const replaced = makeTextObject({
        sourceText: {
          fontName: "Helvetica",
          rotation: 0,
          mode: "replace",
          originalText: "Original line",
        },
      });
      const a = resolveSelectionAffordance([replaced]);
      expect(a.kind).toBe("transform");
      expect(a.showHandles).toBe(true);
    });

    it("shapes and images get handles and rotate", () => {
      expect(resolveSelectionAffordance([makeRect()]).showRotate).toBe(true);
      expect(resolveSelectionAffordance([makeImage()]).showRotate).toBe(true);
    });
  });

  describe("multi-selection", () => {
    it("allows resize but not rotate (no predictable single origin)", () => {
      const a = resolveSelectionAffordance([makeRect(), makeImage()]);
      expect(a.kind).toBe("multi");
      expect(a.showHandles).toBe(true);
      expect(a.showRotate).toBe(false);
    });

    it("stays multi when a read-only run is part of the group", () => {
      const a = resolveSelectionAffordance([makeRect(), readonlyRun()]);
      expect(a.kind).toBe("multi");
      expect(a.showHandles).toBe(true);
    });

    it("is not reported as a source-text selection", () => {
      expect(isSourceTextSelection([makeRect(), readonlyRun()])).toBe(false);
    });
  });

  it("returns a stable value for an empty selection", () => {
    expect(resolveSelectionAffordance([]).kind).toBe("transform");
    expect(isSourceTextSelection([])).toBe(false);
  });

  describe("while the inline text editor is open", () => {
    /*
     * Measured (P7): with the editor open the canvas still drew 6 resize handles
     * and 1 rotate handle, and `onHandlePointerDown` returned immediately for all
     * of them — pressing one did nothing at all. The editing surface carries its
     * own ring, so the selection chrome is suppressed rather than made inert.
     */
    it("drops the handles and the rotate handle", () => {
      const editing = affordanceWhileEditing(resolveSelectionAffordance([makeTextObject({ sourceText: null })]), true);
      expect(editing.kind).toBe("text-editing");
      expect(editing.showHandles).toBe(false);
      expect(editing.showRotate).toBe(false);
    });

    it("keeps geometry editing, because the Inspector's fields still apply", () => {
      // Unlike a read-only run, an object being typed into can still be moved and
      // resized through the Inspector; only the canvas GESTURES are suspended.
      expect(affordanceWhileEditing(resolveSelectionAffordance([makeTextObject({ sourceText: null })]), true).allowsGeometry).toBe(true);
    });

    it("is a no-op when no editor is open", () => {
      const base = resolveSelectionAffordance([makeRect()]);
      expect(affordanceWhileEditing(base, false)).toBe(base);
    });

    it("cannot override the read-only verdict", () => {
      // A read-only run refuses the editor entirely, so an editing flag over it
      // could only come from a bug; the capability model wins either way.
      const base = resolveSelectionAffordance([readonlyRun()]);
      expect(affordanceWhileEditing(base, true)).toBe(base);
      expect(affordanceWhileEditing(base, true).allowsGeometry).toBe(false);
    });
  });

  describe("supportsInlineTextEditing", () => {
    /*
     * Measured (P7): the annotate tool opened the inline editor on the
     * `annotation` object it had just created. The canvas renders that editor for
     * text objects only, so nothing appeared — and because the editor's own
     * commit/cancel are the only things that clear the editing id, the canvas
     * stayed wedged in a pseudo-editing state after a single note was placed.
     */
    it("accepts an editor-authored text object", () => {
      expect(supportsInlineTextEditing(makeTextObject({ sourceText: null }))).toBe(true);
    });

    it("refuses an annotation — its text is an Inspector field, not a canvas overlay", () => {
      expect(supportsInlineTextEditing(makeAnnotation())).toBe(false);
    });

    it("refuses objects with no text at all", () => {
      expect(supportsInlineTextEditing(makeRect())).toBe(false);
      expect(supportsInlineTextEditing(makeImage())).toBe(false);
    });

    it("refuses a read-only imported run", () => {
      expect(supportsInlineTextEditing(readonlyRun())).toBe(false);
    });

    it("accepts a `replace` run, which the double-click path already allowed", () => {
      const replaced = makeTextObject({
        sourceText: { fontName: "Helvetica", rotation: 0, mode: "replace", originalText: "Original line" },
      });
      expect(supportsInlineTextEditing(replaced)).toBe(true);
    });

    it("is safe on a missing object (a stale id resolves to nothing)", () => {
      expect(supportsInlineTextEditing(null)).toBe(false);
      expect(supportsInlineTextEditing(undefined)).toBe(false);
    });
  });
});
