import { base14AscentRatio } from "@/src/domain/editor/textMetrics";

/**
 * The GEOMETRY and entry behaviour of the inline text editor — where the
 * `<textarea>` overlay sits so its glyphs land on the ones it replaces, how tall
 * it is, and what is selected the moment it opens.
 *
 * WHY THIS EXISTS. Measured in Chrome (a 16px Helvetica text object at 100% zoom,
 * `docs/editor-p1-premium-polish.md` P7), double-clicking committed text moved it:
 *
 *   - **+1.0px horizontally.** The overlay was styled `border: 1.5px solid` with
 *     `box-sizing: border-box` and `padding: 0`, so the border inset the CONTENT
 *     box and every glyph started one device pixel to the right of where the
 *     committed run starts. A ring that moves the text it rings is the wrong ring:
 *     `outline` occupies no layout space and says the same thing.
 *   - **+3.8px vertically**, i.e. 0.2375em, and it scales with font size AND zoom
 *     (a 48pt heading at 200% moves ~23px). CSS puts the first baseline at
 *     `half-leading + the font's own ascent` below the content box, using the
 *     metrics of whatever face the browser substituted. The committed SVG render
 *     and the PDF export both put it at the base-14 ASCENDER — for editor-authored
 *     text the exporter draws the first line at local `(0, ascent)` — which for
 *     Helvetica at 16px is 11.49px, while CSS measured 15.14px.
 *   - **the surface was twice the object's height** (40.38px of white over a 20px
 *     object): a `<textarea>` with no `rows` has an intrinsic height of TWO rows,
 *     and `minHeight` cannot pull it back down. The extra row covered page content
 *     that has nothing to do with the text being edited.
 *   - **the old glyphs peeked out above it.** The committed run's ascender area
 *     sits ~2.99px ABOVE the object's box top (that is where the ascent
 *     convention puts it), and the opaque surface started exactly at the box top,
 *     so a sliver of the text being replaced stayed visible underneath.
 *
 * THE FIX, in two halves. The base-14 ascender is knowable statically
 * ({@link firstBaselineTarget}); where CSS puts its first baseline is NOT — it
 * depends on the substituted face's `hhea` metrics, which no formula in this repo
 * has. So `TextEditor` measures that ONE number once per editing session (a
 * zero-height inline-block strut sits on the baseline by definition) and passes it
 * to {@link baselineShift}, which turns the pair into a translation. Everything
 * else — the box, the clamp, the caret — is pure and tested here.
 *
 * Residual: the committed SVG render uses `dominant-baseline: hanging`, which
 * Chrome resolved to 0.73em against pdf-lib's 0.718em — a 0.012em disagreement
 * (0.19px at 16px) that predates this module. Aligning the overlay to the
 * EXPORTER's ascent rather than to the browser's hanging baseline keeps the
 * overlay exact against the artifact the user ends up with, and within a fifth of
 * a pixel of the canvas. Measured after the fix, the glyphs move by dy +0.28px at
 * 16px, −0.37px at 24px and −0.75px at 48px (dx 0 at all three) — sub-pixel where
 * it used to be +3.8px at 16px and would have been +11.4px at 48px.
 *
 * That residual is also why the surface does not cover the committed run's top
 * 0.28px at 100% zoom: the surface top IS the glyph origin here (no padding), so
 * inflating it upward to hide that sliver would move the text by the same amount
 * and reintroduce the jump this module exists to remove. A quarter pixel of
 * antialiasing is the cheaper defect.
 *
 * @see [[text-editing-baseline-alignment]]
 */

/** The narrowest the editing surface may be, so an empty box is still clickable. */
export const TEXT_EDITOR_MIN_WIDTH = 40;

/**
 * How far the baseline correction may move the surface, as a fraction of the font
 * size.
 *
 * The measurement it derives from happens in the DOM, and a hidden/zero-metric
 * probe (a display-suppressed subtree, a font that failed to load) can report
 * nonsense. 0.5em is far outside any real half-leading, so clamping here means a
 * bad measurement degrades to a small offset instead of throwing the editing
 * surface off screen.
 */
export const BASELINE_SHIFT_LIMIT_EM = 0.5;

/** How the editor was opened, which decides what is selected on entry. */
export type TextEditEntry = "fresh" | "existing";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Where the FIRST baseline belongs, in px below the object box's top edge.
 *
 * This is the exporter's convention for editor-authored text (`drawTextObject`
 * anchors line `i` at local `y = ascent + i · fontSize · lineHeight`), expressed
 * with the same per-em ratios `textMetrics` gives the renderer and the exporter.
 * Using the shared ratios rather than a local constant is the whole point: three
 * layers guessing their own "ascent" is the drift that module was written to end.
 */
export function firstBaselineTarget(fontFamily: string, fontSizePx: number): number {
  if (!Number.isFinite(fontSizePx) || fontSizePx <= 0) return 0;
  return base14AscentRatio(fontFamily) * fontSizePx;
}

/**
 * The vertical translation, in px, that moves a CSS-laid-out first baseline onto
 * the target one. Negative means the surface moves UP.
 *
 * `measuredPx` is the browser's own first-baseline offset from the content box
 * top for the exact font, size and line height in use. A non-finite or
 * non-positive measurement means the probe failed, and the honest answer is 0 —
 * today's placement, no correction — rather than a guess.
 */
export function baselineShift(targetPx: number, measuredPx: number, fontSizePx: number): number {
  if (!Number.isFinite(targetPx) || !Number.isFinite(measuredPx) || measuredPx <= 0) return 0;
  if (!Number.isFinite(fontSizePx) || fontSizePx <= 0) return 0;
  const limit = BASELINE_SHIFT_LIMIT_EM * fontSizePx;
  return clamp(targetPx - measuredPx, -limit, limit);
}

/**
 * How many lines the surface must show.
 *
 * Soft wrapping is off (`white-space: pre`), so a line is a line: this counts
 * newlines and nothing else, which keeps the height a pure function of the value.
 * An empty value still needs one line — a zero-height caret is not a caret.
 */
export function textEditorLineCount(value: string): number {
  if (!value) return 1;
  return value.split("\n").length;
}

export interface TextEditorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextEditorBoxInput {
  /** Rendered font size in px (the object's size × zoom). */
  fontSizePx: number;
  /** The object's line-height multiplier. */
  lineHeight: number;
  /** Current editor value, which decides how many lines must be visible. */
  value: string;
  /** The baseline translation from {@link baselineShift}. */
  shift: number;
}

/**
 * The editing surface's box, in the same screen space as `rect`.
 *
 * Two things it deliberately does NOT do. It does not shrink below the object's
 * own box, because the surface has to cover the committed glyphs it is standing in
 * for; and it does not merely move by `shift` — it also GROWS by `|shift|`, so the
 * edge the shift pulls away from still covers the run underneath. The measured
 * case (`shift = −3.65px`) raises the top over the committed ascenders and leaves
 * the bottom exactly where the object's box ends.
 *
 * Height grows with the value so a third line does not type itself into a clipped
 * box (`overflow: hidden`); it is a pure function of the text, not a measured
 * scroll height, so there is nothing to observe or poll.
 */
export function textEditorBox(rect: TextEditorRect, input: TextEditorBoxInput) {
  const { fontSizePx, lineHeight, value, shift } = input;
  const safeShift = Number.isFinite(shift) ? shift : 0;
  // `Math.max` PROPAGATES NaN rather than ignoring it, so a non-finite font size
  // would otherwise reach the style object as `height: NaN` — a surface with no
  // height at all. Sanitize at the boundary instead.
  const safeFontSize = Number.isFinite(fontSizePx) && fontSizePx > 0 ? fontSizePx : 0;
  const safeRectHeight = Number.isFinite(rect.height) ? rect.height : 0;
  const lineHeightPx = safeFontSize * (lineHeight > 0 ? lineHeight : 1.2);
  const contentHeight = lineHeightPx * textEditorLineCount(value);
  const height = Math.max(safeRectHeight, contentHeight, 1) + Math.abs(safeShift);
  return {
    left: rect.x,
    top: rect.y + safeShift,
    width: Math.max(rect.width, TEXT_EDITOR_MIN_WIDTH),
    height,
  };
}

/**
 * What is selected when the editor opens.
 *
 * `fresh` — the object was just created by a tool. The text tool seeds an EMPTY
 * box, so this is a caret at the start; if a tool ever seeds a placeholder
 * instead, selecting it all is the right entry, because the first keystroke
 * replacing it is the intent.
 *
 * `existing` — the user double-clicked, or chose Edit, on text they already
 * wrote. Select NOTHING and put the caret at the end. The old behaviour called
 * `el.select()` unconditionally, so opening an established paragraph and pressing
 * one key deleted the paragraph; a caret is recoverable, a destroyed paragraph
 * needs an undo the user has to think of. Select-all is still one Ctrl/Cmd+A away.
 *
 * Placing the caret at the CLICKED character would be better still, and is not
 * possible here: the textarea does not exist at double-click time, so there is no
 * text node to map the point onto.
 */
export function caretOnEntry(text: string, entry: TextEditEntry): { start: number; end: number } {
  const end = (text ?? "").length;
  if (entry === "fresh") return { start: 0, end };
  return { start: end, end };
}
