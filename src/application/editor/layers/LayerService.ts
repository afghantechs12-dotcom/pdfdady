import type { Command } from "../commands/types";
import type { EditorState } from "@/src/domain/editor/document";
import { getActivePage } from "@/src/domain/editor/document";
import type { Layer } from "@/src/domain/editor/layers";
import { createLayer, findLayer, layerOfObject } from "@/src/domain/editor/layers";
import type { EditorObject } from "@/src/domain/editor/objects";
import { generateId } from "@/src/domain/editor/ids";
import {
  AddLayerCommand,
  ReorderLayerCommand,
  ReorderObjectCommand,
  SetLayerPropertyCommand,
  duplicateLayerCommand,
  moveToLayerCommand,
  removeLayerCommand,
} from "../commands/commands";
import type { ILayerService } from "../ports/ILayerService";

/**
 * Layer operations as undoable commands. Methods are pure: they read the state
 * (when needed) and return a command, or plain data for queries; they never
 * mutate. The UI executes the returned command through the history, optionally
 * inside a transaction or with a coalesce key. Only the methods that need to
 * inspect the current state take it — `bringForward`/`sendBackward`/`addLayer`/
 * `reorderLayer` are state-independent, so their signatures omit it.
 */
export class LayerService implements ILayerService {
  bringForward(objectId: string): Command {
    return new ReorderObjectCommand("Bring forward", objectId, 1);
  }

  sendBackward(objectId: string): Command {
    return new ReorderObjectCommand("Send backward", objectId, -1);
  }

  bringToFront(state: EditorState, objectId: string): Command {
    const page = getActivePage(state);
    const layer = layerOfObject(page.layerStack, objectId);
    if (!layer) return new ReorderObjectCommand("Bring to front", objectId, 0);
    const idx = layer.objectIds.indexOf(objectId);
    const delta = layer.objectIds.length - 1 - idx;
    return new ReorderObjectCommand("Bring to front", objectId, delta);
  }

  sendToBack(state: EditorState, objectId: string): Command {
    const page = getActivePage(state);
    const layer = layerOfObject(page.layerStack, objectId);
    if (!layer) return new ReorderObjectCommand("Send to back", objectId, 0);
    const idx = layer.objectIds.indexOf(objectId);
    return new ReorderObjectCommand("Send to back", objectId, -idx);
  }

  moveToLayer(
    state: EditorState,
    objectId: string,
    targetLayerId: string,
    targetIndex?: number,
  ): Command {
    return moveToLayerCommand(state, objectId, targetLayerId, targetIndex, "Move to layer");
  }

  addLayer(name: string): { command: Command; layerId: string } {
    const layerId = generateId("layer");
    const layer = createLayer(layerId, name);
    return { command: new AddLayerCommand("Add layer", layer), layerId };
  }

  deleteLayer(state: EditorState, layerId: string): Command {
    return removeLayerCommand(state, layerId, "Delete layer");
  }

  reorderLayer(layerId: string, delta: number): Command {
    return new ReorderLayerCommand("Reorder layer", layerId, delta);
  }

  /**
   * Patches a layer's own properties (name, visible, locked, opacity). Captures
   * the `before` values of the patched keys from the current layer so `invert`
   * restores them. `patch` must not include `id`/`objectIds` (those are
   * structural; use the dedicated reorder/move commands).
   */
  setLayerProperty(
    state: EditorState,
    layerId: string,
    patch: Partial<Omit<Layer, "id" | "objectIds">>,
    label = "Edit layer",
  ): Command {
    const layer = findLayer(getActivePage(state).layerStack, layerId);
    if (!layer) {
      throw new Error(`Cannot edit layer ${layerId}: not found.`);
    }
    const before = {} as Record<keyof Layer, unknown>;
    for (const key of Object.keys(patch) as Array<keyof Layer>) {
      before[key] = layer[key];
    }
    return new SetLayerPropertyCommand(label, layerId, before as Partial<Layer>, patch as Partial<Layer>);
  }

  /** Duplicates a layer + its objects; returns the command + the new layer id. */
  duplicateLayer(state: EditorState, layerId: string): { command: Command; layerId: string } {
    return duplicateLayerCommand(state, layerId);
  }

  layersOf(state: EditorState): Layer[] {
    return getActivePage(state).layerStack.layers;
  }

  objectsInLayer(state: EditorState, layerId: string): EditorObject[] {
    const page = getActivePage(state);
    const layer = findLayer(page.layerStack, layerId);
    if (!layer) return [];
    return layer.objectIds
      .map((id) => page.objects[id])
      .filter((o): o is EditorObject => Boolean(o));
  }
}
