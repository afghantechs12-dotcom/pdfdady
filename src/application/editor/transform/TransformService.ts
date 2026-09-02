import {
  type AffineTransform,
  type Bounds,
  type Point,
  type Vec2,
} from "@/src/domain/editor/geometry";
import {
  compose,
  decompose,
  makeRotate,
  makeScale,
  makeTranslate,
  sub,
  transformPoint,
} from "@/src/domain/editor/geometry";
import type { EditorObject } from "@/src/domain/editor/objects";
import {
  captureTransforms,
  TransformObjectsCommand,
} from "../commands/commands";
import { hasFixedAspectByDefault } from "./aspectConstraint";
import type { EditorState } from "@/src/domain/editor/document";
import { getActivePage, getObject } from "@/src/domain/editor/document";

/**
 * The transformation model for the editor: move, rotate, resize, and flip as
 * pure functions over an object's {@link AffineTransform}. Each returns the new
 * transform (or a map of id → transform); the command builders wrap a batch of
 * those into a single coalesceable {@link TransformObjectsCommand} for undo.
 *
 * Resize is the subtle one. It keeps the handle opposite the dragged one fixed
 * and solves for the new scale by projecting the drag vector onto the object's
 * local axes (so it stays correct when the object is rotated). Edge handles
 * scale only one axis; corner handles scale both. The construction is
 *   newT = translate(fixedWorld) · scale(nsx, nsy) · rotate(θ) · translate(−fLocal)
 * which pins `fLocal` to `fixedWorld` and lands the dragged handle at the target.
 */

/** The eight resize handles of a selection box. */
export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** A handle's position as a fraction of the object's local width/height. */
const HANDLE_FRACTIONS: Record<ResizeHandle, { hx: number; hy: number }> = {
  nw: { hx: 0, hy: 0 },
  n: { hx: 0.5, hy: 0 },
  ne: { hx: 1, hy: 0 },
  e: { hx: 1, hy: 0.5 },
  se: { hx: 1, hy: 1 },
  s: { hx: 0.5, hy: 1 },
  sw: { hx: 0, hy: 1 },
  w: { hx: 0, hy: 0.5 },
};

/** Returns the handle opposite `h` (nw↔se, n↔s, …). */
export function oppositeHandle(h: ResizeHandle): ResizeHandle {
  const { hx, hy } = HANDLE_FRACTIONS[h];
  const ox = 1 - hx;
  const oy = 1 - hy;
  return (Object.keys(HANDLE_FRACTIONS) as ResizeHandle[]).find(
    (key) => HANDLE_FRACTIONS[key].hx === ox && HANDLE_FRACTIONS[key].hy === oy,
  )!;
}

/** Rotates a vector by `radians`. */
function rotateVector(v: Vec2, radians: number): Vec2 {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: cos * v.x - sin * v.y, y: sin * v.x + cos * v.y };
}

/** Translates a transform by a page-space delta (move). */
export function moveObject(obj: EditorObject, delta: Vec2): AffineTransform {
  return compose(makeTranslate(delta.x, delta.y), obj.transform);
}

/** Moves several objects by the same delta; returns id → new transform. */
export function moveObjects(
  objs: EditorObject[],
  delta: Vec2,
): Record<string, AffineTransform> {
  const out: Record<string, AffineTransform> = {};
  for (const o of objs) out[o.id] = moveObject(o, delta);
  return out;
}

/**
 * Rotates an object's transform by `deltaRadians` about a page-space `center`.
 * The composition is translate(center) · rotate(δ) · translate(−center) · T,
 * which spins the object around `center` without changing its size.
 */
export function rotateObject(
  obj: EditorObject,
  center: Point,
  deltaRadians: number,
): AffineTransform {
  const about = compose(makeTranslate(center.x, center.y), makeRotate(deltaRadians));
  return compose(about, compose(makeTranslate(-center.x, -center.y), obj.transform));
}

/** Rotates several objects about the same center; returns id → new transform. */
export function rotateObjects(
  objs: EditorObject[],
  center: Point,
  deltaRadians: number,
): Record<string, AffineTransform> {
  const out: Record<string, AffineTransform> = {};
  for (const o of objs) out[o.id] = rotateObject(o, center, deltaRadians);
  return out;
}

/** Minimum size (in page units) enforced on resize so objects never collapse to 0. */
const DEFAULT_MIN_SIZE = 1;

/**
 * Resizes a single object from `handle` so that the handle lands at `newWorld`,
 * keeping the opposite handle fixed. Rotation-aware (projects the drag onto the
 * object's local axes). Edge handles scale one axis; corner handles scale both.
 *
 * `lockAspect` makes the drag UNIFORM instead: one scale for both axes, obtained
 * by projecting the local drag vector onto the handle's original diagonal. That
 * single formula covers every handle — for an edge handle the diagonal has a zero
 * component, so the projection reduces to that edge's own scale and applies it to
 * both axes — and it keeps the pointer on the object's diagonal, which is what
 * makes a constrained corner drag feel attached to the cursor. Negative
 * projections still flip, because a locked resize dragged past the anchor should
 * mirror the object rather than refuse to move.
 *
 * WHY IT EXISTS: nothing in the resize path constrained the ratio, so a corner
 * drag on a photo scaled x and y independently and the image simply came out
 * distorted — the one object kind where free scaling is almost never the intent.
 * WHICH drags lock is decided by `aspectConstraint`, not here, so this stays pure
 * geometry with no opinion about object kinds.
 */
export function resizeObject(
  obj: EditorObject,
  handle: ResizeHandle,
  newWorld: Point,
  minSize = DEFAULT_MIN_SIZE,
  lockAspect = false,
): AffineTransform {
  const { transform, localBounds } = obj;
  const W = localBounds.width;
  const H = localBounds.height;
  const { hx, hy } = HANDLE_FRACTIONS[handle];
  const { hx: ox, hy: oy } = HANDLE_FRACTIONS[oppositeHandle(handle)];

  const hLocal: Point = { x: hx * W, y: hy * H };
  const fLocal: Point = { x: ox * W, y: oy * H };
  const fixedWorld = transformPoint(transform, fLocal);

  // Local-space vector from the fixed point to the dragged handle.
  const lx = hLocal.x - fLocal.x; // ∈ {−W, 0, +W}
  const ly = hLocal.y - fLocal.y; // ∈ {−H, 0, +H}

  const { rotation, scale: origScale } = decompose(transform);
  const desired = sub(newWorld, fixedWorld);
  // Rotate the world drag into the object's local basis to read off new scales.
  const localDesired = rotateVector(desired, -rotation);

  let nsx = origScale.x;
  let nsy = origScale.y;
  if (lockAspect) {
    // Project the drag onto the handle's diagonal: s = (d·v)/(d·d), with
    // d = (lx, ly) the original fixed-point→handle vector. One scale, both axes.
    const dd = lx * lx + ly * ly;
    if (dd > 0) {
      const s = (localDesired.x * lx + localDesired.y * ly) / dd;
      // The object must clear `minSize` on BOTH axes now that one factor drives
      // both, so the tighter of the two governs.
      const minScale = minSize / Math.max(Math.min(W, H), Number.EPSILON);
      const clamped = s >= 0 ? Math.max(s, minScale) : Math.min(s, -minScale);
      nsx = clamped;
      nsy = clamped;
    }
  } else {
    if (lx !== 0) {
      nsx = localDesired.x / lx;
      // Clamp so the object can't collapse through the anchor.
      const minScale = minSize / W;
      nsx = nsx >= 0 ? Math.max(nsx, minScale) : Math.min(nsx, -minScale);
    }
    if (ly !== 0) {
      nsy = localDesired.y / ly;
      const minScale = minSize / H;
      nsy = nsy >= 0 ? Math.max(nsy, minScale) : Math.min(nsy, -minScale);
    }
  }

  // newT = T(fixedWorld) · R(θ) · S(nsx, nsy) · T(−fLocal)
  // Order matters: scale the local vector FIRST, then rotate it, so the drag
  // projects back onto the (rotated) local axes correctly. Swapping S and R
  // would skew the result for any non-zero rotation.
  return compose(
    makeTranslate(fixedWorld.x, fixedWorld.y),
    compose(
      makeRotate(rotation),
      compose(makeScale(nsx, nsy), makeTranslate(-fLocal.x, -fLocal.y)),
    ),
  );
}

/**
 * Scales every object in a selection about the anchor corner of the selection
 * box (the corner opposite `handle`). Each object's transform is scaled about
 * that anchor, preserving relative positions, sizes, and individual rotations.
 */
export function resizeSelection(
  objs: EditorObject[],
  selectionBounds: Bounds,
  handle: ResizeHandle,
  newOppositeWorld: Point,
  minSize = DEFAULT_MIN_SIZE,
): Record<string, AffineTransform> {
  const { hx, hy } = HANDLE_FRACTIONS[handle];
  const { hx: ax, hy: ay } = HANDLE_FRACTIONS[oppositeHandle(handle)];
  const anchor: Point = {
    x: selectionBounds.x + ax * selectionBounds.width,
    y: selectionBounds.y + ay * selectionBounds.height,
  };

  // The dragged corner's current world position.
  const draggedCorner: Point = {
    x: selectionBounds.x + hx * selectionBounds.width,
    y: selectionBounds.y + hy * selectionBounds.height,
  };

  let scaleX = 1;
  let scaleY = 1;
  if (selectionBounds.width > 0) {
    const newW = (newOppositeWorld.x - anchor.x) / (draggedCorner.x - anchor.x || 1);
    if (hx !== 0.5) {
      scaleX = newW;
      const minScale = minSize / selectionBounds.width;
      scaleX = scaleX >= 0 ? Math.max(scaleX, minScale) : Math.min(scaleX, -minScale);
    }
  }
  if (selectionBounds.height > 0) {
    const newH = (newOppositeWorld.y - anchor.y) / (draggedCorner.y - anchor.y || 1);
    if (hy !== 0.5) {
      scaleY = newH;
      const minScale = minSize / selectionBounds.height;
      scaleY = scaleY >= 0 ? Math.max(scaleY, minScale) : Math.min(scaleY, -minScale);
    }
  }

  const out: Record<string, AffineTransform> = {};
  for (const o of objs) {
    // Scale the object's transform about the anchor point.
    out[o.id] = compose(
      makeTranslate(anchor.x, anchor.y),
      compose(
        makeScale(scaleX, scaleY),
        compose(makeTranslate(-anchor.x, -anchor.y), o.transform),
      ),
    );
  }
  return out;
}

/** Flips an object about its center along the given axis (mirrors the transform). */
export function flipObject(obj: EditorObject, axis: "x" | "y"): AffineTransform {
  const center = transformPoint(obj.transform, {
    x: obj.localBounds.width / 2,
    y: obj.localBounds.height / 2,
  });
  const flip = axis === "x" ? makeScale(-1, 1) : makeScale(1, -1);
  return compose(
    makeTranslate(center.x, center.y),
    compose(flip, compose(makeTranslate(-center.x, -center.y), obj.transform)),
  );
}

// ---------------------------------------------------------------------------
// Command builders — capture before, compute after, wrap in one command.
// ---------------------------------------------------------------------------

/** Builds a coalesceable move command for the given ids. */
export function moveCommand(
  state: EditorState,
  ids: string[],
  delta: Vec2,
  coalesceKey?: string,
): TransformObjectsCommand {
  const page = getActivePage(state);
  const objs = ids.map((id) => getObject(page, id)).filter((o): o is EditorObject => Boolean(o));
  const before = captureTransforms(state, ids);
  const after = moveObjects(objs, delta);
  return new TransformObjectsCommand("Move", before, after, coalesceKey);
}

/** Builds a coalesceable rotate command about `center`. */
export function rotateCommand(
  state: EditorState,
  ids: string[],
  center: Point,
  deltaRadians: number,
  coalesceKey?: string,
): TransformObjectsCommand {
  const page = getActivePage(state);
  const objs = ids.map((id) => getObject(page, id)).filter((o): o is EditorObject => Boolean(o));
  const before = captureTransforms(state, ids);
  const after = rotateObjects(objs, center, deltaRadians);
  return new TransformObjectsCommand("Rotate", before, after, coalesceKey);
}

/** Builds a coalesceable single-object resize command. */
export function resizeCommand(
  state: EditorState,
  id: string,
  handle: ResizeHandle,
  newWorld: Point,
  coalesceKey?: string,
): TransformObjectsCommand {
  const page = getActivePage(state);
  const obj = getObject(page, id);
  if (!obj) throw new Error(`Cannot resize object ${id}: not found.`);
  const before = captureTransforms(state, [id]);
  // The command-level API gets the DEFAULT constraint (no pointer, so no Shift to
  // read): an image resized through here keeps its proportions too, rather than
  // depending on which entry point the caller happened to pick.
  const after = { [id]: resizeObject(obj, handle, newWorld, undefined, hasFixedAspectByDefault(obj)) };
  return new TransformObjectsCommand("Resize", before, after, coalesceKey);
}

/** Builds a coalesceable selection-box resize command for multiple objects. */
export function resizeSelectionCommand(
  state: EditorState,
  ids: string[],
  selectionBounds: Bounds,
  handle: ResizeHandle,
  newOppositeWorld: Point,
  coalesceKey?: string,
): TransformObjectsCommand {
  const page = getActivePage(state);
  const objs = ids.map((id) => getObject(page, id)).filter((o): o is EditorObject => Boolean(o));
  const before = captureTransforms(state, ids);
  const after = resizeSelection(objs, selectionBounds, handle, newOppositeWorld);
  return new TransformObjectsCommand("Resize", before, after, coalesceKey);
}
