import { beforeEach, describe, expect, it } from "vitest";
import { createEditorState, getActivePage } from "@/src/domain/editor/document";
import { makeRect, resetFactory } from "@/src/domain/editor/testFactories";
import { AddObjectCommand } from "./commands";
import { CommandHistory } from "./CommandHistory";

describe("CommandHistory: navigation (Part 6)", () => {
  beforeEach(() => resetFactory());

  it("exposes undo/redo labels oldest→newest / next→latest", () => {
    const history = new CommandHistory();
    let state = createEditorState();
    for (let i = 0; i < 3; i++) {
      state = history.execute(new AddObjectCommand("Add object", makeRect()), state);
    }
    expect(history.undoLabels()).toEqual(["Add object", "Add object", "Add object"]);
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);
  });

  it("jumpTo undoes/redoes to a target depth in one step", () => {
    const history = new CommandHistory();
    let state = createEditorState();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const rect = makeRect();
      ids.push(rect.id);
      state = history.execute(new AddObjectCommand("Add object", rect), state);
    }
    expect(Object.keys(getActivePage(state).objects).length).toBe(3);
    expect(history.undoDepth).toBe(3);

    // Jump back to depth 1 → only the first object remains.
    state = history.jumpTo(state, 1);
    expect(Object.keys(getActivePage(state).objects).length).toBe(1);
    expect(history.undoDepth).toBe(1);
    expect(history.canRedo).toBe(true);
    expect(history.redoLabels().length).toBe(2);

    // Jump forward to depth 3 → all three objects back.
    state = history.jumpTo(state, 3);
    expect(Object.keys(getActivePage(state).objects).length).toBe(3);
    expect(history.undoDepth).toBe(3);
    expect(history.canRedo).toBe(false);

    // Jump to 0 → empty page.
    state = history.jumpTo(state, 0);
    expect(Object.keys(getActivePage(state).objects).length).toBe(0);
    expect(history.redoLabels()).toEqual(["Add object", "Add object", "Add object"]);
  });

  it("jumpTo clamps beyond the reachable range", () => {
    const history = new CommandHistory();
    let state = createEditorState();
    state = history.execute(new AddObjectCommand("Add object", makeRect()), state);
    // Target 5 is beyond total (1 past + 0 future = 1 reachable); clamp to 1.
    history.jumpTo(state, 5);
    expect(history.undoDepth).toBe(1);
  });
});
