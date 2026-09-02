"use client";

import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { createEditorInstance } from "@/lib/editor/createEditorInstance";
import { SetPropertyCommand, SetActivePageCommand } from "@/src/application/editor/commands/commands";
import type { Command } from "@/src/application/editor/commands/types";
import type { EditorDocumentService } from "@/src/application/editor/EditorDocumentService";
import type { ResizeHandle } from "@/src/application/editor/transform/TransformService";
import {
  getActivePage,
  type EditorObject,
  type EditorState,
  type SelectionState,
} from "@/src/domain/editor/document";
import { worldBounds, pageObjects } from "@/src/domain/editor/document";
import type { Bounds, Point, Vec2 } from "@/src/domain/editor/geometry";
import { unionBounds } from "@/src/domain/editor/geometry";
import {
  createAnnotation,
  createDrawing,
  createHighlight,
  createImageObject,
  createShapeObject,
  createSignature,
  createTextObject,
} from "@/src/domain/editor/objectFactories";
import type { AlignmentTarget } from "@/src/application/editor/extensions/AlignmentEngine";
import type {
  AnnotationObject,
  DrawingObject,
  HighlightObject,
  ImageObject,
  ShapeKind,
  ShapeObject,
  SignatureObject,
  TextObject,
} from "@/src/domain/editor/objects";

/**
 * The React binding for the headless editor. Creates one
 * {@link EditorDocumentService} per mounting surface (via
 * {@link createEditorInstance}), subscribes to it with
 * `useSyncExternalStore` so React re-renders on every state change, and exposes
 * the active page, the derived selection, and a full action API wrapping the
 * facade + command builders.
 *
 * The service is the single source of truth — React only mirrors it. Selection
 * is included in {@link EditorState} (transient, not undoable) so selecting an
 * object also re-renders, without touching the undo stack.
 */

export interface EditorSelection {
  ids: string[];
  primaryId: string | null;
  objects: EditorObject[];
  bounds: Bounds | null;
}

export interface UseEditorResult {
  state: EditorState;
  service: EditorDocumentService;
  activePage: ReturnType<typeof getActivePage>;
  selection: EditorSelection;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  undoDepth: number;
  /**
   * Monotonic count of applied mutations. Use this — not `undoDepth` — to decide
   * whether the document has changed since a save/export.
   */
  revision: number;
  actions: EditorActions;
}

/** A partial object patch for {@link EditorActions.setProperty}. */
type PropertyPatch<T extends EditorObject> = Partial<Omit<T, "kind">>;

export interface EditorActions {
  // --- Selection (transient) ---
  select(id: string): void;
  addToSelection(id: string): void;
  toggleSelection(id: string): void;
  selectMany(ids: string[]): void;
  selectAll(): void;
  clearSelection(): void;
  setPrimary(id: string): void;

  // --- History ---
  undo(): void;
  redo(): void;
  beginTransaction(label: string): void;
  commit(): void;
  rollback(): void;

  // --- Object creation (returns the new id) ---
  addObject(obj: EditorObject): void;
  addText(position: Point, overrides?: Partial<TextObject>): string;
  addImage(position: Point, src: string, naturalWidth: number, naturalHeight: number, overrides?: Partial<ImageObject>): string;
  addShape(position: Point, shape: ShapeKind, overrides?: Partial<ShapeObject>): string;
  addHighlight(position: Point, overrides?: Partial<HighlightObject>): string;
  addDrawing(position: Point, points: Point[], overrides?: Partial<DrawingObject>): string;
  addAnnotation(position: Point, overrides?: Partial<AnnotationObject>): string;
  addSignature(position: Point, src: string, naturalWidth: number, naturalHeight: number, signer: string, overrides?: Partial<SignatureObject>): string;

  // --- Object mutation ---
  deleteSelected(): void;
  setProperty<T extends EditorObject>(id: string, patch: PropertyPatch<T>, label?: string): void;
  execute(command: Command): void;

  // --- Transform (live gestures pass a gestureKey so they coalesce into one undo) ---
  moveSelection(delta: Vec2, gestureKey?: string): void;
  resizeObject(id: string, handle: ResizeHandle, newWorld: Point, gestureKey?: string): void;
  resizeSelection(handle: ResizeHandle, newOppositeWorld: Point, gestureKey?: string): void;
  rotateSelection(center: Point, deltaRadians: number, gestureKey?: string): void;
  flipSelection(axis: "x" | "y"): void;
  setObjectSize(id: string, width: number, height: number): void;
  alignSelection(target: AlignmentTarget): void;
  distributeSelection(axis: "horizontal" | "vertical"): void;

  // --- Z-order / layers ---
  bringForward(id: string): void;
  sendBackward(id: string): void;
  bringToFront(id: string): void;
  sendToBack(id: string): void;
  moveToLayer(id: string, targetLayerId: string, targetIndex?: number): void;
  addLayer(name: string): string;
  deleteLayer(layerId: string): void;
  reorderLayer(layerId: string, delta: number): void;
  setLayerProperty(layerId: string, patch: Partial<{ name: string; visible: boolean; locked: boolean; opacity: number }>, label?: string): void;
  duplicateLayer(layerId: string): string;

  // --- History navigation (Part 6) ---
  undoLabels(): string[];
  redoLabels(): string[];
  jumpTo(targetUndoDepth: number): void;

  // --- Pages ---
  setActivePage(pageId: string): void;

  // --- Serialization / lifecycle ---
  serialize(): ReturnType<EditorDocumentService["serialize"]>;
  deserialize(data: unknown): void;
  loadState(state: EditorState): void;
  reset(): void;
}

/** Creates the action set bound to a service instance. Actions are stable (they read fresh state from the service). */
function buildActions(service: EditorDocumentService): EditorActions {
  const topLayerId = (): string => {
    const page = getActivePage(service.getState());
    const layers = page.layerStack.layers;
    return layers[layers.length - 1].id;
  };

  const setProperty = <T extends EditorObject>(id: string, patch: PropertyPatch<T>, label = "Edit property"): void => {
    const page = getActivePage(service.getState());
    const obj = page.objects[id];
    if (!obj) return;
    // `before` holds the current values of exactly the patched keys (no `kind`).
    const before: Partial<EditorObject> = {};
    for (const key of Object.keys(patch) as Array<keyof T>) {
      (before as Record<string, unknown>)[key as string] = obj[key as keyof EditorObject];
    }
    service.execute(new SetPropertyCommand(label, id, before, patch as Partial<EditorObject>));
  };

  return {
    select: (id) => service.select(id),
    addToSelection: (id) => service.addToSelection(id),
    toggleSelection: (id) => service.toggleSelection(id),
    selectMany: (ids) => service.selectMany(ids),
    selectAll: () => service.selectAll(),
    clearSelection: () => service.clearSelection(),
    setPrimary: (id) => service.setPrimary(id),

    undo: () => service.undo(),
    redo: () => service.redo(),
    beginTransaction: (label) => service.beginTransaction(label),
    commit: () => service.commit(),
    rollback: () => service.rollback(),

    addObject: (obj) => service.addObject(obj, obj.layerId),
    addText: (position, overrides) => {
      const obj = createTextObject(position, topLayerId(), overrides);
      service.addObject(obj, obj.layerId);
      return obj.id;
    },
    addImage: (position, src, naturalWidth, naturalHeight, overrides) => {
      const obj = createImageObject(position, topLayerId(), src, naturalWidth, naturalHeight, overrides);
      service.addObject(obj, obj.layerId);
      return obj.id;
    },
    addShape: (position, shape, overrides) => {
      const obj = createShapeObject(position, topLayerId(), shape, overrides);
      service.addObject(obj, obj.layerId);
      return obj.id;
    },
    addHighlight: (position, overrides) => {
      const obj = createHighlight(position, topLayerId(), overrides);
      service.addObject(obj, obj.layerId);
      return obj.id;
    },
    addDrawing: (position, points, overrides) => {
      const obj = createDrawing(position, topLayerId(), points, overrides);
      service.addObject(obj, obj.layerId);
      return obj.id;
    },
    addAnnotation: (position, overrides) => {
      const obj = createAnnotation(position, topLayerId(), overrides);
      service.addObject(obj, obj.layerId);
      return obj.id;
    },
    addSignature: (position, src, naturalWidth, naturalHeight, signer, overrides) => {
      const obj = createSignature(position, topLayerId(), src, naturalWidth, naturalHeight, signer, overrides);
      service.addObject(obj, obj.layerId);
      return obj.id;
    },

    deleteSelected: () => service.removeSelected(),
    setProperty,
    execute: (command) => service.execute(command),

    moveSelection: (delta, gestureKey) => service.moveSelection(delta, gestureKey),
    resizeObject: (id, handle, newWorld, gestureKey) => service.resizeObject(id, handle, newWorld, gestureKey),
    resizeSelection: (handle, newOppositeWorld, gestureKey) => service.resizeSelection(handle, newOppositeWorld, gestureKey),
    rotateSelection: (center, deltaRadians, gestureKey) => service.rotateSelection(center, deltaRadians, gestureKey),
    flipSelection: (axis) => service.flipSelection(axis),
    setObjectSize: (id, width, height) => service.setObjectSize(id, width, height),
    alignSelection: (target) => service.alignSelection(target),
    distributeSelection: (axis) => service.distributeSelection(axis),

    bringForward: (id) => service.bringForward(id),
    sendBackward: (id) => service.sendBackward(id),
    bringToFront: (id) => service.bringToFront(id),
    sendToBack: (id) => service.sendToBack(id),
    moveToLayer: (id, targetLayerId, targetIndex) => service.moveToLayer(id, targetLayerId, targetIndex),
    addLayer: (name) => service.addLayer(name),
    deleteLayer: (layerId) => service.deleteLayer(layerId),
    reorderLayer: (layerId, delta) => service.reorderLayer(layerId, delta),
    setLayerProperty: (layerId, patch, label) => service.setLayerProperty(layerId, patch, label),
    duplicateLayer: (layerId) => service.duplicateLayer(layerId),

    undoLabels: () => service.undoLabels(),
    redoLabels: () => service.redoLabels(),
    jumpTo: (targetUndoDepth) => service.jumpTo(targetUndoDepth),

    setActivePage: (pageId) => {
      const current = service.getState().activePageId;
      if (current === pageId) return;
      service.execute(new SetActivePageCommand("Switch page", current, pageId));
    },

    serialize: () => service.serialize(),
    deserialize: (data) => service.deserialize(data),
    loadState: (state) => service.loadState(state),
    reset: () => service.reset(),
  };
}

/**
 * Binds a headless editor instance to React. `initialState` is used only on the
 * first mount; subsequent changes are ignored (the editor owns its state after
 * creation). Pass an initial state to seed a loaded document.
 */
export function useEditor(initialState?: EditorState): UseEditorResult {
  const ref = useRef<EditorDocumentService | null>(null);
  if (ref.current === null) {
    ref.current = createEditorInstance(initialState);
  }
  const service = ref.current;

  const subscribe = useCallback((onStoreChange: () => void) => service.subscribe(onStoreChange), [service]);
  const getSnapshot = useCallback(() => service.getState(), [service]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const actions = useMemo(() => buildActions(service), [service]);

  const activePage = getActivePage(state);

  const selection = useMemo<EditorSelection>(() => {
    const sel: SelectionState = state.selection;
    const objects = sel.ids
      .map((id) => activePage.objects[id])
      .filter((o): o is EditorObject => Boolean(o));
    let bounds: Bounds | null = null;
    for (const obj of objects) {
      const b = worldBounds(obj);
      bounds = bounds ? unionBounds(bounds, b) : b;
    }
    return { ids: sel.ids, primaryId: sel.primaryId, objects, bounds };
  }, [state, activePage]);

  return {
    state,
    service,
    activePage,
    selection,
    canUndo: service.canUndo,
    canRedo: service.canRedo,
    undoLabel: service.undoLabel,
    redoLabel: service.redoLabel,
    undoDepth: service.undoDepth,
    revision: service.revision,
    actions,
  };
}

/** Re-exported for components that need the paint-ordered object list of a page. */
export { pageObjects };
