/**
 * The capability model for EXISTING (imported) PDF text.
 *
 * WHY THIS EXISTS. M5 Part 1 turned every extracted text run into a fully
 * editable `TextObject` placed over the original with an opaque white rectangle
 * "redacting" the original. That was dishonest and visibly broken:
 *
 *  - the original text stayed in the rasterized page background AND in the
 *    exported source page, so the user saw the original plus an approximate
 *    copy whenever the two failed to align (they routinely did — the copy is
 *    re-typeset in a base-14 font, not the original embedded font);
 *  - moving or deleting the copy revealed the original underneath;
 *  - the white rectangle destroyed table rules, images, and colored fills that
 *    happened to sit behind the run.
 *
 * The product rule is now explicit: the user either genuinely edits the original
 * text, or is told plainly that it cannot be edited. Never a duplicate that
 * calls itself "Edit text".
 *
 * This module owns the decision. It is PURE (no PDF.js, no DOM, no pdf-lib) so
 * every branch is unit-testable, and it is deliberately CONSERVATIVE: any fact
 * we do not positively know forces {@link readonlyCapability}. Editing is never
 * unlocked merely because text extraction returned a string and a bounding box.
 *
 * @see [[preview-architecture]] for how pages are rasterized and exported.
 */

/**
 * How an imported text run may be edited.
 *
 *  - `direct` — the original drawing operation itself is rewritten. No mask, no
 *    copy. Requires a real mapping back to the page content stream (see
 *    {@link SourceTextFacts.hasOperatorMapping}), which the current pdf-lib
 *    based pipeline does NOT provide. The branch exists so the capability
 *    contract is complete and a future content-stream writer has a seam to
 *    land in, not because it is reachable today.
 *  - `replace` — the original glyph region is permanently removed by an
 *    INDEPENDENT redaction, and replacement text is drawn over it. Only offered
 *    when the region's background was actually probed and found uniform, so the
 *    removal reconstructs what was behind the glyphs instead of stamping white
 *    over whatever was there.
 *  - `readonly` — the original renders, untouched, and no editable duplicate is
 *    ever created. This is the default and the honest answer for most PDFs.
 */
export type ImportedTextEditMode = "direct" | "replace" | "readonly";

/**
 * The result of assessing one imported text run. `reason` is user-facing copy —
 * it is rendered verbatim in the Properties panel, so it explains the decision
 * in the user's terms rather than naming internal fields.
 */
export type ImportedTextEditCapability =
  | { mode: "direct"; editable: true; reason: null }
  | { mode: "replace"; editable: true; reason: string }
  | { mode: "readonly"; editable: false; reason: string };

/** The outcome of probing the page raster behind a text run. */
export interface BackgroundProbeResult {
  /**
   * True only when the sampled region is a single flat fill (within tolerance)
   * apart from the glyphs themselves, AND nothing crosses the region's border
   * ring — a table rule, an image edge, or a gradient all fail this.
   */
  uniform: boolean;
  /** The reconstructed background color (sRGB 0..1), or null when not uniform. */
  color: { r: number; g: number; b: number } | null;
  /** Why the probe reached its verdict, for diagnostics and UI copy. */
  reason: string;
}

/**
 * Everything known about one imported text run, as inputs to the capability
 * decision.
 *
 * Every field is deliberately explicit rather than optional-with-a-permissive
 * default: a caller that cannot determine a fact must say so (`"unknown"`,
 * `false`, or `null`), and the assessor treats that as disqualifying. This is
 * what makes "unknown defaults to readonly" a property of the type rather than
 * a convention someone can forget.
 */
export interface SourceTextFacts {
  /**
   * True when this run maps to a known page and a known content-stream operator
   * range, so the original drawing operation could actually be rewritten.
   *
   * The current pipeline extracts text with PDF.js `getTextContent()`, which
   * reports strings, transforms, and advance widths — NOT operator offsets. It
   * is therefore always false today, and `direct` is unreachable. That is a real
   * limitation of the stack, recorded honestly rather than papered over.
   */
  hasOperatorMapping: boolean;
  /** Horizontal is the only writing mode the replacement geometry handles. */
  writingMode: "horizontal" | "vertical" | "unknown";
  /** Rotation in degrees. Only the cardinals (0/90/180/270) are supported. */
  rotation: number;
  /** The horizontal scale (PDF `Tz`/100). Anything but 1 breaks advance math. */
  horizontalScale: number;
  /** Whether the run's font is embedded in the PDF and reusable for redraw. */
  fontEmbedded: boolean;
  /** The font's PDF type. Type 3 fonts draw arbitrary glyph procedures. */
  fontType: "Type1" | "TrueType" | "Type0" | "Type3" | "unknown";
  /** Whether the font's character encoding is known well enough to re-encode. */
  encodingKnown: boolean;
  /** A clipping path intersecting the run makes the visible extent unknowable. */
  hasUnsupportedClipPath: boolean;
  /** A transparency group means the composite result isn't the raster we probed. */
  hasTransparencyGroup: boolean;
  /** Ligatures whose glyph→character mapping we cannot invert. */
  hasComplexLigatures: boolean;
  /** For composite (Type0) fonts, whether the CID→Unicode mapping is known. */
  compositeFontMappingKnown: boolean;
  /** Whether the reported bounds are trustworthy enough to redact against. */
  boundsTrustworthy: boolean;
  /** The background probe, or null when the region has not been probed yet. */
  background: BackgroundProbeResult | null;
}

/**
 * The conservative default: nothing is known, so nothing is editable. Callers
 * building facts incrementally should spread this so a newly-added fact cannot
 * silently default to "supported".
 */
export const UNKNOWN_SOURCE_TEXT_FACTS: SourceTextFacts = {
  hasOperatorMapping: false,
  writingMode: "unknown",
  rotation: 0,
  horizontalScale: 1,
  fontEmbedded: false,
  fontType: "unknown",
  encodingKnown: false,
  hasUnsupportedClipPath: false,
  hasTransparencyGroup: false,
  hasComplexLigatures: false,
  compositeFontMappingKnown: false,
  boundsTrustworthy: false,
  background: null,
};

/** The user-facing copy for the ordinary readonly outcome. */
export const READONLY_REASON =
  "This text is part of the original PDF content and cannot be edited safely.";

/** Builds a readonly capability with a specific explanation. */
export function readonlyCapability(reason: string = READONLY_REASON): ImportedTextEditCapability {
  return { mode: "readonly", editable: false, reason };
}

/** True when `deg` is within `tol` of one of 0/90/180/270. */
function isCardinalRotation(deg: number, tol = 0.5): boolean {
  if (!Number.isFinite(deg)) return false;
  const normalized = ((deg % 360) + 360) % 360;
  return [0, 90, 180, 270, 360].some((c) => Math.abs(normalized - c) <= tol);
}

/**
 * Decides how (or whether) an imported text run may be edited.
 *
 * The order matters: `direct` is strictly better than `replace` (it needs no
 * mask and cannot leave a residue), so it is tried first. `replace` is only
 * reached when a background probe positively succeeded — an unprobed run
 * (`background: null`) can never be replaced, which is what stops the old
 * "assume it's white" behavior from creeping back in.
 *
 * @param facts What is known about the run. Unknowns disqualify.
 * @returns The capability, defaulting to {@link readonlyCapability}.
 */
export function assessImportedTextCapability(
  facts: SourceTextFacts,
): ImportedTextEditCapability {
  // --- Shared disqualifiers: these break BOTH direct and replace ------------
  if (facts.fontType === "Type3") {
    return readonlyCapability(
      "This text uses a Type 3 font, whose glyphs are arbitrary drawings. It cannot be edited safely.",
    );
  }
  if (!isCardinalRotation(facts.rotation)) {
    return readonlyCapability(
      "This text is rotated at an angle the editor cannot reproduce exactly. It cannot be edited safely.",
    );
  }
  if (facts.writingMode !== "horizontal") {
    return readonlyCapability(
      "This text uses a writing mode the editor does not support. It cannot be edited safely.",
    );
  }
  if (facts.horizontalScale !== 1) {
    return readonlyCapability(
      "This text is horizontally scaled, so replacement text would not match its width. It cannot be edited safely.",
    );
  }
  if (facts.hasUnsupportedClipPath) {
    return readonlyCapability(
      "This text is clipped by the page content, so its visible extent is unknown. It cannot be edited safely.",
    );
  }
  if (facts.hasTransparencyGroup) {
    return readonlyCapability(
      "This text is drawn inside a transparency group, so its final appearance cannot be reproduced. It cannot be edited safely.",
    );
  }
  if (facts.hasComplexLigatures) {
    return readonlyCapability(
      "This text uses ligatures the editor cannot map back to characters. It cannot be edited safely.",
    );
  }
  if (!facts.boundsTrustworthy) {
    return readonlyCapability(
      "The editor cannot determine exactly where this text sits on the page. It cannot be edited safely.",
    );
  }

  // --- Direct: rewrite the original operator. Needs a real operator mapping --
  if (facts.hasOperatorMapping) {
    const encodingUsable =
      facts.encodingKnown &&
      (facts.fontType !== "Type0" || facts.compositeFontMappingKnown);
    if (facts.fontEmbedded && encodingUsable) {
      return { mode: "direct", editable: true, reason: null };
    }
  }

  // --- Replace: permanently remove the original, then draw a replacement ----
  // Requires a POSITIVE background probe. `null` (never probed) is not a maybe.
  if (facts.background?.uniform && facts.background.color) {
    return {
      mode: "replace",
      editable: true,
      reason:
        "The original text will be permanently removed and replaced. The replacement is re-typeset, so its shape may differ slightly from the original.",
    };
  }

  if (facts.background && !facts.background.uniform) {
    return readonlyCapability(
      "The background behind this text is not a flat color, so the original cannot be removed cleanly. It cannot be edited safely.",
    );
  }

  return readonlyCapability();
}
