import { loadPdfDocument } from "./loadDocument";
import { type ProcessedResult } from "./types";

/**
 * Clears document information metadata (title, author, subject, keywords,
 * producer, creator, dates) AND removes the XMP metadata stream from the
 * catalog. Clearing only the Info dictionary leaves the parallel XMP packet
 * intact, so viewers and scrapers could still read the original author/title —
 * this strips both.
 */
export async function removeMetadata(file: File): Promise<ProcessedResult> {
  const { PDFName } = await import("pdf-lib");
  const doc = await loadPdfDocument(file);

  doc.setTitle("");
  doc.setAuthor("");
  doc.setSubject("");
  doc.setKeywords([]);
  doc.setProducer("");
  doc.setCreator("");
  const epoch = new Date(0);
  doc.setCreationDate(epoch);
  doc.setModificationDate(epoch);

  // Drop the XMP metadata stream (Catalog /Metadata) if present.
  try {
    doc.catalog.delete(PDFName.of("Metadata"));
  } catch {
    // No XMP stream — nothing to remove.
  }

  const bytes = await doc.save();
  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    fileName: "cleaned.pdf",
    mimeType: "application/pdf",
  };
}
