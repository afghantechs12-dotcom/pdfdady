import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addObjectToPage,
  createEditorState,
  createPage,
  type EditorPage,
  type EditorState,
} from "@/src/domain/editor/document";
import { createBlankPage } from "@/src/domain/editor/pageOperations";
import { setIdFactory } from "@/src/domain/editor/ids";
import { makeRect, makeTextObject, resetFactory } from "@/src/domain/editor/testFactories";
import {
  InsertPageCommand,
  MovePageCommand,
  SetPageRotationCommand,
  SetPageSizeCommand,
  duplicatePageCommand,
  movePageCommand,
  removePageCommand,
} from "./pageCommands";

/**
 * Tests for the page commands: exact apply/invert round-trips (deep-equal
 * state restoration) and deterministic redo for the id-generating duplicate.
 */

let restoreIds: () => void;

beforeEach(() => {
  resetFactory();
  let n = 0;
  restoreIds = setIdFactory(() => `det-${++n}`);
});

afterEach(() => restoreIds());

/** A state with `count` source-backed pages ("page-0"…), active on the first. */
function stateWithPages(count: number): EditorState {
  const base = createEditorState("doc", "page-0");
  const pages: EditorPage[] = [];
  for (let i = 0; i < count; i++) pages.push(createPage(`page-${i}`, 595, 842, 0, i));
  return { ...base, document: { ...base.document, pages }, activePageId: "page-0" };
}

const pageIds = (state: EditorState) => state.document.pages.map((p) => p.id);

describe("InsertPageCommand", () => {
  it("apply inserts and invert removes (deep-equal round-trip)", () => {
    const before = stateWithPages(2);
    const cmd = new InsertPageCommand("Insert page", createBlankPage("new", 300, 400), 1);
    const after = cmd.apply(before);
    expect(pageIds(after)).toEqual(["page-0", "new", "page-1"]);
    expect(after.document.pages[1].sourcePageIndex).toBeNull();
    expect(cmd.invert(after)).toEqual(before);
  });

  it("invert reactivates a neighbor when the inserted page became active", () => {
    const before = stateWithPages(2);
    const cmd = new InsertPageCommand("Insert page", createBlankPage("new"), 2);
    const withActive = { ...cmd.apply(before), activePageId: "new" };
    const undone = cmd.invert(withActive);
    expect(pageIds(undone)).toEqual(["page-0", "page-1"]);
    expect(undone.activePageId).toBe("page-1");
  });

  it("has the required label", () => {
    expect(new InsertPageCommand("Insert page", createBlankPage("new"), 0).label).toBe("Insert page");
  });
});

describe("RemovePageCommand", () => {
  it("apply removes; invert restores page, index, active page, and selection exactly", () => {
    const base = stateWithPages(3);
    const onPage1 = makeRect();
    const pages = [
      base.document.pages[0],
      addObjectToPage(base.document.pages[1], onPage1),
      base.document.pages[2],
    ];
    const before: EditorState = {
      ...base,
      document: { ...base.document, pages },
      activePageId: "page-1",
      selection: { ids: [onPage1.id], primaryId: onPage1.id },
    };

    const cmd = removePageCommand(before, "page-1");
    expect(cmd.label).toBe("Delete page");

    const after = cmd.apply(before);
    expect(pageIds(after)).toEqual(["page-0", "page-2"]);
    // The removed page was active + selected → neighbor active, selection cleared.
    expect(after.activePageId).toBe("page-2");
    expect(after.selection.ids).toEqual([]);

    expect(cmd.invert(after)).toEqual(before);
  });

  it("round-trips across undo/redo cycles (apply → invert → apply is stable)", () => {
    const before = stateWithPages(3);
    const cmd = removePageCommand(before, "page-0");
    const once = cmd.apply(before);
    const again = cmd.apply(cmd.invert(once));
    expect(again).toEqual(once);
  });

  it("factory throws for a missing page and for the last remaining page", () => {
    expect(() => removePageCommand(stateWithPages(2), "nope")).toThrow(/not found/);
    expect(() => removePageCommand(stateWithPages(1), "page-0")).toThrow(/last remaining page/);
  });
});

describe("DuplicatePageCommand", () => {
  function populatedState(): EditorState {
    const base = stateWithPages(2);
    let page = addObjectToPage(base.document.pages[0], makeRect());
    page = addObjectToPage(page, makeTextObject());
    return { ...base, document: { ...base.document, pages: [page, base.document.pages[1]] } };
  }

  it("apply inserts the clone after the source; invert removes it (deep-equal)", () => {
    const before = populatedState();
    const { command, pageId } = duplicatePageCommand(before, "page-0");
    expect(command.label).toBe("Duplicate page");

    const after = command.apply(before);
    expect(pageIds(after)).toEqual(["page-0", pageId, "page-1"]);
    const copy = after.document.pages[1];
    expect(Object.keys(copy.objects)).toHaveLength(2);
    expect(copy.sourcePageIndex).toBe(0);

    expect(command.invert(after)).toEqual(before);
  });

  it("redo after undo reuses the identical ids (deterministic apply)", () => {
    const before = populatedState();
    const { command } = duplicatePageCommand(before, "page-0");
    const first = command.apply(before);
    const second = command.apply(command.invert(first));
    // Deep-equal INCLUDING every generated page/layer/object id.
    expect(second).toEqual(first);
  });

  it("factory throws for a missing page", () => {
    expect(() => duplicatePageCommand(stateWithPages(1), "nope")).toThrow(/not found/);
  });
});

describe("MovePageCommand", () => {
  it("apply moves to the target index; invert moves back (deep-equal)", () => {
    const before = stateWithPages(4);
    const cmd = movePageCommand(before, "page-0", 2);
    expect(cmd.label).toBe("Move page");
    const after = cmd.apply(before);
    expect(pageIds(after)).toEqual(["page-1", "page-2", "page-0", "page-3"]);
    expect(cmd.invert(after)).toEqual(before);
  });

  it("factory clamps the target index so invert stays exact", () => {
    const before = stateWithPages(3);
    const cmd = movePageCommand(before, "page-0", 99);
    const after = cmd.apply(before);
    expect(pageIds(after)).toEqual(["page-1", "page-2", "page-0"]);
    expect(cmd.invert(after)).toEqual(before);
  });

  it("factory throws for a missing page", () => {
    expect(() => movePageCommand(stateWithPages(2), "nope", 0)).toThrow(/not found/);
  });

  it("a raw command with captured indices round-trips", () => {
    const before = stateWithPages(3);
    const cmd = new MovePageCommand("Move page", "page-2", 2, 0);
    const after = cmd.apply(before);
    expect(pageIds(after)).toEqual(["page-2", "page-0", "page-1"]);
    expect(cmd.invert(after)).toEqual(before);
  });
});

describe("SetPageRotationCommand", () => {
  it("apply sets the rotation; invert restores the captured before (deep-equal)", () => {
    const before = stateWithPages(2);
    const cmd = new SetPageRotationCommand("Rotate page", "page-1", 0, 90);
    expect(cmd.label).toBe("Rotate page");
    const after = cmd.apply(before);
    expect(after.document.pages[1].rotation).toBe(90);
    expect(cmd.invert(after)).toEqual(before);
  });
});

describe("SetPageSizeCommand", () => {
  it("apply sets the size; invert restores the captured before (deep-equal)", () => {
    const before = stateWithPages(1);
    const cmd = new SetPageSizeCommand(
      "Resize page",
      "page-0",
      { width: 595, height: 842 },
      { width: 300, height: 400 },
    );
    expect(cmd.label).toBe("Resize page");
    const after = cmd.apply(before);
    expect(after.document.pages[0].width).toBe(300);
    expect(after.document.pages[0].height).toBe(400);
    expect(cmd.invert(after)).toEqual(before);
  });
});
