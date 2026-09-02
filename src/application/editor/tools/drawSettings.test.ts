import { describe, expect, it } from "vitest";

import {
  DEFAULT_DRAW_SETTINGS,
  MAX_DRAW_WIDTH,
  MIN_DRAW_WIDTH,
  drawingOverridesFor,
  effectiveStrokeOpacity,
  withBrush,
  withColor,
  withOpacity,
  withPressure,
  withWidth,
} from "@/src/application/editor/tools/drawSettings";
import {
  BRUSH_DEFAULT_PRESSURE,
  BRUSH_DEFAULT_WIDTH,
  BRUSH_OPACITY,
} from "@/src/application/editor/tools/drawingGeometry";

const RED = { r: 1, g: 0, b: 0, a: 1 };

describe("DEFAULT_DRAW_SETTINGS", () => {
  it("starts as a pen with the pen's own defaults", () => {
    expect(DEFAULT_DRAW_SETTINGS.brush).toBe("pen");
    expect(DEFAULT_DRAW_SETTINGS.width).toBe(BRUSH_DEFAULT_WIDTH.pen);
    expect(DEFAULT_DRAW_SETTINGS.pressure).toBe(BRUSH_DEFAULT_PRESSURE.pen);
  });
});

describe("withBrush", () => {
  it("adopts the new brush's default width and pressure", () => {
    const marker = withBrush(DEFAULT_DRAW_SETTINGS, "marker");
    expect(marker.brush).toBe("marker");
    expect(marker.width).toBe(BRUSH_DEFAULT_WIDTH.marker);
    expect(marker.pressure).toBe(BRUSH_DEFAULT_PRESSURE.marker);
  });

  it("preserves the user's chosen color across a brush switch", () => {
    const red = withColor(DEFAULT_DRAW_SETTINGS, RED);
    const asHighlighter = withBrush(red, "highlighter");
    expect(asHighlighter.color.r).toBe(1);
    expect(asHighlighter.color.g).toBe(0);
  });

  it("does not carry a previous brush's width onto the next", () => {
    const wide = withWidth(withBrush(DEFAULT_DRAW_SETTINGS, "highlighter"), 40);
    const pencil = withBrush(wide, "pencil");
    expect(pencil.width).toBe(BRUSH_DEFAULT_WIDTH.pencil);
  });
});

describe("withWidth", () => {
  it("clamps to the supported range", () => {
    expect(withWidth(DEFAULT_DRAW_SETTINGS, 0).width).toBe(MIN_DRAW_WIDTH);
    expect(withWidth(DEFAULT_DRAW_SETTINGS, -10).width).toBe(MIN_DRAW_WIDTH);
    expect(withWidth(DEFAULT_DRAW_SETTINGS, 9999).width).toBe(MAX_DRAW_WIDTH);
  });

  it("ignores a non-finite width rather than corrupting the settings", () => {
    expect(withWidth(DEFAULT_DRAW_SETTINGS, Number.NaN)).toEqual(DEFAULT_DRAW_SETTINGS);
  });
});

describe("withColor / withOpacity", () => {
  it("changing color preserves the current opacity", () => {
    const faded = withOpacity(DEFAULT_DRAW_SETTINGS, 0.5);
    const recolored = withColor(faded, RED);
    expect(recolored.color.a).toBe(0.5);
    expect(recolored.color.r).toBe(1);
  });

  it("clamps opacity into 0..1", () => {
    expect(withOpacity(DEFAULT_DRAW_SETTINGS, 2).color.a).toBe(1);
    expect(withOpacity(DEFAULT_DRAW_SETTINGS, -1).color.a).toBe(0);
  });
});

describe("withPressure", () => {
  it("toggles pressure simulation", () => {
    expect(withPressure(DEFAULT_DRAW_SETTINGS, false).pressure).toBe(false);
    expect(withPressure(DEFAULT_DRAW_SETTINGS, true).pressure).toBe(true);
  });
});

describe("effectiveStrokeOpacity", () => {
  it("combines the user's alpha with the brush multiplier", () => {
    const marker = withBrush(DEFAULT_DRAW_SETTINGS, "marker");
    expect(effectiveStrokeOpacity(marker)).toBeCloseTo(BRUSH_OPACITY.marker, 5);
    expect(effectiveStrokeOpacity(withOpacity(marker, 0.5))).toBeCloseTo(
      0.5 * BRUSH_OPACITY.marker,
      5,
    );
  });
});

describe("drawingOverridesFor", () => {
  it("carries brush, color and width into the created object", () => {
    const settings = withWidth(withColor(withBrush(DEFAULT_DRAW_SETTINGS, "marker"), RED), 10);
    const o = drawingOverridesFor(settings);
    expect(o.brush).toBe("marker");
    expect(o.style.strokeWidth).toBe(10);
    expect(o.style.stroke).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(o.style.fill).toBeNull();
  });

  it("produces a complete ObjectStyle (cornerRadius included)", () => {
    const o = drawingOverridesFor(DEFAULT_DRAW_SETTINGS);
    expect(o.style.cornerRadius).toBeTypeOf("number");
  });
});
