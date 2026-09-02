import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./Button";
import { IconButton } from "@/components/app/primitives";
import { focusRing } from "@/styles/tokens";

/**
 * U3 — focus-visible is preserved.
 *
 * The interesting assertion is the repository-wide one. `outline-none` is used
 * in 87 files, and it is correct in all of them ONLY because each one replaces
 * the indicator it suppressed. Removing one replacement is invisible in review,
 * in a screenshot, and to a mouse user — a keyboard user simply loses track of
 * where they are (WCAG 2.4.7). A per-component test cannot catch that; a scan
 * over every class string can, and it is why this file scans instead of
 * enumerating.
 *
 * Two real defects this predicate found when it was first written: nothing (the
 * public primitives were already consistent) and the command palette's search
 * input, which suppressed its outline and provided nothing, relying on being
 * autofocused. That one is fixed on the row via `focus-within`.
 */

/** A class string carries an indicator if some focus state changes something visible. */
const INDICATOR = /focus(?:-visible|-within)?:(?:ring|outline-(?!none)|border|shadow|bg)/;

const tsxFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });

/**
 * Adjacent string literals joined by `+` are one class list. Collapsing them
 * first is what stops `inputBase` in PasswordField — whose ring lives in the
 * second half of the concatenation — from reading as a missing indicator.
 */
const classStrings = (file: string): string[] => {
  const source = readFileSync(file, "utf8").replace(/"\s*\+\s*\n?\s*"/g, "");
  return [...source.matchAll(/"([^"\n]*\boutline-none\b[^"\n]*)"/g)].map((m) => m[1]);
};

describe("U3 — focus-visible is preserved", () => {
  const files = [...tsxFiles("components"), ...tsxFiles("app"), ...tsxFiles("styles")];

  it("scans a realistic number of files, so a passing run means something", () => {
    expect(files.length).toBeGreaterThan(150);
    const withOutlineNone = files.filter((f) => classStrings(f).length > 0);
    expect(withOutlineNone.length).toBeGreaterThan(60);
  });

  it("never suppresses the native outline without replacing the indicator", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const classes of classStrings(file)) {
        // A permanently visible ring counts: the editor's inline rename input
        // carries `shadow-[0_0_0_3px_…]` at all times and appears only while
        // focused, so there is always an indicator on the focused element.
        if (INDICATOR.test(classes) || /\bshadow-\[/.test(classes)) continue;
        offenders.push(`${file}: ${classes.slice(0, 100)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps one shared focus treatment for the public site", () => {
    expect(focusRing).toMatch(/focus-visible:ring-2/);
    expect(focusRing).toMatch(/focus-visible:ring-primary\/40/);
    // An offset against the page background, so the ring is not swallowed by a
    // control that sits flush against a same-coloured surface.
    expect(focusRing).toMatch(/focus-visible:ring-offset-2/);
  });

  it("renders a focus ring on the shared button, as a button and as a link", () => {
    const asButton = renderToStaticMarkup(h(Button, { children: "Run" }));
    const asLink = renderToStaticMarkup(h(Button, { href: "/tools", children: "Tools" }));
    for (const html of [asButton, asLink]) {
      expect(html).toContain("focus-visible:ring-2");
      expect(html).toMatch(/focus-visible:ring-[a-z]/);
    }
    // A disabled button keeps its ring classes; `disabled` already removes it
    // from the tab order, and stripping the ring would leave a *focusable*
    // element with no indicator if a call site ever renders it as a link.
    expect(renderToStaticMarkup(h(Button, { disabled: true, children: "Run" }))).toContain(
      "focus-visible:ring-2",
    );
  });

  it("renders a focus ring on the app icon button, which has no text to fall back on", () => {
    const html = renderToStaticMarkup(
      h(IconButton, { label: "Workspace settings", icon: h("svg") }),
    );
    expect(html).toContain("focus-visible:ring-2");
    // Icon-only, so the accessible name is the only thing a screen reader gets.
    expect(html).toContain('aria-label="Workspace settings"');
  });

  it("never uses colour alone to show focus", () => {
    // `focus-visible:text-…` or a bare colour swap fails 1.4.11/2.4.7 for a
    // user who cannot distinguish the two colours. Every indicator string in
    // the shared tokens changes geometry: a ring, an outline or a border.
    expect(focusRing).not.toMatch(/focus-visible:text-/);
    expect(INDICATOR.test("focus-visible:text-primary")).toBe(false);
  });
});
