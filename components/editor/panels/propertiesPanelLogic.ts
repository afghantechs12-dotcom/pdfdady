import type { ObjectStyle } from "@/src/domain/editor/objects";

/**
 * Pure helpers for the Properties panel (M6.16). Node-testable; the panel
 * component renders these results and never re-derives them in JSX. Numeric
 * bounds come from the DOMAIN clamping helpers (`shapeGeometry.ts`,
 * `cropMath.ts`) — no constants are duplicated here.
 */

/** The canonical dash presets offered by the panel (local units). */
export const DASH_PRESETS = {
  solid: undefined,
  dashed: [6, 4],
  dotted: [2, 3],
} as const;

export type DashPresetId = keyof typeof DASH_PRESETS | "custom";

/** Which preset a stored dash pattern corresponds to ("custom" when none). */
export function dashPresetOf(dash: ObjectStyle["dash"]): DashPresetId {
  if (!dash || dash.length === 0) return "solid";
  if (dash.length === 2 && dash[0] === 6 && dash[1] === 4) return "dashed";
  if (dash.length === 2 && dash[0] === 2 && dash[1] === 3) return "dotted";
  return "custom";
}

/** The dash array for a chosen preset (undefined = solid). "custom" keeps the current value. */
export function dashForPreset(preset: DashPresetId, current: ObjectStyle["dash"]): number[] | undefined {
  if (preset === "custom") return current;
  const value = DASH_PRESETS[preset];
  return value ? [...value] : undefined;
}

/**
 * A representative value over a multi-selection: the first value plus a
 * `mixed` flag when the objects disagree (the panel renders "Mixed").
 */
export function representativeValue(values: number[]): { value: number; mixed: boolean } {
  const first = values[0] ?? 0;
  return { value: first, mixed: values.some((v) => v !== first) };
}

/** Radians → whole degrees, normalized into [-180, 180]. */
export function rotationDegOf(radians: number): number {
  const deg = Math.round((radians * 180) / Math.PI);
  const wrapped = ((deg % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/**
 * The SHORTEST-PATH delta (radians) that rotates `currentDeg` to `targetDeg`.
 * Normalized into (-180, 180] so crossing the ±180 seam (display shows 179,
 * user types -179) rotates 2°, not −358°.
 */
export function rotationDelta(currentDeg: number, targetDeg: number): number {
  let deltaDeg = (targetDeg - currentDeg) % 360;
  if (deltaDeg > 180) deltaDeg -= 360;
  if (deltaDeg < -180) deltaDeg += 360;
  return (deltaDeg * Math.PI) / 180;
}

// ---------------------------------------------------------------------------
// Position / size (P1 Phase H — H14, H25).
// ---------------------------------------------------------------------------

/**
 * The move delta that puts an object's world origin at an absolute coordinate.
 *
 * The X/Y fields are ABSOLUTE, but the only move primitive is relative
 * (`moveSelection(delta)`), so the panel converts. Returning `null` for a
 * no-op (or a non-finite input) keeps the caller from pushing an identity
 * command onto the undo stack, which would make Undo appear to do nothing.
 */
export function positionDelta(
  current: { x: number; y: number },
  next: { x?: number; y?: number },
): { x: number; y: number } | null {
  const targetX = next.x ?? current.x;
  const targetY = next.y ?? current.y;
  if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) return null;
  const dx = targetX - current.x;
  const dy = targetY - current.y;
  if (dx === 0 && dy === 0) return null;
  return { x: dx, y: dy };
}

/**
 * The (width, height) to commit for one edited dimension, honouring an
 * aspect-ratio lock (H14).
 *
 * Both dimensions are returned together because `setObjectSize(id, w, h)` takes
 * both in ONE command — that is what keeps a locked resize a single undo entry
 * instead of two, and why no new transform infrastructure is needed.
 *
 * The ratio is taken from the CURRENT size rather than a remembered original, so
 * the lock composes with unlocked edits: whatever shape the object has now is
 * the shape it keeps.
 *
 * Returns `null` for anything not worth committing — a no-op, a non-finite
 * value, or a zero/negative dimension. `setObjectSize` divides by the current
 * size, so a degenerate object has no ratio and no valid target; declining is
 * more honest than handing the service a pair it will silently discard.
 */
export function lockedSize(
  current: { w: number; h: number },
  edit: { w?: number; h?: number },
  locked: boolean,
): { w: number; h: number } | null {
  const nextW = edit.w ?? current.w;
  const nextH = edit.h ?? current.h;
  if (!Number.isFinite(nextW) || !Number.isFinite(nextH)) return null;
  if (nextW <= 0 || nextH <= 0) return null;
  // No ratio to preserve, and `setObjectSize` would divide by zero.
  if (current.w <= 0 || current.h <= 0) return null;

  let w = nextW;
  let h = nextH;
  if (locked) {
    const ratio = current.w / current.h;
    // Drive the partner from the dimension the user actually typed.
    if (edit.w != null && edit.h == null) h = Math.round(nextW / ratio);
    else if (edit.h != null && edit.w == null) w = Math.round(nextH * ratio);
  }
  if (w <= 0 || h <= 0) return null;
  if (w === current.w && h === current.h) return null;
  return { w, h };
}

// ---------------------------------------------------------------------------
// Page size naming (P1 Phase H — H23).
// ---------------------------------------------------------------------------

/** Known page sizes in PDF points, portrait (width, height). */
const PAGE_SIZES: Array<{ name: string; w: number; h: number }> = [
  { name: "A3", w: 842, h: 1191 },
  { name: "A4", w: 595, h: 842 },
  { name: "A5", w: 420, h: 595 },
  { name: "Letter", w: 612, h: 792 },
  { name: "Legal", w: 612, h: 1008 },
  { name: "Tabloid", w: 792, h: 1224 },
];

/** How far (pt) a dimension may drift and still count as a named size. */
const SIZE_TOLERANCE = 1;

/**
 * A human name for a page size ("A4", "Letter"), or `null` when it matches none.
 *
 * Returns `null` rather than a guess: the panel always shows the exact
 * `W × H pt` beside this, so an unrecognized size is simply unnamed instead of
 * being mislabelled as the nearest standard. Orientation-insensitive — a
 * landscape A4 is still A4.
 *
 * The ±1pt tolerance absorbs the rounding in real-world PDFs (A4 is 595.276pt,
 * commonly stored as 595 or 595.28) without letting genuinely different sizes
 * collide: the closest pair of standards here differ by far more than 2pt.
 */
export function describePageSize(width: number, height: number): string | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  for (const size of PAGE_SIZES) {
    if (
      Math.abs(shortSide - size.w) <= SIZE_TOLERANCE &&
      Math.abs(longSide - size.h) <= SIZE_TOLERANCE
    ) {
      return size.name;
    }
  }
  return null;
}

/**
 * The full page-size readout: the name when known, always the exact dimensions.
 * One helper so the label can never overstate what was recognized (H23).
 */
export function pageSizeLabel(width: number, height: number): string {
  const exact = `${Math.round(width)} × ${Math.round(height)} pt`;
  const name = describePageSize(width, height);
  return name ? `${name} · ${exact}` : exact;
}

// ---------------------------------------------------------------------------
// Contextual Inspector heading (P1 Phase H — H3, H41).
// ---------------------------------------------------------------------------

/** What the heading needs to know about the selection. Deliberately minimal. */
export interface InspectorHeadingInput {
  /** How many objects are selected. */
  count: number;
  /** The primary object's kind, or null when nothing is selected. */
  kind: string | null;
  /**
   * Whether the primary object is an imported PDF text run that cannot be edited
   * in place. Named separately because it is not a `kind` — it is a capability,
   * and the heading is the first place a user learns the difference.
   */
  readonlySourceText?: boolean;
}

/** Kind → heading. Only kinds the panel actually renders controls for. */
const KIND_HEADINGS: Record<string, string> = {
  text: "Text",
  image: "Image",
  shape: "Shape",
  drawing: "Drawing",
  annotation: "Annotation",
  signature: "Signature",
  highlight: "Highlight",
};

/**
 * The Inspector's heading for the current selection.
 *
 * Replaces `Properties · {name}`. Two problems with that form: the panel is
 * already labelled "Properties" by its own tab, so the word was a redundant
 * heading (H41), and `{name}` was an object name like "Text 3" — which says what
 * the object is *called*, not what it *is*, so the heading carried no information
 * the layer list did not already give.
 *
 * An imported PDF text run reads "Original PDF text", not "Text". The two support
 * genuinely different actions, and a heading that called them both "Text" would
 * make the missing geometry controls look like a bug rather than a fact about
 * original page content.
 *
 * Unknown kinds (a plugin-defined object) fall back to "Object" rather than to
 * the raw kind string: a heading is UI copy, and `kind` is an internal token.
 */
export function inspectorHeading(input: InspectorHeadingInput): string {
  const { count, kind, readonlySourceText = false } = input;
  // Order matters. The count decides first: a multi-selection whose primary
  // could not be resolved is still a multi-selection, and answering "Page" there
  // would tell the user nothing is selected while handles are on screen.
  if (count <= 0) return "Page";
  if (count > 1) return `${count} objects selected`;
  if (kind === null) return "Object";
  if (kind === "text" && readonlySourceText) return "Original PDF text";
  return KIND_HEADINGS[kind] ?? "Object";
}
