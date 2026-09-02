import { releasePdfDoc, retainPdfDoc } from "@/lib/pdf/render";
import {
  normalizedPageRotation,
  rasterizePageBackground,
} from "@/lib/editor/rasterizePageBackground";
import {
  assembleRestoredBackgrounds,
  planBackgroundRestore,
  type RestoredPage,
} from "@/src/application/editor/persistence/editorCapture";

/**
 * Redrawing a restored draft's page backgrounds from the source PDF it carried.
 *
 * The draft stores the scene graph and the original file's bytes; it does not
 * store the rasters, because a data-URL per page would multiply a 2 MB PDF into
 * tens of megabytes of base64 in IndexedDB and blow the quota on the third
 * document. So the rasters are rebuilt here.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO is call `loadPdfIntoEditor`. That would mint
 * new page ids and return its own state, so restoring would either render a
 * document of white pages (every background key missing) or, if its state were
 * applied, hand the user the file as it sits on disk with every edit silently
 * gone. Instead the draft's scene stays authoritative and only the images are
 * rebuilt, keyed on each page's PINNED source index — which is what survives
 * insert, delete, duplicate and reorder.
 */

/** How the raster rebuild went, in enough detail to be honest about it. */
export interface RestoredBackgrounds {
  /** Page id → data URL. Every restored page has an entry. */
  backgrounds: Map<string, string>;
  /** How many source pages were rendered. */
  rendered: number;
  /**
   * Pages that wanted a raster and did not get one — the source has fewer pages
   * than the draft references, or the render failed. The document is restored;
   * these pages are white.
   */
  unrenderedPageIds: string[];
}

/**
 * Rebuilds the backgrounds for `pages` from `sourceBytes`.
 *
 * Never throws for a per-page problem: a document restored with one white page
 * is better than a restore that fails. It does propagate a failure to OPEN the
 * PDF at all, because that is the caller's decision to present — the scene is
 * still restorable without any images.
 */
export async function restoreBackgrounds(input: {
  pages: readonly RestoredPage[];
  sourceBytes: Uint8Array;
  documentName: string;
  /** Aborts between pages, e.g. when the editor unmounts mid-recovery. */
  signal?: AbortSignal;
}): Promise<RestoredBackgrounds> {
  const wanted = planBackgroundRestore(input.pages);
  if (wanted.length === 0) {
    return {
      backgrounds: assembleRestoredBackgrounds(input.pages, new Map()),
      rendered: 0,
      unrenderedPageIds: [],
    };
  }

  /*
   * A File wrapper, because `retainPdfDoc` is keyed on one — and RETAIN/RELEASE
   * rather than a bare `getPdfDoc`, because that cache is a plain Map, not a
   * WeakMap. Dropping the File without releasing leaves the fully decoded
   * document and its worker-side resources alive for the life of the tab, which
   * on the recovery path means leaking a copy of the user's PDF every time they
   * recover one.
   *
   * A fresh Uint8Array copy: `sourceBytes` may be a view over a larger buffer,
   * and Blob would otherwise serialise the whole backing store.
   */
  const file = new File([new Uint8Array(input.sourceBytes)], `${input.documentName}.pdf`, {
    type: "application/pdf",
  });

  const rasters = new Map<number, string>();
  let rendered = 0;
  try {
    const doc = await retainPdfDoc(file);
    for (const index of wanted) {
      if (input.signal?.aborted) break;
      // 1-based for PDF.js, 0-based in the editor. Out of range is normal, not
      // exceptional: a draft can reference pages a re-uploaded source no longer
      // has.
      if (index < 0 || index >= doc.numPages) continue;
      try {
        const page = await doc.getPage(index + 1);
        const vp = page.getViewport({ scale: 1, rotation: 0 });
        const raster = await rasterizePageBackground(page, {
          width: vp.width,
          height: vp.height,
          rawRotation: normalizedPageRotation(page.rotate),
        });
        // null is a cancelled render — no outcome to record.
        if (raster !== null && raster !== "") {
          rasters.set(index, raster);
          rendered += 1;
        }
      } catch (error) {
        // One unreadable page does not cost the user the other ninety-nine.
        console.error(`restore: could not rasterise source page ${index}`, error);
      }
    }
  } finally {
    releasePdfDoc(file);
  }

  const backgrounds = assembleRestoredBackgrounds(input.pages, rasters);
  const unrenderedPageIds = input.pages
    .filter((page) => page.sourcePageIndex !== null && !rasters.has(page.sourcePageIndex))
    .map((page) => page.pageId);

  return { backgrounds, rendered, unrenderedPageIds };
}
