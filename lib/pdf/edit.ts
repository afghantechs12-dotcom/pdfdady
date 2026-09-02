import { loadPdfDocument } from "./loadDocument";
import { PdfProcessingError, type ProcessedResult } from "./types";

/**
 * Describes the desired final state of the document: which original pages to
 * keep, in what order, and with what rotation. This single model cleanly
 * expresses delete (omit a page), rotate (set rotation), and reorder (order
 * of the array).
 */
export interface EditPage {
  originalIndex: number; // 0-based index into the source document
  rotation: number; // rotation DELTA in degrees (0 | 90 | 180 | 270), added to the page's own /Rotate
}

export async function editPdf(
  file: File,
  pages: EditPage[],
): Promise<ProcessedResult> {
  if (pages.length === 0) {
    throw new PdfProcessingError(
      "You must keep at least one page in the document.",
      "invalid_input",
    );
  }

  const src = await loadPdfDocument(file);
  const total = src.getPageCount();

  const { PDFDocument, degrees } = await import("pdf-lib");
  const out = await PDFDocument.create();

  const indices = pages.map((p) => p.originalIndex);
  if (indices.some((i) => i < 0 || i >= total)) {
    throw new PdfProcessingError("Invalid page selection.", "invalid_input");
  }

  const copied = await out.copyPages(src, indices);
  copied.forEach((page, i) => {
    // The UI (and the live preview in lib/pdf/render.ts) treats rotation as a
    // delta on top of the page's existing /Rotate, so add — never overwrite —
    // or pages that were already rotated in the source come out sideways.
    const rotation =
      (((page.getRotation().angle + pages[i].rotation) % 360) + 360) % 360;
    page.setRotation(degrees(rotation));
    out.addPage(page);
  });

  const bytes = await out.save();
  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    fileName: "edited.pdf",
    mimeType: "application/pdf",
  };
}
