import type { Vec2, Point, Bounds, AffineTransform } from "@/src/domain/editor/geometry";
import { compose, decompose, makeScale, makeTranslate } from "@/src/domain/editor/geometry";
import {
  createEditorState,
  getActivePage,
  getPage,
  worldBounds,
  type EditorPage,
  type EditorState,
  type SelectionState,
} from "@/src/domain/editor/document";
import { createBlankPage, isPageRotation, type PageRotation } from "@/src/domain/editor/pageOperations";
import type { EditorObject } from "@/src/domain/editor/objects";
import { alignToEdge, distributeObjects, type AlignmentTarget } from "./extensions/AlignmentEngine";
import { generateId } from "@/src/domain/editor/ids";
import { CommandHistory } from "./commands/CommandHistory";
import type { Command } from "./commands/types";
import {
  AddObjectCommand,
  RemoveObjectsCommand,
  TransformObjectsCommand,
  captureTransforms,
} from "./commands/commands";
import {
  InsertPageCommand,
  SetPageRotationCommand,
  SetPageSizeCommand,
  duplicatePageCommand,
  movePageCommand,
  removePageCommand,
} from "./commands/pageCommands";
import {
  flipObject,
  moveCommand,
  resizeCommand,
  resizeSelectionCommand,
  rotateCommand,
  type ResizeHandle,
} from "./transform/TransformService";
import type { ISelectionService } from "./ports/ISelectionService";
import type { ILayerService } from "./ports/ILayerService";
import type { ISerializer } from "./ports/ISerializer";
import type { PluginRegistry } from "./plugins/PluginRegistry";

/**
 * The editor facade: a self-contained, headless editor instance.
 *
 * It owns the current {@link EditorState} and a {@link CommandHistory}, and
 * exposes the operations a UI needs (run a command, undo/redo, transactions,
 * selection, add/remove, transform, layers, serialize). Every mutating op runs
 * through the history so undo/redo is central, and every change notifies
 * subscribers — a React hook subscribes and re-renders, keeping the editor's
 * state the single source of truth.
 *
 * Selection is NOT recorded on the undo stack (it's transient UI state); only
 * document mutations are. Live gestures (drag, resize, rotate) take a
 * `gestureKey` so their many micro-commands coalesce into one undo entry.
 */
export interface EditorDocumentServiceDeps {
  history: CommandHistory;
  selection: ISelectionService;
  layers: ILayerService;
  serializer: ISerializer;
  plugins: PluginRegistry;
  textLayoutEngine?: any; // Placeholder for text layout engine
  initialState?: EditorState;
}

export class EditorDocumentService {
  private state: EditorState;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: EditorDocumentServiceDeps) {
    this.state = deps.initialState ?? createEditorState();
  }

  // --- State + subscription -------------------------------------------------

  getState(): EditorState {
    return this.state;
  }

  /** Replaces the state directly (e.g. loading a deserialized document). */
  loadState(state: EditorState): void {
    this.state = state;
    this.deps.history.clear();
    this.notify();
  }

  /** Resets to a fresh empty document. */
  reset(): void {
    this.loadState(createEditorState());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- History ---------------------------------------------------------------

  get canUndo(): boolean {
    return this.deps.history.canUndo;
  }
  get canRedo(): boolean {
    return this.deps.history.canRedo;
  }
  get undoLabel(): string | null {
    return this.deps.history.undoLabel;
  }
  get redoLabel(): string | null {
    return this.deps.history.redoLabel;
  }

  /** Runs a command through the history and updates state. */
  execute(command: Command): void {
    this.applyCommand(command);
    this.notify();
  }

  /** Runs a command without notifying — for composing multiple ops into one notification. */
  private applyCommand(command: Command): void {
    this.state = this.deps.history.execute(command, this.state);

    // Invalidate cache for text objects if applicable
    if (this.deps.textLayoutEngine && command.getAffectedObjectIds) {
      const affectedIds = command.getAffectedObjectIds();
      if (affectedIds && affectedIds.length > 0) {
        this.deps.textLayoutEngine.invalidate(affectedIds);
      }
    }
  }

  undo(): void {
    this.state = this.deps.history.undo(this.state);
    this.notify();
  }

  redo(): void {
    this.state = this.deps.history.redo(this.state);
    this.notify();
  }

  beginTransaction(label: string): void {
    this.deps.history.beginTransaction(label);
  }

  commit(): void {
    this.state = this.deps.history.commit(this.state);
    this.notify();
  }

  rollback(): void {
    this.state = this.deps.history.rollback(this.state);
    this.notify();
  }

  // --- Selection (transient — not undoable) ---------------------------------

  get selection(): SelectionState {
    return this.state.selection;
  }

  select(id: string): void {
    this.setSelection(this.deps.selection.select(id));
  }

  addToSelection(id: string): void {
    this.setSelection(this.deps.selection.add(this.state.selection, id));
  }

  toggleSelection(id: string): void {
    this.setSelection(this.deps.selection.toggle(this.state.selection, id));
  }

  selectAll(): void {
    this.setSelection(this.deps.selection.selectAll(getActivePage(this.state)));
  }

  /** Replaces the selection with a set of ids (the last is the primary). */
  selectMany(ids: string[]): void {
    this.setSelection(this.deps.selection.selectMany(ids));
  }

  clearSelection(): void {
    this.setSelection(this.deps.selection.clear());
  }

  setPrimary(id: string): void {
    this.setSelection(this.deps.selection.setPrimary(this.state.selection, id));
  }

  isSelected(id: string): boolean {
    return this.deps.selection.isSelected(this.state.selection, id);
  }

  selectedObjects(): EditorObject[] {
    return this.deps.selection.selectedObjects(getActivePage(this.state), this.state.selection);
  }

  selectionBounds(): Bounds | null {
    return this.deps.selection.selectionBounds(getActivePage(this.state), this.state.selection);
  }

  private setSelection(next: SelectionState): void {
    this.setSelectionQuiet(next);
    this.notify();
  }

  /** Updates selection without notifying — for composing with a command into one notification. */
  private setSelectionQuiet(next: SelectionState): void {
    this.state = { ...this.state, selection: next };
  }

  // --- Object mutations (undoable) ------------------------------------------

  /** Adds an object (default: top layer) and selects it, notifying once. */
  addObject(object: EditorObject, layerId?: string): void {
    this.applyCommand(new AddObjectCommand("Add object", object, layerId));
    this.setSelectionQuiet(this.deps.selection.select(object.id));
    this.notify();
  }

  /** Removes every selected object and clears the selection, notifying once. */
  removeSelected(): void {
    const objs = this.selectedObjects();
    if (objs.length === 0) return;
    this.applyCommand(new RemoveObjectsCommand("Delete", objs));
    this.setSelectionQuiet(this.deps.selection.clear());
    this.notify();
  }

  /** Moves the current selection by a delta (coalesceable for live drag). */
  moveSelection(delta: Vec2, gestureKey?: string): void {
    const ids = this.state.selection.ids;
    if (ids.length === 0) return;
    this.execute(moveCommand(this.state, ids, delta, gestureKey));
  }

  /** Rotates the current selection about a center (coalesceable). */
  rotateSelection(center: Point, deltaRadians: number, gestureKey?: string): void {
    const ids = this.state.selection.ids;
    if (ids.length === 0) return;
    this.execute(rotateCommand(this.state, ids, center, deltaRadians, gestureKey));
  }

  /** Resizes a single object from a handle (coalesceable for live resize). */
  resizeObject(id: string, handle: ResizeHandle, newWorld: Point, gestureKey?: string): void {
    this.execute(resizeCommand(this.state, id, handle, newWorld, gestureKey));
  }

  /** Resizes the whole selection box from a handle (coalesceable). */
  resizeSelection(handle: ResizeHandle, newOppositeWorld: Point, gestureKey?: string): void {
    const ids = this.state.selection.ids;
    const bounds = this.selectionBounds();
    if (ids.length === 0 || !bounds) return;
    this.execute(resizeSelectionCommand(this.state, ids, bounds, handle, newOppositeWorld, gestureKey));
  }

  /** Flips the current selection about its center along the given axis. */
  flipSelection(axis: "x" | "y"): void {
    const objs = this.selectedObjects();
    if (objs.length === 0) return;
    const before = captureTransforms(this.state, objs.map((o) => o.id));
    const after: Record<string, AffineTransform> = {};
    for (const o of objs) after[o.id] = flipObject(o, axis);
    this.execute(new TransformObjectsCommand(axis === "x" ? "Flip horizontal" : "Flip vertical", before, after));
  }

  /**
   * Sets an object's displayed size (local bounds × |scale|) by applying a
   * positive scale correction in LOCAL space, so the local origin (top-left)
   * stays fixed and rotation/flip are preserved. Used by the inspector's W/H.
   */
  setObjectSize(id: string, width: number, height: number): void {
    const page = getActivePage(this.state);
    const obj = page.objects[id];
    if (!obj) return;
    const { scale } = decompose(obj.transform);
    const curW = Math.abs(obj.localBounds.width * scale.x);
    const curH = Math.abs(obj.localBounds.height * scale.y);
    if (curW === 0 || curH === 0) return;
    const sx = width / curW;
    const sy = height / curH;
    const before = captureTransforms(this.state, [id]);
    const after = { [id]: compose(obj.transform, makeScale(sx, sy)) };
    this.execute(new TransformObjectsCommand("Set size", before, after));
  }

  /** Aligns the selected objects to one edge/center of their union bounds. */
  alignSelection(target: AlignmentTarget): void {
    const objs = this.selectedObjects();
    if (objs.length < 2) return;
    const bounds = objs.map(worldBounds);
    const deltas = alignToEdge(bounds, target);
    const before = captureTransforms(this.state, objs.map((o) => o.id));
    const after: Record<string, AffineTransform> = {};
    objs.forEach((o, i) => {
      after[o.id] = compose(makeTranslate(deltas[i].x, deltas[i].y), o.transform);
    });
    this.execute(new TransformObjectsCommand(`Align ${target}`, before, after));
  }

  /** Distributes the selected objects evenly along an axis (≥3 objects). */
  distributeSelection(axis: "horizontal" | "vertical"): void {
    const objs = this.selectedObjects();
    if (objs.length < 3) return;
    const bounds = objs.map(worldBounds);
    const deltas = distributeObjects(bounds, axis);
    const before = captureTransforms(this.state, objs.map((o) => o.id));
    const after: Record<string, AffineTransform> = {};
    objs.forEach((o, i) => {
      after[o.id] = compose(makeTranslate(deltas[i].x, deltas[i].y), o.transform);
    });
    this.execute(new TransformObjectsCommand(`Distribute ${axis}`, before, after));
  }

  // --- Layers (undoable, via the layer service) -----------------------------

  bringForward(id: string): void {
    this.execute(this.deps.layers.bringForward(id));
  }
  sendBackward(id: string): void {
    this.execute(this.deps.layers.sendBackward(id));
  }
  bringToFront(id: string): void {
    this.execute(this.deps.layers.bringToFront(this.state, id));
  }
  sendToBack(id: string): void {
    this.execute(this.deps.layers.sendToBack(this.state, id));
  }
  moveToLayer(id: string, targetLayerId: string, targetIndex?: number): void {
    this.execute(this.deps.layers.moveToLayer(this.state, id, targetLayerId, targetIndex));
  }
  addLayer(name: string): string {
    const { command, layerId } = this.deps.layers.addLayer(name);
    this.execute(command);
    return layerId;
  }
  deleteLayer(layerId: string): void {
    this.execute(this.deps.layers.deleteLayer(this.state, layerId));
  }
  reorderLayer(layerId: string, delta: number): void {
    this.execute(this.deps.layers.reorderLayer(layerId, delta));
  }

  /** Patches a layer's own properties (name/visible/locked/opacity). */
  setLayerProperty(layerId: string, patch: Partial<{ name: string; visible: boolean; locked: boolean; opacity: number }>, label?: string): void {
    this.execute(this.deps.layers.setLayerProperty(this.state, layerId, patch, label));
  }

  /** Duplicates a layer + its objects; returns the new layer id. */
  duplicateLayer(layerId: string): string {
    const { command, layerId: newId } = this.deps.layers.duplicateLayer(this.state, layerId);
    this.execute(command);
    return newId;
  }

  // --- Pages (undoable) ------------------------------------------------------

  /** The document's pages in order. */
  pages(): EditorPage[] {
    return this.state.document.pages;
  }

  /** The number of pages in the document. */
  get pageCount(): number {
    return this.state.document.pages.length;
  }

  /**
   * Inserts a blank page at `index` (clamped). Size defaults to the active
   * page's size so an inserted page matches the document it joins. The page
   * has no source PDF page (it exports as an empty page). The active page is
   * NOT changed (activation is a transient UI concern, like selection), so
   * undo/redo round-trips the state exactly. Returns the new page's id.
   */
  insertBlankPage(index: number, width?: number, height?: number): string {
    const active = getActivePage(this.state);
    const page = createBlankPage(
      this.generateId("page"),
      width ?? active.width,
      height ?? active.height,
    );
    this.execute(new InsertPageCommand("Insert page", page, index));
    return page.id;
  }

  /**
   * Deletes a page. No-op (does not push history) when the page is unknown or
   * is the last remaining page — a document is never empty.
   */
  deletePage(pageId: string): void {
    const pages = this.state.document.pages;
    if (pages.length <= 1 || !pages.some((p) => p.id === pageId)) return;
    this.execute(removePageCommand(this.state, pageId));
  }

  /** Duplicates a page (fresh ids), inserting the copy after it. Returns the new id, or null if the page is unknown. */
  duplicatePage(pageId: string): string | null {
    if (!this.state.document.pages.some((p) => p.id === pageId)) return null;
    const { command, pageId: newId } = duplicatePageCommand(this.state, pageId);
    this.execute(command);
    return newId;
  }

  /** Reorders a page to `toIndex` (clamped). No-op when the page is unknown. */
  movePage(pageId: string, toIndex: number): void {
    if (!this.state.document.pages.some((p) => p.id === pageId)) return;
    this.execute(movePageCommand(this.state, pageId, toIndex));
  }

  /** Sets a page's absolute rotation (0/90/180/270). No-op when unchanged or invalid or unknown. */
  rotatePage(pageId: string, rotation: PageRotation): void {
    const page = getPage(this.state.document, pageId);
    if (!page || !isPageRotation(rotation) || page.rotation === rotation) return;
    this.execute(new SetPageRotationCommand("Rotate page", pageId, page.rotation, rotation));
  }

  /**
   * Rotates a page by a delta (typically +90 or −90), normalized into the
   * 0/90/180/270 quadrant set. No-op when the page is unknown or the delta is
   * not a whole number of quadrants.
   */
  rotatePageBy(pageId: string, delta: number): void {
    const page = getPage(this.state.document, pageId);
    if (!page) return;
    if (!Number.isInteger(delta / 90)) return;
    const next = ((((page.rotation + delta) % 360) + 360) % 360) as PageRotation;
    this.rotatePage(pageId, next);
  }

  /** Sets a page's size. No-op when the page is unknown or the size is unchanged. */
  setPageSize(pageId: string, width: number, height: number): void {
    const page = getPage(this.state.document, pageId);
    if (!page || (page.width === width && page.height === height)) return;
    this.execute(
      new SetPageSizeCommand(
        "Resize page",
        pageId,
        { width: page.width, height: page.height },
        { width, height },
      ),
    );
  }

  // --- History navigation (Part 6 — history panel) -------------------------

  /** Labels of the undo stack, oldest→newest (the "past" in a history panel). */
  undoLabels(): string[] {
    return this.deps.history.undoLabels();
  }

  /** Labels of the redo stack, next-redo→latest (the "future" in a history panel). */
  redoLabels(): string[] {
    return this.deps.history.redoLabels();
  }

  /** Current undo depth (entries in the past). */
  get undoDepth(): number {
    return this.deps.history.undoDepth;
  }

  /**
   * Monotonic count of applied mutations — the sound basis for "has this document
   * changed since it was exported?". See {@link CommandHistory.revision} for why
   * `undoDepth` cannot answer that question.
   */
  get revision(): number {
    return this.deps.history.revision;
  }

  /**
   * Jumps history so the undo stack has `targetUndoDepth` entries, undoing/redoing
   * as many steps as needed. Used by the history panel to navigate to a clicked
   * entry. Notifies once.
   */
  jumpTo(targetUndoDepth: number): void {
    this.state = this.deps.history.jumpTo(this.state, targetUndoDepth);
    this.notify();
  }

  // --- Serialization ---------------------------------------------------------

  serialize() {
    return this.deps.serializer.serialize(this.state);
  }

  deserialize(data: unknown): void {
    this.loadState(this.deps.serializer.deserialize(data));
  }

  // --- Plugins ---------------------------------------------------------------

  get plugins(): PluginRegistry {
    return this.deps.plugins;
  }

  /** Generates a stable id (for objects callers build by hand). */
  generateId(prefix?: string): string {
    return generateId(prefix);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Constructs a headless editor instance from its dependencies. */
export function createEditorDocumentService(deps: EditorDocumentServiceDeps): EditorDocumentService {
  return new EditorDocumentService(deps);
}

/**
 * A factory that produces fresh, independent editor instances. Registered in DI
 * as a singleton so the per-instance CommandHistory/state aren't shared across
 * editors — call `create()` for each editor surface.
 */
export interface EditorServiceFactory {
  create(initialState?: EditorState): EditorDocumentService;
}
