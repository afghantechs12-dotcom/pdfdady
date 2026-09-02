import type { EditorColor } from "@/src/domain/editor/objects";

/** Clamps a number to [0, 1]. */
function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Formats an alpha value in [0, 1] without trailing zeros (e.g. 1 → "1", 0.5 → "0.5"). */
function formatAlpha(a: number): string {
  return Number(a.toFixed(6)).toString();
}

/**
 * Converts an {@link EditorColor} to a CSS `rgba(r,g,b,a)` string, with r/g/b as
 * 0..255 integers and a as 0..1. Channels are clamped to [0,1] first.
 */
export function editorColorToCss(c: EditorColor): string {
  const r = Math.round(clamp01(c.r) * 255);
  const g = Math.round(clamp01(c.g) * 255);
  const b = Math.round(clamp01(c.b) * 255);
  const a = clamp01(c.a);
  return `rgba(${r},${g},${b},${formatAlpha(a)})`;
}

/**
 * Parses a CSS color string into an {@link EditorColor} (sRGB 0..1 floats).
 *
 * Supports `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(r,g,b)` and `rgba(r,g,b,a)` (comma
 * syntax). In `rgba()`, alpha is 0..1; in `#rrggbbaa`, alpha is 0..255. All
 * channels are clamped to [0,1]. Throws `Error` on unparseable input.
 */
export function cssToEditorColor(css: string): EditorColor {
  const s = css.trim().toLowerCase();

  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) throw new Error(`Unparseable color: "${css}"`);
    if (hex.length === 3) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      return { r: clamp01(r / 255), g: clamp01(g / 255), b: clamp01(b / 255), a: 1 };
    }
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return { r: clamp01(r / 255), g: clamp01(g / 255), b: clamp01(b / 255), a: 1 };
    }
    if (hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = parseInt(hex.slice(6, 8), 16);
      return { r: clamp01(r / 255), g: clamp01(g / 255), b: clamp01(b / 255), a: clamp01(a / 255) };
    }
    throw new Error(`Unparseable color: "${css}"`);
  }

  const match = s.match(/^rgba?\(([^)]+)\)$/);
  if (match) {
    const parts = match[1].split(",").map((p) => p.trim());
    if (parts.length < 3 || parts.length > 4) throw new Error(`Unparseable color: "${css}"`);
    const r = parseFloat(parts[0]);
    const g = parseFloat(parts[1]);
    const b = parseFloat(parts[2]);
    const a = parts.length === 4 ? parseFloat(parts[3]) : 1;
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) || Number.isNaN(a)) {
      throw new Error(`Unparseable color: "${css}"`);
    }
    return { r: clamp01(r / 255), g: clamp01(g / 255), b: clamp01(b / 255), a: clamp01(a) };
  }

  throw new Error(`Unparseable color: "${css}"`);
}

/**
 * Returns a new {@link EditorColor} with the given alpha (clamped to [0,1]),
 * keeping r/g/b unchanged.
 */
export function withAlpha(c: EditorColor, a: number): EditorColor {
  return { r: c.r, g: c.g, b: c.b, a: clamp01(a) };
}

/** Returns the color as an uppercase `#rrggbb` hex string (alpha is ignored). */
export function toHex(c: EditorColor): string {
  const r = Math.round(clamp01(c.r) * 255).toString(16).padStart(2, "0");
  const g = Math.round(clamp01(c.g) * 255).toString(16).padStart(2, "0");
  const b = Math.round(clamp01(c.b) * 255).toString(16).padStart(2, "0");
  return `#${r}${g}${b}`.toUpperCase();
}
