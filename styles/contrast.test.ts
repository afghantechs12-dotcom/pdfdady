import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * U1 (contrast half) / §15 — every token pair the product uses for TEXT clears
 * WCAG 1.4.3, and the two tokens that cannot are never used as text.
 *
 * Why this is a unit test and not a browser assertion: measuring rendered
 * contrast means resolving each element's effective background through its
 * ancestors, and the marketing surfaces stack tinted panels on gradients on blur
 * auras. A probe doing that produces confident false positives — it reads a
 * transparent parent as white and fails text that is legible on screen. The
 * palette, on the other hand, is a closed set of ~40 declared values, and a pair
 * either clears the ratio or it does not.
 *
 * The ratios come from the WCAG 2.x relative-luminance formula, and the hexes are
 * READ OUT OF `tailwind.config.ts` rather than copied, so retinting a token
 * without checking it fails here.
 */
const CONFIG = readFileSync(join(__dirname, "..", "tailwind.config.ts"), "utf8");

/**
 * The `colors` block flattened to dotted paths — `navy.DEFAULT`, `app.text`,
 * `editor.text`. Dotted and not bare: three namespaces declare a `text`, a
 * `muted` and a `border`, and a flat map would silently answer with whichever
 * came last. That is exactly the confusion the namespaces exist to prevent.
 */
const declared = (() => {
  const block = CONFIG.slice(CONFIG.indexOf("colors: {"), CONFIG.indexOf("borderRadius: {"));
  const found = new Map<string, string>();
  const path: string[] = [];
  for (const line of block.split("\n")) {
    const open = /^\s*(\w+):\s*\{\s*$/.exec(line);
    if (open) {
      path.push(open[1]);
      continue;
    }
    if (/^\s*\},?\s*$/.test(line)) {
      path.pop();
      continue;
    }
    const leaf = /^\s*(\w+):\s*"(#[0-9A-Fa-f]{6})"/.exec(line);
    if (leaf) found.set([...path.slice(1), leaf[1]].join("."), leaf[2].toUpperCase());
  }
  return found;
})();

const hex = (name: string) => {
  const value = declared.get(name);
  if (!value) throw new Error(`token not declared in tailwind.config.ts: ${name}`);
  return value;
};

const luminance = (value: string) => {
  const channel = (offset: number) => {
    const c = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};

const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const WHITE = "#FFFFFF";

/** Foreground/background token pairs that carry real body copy. */
const BODY_TEXT: ReadonlyArray<readonly [string, string]> = [
  ["navy.DEFAULT", "white"],
  ["navy.DEFAULT", "lavender"],
  ["navy.soft", "white"],
  ["navy.soft", "lavender"],
  ["primary.DEFAULT", "white"],
  ["primary.DEFAULT", "lavender"],
  ["primary.DEFAULT", "primary.soft"],
  ["success", "white"],
  ["app.text", "app.bg"],
  ["app.text", "app.surface"],
  ["app.text", "app.subtle"],
  ["app.muted", "app.bg"],
  ["app.muted", "app.surface"],
  ["app.muted", "app.subtle"],
  ["app.sidebartext", "app.sidebar"],
  ["app.sidebartext", "app.sidebaractive"],
  ["app.sidebartext", "app.sidebarhover"],
  ["app.sidebartext", "app.sidebarmenu"],
  ["editor.text", "editor.bg"],
  ["editor.text", "editor.surface"],
  ["editor.text", "editor.subtle"],
  ["editor.muted", "editor.bg"],
  ["editor.muted", "editor.surface"],
  ["editor.accent", "editor.surface"],
  ["editor.accent", "editor.accentsoft"],
];

/** `white` is not a declared token — Tailwind supplies it. */
const colour = (name: string) => (name === "white" ? WHITE : hex(name));

describe("§15 — declared token pairs clear WCAG 1.4.3", () => {
  it("reads the palette out of the config rather than restating it", () => {
    // Vacuity floor: a parser that found nothing would make every loop below pass.
    expect(declared.size).toBeGreaterThan(30);
    expect(hex("navy.DEFAULT")).toBe("#1E1B2E");
    expect(hex("app.sidebar")).toBe("#07111F");
    expect(hex("editor.text")).toBe("#1F2430");
    // Three namespaces, three different `text` values, none of them shadowed.
    expect(new Set([hex("app.text"), hex("editor.text"), hex("navy.DEFAULT")]).size).toBe(3);
  });

  it("clears 4.5:1 for every body-text pair", () => {
    const failures: string[] = [];
    for (const [fg, bg] of BODY_TEXT) {
      const value = ratio(colour(fg), colour(bg));
      if (value < 4.5) failures.push(`${fg} on ${bg}: ${value.toFixed(2)}:1`);
    }
    expect(failures).toEqual([]);
  });

  it("clears 4.5:1 for white text on both filled-button surfaces", () => {
    // The primary button and its hover state. A hover that dropped below the
    // threshold would fail only while the pointer was on it — invisible in review.
    expect(ratio(WHITE, hex("primary.DEFAULT"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(WHITE, hex("primary.hover"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(WHITE, hex("app.sidebar"))).toBeGreaterThanOrEqual(4.5);
  });

  it("clears 3:1 for the editor's three signal colours, which must also differ", () => {
    // 1.4.11: the selection frame and the snap guide are non-text information.
    for (const token of ["editor.accent", "editor.selection", "editor.guide"]) {
      expect(ratio(hex(token), WHITE)).toBeGreaterThanOrEqual(3);
    }
    const signals = new Set(["editor.accent", "editor.selection", "editor.guide"].map(hex));
    expect(signals.size).toBe(3);
  });

  it("keeps the two sub-threshold accents out of text", () => {
    // `warning` (2.15:1 on white) and `aipink` (3.53:1) are fill and icon colours.
    // The AI badge used `text-aipink` on its own 10% tint at 3.13:1 until Phase 6.
    expect(ratio(hex("warning"), WHITE)).toBeLessThan(4.5);
    expect(ratio(hex("aipink"), WHITE)).toBeLessThan(4.5);
    const sources = ["components", "app"].flatMap((dir) => walk(join(__dirname, "..", dir)));
    const offenders = sources.filter((file) => {
      const source = readFileSync(file, "utf8");
      // A bullet glyph and an icon are non-text content at 3:1; a class list that
      // also sets a font size or weight is prose, and owes 4.5:1.
      return [...source.matchAll(/"([^"\n]*\btext-(?:warning|aipink)\b[^"\n]*)"/g)].some(
        ([, cls]) => /\bfont-|\btext-(?:xs|sm|base|lg|xl|\[)/.test(cls),
      );
    });
    expect(offenders).toEqual([]);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry: string) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx$/.test(entry) ? [full] : [];
  });
}
