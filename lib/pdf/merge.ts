import { loadPdfDocument } from "./loadDocument";
import { PdfProcessingError, type ProcessedResult } from "./types";

/**
 * Merges 2+ PDFs into a single document, preserving input order.
 * Output page count equals the sum of input page counts. No network calls.
 */
export async function mergePdfs(files: File[]): Promise<ProcessedResult> {
  if (files.length < 2) {
    throw new PdfProcessingError(
      "Please add at least two PDF files to merge.",
      "invalid_input",
    );
  }

  const { PDFDocument } = await import("pdf-lib");
  const merged = await PDFDocument.create();

  for (const file of files) {
    const src = await loadPdfDocument(file);
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach((p) => merged.addPage(p));
  }

  const out = await merged.save();
  return {
    blob: new Blob([out], { type: "application/pdf" }),
    fileName: "merged.pdf",
    mimeType: "application/pdf",
  };
}
