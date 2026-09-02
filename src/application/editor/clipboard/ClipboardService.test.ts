import { beforeEach, describe, expect, it } from "vitest";
import { compose, makeRotate, makeTranslate } from "@/src/domain/editor/geometry";
import {
  addObjectToPage,
  createEditorState,
  getActivePage,
  getObject,
  type EditorState,
} from "@/src/domain/editor/document";
import { createLayer } from "@/src/domain/editor/layers";
import { makeRect, makeTextObject, resetFactory } from "@/src/domain/editor/testFactories";
import { SetPropertyCommand } from "@/src/application/editor/commands/commands";
import { ClipboardService } from "./ClipboardService";

/** The ids present in `after` but not `before` (the freshly pasted/duplicated). */
function newIds(before: EditorState, after: EditorState): string[] {
  const beforeIds = new Set(Object.keys(getActivePage(before).objects));
  return Object.keys(getActivePage(after).objects).filter((id) => !beforeIds.has(id));
}

describe("ClipboardService", () => {
  beforeEach(() => resetFactory());

  it("copy stores objects and reports content", () => {
    const state = makeStateWithTwoRects();
    const ids = Object.keys(getActivePage(state).objects);
    const clip = new ClipboardService();
    expect(clip.hasContent()).toBe(false);

    clip.copy(state, ids);
    expect(clip.hasContent()).toBe(true);
  });

  it("paste produces commands with fresh ids + offset translate (e/f shifted)", () => {
    const state = makeStateWithTwoRects();
    const ids = Object.keys(getActivePage(state).objects);
    const clip = new ClipboardService();
    clip.copy(state, ids);

    const cmds = clip.pasteCommands(state, { x: 16, y: 16 });
    expect(cmds).toHaveLength(2);

    // Original ids are not reused.
    const originalIdSet = new Set(ids);
    const pastedState = cmds.reduce<EditorState>((s, cmd) => cmd.apply(s), state);
    const pastedIds = newIds(state, pastedState);
    expect(pastedIds).toHaveLength(2);
    expect(pastedIds.every((id) => !originalIdSet.has(id))).toBe(true);

    // makeRect starts at the identity (e=0, f=0); a 16,16 paste shifts e/f by 16.
    for (const id of pastedIds) {
      const t = getObject(getActivePage(pastedState), id)!.transform;
      expect(t.e).toBe(16);
      expect(t.f).toBe(16);
    }
  });

  it("paste offset composes in page space for a rotated object (e/f shift, linear part kept)", () => {
    // A rotated text object: translate (100, 200) then rotate 0.5 rad about origin.
    const rotated = compose(makeRotate(0.5), makeTranslate(100, 200));
    const obj = makeTextObject({ transform: rotated });
    let state = createEditorState();
    state = {
      ...state,
      document: {
        ...state.document,
        pages: [addObjectToPage(getActivePage(state), obj)],
      },
    };
    const clip = new ClipboardService();
    clip.copy(state, [obj.id]);

    const [cmd] = clip.pasteCommands(state, { x: 16, y: 16 });
    const pasted = cmd.apply(state);
    const [newId] = newIds(state, pasted);
    const original = getObject(getActivePage(state), obj.id)!;
    const clone = getObject(getActivePage(pasted), newId)!;

    // e/f shift by exactly the offset; the linear part (a,b,c,d) is preserved.
    expect(clone.transform.e).toBeCloseTo(original.transform.e + 16, 9);
    expect(clone.transform.f).toBeCloseTo(original.transform.f + 16, 9);
    expect(clone.transform.a).toBeCloseTo(original.transform.a, 9);
    expect(clone.transform.b).toBeCloseTo(original.transform.b, 9);
    expect(clone.transform.c).toBeCloseTo(original.transform.c, 9);
    expect(clone.transform.d).toBeCloseTo(original.transform.d, 9);
  });

  it("paste on an empty clipboard returns []", () => {
    const state = makeStateWithTwoRects();
    const clip = new ClipboardService();
    expect(clip.pasteCommands(state)).toEqual([]);
  });

  it("paste lands objects on the top layer by default", () => {
    // Two layers; the source object sits on the bottom layer.
    let state = createEditorState();
    state = {
      ...state,
      document: {
        ...state.document,
        pages: [
          {
            ...getActivePage(state),
            layerStack: {
              layers: [
                createLayer("layer-1", "Bottom", []),
                createLayer("layer-2", "Top", []),
              ],
            },
          },
        ],
      },
    };
    const rect = makeRect({ layerId: "layer-1" });
    state = {
      ...state,
      document: {
        ...state.document,
        pages: [addObjectToPage(getActivePage(state), rect, "layer-1")],
      },
    };

    const clip = new ClipboardService();
    clip.copy(state, [rect.id]);
    const [cmd] = clip.pasteCommands(state);
    const pasted = cmd.apply(state);
    const [newId] = newIds(state, pasted);

    // The pasted object's layerId + layer membership is the top layer.
    expect(getObject(getActivePage(pasted), newId)!.layerId).toBe("layer-2");
    expect(getActivePage(pasted).layerStack.layers[1].objectIds).toContain(newId);
    expect(getActivePage(pasted).layerStack.layers[0].objectIds).not.toContain(newId);
  });

  it("duplicate produces clones with new ids + offset, without touching the clipboard", () => {
    const state = makeStateWithTwoRects();
    const ids = Object.keys(getActivePage(state).objects);
    const clip = new ClipboardService();
    // Clipboard stays empty throughout — duplicate never reads or writes it.
    expect(clip.hasContent()).toBe(false);

    const cmds = clip.duplicateCommands(state, ids, { x: 5, y: 7 });
    expect(cmds).toHaveLength(2);
    expect(clip.hasContent()).toBe(false);

    const duped = cmds.reduce<EditorState>((s, cmd) => cmd.apply(s), state);
    const dupedIds = newIds(state, duped);
    expect(dupedIds).toHaveLength(2);
    expect(dupedIds.every((id) => !new Set(ids).has(id))).toBe(true);
    for (const id of dupedIds) {
      const t = getObject(getActivePage(duped), id)!.transform;
      expect(t.e).toBe(5);
      expect(t.f).toBe(7);
    }
  });

  it("duplicate keeps each clone on its original's layer", () => {
    let state = createEditorState();
    state = {
      ...state,
      document: {
        ...state.document,
        pages: [
          {
            ...getActivePage(state),
            layerStack: {
              layers: [
                createLayer("layer-1", "Bottom", []),
                createLayer("layer-2", "Top", []),
              ],
            },
          },
        ],
      },
    };
    const bottom = makeRect({ layerId: "layer-1" });
    const top = makeRect({ layerId: "layer-2" });
    state = {
      ...state,
      document: {
        ...state.document,
        pages: [
          addObjectToPage(
            addObjectToPage(getActivePage(state), bottom, "layer-1"),
            top,
            "layer-2",
          ),
        ],
      },
    };

    const clip = new ClipboardService();
    const cmds = clip.duplicateCommands(state, [bottom.id, top.id]);
    const duped = cmds.reduce<EditorState>((s, cmd) => cmd.apply(s), state);

    // Find each clone by the layer it landed on, and confirm layer membership.
    const bottomLayer = getActivePage(duped).layerStack.layers[0];
    const topLayer = getActivePage(duped).layerStack.layers[1];
    const newBottom = bottomLayer.objectIds.find((id) => id !== bottom.id);
    const newTop = topLayer.objectIds.find((id) => id !== top.id);
    expect(newBottom).toBeDefined();
    expect(newTop).toBeDefined();
    expect(getObject(getActivePage(duped), newBottom!)!.layerId).toBe("layer-1");
    expect(getObject(getActivePage(duped), newTop!)!.layerId).toBe("layer-2");
  });

  it("copying then editing the original does not change the clipboard (deep clone)", () => {
    const state = makeStateWithTwoRects();
    const id = Object.keys(getActivePage(state).objects)[0];
    const originalName = getObject(getActivePage(state), id)!.name;

    const clip = new ClipboardService();
    clip.copy(state, [id]);

    // Rename the original after the copy.
    const rename = new SetPropertyCommand(
      "Rename",
      id,
      { name: originalName },
      { name: "Changed after copy" },
    );
    const mutated = rename.apply(state);
    expect(getObject(getActivePage(mutated), id)!.name).toBe("Changed after copy");

    // The pasted clone still carries the pre-copy name — the clipboard was not
    // mutated by the edit to the live object.
    const [cmd] = clip.pasteCommands(mutated);
    const pasted = cmd.apply(mutated);
    const [newId] = newIds(mutated, pasted);
    expect(getObject(getActivePage(pasted), newId)!.name).toBe(originalName);
  });

  it("clear empties the clipboard", () => {
    const state = makeStateWithTwoRects();
    const ids = Object.keys(getActivePage(state).objects);
    const clip = new ClipboardService();
    clip.copy(state, ids);
    expect(clip.hasContent()).toBe(true);
    clip.clear();
    expect(clip.hasContent()).toBe(false);
    expect(clip.pasteCommands(state)).toEqual([]);
  });

  it("copy of ids not on the page stores nothing", () => {
    const state = makeStateWithTwoRects();
    const clip = new ClipboardService();
    clip.copy(state, ["does-not-exist"]);
    expect(clip.hasContent()).toBe(false);
    expect(clip.pasteCommands(state)).toEqual([]);
  });
});

/** A fresh state with two rect objects on the default page, in paint order. */
function makeStateWithTwoRects(): EditorState {
  const initial = createEditorState();
  let page = getActivePage(initial);
  page = addObjectToPage(page, makeRect());
  page = addObjectToPage(page, makeRect());
  return { ...initial, document: { ...initial.document, pages: [page] } };
}
