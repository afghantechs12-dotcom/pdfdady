import { describe, expect, it } from "vitest";
import { createEditorState, createPage } from "@/src/domain/editor/document";
import type { EditorState } from "@/src/domain/editor/document";
import type { SerializedEditorState } from "@/src/application/editor/ports/ISerializer";
import {
  assembleRestoredBackgrounds,
  canRedrawFromSource,
  captureEditorDocument,
  planBackgroundRestore,
  readRestoredPages,
  type RestoredPage,
} from "./editorCapture";

const scene: SerializedEditorState = {
  format: "pdfdadi-editor",
  version: 5,
  document: { id: "doc-1", version: 5, pages: [], metadata: {} },
  activePageId: "page-1",
  selection: null,
};

/** A state with `count` pages, each carrying `objectsPerPage` objects. */
function stateWith(count: number, objectsPerPage = 0): EditorState {
  const base = createEditorState("doc-1", "page-1");
  const pages = Array.from({ length: count }, (_, index) => {
    const page = createPage(`page-${index + 1}`, 595, 842, 0, index);
    const objects: Record<string, unknown> = {};
    for (let n = 0; n < objectsPerPage; n += 1) {
      objects[`obj-${index}-${n}`] = { id: `obj-${index}-${n}`, kind: "rect" };
    }
    return { ...page, objects: objects as typeof page.objects };
  });
  return { ...base, document: { ...base.document, pages } };
}

const sceneFor = (pages: unknown): SerializedEditorState =>
  ({ ...scene, document: { id: "doc-1", version: 5, pages, metadata: {} } });

describe("capturing the live document", () => {
  it("counts the pages and every object on them", () => {
    const captured = captureEditorDocument({
      scene,
      state: stateWith(3, 4),
      sourceBytes: new Uint8Array([1, 2, 3]),
      sourceReference: "workspace:doc-1",
      documentName: "Contract",
    });
    expect(captured).not.toBeNull();
    expect(captured?.pageCount).toBe(3);
    // 3 pages x 4 objects. A count taken from the first page only, or from the
    // page array alone, is the shape of mistake this pins.
    expect(captured?.objectCount).toBe(12);
  });

  it("carries the scene, the bytes and the name through unchanged", () => {
    const bytes = new Uint8Array([9, 9, 9]);
    const captured = captureEditorDocument({
      scene,
      state: stateWith(1),
      sourceBytes: bytes,
      sourceReference: "workspace:doc-1",
      documentName: "Contract",
    });
    expect(captured?.scene).toBe(scene);
    expect(captured?.sourceBytes).toBe(bytes);
    expect(captured?.sourceReference).toBe("workspace:doc-1");
    expect(captured?.documentName).toBe("Contract");
  });

  it("counts an empty document as zero objects, not as nothing to save", () => {
    // An emptied document IS a change worth persisting: the user deleted
    // everything, and a capture that returned null would leave the draft holding
    // the pre-deletion document forever.
    const captured = captureEditorDocument({
      scene,
      state: stateWith(2, 0),
      sourceBytes: null,
      sourceReference: null,
      documentName: "Empty",
    });
    expect(captured?.objectCount).toBe(0);
    expect(captured?.pageCount).toBe(2);
  });

  it("declines to capture a document with no pages", () => {
    const base = createEditorState("doc-1", "page-1");
    const captured = captureEditorDocument({
      scene,
      state: { ...base, document: { ...base.document, pages: [] } },
      sourceBytes: null,
      sourceReference: null,
      documentName: "Nothing",
    });
    expect(captured).toBeNull();
  });

  it("survives a page whose objects record is missing", () => {
    /*
     * A throw inside `capture` reaches the scheduler as a failed write, and the
     * user is told saving failed when the truth is that one page was mid-migration.
     */
    const base = stateWith(2, 3);
    const pages = [...base.document.pages];
    pages[0] = { ...pages[0], objects: undefined as unknown as (typeof pages)[0]["objects"] };
    const captured = captureEditorDocument({
      scene,
      state: { ...base, document: { ...base.document, pages } },
      sourceBytes: null,
      sourceReference: null,
      documentName: "Partial",
    });
    expect(captured?.pageCount).toBe(2);
    expect(captured?.objectCount).toBe(3);
  });
});

describe("reading pages back out of a restored draft", () => {
  it("keeps each page's id and its pinned source index", () => {
    const pages = readRestoredPages(
      sceneFor([
        { id: "page-a", sourcePageIndex: 0 },
        { id: "page-b", sourcePageIndex: 4 },
      ]),
    );
    expect(pages).toEqual([
      { pageId: "page-a", sourcePageIndex: 0 },
      { pageId: "page-b", sourcePageIndex: 4 },
    ]);
  });

  it("treats a page inserted in the editor as having no source page", () => {
    const pages = readRestoredPages(sceneFor([{ id: "page-new", sourcePageIndex: null }]));
    expect(pages).toEqual([{ pageId: "page-new", sourcePageIndex: null }]);
  });

  it("never defaults an unreadable source index to page one", () => {
    /*
     * The mistake this exists for: `?? 0`. Every one of these values would then
     * paint the FIRST page of the PDF onto an unrelated page, which looks exactly
     * like a corrupted document.
     */
    for (const raw of [undefined, "2", -1, 1.5, Number.NaN, {}, [], true]) {
      const pages = readRestoredPages(sceneFor([{ id: "page-x", sourcePageIndex: raw }]));
      expect(pages, `sourcePageIndex: ${JSON.stringify(raw)}`).toEqual([
        { pageId: "page-x", sourcePageIndex: null },
      ]);
    }
  });

  it("skips a page with no usable id rather than restoring a nameless page", () => {
    const pages = readRestoredPages(
      sceneFor([
        { id: "page-a", sourcePageIndex: 0 },
        { id: "", sourcePageIndex: 1 },
        { sourcePageIndex: 2 },
        null,
        "page-c",
        { id: "page-d", sourcePageIndex: 3 },
      ]),
    );
    expect(pages.map((page) => page.pageId)).toEqual(["page-a", "page-d"]);
  });

  it("returns nothing for a scene it cannot read at all", () => {
    expect(readRestoredPages(sceneFor(undefined))).toEqual([]);
    expect(readRestoredPages(sceneFor("pages"))).toEqual([]);
    expect(readRestoredPages({ ...scene, document: null })).toEqual([]);
    expect(readRestoredPages({ ...scene, document: "nope" as unknown })).toEqual([]);
  });
});

describe("planning which source pages to rasterise", () => {
  it("asks for each source page once, front to back", () => {
    const pages: RestoredPage[] = [
      { pageId: "p3", sourcePageIndex: 2 },
      { pageId: "p1", sourcePageIndex: 0 },
      { pageId: "p2", sourcePageIndex: 1 },
    ];
    expect(planBackgroundRestore(pages)).toEqual([0, 1, 2]);
  });

  it("asks once for a page that was duplicated", () => {
    // Two editor pages pinned to one source page. Rendering it twice is wasted
    // work at the slowest moment in the app.
    const pages: RestoredPage[] = [
      { pageId: "p1", sourcePageIndex: 1 },
      { pageId: "p1-copy", sourcePageIndex: 1 },
      { pageId: "p2", sourcePageIndex: 3 },
    ];
    expect(planBackgroundRestore(pages)).toEqual([1, 3]);
  });

  it("asks for nothing when every page was created in the editor", () => {
    expect(
      planBackgroundRestore([
        { pageId: "p1", sourcePageIndex: null },
        { pageId: "p2", sourcePageIndex: null },
      ]),
    ).toEqual([]);
  });
});

describe("assembling the backgrounds a restored document renders", () => {
  it("gives every page the raster of its own source page", () => {
    const pages: RestoredPage[] = [
      { pageId: "p1", sourcePageIndex: 0 },
      { pageId: "p2", sourcePageIndex: 1 },
    ];
    const backgrounds = assembleRestoredBackgrounds(
      pages,
      new Map([
        [0, "data:image/png;base64,ZERO"],
        [1, "data:image/png;base64,ONE"],
      ]),
    );
    expect(backgrounds.get("p1")).toBe("data:image/png;base64,ZERO");
    expect(backgrounds.get("p2")).toBe("data:image/png;base64,ONE");
  });

  it("keys on the pinned source page, not on position", () => {
    /*
     * The document was reordered before the crash: page 3 of the source is now
     * first. Keying on array position would show the reader page one's image
     * where page three's content is — a silent visual corruption, and one the
     * user cannot correct because the content underneath is right.
     */
    const pages: RestoredPage[] = [
      { pageId: "p-third", sourcePageIndex: 2 },
      { pageId: "p-first", sourcePageIndex: 0 },
    ];
    const backgrounds = assembleRestoredBackgrounds(
      pages,
      new Map([
        [0, "FIRST"],
        [2, "THIRD"],
      ]),
    );
    expect(backgrounds.get("p-third")).toBe("THIRD");
    expect(backgrounds.get("p-first")).toBe("FIRST");
  });

  it("gives a duplicated page the same raster as its original", () => {
    const backgrounds = assembleRestoredBackgrounds(
      [
        { pageId: "p1", sourcePageIndex: 1 },
        { pageId: "p1-copy", sourcePageIndex: 1 },
      ],
      new Map([[1, "ONE"]]),
    );
    expect(backgrounds.get("p1")).toBe("ONE");
    expect(backgrounds.get("p1-copy")).toBe("ONE");
  });

  it("gives a page with no raster an explicit white background", () => {
    // An ABSENT key reads as "not loaded yet" downstream and shows a loading
    // state that never ends; an empty string is the open path's own white value.
    const backgrounds = assembleRestoredBackgrounds(
      [
        { pageId: "p-inserted", sourcePageIndex: null },
        { pageId: "p-beyond", sourcePageIndex: 99 },
      ],
      new Map([[0, "ZERO"]]),
    );
    expect(backgrounds.has("p-inserted")).toBe(true);
    expect(backgrounds.get("p-inserted")).toBe("");
    expect(backgrounds.has("p-beyond")).toBe(true);
    expect(backgrounds.get("p-beyond")).toBe("");
  });

  it("covers every restored page", () => {
    const pages: RestoredPage[] = Array.from({ length: 5 }, (_, index) => ({
      pageId: `p${index}`,
      sourcePageIndex: index % 2 === 0 ? index : null,
    }));
    const backgrounds = assembleRestoredBackgrounds(pages, new Map([[0, "ZERO"]]));
    expect(backgrounds.size).toBe(5);
  });
});

describe("whether a restored draft can be redrawn", () => {
  it("can when the draft carries the source bytes", () => {
    expect(
      canRedrawFromSource({
        pages: [{ pageId: "p1", sourcePageIndex: 0 }],
        sourceBytes: new Uint8Array([1]),
      }),
    ).toBe(true);
  });

  it("cannot when pages need a source the draft no longer has", () => {
    // Not a reason to refuse the restore — a reason to stop calling it complete.
    expect(
      canRedrawFromSource({
        pages: [{ pageId: "p1", sourcePageIndex: 0 }],
        sourceBytes: null,
      }),
    ).toBe(false);
    expect(
      canRedrawFromSource({
        pages: [{ pageId: "p1", sourcePageIndex: 0 }],
        sourceBytes: new Uint8Array(),
      }),
    ).toBe(false);
  });

  it("can when nothing on screen came from a source PDF", () => {
    // A document built from scratch in the editor has no raster to lose.
    expect(
      canRedrawFromSource({
        pages: [
          { pageId: "p1", sourcePageIndex: null },
          { pageId: "p2", sourcePageIndex: null },
        ],
        sourceBytes: null,
      }),
    ).toBe(true);
  });
});
