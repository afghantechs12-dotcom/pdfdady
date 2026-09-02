import { beforeEach, describe, expect, it } from "vitest";
import {
  addObjectToPage,
  createEditorState,
  getActivePage,
} from "@/src/domain/editor/document";
import { createLayer } from "@/src/domain/editor/layers";
import { makeRect, resetFactory } from "@/src/domain/editor/testFactories";
import { CommandHistory } from "../commands/CommandHistory";
import { AddObjectCommand } from "../commands/commands";
import { LayerService } from "./LayerService";

describe("LayerService", () => {
  let svc: LayerService;
  let history: CommandHistory;

  beforeEach(() => {
    resetFactory();
    svc = new LayerService();
    history = new CommandHistory();
  });

  function stateWithRects(count: number) {
    const state = createEditorState();
    let page = getActivePage(state);
    for (let i = 0; i < count; i++) page = addObjectToPage(page, makeRect());
    return { ...state, document: { ...state.document, pages: [page] } };
  }

  it("bringForward / sendBackward produce ±1 reorder commands", () => {
    const state = stateWithRects(2);
    const order = getActivePage(state).layerStack.layers[0].objectIds;
    const [first, second] = order;
    let s = history.execute(svc.bringForward(first), state);
    // +1 on the first object swaps it with the second.
    expect(getActivePage(s).layerStack.layers[0].objectIds).toEqual([second, first]);
    s = history.undo(s);
    expect(getActivePage(s).layerStack.layers[0].objectIds).toEqual([first, second]);
  });

  it("bringToFront sends an object to the top of its layer", () => {
    const state = stateWithRects(3);
    const page = getActivePage(state);
    const firstId = page.layerStack.layers[0].objectIds[0];
    const s = history.execute(svc.bringToFront(state, firstId), state);
    const order = getActivePage(s).layerStack.layers[0].objectIds;
    expect(order[order.length - 1]).toBe(firstId);
  });

  it("sendToBack sends an object to the bottom of its layer", () => {
    const state = stateWithRects(3);
    const page = getActivePage(state);
    const lastId = page.layerStack.layers[0].objectIds[2];
    const s = history.execute(svc.sendToBack(state, lastId), state);
    const order = getActivePage(s).layerStack.layers[0].objectIds;
    expect(order[0]).toBe(lastId);
  });

  it("addLayer returns a command + id and adds a layer when executed", () => {
    const state = stateWithRects(0);
    const { command, layerId } = svc.addLayer("Annotations");
    expect(layerId).toBeTruthy();
    const s = history.execute(command, state);
    expect(getActivePage(s).layerStack.layers).toHaveLength(2);
    expect(getActivePage(s).layerStack.layers[1].name).toBe("Annotations");
  });

  it("deleteLayer removes a layer and undo restores it", () => {
    const state = stateWithRects(0);
    const { command, layerId } = svc.addLayer("Temp");
    let s = history.execute(command, state);
    const deleteCmd = svc.deleteLayer(s, layerId);
    s = history.execute(deleteCmd, s);
    expect(getActivePage(s).layerStack.layers).toHaveLength(1);
    s = history.undo(s);
    expect(getActivePage(s).layerStack.layers).toHaveLength(2);
  });

  it("reorderLayer moves a whole layer", () => {
    let state = createEditorState();
    let page = getActivePage(state);
    page = {
      ...page,
      layerStack: { layers: [createLayer("a", "A"), createLayer("b", "B")] },
    };
    state = { ...state, document: { ...state.document, pages: [page] } };
    const s = history.execute(svc.reorderLayer("a", 1), state);
    expect(getActivePage(s).layerStack.layers.map((l) => l.id)).toEqual(["b", "a"]);
  });

  it("layersOf and objectsInLayer read the active page", () => {
    const state = stateWithRects(2);
    expect(svc.layersOf(state)).toHaveLength(1);
    expect(svc.layersOf(state)[0].id).toBe("layer-1");
    expect(svc.objectsInLayer(state, "layer-1")).toHaveLength(2);
    expect(svc.objectsInLayer(state, "missing")).toEqual([]);
  });

  it("moveToLayer relocates an object between layers", () => {
    let state = createEditorState();
    let page = getActivePage(state);
    page = {
      ...page,
      layerStack: {
        layers: [createLayer("layer-1", "Bottom", []), createLayer("layer-2", "Top", [])],
      },
    };
    state = { ...state, document: { ...state.document, pages: [page] } };
    const rect = makeRect();
    state = history.execute(new AddObjectCommand("Add", rect, "layer-1"), state);
    const move = svc.moveToLayer(state, rect.id, "layer-2");
    const s = history.execute(move, state);
    const layers = getActivePage(s).layerStack.layers;
    expect(layers[1].objectIds).toContain(rect.id);
    expect(layers[0].objectIds).not.toContain(rect.id);
  });
});
