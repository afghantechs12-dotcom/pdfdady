import type { EditorPage, EditorState } from "./document";
import { createPage } from "./document";
import type { EditorObject } from "./objects";
import type { Layer } from "./layers";

/**
 * Pure page-level operations for the PDFDadi editor (M6 page operations).
 *
 * All functions are immutable `(state) => state` transforms over
 * {@link EditorState}, mirroring the object/layer primitives in [[document]]
 * and [[layers]]: a lookup miss (unknown page id) returns the SAME state
 * reference (the layers.ts convention), while an invalid VALUE (a rotation
 * outside 0/90/180/270, a non-positive size) throws — those are caller bugs,
 * not stale ids, and silently ignoring them would hide them.
 *
 * Invariants maintained here:
 *  - a document never has zero pages ({@link removePage} refuses the last one);
 *  - `activePageId` always names an existing page (removal reactivates the
 *    nearest neighbor, preferring the page after);
 *  - the selection never references objects on a removed page;
 *  - a duplicated page shares NO ids with its source (fresh page/layer/object
 *    ids) but keeps its `sourcePageIndex`, so export still copies the same
 *    source page under both.
 */

/** The valid page rotations (mirrors pdf-lib's /Rotate quadrants). */
export type PageRotation = EditorPage["rotation"];

/** True when `value` is a valid page rotation (0/90/180/270). */
export function isPageRotation(value: number): value is PageRotation {
  return value === 0 || value === 90 || value === 180 || value === 270;
}

/**
 * Creates a blank page with NO source-PDF page (`sourcePageIndex: null`) — the
 * production factory for "Insert blank page". Export emits an empty page of
 * this size for it rather than copying source content.
 */
export function createBlankPage(id: string, width = 595, height = 842): EditorPage {
  return createPage(id, width, height, 0, null);
}

/**
 * Inserts `page` at `index`, clamping the index to [0, pages.length] (negative
 * → front, past-the-end → back). Returns the state unchanged if a page with the
 * same id already exists (page ids are unique within a document).
 */
export function insertPageAt(state: EditorState, page: EditorPage, index: number): EditorState {
  const pages = state.document.pages;
  if (pages.some((p) => p.id === page.id)) return state;
  const at = Math.max(0, Math.min(Math.trunc(index), pages.length));
  const nextPages = [...pages.slice(0, at), page, ...pages.slice(at)];
  return { ...state, document: { ...state.document, pages: nextPages } };
}

/**
 * Removes a page. Refuses (returns the state unchanged) to remove the LAST
 * remaining page — a document is never empty. If the removed page was active,
 * the nearest neighbor becomes active (the page after, else the page before).
 * Selection entries pointing at objects that lived on the removed page are
 * cleared; the rest of the selection is preserved.
 */
export function removePage(state: EditorState, pageId: string): EditorState {
  const pages = state.document.pages;
  if (pages.length <= 1) return state; // never empty the document
  const index = pages.findIndex((p) => p.id === pageId);
  if (index < 0) return state;
  const removed = pages[index];
  const nextPages = pages.filter((p) => p.id !== pageId);

  // Nearest-neighbor reactivation: the page that slid into the removed page's
  // slot is the one AFTER it; when the last page was removed, that clamps to
  // the new last page (the one before).
  const activePageId =
    state.activePageId === pageId
      ? nextPages[Math.min(index, nextPages.length - 1)].id
      : state.activePageId;

  const keptIds = state.selection.ids.filter((id) => !(id in removed.objects));
  const keptPrimary =
    state.selection.primaryId !== null && !(state.selection.primaryId in removed.objects)
      ? state.selection.primaryId
      : null;
  const selectionUnchanged =
    keptIds.length === state.selection.ids.length && keptPrimary === state.selection.primaryId;
  const selection = selectionUnchanged ? state.selection : { ids: keptIds, primaryId: keptPrimary };

  return {
    ...state,
    document: { ...state.document, pages: nextPages },
    activePageId,
    selection,
  };
}

/**
 * Deep-copies a page under a new id: fresh layer ids, fresh object ids (in
 * paint order, then any orphaned objects), each layer's `objectIds` remapped to
 * the new ids IN THE SAME ORDER, and each object's `layerId` remapped to its
 * cloned layer. Size, rotation, background reference, and `sourcePageIndex`
 * are kept — a duplicate of a source-backed page copies the same source page
 * on export. Nested value objects (transforms, styles, content) are shared by
 * reference, which is safe under the editor's no-in-place-mutation rule
 * (matches {@link duplicateLayerCommand}'s cloning); `metadata` is shallow-
 * cloned because callers may treat it as a mutable-ish grab bag.
 */
export function clonePage(
  page: EditorPage,
  newPageId: string,
  idGenerator: (prefix?: string) => string,
): EditorPage {
  const layerIdMap = new Map<string, string>();
  const objectIdMap = new Map<string, string>();
  for (const layer of page.layerStack.layers) {
    layerIdMap.set(layer.id, idGenerator("layer"));
    for (const objectId of layer.objectIds) {
      if (page.objects[objectId] && !objectIdMap.has(objectId)) {
        objectIdMap.set(objectId, idGenerator("obj"));
      }
    }
  }
  // Objects present in the map but referenced by no layer (orphans) still get
  // fresh ids so the clone never aliases the source page's objects.
  for (const objectId of Object.keys(page.objects)) {
    if (!objectIdMap.has(objectId)) objectIdMap.set(objectId, idGenerator("obj"));
  }

  const objects: Record<string, EditorObject> = {};
  for (const [oldId, newId] of objectIdMap) {
    const obj = page.objects[oldId];
    objects[newId] = {
      ...obj,
      id: newId,
      layerId: layerIdMap.get(obj.layerId) ?? obj.layerId,
      metadata: { ...obj.metadata },
    };
  }

  const layers: Layer[] = page.layerStack.layers.map((layer) => ({
    ...layer,
    id: layerIdMap.get(layer.id) as string,
    objectIds: layer.objectIds
      .filter((id) => objectIdMap.has(id))
      .map((id) => objectIdMap.get(id) as string),
  }));

  return { ...page, id: newPageId, objects, layerStack: { layers } };
}

/**
 * Duplicates a page (see {@link clonePage} for what "duplicate" copies) and
 * inserts the copy immediately after the source. Returns the state unchanged
 * when the source page is missing or `newPageId` collides with an existing
 * page id.
 */
export function duplicatePage(
  state: EditorState,
  pageId: string,
  newPageId: string,
  idGenerator: (prefix?: string) => string,
): EditorState {
  const index = state.document.pages.findIndex((p) => p.id === pageId);
  if (index < 0) return state;
  const copy = clonePage(state.document.pages[index], newPageId, idGenerator);
  return insertPageAt(state, copy, index + 1);
}

/**
 * Moves a page to `toIndex` (clamped to [0, pages.length - 1]). Returns the
 * state unchanged when the page is missing or already at the target index.
 */
export function movePage(state: EditorState, pageId: string, toIndex: number): EditorState {
  const pages = state.document.pages;
  const from = pages.findIndex((p) => p.id === pageId);
  if (from < 0) return state;
  const to = Math.max(0, Math.min(Math.trunc(toIndex), pages.length - 1));
  if (to === from) return state;
  const nextPages = [...pages];
  const [moved] = nextPages.splice(from, 1);
  nextPages.splice(to, 0, moved);
  return { ...state, document: { ...state.document, pages: nextPages } };
}

/**
 * Sets a page's rotation. Throws on a value outside 0/90/180/270 (a caller
 * bug, not a stale id); returns the state unchanged when the page is missing
 * or already at that rotation.
 */
export function setPageRotation(
  state: EditorState,
  pageId: string,
  rotation: PageRotation,
): EditorState {
  if (!isPageRotation(rotation)) {
    throw new Error(`Invalid page rotation ${rotation}: must be 0, 90, 180, or 270.`);
  }
  const pages = state.document.pages;
  const page = pages.find((p) => p.id === pageId);
  if (!page || page.rotation === rotation) return state;
  const nextPages = pages.map((p) => (p.id === pageId ? { ...p, rotation } : p));
  return { ...state, document: { ...state.document, pages: nextPages } };
}

/**
 * Sets a page's size in editor units. Throws on a non-finite or non-positive
 * dimension; returns the state unchanged when the page is missing or already
 * that size. Objects are NOT repositioned — a shrink can leave objects beyond
 * the page edge (they clip on render/export), matching how design tools treat
 * canvas resizes.
 */
export function setPageSize(
  state: EditorState,
  pageId: string,
  width: number,
  height: number,
): EditorState {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid page size ${width}x${height}: dimensions must be positive finite numbers.`);
  }
  const pages = state.document.pages;
  const page = pages.find((p) => p.id === pageId);
  if (!page || (page.width === width && page.height === height)) return state;
  const nextPages = pages.map((p) => (p.id === pageId ? { ...p, width, height } : p));
  return { ...state, document: { ...state.document, pages: nextPages } };
}
