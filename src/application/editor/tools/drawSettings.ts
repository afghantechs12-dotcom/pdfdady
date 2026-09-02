/**
 * The Draw tool's user-facing settings.
 *
 * WHY THIS EXISTS. `drawingGeometry` already models four brushes with per-brush
 * opacity, width and pressure defaults, and both the SVG renderer and the PDF
 * exporter derive from those fields. But nothing ever SET them: the canvas called
 * `addDrawing(start, points)` with no overrides, so every stroke came out as the
 * factory default black 2pt pen, and the in-progress preview was hardcoded black
 * as well. The engine was complete and unreachable — which is what "Draw does not
 * feel like a professional tool" actually meant.
 *
 * This module owns the settings state transitions so they are testable without a
 * DOM, and so switching brush applies that brush's sensible defaults exactly once
 * (a marker that keeps the pen's 2pt width is not a marker).
 */

import type { BrushKind, EditorColor, ObjectStyle } from "@/src/domain/editor/objects";
import { DEFAULT_STYLE } from "@/src/domain/editor/objects";
import {
  BRUSH_DEFAULT_PRESSURE,
  BRUSH_DEFAULT_WIDTH,
  BRUSH_OPACITY,
} from "@/src/application/editor/tools/drawingGeometry";

/** Ink black — the default drawing color (matches the object factory's stroke). */
export const DEFAULT_DRAW_COLOR: EditorColor = { r: 0.07, g: 0.09, b: 0.15, a: 1 };

/** Bounds for the width control. */
export const MIN_DRAW_WIDTH = 1;
export const MAX_DRAW_WIDTH = 48;

/** The Draw tool's live settings. */
export interface DrawSettings {
  brush: BrushKind;
  /** Stroke width in page units (pt). */
  width: number;
  /** Stroke color. Alpha carries the user's opacity choice. */
  color: EditorColor;
  /** Whether pressure/velocity width simulation is on. */
  pressure: boolean;
}

/** The settings the tool starts with. */
export const DEFAULT_DRAW_SETTINGS: DrawSettings = {
  brush: "pen",
  width: BRUSH_DEFAULT_WIDTH.pen,
  color: DEFAULT_DRAW_COLOR,
  pressure: BRUSH_DEFAULT_PRESSURE.pen,
};

/**
 * Switches brush, adopting that brush's default width and pressure.
 *
 * The COLOR is deliberately preserved: a user who picked red keeps red when
 * moving from pen to marker. Width and pressure are brush-defining and are reset;
 * carrying a 12pt highlighter width onto the pencil produces a tool that behaves
 * like neither.
 */
export function withBrush(settings: DrawSettings, brush: BrushKind): DrawSettings {
  return {
    ...settings,
    brush,
    width: BRUSH_DEFAULT_WIDTH[brush],
    pressure: BRUSH_DEFAULT_PRESSURE[brush],
  };
}

/** Sets the stroke width, clamped to the supported range. */
export function withWidth(settings: DrawSettings, width: number): DrawSettings {
  if (!Number.isFinite(width)) return settings;
  return { ...settings, width: Math.min(MAX_DRAW_WIDTH, Math.max(MIN_DRAW_WIDTH, width)) };
}

/** Sets the stroke color, preserving the current alpha (opacity is its own control). */
export function withColor(settings: DrawSettings, color: EditorColor): DrawSettings {
  return { ...settings, color: { ...color, a: settings.color.a } };
}

/** Sets stroke opacity (0..1), clamped. */
export function withOpacity(settings: DrawSettings, opacity: number): DrawSettings {
  if (!Number.isFinite(opacity)) return settings;
  const a = Math.min(1, Math.max(0, opacity));
  return { ...settings, color: { ...settings.color, a } };
}

/** Toggles pressure simulation. */
export function withPressure(settings: DrawSettings, pressure: boolean): DrawSettings {
  return { ...settings, pressure };
}

/**
 * The effective opacity a stroke will render at: the user's alpha times the
 * brush's own multiplier. Used by the live preview so what the user sees during
 * the stroke matches what lands on the page.
 */
export function effectiveStrokeOpacity(settings: DrawSettings): number {
  return settings.color.a * BRUSH_OPACITY[settings.brush];
}

/**
 * The `DrawingObject` overrides for a stroke drawn with these settings — the
 * bridge between the control surface and `addDrawing`.
 *
 * `widths` (the per-point pressure profile) is NOT set here: it is derived from
 * the captured pointer samples at stroke end, where the velocity data lives.
 */
export function drawingOverridesFor(settings: DrawSettings): {
  brush: BrushKind;
  smoothing: boolean;
  style: ObjectStyle;
} {
  return {
    brush: settings.brush,
    smoothing: true,
    style: {
      ...DEFAULT_STYLE,
      fill: null,
      stroke: settings.color,
      strokeWidth: settings.width,
    },
  };
}
