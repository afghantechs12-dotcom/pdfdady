import { beforeEach, describe, expect, it } from "vitest";
import {
  addObjectToPage,
  createEditorState,
  createPage,
  type EditorPage,
  type EditorState,
} from "./document";
import {
  clonePage,
  createBlankPage,
  duplicatePage,
  insertPageAt,
  isPageRotation,
  movePage,
  removePage,
  setPageRotation,
  setPageSize,
} from "./pageOperations";
import { makeRect, makeTextObject, resetFactory } from "./testFactories";

/**
 * Tests for the pure page operations (M6). They assert the documented
 * invariants: index clamping, the never-empty-document rule, active-page
 * reassignment, selection cleanup, and clone id freshness with intact layer
 * stacks.
 */

let idCounter = 0;
const nextId = (prefix = "id") => `${prefix}-copy-${++idCounter}`;

/** A state with `count` pages, each carrying a `sourcePageIndex` of its index. */
function stateWithPages(count: number): EditorState {
  const base = createEditorState("doc", "page-0");
  const pages: EditorPage[] = [];
  for (let i = 0; i < count; i++) {
    pages.push(createPage(`page-${i}`, 595, 842, 0, i));
  }
  return { ...base, document: { ...base.document, pages }, activePageId: "page-0" };
}

const pageIds = (state: EditorState) => state.document.pages.map((p) => p.id);

describe("pageOperations: createBlankPage + isPageRotation", () => {
  it("createBlankPage has no source page and the requested size", () => {
    const page = createBlankPage("p-new", 400, 300);
    expect(page.sourcePageIndex).toBeNull();
    expect(page.width).toBe(400);
    expect(page.height).toBe(300);
    expect(page.rotation).toBe(0);
    expect(page.layerStack.layers).toHaveLength(1);
  });

  it("createPage defaults sourcePageIndex to null and accepts an explicit index", () => {
    expect(createPage("p").sourcePageIndex).toBeNull();
    expect(createPage("p", 595, 842, 0, 3).sourcePageIndex).toBe(3);
  });

  it("isPageRotation accepts only the four quadrants", () => {
    expect([0, 90, 180, 270].every(isPageRotation)).toBe(true);
    expect([45, -90, 360, 1.5, NaN].some(isPageRotation)).toBe(false);
  });
});

describe("pageOperations: insertPageAt", () => {
  it("inserts at an in-range index", () => {
    const state = insertPageAt(stateWithPages(3), createBlankPage("new"), 1);
    expect(pageIds(state)).toEqual(["page-0", "new", "page-1", "page-2"]);
  });

  it("clamps a negative index to the front", () => {
    const state = insertPageAt(stateWithPages(2), createBlankPage("new"), -5);
    expect(pageIds(state)).toEqual(["new", "page-0", "page-1"]);
  });

  it("clamps a past-the-end index to the back", () => {
    const state = insertPageAt(stateWithPages(2), createBlankPage("new"), 99);
    expect(pageIds(state)).toEqual(["page-0", "page-1", "new"]);
  });

  it("refuses a duplicate page id and does not mutate the input state", () => {
    const before = stateWithPages(2);
    const after = insertPageAt(before, createBlankPage("page-1"), 0);
    expect(after).toBe(before);
    expect(pageIds(before)).toEqual(["page-0", "page-1"]);
  });
});

describe("pageOperations: removePage", () => {
  it("removes a page and keeps the rest in order", () => {
    const state = removePage(stateWithPages(3), "page-1");
    expect(pageIds(state)).toEqual(["page-0", "page-2"]);
  });

  it("refuses to remove the last remaining page", () => {
    const before = stateWithPages(1);
    expect(removePage(before, "page-0")).toBe(before);
    expect(before.document.pages).toHaveLength(1);
  });

  it("returns the same state for an unknown page id", () => {
    const before = stateWithPages(2);
    expect(removePage(before, "nope")).toBe(before);
  });

  it("activates the page AFTER the removed active page", () => {
    const state = removePage(stateWithPages(3), "page-0");
    expect(state.activePageId).toBe("page-1");
  });

  it("activates the page BEFORE when the last page was active", () => {
    const base = { ...stateWithPages(3), activePageId: "page-2" };
    const state = removePage(base, "page-2");
    expect(state.activePageId).toBe("page-1");
  });

  it("leaves the active page alone when a different page is removed", () => {
    const state = removePage(stateWithPages(3), "page-2");
    expect(state.activePageId).toBe("page-0");
  });

  it("clears selection entries that lived on the removed page", () => {
    resetFactory();
    const base = stateWithPages(2);
    const onRemoved = makeRect();
    const onKept = makeRect();
    const pages = [
      addObjectToPage(base.document.pages[0], onKept),
      addObjectToPage(base.document.pages[1], onRemoved),
    ];
    const state: EditorState = {
      ...base,
      document: { ...base.document, pages },
      selection: { ids: [onKept.id, onRemoved.id], primaryId: onRemoved.id },
    };

    const after = removePage(state, "page-1");
    expect(after.selection.ids).toEqual([onKept.id]);
    expect(after.selection.primaryId).toBeNull();
  });

  it("keeps the selection reference when nothing selected was on the removed page", () => {
    resetFactory();
    const base = stateWithPages(2);
    const kept = makeTextObject();
    const pages = [addObjectToPage(base.document.pages[0], kept), base.document.pages[1]];
    const selection = { ids: [kept.id], primaryId: kept.id };
    const state: EditorState = { ...base, document: { ...base.document, pages }, selection };

    const after = removePage(state, "page-1");
    expect(after.selection).toBe(selection);
  });
});

describe("pageOperations: duplicatePage / clonePage", () => {
  beforeEach(() => {
    resetFactory();
    idCounter = 0;
  });

  /** A 2-page state whose first page has two objects across two layers. */
  function stateWithPopulatedPage(): EditorState {
    const base = stateWithPages(2);
    const a = makeRect();
    const b = makeTextObject();
    let page = addObjectToPage(base.document.pages[0], a);
    page = addObjectToPage(page, b);
    return { ...base, document: { ...base.document, pages: [page, base.document.pages[1]] } };
  }

  it("inserts the copy immediately after the source page", () => {
    const state = duplicatePage(stateWithPopulatedPage(), "page-0", "page-copy", nextId);
    expect(pageIds(state)).toEqual(["page-0", "page-copy", "page-1"]);
  });

  it("gives every cloned object and layer a fresh id", () => {
    const before = stateWithPopulatedPage();
    const state = duplicatePage(before, "page-0", "page-copy", nextId);
    const source = state.document.pages[0];
    const copy = state.document.pages[1];

    const sourceObjectIds = Object.keys(source.objects);
    const copyObjectIds = Object.keys(copy.objects);
    expect(copyObjectIds).toHaveLength(sourceObjectIds.length);
    expect(copyObjectIds.some((id) => sourceObjectIds.includes(id))).toBe(false);
    const sourceLayerIds = source.layerStack.layers.map((l) => l.id);
    const copyLayerIds = copy.layerStack.layers.map((l) => l.id);
    expect(copyLayerIds.some((id) => sourceLayerIds.includes(id))).toBe(false);
    // Every cloned object points at a layer that exists on the CLONE.
    for (const obj of Object.values(copy.objects)) {
      expect(copyLayerIds).toContain(obj.layerId);
    }
  });

  it("keeps layer stack order and object paint order on the clone", () => {
    const before = stateWithPopulatedPage();
    const sourceOrder = before.document.pages[0].layerStack.layers[0].objectIds;
    const state = duplicatePage(before, "page-0", "page-copy", nextId);
    const copy = state.document.pages[1];
    const copyOrder = copy.layerStack.layers[0].objectIds;

    expect(copyOrder).toHaveLength(sourceOrder.length);
    // Same ORDER: the i-th cloned id maps back to the i-th source object's name.
    const sourceNames = sourceOrder.map((id) => before.document.pages[0].objects[id].name);
    const copyNames = copyOrder.map((id) => copy.objects[id].name);
    expect(copyNames).toEqual(sourceNames);
    // Every id in the clone's layer resolves in the clone's object map.
    for (const id of copyOrder) expect(copy.objects[id]).toBeDefined();
  });

  it("keeps sourcePageIndex, rotation, size, and background on the clone", () => {
    const base = stateWithPages(2);
    const source: EditorPage = {
      ...createPage("page-0", 400, 500, 90, 7),
      background: { type: "color", color: "#abcdef" },
    };
    const state = duplicatePage(
      { ...base, document: { ...base.document, pages: [source, base.document.pages[1]] } },
      "page-0",
      "page-copy",
      nextId,
    );
    const copy = state.document.pages[1];
    expect(copy.sourcePageIndex).toBe(7);
    expect(copy.rotation).toBe(90);
    expect(copy.width).toBe(400);
    expect(copy.height).toBe(500);
    expect(copy.background).toEqual({ type: "color", color: "#abcdef" });
  });

  it("returns the same state for an unknown source page", () => {
    const before = stateWithPages(2);
    expect(duplicatePage(before, "nope", "page-copy", nextId)).toBe(before);
  });

  it("clonePage re-ids objects that no layer references (orphans)", () => {
    const orphan = makeRect();
    const page: EditorPage = {
      ...createPage("page-x"),
      objects: { [orphan.id]: orphan },
    };
    const copy = clonePage(page, "page-x-copy", nextId);
    expect(Object.keys(copy.objects)).toHaveLength(1);
    expect(copy.objects[orphan.id]).toBeUndefined();
  });

  it("clonePage shallow-copies metadata so edits don't leak between pages", () => {
    const rect = makeRect({ metadata: { groupId: "g1" } });
    const page = addObjectToPage(createPage("page-x"), rect);
    const copy = clonePage(page, "page-x-copy", nextId);
    const cloned = Object.values(copy.objects)[0];
    expect(cloned.metadata).toEqual({ groupId: "g1" });
    expect(cloned.metadata).not.toBe(rect.metadata);
  });
});

describe("pageOperations: movePage", () => {
  it("moves a page forward", () => {
    const state = movePage(stateWithPages(4), "page-0", 2);
    expect(pageIds(state)).toEqual(["page-1", "page-2", "page-0", "page-3"]);
  });

  it("moves a page backward", () => {
    const state = movePage(stateWithPages(4), "page-3", 1);
    expect(pageIds(state)).toEqual(["page-0", "page-3", "page-1", "page-2"]);
  });

  it("clamps an out-of-range target index", () => {
    expect(pageIds(movePage(stateWithPages(3), "page-2", 99))).toEqual(["page-0", "page-1", "page-2"]);
    expect(pageIds(movePage(stateWithPages(3), "page-2", -4))).toEqual(["page-2", "page-0", "page-1"]);
  });

  it("returns the same state for a no-op move or unknown page", () => {
    const before = stateWithPages(3);
    expect(movePage(before, "page-1", 1)).toBe(before);
    expect(movePage(before, "nope", 0)).toBe(before);
  });
});

describe("pageOperations: setPageRotation", () => {
  it("sets a valid rotation", () => {
    const state = setPageRotation(stateWithPages(2), "page-1", 270);
    expect(state.document.pages[1].rotation).toBe(270);
    expect(state.document.pages[0].rotation).toBe(0);
  });

  it("throws on an invalid rotation", () => {
    const before = stateWithPages(1);
    expect(() => setPageRotation(before, "page-0", 45 as 0)).toThrow(/Invalid page rotation/);
    expect(() => setPageRotation(before, "page-0", -90 as 0)).toThrow(/Invalid page rotation/);
  });

  it("returns the same state for an unknown page or an unchanged rotation", () => {
    const before = stateWithPages(2);
    expect(setPageRotation(before, "nope", 90)).toBe(before);
    expect(setPageRotation(before, "page-0", 0)).toBe(before);
  });
});

describe("pageOperations: setPageSize", () => {
  it("sets a positive finite size", () => {
    const state = setPageSize(stateWithPages(2), "page-0", 200.5, 300);
    expect(state.document.pages[0].width).toBe(200.5);
    expect(state.document.pages[0].height).toBe(300);
  });

  it("throws on a non-positive or non-finite dimension", () => {
    const before = stateWithPages(1);
    expect(() => setPageSize(before, "page-0", 0, 100)).toThrow(/Invalid page size/);
    expect(() => setPageSize(before, "page-0", 100, -1)).toThrow(/Invalid page size/);
    expect(() => setPageSize(before, "page-0", NaN, 100)).toThrow(/Invalid page size/);
    expect(() => setPageSize(before, "page-0", Infinity, 100)).toThrow(/Invalid page size/);
  });

  it("returns the same state for an unknown page or an unchanged size", () => {
    const before = stateWithPages(2);
    expect(setPageSize(before, "nope", 100, 100)).toBe(before);
    expect(setPageSize(before, "page-0", 595, 842)).toBe(before);
  });

  it("does not move objects when the page shrinks", () => {
    resetFactory();
    const base = stateWithPages(1);
    const rect = makeRect();
    const page = addObjectToPage(base.document.pages[0], rect);
    const state = setPageSize(
      { ...base, document: { ...base.document, pages: [page] } },
      "page-0",
      100,
      100,
    );
    expect(state.document.pages[0].objects[rect.id].transform).toEqual(rect.transform);
  });
});
