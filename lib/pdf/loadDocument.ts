import type { PDFDocument } from "pdf-lib";
import { PdfProcessingError } from "./types";

/**
 * Loads a File into a pdf-lib PDFDocument with friendly error handling for
 * corrupt or password-protected PDFs. pdf-lib is imported dynamically so it
 * stays out of the homepage bundle.
 */
export async function loadPdfDocument(file: File): Promise<PDFDocument> {
  const { PDFDocument } = await import("pdf-lib");
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    // The bytes could not be read off the File handle at all (revoked blob,
    // removed device). Nothing about the document was ever parsed, so this is a
    // read failure, not a claim that the PDF is malformed.
    throw new PdfProcessingError(
      "We couldn't read this file. Please try again.",
      "corrupt_document",
    );
  }

  let doc: PDFDocument;
  try {
    // `ignoreEncryption: true` so the parse SUCCEEDS on an encrypted file and we
    // can ask the document about itself. The alternative — letting load() throw
    // and catching `EncryptedPDFError` — cannot work: pdf-lib's CJS build
    // constructs that class through tslib's `_super.call(this, msg) || this`
    // downlevel, which returns a plain Error, so its prototype chain never
    // reaches EncryptedPDFError and `instanceof` is false for every encrypted
    // PDF ever loaded. That silently sent every password-protected file down the
    // "may be corrupted" path with a `corrupt_document` category. A message
    // substring would be just as fragile in the other direction. `isEncrypted`
    // reads the document's own /Encrypt trailer entry: a fact about the file,
    // not about the shape of a thrown object.
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch {
    throw new PdfProcessingError(
      `We couldn't read "${file.name}". It may be corrupted or not a valid PDF.`,
      "corrupt_document",
    );
  }

  // pdf-lib cannot decrypt, so even owner-password-only files must be unlocked
  // first — point users at the unlock tool rather than a dead end. Checked after
  // the parse and before returning, so no caller can act on a document whose
  // contents pdf-lib is not actually able to read.
  if (doc.isEncrypted) {
    throw new PdfProcessingError(
      `"${file.name}" is encrypted (password-protected), so this in-browser tool can't modify it. Use the Unlock PDF tool first, then try again.`,
      "password_required",
    );
  }

  return doc;
}
