import {
  compose,
  makeTranslate,
  type Vec2,
} from "@/src/domain/editor/geometry";
import {
  getActivePage,
  pageObjects,
  type EditorState,
} from "@/src/domain/editor/document";
import type { EditorObject } from "@/src/domain/editor/objects";
import { generateId } from "@/src/domain/editor/ids";
import { AddObjectCommand } from "@/src/application/editor/commands/commands";

/**
 * The clipboard for the PDFDadi editor (Part 8).
 *
 * An in-memory clipboard of serialized editor objects. {@link copy} deep-clones
 * the named objects off the active page so later edits to the originals never
 * mutate what's stored — paste always reproduces the state at copy time. Paste
 * and duplicate are expressed as {@link AddObjectCommand}s (so they enter the
 * undo stack like any other edit) with fresh ids and a page-space translate
 * offset composed onto each object's transform.
 */
export class ClipboardService {
  /** Deep-cloned objects captured by the last {@link copy}. */
  private clipboard: EditorObject[] = [];

  /**
   * Stores deep clones of the active-page objects whose ids are in `ids`. If
   * none of the ids are present on the active page, the clipboard is cleared
   * (nothing is retained from a prior copy). Cloning is structural (JSON) so the
   * clipboard holds no references into live state.
   */
  copy(state: EditorState, ids: string[]): void {
    const page = getActivePage(state);
    const wanted = new Set(ids);
    this.clipboard = pageObjects(page)
      .filter((obj) => wanted.has(obj.id))
      .map((obj) => deepClone(obj));
  }

  /** True when the clipboard holds at least one object. */
  hasContent(): boolean {
    return this.clipboard.length > 0;
  }

  /** Empties the clipboard. */
  clear(): void {
    this.clipboard = [];
  }

  /**
   * Returns {@link AddObjectCommand}s that paste the clipboard contents at an
   * offset. Each pasted object gets a fresh id, the given `layerId` (default:
   * the top layer of the active page), and a page-space translate of `offset`
   * (default `{ x: 16, y: 16 }`) composed onto its transform. Returns `[]` when
   * the clipboard is empty.
   *
   * The offset is applied as `compose(makeTranslate(offset), transform)` — i.e.
   * the translate is applied AFTER the object's own transform, so the object
   * moves by `offset` in page space regardless of its rotation/scale. That keeps
   * a rotated paste landing where the user expects, not offset along the local
   * axes.
   */
  pasteCommands(
    state: EditorState,
    offset: Vec2 = { x: 16, y: 16 },
    layerId?: string,
  ): AddObjectCommand[] {
    if (this.clipboard.length === 0) return [];
    const page = getActivePage(state);
    const targetLayerId =
      layerId ?? page.layerStack.layers[page.layerStack.layers.length - 1].id;
    return this.clipboard.map((obj) => {
      const clone = deepClone(obj);
      const transform = compose(makeTranslate(offset.x, offset.y), clone.transform);
      const pasted: EditorObject = {
        ...clone,
        id: generateId("obj"),
        layerId: targetLayerId,
        transform,
      };
      return new AddObjectCommand("Paste", pasted, targetLayerId);
    });
  }

  /**
   * Returns {@link AddObjectCommand}s that duplicate the given ids in place at
   * an offset, without touching the clipboard. Each duplicate reads the live
   * object off the active page, is deep-cloned, gets a fresh id, stays on the
   * original's layer, and has `offset` (default `{ x: 16, y: 16 }`) composed onto
   * its transform in page space (same convention as {@link pasteCommands}).
   * Objects whose ids are not on the active page are skipped.
   */
  duplicateCommands(
    state: EditorState,
    ids: string[],
    offset: Vec2 = { x: 16, y: 16 },
  ): AddObjectCommand[] {
    const page = getActivePage(state);
    const wanted = new Set(ids);
    return pageObjects(page)
      .filter((obj) => wanted.has(obj.id))
      .map((obj) => {
        const clone = deepClone(obj);
        const transform = compose(makeTranslate(offset.x, offset.y), clone.transform);
        const duplicate: EditorObject = {
          ...clone,
          id: generateId("obj"),
          transform,
        };
        return new AddObjectCommand("Duplicate", duplicate, obj.layerId);
      });
  }
}

/**
 * Structural deep clone via JSON. The clipboard must not hold references into
 * live editor state (a later edit would otherwise mutate the clipboard in
 * place), and editor objects are JSON-serializable values, so a JSON round-trip
 * is the simplest correct clone.
 */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
