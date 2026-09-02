import type { EditorColor } from "@/src/domain/editor/objects";
import { formatHex, parseHex, sameColor, uniqueSwatches } from "@/src/domain/editor/colorModel";

/**
 * The user's own saved swatches — the palette they build up deliberately, as
 * opposed to `collectDocumentColors` (derived from content) and recents
 * (derived from behaviour). Persisted per browser so a palette survives a
 * reload, because a saved swatch that disappears on refresh is worse than no
 * saved swatches at all.
 *
 * Storage is a plain array of hex strings, not serialised EditorColors: hex is
 * forward-compatible, human-inspectable in devtools, and cannot carry a
 * malformed float. Parsing is total — an unreadable or tampered entry is
 * dropped rather than throwing, so a corrupt key can never break the editor.
 */
export const SAVED_SWATCHES_KEY = "pdfdadi.editor.savedSwatches";

/** How many swatches a user may save. Bounded so the popover cannot grow unbounded. */
export const SAVED_SWATCH_LIMIT = 18;

/** Parse the persisted payload, dropping anything unreadable. Never throws. */
export function parseSavedSwatches(raw: string | null): EditorColor[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const colors: EditorColor[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const parsed = parseHex(entry);
    if (parsed) colors.push(parsed);
  }
  return uniqueSwatches(colors, SAVED_SWATCH_LIMIT);
}

/** Serialise for storage. */
export function serializeSavedSwatches(colors: readonly EditorColor[]): string {
  return JSON.stringify(colors.slice(0, SAVED_SWATCH_LIMIT).map((c) => formatHex(c)));
}

/**
 * Add a swatch. Appends rather than prepending: a saved palette is a deliberate,
 * stable arrangement, and reordering it on every save would move the swatch the
 * user is aiming at. Saving a colour already present is a no-op (returns the
 * same array identity, so React can skip the write).
 */
export function addSavedSwatch(
  saved: readonly EditorColor[],
  color: EditorColor,
  limit = SAVED_SWATCH_LIMIT,
): EditorColor[] {
  const opaque = { ...color, a: 1 };
  if (saved.some((c) => sameColor(c, opaque))) return saved as EditorColor[];
  if (saved.length >= limit) return saved as EditorColor[];
  return [...saved, opaque];
}

/** Remove a swatch by colour. Returns the same array identity when absent. */
export function removeSavedSwatch(
  saved: readonly EditorColor[],
  color: EditorColor,
): EditorColor[] {
  const opaque = { ...color, a: 1 };
  if (!saved.some((c) => sameColor(c, opaque))) return saved as EditorColor[];
  return saved.filter((c) => !sameColor(c, opaque));
}

/** True when the palette is full, so the UI can explain the refusal instead of ignoring the click. */
export function savedSwatchesFull(saved: readonly EditorColor[], limit = SAVED_SWATCH_LIMIT): boolean {
  return saved.length >= limit;
}
