import type { EditorState } from "@/src/domain/editor/document";
import type { SerializedEditorState } from "@/src/application/editor/ports/ISerializer";
import type { CapturedDocument } from "./DocumentPersistenceCoordinator";

/**
 * The two translations between the editor and the persistence subsystem:
 * turning live editor state into a {@link CapturedDocument}, and turning a
 * restored draft back into page backgrounds.
 *
 * Both are pure, and both are here rather than in the component because both have
 * a failure mode that is invisible on screen.
 *
 *
 * CAPTURE MUST BE SYNCHRONOUS.
 *
 * The coordinator documents this as an invariant and the reason is subtle: the
 * scheduler captures at the moment it decides to write, and anything awaited
 * between "decide" and "read the document" is a window in which the user can
 * edit. The write would then be stamped with the revision it was scheduled for
 * while containing a later document — so a crash would restore a draft whose
 * revision claims it is older than it is, and the newer workspace version would
 * be preferred over it. Every function here is therefore sync.
 *
 *
 * RESTORING BACKGROUNDS MUST NOT RE-RUN THE OPEN PATH.
 *
 * `loadPdfIntoEditor` looks like the obvious way to get backgrounds back. It is
 * wrong twice over:
 *
 *   - it mints fresh page ids (`generateId("page")`), so every background key
 *     would miss the restored scene's pages and the whole document would render
 *     white;
 *   - it returns its own `state`, and applying that would replace the draft —
 *     the user would click "Restore my work" and get the file as it was on disk,
 *     with every edit silently gone. That is worse than not offering recovery.
 *
 * So the raster is keyed on each restored page's PINNED source index, and the
 * draft's scene is the authority on everything else.
 */

/** A restored page, reduced to what the background rebuild needs. */
export interface RestoredPage {
  pageId: string;
  /** The 0-based source PDF page this editor page copies, or null if none. */
  sourcePageIndex: number | null;
}

export interface CaptureEditorDocumentInput {
  /** `actions.serialize()` — already synchronous. */
  scene: SerializedEditorState;
  /** Live editor state, read for the counts. */
  state: EditorState;
  /**
   * The opened file's bytes.
   *
   * Carried for a workspace document too, not only for a guest one. Draft assets
   * are content-addressed, so an unchanged source PDF is written once and every
   * later revision reuses it — the cost is one write, and what it buys is a draft
   * that can restore with no network. A draft that can only restore online is not
   * much of a crash recovery.
   */
  sourceBytes: Uint8Array | null;
  /**
   * Where the source can be re-fetched when the bytes are not carried. Recorded
   * even when they are, so a draft whose asset blob was evicted can still say
   * what it was missing.
   */
  sourceReference: string | null;
  documentName: string;
}

/**
 * Live editor state → a snapshot the scheduler can write.
 *
 * Returns null when there is nothing worth writing, which the coordinator treats
 * as "no work to persist" rather than as a failure.
 */
export function captureEditorDocument(
  input: CaptureEditorDocumentInput,
): CapturedDocument | null {
  const pages = input.state.document.pages;
  if (!Array.isArray(pages) || pages.length === 0) return null;

  let objectCount = 0;
  for (const page of pages) {
    // `objects` is a record keyed by object id; a page mid-migration may not
    // have one yet, and a thrown TypeError inside `capture` would surface as a
    // failed autosave rather than as the missing field it is.
    if (page && typeof page.objects === "object" && page.objects !== null) {
      objectCount += Object.keys(page.objects).length;
    }
  }

  return {
    scene: input.scene,
    sourceBytes: input.sourceBytes,
    sourceReference: input.sourceReference,
    documentName: input.documentName,
    pageCount: pages.length,
    objectCount,
  };
}

/**
 * Reads the pages out of a restored draft's scene.
 *
 * `SerializedEditorState.document` is typed `unknown` and that is honest: this
 * came back from IndexedDB, possibly written by an older build. Every field is
 * therefore checked, and anything unrecognisable is skipped rather than thrown —
 * a page whose shape we cannot read loses its background, not the restore.
 */
export function readRestoredPages(scene: SerializedEditorState): RestoredPage[] {
  const document = (scene as { document?: unknown }).document;
  if (typeof document !== "object" || document === null) return [];
  const pages = (document as { pages?: unknown }).pages;
  if (!Array.isArray(pages)) return [];

  const restored: RestoredPage[] = [];
  for (const page of pages) {
    if (typeof page !== "object" || page === null) continue;
    const id = (page as { id?: unknown }).id;
    if (typeof id !== "string" || id === "") continue;
    const raw = (page as { sourcePageIndex?: unknown }).sourcePageIndex;
    /*
     * Only a non-negative integer is a source page. `null` is the documented
     * "no source page" value, but a legacy draft can carry `undefined`, and a
     * corrupted one anything at all — all of which must mean "no raster", never
     * index 0. Defaulting a broken value to 0 would paint page one's image onto
     * an unrelated page, which reads as a corrupted document.
     */
    const sourcePageIndex =
      typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : null;
    restored.push({ pageId: id, sourcePageIndex });
  }
  return restored;
}

/**
 * Which source pages have to be rasterised to redraw a restored document.
 *
 * Deduplicated, because a duplicated page op leaves two editor pages pinned to
 * one source page and rendering it twice is wasted work on the recovery path —
 * the slowest moment in the app, with a user waiting to see their document.
 * Ascending, so the PDF is read front to back.
 */
export function planBackgroundRestore(pages: readonly RestoredPage[]): number[] {
  const wanted = new Set<number>();
  for (const page of pages) {
    if (page.sourcePageIndex !== null) wanted.add(page.sourcePageIndex);
  }
  return [...wanted].sort((a, b) => a - b);
}

/**
 * Rasters → the `backgrounds` map the canvas consumes.
 *
 * Keyed by page id, and a page with no usable raster gets `""` — the same value
 * the open path uses for a page it could not rasterise, which the canvas already
 * renders as white. The alternative, leaving the key absent, is indistinguishable
 * from "not loaded yet" further down and shows a loading state that never ends.
 */
export function assembleRestoredBackgrounds(
  pages: readonly RestoredPage[],
  rasters: ReadonlyMap<number, string>,
): Map<string, string> {
  const backgrounds = new Map<string, string>();
  for (const page of pages) {
    const raster = page.sourcePageIndex === null ? undefined : rasters.get(page.sourcePageIndex);
    backgrounds.set(page.pageId, raster ?? "");
  }
  return backgrounds;
}

/**
 * Whether a restored draft can be redrawn at all.
 *
 * False when the draft references source pages but carries no bytes to render
 * them from — the asset blob was evicted, or the draft was written before the
 * source could be stored. The scene is still restorable; the caller has to say
 * so rather than present a document of blank pages as a complete recovery.
 */
export function canRedrawFromSource(input: {
  pages: readonly RestoredPage[];
  sourceBytes: Uint8Array | null;
}): boolean {
  if (input.sourceBytes !== null && input.sourceBytes.byteLength > 0) return true;
  return input.pages.every((page) => page.sourcePageIndex === null);
}
