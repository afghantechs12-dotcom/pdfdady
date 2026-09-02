import type { Bounds } from "./geometry";
import { transformBounds } from "./geometry";
import type { EditorObject } from "./objects";
export type { EditorObject } from "./objects";
import type { LayerStack } from "./layers";
import { createLayerStack, paintOrder } from "./layers";

/**
 * The document and state model for the PDFDadi editor.
 *
 * State is normalized and immutable:
 *  - each {@link EditorPage} owns a flat `objects` map keyed by id (O(1) lookup
 *    and O(1) "replace one object" edits) plus a {@link LayerStack} that holds
 *    only the ordered ids. This is the Figma-style split: geometry/properties
 *    live in the map, paint order lives in the layer arrays, and an edit to one
 *    object never reallocates the others.
 *  - {@link EditorState} bundles the document, the active page, and the current
 *    selection. Commands are pure `(state) => state` functions over this, which
 *    is what makes undo/redo a stack of inverse applications and lets React hold
 *    editor state in a single `useState` without ref-chasing.
 *
 * All "mutators" below return new objects/structures; none mutate in place.
 */

/** Page background fill options. */
export interface PageBackground {
  type: "white" | "transparent" | "color";
  color?: string; // CSS color string when type === "color"
}

/** A single editor page: a size, a background, an object map, and a layer stack. */
export interface EditorPage {
  id: string;
  /** Page width in editor units (points by default; px at 1:1 zoom). */
  width: number;
  height: number;
  /** Page rotation in degrees (0/90/180/270) — mirrors pdf-lib's /Rotate. */
  rotation: 0 | 90 | 180 | 270;
  /**
   * The index of this page in the ORIGINAL source PDF (the one opened into the
   * editor), or null when the page has no source (a blank/inserted page). Export
   * copies source page `sourcePageIndex` under this editor page, so the mapping
   * survives insert/delete/duplicate/reorder — the field pins each page to its
   * source page permanently (a duplicated page keeps its source's index).
   *
   * Optional-tolerant: `undefined` (an in-memory page built before M6) is
   * treated by export as "map by array index" (the pre-M6 behavior), while
   * `null` explicitly means "no source page". New pages always set it.
   */
  sourcePageIndex?: number | null;
  background: PageBackground;
  /** Normalized object map: id → object. The source of truth for geometry/props. */
  objects: Record<string, EditorObject>;
  /** Paint order + grouping: ids only, referencing `objects`. */
  layerStack: LayerStack;
}

/** The multi-page editor document. */
export interface EditorDocument {
  id: string;
  /** Serializer format version — bumped when the on-disk shape changes. */
  version: number;
  pages: EditorPage[];
  metadata: Record<string, unknown>;
}

/** Selection on the active page: an ordered id list plus the primary (anchor). */
export interface SelectionState {
  /** Selected object ids in pick order; the last is usually the primary. */
  ids: string[];
  /** The anchor of the selection — the object transform handles attach to. */
  primaryId: string | null;
}

/** The complete editor state commands operate over. */
export interface EditorState {
  document: EditorDocument;
  /** The page currently shown/edited. */
  activePageId: string;
  selection: SelectionState;
}

/**
 * The current serializer format version; see [[serialization]] for migrations.
 *
 * v2 (M4) adds optional `letterSpacing` on text objects and `crop` on image
 * objects; both default on read so v1 saves upgrade cleanly via the 1→2
 * migration. Grouping is stored in object metadata (no shape change).
 *
 * v3 (M5 Part 1) adds optional `background` and `sourceText` on text objects
 * (existing-text redaction + provenance). Both default on read so v2 saves
 * upgrade cleanly via the 2→3 migration.
 *
 * v4 (M5 Part 2) adds normalized rich `content` and persisted `frame` layout
 * intent to text objects. The legacy scalar `text` remains a compatibility
 * projection, so v3 saves upgrade safely through the 3→4 migration.
 *
 * v5 (M6 page operations) adds `sourcePageIndex` to pages so the editor-page →
 * source-PDF-page mapping survives insert/delete/duplicate/reorder. The 4→5
 * migration backfills each page's array index (the mapping pre-v5 export used).
 *
 * v6 (M6 shape library + drawing upgrade) extends shapes with the new kinds
 * (roundedRect/circle/triangle/arrow/star/speechBubble/connector/bezier/path),
 * per-kind parameters (`sides`/`starPoints`/`innerRatio`/`headSize`/`headType`/
 * `tailPosition`/`connectorKind`/`startArrow`/`endArrow`/`pathData`), style
 * `dash` + `shadow`, and drawings with `brush`/`smoothing`/`widths`. All new
 * fields are optional with pre-v6 defaults; the 5→6 migration backfills the
 * explicit defaults (`shadow: null`, `brush: "pen"`, `smoothing: false`).
 *
 * v7 (Phase 3 canonical round-trip fidelity) makes the sticky-note PANEL part of
 * the annotation model: `background`, `border`, `borderWidth`, `cornerRadius`.
 * Before v7 the panel existed only as a hardcoded fill inside the canvas
 * renderer, so it was never serialized and the PDF exporter never drew it — a
 * note that looked yellow on screen round-tripped and exported as bare text. The
 * 6→7 migration backfills the exact historical look (the `rgba(255,245,180,0.95)`
 * fill, a 1px hairline in the note's own text color, radius 6).
 */
export const EDITOR_FORMAT_VERSION = 7;

/**
 * Creates a blank page of a given size (A4 default, in points). A page created
 * here has no source-PDF page unless `sourcePageIndex` is given (the Open-PDF
 * flow passes the source index; blank/inserted pages keep the null default).
 */
export function createPage(
  id: string,
  width = 595,
  height = 842,
  rotation: 0 | 90 | 180 | 270 = 0,
  sourcePageIndex: number | null = null,
): EditorPage {
  return {
    id,
    width,
    height,
    rotation,
    sourcePageIndex,
    background: { type: "white" },
    objects: {},
    layerStack: createLayerStack(),
  };
}

/** Creates a single-page document wrapping a blank A4 page. */
export function createDocument(docId = "doc-1", pageId = "page-1"): EditorDocument {
  return {
    id: docId,
    version: EDITOR_FORMAT_VERSION,
    pages: [createPage(pageId)],
    metadata: {},
  };
}

/** Creates the initial editor state for a fresh document. */
export function createEditorState(docId = "doc-1", pageId = "page-1"): EditorState {
  const document = createDocument(docId, pageId);
  return {
    document,
    activePageId: pageId,
    selection: { ids: [], primaryId: null },
  };
}

/** Empty selection (no ids, no primary). */
export const EMPTY_SELECTION: SelectionState = { ids: [], primaryId: null };

/** Returns the active page, or the first page if the active id is stale. */
export function getActivePage(state: EditorState): EditorPage {
  const page = state.document.pages.find((p) => p.id === state.activePageId);
  return page ?? state.document.pages[0];
}

/** Returns a page by id, or undefined. */
export function getPage(doc: EditorDocument, pageId: string): EditorPage | undefined {
  return doc.pages.find((p) => p.id === pageId);
}

/** Looks up an object on a page by id. */
export function getObject(page: EditorPage, objectId: string): EditorObject | undefined {
  return page.objects[objectId];
}

/** Looks up an object across the whole document by id (searches every page). */
export function findObject(doc: EditorDocument, objectId: string): EditorObject | undefined {
  for (const page of doc.pages) {
    const obj = page.objects[objectId];
    if (obj) return obj;
  }
  return undefined;
}

/**
 * The page-space (world) bounds of an object — its local bounds passed through
 * its transform. This is the box selection hit-testing and the transform handles
 * are drawn around.
 */
export function worldBounds(obj: EditorObject): Bounds {
  return transformBounds(obj.transform, obj.localBounds);
}

/** The ids on a page in paint order (bottom-most first). */
export function pageObjectIds(page: EditorPage): string[] {
  return paintOrder(page.layerStack).map((entry) => entry.objectId);
}

/** The objects on a page in paint order, skipping any whose id is orphaned. */
export function pageObjects(page: EditorPage): EditorObject[] {
  return pageObjectIds(page)
    .map((id) => page.objects[id])
    .filter((o): o is EditorObject => Boolean(o));
}

/**
 * Returns a new page with one object replaced (matched by id). Use this as the
 * low-level edit primitive in commands; higher-level intents (move, resize) are
 * built on top by computing the next object and calling this.
 */
export function setObject(page: EditorPage, next: EditorObject): EditorPage {
  return { ...page, objects: { ...page.objects, [next.id]: next } };
}

/** Returns a new page with an object added to a layer (default: the top layer). */
export function addObjectToPage(
  page: EditorPage,
  obj: EditorObject,
  layerId?: string,
): EditorPage {
  const targetLayer = page.layerStack.layers.find((l) => l.id === (layerId ?? "__top"));
  // Default: the top-most (last) layer.
  const layer =
    targetLayer ?? page.layerStack.layers[page.layerStack.layers.length - 1];
  const nextLayer = { ...layer, objectIds: [...layer.objectIds, obj.id] };
  const nextStack = {
    layers: page.layerStack.layers.map((l) => (l.id === layer.id ? nextLayer : l)),
  };
  return {
    ...page,
    objects: { ...page.objects, [obj.id]: obj },
    layerStack: nextStack,
  };
}

/**
 * Bulk-adds many objects to a page in ONE immutable step (M5 Part 1 perf fix).
 *
 * Unlike calling {@link addObjectToPage} per object — which spreads the entire
 * `objects` map and the target layer's `objectIds` array on every call, making
 * N additions O(N²) — this merges all objects into one new map and appends all
 * ids to the target layer in one spread, so N additions are O(N). Used by the
 * Open-PDF flow, which can add ~2000 extracted text objects to a single page.
 *
 * Objects are appended to the target layer in the order given (paint order =
 * layer arrays), matching {@link addObjectToPage}'s "top of the target layer"
 * semantics. `layerId` resolves exactly as in {@link addObjectToPage}
 * (top-most layer when omitted).
 */
export function addObjectsToPage(
  page: EditorPage,
  objs: EditorObject[],
  layerId?: string,
): EditorPage {
  if (objs.length === 0) return page;
  const targetLayer = page.layerStack.layers.find((l) => l.id === (layerId ?? "__top"));
  const layer = targetLayer ?? page.layerStack.layers[page.layerStack.layers.length - 1];
  const nextLayer = { ...layer, objectIds: [...layer.objectIds, ...objs.map((o) => o.id)] };
  const nextStack = {
    layers: page.layerStack.layers.map((l) => (l.id === layer.id ? nextLayer : l)),
  };
  const objects: Record<string, EditorObject> = { ...page.objects };
  for (const obj of objs) objects[obj.id] = obj;
  return { ...page, objects, layerStack: nextStack };
}

/** Returns a new page with an object removed from its map and its layer array. */
export function removeObjectFromPage(page: EditorPage, objectId: string): EditorPage {
  if (!page.objects[objectId]) return page;
  const { [objectId]: _removed, ...rest } = page.objects;
  void _removed;
  const nextStack = {
    layers: page.layerStack.layers.map((l) => ({
      ...l,
      objectIds: l.objectIds.filter((id) => id !== objectId),
    })),
  };
  return { ...page, objects: rest, layerStack: nextStack };
}

/** Returns a new document with one page replaced (matched by id). */
export function replacePage(doc: EditorDocument, pageId: string, next: EditorPage): EditorDocument {
  return { ...doc, pages: doc.pages.map((p) => (p.id === pageId ? next : p)) };
}

/** Returns a new state with the active page replaced. */
export function setActivePage(state: EditorState, next: EditorPage): EditorState {
  return {
    ...state,
    document: replacePage(state.document, state.activePageId, next),
  };
}

/** Returns a new state with a replacement selection. */
export function setSelection(state: EditorState, selection: SelectionState): EditorState {
  return { ...state, selection };
}
