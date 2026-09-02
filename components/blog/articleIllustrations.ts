import type { IconTone } from "@/styles/tokens";

/**
 * Article illustrations for the blog (launch polish P1-12).
 *
 * The cards previously drew one generic lucide icon on a large pastel
 * rectangle. At card size that reads as a placeholder — every article looked
 * like the same unfinished component with a different glyph.
 *
 * These are small workflow diagrams instead: each shows the transformation the
 * article is about (A + B → one file, big → small, page → rotated page). They
 * are inline SVG rather than images, which means:
 *
 *   - no image requests, no `next/image`, no CDN, no layout shift;
 *   - they inherit `currentColor` from the existing `iconToneClasses` tone, so
 *     they stay inside the established palette instead of introducing a second;
 *   - they render on the server with the rest of the card.
 *
 * A fixed 200×96 viewBox with `preserveAspectRatio` keeps every card's hero the
 * same shape, so the grid's rows stay aligned regardless of illustration.
 *
 * Accessibility: these are decorative. The article title adjacent to them
 * carries the meaning, so they are `aria-hidden` at the call site and carry no
 * `<title>`. Announcing "two documents becoming one document" before every
 * heading would be noise, not information.
 */

/** The canonical viewBox every illustration is drawn in. */
export const ILLUSTRATION_VIEWBOX = "0 0 200 96";

export type IllustrationId =
  | "merge"
  | "compress"
  | "protect"
  | "split"
  | "convert"
  | "edit"
  | "rotate"
  | "paginate"
  | "crop"
  | "generic";

/**
 * Maps an article to its diagram.
 *
 * Keyed by the article's existing `heroIcon`, so adding an article needs no new
 * field and an unrecognised icon degrades to the generic document mark rather
 * than rendering nothing.
 */
const BY_HERO_ICON: Record<string, IllustrationId> = {
  Combine: "merge",
  Minimize2: "compress",
  ShieldCheck: "protect",
  Scissors: "split",
  Image: "convert",
  PencilRuler: "edit",
  RotateCw: "rotate",
  Hash: "paginate",
  Crop: "crop",
};

export function illustrationForIcon(heroIcon: string): IllustrationId {
  return BY_HERO_ICON[heroIcon] ?? "generic";
}

/**
 * Tone → the diagram's single stroke/fill colour.
 *
 * Depth inside a diagram comes from per-element opacity, not from a second
 * colour: one hue per card means a diagram can never drift outside the tone the
 * card already uses, and the palette stays exactly as wide as it was.
 */
export const illustrationToneClasses: Record<IconTone, { strong: string }> = {
  purple: { strong: "text-purple-500" },
  blue: { strong: "text-blue-500" },
  green: { strong: "text-green-500" },
  orange: { strong: "text-orange-500" },
  pink: { strong: "text-pink-500" },
  teal: { strong: "text-teal-500" },
  red: { strong: "text-red-500" },
};
