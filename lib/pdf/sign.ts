import { loadPdfDocument } from "./loadDocument";
import { visualFractionToUserSpace } from "./annotate";
import { PdfProcessingError, type ProcessedResult } from "./types";

export interface SignPlacement {
  pageIndex: number;
  xFrac: number; // 0..1 left edge of the image on the DISPLAYED page
  yFrac: number; // 0..1 bottom edge of the image, from the bottom of the DISPLAYED page
  widthFrac: number; // 0..1 image width relative to the DISPLAYED page width
}

/**
 * Places a signature image (PNG/JPG) onto a chosen page at a relative position
 * and size. This is a VISUAL signature, not a cryptographic one.
 *
 * Placement is expressed against the DISPLAYED page (matching the live preview);
 * we map the anchor into unrotated user space (MediaBox origin + /Rotate aware)
 * and counter-rotate the image so it sits upright on rotated pages.
 */
export async function signPdf(
  file: File,
  signatureImage: File,
  placement: SignPlacement,
): Promise<ProcessedResult> {
  const doc = await loadPdfDocument(file);
  const pages = doc.getPages();

  if (placement.pageIndex < 0 || placement.pageIndex >= pages.length) {
    throw new PdfProcessingError("Selected page is out of range.", "invalid_input");
  }

  const imgBytes = new Uint8Array(await signatureImage.arrayBuffer());
  let image;
  try {
    if (signatureImage.type === "image/png") {
      image = await doc.embedPng(imgBytes);
    } else if (signatureImage.type === "image/jpeg") {
      image = await doc.embedJpg(imgBytes);
    } else {
      throw new PdfProcessingError(
        "Signature must be a PNG or JPG image.",
        "unsupported_format",
      );
    }
  } catch (err) {
    if (err instanceof PdfProcessingError) throw err;
    throw new PdfProcessingError(
      "We couldn't read the signature image.",
      "corrupt_document",
    );
  }

  const { degrees } = await import("pdf-lib");
  const page = pages[placement.pageIndex];
  const box = page.getMediaBox();
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;

  const { x, y, visualWidth } = visualFractionToUserSpace(
    box,
    rotation,
    placement.xFrac,
    placement.yFrac,
  );
  const drawWidth = Math.max(1, placement.widthFrac * visualWidth);
  const drawHeight = (image.height / image.width) * drawWidth;

  page.drawImage(image, {
    x,
    y,
    width: drawWidth,
    height: drawHeight,
    rotate: degrees(rotation),
  });

  const bytes = await doc.save();
  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    fileName: "signed.pdf",
    mimeType: "application/pdf",
  };
}
