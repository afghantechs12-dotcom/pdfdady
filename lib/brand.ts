/**
 * The single source of truth for the product's visible name.
 *
 * Component-level product names used to be typed inline in each surface, which
 * is how a rename becomes a grep across dozens of files that quietly misses a
 * few. Everything user-facing reads from here instead.
 *
 * Scope note: this is presentation only. Package names, API paths, cookie names
 * (`pdfdadi_session`), storage keys and the editor's serialized document format
 * (`.pdfdadi.json`) are contracts — renaming those would break sessions and
 * saved files, so they are deliberately NOT derived from this constant.
 *
 * SEO/marketing metadata has its own admin-editable source (`getSITE()` in
 * `lib/seo/adminRuntime`) so the site owner can change titles without a deploy.
 * `BRAND.name` matches its default; the authenticated shell uses this constant
 * because it is not admin-configurable content.
 */
export const BRAND = {
  /** Full product name, e.g. page titles and the authenticated sidebar. */
  name: "PDFDadi",
  /** Wordmark split for the two-tone logo treatment. */
  wordmark: { lead: "PDF", accent: "Dadi" },
  /** Short name for tight spaces (collapsed sidebar, mobile bar). */
  short: "PDFDadi",
} as const;

/** Builds a document title suffixed with the product name. */
export function brandTitle(page: string): string {
  return `${page} — ${BRAND.name}`;
}
