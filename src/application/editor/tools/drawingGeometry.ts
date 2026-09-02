import type { Point } from "@/src/domain/editor/geometry";
import type { BrushKind, DrawingObject } from "@/src/domain/editor/objects";
import { sampleSmoothedCenterline, smoothedPathData } from "./strokeSmoothing";
import { buildStrokeOutline } from "./strokeOutline";

/**
 * The single derivation of a freehand stroke's rendered geometry (M6).
 *
 * Both the SVG renderer (`ObjectRenderer`) and the PDF exporter
 * (`PdfExportService`) call {@link deriveDrawingRender} on the SAME stored
 * fields ({@link DrawingObject.points}/`widths`/`smoothing`/`brush`), so a
 * stroke looks identical on screen and in the exported PDF by construction.
 *
 * Brush semantics:
 *  - "pen":         the classic stroke (opacity 1).
 *  - "marker":      wider default, 60% opacity, round caps.
 *  - "highlighter": wide, 35% opacity, MULTIPLY blend (like HighlightObject).
 *  - "pencil":      1px default with a deterministic jitter texture — each
 *                   point is offset by a hash of its INDEX (a Knuth
 *                   multiplicative hash, see {@link pencilJitter}), NOT by
 *                   Math.random(), so re-renders and export are identical.
 *
 * Rendering modes:
 *  - `fill`:   pressure strokes (per-point `widths`) render as a CLOSED
 *              variable-width outline filled with the stroke color. When
 *              smoothing is also on, the CENTERLINE is smoothed (resampled
 *              from the Catmull-Rom curve) before offsetting.
 *  - `stroke`: constant-width strokes; smoothing swaps the polyline for the
 *              Catmull-Rom→Bézier path.
 */

/** Opacity multiplier applied per brush (on top of object opacity + color alpha). */
export const BRUSH_OPACITY: Record<BrushKind, number> = {
  pen: 1,
  marker: 0.6,
  highlighter: 0.35,
  pencil: 1,
};

/** Default stroke width per brush, used by the toolbar when switching brushes. */
export const BRUSH_DEFAULT_WIDTH: Record<BrushKind, number> = {
  pen: 2,
  marker: 8,
  highlighter: 12,
  pencil: 1,
};

/** Default pressure-simulation setting per brush (pen/pencil feel like ink). */
export const BRUSH_DEFAULT_PRESSURE: Record<BrushKind, boolean> = {
  pen: true,
  marker: false,
  highlighter: false,
  pencil: true,
};

/** The brush list in toolbar order. */
export const ALL_BRUSHES: readonly BrushKind[] = ["pen", "marker", "highlighter", "pencil"];

/** Human labels for the brushes. */
export const BRUSH_LABELS: Record<BrushKind, string> = {
  pen: "Pen",
  marker: "Marker",
  highlighter: "Highlighter",
  pencil: "Pencil",
};

/** Jitter amplitude for the pencil texture, in local units. */
export const PENCIL_JITTER_AMPLITUDE = 0.6;

/**
 * Deterministic per-index jitter in [-0.5, 0.5): a Knuth multiplicative hash
 * of the point index (`i · 2654435761 mod 2³²`, scaled). Documented contract:
 * NO randomness — the same stroke always renders the same texture, on screen
 * and in the exported PDF.
 */
export function pencilJitter(index: number): number {
  const h = (index * 2654435761) >>> 0;
  return h / 4294967296 - 0.5;
}

/** Applies the deterministic pencil jitter to a polyline (indices seed the hash). */
export function jitterPoints(points: Point[]): Point[] {
  return points.map((p, i) => ({
    x: p.x + pencilJitter(2 * i) * PENCIL_JITTER_AMPLITUDE,
    y: p.y + pencilJitter(2 * i + 1) * PENCIL_JITTER_AMPLITUDE,
  }));
}

/** What the renderer/exporter must draw for one drawing object. */
export interface DrawingRenderSpec {
  /** "stroke": stroke `pathData` at `strokeWidth`; "fill": fill the closed outline. */
  mode: "stroke" | "fill";
  /** SVG path data in LOCAL coordinates (M/L/C, plus Z for fill mode). */
  pathData: string;
  /** Stroke width for stroke mode (0 in fill mode — the outline carries width). */
  strokeWidth: number;
  /** Brush opacity multiplier (combine with object opacity and color alpha). */
  opacityFactor: number;
  /** True for highlighter: render/export with MULTIPLY blend. */
  blendMultiply: boolean;
}

const fmt = (n: number): string => {
  const r = Math.round(n * 1000) / 1000;
  return String(r === 0 ? 0 : r);
};

function polylinePathData(points: Point[]): string {
  if (points.length === 0) return "";
  const parts = [`M ${fmt(points[0].x)} ${fmt(points[0].y)}`];
  for (let i = 1; i < points.length; i++) parts.push(`L ${fmt(points[i].x)} ${fmt(points[i].y)}`);
  return parts.join(" ");
}

/** The fields the derivation reads (structural subset of {@link DrawingObject}). */
export type DrawingRenderSource = Pick<DrawingObject, "points" | "brush" | "smoothing" | "widths"> & {
  style: { strokeWidth: number };
};

/**
 * Derives the render spec for a drawing object. Pure and deterministic — see
 * the module docs for the mode/brush rules.
 */
export function deriveDrawingRender(obj: DrawingRenderSource): DrawingRenderSpec {
  const brush: BrushKind = obj.brush ?? "pen";
  const opacityFactor = BRUSH_OPACITY[brush];
  const blendMultiply = brush === "highlighter";
  const baseWidth = obj.style.strokeWidth > 0 ? obj.style.strokeWidth : BRUSH_DEFAULT_WIDTH[brush];
  const points = brush === "pencil" ? jitterPoints(obj.points) : obj.points;

  const hasPressure =
    Array.isArray(obj.widths) && obj.widths.length > 0 && obj.points.length >= 2;

  if (hasPressure) {
    const widths = obj.widths as number[];
    const centerline = obj.smoothing
      ? sampleSmoothedCenterline(points, widths)
      : { points, widths };
    const outline = buildStrokeOutline(centerline.points, centerline.widths ?? widths);
    if (outline) {
      return { mode: "fill", pathData: outline, strokeWidth: 0, opacityFactor, blendMultiply };
    }
    // Degenerate outline (all points identical) → fall through to stroke mode.
  }

  const pathData = obj.smoothing && points.length >= 3 ? smoothedPathData(points) : polylinePathData(points);
  return { mode: "stroke", pathData, strokeWidth: baseWidth, opacityFactor, blendMultiply };
}
