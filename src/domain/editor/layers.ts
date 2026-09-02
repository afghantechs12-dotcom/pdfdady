/**
 * The layer model for the PDFDadi editor.
 *
 * Paint order is determined by TWO ordered lists, not by a z-number on each
 * object:
 *   1. the {@link LayerStack.layers} array — bottom layer first, top layer last;
 *   2. each {@link Layer.objectIds} array — bottom object first, top object last.
 *
 * This avoids the classic drift where per-object `z` floats go stale after
 * reorder/undo. Reordering is an array splice; "bring forward" is a swap;
 * serialization writes the arrays directly. An object belongs to exactly one
 * layer (its `layerId`); moving it between layers updates both that field and
 * the two arrays atomically as part of a single command.
 */

/** A single layer: an ordered list of object ids plus layer-level flags. */
export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number; // 0..1, multiplies with each object's opacity
  /** Paint order within the layer: bottom object first, top object last. */
  objectIds: string[];
}

/** Creates a layer with sensible defaults and (optionally) a starting order. */
export function createLayer(
  id: string,
  name: string,
  objectIds: string[] = [],
): Layer {
  return {
    id,
    name,
    visible: true,
    locked: false,
    opacity: 1,
    objectIds: [...objectIds],
  };
}

/** The ordered stack of layers on a page. */
export interface LayerStack {
  /** Bottom layer first, top layer last. */
  layers: Layer[];
}

/** Creates an empty layer stack with a single default content layer. */
export function createLayerStack(firstLayerId = "layer-1"): LayerStack {
  return { layers: [createLayer(firstLayerId, "Layer 1")] };
}

/** Finds a layer by id, or undefined. */
export function findLayer(stack: LayerStack, layerId: string): Layer | undefined {
  return stack.layers.find((l) => l.id === layerId);
}

/** The index of a layer, or -1. */
export function layerIndex(stack: LayerStack, layerId: string): number {
  return stack.layers.findIndex((l) => l.id === layerId);
}

/** The layer an object belongs to, or undefined if its layerId is stale. */
export function layerOfObject(stack: LayerStack, objectId: string): Layer | undefined {
  return stack.layers.find((l) => l.objectIds.includes(objectId));
}

/**
 * The paint-ordered list of (objectId, layerId) pairs for a stack — bottom-most
 * first. Hidden or locked layers are still listed (render/interaction layers
 * filter on visibility/lock; this function is the structural source of truth).
 */
export function paintOrder(stack: LayerStack): Array<{ objectId: string; layerId: string }> {
  const out: Array<{ objectId: string; layerId: string }> = [];
  for (const layer of stack.layers) {
    for (const objectId of layer.objectIds) {
      out.push({ objectId, layerId: layer.id });
    }
  }
  return out;
}

/**
 * Moves an object within its layer by a relative delta (negative = toward the
 * back, positive = toward the front). Returns a new stack; no-op (returns the
 * same reference) if the object or its layer cannot be found or the delta is 0.
 */
export function reorderWithinLayer(
  stack: LayerStack,
  objectId: string,
  delta: number,
): LayerStack {
  if (delta === 0) return stack;
  const layer = layerOfObject(stack, objectId);
  if (!layer) return stack;
  const idx = layer.objectIds.indexOf(objectId);
  if (idx < 0) return stack;
  const next = [...layer.objectIds];
  // Clamp so the object can't leave its layer; cross-layer moves use moveToLayer.
  const target = Math.max(0, Math.min(next.length - 1, idx + delta));
  if (target === idx) return stack;
  next.splice(idx, 1);
  next.splice(target, 0, objectId);
  return replaceLayer(stack, layer.id, { ...layer, objectIds: next });
}

/**
 * Moves an object to a target layer at a given index (default: top). Returns a
 * new stack, or the same reference if the object is already there at that spot.
 */
export function moveToLayer(
  stack: LayerStack,
  objectId: string,
  targetLayerId: string,
  targetIndex?: number,
): LayerStack {
  const fromLayer = layerOfObject(stack, objectId);
  if (!fromLayer) return stack;
  const toLayer = findLayer(stack, targetLayerId);
  if (!toLayer) return stack;
  if (fromLayer.id === toLayer.id) {
    // Same-layer move is just a reorder.
    const idx = fromLayer.objectIds.indexOf(objectId);
    const target = targetIndex ?? fromLayer.objectIds.length - 1;
    if (target === idx) return stack;
    const next = [...fromLayer.objectIds];
    next.splice(idx, 1);
    next.splice(Math.min(target, next.length), 0, objectId);
    return replaceLayer(stack, fromLayer.id, { ...fromLayer, objectIds: next });
  }
  // Remove from source, insert into target.
  const fromNext = fromLayer.objectIds.filter((id) => id !== objectId);
  const toNext = [...toLayer.objectIds];
  const insertAt = targetIndex ?? toNext.length;
  toNext.splice(Math.min(insertAt, toNext.length), 0, objectId);
  let next = replaceLayer(stack, fromLayer.id, { ...fromLayer, objectIds: fromNext });
  next = replaceLayer(next, toLayer.id, { ...toLayer, objectIds: toNext });
  return next;
}

/** Reorders a whole layer by a relative delta (negative = down, positive = up). */
export function reorderLayer(stack: LayerStack, layerId: string, delta: number): LayerStack {
  if (delta === 0) return stack;
  const idx = layerIndex(stack, layerId);
  if (idx < 0) return stack;
  const target = Math.max(0, Math.min(stack.layers.length - 1, idx + delta));
  if (target === idx) return stack;
  const next = [...stack.layers];
  const [moved] = next.splice(idx, 1);
  next.splice(target, 0, moved);
  return { layers: next };
}

/** Adds a layer at a given index (default: top). Returns a new stack. */
export function addLayer(stack: LayerStack, layer: Layer, atIndex?: number): LayerStack {
  const next = [...stack.layers];
  next.splice(Math.min(atIndex ?? next.length, next.length), 0, layer);
  return { layers: next };
}

/** Removes a layer; objects on it are orphaned (caller should move them first). */
export function removeLayer(stack: LayerStack, layerId: string): LayerStack {
  if (stack.layers.length <= 1) return stack; // never empty the stack
  return { layers: stack.layers.filter((l) => l.id !== layerId) };
}

/** Returns a new stack with one layer replaced (matched by id). */
export function replaceLayer(
  stack: LayerStack,
  layerId: string,
  nextLayer: Layer,
): LayerStack {
  return {
    layers: stack.layers.map((l) => (l.id === layerId ? nextLayer : l)),
  };
}
