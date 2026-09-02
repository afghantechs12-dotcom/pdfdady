/**
 * What selection chrome an object may legitimately show.
 *
 * WHY THIS EXISTS. `SelectionOverlay` used to draw the same chrome for every
 * selection: an eight-handle transform box plus a rotate handle. For read-only
 * imported PDF text that was a lie the rest of the app then had to apologize
 * for — the canvas offered MOVE / RESIZE / ROTATE affordances while the
 * Properties panel simultaneously explained the run "cannot be edited safely".
 * Affordances that contradict the system's own rules are worse than absent ones:
 * the user learns the handles mean nothing.
 *
 * The decision lives here, as a pure function, for the same reason
 * {@link shouldDrawTextObject} does: the canvas chrome and the Properties panel
 * must reach the SAME verdict about a selection, and two components branching
 * independently on `sourceText.mode` is how they drift. One function, one
 * verdict, unit-testable without a DOM.
 *
 * @see [[imported-text-readonly]] for the capability model this defers to.
 */

import { isObjectKind, type EditorObject } from "@/src/domain/editor/objects";
import { isReadonlySourceText } from "@/src/domain/editor/importedTextRendering";

/**
 * The kind of chrome a selection gets.
 *
 *  - `transform`   — a normal editable object: box, resize handles, rotate.
 *  - `source-text` — a read-only imported run: a TEXT-RANGE highlight, the way a
 *                    PDF viewer marks selected text. No transform affordances,
 *                    because none of them would do anything.
 *  - `multi`       — several objects: a shared box, resize allowed, but no
 *                    rotate (rotating a heterogeneous set has no single origin
 *                    the user can predict).
 *  - `text-editing` — the object's inline text editor is OPEN. The canvas draws
 *                    no selection chrome at all: the editing surface has its own
 *                    ring, and the handles are refused by
 *                    `onHandlePointerDown` while editing, so drawing them was an
 *                    affordance that did nothing (measured: 6 resize handles + 1
 *                    rotate handle, all inert). Geometry still APPLIES — the
 *                    Inspector's X/Y/W/H keep working on the object being
 *                    edited — so this differs from `source-text`, where the
 *                    operations themselves are unavailable.
 */
export type SelectionAffordanceKind = "transform" | "source-text" | "multi" | "text-editing";

export interface SelectionAffordance {
  kind: SelectionAffordanceKind;
  /** Whether the eight resize handles may be drawn. */
  showHandles: boolean;
  /** Whether the rotate handle may be drawn. */
  showRotate: boolean;
  /**
   * Whether geometry editing (X/Y/W/H, rotation, flip, opacity) applies. The
   * Properties panel gates its Position/Appearance sections on this so it cannot
   * present a control that silently does nothing.
   */
  allowsGeometry: boolean;
}

const TRANSFORM: SelectionAffordance = {
  kind: "transform",
  showHandles: true,
  showRotate: true,
  allowsGeometry: true,
};

const MULTI: SelectionAffordance = {
  kind: "multi",
  showHandles: true,
  showRotate: false,
  allowsGeometry: true,
};

const SOURCE_TEXT: SelectionAffordance = {
  kind: "source-text",
  showHandles: false,
  showRotate: false,
  allowsGeometry: false,
};

const TEXT_EDITING: SelectionAffordance = {
  kind: "text-editing",
  showHandles: false,
  showRotate: false,
  allowsGeometry: true,
};

/**
 * Resolves the chrome for the currently selected objects.
 *
 * `objects` is the resolved selection (ids already mapped to objects; missing
 * ids dropped by the caller). An empty selection yields the read-only verdict's
 * opposite — `transform` with nothing to draw is meaningless, so callers check
 * for an empty selection before rendering chrome; we still return a stable value
 * rather than null so consumers need no extra branch.
 *
 * A multi-selection containing a read-only run keeps `multi` chrome: the user is
 * acting on the group, and the group's editable members legitimately move. The
 * read-only member is simply not transformed by the underlying commands.
 */
export function resolveSelectionAffordance(objects: readonly EditorObject[]): SelectionAffordance {
  if (objects.length > 1) return MULTI;
  const only = objects[0];
  if (!only) return TRANSFORM;
  if (isObjectKind(only, "text") && isReadonlySourceText(only)) return SOURCE_TEXT;
  return TRANSFORM;
}

/** True when the selection is a single read-only imported PDF text run. */
export function isSourceTextSelection(objects: readonly EditorObject[]): boolean {
  return resolveSelectionAffordance(objects).kind === "source-text";
}

/**
 * Whether an object's INLINE text editor may open over it on the canvas.
 *
 * Two rules, together in one place because four call sites need them and one of
 * them obeyed neither. `EditorCanvas` renders the inline editor only for `text`
 * objects, but the annotate tool handed the editing id to the `annotation` object
 * it had just created. Nothing rendered — and nothing could clear the id, because
 * the editor's own commit/cancel handlers are its only writers — so placing one
 * note left the canvas in a permanent pseudo-editing state: selection clicks
 * refused, every resize handle inert, the object toolbar hidden, and (after the
 * chrome suppression above) no selection frame either, with no editing surface to
 * replace it. A note's text is edited in the Inspector's Annotation field, which
 * is where it has always lived.
 *
 * A read-only imported run refuses the editor too, for the reason
 * `onDoubleClick` documents: a typed copy would sit on top of original PDF text
 * that is still visible in the page raster.
 */
export function supportsInlineTextEditing(obj: EditorObject | null | undefined): boolean {
  if (!obj) return false;
  if (!isObjectKind(obj, "text")) return false;
  return !isReadonlySourceText(obj);
}

/**
 * Narrows an affordance while the inline text editor is open.
 *
 * Kept separate from {@link resolveSelectionAffordance} on purpose: whether an
 * editor is OPEN is canvas-local state, and the other consumers of the affordance
 * (the Properties panel, the object toolbar, the workspace) must not change their
 * verdict because of it. The object toolbar hides itself while editing, and the
 * Inspector deliberately keeps working on the object being typed into.
 *
 * A read-only run can never be edited (`onDoubleClick` refuses it), so its
 * affordance is returned untouched — an editing flag that contradicted the
 * capability model would be exactly the drift this module prevents.
 */
export function affordanceWhileEditing(
  base: SelectionAffordance,
  isEditingText: boolean,
): SelectionAffordance {
  if (!isEditingText) return base;
  if (base.kind === "source-text") return base;
  return TEXT_EDITING;
}
