import { describe, expect, it } from "vitest";
import {
  addLayer,
  createLayer,
  createLayerStack,
  findLayer,
  layerIndex,
  layerOfObject,
  moveToLayer,
  paintOrder,
  removeLayer,
  reorderLayer,
  reorderWithinLayer,
  replaceLayer,
} from "./layers";

const stackWith = (...ids: string[]) => {
  const stack = createLayerStack();
  // Replace the default layer's objects with the given ids.
  return replaceLayer(stack, "layer-1", createLayer("layer-1", "Layer 1", ids));
};

describe("editor layers", () => {
  it("createLayerStack starts with one empty layer", () => {
    const stack = createLayerStack();
    expect(stack.layers).toHaveLength(1);
    expect(stack.layers[0].objectIds).toEqual([]);
  });

  it("paintOrder walks layers bottom→top, objects bottom→top", () => {
    const stack = createLayerStack();
    let next = addLayer(stack, createLayer("layer-2", "Top"));
    next = replaceLayer(next, "layer-1", createLayer("layer-1", "Bottom", ["a", "b"]));
    next = replaceLayer(next, "layer-2", createLayer("layer-2", "Top", ["c"]));
    expect(paintOrder(next).map((e) => e.objectId)).toEqual(["a", "b", "c"]);
  });

  it("reorderWithinLayer moves an object and clamps at the ends", () => {
    const stack = stackWith("a", "b", "c");
    const up = reorderWithinLayer(stack, "a", 1);
    expect(layerOfObject(up, "a")?.objectIds).toEqual(["b", "a", "c"]);
    // Clamping: moving the front object forward is a no-op (same reference).
    const same = reorderWithinLayer(stack, "c", 5);
    expect(same).toBe(stack);
  });

  it("reorderWithinLayer is a no-op for an unknown object or zero delta", () => {
    const stack = stackWith("a", "b");
    expect(reorderWithinLayer(stack, "missing", 1)).toBe(stack);
    expect(reorderWithinLayer(stack, "a", 0)).toBe(stack);
  });

  it("moveToLayer relocates an object between layers", () => {
    let stack = createLayerStack();
    stack = addLayer(stack, createLayer("layer-2", "Top"));
    stack = replaceLayer(stack, "layer-1", createLayer("layer-1", "Bottom", ["a", "b"]));
    const moved = moveToLayer(stack, "a", "layer-2");
    expect(layerOfObject(moved, "a")?.id).toBe("layer-2");
    expect(findLayer(moved, "layer-1")?.objectIds).toEqual(["b"]);
    expect(findLayer(moved, "layer-2")?.objectIds).toEqual(["a"]);
  });

  it("moveToLayer within the same layer is a no-op when the target is current", () => {
    const stack = stackWith("a", "b", "c");
    // "a" is already at index 0; moving it to index 0 changes nothing.
    const moved = moveToLayer(stack, "a", "layer-1", 0);
    expect(moved).toBe(stack);
  });

  it("moveToLayer within the same layer reorders to a new index", () => {
    const stack = stackWith("a", "b", "c");
    // Move "a" to the top (index 2 after removal → end).
    const moved = moveToLayer(stack, "a", "layer-1", 2);
    expect(findLayer(moved, "layer-1")?.objectIds).toEqual(["b", "c", "a"]);
  });

  it("reorderLayer moves a layer and clamps", () => {
    let stack = createLayerStack();
    stack = addLayer(stack, createLayer("layer-2", "Two"));
    stack = addLayer(stack, createLayer("layer-3", "Three"));
    const moved = reorderLayer(stack, "layer-1", 1);
    expect(layerIndex(moved, "layer-1")).toBe(1);
    // layer-3 is already at the top (index 2); a large positive delta clamps to
    // its current position and is a no-op (same reference).
    expect(reorderLayer(moved, "layer-3", 99)).toBe(moved);
  });

  it("removeLayer never empties the stack", () => {
    let stack = createLayerStack();
    stack = addLayer(stack, createLayer("layer-2", "Two"));
    expect(removeLayer(stack, "layer-1").layers).toHaveLength(1);
    // Removing from a single-layer stack is a no-op.
    expect(removeLayer(createLayerStack(), "layer-1").layers).toHaveLength(1);
  });

  it("layerOfObject finds the owning layer", () => {
    const stack = stackWith("a", "b");
    expect(layerOfObject(stack, "a")?.id).toBe("layer-1");
    expect(layerOfObject(stack, "missing")).toBeUndefined();
  });
});
