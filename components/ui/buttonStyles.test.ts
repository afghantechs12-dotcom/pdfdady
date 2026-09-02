import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUTTON_BASE,
  BUTTON_SIZES,
  BUTTON_VARIANTS,
  type ButtonVariant,
} from "./buttonStyles";

/**
 * The homepage dark CTA ("Start with a file, or start with a Workspace")
 * shipped with an invisible label: a white button with white text.
 *
 * Root cause: `cn` is a plain string joiner, so a call-site
 * `className="bg-white text-navy"` does not *replace* the variant's
 * `bg-primary text-white` — both are emitted and the compiled stylesheet's
 * source order decides. `.bg-white` happens to sort after `.bg-primary`, so the
 * background flipped to white; `.text-navy` sorts *before* `.text-white`, so the
 * foreground stayed white. White on white.
 *
 * These assertions lock in the structural fix rather than the pixel: colour is
 * variant-owned and self-consistent, and no call site re-opens the hole by
 * passing colour utilities through `className`.
 */

const VARIANT_NAMES = Object.keys(BUTTON_VARIANTS) as ButtonVariant[];

const classesOf = (variant: ButtonVariant) =>
  BUTTON_VARIANTS[variant].split(/\s+/).filter(Boolean);

/** Bare `text-*` colour, ignoring `hover:`/`focus-visible:` prefixes and sizes. */
const hasBareForeground = (variant: ButtonVariant) =>
  classesOf(variant).some(
    (c) => c.startsWith("text-") && !c.includes(":") && !/^text-(xs|sm|base|lg|xl)$/.test(c),
  );

describe("button variants are self-consistent", () => {
  it("exposes a non-trivial variant set", () => {
    // Guards against the map being emptied and every it.each below passing
    // vacuously.
    expect(VARIANT_NAMES.length).toBeGreaterThanOrEqual(6);
  });

  it.each(VARIANT_NAMES)("%s declares its own foreground colour", (variant) => {
    expect(hasBareForeground(variant)).toBe(true);
  });

  it.each(VARIANT_NAMES)("%s declares its own focus ring colour", (variant) => {
    // The base class sets `ring-2` but intentionally no ring colour, so a
    // dark-surface variant never has to out-sort a light-surface default.
    expect(
      classesOf(variant).some((c) => c.startsWith("focus-visible:ring-")),
    ).toBe(true);
  });

  it("base classes set a ring width but no ring colour", () => {
    expect(BUTTON_BASE).toContain("focus-visible:ring-2");
    expect(BUTTON_BASE).not.toMatch(/focus-visible:ring-(?!2\b)[a-z]/);
  });

  it("dark-surface variants pair a light foreground with a visible ring", () => {
    // `onDark` is a light button on navy: dark text. `onDarkOutline` is a
    // transparent button on navy: light text. Both need a white-ish ring, since
    // a `primary/40` ring is near-invisible against navy.
    expect(BUTTON_VARIANTS.onDark).toContain("text-navy");
    expect(BUTTON_VARIANTS.onDark).not.toContain("text-white");
    expect(BUTTON_VARIANTS.onDarkOutline).toContain("text-white");

    for (const variant of ["onDark", "onDarkOutline"] as const) {
      expect(BUTTON_VARIANTS[variant]).toContain("focus-visible:ring-white");
      expect(BUTTON_VARIANTS[variant]).toContain("focus-visible:ring-offset-navy");
    }
  });

  it("every size sets a height and radius", () => {
    for (const [size, classes] of Object.entries(BUTTON_SIZES)) {
      expect(classes, size).toMatch(/\bh-\d/);
      expect(classes, size).toMatch(/\brounded-/);
    }
  });
});

describe("call sites do not override button colours via className", () => {
  const ROOT = join(__dirname, "..", "..");

  /**
   * Reads the CTA source and asserts it uses variants. Scoped to the component
   * that regressed rather than a repo-wide scan: a broad grep here would be a
   * lint rule wearing a test costume, and would fail on legitimate uses of
   * `className` for spacing.
   */
  it("FinalCTA uses dark-surface variants, not colour overrides", () => {
    const source = readFileSync(
      join(ROOT, "components", "home", "FinalCTA.tsx"),
      "utf8",
    );

    expect(source).toContain('variant="onDark"');
    expect(source).toContain('variant="onDarkOutline"');

    // The exact shape of the original bug: colour utilities handed to Button
    // through className.
    const buttonColourOverride =
      /<Button[^>]*className="[^"]*\b(?:bg-white|text-navy|text-white|bg-transparent)\b/s;
    expect(buttonColourOverride.test(source)).toBe(false);
  });
});
