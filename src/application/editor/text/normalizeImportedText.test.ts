import { beforeEach, describe, expect, it } from "vitest";
import { addObjectToPage, createEditorState, getActivePage } from "@/src/domain/editor/document";
import type { EditorDocument } from "@/src/domain/editor/document";
import { makeRect, makeTextObject, resetFactory } from "@/src/domain/editor/testFactories";
import { type TextObject } from "@/src/domain/editor/objects";
import { normalizeImportedText, isUnchangedLegacyCopy } from "./normalizeImportedText";

/**
 * Tests for legacy imported-text normalization.
 *
 * The stakes: saved documents from before the capability model contain editable
 * COPIES of original PDF text with white covers. Loading one unchanged
 * reproduces the duplication defect. But some of those copies hold real user
 * edits, and destroying them would be worse than the defect. These tests pin
 * both halves of that rule.
 */

/** Builds a one-page document holding the given text objects. */
function docWith(...objects: TextObject[]): EditorDocument {
  const state = createEditorState();
  let page = getActivePage(state);
  for (const obj of objects) page = addObjectToPage(page, obj);
  return { ...state.document, pages: [page] };
}

/** A legacy Part-1 import: editable copy, white cover, no capability mode. */
function legacyCopy(overrides: Partial<TextObject> = {}): TextObject {
  const text = (overrides.text as string) ?? "Original line";
  return makeTextObject({
    text,
    name: text.slice(0, 24),
    background: { r: 1, g: 1, b: 1, a: 1 },
    sourceText: { fontName: "Helvetica", rotation: 0 },
    ...overrides,
  });
}

describe("normalizeImportedText: unchanged legacy copies", () => {
  beforeEach(() => resetFactory());

  it("suppresses an unchanged copy: no render, no export, no white cover", () => {
    const result = normalizeImportedText(docWith(legacyCopy()));
    const obj = Object.values(result.document.pages[0].objects)[0] as TextObject;

    expect(obj.sourceText?.mode).toBe("readonly");
    // The white cover is dropped, so whatever was behind the run (table rules,
    // images, colored fills) becomes visible again.
    expect(obj.background).toBeNull();
    expect(result.suppressed).toBe(1);
    expect(result.preserved).toBe(0);
  });

  it("preserves the original text on the marker so it can still be copied", () => {
    const result = normalizeImportedText(docWith(legacyCopy({ text: "Cambridge vocabulary" })));
    const obj = Object.values(result.document.pages[0].objects)[0] as TextObject;
    expect(obj.sourceText?.originalText).toBe("Cambridge vocabulary");
  });

  it("leaves the run selectable — locking it would hide the explanation", () => {
    const result = normalizeImportedText(docWith(legacyCopy()));
    const obj = Object.values(result.document.pages[0].objects)[0] as TextObject;
    expect(obj.locked).toBe(false);
  });
});

describe("normalizeImportedText: user-modified copies", () => {
  beforeEach(() => resetFactory());

  it("preserves a modified copy as a replacement rather than discarding user work", () => {
    // The name still holds the ORIGINAL run (the old importer set it and the
    // editing UI never updates it), while `text` holds what the user typed.
    const modified = legacyCopy({ text: "My own replacement", name: "Original line" });
    const result = normalizeImportedText(docWith(modified));
    const obj = Object.values(result.document.pages[0].objects)[0] as TextObject;

    expect(obj.sourceText?.mode).toBe("replace");
    expect(obj.text).toBe("My own replacement");
    // The cover is RETAINED here — it is the only thing removing the original.
    expect(obj.background).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(result.preserved).toBe(1);
    expect(result.suppressed).toBe(0);
  });

  it("warns (without altering) when a modified copy has no removal patch", () => {
    // User work exists but nothing hides the original, so export would print
    // both. Neither dropping it nor keeping it silently is acceptable.
    const unsafe = legacyCopy({ text: "Typed text", name: "Original line", background: null });
    const result = normalizeImportedText(docWith(unsafe));
    const obj = Object.values(result.document.pages[0].objects)[0] as TextObject;

    expect(obj.text).toBe("Typed text");
    expect(obj.sourceText?.mode).toBe("replace");
    expect(result.warningCount).toBe(1);
    expect(result.warnings[0].message).toMatch(/both may appear/);
  });

  it("bounds the surfaced warnings but reports the true total", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      legacyCopy({ text: `Typed ${i}`, name: "Original line", background: null }),
    );
    const result = normalizeImportedText(docWith(...many));
    expect(result.warningCount).toBe(30);
    expect(result.warnings).toHaveLength(20);
  });
});

describe("normalizeImportedText: objects it must not touch", () => {
  beforeEach(() => resetFactory());

  it("never touches editor-authored text", () => {
    const authored = makeTextObject({ text: "I typed this", sourceText: null });
    const doc = docWith(authored);
    const result = normalizeImportedText(doc);

    const obj = Object.values(result.document.pages[0].objects)[0] as TextObject;
    expect(obj.sourceText).toBeNull();
    expect(obj.text).toBe("I typed this");
    expect(result.suppressed).toBe(0);
    expect(result.preserved).toBe(0);
    // Nothing changed, so the document is returned by identity.
    expect(result.document).toBe(doc);
  });

  it("never touches non-text objects", () => {
    const state = createEditorState();
    let page = getActivePage(state);
    page = addObjectToPage(page, makeRect());
    const doc = { ...state.document, pages: [page] };
    expect(normalizeImportedText(doc).document).toBe(doc);
  });

  it("leaves an object that already carries a capability mode alone", () => {
    // Only LEGACY markers (no mode) are reclassified. A run already assessed
    // must not be re-decided on every load.
    const modern = makeTextObject({
      text: "Original line",
      background: null,
      sourceText: { fontName: "Helvetica", rotation: 0, mode: "readonly", reason: "because" },
    });
    const result = normalizeImportedText(docWith(modern));
    const obj = Object.values(result.document.pages[0].objects)[0] as TextObject;
    expect(obj.sourceText?.reason).toBe("because");
    expect(result.suppressed).toBe(0);
  });
});

describe("isUnchangedLegacyCopy", () => {
  beforeEach(() => resetFactory());

  it("uses originalText when present — the reliable signal", () => {
    const unchanged = makeTextObject({
      text: "Hello",
      sourceText: { originalText: "Hello" },
    });
    const changed = makeTextObject({
      text: "Goodbye",
      sourceText: { originalText: "Hello" },
    });
    expect(isUnchangedLegacyCopy(unchanged)).toBe(true);
    expect(isUnchangedLegacyCopy(changed)).toBe(false);
  });

  it("falls back to the importer-set name for genuinely old saves", () => {
    // The old importer set name = text.slice(0, 24) and nothing updated it when
    // the user typed, so a name still matching the prefix means untouched.
    expect(isUnchangedLegacyCopy(makeTextObject({ text: "Short line", name: "Short line" }))).toBe(true);
    expect(isUnchangedLegacyCopy(makeTextObject({ text: "User typed this", name: "Short line" }))).toBe(false);
  });

  it("treats the importer's empty-run placeholder name as unchanged", () => {
    expect(isUnchangedLegacyCopy(makeTextObject({ text: "anything", name: "Existing text" }))).toBe(true);
  });
});
