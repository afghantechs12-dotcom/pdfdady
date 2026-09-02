import { loadPdfDocument } from "./loadDocument";
import { visualFractionToUserSpace } from "./annotate";
import { assertWinAnsiSafe } from "./winAnsi";
import { PdfProcessingError, type ProcessedResult } from "./types";

/**
 * Stamps a diagonal, semi-transparent text watermark across every page.
 * The watermark is placed against the page as VISUALLY displayed — mapping
 * through /Rotate and the MediaBox origin via visualFractionToUserSpace — so
 * it stays centered and diagonal on rotated/offset pages too.
 */
export async function addWatermark(
  file: File,
  text: string,
): Promise<ProcessedResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new PdfProcessingError("Please enter watermark text.", "invalid_input");
  }
  if (trimmed.length > 60) {
    throw new PdfProcessingError(
      "Watermark text is too long (max 60 chars).",
      "invalid_input",
    );
  }
  assertWinAnsiSafe(trimmed, "Watermark text");

  const doc = await loadPdfDocument(file);
  const { StandardFonts, rgb, degrees } = await import("pdf-lib");
  const font = await doc.embedFont(StandardFonts.HelveticaBold);

  for (const page of doc.getPages()) {
    const box = page.getMediaBox();
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    const { visualWidth, visualHeight } = visualFractionToUserSpace(
      box,
      rotation,
      0,
      0,
    );

    const fontSize = Math.max(24, Math.min(visualWidth, visualHeight) / 10);
    const textWidth = font.widthOfTextAtSize(trimmed, fontSize);

    // Start the baseline so the 45°-rotated text is centered on the visual
    // page center, then map that visual anchor into user space and add the
    // page rotation so the stamp keeps its visual angle on rotated pages.
    const visualX = visualWidth / 2 - (textWidth / 2) * Math.cos(Math.PI / 4);
    const visualY = visualHeight / 2 - (textWidth / 2) * Math.sin(Math.PI / 4);
    const { x, y } = visualFractionToUserSpace(
      box,
      rotation,
      visualX / visualWidth,
      visualY / visualHeight,
    );

    page.drawText(trimmed, {
      x,
      y,
      size: fontSize,
      font,
      color: rgb(0.55, 0.5, 0.7),
      rotate: degrees(rotation + 45),
      opacity: 0.25,
    });
  }

  const bytes = await doc.save();
  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    fileName: "watermarked.pdf",
    mimeType: "application/pdf",
  };
}
