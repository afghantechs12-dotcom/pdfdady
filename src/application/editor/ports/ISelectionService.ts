import type { Bounds } from "@/src/domain/editor/geometry";
import type { EditorObject, EditorPage } from "@/src/domain/editor/document";
import type { SelectionState } from "@/src/domain/editor/document";

/**
 * Port: selection operations for the editor.
 *
 * Selection is transient UI state, not document state: it lives in
 * {@link EditorState.selection} but is NOT recorded on the undo stack (you don't
 * "undo" clicking a different object). The service is therefore a set of pure
 * functions over {@link SelectionState} (+ the active page for the ones that
 * need object geometry); the caller applies the result with `setSelection`.
 *
 * Multi-selection keeps an ordered id list and a `primaryId` anchor — the object
 * the transform handles align to and whose properties the inspector shows when
 * several are selected.
 */
export interface ISelectionService {
  /** Replaces the selection with a single id (the primary). */
  select(id: string): SelectionState;
  /** Adds an id to the selection (shift-click); becomes the new primary. */
  add(current: SelectionState, id: string): SelectionState;
  /** Toggles an id in the selection (shift-click); primary unchanged if still in. */
  toggle(current: SelectionState, id: string): SelectionState;
  /** Replaces the selection with a set of ids; the last is the primary. */
  selectMany(ids: string[]): SelectionState;
  /** Selects every (visible, unlocked) object on the page. */
  selectAll(page: EditorPage): SelectionState;
  /** Clears the selection. */
  clear(): SelectionState;
  /** Sets the primary within the current selection (no-op if id not selected). */
  setPrimary(current: SelectionState, id: string): SelectionState;
  /** True when `id` is in the selection. */
  isSelected(current: SelectionState, id: string): boolean;
  /** The selected objects (in selection order), skipping orphaned ids. */
  selectedObjects(page: EditorPage, selection: SelectionState): EditorObject[];
  /** The primary object, or undefined. */
  primaryObject(page: EditorPage, selection: SelectionState): EditorObject | undefined;
  /**
   * The union bounds of the selected objects in page space — the box the
   * transform handles are drawn around. Null when nothing is selected.
   */
  selectionBounds(page: EditorPage, selection: SelectionState): Bounds | null;
}
