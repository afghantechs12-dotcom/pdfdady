import type { AffineTransform, Bounds, Point } from "@/src/domain/editor/geometry";
import { transformPoint } from "@/src/domain/editor/geometry";

/**
 * Pure crop-handle math for the interactive image crop (M6).
 *
 * The crop rect lives in NATURAL pixel coordinates (the same data shape as
 * `ImageObject.crop`, so the numeric inspector fields and the export path keep
 * working unchanged). Eight handles adjust it; every adjustment is clamped so
 * the rect stays inside the image and never shrinks below
 * {@link MIN_CROP_SIZE} px on either axis.
 */

/** The eight crop handles (compass naming, matching the resize handles). */
export type CropHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** All handles in render order. */
export const CROP_HANDLES: readonly CropHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Minimum crop size in natural px. Tiny images use their full positive axis size. */
export const MIN_CROP_SIZE = 8;

/** Resource bound shared with deserialization/upload validation. */
export const MAX_NATURAL_IMAGE_DIMENSION = 100_000;

/** Derived drawing coordinates beyond this bound are rejected as unsafe. */
export const MAX_CROP_DRAW_COORDINATE = 10_000_000;

const clampNum = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);
const isSafeFinite = (value: number, max = MAX_CROP_DRAW_COORDINATE): boolean =>
  Number.isFinite(value) && Math.abs(value) <= max;

/** Throws unless natural image dimensions form a valid bounded raster domain. */
export function assertNaturalImageDimensions(naturalWidth: number, naturalHeight: number): void {
  if (
    !Number.isFinite(naturalWidth) ||
    !Number.isFinite(naturalHeight) ||
    naturalWidth <= 0 ||
    naturalHeight <= 0 ||
    naturalWidth > MAX_NATURAL_IMAGE_DIMENSION ||
    naturalHeight > MAX_NATURAL_IMAGE_DIMENSION
  ) {
    throw new RangeError(
      `Image dimensions must be finite, positive, and no larger than ${MAX_NATURAL_IMAGE_DIMENSION}px.`,
    );
  }
}

/** The full-image crop rect (the default when entering crop mode without one). */
export function fullCrop(naturalWidth: number, naturalHeight: number): Bounds {
  assertNaturalImageDimensions(naturalWidth, naturalHeight);
  return { x: 0, y: 0, width: naturalWidth, height: naturalHeight };
}

/**
 * Sanitizes a stored crop against the image's natural size: clamps it inside
 * the image and enforces the minimum size (falling back to the full image for
 * degenerate rects).
 */
export function sanitizeCrop(crop: Bounds | null | undefined, naturalWidth: number, naturalHeight: number): Bounds {
  assertNaturalImageDimensions(naturalWidth, naturalHeight);
  const minWidth = Math.min(MIN_CROP_SIZE, naturalWidth);
  const minHeight = Math.min(MIN_CROP_SIZE, naturalHeight);
  if (
    !crop ||
    ![crop.x, crop.y, crop.width, crop.height].every((n) => Number.isFinite(n)) ||
    crop.width < minWidth ||
    crop.height < minHeight
  ) {
    return fullCrop(naturalWidth, naturalHeight);
  }
  const x = clampNum(crop.x, 0, Math.max(0, naturalWidth - minWidth));
  const y = clampNum(crop.y, 0, Math.max(0, naturalHeight - minHeight));
  const width = clampNum(crop.width, minWidth, naturalWidth - x);
  const height = clampNum(crop.height, minHeight, naturalHeight - y);
  return { x, y, width, height };
}

/**
 * Adjusts a crop rect by dragging `handle` by (dx, dy) natural px. Edges move
 * independently (corner handles move two); the opposite edge is the fixed
 * anchor. Clamped inside [0, natural] and to {@link MIN_CROP_SIZE}.
 */
export function adjustCrop(
  crop: Bounds,
  handle: CropHandle,
  dx: number,
  dy: number,
  naturalWidth: number,
  naturalHeight: number,
): Bounds {
  assertNaturalImageDimensions(naturalWidth, naturalHeight);
  const start = sanitizeCrop(crop, naturalWidth, naturalHeight);
  // Non-finite deltas (zero/unmeasured scale upstream) must not poison the
  // rect — the module contract is "every adjustment is clamped".
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return start;
  const minWidth = Math.min(MIN_CROP_SIZE, naturalWidth);
  const minHeight = Math.min(MIN_CROP_SIZE, naturalHeight);
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;

  const movesLeft = handle === "nw" || handle === "w" || handle === "sw";
  const movesRight = handle === "ne" || handle === "e" || handle === "se";
  const movesTop = handle === "nw" || handle === "n" || handle === "ne";
  const movesBottom = handle === "sw" || handle === "s" || handle === "se";

  if (movesLeft) left = clampNum(left + dx, 0, right - minWidth);
  if (movesRight) right = clampNum(right + dx, left + minWidth, naturalWidth);
  if (movesTop) top = clampNum(top + dy, 0, bottom - minHeight);
  if (movesBottom) bottom = clampNum(bottom + dy, top + minHeight, naturalHeight);

  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Moves the whole crop rect by (dx, dy), clamped inside the image (size is
 * preserved). Used for dragging the crop area itself.
 */
export function moveCrop(crop: Bounds, dx: number, dy: number, naturalWidth: number, naturalHeight: number): Bounds {
  const start = sanitizeCrop(crop, naturalWidth, naturalHeight);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return start;
  const x = clampNum(start.x + dx, 0, Math.max(0, naturalWidth - start.width));
  const y = clampNum(start.y + dy, 0, Math.max(0, naturalHeight - start.height));
  return { ...start, x, y };
}

/**
 * Resolves a crop-mode COMMIT (the pure half of the canvas's commit handler):
 * sanitizes the draft, maps a full-image crop to `null` (the canonical
 * "no crop" value), and reports whether the result differs from the persisted
 * crop. `changed: false` means committing would be a no-op — the caller must
 * NOT issue a command, so an unchanged commit never pollutes the undo history.
 */
export function resolveCropCommit(
  draft: Bounds,
  current: Bounds | null,
  naturalWidth: number,
  naturalHeight: number,
): { changed: boolean; next: Bounds | null } {
  // "Covers the whole image" is the canonical-null test. Checked by coverage
  // (not exact equality with the natural size) so images SMALLER than
  // MIN_CROP_SIZE — where sanitize can only produce an over-size rect — also
  // canonicalize to null instead of persisting a crop larger than the image.
  const coversImage = (rect: Bounds): boolean =>
    rect.x <= 0 &&
    rect.y <= 0 &&
    rect.x + rect.width >= naturalWidth &&
    rect.y + rect.height >= naturalHeight;
  const tinyImage = naturalWidth < MIN_CROP_SIZE || naturalHeight < MIN_CROP_SIZE;

  const next = sanitizeCrop(draft, naturalWidth, naturalHeight);
  const isFull = tinyImage || coversImage(next);
  // Canonicalize the PERSISTED side too: a stored full-image rect (e.g. one
  // written by the numeric inspector before it normalized) equals null.
  const currentIsFull = current === null || coversImage(current);
  const unchanged = isFull
    ? currentIsFull
    : current !== null &&
      current.x === next.x &&
      current.y === next.y &&
      current.width === next.width &&
      current.height === next.height;
  return { changed: !unchanged, next: isFull ? null : next };
}

/** The handle's position on a rect (unit factors: 0 = min edge, 1 = max edge). */
export function handleAnchor(handle: CropHandle): { fx: number; fy: number } {
  switch (handle) {
    case "nw": return { fx: 0, fy: 0 };
    case "n": return { fx: 0.5, fy: 0 };
    case "ne": return { fx: 1, fy: 0 };
    case "e": return { fx: 1, fy: 0.5 };
    case "se": return { fx: 1, fy: 1 };
    case "s": return { fx: 0.5, fy: 1 };
    case "sw": return { fx: 0, fy: 1 };
    case "w": return { fx: 0, fy: 0.5 };
  }
}

// ---------------------------------------------------------------------------
// Crop draw geometry — shared by the crop-mode overlay (screen) and the
// clip-based PDF export, so both place the full image identically.
// ---------------------------------------------------------------------------

/** The structural subset of ImageObject the draw geometry needs. */
export interface CroppedImageLike {
  transform: AffineTransform;
  localBounds: Bounds;
  naturalWidth: number;
  naturalHeight: number;
  crop?: Bounds | null;
}

/**
 * Where the FULL image sits when a crop is applied. The object's local box
 * (localBounds) displays exactly the crop region, so the full image spans a
 * larger rect offset up/left of the local origin. All values in LOCAL units:
 *
 *  - `offset`: the full image's top-left in local space (≤ 0 on both axes)
 *  - `width`/`height`: the full image's local size
 *
 * `clipCorners` are the crop window's corners (= the local box corners) in
 * WORLD/page space, in order TL→TR→BR→BL — the polygon the export clips to.
 * Returns null when the object has no usable crop (nothing special to draw).
 */
export interface CropDrawSpec {
  offset: Point;
  width: number;
  height: number;
  clipCorners: [Point, Point, Point, Point];
}

/** See {@link CropDrawSpec}. Sanitizes the stored crop before deriving. */
export function cropDrawSpec(obj: CroppedImageLike): CropDrawSpec | null {
  if (!obj.crop) return null;
  try {
    assertNaturalImageDimensions(obj.naturalWidth, obj.naturalHeight);
  } catch {
    return null;
  }
  if (
    ![obj.localBounds.x, obj.localBounds.y, obj.localBounds.width, obj.localBounds.height].every(Number.isFinite) ||
    obj.localBounds.width <= 0 ||
    obj.localBounds.height <= 0 ||
    ![obj.transform.a, obj.transform.b, obj.transform.c, obj.transform.d, obj.transform.e, obj.transform.f].every(Number.isFinite)
  ) {
    return null;
  }
  const crop = sanitizeCrop(obj.crop, obj.naturalWidth, obj.naturalHeight);
  // A crop equal to the full image draws exactly like no crop.
  if (crop.x === 0 && crop.y === 0 && crop.width === obj.naturalWidth && crop.height === obj.naturalHeight) {
    return null;
  }
  const W = obj.localBounds.width;
  const H = obj.localBounds.height;
  const kx = W / crop.width; // natural px → local units
  const ky = H / crop.height;
  const t = obj.transform;
  const corner = (lx: number, ly: number): Point => transformPoint(t, { x: lx, y: ly });
  const offset = { x: -crop.x * kx || 0, y: -crop.y * ky || 0 };
  const width = obj.naturalWidth * kx;
  const height = obj.naturalHeight * ky;
  const clipCorners = [corner(0, 0), corner(W, 0), corner(W, H), corner(0, H)] as [Point, Point, Point, Point];
  if (
    ![kx, ky, offset.x, offset.y, width, height].every((value) => isSafeFinite(value)) ||
    width <= 0 ||
    height <= 0 ||
    !clipCorners.every((point) => isSafeFinite(point.x) && isSafeFinite(point.y))
  ) {
    return null;
  }
  return { offset, width, height, clipCorners };
}

/**
 * Converts a stored crop rect (natural px) into the object's LOCAL frame,
 * where the PERSISTED crop `base` fills (0,0,W,H). Used by the crop overlay to
 * draw the live draft window while dragging.
 */
export function cropRectToLocal(draft: Bounds, base: Bounds, localW: number, localH: number): Bounds {
  if (
    ![draft.x, draft.y, draft.width, draft.height, base.x, base.y, base.width, base.height, localW, localH].every(Number.isFinite) ||
    base.width <= 0 ||
    base.height <= 0 ||
    localW <= 0 ||
    localH <= 0
  ) {
    return { x: 0, y: 0, width: Math.max(0, localW), height: Math.max(0, localH) };
  }
  const kx = localW / base.width;
  const ky = localH / base.height;
  const result = {
    x: (draft.x - base.x) * kx,
    y: (draft.y - base.y) * ky,
    width: draft.width * kx,
    height: draft.height * ky,
  };
  return Object.values(result).every((value) => isSafeFinite(value))
    ? result
    : { x: 0, y: 0, width: localW, height: localH };
}
