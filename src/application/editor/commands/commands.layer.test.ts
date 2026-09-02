import { beforeEach, describe, expect, it } from "vitest";
import {
  addObjectToPage,
  createEditorState,
  getActivePage,
} from "@/src/domain/editor/document";
import { makeRect, resetFactory } from "@/src/domain/editor/testFactories";
import { DuplicateLayerCommand, SetLayerPropertyCommand, duplicateLayerCommand } from "./commands";

describe("SetLayerPropertyCommand", () => {
  beforeEach(() => resetFactory());

  it("patches a layer's name/visible/locked/opacity + inverts exactly", () => {
    const state = createEditorState();
    const layerId = getActivePage(state).layerStack.layers[0].id;
    const cmd = new SetLayerPropertyCommand("Rename", layerId, { name: "Layer 1", locked: false }, { name: "Background", locked: true });
    const applied = cmd.apply(state);
    const layer = getActivePage(applied).layerStack.layers.find((l) => l.id === layerId);
    expect(layer?.name).toBe("Background");
    expect(layer?.locked).toBe(true);
    const restored = cmd.invert(applied);
    const layer2 = getActivePage(restored).layerStack.layers.find((l) => l.id === layerId);
    expect(layer2?.name).toBe("Layer 1");
    expect(layer2?.locked).toBe(false);
  });

  it("is a no-op when the layer id is stale", () => {
    const state = createEditorState();
    const cmd = new SetLayerPropertyCommand("Edit", "missing", { name: "x" }, { name: "y" });
    expect(cmd.apply(state)).toBe(state);
  });
});

describe("DuplicateLayerCommand", () => {
  beforeEach(() => resetFactory());

  it("clones a layer + its objects with fresh ids, and invert removes them", () => {
    let state = createEditorState();
    let page = getActivePage(state);
    page = addObjectToPage(page, makeRect());
    page = addObjectToPage(page, makeRect());
    state = { ...state, document: { ...state.document, pages: [page] } };

    const sourceLayerId = page.layerStack.layers[0].id;
    const { command, layerId: newLayerId } = duplicateLayerCommand(state, sourceLayerId);
    expect(command).toBeInstanceOf(DuplicateLayerCommand);

    const applied = command.apply(state);
    const appliedPage = getActivePage(applied);
    // New layer present, inserted above the source.
    expect(appliedPage.layerStack.layers.some((l) => l.id === newLayerId)).toBe(true);
    // Cloned objects present with fresh ids on the new layer.
    const newLayer = appliedPage.layerStack.layers.find((l) => l.id === newLayerId);
    expect(newLayer?.objectIds.length).toBe(2);
    for (const id of newLayer!.objectIds) {
      expect(appliedPage.objects[id]).toBeDefined();
      expect(appliedPage.objects[id].layerId).toBe(newLayerId);
    }
    // Original objects untouched.
    expect(Object.keys(appliedPage.objects).length).toBe(4);

    // Invert removes the cloned layer + objects, restoring the original state.
    const restored = command.invert(applied);
    const restoredPage = getActivePage(restored);
    expect(restoredPage.layerStack.layers.some((l) => l.id === newLayerId)).toBe(false);
    expect(Object.keys(restoredPage.objects).length).toBe(2);
  });

  it("throws when the source layer is missing", () => {
    const state = createEditorState();
    expect(() => duplicateLayerCommand(state, "missing")).toThrow(/not found/);
  });
});
