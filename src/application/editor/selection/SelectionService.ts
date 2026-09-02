import type { Bounds } from "@/src/domain/editor/geometry";
import { unionBounds } from "@/src/domain/editor/geometry";
import {
  EMPTY_SELECTION,
  worldBounds,
  type EditorObject,
  type EditorPage,
  type SelectionState,
} from "@/src/domain/editor/document";
import { pageObjects } from "@/src/domain/editor/document";
import type { ISelectionService } from "../ports/ISelectionService";

/**
 * Pure selection operations. No state is held — every method is a function of
 * its arguments — so the service is trivially testable and safe to share as a
 * DI singleton. Selection is never pushed to the undo stack (see the port).
 */
export class SelectionService implements ISelectionService {
  select(id: string): SelectionState {
    return { ids: [id], primaryId: id };
  }

  add(current: SelectionState, id: string): SelectionState {
    if (current.ids.includes(id)) {
      // Already selected — just promote to primary.
      return { ids: current.ids, primaryId: id };
    }
    return { ids: [...current.ids, id], primaryId: id };
  }

  toggle(current: SelectionState, id: string): SelectionState {
    if (!current.ids.includes(id)) return this.add(current, id);
    const ids = current.ids.filter((x) => x !== id);
    // If the primary was deselected, fall back to the last remaining id.
    const primaryId =
      current.primaryId === id ? (ids[ids.length - 1] ?? null) : current.primaryId;
    return { ids, primaryId };
  }

  selectMany(ids: string[]): SelectionState {
    if (ids.length === 0) return EMPTY_SELECTION;
    // De-duplicate while preserving order.
    const unique = [...new Set(ids)];
    return { ids: unique, primaryId: unique[unique.length - 1] };
  }

  selectAll(page: EditorPage): SelectionState {
    // Only visible, unlocked objects are selectable (matches hit-testing).
    const ids = pageObjects(page)
      .filter((o) => o.visible && !o.locked)
      .map((o) => o.id);
    return this.selectMany(ids);
  }

  clear(): SelectionState {
    return EMPTY_SELECTION;
  }

  setPrimary(current: SelectionState, id: string): SelectionState {
    if (!current.ids.includes(id)) return current;
    return { ids: current.ids, primaryId: id };
  }

  isSelected(current: SelectionState, id: string): boolean {
    return current.ids.includes(id);
  }

  selectedObjects(page: EditorPage, selection: SelectionState): EditorObject[] {
    return selection.ids
      .map((id) => page.objects[id])
      .filter((o): o is EditorObject => Boolean(o));
  }

  primaryObject(page: EditorPage, selection: SelectionState): EditorObject | undefined {
    if (!selection.primaryId) return undefined;
    return page.objects[selection.primaryId];
  }

  selectionBounds(page: EditorPage, selection: SelectionState): Bounds | null {
    const objs = this.selectedObjects(page, selection);
    if (objs.length === 0) return null;
    const boxes = objs.map(worldBounds);
    return boxes.reduce((acc, b) => (acc ? unionBounds(acc, b) : b));
  }
}
