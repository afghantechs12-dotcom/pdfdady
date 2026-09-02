import { loadPdfDocument } from "./loadDocument";
import { assertWinAnsiSafe } from "./winAnsi";
import { PdfProcessingError, type ProcessedResult } from "./types";

export interface TextNote {
  pageIndex: number;
  text: string;
  xFrac: number; // 0..1 from the left of the DISPLAYED page
  yFrac: number; // 0..1 from the bottom of the DISPLAYED page
  fontSize: number;
}

/**
 * Adds a simple text note to a chosen page at a relative position, using an
 * embedded standard font.
 *
 * xFrac/yFrac are expressed against the page as it is VISUALLY displayed (which
 * is what the live preview shows). We map that point into unrotated user space —
 * accounting for the MediaBox origin and the page's /Rotate — and counter-rotate
 * the text so it reads upright on rotated pages. This keeps the preview and the
 * output in agreement.
 */
export async function annotatePdf(
  file: File,
  note: TextNote,
): Promise<ProcessedResult> {
  const trimmed = note.text.trim();
  if (!trimmed) {
    throw new PdfProcessingError("Please enter note text.", "invalid_input");
  }
  if (trimmed.length > 500) {
    throw new PdfProcessingError(
      "Note is too long (max 500 characters).",
      "invalid_input",
    );
  }
  assertWinAnsiSafe(trimmed, "Note text");

  const doc = await loadPdfDocument(file);
  const pages = doc.getPages();
  if (note.pageIndex < 0 || note.pageIndex >= pages.length) {
    throw new PdfProcessingError("Selected page is out of range.", "invalid_input");
  }

  const { StandardFonts, rgb, degrees } = await import("pdf-lib");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = pages[note.pageIndex];
  const box = page.getMediaBox();
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;

  const { x, y, visualWidth } = visualFractionToUserSpace(
    box,
    rotation,
    note.xFrac,
    note.yFrac,
  );

  page.drawText(trimmed, {
    x,
    y,
    size: note.fontSize,
    font,
    color: rgb(0.86, 0.15, 0.15),
    rotate: degrees(rotation), // cancel the display rotation so text is upright
    maxWidth: visualWidth * 0.8,
    lineHeight: note.fontSize * 1.2,
  });

  const bytes = await doc.save();
  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    fileName: "annotated.pdf",
    mimeType: "application/pdf",
  };
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Maps a point given as (xFrac from left, yFrac from bottom) of the DISPLAYED
 * page into an absolute (x, y) in unrotated user space. Also returns the visual
 * page width (points) for maxWidth. /Rotate is clockwise; the inverse mapping
 * from visual → unrotated coords is:
 *   0°:   ux=vx,     uy=vy
 *   90°:  ux=W - vy, uy=vx
 *   180°: ux=W - vx, uy=H - vy
 *   270°: ux=vy,     uy=H - vx
 */
export function visualFractionToUserSpace(
  box: Box,
  rotation: number,
  xFrac: number,
  yFrac: number,
): { x: number; y: number; visualWidth: number; visualHeight: number } {
  const { x: mx, y: my, width: W, height: H } = box;
  const swapped = rotation === 90 || rotation === 270;
  const visualWidth = swapped ? H : W;
  const visualHeight = swapped ? W : H;

  const vx = xFrac * visualWidth;
  const vy = yFrac * visualHeight;

  let ux: number;
  let uy: number;
  switch (rotation) {
    case 90:
      ux = W - vy;
      uy = vx;
      break;
    case 180:
      ux = W - vx;
      uy = H - vy;
      break;
    case 270:
      ux = vy;
      uy = H - vx;
      break;
    default:
      ux = vx;
      uy = vy;
      break;
  }

  return { x: mx + ux, y: my + uy, visualWidth, visualHeight };
}
