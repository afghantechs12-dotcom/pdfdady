import { getPdfDoc } from "@/lib/pdf/render";
import {
  MAX_BACKGROUND_PAGE_DIM,
  normalizedPageRotation,
  rasterizePageBackground,
} from "@/lib/editor/rasterizePageBackground";
import {
  addObjectsToPage,
  createPage,
  EDITOR_FORMAT_VERSION,
  type EditorPage,
  type EditorState,
} from "@/src/domain/editor/document";
import { generateId } from "@/src/domain/editor/ids";
import { extractTextObjects } from "@/lib/editor/extractText";

/**
 * The "Open PDF to edit" flow (Part 1 — editing existing PDFs). Loads a PDF
 * with PDF.js, creates one editor page per source page sized to the page's point
 * dimensions, rasterizes each page to a PNG data URL for the canvas background,
 * and returns the seeded editor state + the backgrounds + the source bytes (kept
 * for export, so edits draw onto copies of the original pages — preserving the
 * original content).
 *
 * M5 Part 1: each page's EXISTING text is also extracted (PDF.js
 * `getTextContent`) and turned into editable `TextObject`s placed over the
 * original with an opaque white background that redacts the original on screen
 * and in export. Extraction is best-effort and non-fatal — a page whose text
 * can't be read still opens with a blank overlay. Backgrounds + text are
 * rasterized/extracted up front for correctness/simplicity; lazy per-page work
 * (the M3.d virtualization pattern) is a documented perf refinement for very
 * large PDFs (Part 10).
 *
 * Resource bounds (M5 Part 1 security hardening): a crafted/huge PDF can't DoS
 * the tab on open — the page count is capped ({@link MAX_OPEN_PAGES}, mirroring
 * the server-side `PDF_TO_IMAGES_MAX_PAGES` convention), pathologically large
 * page dimensions skip rasterization, and the total extracted-text object count
 * is capped ({@link MAX_EXTRACTED_OBJECTS}). Page-count over the cap is an
 * actionable {@link PdfOpenError} (the editor cannot silently drop pages, since
 * export would then lose them); the other bounds truncate with a non-fatal
 * fallback (white background / fewer extracted lines).
 */

/**
 * A user-facing Open-PDF error with an actionable message (e.g. too many pages).
 *
 * `pageCap` carries the two NUMBERS behind a page-cap refusal rather than relying
 * on the message string. The presentation layer authors every sentence a user
 * reads and passes no text through (`documentLoadState.ts`), so a refusal that
 * only exists as prose here cannot reach the Workspace panel — which is exactly
 * how a 300-page document came to be described as possibly damaged. Numbers cross
 * that boundary; text does not.
 */
export class PdfOpenError extends Error {
  constructor(
    message: string,
    readonly pageCap: { pages: number; max: number } | null = null,
  ) {
    super(message);
    this.name = "PdfOpenError";
  }
}

/**
 * Hard cap on the number of pages opened into the editor. Mirrors the server-side
 * `PDF_TO_IMAGES_MAX_PAGES` default (200): the editor rasterizes every page to a
 * PNG data URL up front, so a many-page crafted PDF would otherwise freeze/OOM
 * the tab. Over the cap is rejected (not truncated) because export draws edits
 * onto copies of the ORIGINAL source pages — silently loading only the first N
 * would drop the rest on export. Users split the PDF first (same guidance as the
 * server image-extraction path).
 */
const MAX_OPEN_PAGES = 200;

/**
 * Maximum page dimension (points) we will rasterize — see
 * {@link MAX_BACKGROUND_PAGE_DIM}, which the draft-restore path shares so a
 * recovered document is rasterised by exactly the same rules as an opened one.
 */
const MAX_PAGE_DIM = MAX_BACKGROUND_PAGE_DIM;

export interface LoadedPdf {
  state: EditorState;
  backgrounds: Map<string, string>;
  sourceBytes: Uint8Array;
}

export interface LoadPdfOptions {
  /**
   * When true (default), existing text on each page is extracted into editable
   * `TextObject`s. Set false to open a blank-overlay editor (faster for very
   * large PDFs until lazy extraction lands in Part 10).
   */
  extractText?: boolean;
}

/**
 * The per-page extraction budget decision (M5 Part 1 resource bound). Pure so it
 * is unit-testable without a DOM/PDF.js: given how many text objects have
 * already been extracted across the document, returns whether this page should
 * extract at all and, if so, the per-page line cap that keeps the running total
 * under `budgetTotal`.
 *
 * @param totalExtracted Text objects extracted on prior pages so far.
 * @param budgetTotal     The document-wide cap ({@link MAX_EXTRACTED_OBJECTS}).
 * @param perPageMax      The default per-page line cap (2000).
 * @returns `{ extract, maxLines }` — `extract` is false once the budget is spent;
 *          `maxLines` is scaled by the remaining budget so the total never
 *          exceeds `budgetTotal`.
 */
export function pageExtractionBudget(
  totalExtracted: number,
  budgetTotal: number,
  perPageMax: number,
): { extract: boolean; maxLines: number } {
  if (totalExtracted >= budgetTotal) return { extract: false, maxLines: 0 };
  const remaining = budgetTotal - totalExtracted;
  return { extract: true, maxLines: Math.min(perPageMax, remaining) };
}

/**
 * Global cap on the number of existing-text objects created across the whole
 * document (M5 Part 1 resource bound). Bounds memory on huge/crafted PDFs;
 * pages beyond the budget still open with their rasterized background. The real
 * fix for very large docs is lazy per-page extraction (Part 10).
 */
const MAX_EXTRACTED_OBJECTS = 20_000;
/** Default per-page line cap (a single pathological page can't dominate). */
const PER_PAGE_MAX_LINES = 2_000;

export async function loadPdfIntoEditor(file: File, options: LoadPdfOptions = {}): Promise<LoadedPdf> {
  const extract = options.extractText ?? true;
  const sourceBytes = new Uint8Array(await file.arrayBuffer());
  const doc = await getPdfDoc(file);

  // Page-count cap: reject (do not truncate) over the limit — see PdfOpenError.
  if (doc.numPages > MAX_OPEN_PAGES) {
    throw new PdfOpenError(
      `This PDF has ${doc.numPages} pages. The editor supports up to ${MAX_OPEN_PAGES} pages — please split the PDF first.`,
      { pages: doc.numPages, max: MAX_OPEN_PAGES },
    );
  }

  const pages: EditorPage[] = [];
  const backgrounds = new Map<string, string>();
  let totalExtracted = 0;

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    // The editor's page space is UNROTATED (MediaBox) space — objects live
    // there, and the page's /Rotate is carried as `EditorPage.rotation`, a
    // DISPLAY attribute the canvas applies when rendering (M6 rotation-aware
    // canvas) and export re-applies via `page.setRotation`. So dimensions, the
    // background raster, and the extracted text below are all produced with
    // rotation 0; the on-screen result still matches the original PDF because
    // the canvas rotates the whole surface by `rotation`.
    const vp = page.getViewport({ scale: 1, rotation: 0 });
    const pageId = generateId("page");
    const rawRotation = (((page.rotate ?? 0) % 360) + 360) % 360;
    const rotation = normalizedPageRotation(page.rotate);
    // Pin the page to its source PDF page (0-based) so export copies the right
    // source page even after insert/delete/duplicate/reorder (M6 page ops).
    let editorPage = createPage(pageId, Math.round(vp.width), Math.round(vp.height), rotation, i - 1);

    // Rasterize the page to a PNG data URL for the canvas background, in
    // UNROTATED page space (extraRotation cancels the page's own /Rotate). A
    // page with pathologically large dimensions is skipped (white bg) rather
    // than OOMing on the canvas backing-store allocation.
    // A cancelled render (null) stores nothing: cancellation is not an outcome,
    // and recording "" for it would bake a white page into the document.
    const raster = await rasterizePageBackground(page, {
      width: vp.width,
      height: vp.height,
      rawRotation,
    });
    if (raster !== null) backgrounds.set(pageId, raster);

    // M5 Part 1: extract existing text into editable objects on the page's
    // default layer. Extraction failures return [] (non-fatal). A global object
    // budget bounds memory on huge/crafted docs — once reached, further pages
    // skip extraction (they still open with their rasterized background; full
    // lazy per-page extraction is the Part 10 performance milestone). The
    // objects are bulk-merged into the page in one O(k) step (not per object).
    const budget = pageExtractionBudget(totalExtracted, MAX_EXTRACTED_OBJECTS, PER_PAGE_MAX_LINES);
    if (extract && budget.extract) {
      try {
        const textObjects = await extractTextObjects(page, {
          pageWidth: Math.round(vp.width),
          pageHeight: Math.round(vp.height),
          layerId: editorPage.layerStack.layers[0].id,
          maxLines: budget.maxLines,
        });
        editorPage = addObjectsToPage(editorPage, textObjects, editorPage.layerStack.layers[0].id);
        totalExtracted += textObjects.length;
      } catch {
        // Non-fatal: a page whose text can't be extracted still opens cleanly.
      }
    }

    pages.push(editorPage);
  }

  const editorDocument = {
    id: generateId("doc"),
    version: EDITOR_FORMAT_VERSION,
    pages,
    metadata: { sourceName: file.name },
  };
  const state: EditorState = {
    document: editorDocument,
    activePageId: pages[0]?.id ?? "",
    selection: { ids: [], primaryId: null },
  };
  return { state, backgrounds, sourceBytes };
}
