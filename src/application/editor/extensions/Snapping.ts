import type { Point } from "@/src/domain/editor/geometry";

/**
 * Snapping — the first real extension point (Part 6 infrastructure).
 *
 * A {@link SnapStrategy} answers "should this pointer snap, and to where?" for a
 * single source of snap targets (a grid, guides, object edges, page margins).
 * The {@link ISnapEngine} combines every registered strategy and returns the
 * closest snap within `threshold`; if none, the pointer is returned unchanged.
 *
 * Plugins register strategies through the plugin API (see [[plugins]]). The
 * default engine is a no-op so the editor works without any snapping, and a
 * {@link GridSnapStrategy} ships as a ready-made, testable default.
 */

/** A request to snap a pointer position during a drag. */
export interface SnapRequest {
  /** The current pointer position in page space. */
  pointer: Point;
  /** The ids of the objects being dragged (so strategies can ignore their own edges). */
  draggedIds: string[];
  /** Snap tolerance in page units; a candidate within this distance snaps. */
  threshold: number;
  /** Current zoom factor (strategies may scale tolerance with zoom). */
  zoom: number;
}

/** The outcome of a snap attempt. */
export interface SnapResult {
  /** The snapped pointer position (or the original if `active` is false). */
  point: Point;
  /** The delta applied to reach `point` from the requested pointer. */
  dx: number;
  dy: number;
  /** Whether snapping actually occurred. */
  active: boolean;
  /** Which strategy produced the snap (for UI highlight); "" when inactive. */
  source: string;
}

/** A single source of snap targets. Returns null when it has no snap to offer. */
export interface SnapStrategy {
  readonly id: string;
  snap(request: SnapRequest): SnapResult | null;
}

/** A snap result that leaves the pointer unchanged. */
export function unsnapped(pointer: Point): SnapResult {
  return { point: pointer, dx: 0, dy: 0, active: false, source: "" };
}

/** A no-op engine: never snaps. The default when no strategies are registered. */
export class NoopSnapEngine implements ISnapEngine {
  snap(request: SnapRequest): SnapResult {
    return unsnapped(request.pointer);
  }
}

/** The snap engine port: combines strategies and returns the closest snap. */
export interface ISnapEngine {
  snap(request: SnapRequest): SnapResult;
}

/**
 * Combines registered strategies, runs them all, and returns the snap with the
 * smallest distance to the pointer (within `threshold`). Ties go to the first
 * strategy registered. If no strategy snaps, the pointer is returned unchanged.
 */
export class CompositeSnapEngine implements ISnapEngine {
  constructor(private readonly strategies: SnapStrategy[] = []) {}

  snap(request: SnapRequest): SnapResult {
    let best: SnapResult | null = null;
    let bestDist = request.threshold;
    for (const strategy of this.strategies) {
      const result = strategy.snap(request);
      if (!result || !result.active) continue;
      const dist = Math.hypot(result.dx, result.dy);
      if (dist <= bestDist) {
        best = result;
        bestDist = dist;
      }
    }
    return best ?? unsnapped(request.pointer);
  }
}

/**
 * Snaps the pointer to the nearest intersection of a fixed-size grid. The grid
 * origin is (0, 0) by default; `offset` shifts it. This is the ready-made
 * default strategy — a plugin can register it or supply its own.
 */
export class GridSnapStrategy implements SnapStrategy {
  readonly id = "grid";

  constructor(
    private readonly gridSize: number,
    private readonly offset: Point = { x: 0, y: 0 },
  ) {
    if (gridSize <= 0) throw new Error("GridSnapStrategy requires a positive gridSize.");
  }

  snap(request: SnapRequest): SnapResult | null {
    const { pointer, threshold } = request;
    const targetX = Math.round((pointer.x - this.offset.x) / this.gridSize) * this.gridSize + this.offset.x;
    const targetY = Math.round((pointer.y - this.offset.y) / this.gridSize) * this.gridSize + this.offset.y;
    const dx = targetX - pointer.x;
    const dy = targetY - pointer.y;
    if (Math.abs(dx) > threshold || Math.abs(dy) > threshold) return null;
    return { point: { x: targetX, y: targetY }, dx, dy, active: true, source: this.id };
  }
}
