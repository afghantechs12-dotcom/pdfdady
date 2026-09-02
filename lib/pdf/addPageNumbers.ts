import { loadPdfDocument } from "./loadDocument";
import { visualFractionToUserSpace } from "./annotate";
import { type ProcessedResult } from "./types";

export type PageNumberPosition = "bottom-center" | "bottom-right";

/**
 * Draws sequential page numbers onto every page using an embedded standard
 * font. Positions are computed against the page as VISUALLY displayed —
 * accounting for /Rotate and the MediaBox origin via visualFractionToUserSpace
 * — so numbers land at the visual bottom of rotated/offset pages too.
 */
export async function addPageNumbers(
  file: File,
  options?: { position?: PageNumberPosition; showTotal?: boolean },
): Promise<ProcessedResult> {
  const position = options?.position ?? "bottom-center";
  const showTotal = options?.showTotal ?? true;

  const doc = await loadPdfDocument(file);
  const { StandardFonts, rgb, degrees } = await import("pdf-lib");
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const pages = doc.getPages();
  const total = pages.length;
  const fontSize = 11;
  const margin = 28;

  pages.forEach((page, i) => {
    const label = showTotal ? `${i + 1} / ${total}` : `${i + 1}`;
    const textWidth = font.widthOfTextAtSize(label, fontSize);

    const box = page.getMediaBox();
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    const { visualWidth, visualHeight } = visualFractionToUserSpace(
      box,
      rotation,
      0,
      0,
    );

    // Anchor point in VISUAL coordinates (from the displayed page's
    // bottom-left), then map into user space and counter-rotate the text.
    const visualX =
      position === "bottom-right"
        ? visualWidth - margin - textWidth
        : visualWidth / 2 - textWidth / 2;
    const { x, y } = visualFractionToUserSpace(
      box,
      rotation,
      visualX / visualWidth,
      margin / visualHeight,
    );

    page.drawText(label, {
      x,
      y,
      size: fontSize,
      font,
      color: rgb(0.2, 0.2, 0.25),
      rotate: degrees(rotation),
    });
  });

  const bytes = await doc.save();
  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    fileName: "numbered.pdf",
    mimeType: "application/pdf",
  };
}
