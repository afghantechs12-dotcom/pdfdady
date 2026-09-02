import type { AffineTransform } from "@/src/domain/editor/geometry";
import {
  getActivePage,
  getObject,
  setActivePage,
  setSelection,
  type EditorState,
  type SelectionState,
} from "@/src/domain/editor/document";
import {
  addObjectToPage,
  removeObjectFromPage,
  setObject,
} from "@/src/domain/editor/document";
import type { EditorObject } from "@/src/domain/editor/objects";
import {
  addLayer,
  createLayer,
  findLayer,
  layerIndex,
  layerOfObject,
  moveToLayer,
  removeLayer,
  reorderLayer,
  reorderWithinLayer,
  replaceLayer,
  type Layer,
} from "@/src/domain/editor/layers";
import { generateId } from "@/src/domain/editor/ids";
import { Command } from "./types";
import { SetTextContentCommand } from "./SetTextContentCommand";
import { SetTextFrameCommand } from "./SetTextFrameCommand";
import { SetTextStyleCommand } from "./SetTextStyleCommand";

/**
 * Concrete editor commands. Each is a pure before/after swap so `invert` is a
 * mirror of `apply` and round-trips stay exact across arbitrary undo/redo.
 *
 * Constructors take explicit `before`/`after` values (the caller — typically
 * the transform or layer service — reads the current state to capture `before`)
 * rather than capturing lazily, so commands have no hidden mutable state and
 * remain deterministic under coalescing and serialization.
 */

// ---------------------------------------------------------------------------
// Object add / remove
// ---------------------------------------------------------------------------

/** Adds an object to a layer (default: the top layer of the active page). */
export class AddObjectCommand implements Command {
  readonly type = "object.add";
  constructor(
    readonly label: string,
    private readonly object: EditorObject,
    private readonly layerId?: string,
  ) {}

  apply(state: EditorState): EditorState {
    const page = getActivePage(state);
    return setActivePage(state, addObjectToPage(page, this.object, this.layerId));
  }

  invert(state: EditorState): EditorState {
    const page = getActivePage(state);
    return setActivePage(state, removeObjectFromPage(page, this.object.id));
  }
}

/** Removes one or more objects from the active page. */
export class RemoveObjectsCommand implements Command {
  readonly type = "object.remove";
  constructor(
    readonly label: string,
    private readonly objects: EditorObject[],
  ) {}

  apply(state: EditorState): EditorState {
    let page = getActivePage(state);
    for (const obj of this.objects) {
      page = removeObjectFromPage(page, obj.id);
    }
    return setActivePage(state, page);
  }

  invert(state: EditorState): EditorState {
    let page = getActivePage(state);
    for (const obj of this.objects) {
      page = addObjectToPage(page, obj, obj.layerId);
    }
    return setActivePage(state, page);
  }
}

// ---------------------------------------------------------------------------
// Transform (move / resize / rotate) — coalesceable for live drag
// ---------------------------------------------------------------------------

/**
 * Sets the transforms of one or more objects on the active page. `before`/`after`
 * are id → transform maps. Used for move, resize, and rotate; a live gesture
 * emits many of these with a shared `coalesceKey` so they merge into one undo.
 */
export class TransformObjectsCommand implements Command {
  readonly type = "object.transform";
  readonly coalesceKey?: string;

  constructor(
    readonly label: string,
    private readonly before: Record<string, AffineTransform>,
    private readonly after: Record<string, AffineTransform>,
    coalesceKey?: string,
  ) {
    this.coalesceKey = coalesceKey;
  }

  apply(state: EditorState): EditorState {
    let page = getActivePage(state);
    for (const [id, transform] of Object.entries(this.after)) {
      const obj = getObject(page, id);
      if (obj) page = setObject(page, { ...obj, transform });
    }
    return setActivePage(state, page);
  }

  invert(state: EditorState): EditorState {
    let page = getActivePage(state);
    for (const [id, transform] of Object.entries(this.before)) {
      const obj = getObject(page, id);
      if (obj) page = setObject(page, { ...obj, transform });
    }
    return setActivePage(state, page);
  }

  /**
   * Merges a follow-up transform with the same coalesce key: keep this command's
   * original `before` (the gesture start) and adopt the follow-up's `after` (the
   * latest position), so the whole drag undoes back to where it began.
   */
  merge(next: Command): Command | null {
    if (!(next instanceof TransformObjectsCommand) || next.type !== this.type) return null;
    return new TransformObjectsCommand(this.label, this.before, next.after, this.coalesceKey);
  }
}

// ---------------------------------------------------------------------------
// Property edits (text content, color, opacity, style, …)
// ---------------------------------------------------------------------------

/**
 * Applies a partial patch (`after`) to an object's properties, with `before`
 * holding the previous values of exactly those keys so `invert` restores them.
 * Only top-level object fields are patched; nested edits (e.g. style.fill) must
 * supply the full nested value in both `before` and `after`.
 *
 * Invariant: the patch MUST NOT include `kind` — changing an object's kind is a
 * remove+add, not a property edit. Preserving the discriminant is what lets the
 * spread below stay a valid member of the {@link EditorObject} union; the cast
 * is safe under that invariant (it documents it rather than weakening it).
 */
export class SetPropertyCommand implements Command {
  readonly type = "object.setProperty";
  constructor(
    readonly label: string,
    private readonly objectId: string,
    private readonly before: Partial<EditorObject>,
    private readonly after: Partial<EditorObject>,
  ) {}

  apply(state: EditorState): EditorState {
    const page = getActivePage(state);
    const obj = getObject(page, this.objectId);
    if (!obj) return state;
    return setActivePage(state, setObject(page, { ...obj, ...this.after } as EditorObject));
  }

  invert(state: EditorState): EditorState {
    const page = getActivePage(state);
    const obj = getObject(page, this.objectId);
    if (!obj) return state;
    return setActivePage(state, setObject(page, { ...obj, ...this.before } as EditorObject));
  }
}

// ---------------------------------------------------------------------------
// Layer / z-order
// ---------------------------------------------------------------------------

/** Reorders an object within its layer by a relative delta. */
export class ReorderObjectCommand implements Command {
  readonly type = "layer.reorderObject";
  constructor(
    readonly label: string,
    private readonly objectId: string,
    private readonly delta: number,
  ) {}

  apply(state: EditorState): EditorState {
    const page = getActivePage(state);
    return setActivePage(state, {
      ...page,
      layerStack: reorderWithinLayer(page.layerStack, this.objectId, this.delta),
    });
  }

  invert(state: EditorState): EditorState {
    const page = getActivePage(state);
    return setActivePage(state, {
      ...page,
      layerStack: reorderWithinLayer(page.layerStack, this.objectId, -this.delta),
    });
  }
}

/**
 * Moves an object to a different layer (or a new index in its own layer). The
 * source layer + index are captured explicitly (via the {@link moveToLayerCommand}
 * factory) so `invert` restores the exact original position.
 */
export class MoveToLayerCommand implements Command {
  readonly type = "layer.moveToLayer";
  constructor(
    readonly label: string,
    private readonly objectId: string,
    private readonly fromLayerId: string,
    private readonly fromIndex: number,
    private readonly targetLayerId: string,
    private readonly targetIndex: number | undefined,
  ) {}

  apply(state: EditorState): EditorState {
    const page = getActivePage(state);
    return setActivePage(state, {
      ...page,
      layerStack: moveToLayer(page.layerStack, this.objectId, this.targetLayerId, this.targetIndex),
    });
  }

  invert(state: EditorState): EditorState {
    const page = getActivePage(state);
    return setActivePage(state, {
      ...page,
      layerStack: moveToLayer(page.layerStack, this.objectId, this.fromLayerId, this.fromIndex),
    });
  }
}

/** Reorders a whole layer by a relative delta (negative = down, positive = up). */
export class ReorderLayerCommand implements Command {
  readonly type = "layer.reorder";
  constructor(
    readonly label: string,
    private readonly layerId: string,
    private readonly delta: number,
  ) {}

  apply(state: EditorState): EditorState {
    const page = getActivePage(state);
    return setActivePage(state, {
      ...page,
      layerStack: reorderLayer(page.layerStack, this.layerId, this.delta),
    });
  }

  invert(state: EditorState): EditorState {
    const page = getActivePage(state);
    return setActivePage(state, {
      ...page,
      layerStack: reorderLayer(page.layerStack, this.layerId, -this.delta),
    });
  }
}

/** Adds a layer at a given index (default: top). Invert removes it. */
export class AddLayerCommand implements Command {
  readonly type = "layer.add";
  constructor(
    readonly label: string,
    private readonly layer: ReturnType<typeof createLayer>,
    private readonly atIndex?: number,
  ) {}

  apply(state: EditorState): EditorState {
    const page = getActivePage(state);
    return setActivePage(state, {
      ...page,
      layerStack: addLayer(page.layerStack, this.layer, this.atIndex),
    });
  }

  invert(state: EditorState): EditorState {
    const page = getActivePage(state);
    return setActivePage(state, {
      ...page,
      layerStack: removeLayer(page.layerStack, this.layer.id),
    });
  }
}

/**
 * Removes a layer; invert re-adds the captured layer at its original index with
 * its objects intact. Built via the {@link removeLayerCommand} factory, which
 * snapshots the layer + position before removal.
 */
export class RemoveLayerCommand implements Command {
  readonly type = "layer.remove";
  constructor(
    readonly label: string,
    private readonly layer: ReturnType<typeof createLayer>,
    private readonly atIndex: number,
  ) {}

  apply(state: EditorState): EditorState {
    const page = getActivePage(state);
    return setActivePage(state, {
      ...page,
      layerStack: removeLayer(page.layerStack, this.layer.id),
    });
  }

  invert(state: EditorState): EditorState {
    const page = getActivePage(state);
    return setActivePage(state, {
      ...page,
      layerStack: addLayer(page.layerStack, this.layer, this.atIndex),
    });
  }
}

// ---------------------------------------------------------------------------
// Page + selection
// ---------------------------------------------------------------------------

/** Switches the active page. before/after are the old/new active page ids. */
export class SetActivePageCommand implements Command {
  readonly type = "page.setActive";
  constructor(
    readonly label: string,
    private readonly beforePageId: string,
    private readonly afterPageId: string,
  ) {}

  apply(state: EditorState): EditorState {
    return { ...state, activePageId: this.afterPageId };
  }

  invert(state: EditorState): EditorState {
    return { ...state, activePageId: this.beforePageId };
  }
}

/**
 * Replaces the selection. Selection is usually managed OUTSIDE the undo stack
 * (it is transient UI state, not document state), but this command lets a
 * workflow record selection as part of a composite when that is desirable.
 */
export class ChangeSelectionCommand implements Command {
  readonly type = "selection.change";
  constructor(
    readonly label: string,
    private readonly before: SelectionState,
    private readonly after: SelectionState,
  ) {}

  apply(state: EditorState): EditorState {
    return setSelection(state, this.after);
  }

  invert(state: EditorState): EditorState {
    return setSelection(state, this.before);
  }
}

// ---------------------------------------------------------------------------
// Capture helpers — read the current state to build before/after commands.
// ---------------------------------------------------------------------------

/** Snapshots the current transforms of the given ids (the `before` for a transform). */
export function captureTransforms(
  state: EditorState,
  ids: string[],
): Record<string, AffineTransform> {
  const page = getActivePage(state);
  const out: Record<string, AffineTransform> = {};
  for (const id of ids) {
    const obj = getObject(page, id);
    if (obj) out[id] = obj.transform;
  }
  return out;
}

/** Builds a MoveToLayerCommand with the object's current layer + index captured. */
export function moveToLayerCommand(
  state: EditorState,
  objectId: string,
  targetLayerId: string,
  targetIndex?: number,
  label = "Move to layer",
): MoveToLayerCommand {
  const page = getActivePage(state);
  const fromLayer = layerOfObject(page.layerStack, objectId);
  if (!fromLayer) {
    throw new Error(`Cannot move object ${objectId}: not found in any layer.`);
  }
  const fromIndex = fromLayer.objectIds.indexOf(objectId);
  return new MoveToLayerCommand(label, objectId, fromLayer.id, fromIndex, targetLayerId, targetIndex);
}

/** Builds a RemoveLayerCommand with the layer + its index captured for invert. */
export function removeLayerCommand(
  state: EditorState,
  layerId: string,
  label = "Delete layer",
): RemoveLayerCommand {
  const page = getActivePage(state);
  const layer = findLayer(page.layerStack, layerId);
  if (!layer) {
    throw new Error(`Cannot remove layer ${layerId}: not found.`);
  }
  const atIndex = page.layerStack.layers.findIndex((l) => l.id === layerId);
  return new RemoveLayerCommand(label, layer, atIndex);
}

/** Convenience: replace a single object wholesale (used by some property edits). */
export function replaceObjectCommand(
  label: string,
  before: EditorObject,
  after: EditorObject,
): SetPropertyCommand {
  // A full-object replace is expressed as a property patch of every differing
  // key; for the common case we just patch the whole object via before/after.
  return new SetPropertyCommand(label, after.id, before, after);
}

// ---------------------------------------------------------------------------
// Text commands (M5 Part 2 Slice 3)
// ---------------------------------------------------------------------------

export { SetTextContentCommand, SetTextFrameCommand, SetTextStyleCommand };

// ---------------------------------------------------------------------------
// Layer property + duplicate (Part 5 — Layers panel: rename / hide / lock / duplicate)
// ---------------------------------------------------------------------------

/**
 * Patches a layer's own properties (name, visible, locked, opacity). `before`/
 * `after` are partials of exactly the keys being changed so `invert` restores
 * them. Object membership + paint order are untouched.
 */
export class SetLayerPropertyCommand implements Command {
  readonly type = "layer.setProperty";
  constructor(
    readonly label: string,
    private readonly layerId: string,
    private readonly before: Partial<Layer>,
    private readonly after: Partial<Layer>,
  ) {}

  apply(state: EditorState): EditorState {
    const page = getActivePage(state);
    const layer = findLayer(page.layerStack, this.layerId);
    if (!layer) return state;
    return setActivePage(state, {
      ...page,
      layerStack: replaceLayer(page.layerStack, this.layerId, { ...layer, ...this.after }),
    });
  }

  invert(state: EditorState): EditorState {
    const page = getActivePage(state);
    const layer = findLayer(page.layerStack, this.layerId);
    if (!layer) return state;
    return setActivePage(state, {
      ...page,
      layerStack: replaceLayer(page.layerStack, this.layerId, { ...layer, ...this.before }),
    });
  }
}

/**
 * Duplicates a layer and every object on it, giving the copy fresh ids. The
 * cloned layer is inserted immediately above the source. `invert` removes the
 * cloned layer + its cloned objects. The new layer + cloned objects are captured
 * at build time (via {@link duplicateLayerCommand}) so apply/invert are exact.
 */
export class DuplicateLayerCommand implements Command {
  readonly type = "layer.duplicate";
  constructor(
    readonly label: string,
    private readonly newLayer: Layer,
    private readonly clonedObjects: EditorObject[],
    private readonly atIndex: number,
  ) {}

  apply(state: EditorState): EditorState {
    const page = getActivePage(state);
    const objects = { ...page.objects };
    for (const obj of this.clonedObjects) objects[obj.id] = obj;
    return setActivePage(state, {
      ...page,
      objects,
      layerStack: addLayer(page.layerStack, this.newLayer, this.atIndex),
    });
  }

  invert(state: EditorState): EditorState {
    const page = getActivePage(state);
    let objects = page.objects;
    for (const obj of this.clonedObjects) {
      const { [obj.id]: _removed, ...rest } = objects;
      void _removed;
      objects = rest;
    }
    return setActivePage(state, {
      ...page,
      objects,
      layerStack: removeLayer(page.layerStack, this.newLayer.id),
    });
  }
}

/**
 * Builds a {@link DuplicateLayerCommand} for `layerId`: snapshots the source
 * layer + its objects, generates fresh ids for the copy, and captures the
 * insertion index (one above the source). Cloned objects keep their transforms
 * + properties but get new ids + the new layer id. Returns the command + the new
 * layer id (mirrors {@link LayerService.addLayer}'s shape).
 */
export function duplicateLayerCommand(
  state: EditorState,
  layerId: string,
  label = "Duplicate layer",
): { command: DuplicateLayerCommand; layerId: string } {
  const page = getActivePage(state);
  const source = findLayer(page.layerStack, layerId);
  if (!source) {
    throw new Error(`Cannot duplicate layer ${layerId}: not found.`);
  }
  const newLayerId = generateId("layer");
  const clonedObjects: EditorObject[] = [];
  const newObjectIds: string[] = [];
  for (const oldId of source.objectIds) {
    const obj = page.objects[oldId];
    if (!obj) continue;
    const newId = generateId("obj");
    newObjectIds.push(newId);
    clonedObjects.push({ ...obj, id: newId, layerId: newLayerId, metadata: { ...obj.metadata } });
  }
  const newLayer = createLayer(newLayerId, `${source.name} copy`, newObjectIds);
  const atIndex = layerIndex(page.layerStack, layerId) + 1;
  return { command: new DuplicateLayerCommand(label, newLayer, clonedObjects, atIndex), layerId: newLayerId };
}
