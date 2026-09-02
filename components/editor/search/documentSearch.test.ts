import { describe, expect, it } from "vitest";
import {
  describeScope,
  searchDocument,
  stepMatch,
} from "@/components/editor/search/documentSearch";
import { addObjectToPage, createDocument, createPage } from "@/src/domain/editor/document";
import type { EditorDocument, EditorPage } from "@/src/domain/editor/document";
import type { EditorObject, TextObject } from "@/src/domain/editor/objects";
import { createTextObject } from "@/src/domain/editor/objectFactories";

/**
 * Builds a one-page document containing the given text runs, in order.
 * `imported: true` marks a run as imported (readonly) PDF text — the case that
 * must remain searchable.
 */
function docWithTexts(runs: Array<{ text: string; imported?: boolean }>): EditorDocument {
  let page: EditorPage = createPage("page-1", 600, 800);
  const layerId = page.layerStack.layers[0].id;
  runs.forEach((run, i) => {
    const base = createTextObject({ x: 0, y: i * 20 }, layerId, {
      id: `t${i}`,
      text: run.text,
    });
    const obj: TextObject = run.imported
      ? { ...base, sourceText: { mode: "readonly", originalText: run.text } }
      : base;
    page = addObjectToPage(page, obj as EditorObject, layerId);
  });
  const doc = createDocument();
  return { ...doc, pages: [page] };
}

describe("documentSearch — finds text in the OPEN document", () => {
  it("finds a simple match and reports its page and offsets", () => {
    const doc = docWithTexts([{ text: "Hello world" }]);
    const { matches } = searchDocument(doc, "world");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      pageIndex: 0,
      pageNumber: 1,
      objectId: "t0",
      start: 6,
      end: 11,
      text: "world",
      readonlySource: false,
    });
  });

  it("is case-insensitive by default and case-sensitive on request", () => {
    const doc = docWithTexts([{ text: "Proposal PROPOSAL proposal" }]);
    expect(searchDocument(doc, "proposal").matches).toHaveLength(3);
    expect(searchDocument(doc, "PROPOSAL", { caseSensitive: true }).matches).toHaveLength(1);
    // Original casing is preserved in the result, not the query's casing.
    expect(searchDocument(doc, "proposal").matches[1].text).toBe("PROPOSAL");
  });

  it("finds every occurrence within one object, not just the first", () => {
    const doc = docWithTexts([{ text: "a b a b a" }]);
    expect(searchDocument(doc, "a").matches.map((m) => m.start)).toEqual([0, 4, 8]);
  });

  it("returns matches in page then paint order", () => {
    const doc = docWithTexts([{ text: "first hit" }, { text: "second hit" }]);
    const ids = searchDocument(doc, "hit").matches.map((m) => m.objectId);
    expect(ids).toEqual(["t0", "t1"]);
  });

  /**
   * The whole reason this module exists rather than reusing workspace search:
   * imported PDF text is in the object model, so it MUST be searchable. If this
   * regressed, search would only find the user's own additions while appearing
   * to search the document.
   */
  it("searches imported (readonly) PDF text, and flags it as readonly", () => {
    const doc = docWithTexts([
      { text: "editable addition" },
      { text: "imported original text", imported: true },
    ]);
    const matches = searchDocument(doc, "text");
    expect(matches.matches).toHaveLength(1);
    expect(matches.matches[0].objectId).toBe("t1");
    expect(matches.matches[0].readonlySource).toBe(true);

    // And both kinds are found by a query that hits each.
    const both = searchDocument(doc, "i");
    expect(both.matches.length).toBeGreaterThanOrEqual(2);
    expect(new Set(both.matches.map((m) => m.objectId))).toEqual(new Set(["t0", "t1"]));
  });

  it("supports whole-word matching", () => {
    const doc = docWithTexts([{ text: "cat concatenate cats cat." }]);
    expect(searchDocument(doc, "cat").matches).toHaveLength(4);
    const whole = searchDocument(doc, "cat", { wholeWord: true });
    // "cat", and "cat." (punctuation is a boundary) — but not "concatenate"/"cats".
    expect(whole.matches.map((m) => m.start)).toEqual([0, 21]);
  });

  it("treats the query as literal text, not a regex", () => {
    const doc = docWithTexts([{ text: "price (net) is 5.00 and a*b" }]);
    // Each of these would throw or over-match if interpolated into a RegExp.
    expect(searchDocument(doc, "(net)").matches).toHaveLength(1);
    expect(searchDocument(doc, "a*b").matches).toHaveLength(1);
    expect(searchDocument(doc, "5.00").matches).toHaveLength(1);
    // "5x00" must NOT match "5.00" — proof the dot is escaped.
    expect(searchDocument(doc, "5x00").matches).toHaveLength(0);
    // An unbalanced bracket is a normal query, not a crash.
    expect(() => searchDocument(doc, "(")).not.toThrow();
    expect(searchDocument(doc, "(").matches).toHaveLength(1);
  });

  it("returns no matches (and does not search) for an empty query", () => {
    const doc = docWithTexts([{ text: "anything" }]);
    for (const q of ["", "   "]) {
      expect(searchDocument(doc, q).matches).toEqual([]);
    }
    // Scope is still reported so the UI can describe the document.
    expect(searchDocument(doc, "").scope.textObjects).toBe(1);
  });

  it("caps results and reports truncation instead of silently dropping hits", () => {
    const doc = docWithTexts([{ text: "x".repeat(50) }]);
    const res = searchDocument(doc, "x", { limit: 10 });
    expect(res.matches).toHaveLength(10);
    expect(res.scope.truncated).toBe(true);
    expect(searchDocument(doc, "x", { limit: 999 }).scope.truncated).toBe(false);
  });

  it("produces a snippet with the hit offset inside it", () => {
    const long = `${"before ".repeat(20)}NEEDLE${" after".repeat(20)}`;
    const doc = docWithTexts([{ text: long }]);
    const m = searchDocument(doc, "NEEDLE").matches[0];
    expect(m.snippet).toContain("NEEDLE");
    // The recorded offset must actually point at the hit within the snippet.
    expect(m.snippet.slice(m.snippetStart, m.snippetStart + 6)).toBe("NEEDLE");
    expect(m.snippet.startsWith("…")).toBe(true);
  });

  it("searches across multiple pages with correct page numbers", () => {
    const a = docWithTexts([{ text: "target on one" }]);
    const b = docWithTexts([{ text: "target on two" }]);
    const doc: EditorDocument = { ...a, pages: [a.pages[0], b.pages[0]] };
    const matches = searchDocument(doc, "target").matches;
    expect(matches.map((m) => m.pageNumber)).toEqual([1, 2]);
    expect(matches.map((m) => m.pageIndex)).toEqual([0, 1]);
  });
});

describe("documentSearch — honest scope reporting", () => {
  it("counts text objects and imported text objects", () => {
    const doc = docWithTexts([
      { text: "one" },
      { text: "two", imported: true },
      { text: "three", imported: true },
    ]);
    const { scope } = searchDocument(doc, "");
    expect(scope.textObjects).toBe(3);
    expect(scope.importedTextObjects).toBe(2);
  });

  it("says a text-free document is not searchable rather than 'no results'", () => {
    // A scanned PDF: a full-page image and no text objects at all.
    let page = createPage("page-1", 600, 800);
    const layerId = page.layerStack.layers[0].id;
    const img = {
      id: "img0",
      kind: "image" as const,
      name: "Scan",
      layerId,
      transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      localBounds: { x: 0, y: 0, width: 600, height: 800 },
      opacity: 1,
      locked: false,
      hidden: false,
      src: "data:image/png;base64,AA",
      naturalWidth: 600,
      naturalHeight: 800,
    } as unknown as EditorObject;
    page = addObjectToPage(page, img, layerId);
    const base = createDocument();
    const doc: EditorDocument = { ...base, pages: [page] };

    const { scope } = searchDocument(doc, "anything");
    expect(scope.textObjects).toBe(0);
    expect(scope.unsearchableObjects).toBe(1);
    const message = describeScope(scope);
    expect(message).toMatch(/no searchable text/i);
    expect(message).toMatch(/scan/i);
  });

  it("warns about image text when a document mixes both", () => {
    const doc = docWithTexts([{ text: "hello" }]);
    const scope = { ...searchDocument(doc, "").scope, unsearchableObjects: 2 };
    expect(describeScope(scope)).toMatch(/inside images cannot be searched/i);
  });

  it("says nothing when there is nothing to warn about", () => {
    const doc = docWithTexts([{ text: "hello" }]);
    expect(describeScope(searchDocument(doc, "").scope)).toBeNull();
  });
});

describe("documentSearch — stepMatch navigation", () => {
  it("wraps forward and backward", () => {
    expect(stepMatch(0, 3, 1)).toBe(1);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(1, 3, -1)).toBe(0);
  });

  it("never returns a negative or out-of-range index", () => {
    for (const total of [0, 1, 5]) {
      for (const current of [-3, 0, 4, 99]) {
        for (const delta of [-5, -1, 1, 7]) {
          const next = stepMatch(current, total, delta);
          expect(next).toBeGreaterThanOrEqual(0);
          if (total > 0) expect(next).toBeLessThan(total);
        }
      }
    }
  });

  it("returns 0 for an empty match list (never -1)", () => {
    expect(stepMatch(0, 0, 1)).toBe(0);
    expect(stepMatch(5, 0, -1)).toBe(0);
  });
});
