import { loadPdfDocument } from "./loadDocument";
import { PdfProcessingError, type ProcessedResult } from "./types";
import type { PageRange } from "@/lib/validation/fileSchemas";

/**
 * Extracts a 1-based, inclusive page range from a PDF into a new document.
 * Output page count equals (to - from + 1).
 */
export async function splitPdf(
  file: File,
  range: PageRange,
): Promise<ProcessedResult> {
  const src = await loadPdfDocument(file);
  const total = src.getPageCount();

  if (range.from < 1 || range.to > total || range.from > range.to) {
    throw new PdfProcessingError(
      `Please enter a valid page range between 1 and ${total}.`,
      "invalid_input",
    );
  }

  const { PDFDocument } = await import("pdf-lib");
  const out = await PDFDocument.create();

  // Convert 1-based inclusive range to 0-based indices.
  const indices = [];
  for (let i = range.from - 1; i <= range.to - 1; i++) indices.push(i);

  const pages = await out.copyPages(src, indices);
  pages.forEach((p) => out.addPage(p));

  const bytes = await out.save();
  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    fileName: `split_${range.from}-${range.to}.pdf`,
    mimeType: "application/pdf",
  };
}

/** Returns the page count of a PDF (for range validation in the UI). */
export async function getPageCount(file: File): Promise<number> {
  const doc = await loadPdfDocument(file);
  return doc.getPageCount();
}
