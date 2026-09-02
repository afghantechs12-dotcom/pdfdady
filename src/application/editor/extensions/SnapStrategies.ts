import { boundsCenter } from "@/src/domain/editor/geometry";
import type { Bounds, Point } from "@/src/domain/editor/geometry";
import type { IGuideEngine } from "./Extensions";
import type { SnapRequest, SnapResult, SnapStrategy } from "./Snapping";

/**
 * Smart-alignment snap strategies (M4 Part 4).
 *
 * Each strategy below is a self-contained source of snap targets constructed
 * with the context it needs (page size, other objects, a guide engine). A
 * {@link SnapRequest} carries only the live pointer + tolerance, so the
 * strategies close over the rest at construction time and re-read mutable
 * sources (other objects, guides) on every `snap()` call.
 *
 * Snapping is **per-axis**: candidate x and y targets are scored independently.
 * An axis snaps when the pointer is within `threshold` (inclusive) of a target
 * on that axis; the other axis is left unchanged. If neither axis snaps the
 * strategy returns `null` (it has nothing to offer the composite engine). This
 * lets a pointer snap horizontally to a margin while drifting freely vertically,
 * which is the feel users expect from a layout editor.
 */

// ---------------------------------------------------------------------------
// Internal helpers — per-axis scoring shared by every strategy below.
// ---------------------------------------------------------------------------

/** The outcome of scoring one axis against a set of candidate coordinates. */
interface AxisSnap {
  /** The snapped coordinate, or the original pointer coordinate if not snapped. */
  value: number;
  /** `value - pointerCoord` when snapped, else 0. */
  delta: number;
  /** Whether a candidate within `threshold` was found. */
  snapped: boolean;
}

/**
 * Finds the nearest candidate to `pointerCoord` within `threshold` (inclusive).
 * Ties resolve to the first candidate encountered, matching the composite
 * engine's "first registered wins" convention.
 */
function snapAxis(
  pointerCoord: number,
  candidates: readonly number[],
  threshold: number,
): AxisSnap {
  let value = pointerCoord;
  let bestAbs = Infinity;
  let snapped = false;
  for (const candidate of candidates) {
    const abs = Math.abs(candidate - pointerCoord);
    if (abs <= threshold && abs < bestAbs) {
      value = candidate;
      bestAbs = abs;
      snapped = true;
    }
  }
  return { value, delta: snapped ? value - pointerCoord : 0, snapped };
}

/**
 * Scores x and y independently and assembles a {@link SnapResult}. Returns
 * `null` only when neither axis has a candidate within `threshold`; a single
 * snapping axis yields a partial snap (the other delta is 0).
 */
function snapPerAxis(
  pointer: Point,
  xCandidates: readonly number[],
  yCandidates: readonly number[],
  threshold: number,
  source: string,
): SnapResult | null {
  const x = snapAxis(pointer.x, xCandidates, threshold);
  const y = snapAxis(pointer.y, yCandidates, threshold);
  if (!x.snapped && !y.snapped) return null;
  return {
    point: { x: x.value, y: y.value },
    dx: x.delta,
    dy: y.delta,
    active: true,
    source,
  };
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

/**
 * Snaps to the four page edges: x = 0, x = width, y = 0, y = height. Page
 * center is intentionally left to {@link CenterSnapStrategy}. The optional
 * constructor `threshold` overrides `request.threshold` for this strategy only;
 * when omitted the request's tolerance is used.
 */
export class PageSnapStrategy implements SnapStrategy {
  readonly id = "page";

  constructor(
    private readonly pageSize: { width: number; height: number },
    private readonly threshold?: number,
  ) {}

  snap(request: SnapRequest): SnapResult | null {
    const threshold = this.threshold ?? request.threshold;
    const xCandidates = [0, this.pageSize.width];
    const yCandidates = [0, this.pageSize.height];
    return snapPerAxis(request.pointer, xCandidates, yCandidates, threshold, this.id);
  }
}

/** Default page margin in points (0.5"), used when none is supplied. */
const DEFAULT_MARGIN = 36;

/**
 * Snaps to the margin guide lines inset `margin` from each page edge:
 * x = margin, x = width − margin, y = margin, y = height − margin. The margin
 * defaults to 36 points (0.5"). Unlike {@link PageSnapStrategy} this never
 * snaps to the raw page edge at 0 or full width/height.
 */
export class MarginSnapStrategy implements SnapStrategy {
  readonly id = "margin";

  constructor(
    private readonly pageSize: { width: number; height: number },
    private readonly margin: number = DEFAULT_MARGIN,
  ) {}

  snap(request: SnapRequest): SnapResult | null {
    const { width, height } = this.pageSize;
    const m = this.margin;
    const xCandidates = [m, width - m];
    const yCandidates = [m, height - m];
    return snapPerAxis(request.pointer, xCandidates, yCandidates, request.threshold, this.id);
  }
}

/**
 * Snaps to other objects' edges (left/right/top/bottom) and centers
 * (centerX/centerY). Objects whose id appears in `request.draggedIds` are
 * skipped so a dragged object never snaps to itself or its group. The other
 * objects are re-fetched via `getOtherObjects()` on every snap, so moving a
 * non-dragged object between frames is reflected automatically.
 */
export class ObjectSnapStrategy implements SnapStrategy {
  readonly id = "object";

  constructor(
    private readonly getOtherObjects: () => { id: string; bounds: Bounds }[],
  ) {}

  snap(request: SnapRequest): SnapResult | null {
    const dragged = new Set(request.draggedIds);
    const xCandidates: number[] = [];
    const yCandidates: number[] = [];
    for (const obj of this.getOtherObjects()) {
      if (dragged.has(obj.id)) continue;
      const b = obj.bounds;
      xCandidates.push(b.x, b.x + b.width, b.x + b.width / 2);
      yCandidates.push(b.y, b.y + b.height, b.y + b.height / 2);
    }
    return snapPerAxis(request.pointer, xCandidates, yCandidates, request.threshold, this.id);
  }
}

/**
 * Snaps to user-placed guides. Vertical guides contribute x targets (their
 * `position`); horizontal guides contribute y targets. The guide list is read
 * fresh from `guideEngine.list()` on every snap, so newly added or removed
 * guides take effect immediately.
 */
export class GuideSnapStrategy implements SnapStrategy {
  readonly id = "guide";

  constructor(private readonly guideEngine: IGuideEngine) {}

  snap(request: SnapRequest): SnapResult | null {
    const xCandidates: number[] = [];
    const yCandidates: number[] = [];
    for (const guide of this.guideEngine.list()) {
      if (guide.orientation === "vertical") xCandidates.push(guide.position);
      else yCandidates.push(guide.position);
    }
    return snapPerAxis(request.pointer, xCandidates, yCandidates, request.threshold, this.id);
  }
}

/**
 * Snaps to the page center (width/2, height/2) and to the centers of other
 * objects. Objects whose id appears in `request.draggedIds` are skipped. When
 * `getOtherObjects` is omitted only the page center is offered as a target.
 */
export class CenterSnapStrategy implements SnapStrategy {
  readonly id = "center";

  constructor(
    private readonly pageSize: { width: number; height: number },
    private readonly getOtherObjects?: () => { id: string; bounds: Bounds }[],
  ) {}

  snap(request: SnapRequest): SnapResult | null {
    const dragged = new Set(request.draggedIds);
    const xCandidates: number[] = [this.pageSize.width / 2];
    const yCandidates: number[] = [this.pageSize.height / 2];
    if (this.getOtherObjects) {
      for (const obj of this.getOtherObjects()) {
        if (dragged.has(obj.id)) continue;
        const c = boundsCenter(obj.bounds);
        xCandidates.push(c.x);
        yCandidates.push(c.y);
      }
    }
    return snapPerAxis(request.pointer, xCandidates, yCandidates, request.threshold, this.id);
  }
}

// ---------------------------------------------------------------------------
// Default wiring
// ---------------------------------------------------------------------------

/** Context used to wire the five built-in snap strategies. */
export interface DefaultSnapContext {
  /** Page size in editor units. */
  pageSize: { width: number; height: number };
  /** Page margin in points; defaults to 36 (0.5") when omitted. */
  margin?: number;
  /** Returns the other (non-dragged) objects on the active page, with bounds. */
  getOtherObjects: () => { id: string; bounds: Bounds }[];
  /** The guide engine supplying user-placed alignment guides. */
  guideEngine: IGuideEngine;
}

/**
 * Builds the five default snap strategies — page edges, margins, other-object
 * edges/centers, guides, and page/object centers — wired to the given context.
 * Register the returned array with a {@link SnapStrategy} composite (or pass
 * directly to a `CompositeSnapEngine`).
 */
export function createDefaultSnapStrategies(ctx: DefaultSnapContext): SnapStrategy[] {
  return [
    new PageSnapStrategy(ctx.pageSize),
    new MarginSnapStrategy(ctx.pageSize, ctx.margin),
    new ObjectSnapStrategy(ctx.getOtherObjects),
    new GuideSnapStrategy(ctx.guideEngine),
    new CenterSnapStrategy(ctx.pageSize, ctx.getOtherObjects),
  ];
}
