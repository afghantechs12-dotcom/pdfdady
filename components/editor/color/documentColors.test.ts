import { describe, expect, it, beforeEach } from "vitest";
import { collectDocumentColors } from "./documentColors";
import { formatHex } from "@/src/domain/editor/colorModel";
import { addObjectsToPage, createDocument, createPage } from "@/src/domain/editor/document";
import type { EditorDocument } from "@/src/domain/editor/document";
import {
  makeAnnotation,
  makeDrawing,
  makeHighlight,
  makeImage,
  makeRect,
  makeTextObject,
  resetFactory,
} from "@/src/domain/editor/testFactories";
import type { EditorObject } from "@/src/domain/editor/objects";


const RED = { r: 1, g: 0, b: 0, a: 1 };
const GREEN = { r: 0, g: 1, b: 0, a: 1 };
const BLUE = { r: 0, g: 0, b: 1, a: 1 };

function docWith(objects: EditorObject[], secondPage: EditorObject[] = []): EditorDocument {
  // Built from the real `createDocument` so `version`/`metadata` are whatever
  // production uses; only the pages are swapped.
  const page = addObjectsToPage(createPage("page-1", 595, 842), objects);
  const page2 = addObjectsToPage(createPage("page-2", 595, 842), secondPage);
  return {
    ...createDocument("doc-1", "page-1"),
    pages: secondPage.length > 0 ? [page, page2] : [page],
  };
}

beforeEach(() => resetFactory());

describe("documentColors: collectDocumentColors", () => {
  it("returns nothing for a document with no objects", () => {
    expect(collectDocumentColors(docWith([]))).toEqual([]);
  });

  it("collects a text object's colour", () => {
    const doc = docWith([makeTextObject({ color: RED })]);
    expect(collectDocumentColors(doc).map((c) => formatHex(c))).toContain("#FF0000");
  });

  it("collects a text object's frame background as well as its ink", () => {
    // Both are author-chosen colours a user may want to match.
    const doc = docWith([makeTextObject({ color: RED, background: GREEN })]);
    const hexes = collectDocumentColors(doc).map((c) => formatHex(c));
    expect(hexes).toContain("#FF0000");
    expect(hexes).toContain("#00FF00");
  });

  it("collects a shape's fill, stroke and shadow colour", () => {
    const doc = docWith([
      makeRect({
        style: {
          fill: RED,
          stroke: GREEN,
          strokeWidth: 2,
          cornerRadius: 0,
          shadow: { offsetX: 2, offsetY: 2, blur: 4, color: BLUE },
        },
      }),
    ]);
    const hexes = collectDocumentColors(doc).map((c) => formatHex(c));
    expect(hexes).toEqual(expect.arrayContaining(["#FF0000", "#00FF00", "#0000FF"]));
  });

  it("collects highlight, drawing-stroke and annotation colours", () => {
    const doc = docWith([
      makeHighlight({ color: RED }),
      makeDrawing({ style: { fill: null, stroke: GREEN, strokeWidth: 2, cornerRadius: 0 } }),
      makeAnnotation({ color: BLUE }),
    ]);
    const hexes = collectDocumentColors(doc).map((c) => formatHex(c));
    expect(hexes).toEqual(expect.arrayContaining(["#FF0000", "#00FF00", "#0000FF"]));
  });

  it("contributes nothing for kinds that carry no author-chosen colour", () => {
    // An image has no colour field; inventing one would put a meaningless
    // swatch in the row.
    expect(collectDocumentColors(docWith([makeImage()]))).toEqual([]);
  });

  it("skips null fills and strokes rather than emitting a placeholder", () => {
    const doc = docWith([makeRect({ style: { fill: null, stroke: null, strokeWidth: 0, cornerRadius: 0 } })]);
    expect(collectDocumentColors(doc)).toEqual([]);
  });

  it("de-duplicates a colour used by many objects into one swatch", () => {
    const doc = docWith([
      makeTextObject({ color: RED }),
      makeHighlight({ color: RED }),
      makeAnnotation({ color: RED }),
    ]);
    expect(collectDocumentColors(doc)).toHaveLength(1);
  });

  it("walks every page, not just the active one", () => {
    // The palette is the DOCUMENT's, so a colour used only on page 2 is offered
    // while editing page 1.
    const doc = docWith([makeTextObject({ color: RED })], [makeTextObject({ color: BLUE })]);
    const hexes = collectDocumentColors(doc).map((c) => formatHex(c));
    expect(hexes).toEqual(expect.arrayContaining(["#FF0000", "#0000FF"]));
  });

  it("honours the swatch cap while still walking the whole document", () => {
    const many: EditorObject[] = [];
    for (let v = 0; v < 40; v += 1) many.push(makeTextObject({ color: { r: v / 40, g: 0, b: 0, a: 1 } }));
    expect(collectDocumentColors(docWith(many), 6)).toHaveLength(6);
  });

  it("returns colours opaque, since the row records hue choices not styles", () => {
    const doc = docWith([makeHighlight({ color: { ...RED, a: 0.3 } })]);
    const collected = collectDocumentColors(doc);
    expect(collected).toHaveLength(1);
    expect(collected[0].a).toBe(1);
  });

  it("is deterministic across repeated calls", () => {
    const doc = docWith([makeTextObject({ color: RED }), makeHighlight({ color: BLUE })]);
    expect(collectDocumentColors(doc)).toEqual(collectDocumentColors(doc));
  });
});
