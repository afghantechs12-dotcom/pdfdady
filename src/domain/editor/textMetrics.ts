/**
 * Base-14 PDF font vertical metrics — the single source of truth for where the
 * alphabetic baseline sits inside a text object's local box.
 *
 * WHY THIS EXISTS. M5 Part 1 places editable replacement text over existing PDF
 * text using a transform `T(baseline) · R(θ) · T(0, −ascent)` and a redaction box
 * `makeBounds(0, 0, advance, ascent + descent)`. For the redrawn text to land
 * exactly on the original baseline, the `ascent` used in that transform MUST
 * equal the `ascent` the render and export layers use to anchor the baseline:
 *
 *   - Export (pdf-lib): the first baseline is drawn at the local point
 *     `(0, ascent)` via `transformPoint(transform, { x: 0, y: ascent })` (see
 *     {@link PdfExportService.drawTextObject}).
 *   - Render (SVG): existing-text objects use `dominantBaseline="alphabetic"`
 *     with `y={ascent}`, putting the alphabetic baseline at local y = `ascent`
 *     (see `ObjectRenderer` `TextContent`).
 *
 * Before this module existed, each of the three sites picked its own "ascent":
 * the adapter used PDF.js's `TextItem.height` (which is the text-matrix vertical
 * scale = the font SIZE, not the ascender), the renderer used the browser's
 * `dominant-baseline: hanging` approximation, and the exporter used pdf-lib's
 * `font.heightAtSize(descender:false)`. They disagreed by ~0.28×fontSize, so the
 * redrawn text floated above the original and the redaction box ate the line
 * above. This module gives all three the SAME number.
 *
 * THE NUMBERS. The ratios below are the per-em Ascender/Descender pdf-lib
 * returns from `font.heightAtSize(size, { descender })` for the `StandardFonts`
 * (measured against the pinned pdf-lib version). A guard test
 * (`PdfExportService.test.ts`) re-measures pdf-lib and asserts these ratios
 * match, so a pdf-lib/AFM drift is caught at test time. They are deliberately
 * NOT the same as PDF.js's `TextItem.height` — that is the font size, not the
 * ascender (see {@link TextExtraction.groupTextItemsIntoLines}).
 *
 * CLASSIFICATION mirrors {@link resolveStandardFont} / `resolveFont`: Times or
 * serif (but not sans) → Times-Roman, Courier/mono → Courier, else Helvetica.
 * Only the base family matters — every weight/style variant of a family shares
 * the same ascender/descender. The classification is duplicated here (rather
 * than imported) to keep this domain module free of `lib/` and
 * `src/application/` dependencies; the duplication is two lines and the guard
 * test pins the alignment.
 */

/** The three base-14 families that carry distinct vertical metrics. */
type Base14Family = "Helvetica" | "Times-Roman" | "Courier";

/**
 * Per-em ascender (baseline → top, positive) and descender (baseline → bottom,
 * positive magnitude) for each base-14 family, exactly as pdf-lib reports them.
 */
const BASE14_VERTICAL_METRICS: Record<Base14Family, { ascent: number; descent: number }> = {
  Helvetica: { ascent: 0.718, descent: 0.207 },
  "Times-Roman": { ascent: 0.683, descent: 0.217 },
  Courier: { ascent: 0.629, descent: 0.157 },
};

/** Helvetica is the default fallback for unknown/opaque family names. */
const DEFAULT_FAMILY: Base14Family = "Helvetica";

/**
 * Maps a font family string to the base-14 family whose vertical metrics apply.
 * Mirrors the classification in {@link resolveStandardFont} so the family this
 * returns is the same one pdf-lib embeds (and therefore the same one whose
 * `heightAtSize` these ratios were measured from).
 */
export function base14Family(family: string): Base14Family {
  const f = (family ?? "").toLowerCase();
  if (f.includes("courier") || f.includes("mono")) return "Courier";
  if (f.includes("times") || (f.includes("serif") && !f.includes("sans"))) return "Times-Roman";
  return DEFAULT_FAMILY;
}

/** The ascender (baseline-to-top) per em for the family. */
export function base14AscentRatio(family: string): number {
  return BASE14_VERTICAL_METRICS[base14Family(family)].ascent;
}

/** The descender magnitude (baseline-to-bottom) per em for the family. */
export function base14DescentRatio(family: string): number {
  return BASE14_VERTICAL_METRICS[base14Family(family)].descent;
}

/** The ascender (baseline-to-top) in points for `fontSize`. */
export function base14Ascent(family: string, fontSize: number): number {
  return base14AscentRatio(family) * fontSize;
}

/** The descender magnitude in points for `fontSize`. */
export function base14Descent(family: string, fontSize: number): number {
  return base14DescentRatio(family) * fontSize;
}

/** The full vertical extent (ascender + descender) in points for `fontSize`. */
export function base14TextHeight(family: string, fontSize: number): number {
  const m = BASE14_VERTICAL_METRICS[base14Family(family)];
  return (m.ascent + m.descent) * fontSize;
}
