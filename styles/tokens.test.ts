import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import config from "@/tailwind.config";
import { aura, colors, zIndex } from "./tokens";

/**
 * The token files are only a design system if the tree cannot go around them.
 *
 * Phase 6's audit found two ways it was going around them. `zIndex` existed in
 * `styles/tokens.ts` and was imported by nothing and absent from the Tailwind
 * config, so the GLOBAL layer order shipped as five arbitrary escape hatches in
 * four files — `z-[55]`, `z-[60]`, `z-[70]`, `z-[75]`, `z-[100]` — i.e. one
 * ordering decision written down five times and nowhere authoritative. And six
 * marketing components hand-wrote a second palette as arbitrary values
 * (`bg-[#3B82F6]/25`, `stopColor="#4F46E5"`), two of whose colours were not
 * derivable from the brand set at all.
 *
 * Neither defect is visible from a rendered page: every one of those literals
 * *worked*. They are only visible from the shape of the source, so these
 * assertions read the source. Three things are locked:
 *
 *  1. The two token sources agree. A value present in `tokens.ts` but missing
 *     from the Tailwind mirror is a token no utility can reach — the exact
 *     failure that purged the `teal` icon tone once already.
 *  2. No component names a global layer with an arbitrary `z-[…]`.
 *  3. No page-chrome component names a colour with an arbitrary `…-[#hex]`
 *     utility, which is a style decision taken at a call site where a token
 *     belonged.
 */

const ROOT = join(__dirname, "..");

/** Tailwind's colour scale keys are lowercase; the TS tokens are camelCase. */
const flat = (group: Record<string, string>) =>
  Object.fromEntries(Object.entries(group).map(([k, v]) => [k.toLowerCase(), v]));

const themeColors = (config.theme?.extend?.colors ?? {}) as Record<
  string,
  Record<string, string> | string
>;
const themeZ = (config.theme?.extend?.zIndex ?? {}) as Record<string, string>;

const sourceFiles = (dir: string, acc: string[] = []) => {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) {
      if (entry !== "node_modules") sourceFiles(rel, acc);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      acc.push(rel);
    }
  }
  return acc;
};

const ALL = [...sourceFiles("components"), ...sourceFiles("app")];
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("the token sources agree", () => {
  it("walks a real tree", () => {
    // An empty walk would make every assertion below vacuously true.
    expect(ALL.length).toBeGreaterThan(100);
  });

  it("mirrors every named z layer into the Tailwind scale", () => {
    for (const [name, value] of Object.entries(zIndex)) {
      if (name === "base") continue; // `z-0` is Tailwind's own.
      expect(themeZ[name.toLowerCase()], `zIndex.${name}`).toBe(String(value));
    }
  });

  it("mirrors every decorative aura colour into the Tailwind palette", () => {
    expect(themeColors.aura).toEqual(flat(aura));
  });

  it("mirrors the brand colours that carry a Tailwind name", () => {
    const primary = themeColors.primary as Record<string, string>;
    expect(primary.DEFAULT).toBe(colors.primary);
    expect(primary.hover).toBe(colors.primaryHover);
    expect(primary.soft).toBe(colors.primarySoft);
    expect(primary.softhover).toBe(colors.primarySoftHover);
  });

  it("keeps styles/ in the Tailwind content globs", () => {
    // `iconToneClasses` and `focusRing` are class strings that live only in
    // styles/*.ts. Dropping this glob purges them: the teal icon tone once
    // shipped with no tile and no colour for exactly this reason.
    expect(config.content).toContain("./styles/**/*.{ts,tsx}");
  });
});

describe("no component re-opens a token with an arbitrary value", () => {
  it("names every global stacking layer", () => {
    const offenders = ALL.filter((f) => /\bz-\[[0-9]/.test(read(f)));
    expect(offenders).toEqual([]);
  });

  /**
   * Scoped to page chrome. Excluded on purpose, each for a reason the audit
   * records rather than for convenience:
   *
   * - `editor/canvas/*`, `EditorCanvas` — PDF-canvas and ruler colours. The
   *   brief forbids pushing page-theme tokens onto the document surface.
   * - `editor/color/*` — a colour PICKER's presets and parsing fixtures.
   * - `workspaces/*` — user-chosen tag colours and their computed contrast
   *   outputs (`#0f172a`/`#ffffff` are results, not choices).
   * - `app/icon`, `app/opengraph-image`, `brand-logo` — `next/og` renders these
   *   outside the DOM with inline styles; Tailwind does not reach them.
   * - `AuthShell` — the macOS window traffic lights, quoting another product's
   *   chrome, commented as deliberately untokenised at the call site.
   */
  const EXEMPT =
    /^(components\/(editor|workspaces)\/|components\/auth\/AuthShell|app\/icon|app\/opengraph-image|app\/\(marketing\)\/(brand-logo|blog))/;

  it("names every colour it applies through a utility", () => {
    const scanned = ALL.filter((f) => !EXEMPT.test(f));
    expect(scanned.length).toBeGreaterThan(50);
    const offenders = scanned.filter((f) => /-\[#[0-9A-Fa-f]{3,8}\b/.test(read(f)));
    expect(offenders).toEqual([]);
  });
});
