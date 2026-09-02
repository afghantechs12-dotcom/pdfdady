import type { AnnotationObject } from "./objects";
import { roundedRectPath } from "./shapeGeometry";

/**
 * The ONE source of truth for how a sticky note is laid out and painted.
 *
 * Why this module exists: the canvas renderer and the PDF exporter each used to
 * carry their own idea of a note. The renderer drew a rounded panel filled with a
 * hardcoded `rgba(255,245,180,0.95)` and inset its text by 6 units; the exporter
 * drew no panel at all and put the first baseline at the very top-left corner. So
 * the same annotation was two different objects depending on which renderer you
 * asked — and only one of them was ever saved.
 *
 * Both consumers now read these functions, which is the same discipline
 * `fitContain` enforces for signatures and `shapePathData` for shapes: geometry
 * that must agree is computed once, not twice.
 */

/** Text inset from the panel's local origin, in local units. */
export const ANNOTATION_TEXT_PADDING = 6;

/** Line advance as a multiple of font size (notes carry no lineHeight field). */
export const ANNOTATION_LINE_HEIGHT = 1.2;

/** The panel to paint behind a note's text, or `null` when there is nothing to paint. */
export interface AnnotationPanel {
  width: number;
  height: number;
  /** Clamped to half the shorter side, so an oversized radius cannot invert the path. */
  cornerRadius: number;
  /** SVG path data in LOCAL coordinates — the same string both consumers draw. */
  pathData: string;
  background: AnnotationObject["background"];
  border: AnnotationObject["border"];
  /** Zero when no border should be drawn (no color, or width 0). */
  borderWidth: number;
}

/**
 * The note's panel, or `null` when the note is genuinely text-only.
 *
 * Returning null rather than a transparent panel keeps "no panel" a single
 * decision both consumers make identically — a renderer that drew a
 * zero-alpha rect and an exporter that drew nothing would differ in blend
 * behaviour over existing page content.
 */
export function annotationPanel(obj: AnnotationObject): AnnotationPanel | null {
  const width = Math.max(obj.localBounds.width, 0);
  const height = Math.max(obj.localBounds.height, 0);
  if (width <= 0 || height <= 0) return null;

  const hasBorder = obj.border !== null && obj.borderWidth > 0;
  if (obj.background === null && !hasBorder) return null;

  const cornerRadius = Math.max(
    0,
    Math.min(Number.isFinite(obj.cornerRadius) ? obj.cornerRadius : 0, Math.min(width, height) / 2),
  );
  return {
    width,
    height,
    cornerRadius,
    pathData: roundedRectPath(width, height, cornerRadius),
    background: obj.background,
    border: hasBorder ? obj.border : null,
    borderWidth: hasBorder ? obj.borderWidth : 0,
  };
}

/** Where each line of note text sits, in LOCAL units. */
export interface AnnotationTextLayout {
  /** Left inset for every line. */
  x: number;
  /** Lines exactly as authored — an empty line stays an empty line. */
  lines: string[];
  /** Local-unit advance between consecutive baselines. */
  lineAdvance: number;
  /** Local y of the first line's TOP edge (not its baseline). */
  firstLineTop: number;
}

/**
 * Splits a note's text into laid-out lines.
 *
 * `\n` only, matching the model: annotation text is a plain string and the
 * inspector's textarea produces `\n`. No wrapping — a note that overflows its
 * panel overflows it identically in both consumers, which is the honest
 * behaviour until the model grows a wrap field.
 */
export function annotationTextLayout(obj: AnnotationObject): AnnotationTextLayout {
  return {
    x: ANNOTATION_TEXT_PADDING,
    lines: obj.text.split("\n"),
    lineAdvance: obj.fontSize * ANNOTATION_LINE_HEIGHT,
    firstLineTop: ANNOTATION_TEXT_PADDING,
  };
}
