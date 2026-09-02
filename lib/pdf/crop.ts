import { loadPdfDocument } from "./loadDocument";
import { PdfProcessingError, type ProcessedResult } from "./types";

export interface CropMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Crops every page by trimming the given margins (in points) from the page as it
 * is VISUALLY displayed, using the PDF CropBox. No rasterization — content is
 * preserved.
 *
 * Two subtleties are handled so the crop matches what the user sees (and what the
 * live preview draws):
 *   1. MediaBox origin — pdf-lib's getSize() drops the MediaBox lower-left
 *      origin, which is non-zero on many print/press PDFs. The CropBox is in
 *      absolute user space, so we offset by getMediaBox().x/y.
 *   2. Page /Rotate — the visual top/right/bottom/left edges do not correspond to
 *      the unrotated user-space edges on rotated pages. We remap the visual
 *      margins into unrotated space per page.
 */
export async function cropPdf(
  file: File,
  margins: CropMargins,
): Promise<ProcessedResult> {
  const { top, right, bottom, left } = margins;
  if ([top, right, bottom, left].some((m) => m < 0)) {
    throw new PdfProcessingError("Margins cannot be negative.", "invalid_input");
  }

  const doc = await loadPdfDocument(file);

  for (const page of doc.getPages()) {
    const box = page.getMediaBox(); // { x, y, width, height } in user space
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    const rect = cropBoxForVisualMargins(box, rotation, margins);

    if (rect.width <= 0 || rect.height <= 0) {
      throw new PdfProcessingError(
        "Margins are too large for the page size. Use smaller values.",
        "invalid_input",
      );
    }
    page.setCropBox(rect.x, rect.y, rect.width, rect.height);
  }

  const bytes = await doc.save();
  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    fileName: "cropped.pdf",
    mimeType: "application/pdf",
  };
}

interface MediaBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Converts visual margins (as seen on the displayed, rotated page) into an
 * absolute CropBox rectangle in unrotated user space.
 *
 * /Rotate is clockwise. The display edge → unrotated edge mapping:
 *   0°:   top→top    right→right   bottom→bottom   left→left
 *   90°:  top→left   right→top     bottom→right    left→bottom
 *   180°: top→bottom right→left    bottom→top      left→right
 *   270°: top→right  right→bottom  bottom→left     left→top
 */
function cropBoxForVisualMargins(
  box: MediaBox,
  rotation: number,
  m: CropMargins,
): { x: number; y: number; width: number; height: number } {
  const { x: mx, y: my, width: W, height: H } = box;
  // Insets in unrotated space, measured from each unrotated edge.
  let insetLeft: number;
  let insetRight: number;
  let insetTop: number;
  let insetBottom: number;

  switch (rotation) {
    case 90:
      insetLeft = m.top;
      insetTop = m.right;
      insetRight = m.bottom;
      insetBottom = m.left;
      break;
    case 180:
      insetLeft = m.right;
      insetTop = m.bottom;
      insetRight = m.left;
      insetBottom = m.top;
      break;
    case 270:
      insetLeft = m.bottom;
      insetTop = m.left;
      insetRight = m.top;
      insetBottom = m.right;
      break;
    default: // 0
      insetLeft = m.left;
      insetTop = m.top;
      insetRight = m.right;
      insetBottom = m.bottom;
      break;
  }

  return {
    x: mx + insetLeft,
    y: my + insetBottom,
    width: W - insetLeft - insetRight,
    height: H - insetTop - insetBottom,
  };
}
