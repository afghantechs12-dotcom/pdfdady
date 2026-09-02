import { describe, expect, it } from "vitest";
import type { Point } from "@/src/domain/editor/geometry";
import {
  ALL_BRUSHES,
  BRUSH_DEFAULT_PRESSURE,
  BRUSH_DEFAULT_WIDTH,
  BRUSH_LABELS,
  BRUSH_OPACITY,
  PENCIL_JITTER_AMPLITUDE,
  deriveDrawingRender,
  jitterPoints,
  pencilJitter,
} from "./drawingGeometry";

const pts: Point[] = [
  { x: 0, y: 0 },
  { x: 10, y: 5 },
  { x: 20, y: 0 },
];

const src = (over: Partial<Parameters<typeof deriveDrawingRender>[0]> = {}) => ({
  points: pts,
  style: { strokeWidth: 2 },
  ...over,
});

describe("brush catalog", () => {
  it("covers all four brushes with opacity/width/pressure defaults and labels", () => {
    expect(ALL_BRUSHES).toEqual(["pen", "marker", "highlighter", "pencil"]);
    for (const b of ALL_BRUSHES) {
      expect(BRUSH_OPACITY[b]).toBeGreaterThan(0);
      expect(BRUSH_DEFAULT_WIDTH[b]).toBeGreaterThan(0);
      expect(typeof BRUSH_DEFAULT_PRESSURE[b]).toBe("boolean");
      expect(BRUSH_LABELS[b].length).toBeGreaterThan(0);
    }
    expect(BRUSH_OPACITY.marker).toBe(0.6);
    expect(BRUSH_OPACITY.highlighter).toBe(0.35);
  });
});

describe("pencilJitter", () => {
  it("is deterministic and bounded in [-0.5, 0.5)", () => {
    for (const i of [0, 1, 2, 17, 999]) {
      const v = pencilJitter(i);
      expect(v).toBe(pencilJitter(i));
      expect(v).toBeGreaterThanOrEqual(-0.5);
      expect(v).toBeLessThan(0.5);
    }
  });

  it("jitterPoints offsets each point by at most the amplitude/2 per axis", () => {
    const out = jitterPoints(pts);
    expect(out).toHaveLength(pts.length);
    out.forEach((p, i) => {
      expect(Math.abs(p.x - pts[i].x)).toBeLessThanOrEqual(PENCIL_JITTER_AMPLITUDE / 2);
      expect(Math.abs(p.y - pts[i].y)).toBeLessThanOrEqual(PENCIL_JITTER_AMPLITUDE / 2);
    });
    // Deterministic.
    expect(jitterPoints(pts)).toEqual(out);
  });
});

describe("deriveDrawingRender: modes", () => {
  it("plain pen stroke → stroke mode polyline with the style width", () => {
    const spec = deriveDrawingRender(src());
    expect(spec.mode).toBe("stroke");
    expect(spec.pathData).toBe("M 0 0 L 10 5 L 20 0");
    expect(spec.strokeWidth).toBe(2);
    expect(spec.opacityFactor).toBe(1);
    expect(spec.blendMultiply).toBe(false);
  });

  it("smoothing swaps the polyline for Catmull-Rom cubics", () => {
    const spec = deriveDrawingRender(src({ smoothing: true }));
    expect(spec.mode).toBe("stroke");
    expect(spec.pathData).toContain("C");
    expect(spec.pathData.startsWith("M 0 0")).toBe(true);
  });

  it("pressure widths switch to fill mode with a closed outline", () => {
    const spec = deriveDrawingRender(src({ widths: [2, 4, 2] }));
    expect(spec.mode).toBe("fill");
    expect(spec.pathData.endsWith("Z")).toBe(true);
    expect(spec.strokeWidth).toBe(0);
  });

  it("pressure + smoothing produces a (denser) closed outline", () => {
    const plain = deriveDrawingRender(src({ widths: [2, 4, 2] }));
    const smooth = deriveDrawingRender(src({ widths: [2, 4, 2], smoothing: true }));
    expect(smooth.mode).toBe("fill");
    expect(smooth.pathData.endsWith("Z")).toBe(true);
    // The smoothed centerline is resampled → more outline vertices.
    expect((smooth.pathData.match(/L/g) ?? []).length).toBeGreaterThan(
      (plain.pathData.match(/L/g) ?? []).length,
    );
  });

  it("degenerate pressure stroke (identical points) falls back to stroke mode", () => {
    const spec = deriveDrawingRender({
      points: [{ x: 5, y: 5 }, { x: 5, y: 5 }],
      style: { strokeWidth: 3 },
      widths: [3, 3],
    });
    expect(spec.mode).toBe("stroke");
  });
});

describe("deriveDrawingRender: brushes", () => {
  it("marker renders at 60% opacity, no blend", () => {
    const spec = deriveDrawingRender(src({ brush: "marker" }));
    expect(spec.opacityFactor).toBe(0.6);
    expect(spec.blendMultiply).toBe(false);
  });

  it("highlighter renders at 35% opacity with multiply blend", () => {
    const spec = deriveDrawingRender(src({ brush: "highlighter" }));
    expect(spec.opacityFactor).toBe(0.35);
    expect(spec.blendMultiply).toBe(true);
  });

  it("pencil applies the deterministic jitter to its path", () => {
    const spec = deriveDrawingRender(src({ brush: "pencil" }));
    const again = deriveDrawingRender(src({ brush: "pencil" }));
    expect(spec.pathData).toBe(again.pathData); // deterministic
    expect(spec.pathData).not.toBe("M 0 0 L 10 5 L 20 0"); // jittered
  });

  it("a zero/absent stroke width falls back to the brush default", () => {
    const spec = deriveDrawingRender({ points: pts, style: { strokeWidth: 0 }, brush: "marker" });
    expect(spec.strokeWidth).toBe(BRUSH_DEFAULT_WIDTH.marker);
  });

  it("an old stroke (no brush fields) renders exactly as before M6", () => {
    // brush undefined → pen, smoothing undefined → raw polyline, widths
    // undefined → stroke mode: byte-identical to the pre-v6 render contract.
    const spec = deriveDrawingRender({ points: pts, style: { strokeWidth: 2 } });
    expect(spec).toEqual({
      mode: "stroke",
      pathData: "M 0 0 L 10 5 L 20 0",
      strokeWidth: 2,
      opacityFactor: 1,
      blendMultiply: false,
    });
  });
});
