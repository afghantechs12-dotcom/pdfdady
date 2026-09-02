import type { PDFPageProxy } from "pdfjs-dist";
import { renderPageToCanvas, isRenderCancelled } from "@/lib/pdf/render";

/**
 * Rasterising one PDF page into an editor page background.
 *
 * Extracted so the OPEN path and the draft-RESTORE path share one
 * implementation. They have to produce byte-identical rasters: a restored
 * document whose backgrounds were rendered at a different scale, or without the
 * page's own /Rotate cancelled, is visibly not the document the user was editing
 * — and the difference would only ever appear after a crash, which is the worst
 * moment to discover two subtly different rasterisers.
 */

/**
 * The background raster's scale over PDF points.
 *
 * 1.5 is the shipped value. It is a fidelity/memory trade the editor already
 * made, and changing it here would silently re-render every restored document at
 * a different sharpness than the one the user opened.
 */
export const BACKGROUND_RENDER_SCALE = 1.5;

/**
 * Largest page dimension (points) worth rasterising.
 *
 * A page near the PDF spec maximum (14400pt) allocates a backing store of
 * `dim x scale x devicePixelRatio` pixels per side and throws or OOMs. Such a
 * page gets a white background instead — the page still opens, and its objects
 * are still editable.
 */
export const MAX_BACKGROUND_PAGE_DIM = 10_000;

/**
 * Renders `page` to a PNG data URL in UNROTATED page space.
 *
 * @returns the data URL; `""` when the page was skipped or the render failed
 *          (both non-fatal — the canvas draws an empty string as white); `null`
 *          when the render was CANCELLED, which is not an outcome at all and
 *          must not be stored as one.
 */
export async function rasterizePageBackground(
  page: PDFPageProxy,
  input: {
    /** Unrotated page width in points. */
    width: number;
    /** Unrotated page height in points. */
    height: number;
    /** The page's own /Rotate, normalised to 0/90/180/270. */
    rawRotation: number;
  },
): Promise<string | null> {
  if (input.width > MAX_BACKGROUND_PAGE_DIM || input.height > MAX_BACKGROUND_PAGE_DIM) {
    return "";
  }
  const canvas = document.createElement("canvas");
  try {
    /*
     * `-rawRotation` cancels the page's own /Rotate: the editor's page space is
     * unrotated MediaBox space, and the rotation is re-applied as a display
     * attribute by the canvas and again by export. Rasterising WITH the rotation
     * would rotate the background twice.
     */
    const result = await renderPageToCanvas(
      page,
      canvas,
      input.width * BACKGROUND_RENDER_SCALE,
      -input.rawRotation,
    );
    await result.done;
    return canvas.toDataURL("image/png");
  } catch (err) {
    if (isRenderCancelled(err)) return null;
    // A failed render is not a failed open. The page shows white.
    return "";
  }
}

/** The page's /Rotate, normalised to the four values the editor models. */
export function normalizedPageRotation(rotate: number | undefined): 0 | 90 | 180 | 270 {
  const raw = (((rotate ?? 0) % 360) + 360) % 360;
  return (raw === 90 || raw === 180 || raw === 270 ? raw : 0) as 0 | 90 | 180 | 270;
}
