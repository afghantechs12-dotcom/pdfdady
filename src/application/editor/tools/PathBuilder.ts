import type { Bounds, Point } from "@/src/domain/editor/geometry";
import { normalizePathData, pathDataBounds } from "@/src/domain/editor/shapeGeometry";

/**
 * The pure interaction state machine for the bezier/path creation tool (M6).
 *
 * The canvas drives it with pointer events; the machine is a plain immutable
 * value, so every transition is a pure function (Node-testable, no DOM):
 *
 *  - {@link addAnchor}(point): click places an anchor (straight corner).
 *  - {@link dragHandle}(point): dragging after placing pulls the anchor's OUT
 *    handle to the pointer; the IN handle mirrors it (symmetric pen-tool
 *    behavior), turning the corner smooth.
 *  - {@link commit}: Enter/double-click builds the final path — cubic segments
 *    where handles exist, straight lines otherwise — normalizes it into local
 *    coordinates (tight bounds at (0,0)) and reports the page-space placement.
 *    Bounds are computed from the EXACT Bézier extrema (via
 *    `shapeGeometry.pathDataBounds`), not sampling, so a bulging curve never
 *    overflows its box.
 *  - Escape (the canvas simply drops the state) cancels.
 *
 * Coordinates fed to the builder are PAGE-space points; commit converts to
 * the object-local convention.
 */

/** One placed anchor. `handleOut === null` means a corner (straight segment). */
export interface PathAnchor {
  point: Point;
  /** The outgoing control point (page space), or null for a corner anchor. */
  handleOut: Point | null;
}

/** The immutable builder state. */
export interface PathBuilderState {
  anchors: PathAnchor[];
}

/** A fresh, empty builder. */
export function createPathBuilder(): PathBuilderState {
  return { anchors: [] };
}

/** Adds an anchor at `point` (a corner until a handle is dragged out). */
export function addAnchor(state: PathBuilderState, point: Point): PathBuilderState {
  return { anchors: [...state.anchors, { point, handleOut: null }] };
}

/**
 * Drags the LAST anchor's out-handle to `point` (called on pointer-move while
 * the placing press is still down). A no-op when no anchor exists. Dragging
 * back onto the anchor itself (< 1 unit) clears the handle — the anchor
 * becomes a corner again.
 */
export function dragHandle(state: PathBuilderState, point: Point): PathBuilderState {
  if (state.anchors.length === 0) return state;
  const last = state.anchors[state.anchors.length - 1];
  const dist = Math.hypot(point.x - last.point.x, point.y - last.point.y);
  const handleOut = dist < 1 ? null : point;
  return { anchors: [...state.anchors.slice(0, -1), { ...last, handleOut }] };
}

const fmt = (n: number): string => {
  const r = Math.round(n * 1000) / 1000;
  return String(r === 0 ? 0 : r);
};

/** The mirror of an anchor's out-handle about its point (the implicit in-handle). */
function handleIn(anchor: PathAnchor): Point | null {
  if (!anchor.handleOut) return null;
  return {
    x: 2 * anchor.point.x - anchor.handleOut.x,
    y: 2 * anchor.point.y - anchor.handleOut.y,
  };
}

/**
 * The path data (PAGE coordinates) for the current anchors — also used by the
 * canvas to draw the live preview. Segments between anchors A → B:
 *  - both corners → `L`
 *  - any handle → `C` with c1 = A.handleOut (or A.point) and
 *    c2 = mirror of B.handleOut (or B.point).
 */
export function previewPathData(state: PathBuilderState): string {
  const a = state.anchors;
  if (a.length === 0) return "";
  const parts = [`M ${fmt(a[0].point.x)} ${fmt(a[0].point.y)}`];
  for (let i = 1; i < a.length; i++) {
    const prev = a[i - 1];
    const next = a[i];
    const inHandle = handleIn(next);
    if (!prev.handleOut && !inHandle) {
      parts.push(`L ${fmt(next.point.x)} ${fmt(next.point.y)}`);
    } else {
      const c1 = prev.handleOut ?? prev.point;
      const c2 = inHandle ?? next.point;
      parts.push(
        `C ${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(next.point.x)} ${fmt(next.point.y)}`,
      );
    }
  }
  return parts.join(" ");
}

/** The result of committing a path: local geometry + page placement. */
export interface CommittedPath {
  /** Normalized path data in LOCAL coordinates (tight bounds at (0,0)). */
  pathData: string;
  /** The local bounds (x/y always 0; tight width/height, min 1). */
  localBounds: Bounds;
  /** The page-space position of the local origin (the tight bounds' top-left). */
  position: Point;
}

/**
 * Removes the most recent unfinished anchor (Backspace/Delete during
 * creation). Returns null when nothing remains — the canvas cancels the
 * whole interaction.
 */
export function removeLastAnchor(state: PathBuilderState): PathBuilderState | null {
  if (state.anchors.length <= 1) return null;
  return { anchors: state.anchors.slice(0, -1) };
}

/**
 * Collapses consecutive corner anchors that sit on (or within 0.01 of) the
 * same point. A double-click finish places two anchors at the same location —
 * without this the committed path would carry a zero-length trailing segment.
 * Anchors with a dragged-out handle are never collapsed (the handle is
 * meaningful even at the same point).
 */
export function dedupeAnchors(state: PathBuilderState): PathBuilderState {
  const out: PathAnchor[] = [];
  for (const a of state.anchors) {
    const prev = out[out.length - 1];
    if (
      prev &&
      !prev.handleOut &&
      !a.handleOut &&
      Math.abs(a.point.x - prev.point.x) < 0.01 &&
      Math.abs(a.point.y - prev.point.y) < 0.01
    ) {
      continue;
    }
    out.push(a);
  }
  return out.length === state.anchors.length ? state : { anchors: out };
}

/**
 * Commits the path. Returns null when fewer than 2 distinct anchors exist
 * (nothing to create — the canvas cancels). Bounds come from the exact Bézier
 * extrema.
 */
export function commit(state: PathBuilderState): CommittedPath | null {
  const deduped = dedupeAnchors(state);
  if (deduped.anchors.length < 2) return null;
  const pagePath = previewPathData(deduped);
  const pageBounds = pathDataBounds(pagePath);
  if (!pageBounds) return null;
  const { pathData, width, height } = normalizePathData(pagePath);
  return {
    pathData,
    localBounds: { x: 0, y: 0, width, height },
    position: { x: pageBounds.x, y: pageBounds.y },
  };
}
