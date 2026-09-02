import { beforeEach, describe, expect, it } from "vitest";
import { getActivePage } from "@/src/domain/editor/document";
import { makeRect, resetFactory } from "@/src/domain/editor/testFactories";
import { CommandHistory } from "./commands/CommandHistory";
import { SelectionService } from "./selection/SelectionService";
import { LayerService } from "./layers/LayerService";
import { SerializationService } from "./serialization/SerializationService";
import { PluginRegistry } from "./plugins/PluginRegistry";
import { EditorDocumentService } from "./EditorDocumentService";

/**
 * Tests for the M6 page-operation facade methods: every mutation goes through
 * `execute` (history entry with the right label), undo/redo works end-to-end,
 * and the guard no-ops don't pollute the undo stack.
 */

function makeService() {
  return new EditorDocumentService({
    history: new CommandHistory(),
    selection: new SelectionService(),
    layers: new LayerService(),
    serializer: new SerializationService(),
    plugins: new PluginRegistry(),
  });
}

describe("EditorDocumentService: page operations (M6)", () => {
  beforeEach(() => resetFactory());

  it("exposes pages() and pageCount", () => {
    const ed = makeService();
    expect(ed.pageCount).toBe(1);
    expect(ed.pages().map((p) => p.id)).toEqual(["page-1"]);
  });

  it("insertBlankPage defaults to the active page's size, pushes 'Insert page', and undoes", () => {
    const ed = makeService();
    const newId = ed.insertBlankPage(1);
    expect(ed.pageCount).toBe(2);
    const inserted = ed.pages()[1];
    expect(inserted.id).toBe(newId);
    expect(inserted.width).toBe(595);
    expect(inserted.height).toBe(842);
    expect(inserted.sourcePageIndex).toBeNull();
    expect(ed.undoLabel).toBe("Insert page");

    ed.undo();
    expect(ed.pageCount).toBe(1);
    ed.redo();
    expect(ed.pages()[1].id).toBe(newId);
  });

  it("insertBlankPage accepts an explicit size", () => {
    const ed = makeService();
    ed.insertBlankPage(0, 200, 300);
    expect(ed.pages()[0].width).toBe(200);
    expect(ed.pages()[0].height).toBe(300);
  });

  it("deletePage removes, records 'Delete page', and undo restores everything", () => {
    const ed = makeService();
    const rect = makeRect();
    ed.addObject(rect); // lives on page-1
    const secondId = ed.insertBlankPage(1);
    ed.deletePage("page-1");

    expect(ed.pageCount).toBe(1);
    expect(ed.pages()[0].id).toBe(secondId);
    expect(ed.getState().activePageId).toBe(secondId);
    expect(ed.selection.ids).toEqual([]); // rect's selection cleared with its page
    expect(ed.undoLabel).toBe("Delete page");

    ed.undo();
    expect(ed.pages().map((p) => p.id)).toEqual(["page-1", secondId]);
    expect(ed.getState().activePageId).toBe("page-1");
    expect(ed.selection.ids).toEqual([rect.id]); // prior selection restored
    expect(getActivePage(ed.getState()).objects[rect.id]).toBeDefined();
  });

  it("deletePage refuses the last page and unknown ids without touching history", () => {
    const ed = makeService();
    ed.deletePage("page-1");
    ed.deletePage("nope");
    expect(ed.pageCount).toBe(1);
    expect(ed.canUndo).toBe(false);
  });

  it("duplicatePage inserts a fresh-id copy after the source with label 'Duplicate page'", () => {
    const ed = makeService();
    const rect = makeRect();
    ed.addObject(rect);
    const newId = ed.duplicatePage("page-1");
    expect(newId).not.toBeNull();
    expect(ed.pages().map((p) => p.id)).toEqual(["page-1", newId]);
    const copy = ed.pages()[1];
    expect(Object.keys(copy.objects)).toHaveLength(1);
    expect(copy.objects[rect.id]).toBeUndefined(); // fresh object id
    expect(ed.undoLabel).toBe("Duplicate page");

    ed.undo();
    expect(ed.pageCount).toBe(1);
    ed.redo();
    // Redo reuses the exact same page id (deterministic clone).
    expect(ed.pages()[1].id).toBe(newId);
  });

  it("duplicatePage returns null for an unknown page and pushes nothing", () => {
    const ed = makeService();
    expect(ed.duplicatePage("nope")).toBeNull();
    expect(ed.canUndo).toBe(false);
  });

  it("movePage reorders with label 'Move page' and undoes exactly", () => {
    const ed = makeService();
    const p2 = ed.insertBlankPage(1);
    const p3 = ed.insertBlankPage(2);
    ed.movePage("page-1", 2);
    expect(ed.pages().map((p) => p.id)).toEqual([p2, p3, "page-1"]);
    expect(ed.undoLabel).toBe("Move page");
    ed.undo();
    expect(ed.pages().map((p) => p.id)).toEqual(["page-1", p2, p3]);
  });

  it("movePage is a silent no-op for an unknown page", () => {
    const ed = makeService();
    ed.movePage("nope", 0);
    expect(ed.canUndo).toBe(false);
  });

  it("rotatePage sets an absolute rotation with label 'Rotate page' and undoes", () => {
    const ed = makeService();
    ed.rotatePage("page-1", 180);
    expect(ed.pages()[0].rotation).toBe(180);
    expect(ed.undoLabel).toBe("Rotate page");
    ed.undo();
    expect(ed.pages()[0].rotation).toBe(0);
  });

  it("rotatePage no-ops on unchanged, invalid, or unknown input", () => {
    const ed = makeService();
    ed.rotatePage("page-1", 0); // unchanged
    ed.rotatePage("page-1", 45 as 0); // invalid quadrant
    ed.rotatePage("nope", 90); // unknown page
    expect(ed.canUndo).toBe(false);
  });

  it("rotatePageBy wraps around the quadrant set in both directions", () => {
    const ed = makeService();
    ed.rotatePageBy("page-1", 90);
    expect(ed.pages()[0].rotation).toBe(90);
    ed.rotatePageBy("page-1", 90);
    ed.rotatePageBy("page-1", 90);
    ed.rotatePageBy("page-1", 90);
    expect(ed.pages()[0].rotation).toBe(0); // 360 → 0
    ed.rotatePageBy("page-1", -90);
    expect(ed.pages()[0].rotation).toBe(270); // −90 wraps to 270
    ed.undo();
    expect(ed.pages()[0].rotation).toBe(0);
  });

  it("rotatePageBy ignores a non-quadrant delta", () => {
    const ed = makeService();
    ed.rotatePageBy("page-1", 45);
    expect(ed.pages()[0].rotation).toBe(0);
    expect(ed.canUndo).toBe(false);
  });

  it("setPageSize resizes with label 'Resize page' and undoes", () => {
    const ed = makeService();
    ed.setPageSize("page-1", 300, 400);
    expect(ed.pages()[0].width).toBe(300);
    expect(ed.pages()[0].height).toBe(400);
    expect(ed.undoLabel).toBe("Resize page");
    ed.undo();
    expect(ed.pages()[0].width).toBe(595);
    expect(ed.pages()[0].height).toBe(842);
  });

  it("setPageSize no-ops on an unchanged size or unknown page", () => {
    const ed = makeService();
    ed.setPageSize("page-1", 595, 842);
    ed.setPageSize("nope", 100, 100);
    expect(ed.canUndo).toBe(false);
  });

  it("a sequence of page operations undoes back to the initial state end-to-end", () => {
    const ed = makeService();
    const initial = ed.getState();
    ed.insertBlankPage(1);
    ed.duplicatePage("page-1");
    ed.movePage("page-1", 2);
    ed.rotatePage("page-1", 90);
    ed.setPageSize("page-1", 200, 200);
    expect(ed.undoDepth).toBe(5);

    ed.undo();
    ed.undo();
    ed.undo();
    ed.undo();
    ed.undo();
    expect(ed.getState()).toEqual(initial);
    expect(ed.canUndo).toBe(false);
  });
});
