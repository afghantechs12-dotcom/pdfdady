import { beforeEach, describe, expect, it } from "vitest";
import { makeTranslate } from "./geometry";
import {
  addObjectToPage,
  createEditorState,
  createPage,
  getActivePage,
  getObject,
  pageObjects,
  removeObjectFromPage,
  setActivePage,
  setObject,
  setSelection,
  worldBounds,
} from "./document";
import { makeRect, makeTextObject, resetFactory } from "./testFactories";

describe("editor document", () => {
  beforeEach(() => resetFactory());

  it("createEditorState yields a single blank A4 page with empty selection", () => {
    const state = createEditorState();
    expect(state.document.pages).toHaveLength(1);
    const page = getActivePage(state);
    expect(page.width).toBe(595);
    expect(page.height).toBe(842);
    expect(pageObjects(page)).toHaveLength(0);
    expect(state.selection.ids).toEqual([]);
  });

  it("createPage accepts a custom size and rotation", () => {
    const page = createPage("p", 400, 300, 90);
    expect(page.rotation).toBe(90);
    expect(page.width).toBe(400);
  });

  it("addObjectToPage appends to the top layer and registers the object", () => {
    const state = createEditorState();
    const page = getActivePage(state);
    const next = addObjectToPage(page, makeRect());
    expect(pageObjects(next)).toHaveLength(1);
    expect(next.objects["obj-1"]).toBeDefined();
  });

  it("removeObjectFromPage drops the object from map and layer", () => {
    const state = createEditorState();
    let page = getActivePage(state);
    const rect = makeRect();
    page = addObjectToPage(page, rect);
    const after = removeObjectFromPage(page, rect.id);
    expect(after.objects[rect.id]).toBeUndefined();
    expect(pageObjects(after)).toHaveLength(0);
  });

  it("pageObjects returns paint order (bottom-most first)", () => {
    const state = createEditorState();
    let page = getActivePage(state);
    const r1 = makeRect();
    const r2 = makeRect();
    page = addObjectToPage(page, r1);
    page = addObjectToPage(page, r2);
    expect(pageObjects(page).map((o) => o.id)).toEqual([r1.id, r2.id]);
  });

  it("setObject produces a new page with the replaced object (no mutation)", () => {
    const state = createEditorState();
    let page = getActivePage(state);
    const rect = makeRect();
    page = addObjectToPage(page, rect);
    const moved = { ...rect, transform: makeTranslate(99, 88) };
    const next = setObject(page, moved);
    expect(getObject(next, rect.id)?.transform.e).toBe(99);
    // Original page untouched.
    expect(getObject(page, rect.id)?.transform.e).toBe(0);
  });

  it("worldBounds applies the object's transform to its local bounds", () => {
    const text = makeTextObject(); // translate(10,20), local 100x20 at origin
    const wb = worldBounds(text);
    expect(wb).toEqual({ x: 10, y: 20, width: 100, height: 20 });
  });

  it("setActivePage and setSelection are non-destructive", () => {
    const state = createEditorState();
    const next = setSelection(state, { ids: ["x"], primaryId: "x" });
    expect(next.selection.ids).toEqual(["x"]);
    expect(state.selection.ids).toEqual([]);
    const page = getActivePage(state);
    const moved = setActivePage(state, addObjectToPage(page, makeRect()));
    expect(pageObjects(getActivePage(moved))).toHaveLength(1);
    expect(pageObjects(getActivePage(state))).toHaveLength(0);
  });
});
