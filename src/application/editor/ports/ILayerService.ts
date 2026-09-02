import type { Command } from "../commands/types";
import type { EditorState } from "@/src/domain/editor/document";
import type { Layer } from "@/src/domain/editor/layers";
import type { EditorObject } from "@/src/domain/editor/objects";

/**
 * Port: cohesive layer operations as undoable commands.
 *
 * Each method inspects the current state and returns a {@link Command} ready to
 * hand to the history (the caller decides whether to execute it directly, inside
 * a transaction, or coalesce it). Queries (`layersOf`, `objectsInLayer`) return
 * plain data. This is the single entry point for layer/z-order intents so the
 * command classes themselves stay low-level and the UI doesn't reach into them.
 */
export interface ILayerService {
  /** Moves an object one slot toward the front of its layer. */
  bringForward(objectId: string): Command;
  /** Moves an object one slot toward the back of its layer. */
  sendBackward(objectId: string): Command;
  /** Moves an object to the top of its layer (needs state to compute the delta). */
  bringToFront(state: EditorState, objectId: string): Command;
  /** Moves an object to the bottom of its layer (needs state to compute the delta). */
  sendToBack(state: EditorState, objectId: string): Command;
  /** Moves an object to a different layer (or a new index in its own layer). */
  moveToLayer(
    state: EditorState,
    objectId: string,
    targetLayerId: string,
    targetIndex?: number,
  ): Command;
  /** Creates a new layer at the top of the stack. Returns the command + new id. */
  addLayer(name: string): { command: Command; layerId: string };
  /** Deletes a layer (capturing it for undo); refuses the last layer. */
  deleteLayer(state: EditorState, layerId: string): Command;
  /** Moves a whole layer up (positive delta) or down (negative). */
  reorderLayer(layerId: string, delta: number): Command;
  /** Patches a layer's own properties (name/visible/locked/opacity). */
  setLayerProperty(
    state: EditorState,
    layerId: string,
    patch: Partial<Omit<Layer, "id" | "objectIds">>,
    label?: string,
  ): Command;
  /** Duplicates a layer + its objects; returns the command + the new layer id. */
  duplicateLayer(state: EditorState, layerId: string): { command: Command; layerId: string };
  /** The ordered layers of the active page (bottom first). */
  layersOf(state: EditorState): Layer[];
  /** The objects on a layer of the active page, in paint order. */
  objectsInLayer(state: EditorState, layerId: string): EditorObject[];
}
