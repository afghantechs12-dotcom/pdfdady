import { beforeEach, describe, expect, it } from "vitest";
import {
  addObjectToPage,
  createEditorState,
  getActivePage,
} from "@/src/domain/editor/document";
import { makeRect, resetFactory } from "@/src/domain/editor/testFactories";
import { SelectionService } from "./SelectionService";

describe("SelectionService", () => {
  let svc: SelectionService;

  beforeEach(() => {
    resetFactory();
    svc = new SelectionService();
  });

  it("select replaces with a single primary", () => {
    const sel = svc.select("a");
    expect(sel).toEqual({ ids: ["a"], primaryId: "a" });
  });

  it("add appends and promotes to primary; existing id just promotes", () => {
    const sel = svc.select("a");
    expect(svc.add(sel, "b")).toEqual({ ids: ["a", "b"], primaryId: "b" });
    // Adding an already-selected id doesn't duplicate it.
    expect(svc.add(sel, "a")).toEqual({ ids: ["a"], primaryId: "a" });
  });

  it("toggle adds or removes; falls back primary when the primary is removed", () => {
    const sel = svc.selectMany(["a", "b"]);
    expect(svc.toggle(sel, "c").ids).toEqual(["a", "b", "c"]);
    // Remove the primary "b" → primary falls back to the last remaining id "a".
    const toggled = svc.toggle(sel, "b");
    expect(toggled).toEqual({ ids: ["a"], primaryId: "a" });
  });

  it("selectMany de-duplicates and sets the last as primary", () => {
    expect(svc.selectMany(["a", "b", "a", "c"])).toEqual({ ids: ["a", "b", "c"], primaryId: "c" });
    expect(svc.selectMany([]).ids).toEqual([]);
  });

  it("selectAll selects visible, unlocked objects", () => {
    const state = createEditorState();
    let page = getActivePage(state);
    const r1 = makeRect();
    const hidden = makeRect({ visible: false });
    const locked = makeRect({ locked: true });
    page = addObjectToPage(page, r1);
    page = addObjectToPage(page, hidden);
    page = addObjectToPage(page, locked);
    const sel = svc.selectAll(page);
    expect(sel.ids).toEqual([r1.id]);
  });

  it("clear empties the selection", () => {
    expect(svc.clear()).toEqual({ ids: [], primaryId: null });
  });

  it("setPrimary only changes primary when the id is selected", () => {
    const sel = svc.selectMany(["a", "b"]);
    expect(svc.setPrimary(sel, "a").primaryId).toBe("a");
    // Not selected → no change.
    expect(svc.setPrimary(sel, "z")).toBe(sel);
  });

  it("isSelected, selectedObjects, primaryObject read the page", () => {
    const state = createEditorState();
    let page = getActivePage(state);
    const r1 = makeRect();
    const r2 = makeRect();
    page = addObjectToPage(page, r1);
    page = addObjectToPage(page, r2);
    const sel = svc.selectMany([r1.id, r2.id]);
    expect(svc.isSelected(sel, r1.id)).toBe(true);
    expect(svc.isSelected(sel, "missing")).toBe(false);
    expect(svc.selectedObjects(page, sel)).toHaveLength(2);
    expect(svc.primaryObject(page, sel)?.id).toBe(r2.id);
  });

  it("selectionBounds is the union of selected world bounds, null when empty", () => {
    const state = createEditorState();
    let page = getActivePage(state);
    const r1 = makeRect(); // 80x60 at origin
    const r2 = makeRect(); // 80x60 at origin (same place)
    page = addObjectToPage(page, r1);
    page = addObjectToPage(page, r2);
    const sel = svc.selectMany([r1.id, r2.id]);
    const bounds = svc.selectionBounds(page, sel);
    expect(bounds).toEqual({ x: 0, y: 0, width: 80, height: 60 });
    expect(svc.selectionBounds(page, svc.clear())).toBeNull();
  });

  it("selectedObjects skips orphaned ids", () => {
    const state = createEditorState();
    const page = getActivePage(state);
    const sel = svc.selectMany(["ghost"]);
    expect(svc.selectedObjects(page, sel)).toEqual([]);
  });
});
