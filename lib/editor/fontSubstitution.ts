import { StandardFontsProvider, type FontDescriptor } from "@/src/application/editor/extensions/Extensions";

/**
 * Safe font substitution for the PDFDadi editor (Part 1).
 *
 * The editor ships only the 14 PDF base-14 fonts (no embedding). When a document
 * or the user requests a family that isn't one of those, {@link resolveFont} maps
 * it to the closest base-14 equivalent and reports the substitution so the UI can
 * warn the user. Bold/italic variants are chosen at export time via weight, not
 * here — this resolver only picks the family.
 */

/** The result of resolving a requested font family against available fonts. */
export interface ResolvedFont {
  /** The pdf-lib / base-14 family to actually use. */
  family: string;
  /** Display label for menus. */
  label: string;
  /** True if the family is a PDF base-14 font (no embedding needed). */
  standard: boolean;
  /** True if the requested family wasn't available and was mapped to a substitute. */
  substituted: boolean;
  /** When substituted, a short user-facing reason. */
  reason?: string;
}

/** Common family aliases that map to a base-14 font (looked up case-insensitively). */
const ALIASES = new Map<string, string>([
  ["arial", "Helvetica"],
  ["times", "Times-Roman"],
  ["times new roman", "Times-Roman"],
  ["courier new", "Courier"],
]);

const PROVIDER = new StandardFontsProvider();
const BASE14: FontDescriptor[] = PROVIDER.list();
const BASE14_BY_LOWER = new Map<string, FontDescriptor>();
for (const f of BASE14) BASE14_BY_LOWER.set(f.family.toLowerCase(), f);

/**
 * Maps a family name (already lowercased) to a base-14 family by category.
 * serif/times → Times-Roman; mono/courier → Courier; else → Helvetica.
 */
function categorize(norm: string): string {
  if (norm.includes("serif") || norm.includes("times")) return "Times-Roman";
  if (norm.includes("mono") || norm.includes("courier")) return "Courier";
  return "Helvetica";
}

/**
 * Resolves a requested font family to an available base-14 font.
 *
 * Exact (case-insensitive, trimmed) base-14 matches return with `substituted:false`.
 * Known aliases and category fallbacks return with `substituted:true` and a
 * user-facing `reason`. Always returns a `standard:true` base-14 family.
 */
export function resolveFont(requestedFamily: string): ResolvedFont {
  const requestedName = requestedFamily.trim();
  const norm = requestedName.toLowerCase();

  const exact = BASE14_BY_LOWER.get(norm);
  if (exact) {
    return { family: exact.family, label: exact.label, standard: true, substituted: false };
  }

  const aliasedFamily = ALIASES.get(norm) ?? categorize(norm);
  const desc = BASE14_BY_LOWER.get(aliasedFamily.toLowerCase());
  if (!desc) throw new Error(`No base-14 font for "${aliasedFamily}"`);
  return {
    family: desc.family,
    label: desc.label,
    standard: true,
    substituted: true,
    reason: `${requestedName} is not embedded; using ${desc.family}`,
  };
}

/** Returns the 14 PDF base-14 fonts (always available, no embedding required). */
export function availableFonts(): FontDescriptor[] {
  return PROVIDER.list();
}

// ---------------------------------------------------------------------------
// Italic as a FAMILY choice (P1 Phase H).
// ---------------------------------------------------------------------------

/**
 * Italic is a FAMILY in the base-14 world, not a boolean.
 *
 * Base-14 exposes posture as separate PostScript families
 * (`Helvetica-Oblique`, `Times-Italic`), so italic is represented by moving the
 * family within the matrix below rather than by a new `italic` field on
 * TextObject. That keeps `EDITOR_FORMAT_VERSION` at 6 with no migration.
 *
 * Bold and italic stay INDEPENDENT: `resolveStandardFont` derives bold from
 * `fontWeight >= 600` OR a "bold" family token, and italic from an
 * `/italic|oblique/` family token. So `fontWeight` remains the sole bold
 * control while italic rides on the family, and all four permutations map to a
 * real base-14 font.
 *
 * Verified with pdf-lib rather than assumed (both matter):
 *  - ASCENT is identical for every upright/oblique pair, so toggling posture
 *    cannot shift a baseline — the C1/C2 imported-text invariant holds.
 *  - ADVANCE WIDTHS are identical for Helvetica and Courier obliques, but the
 *    TIMES italics are genuinely narrower (~1.5-3.5% on mixed text). That is a
 *    real property of the typeface, not a defect: the exporter measures with the
 *    embedded font's own metrics, and it wraps only on explicit newlines, so a
 *    Times italic line re-measures correctly and cannot silently re-flow. It
 *    does change center/right alignment slack, which is the correct result of
 *    choosing a narrower face.
 */
const ITALIC_OF = new Map<string, string>([
  ["Helvetica", "Helvetica-Oblique"],
  ["Helvetica-Bold", "Helvetica-BoldOblique"],
  ["Times-Roman", "Times-Italic"],
  ["Times-Bold", "Times-BoldItalic"],
  ["Courier", "Courier-Oblique"],
  ["Courier-Bold", "Courier-BoldOblique"],
]);

/** The inverse map, derived so the two can never disagree. */
const UPRIGHT_OF = new Map<string, string>(
  [...ITALIC_OF.entries()].map(([upright, italic]) => [italic, upright]),
);

/**
 * True when a family name denotes an italic/oblique face.
 *
 * Mirrors the `/italic|oblique/` test in `resolveStandardFont` so the canvas,
 * the inspector and the exporter agree on posture from the same evidence.
 */
export function familyIsItalic(family: string): boolean {
  return /italic|oblique/i.test(family ?? "");
}

/**
 * Whether a family has an italic counterpart at all.
 *
 * `Symbol` and `ZapfDingbats` are glyph fonts with no oblique variant in
 * base-14, so Italic is genuinely unavailable for them — the caller disables the
 * control and shows `reason` (H24) rather than offering a toggle that would
 * silently do nothing.
 */
export function italicSupport(family: string): { supported: boolean; reason?: string } {
  const canonical = resolveFont(family).family;
  if (ITALIC_OF.has(canonical) || UPRIGHT_OF.has(canonical)) return { supported: true };
  return { supported: false, reason: `${canonical} has no italic variant` };
}

/**
 * The family that expresses `family` with italic turned on/off.
 *
 * The input is canonicalized through {@link resolveFont} first, so an arbitrary
 * or imported family name ("Arial", a PDF subset name) lands on the base-14
 * family the editor can actually draw. Families with no italic variant are
 * returned unchanged — the toggle is a no-op rather than a lie.
 *
 * Bold is preserved across the switch, because the matrix pairs each weight with
 * its own posture (`Helvetica-Bold` ↔ `Helvetica-BoldOblique`).
 */
export function withItalic(family: string, on: boolean): string {
  const canonical = resolveFont(family).family;
  if (on) return ITALIC_OF.get(canonical) ?? canonical;
  return UPRIGHT_OF.get(canonical) ?? canonical;
}
