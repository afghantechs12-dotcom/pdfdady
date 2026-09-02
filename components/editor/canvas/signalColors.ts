import { editorColors } from "@/styles/editor";

/**
 * The canvas's SIGNAL colours — the one place SVG presentation attributes read
 * them from.
 *
 * Why this file exists at all: SVG attributes (`stroke="…"`, `fill="…"`) cannot
 * reference a Tailwind class, so canvas chrome has to be written as literal
 * colour strings. Left to itself that becomes a hex per element — this codebase
 * had `#7C3AED` hand-typed in eleven places across four canvas files, in two
 * different letter cases. These constants re-export the token module so the
 * literals exist exactly once and stay in step with the CSS side.
 *
 * The RULE they enforce is the important part. Four different things used to be
 * the same violet: brand chrome, the active tool, the selection outline, and the
 * alignment guides. When they are one hue, the canvas stops being readable — a
 * selected object's outline is indistinguishable from a snap guide crossing it,
 * and neither is distinguishable from the app furniture around the canvas. Each
 * signal now answers a different question and gets its own hue:
 *
 *   ACCENT (violet)  "which tool is armed" — chrome, brand
 *   SELECTION (blue) "what have I got hold of" — outlines, handles, marquee
 *   GUIDE (magenta)  "what am I lining up with" — snap and spacing indicators
 *
 * `signalColors.test.ts` asserts they stay perceptually distinct, so a future
 * palette change cannot quietly collapse two of them back together.
 */

/** Brand + armed-tool violet. NOT for selection or guides. */
export const ACCENT = editorColors.accent;

/** Selection outlines, resize/rotate handles, and the marquee. */
export const SELECTION = editorColors.selection;

/** Tint behind selected rows/handles that need a fill rather than a stroke. */
export const SELECTION_SOFT = editorColors.selectionsoft;

/**
 * The contrast layer under every selection stroke.
 *
 * Selection chrome has to be legible over content it knows nothing about: a
 * photo, a dark fill, or — worst case — a shape filled with the selection colour
 * itself. A light halo behind the stroke solves that without a second accent
 * colour or an SVG filter.
 */
export const SELECTION_HALO = editorColors.selectionhalo;
export const SELECTION_HALO_WIDTH = 3.5;

/** Alignment/snap guides and equal-spacing marks. */
export const GUIDE = editorColors.guide;

/**
 * In-progress creation previews: the text-box drag area, a shape/highlight
 * draft, pen-tool anchors, the crop window.
 *
 * Deliberately the SAME blue as selection, not a fourth hue. All of these are
 * "the thing your pointer currently has hold of", which is what selection blue
 * already means; a draft is distinguished from a committed object by a DASHED
 * stroke, not by a different colour. Inventing a fourth signal would dilute the
 * three that carry real meaning — and the previous violet made a shape draft
 * look like brand chrome sitting on the page.
 *
 * It is a named alias rather than a direct `SELECTION` reference at each site so
 * the intent is legible where it is used, and so a future decision to split them
 * has one place to change.
 */
export const DRAFT = SELECTION;

/**
 * Translucent selection-blue fills, for surfaces rather than strokes: a draft
 * shape's interior, the marquee's body, the multi-select bounding tint.
 *
 * Written as literal `rgba()` because SVG `fill` cannot take a colour and a
 * separate opacity in one attribute, and applying `fill-opacity` instead would
 * also fade whatever the caller draws inside. The channel values are `SELECTION`
 * (#2563EB) decomposed — `signalColors.test.ts` asserts they still match, so a
 * palette change cannot leave the tints on the old hue.
 */
export const SELECTION_RGB = "37,99,235";
/** ~16% — the marquee body and the multi-select tint. */
export const DRAFT_TINT_STRONG = `rgba(${SELECTION_RGB},0.16)`;
/** ~8% — a shape/highlight draft's interior. */
export const DRAFT_TINT = `rgba(${SELECTION_RGB},0.08)`;
/** ~6% — the text-box drag area, which is larger and needs a lighter wash. */
export const DRAFT_TINT_WEAK = `rgba(${SELECTION_RGB},0.06)`;
/** ~55% — a marquee's own edge, softer than a committed selection stroke. */
export const DRAFT_EDGE = `rgba(${SELECTION_RGB},0.55)`;
