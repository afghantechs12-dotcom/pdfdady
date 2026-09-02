import { describe, expect, it } from "vitest";
import { makeTranslate } from "./geometry";
import {
  ALL_SHAPE_KINDS,
  DEFAULT_INNER_RATIO,
  DEFAULT_POLYGON_SIDES,
  DEFAULT_STAR_POINTS,
  SHAPE_KIND_LABELS,
  arrowPath,
  circlePath,
  clampHeadSize,
  clampInnerRatio,
  clampSides,
  clampStarPoints,
  clampTailPosition,
  connectorPath,
  ellipsePath,
  isClosedShape,
  linePath,
  normalizePathData,
  parsePathData,
  pathDataBounds,
  polygonPath,
  polygonVertices,
  rectPath,
  roundedRectPath,
  serializePathData,
  shapePathData,
  speechBubblePath,
  starPath,
  starVertices,
  transformPathData,
  trianglePath,
} from "./shapeGeometry";

/** Counts occurrences of a command letter in path data. */
function count(d: string, cmd: string): number {
  return (d.match(new RegExp(cmd, "g")) ?? []).length;
}

describe("parameter clamping", () => {
  it("clamps polygon sides to [3, 12] with default 6", () => {
    expect(clampSides(undefined)).toBe(DEFAULT_POLYGON_SIDES);
    expect(clampSides(NaN)).toBe(DEFAULT_POLYGON_SIDES);
    expect(clampSides(2)).toBe(3);
    expect(clampSides(99)).toBe(12);
    expect(clampSides(7.4)).toBe(7);
  });

  it("clamps star points to [4, 12] with default 5", () => {
    expect(clampStarPoints(undefined)).toBe(DEFAULT_STAR_POINTS);
    expect(clampStarPoints(1)).toBe(4);
    expect(clampStarPoints(50)).toBe(12);
  });

  it("clamps inner ratio to [0.1, 0.9] with default 0.5", () => {
    expect(clampInnerRatio(undefined)).toBe(DEFAULT_INNER_RATIO);
    expect(clampInnerRatio(0)).toBe(0.1);
    expect(clampInnerRatio(1.5)).toBe(0.9);
  });

  it("clamps head size to [2, max] with default 16", () => {
    expect(clampHeadSize(undefined, 100)).toBe(16);
    expect(clampHeadSize(0, 100)).toBe(2);
    expect(clampHeadSize(500, 40)).toBe(40);
  });

  it("clamps tail position to [0.05, 0.95] with default 0.3", () => {
    expect(clampTailPosition(undefined)).toBe(0.3);
    expect(clampTailPosition(-2)).toBe(0.05);
    expect(clampTailPosition(2)).toBe(0.95);
  });
});

describe("path builders: structure", () => {
  it("every closed builder starts with M and ends with Z", () => {
    const closed = [
      rectPath(100, 60),
      roundedRectPath(100, 60, 10),
      ellipsePath(100, 60),
      circlePath(100, 60),
      trianglePath(100, 60),
      arrowPath(100, 60, 16, "triangle"),
      polygonPath(100, 60, 6),
      starPath(100, 60, 5, 0.5),
      speechBubblePath(100, 60, 0.3),
    ];
    for (const d of closed) {
      expect(d.startsWith("M ")).toBe(true);
      expect(d.trimEnd().endsWith("Z")).toBe(true);
    }
  });

  it("open builders start with M and have no Z", () => {
    const open = [
      linePath(100, 60),
      arrowPath(100, 60, 16, "open"),
      connectorPath(100, 60, "straight"),
      connectorPath(100, 60, "elbow", { endArrow: true }),
    ];
    for (const d of open) {
      expect(d.startsWith("M ")).toBe(true);
      expect(d).not.toContain("Z");
    }
  });

  it("rounded rect with radius 0 degenerates to a plain rect", () => {
    expect(roundedRectPath(100, 60, 0)).toBe(rectPath(100, 60));
  });

  it("rounded rect clamps the radius to half the short side", () => {
    // radius 1000 on a 100x60 box clamps to 30 — the path must stay in-bounds.
    const b = pathDataBounds(roundedRectPath(100, 60, 1000))!;
    expect(b.x).toBeCloseTo(0, 3);
    expect(b.y).toBeCloseTo(0, 3);
    expect(b.width).toBeCloseTo(100, 3);
    expect(b.height).toBeCloseTo(60, 3);
  });
});

describe("polygon + star vertices", () => {
  it("regular polygon has the requested vertex count, first vertex at the top", () => {
    const v = polygonVertices(100, 100, 5);
    expect(v).toHaveLength(5);
    expect(v[0].x).toBeCloseTo(50, 6);
    expect(v[0].y).toBeCloseTo(0, 6);
  });

  it("polygon path has n line commands plus closing Z", () => {
    const d = polygonPath(100, 100, 8);
    expect(count(d, "L")).toBe(7); // n-1 L commands after the M
    expect(count(d, "M")).toBe(1);
    expect(d.endsWith("Z")).toBe(true);
  });

  it("explicit legacy points (>= 3) win over the regular n-gon", () => {
    const d = polygonPath(100, 100, 6, [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
    expect(d).toBe("M 0 0 L 10 0 L 10 10 Z");
  });

  it("star has 2n vertices alternating outer/inner radius", () => {
    const v = starVertices(200, 200, 5, 0.5);
    expect(v).toHaveLength(10);
    const cx = 100;
    const cy = 100;
    const radii = v.map((p) => Math.hypot(p.x - cx, p.y - cy));
    for (let i = 0; i < radii.length; i++) {
      expect(radii[i]).toBeCloseTo(i % 2 === 0 ? 100 : 50, 6);
    }
  });

  it("star is left-right symmetric about the vertical center line", () => {
    const v = starVertices(200, 200, 5, 0.5);
    // For every vertex there is a mirror vertex at (200 - x, same y).
    for (const p of v) {
      const mirror = v.find(
        (q) => Math.abs(q.x - (200 - p.x)) < 1e-6 && Math.abs(q.y - p.y) < 1e-6,
      );
      expect(mirror).toBeDefined();
    }
  });

  it("polygon is symmetric about the vertical center for even side counts", () => {
    const v = polygonVertices(100, 100, 6);
    for (const p of v) {
      const mirror = v.find(
        (q) => Math.abs(q.x - (100 - p.x)) < 1e-6 && Math.abs(q.y - p.y) < 1e-6,
      );
      expect(mirror).toBeDefined();
    }
  });
});

describe("arrow", () => {
  it("triangle arrow is a closed 7-vertex polygon with the tip at (w, h/2)", () => {
    const d = arrowPath(100, 40, 20, "triangle");
    expect(count(d, "L")).toBe(6);
    expect(d).toContain("L 100 20");
    expect(d.endsWith("Z")).toBe(true);
  });

  it("open arrow is two subpaths: shaft + head strokes", () => {
    const d = arrowPath(100, 40, 20, "open");
    expect(count(d, "M")).toBe(2);
    expect(d).not.toContain("Z");
  });

  it("head size is clamped so the shaft never goes negative", () => {
    const b = pathDataBounds(arrowPath(20, 40, 500, "triangle"))!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.width).toBeLessThanOrEqual(20 + 1e-6);
  });
});

describe("connector", () => {
  it("straight connector runs TL→BR by default", () => {
    expect(connectorPath(100, 50, "straight")).toBe("M 0 0 L 100 50");
  });

  it("elbow connector routes through the mid-x with two bends", () => {
    const d = connectorPath(100, 50, "elbow");
    expect(d).toBe("M 0 0 L 50 0 L 50 50 L 100 50");
  });

  it("end arrow adds an open V subpath at the end point", () => {
    const d = connectorPath(100, 0, "straight", { endArrow: true, headSize: 10 });
    expect(count(d, "M")).toBe(2);
    // The barbs meet at the end point (100, 0).
    expect(d).toContain("L 100 0");
  });

  it("start + end arrows add two head subpaths", () => {
    const d = connectorPath(100, 0, "straight", { startArrow: true, endArrow: true, headSize: 10 });
    expect(count(d, "M")).toBe(3);
  });

  it("explicit endpoints override the box diagonal", () => {
    const d = connectorPath(100, 50, "straight", {
      points: [
        { x: 5, y: 40 },
        { x: 90, y: 10 },
      ],
    });
    expect(d.startsWith("M 5 40 L 90 10")).toBe(true);
  });
});

describe("speech bubble", () => {
  it("stays inside its box and reaches the bottom at the tail tip", () => {
    const d = speechBubblePath(120, 80, 0.3);
    const b = pathDataBounds(d)!;
    expect(b.x).toBeCloseTo(0, 3);
    expect(b.y).toBeCloseTo(0, 3);
    expect(b.width).toBeCloseTo(120, 3);
    expect(b.height).toBeCloseTo(80, 3);
    // The tail tip lands at x = tailPosition * w on the bottom edge.
    expect(d).toContain(`L 36 80`);
  });

  it("clamps the tail position into the straight bottom span", () => {
    const d = speechBubblePath(120, 80, 5); // way out of range → 0.95
    const b = pathDataBounds(d)!;
    expect(b.width).toBeLessThanOrEqual(120 + 1e-6);
  });
});

describe("path data toolkit", () => {
  it("parses and re-serializes M/L/C/Q/Z round-trip", () => {
    const d = "M 0 0 L 10 0 Q 15 5 10 10 C 5 15 0 15 0 10 Z";
    expect(serializePathData(parsePathData(d))).toBe(d);
  });

  it("skips malformed segments instead of throwing", () => {
    expect(parsePathData("garbage")).toEqual([]);
    expect(parsePathData("")).toEqual([]);
    const partial = parsePathData("M 0 0 L 10"); // dangling L → dropped
    expect(partial).toEqual([{ cmd: "M", x: 0, y: 0 }]);
  });

  it("transformPathData maps every coordinate including control points", () => {
    const d = "M 0 0 Q 10 0 10 10";
    const out = transformPathData(d, makeTranslate(5, 7));
    expect(out).toBe("M 5 7 Q 15 7 15 17");
  });

  it("pathDataBounds uses exact cubic extrema (bulge beyond anchors)", () => {
    // A cubic from (0,0) to (10,0) with control points pulling up to y=-7.5
    // at t=0.5: B_y(0.5) = 3/8*(-10)*2*... exact: y(t)= 3t(1-t)^2*(-10)+3t^2(1-t)*(-10)
    // max deviation at t=0.5 → y = -7.5.
    const d = "M 0 0 C 0 -10 10 -10 10 0";
    const b = pathDataBounds(d)!;
    expect(b.y).toBeCloseTo(-7.5, 6);
    expect(b.height).toBeCloseTo(7.5, 6);
    expect(b.width).toBeCloseTo(10, 6);
  });

  it("pathDataBounds handles quadratic extrema exactly", () => {
    // Q control at (5, -10): apex y = -5 at t = 0.5.
    const b = pathDataBounds("M 0 0 Q 5 -10 10 0")!;
    expect(b.y).toBeCloseTo(-5, 6);
  });

  it("normalizePathData shifts the tight bounds to (0,0)", () => {
    const { pathData, width, height } = normalizePathData("M 10 20 L 30 50");
    expect(pathData).toBe("M 0 0 L 20 30");
    expect(width).toBe(20);
    expect(height).toBe(30);
  });

  it("normalizePathData yields a placeholder for empty/invalid data", () => {
    expect(normalizePathData("")).toEqual({ pathData: "M 0 0", width: 1, height: 1 });
  });
});

describe("shapePathData: the canonical entry", () => {
  const bounds = { width: 100, height: 60 };

  it("produces a non-empty path for every kind", () => {
    for (const shape of ALL_SHAPE_KINDS) {
      const d = shapePathData({ shape, localBounds: bounds, pathData: "M 0 0 L 10 10" });
      expect(d.startsWith("M")).toBe(true);
    }
  });

  it("every kind's path stays within (or on) its local bounds box", () => {
    for (const shape of ALL_SHAPE_KINDS) {
      if (shape === "bezier" || shape === "path") continue; // bounds come from pathData
      const b = pathDataBounds(shapePathData({ shape, localBounds: bounds }))!;
      expect(b.x).toBeGreaterThanOrEqual(-1e-6);
      expect(b.y).toBeGreaterThanOrEqual(-1e-6);
      expect(b.x + b.width).toBeLessThanOrEqual(bounds.width + 1e-6);
      expect(b.y + b.height).toBeLessThanOrEqual(bounds.height + 1e-6);
    }
  });

  it("rect honors style.cornerRadius (curves appear only when radius > 0)", () => {
    const square = shapePathData({ shape: "rect", localBounds: bounds, style: { cornerRadius: 0 } });
    const rounded = shapePathData({ shape: "rect", localBounds: bounds, style: { cornerRadius: 8 } });
    expect(square).not.toContain("C");
    expect(rounded).toContain("C");
  });

  it("circle inscribes a true circle of diameter min(w, h)", () => {
    const b = pathDataBounds(shapePathData({ shape: "circle", localBounds: bounds }))!;
    expect(b.width).toBeCloseTo(60, 3);
    expect(b.height).toBeCloseTo(60, 3);
    // Centered: left margin = (100-60)/2 = 20.
    expect(b.x).toBeCloseTo(20, 3);
  });

  it("bezier/path kinds return the stored pathData (placeholder when absent)", () => {
    expect(shapePathData({ shape: "bezier", localBounds: bounds, pathData: "M 0 0 C 1 1 2 2 3 3" })).toBe(
      "M 0 0 C 1 1 2 2 3 3",
    );
    expect(shapePathData({ shape: "path", localBounds: bounds })).toBe("M 0 0");
  });

  it("connector defaults: no start arrow, end arrow present", () => {
    const d = shapePathData({ shape: "connector", localBounds: bounds });
    expect(count(d, "M")).toBe(2); // line + one head
  });
});

describe("isClosedShape", () => {
  it("classifies fillable vs stroke-only kinds", () => {
    expect(isClosedShape("rect")).toBe(true);
    expect(isClosedShape("star")).toBe(true);
    expect(isClosedShape("speechBubble")).toBe(true);
    expect(isClosedShape("line")).toBe(false);
    expect(isClosedShape("connector")).toBe(false);
    expect(isClosedShape("bezier")).toBe(false);
    expect(isClosedShape("path")).toBe(false);
    expect(isClosedShape("arrow", "triangle")).toBe(true);
    expect(isClosedShape("arrow", "open")).toBe(false);
  });
});

describe("kind catalog", () => {
  it("lists all 13 kinds with labels", () => {
    expect(ALL_SHAPE_KINDS).toHaveLength(13);
    for (const kind of ALL_SHAPE_KINDS) {
      expect(SHAPE_KIND_LABELS[kind].length).toBeGreaterThan(0);
    }
  });
});
