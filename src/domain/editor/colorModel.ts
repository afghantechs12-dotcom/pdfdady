import type { EditorColor } from "./objects";

/**
 * The pure colour model behind the editor's colour controls.
 *
 * WHY THIS EXISTS. Colour used to travel through the inspector as a CSS STRING:
 * `editorColorToCss(fill)` produced `rgba(0.2,0.4,1,0.5)`-style text, that text
 * was shown to the user in a monospace input, and `cssToEditorColor` parsed it
 * back. Two things were wrong with that. Raw `rgba(...)` is a developer
 * representation, not a property value a person edits (an explicit acceptance
 * criterion: no normal property control displays raw rgba). And a string
 * round-trip is lossy and throwy — the parser rejects half of what a person
 * would reasonably type, and each keystroke risked an exception.
 *
 * So the control contract is {@link EditorColor} in, {@link EditorColor} out —
 * the canonical document type — and everything a human sees (hex, 0-255 RGB,
 * HSL degrees/percents, opacity percent) is a FORMATTING concern that lives
 * here, next to a tolerant parser for each.
 *
 * Every function is pure and total: parsers return `null` rather than throwing,
 * because they run on every keystroke of a partially-typed value.
 */

/** Channel floats are 0..1 in the document model; clamp before formatting. */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function clampTo(n: number, max: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > max ? max : n;
}

/** 0..1 float → 0..255 integer. */
export function to255(channel: number): number {
  return Math.round(clamp01(channel) * 255);
}

/** 0..255 (any real) → 0..1 float. */
export function from255(value: number): number {
  return clampTo(value, 255) / 255;
}

function hex2(value255: number): string {
  return value255.toString(16).padStart(2, "0").toUpperCase();
}

/**
 * `#RRGGBB`, or `#RRGGBBAA` when `withAlpha` is set AND the colour is not fully
 * opaque. Uppercase, always 7 or 9 characters — a stable width matters because
 * this string is the value of a text input the user edits in place.
 */
export function formatHex(color: EditorColor, withAlpha = false): string {
  const base = `#${hex2(to255(color.r))}${hex2(to255(color.g))}${hex2(to255(color.b))}`;
  if (!withAlpha || color.a >= 1) return base;
  return `${base}${hex2(to255(color.a))}`;
}

/**
 * Parse what a person actually types into a hex field: with or without `#`,
 * 3/4/6/8 digits, any case, surrounding whitespace. Returns `null` for anything
 * else — including a half-typed `#7C3` prefix of a 6-digit value, which is why
 * callers must keep the user's draft text and only commit on a successful parse.
 *
 * A 3- or 4-digit value expands by digit doubling (`#7C3` → `#77CC33`), the CSS
 * rule, so a shorthand a user copies from a stylesheet means the same colour
 * here as it does there. Alpha defaults to fully opaque when not supplied.
 */
export function parseHex(input: string): EditorColor | null {
  const raw = input.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]+$/.test(raw)) return null;
  let digits: string;
  if (raw.length === 3 || raw.length === 4) {
    digits = raw.split("").map((d) => d + d).join("");
  } else if (raw.length === 6 || raw.length === 8) {
    digits = raw;
  } else {
    return null;
  }
  const channel = (index: number) => parseInt(digits.slice(index * 2, index * 2 + 2), 16) / 255;
  return {
    r: channel(0),
    g: channel(1),
    b: channel(2),
    a: digits.length === 8 ? channel(3) : 1,
  };
}

export interface HslColor {
  /** Degrees, 0..360. */
  h: number;
  /** Percent, 0..100. */
  s: number;
  /** Percent, 0..100. */
  l: number;
}

/**
 * RGB (0..1 floats) → HSL in the units the UI shows: degrees and percents.
 * Rounded, because the fields are integer steppers — an HSL round-trip is
 * therefore NOT bit-exact, which is exactly why the popover keeps RGB as the
 * stored truth and only derives HSL for display (see `hslToRgb`).
 */
export function rgbToHsl(color: EditorColor): HslColor {
  const r = clamp01(color.r);
  const g = clamp01(color.g);
  const b = clamp01(color.b);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l: Math.round(l * 100) };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h: Math.round(h) % 360, s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** HSL in UI units (degrees/percents) → RGB floats, preserving `alpha`. */
export function hslToRgb(hsl: HslColor, alpha = 1): EditorColor {
  // Hue wraps rather than clamps: dragging a hue field past 360 should come
  // round to red, not stick at magenta.
  const h = ((hsl.h % 360) + 360) % 360;
  const s = clampTo(hsl.s, 100) / 100;
  const l = clampTo(hsl.l, 100) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const sector = Math.floor(h / 60) % 6;
  const table: Array<[number, number, number]> = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const [r, g, b] = table[sector];
  return { r: r + m, g: g + m, b: b + m, a: clamp01(alpha) };
}

/**
 * Equality at the precision a person can act on. Two colours whose 8-bit
 * channels and 8-bit alpha agree are the same colour for swatch de-duplication
 * and for "is this swatch the current value" — comparing raw floats would show
 * two visually identical recents, and would fail to mark the active swatch after
 * a hex round-trip introduced a 1/255 rounding difference.
 */
export function sameColor(a: EditorColor | null, b: EditorColor | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    to255(a.r) === to255(b.r) &&
    to255(a.g) === to255(b.g) &&
    to255(a.b) === to255(b.b) &&
    to255(a.a) === to255(b.a)
  );
}

/** How many recent colours the popover remembers. */
export const RECENT_COLOR_LIMIT = 12;

/**
 * Most-recent-first, de-duplicated, capped. Re-picking a colour already in the
 * list MOVES it to the front rather than adding a duplicate, so the row stays a
 * useful history instead of filling with one repeated value.
 *
 * De-duplication ignores alpha (`sameColor` does not) — a swatch row is about
 * hue choices, and remembering "blue at 40%" and "blue at 100%" as two entries
 * spends the twelve slots on one colour.
 */
export function pushRecentColor(
  recents: readonly EditorColor[],
  color: EditorColor,
  limit = RECENT_COLOR_LIMIT,
): EditorColor[] {
  const opaque = { ...color, a: 1 };
  const rest = recents.filter((c) => !sameColor({ ...c, a: 1 }, opaque));
  return [opaque, ...rest].slice(0, Math.max(0, limit));
}

/**
 * The brand ramp plus a neutral ramp, offered as the always-available swatches.
 *
 * These are the ONLY hard-coded colours in the module and they mirror
 * `styles/tokens.ts` / `styles/editor.ts`. They exist so a user reaching for
 * "the PDFDadi purple" gets the real token rather than eyeballing a hex.
 */
export const BRAND_SWATCH_HEXES: readonly string[] = [
  "#7C3AED", // brand primary
  "#6D28D9", // brand primary hover
  "#A78BFA",
  "#EC4899", // AI pink
  "#DB2777",
  "#EF4444",
  "#F59E0B",
  "#10B981",
  "#0EA5E9",
  "#1F2430", // editor ink
  "#667085", // editor muted
  "#FFFFFF",
] as const;

/** {@link BRAND_SWATCH_HEXES} as document colours. */
export function brandSwatches(): EditorColor[] {
  // Every entry is a literal 6-digit hex, so the parse cannot fail; the `?? `
  // keeps the function total without asserting.
  return BRAND_SWATCH_HEXES.map((hex) => parseHex(hex) ?? { r: 0, g: 0, b: 0, a: 1 });
}

/**
 * De-duplicate an arbitrary list of colours (the caller collects them from the
 * document) into a capped, stable-ordered swatch row. Alpha is dropped for the
 * same reason as in {@link pushRecentColor}: this is a palette, not a style list.
 */
export function uniqueSwatches(colors: readonly EditorColor[], limit = RECENT_COLOR_LIMIT): EditorColor[] {
  const out: EditorColor[] = [];
  for (const color of colors) {
    const opaque = { ...color, a: 1 };
    if (out.some((c) => sameColor(c, opaque))) continue;
    out.push(opaque);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Relative luminance (WCAG 2.x). Used to decide whether a swatch's selected-state
 * ring and checkmark should be dark or light: a white swatch with a white check
 * is an invisible selection state, and selection must never be conveyed by a
 * treatment the user cannot see.
 */
export function relativeLuminance(color: EditorColor): number {
  const channel = (c: number) => {
    const v = clamp01(c);
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/**
 * `"dark"` when a swatch needs dark-on-light contrast markings. The 0.45
 * threshold sits slightly above mid-luminance because a check drawn on a
 * mid-tone reads better dark than light.
 */
export function swatchInkTone(color: EditorColor): "dark" | "light" {
  return relativeLuminance(color) > 0.45 ? "dark" : "light";
}

/**
 * The accessible name for a colour swatch. Icon-only swatches need a name that
 * says what the colour IS, and hex is the only description that is both precise
 * and short; the opacity is appended only when it is meaningful.
 */
export function describeColor(color: EditorColor | null, emptyLabel = "No fill"): string {
  if (color === null) return emptyLabel;
  const hex = formatHex(color);
  if (color.a >= 1) return hex;
  return `${hex} at ${Math.round(clamp01(color.a) * 100)}% opacity`;
}
