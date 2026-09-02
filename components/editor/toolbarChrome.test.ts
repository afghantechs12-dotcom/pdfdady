import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The toolbar's CHROME contract — control rhythm and accent hierarchy (premium
 * visual pass, P1 + P8).
 *
 * `toolbarLayout.test.ts` covers what the row CONTAINS (groups, priorities,
 * clustering, responsive cuts). Nothing covered how it LOOKS, and the row had
 * quietly accumulated three inconsistencies that a passing suite said nothing
 * about, each measured in Chrome via `scripts/editor-audit.mjs`:
 *
 *   1. undo/redo/Open/Export were `min-h-[38px]` in EVERY mode while the
 *      icon-mode TOOLS are 44px — two control rhythms in one strip, at the
 *      widths where touch targets matter most.
 *   2. Two disabled strengths: `opacity-40` on tools, `opacity-30` on
 *      `ActionButton` — i.e. the weaker one on undo/redo, the disabled state
 *      this editor shows more than any other.
 *   3. The ACTIVE tool and the PRESSED panel toggle had no hover response at
 *      all, so the one button a user most often re-aims at read as a static
 *      badge.
 *
 * Asserting on the source is the honest option: the test environment is Node
 * with no DOM and no layout engine, and `EditorToolbar` needs `EditorContext`
 * plus a `ResizeObserver` to render at all. A "does it look right" assertion
 * here would be theatre. What these DO check is the invariant that survives a
 * refactor: every control height comes from ONE function, there is exactly one
 * filled control, and "active tool" and "panel open" stay visually distinct.
 */

const ROOT = join(__dirname, "..", "..");
const source = readFileSync(join(ROOT, "components", "editor", "EditorToolbar.tsx"), "utf8");

/**
 * The source with comments stripped.
 *
 * Needed because these tests count class literals, and this file's comments
 * deliberately QUOTE the values that were removed (`opacity-30`, the old
 * hardcoded heights) so a future reader knows what the contract replaced. A
 * naive scan of the raw source reads that documentation as a live violation.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** The body of a named top-level function, up to the next `\nfunction`/`\n}`. */
function functionBody(name: string): string {
  const start = code.indexOf(`function ${name}(`);
  expect(start, `${name} should exist in EditorToolbar.tsx`).toBeGreaterThan(-1);
  const rest = code.slice(start);
  const end = rest.indexOf("\n}\n");
  return end > -1 ? rest.slice(0, end) : rest;
}

describe("EditorToolbar chrome — one control rhythm", () => {
  it("declares the row's control box in exactly one place", () => {
    expect(source).toContain("function rowControlBox(");
    const box = functionBody("rowControlBox");
    // The two measured metrics: 38px labelled, 44px (`min-h-11`) icon modes.
    expect(box).toContain("min-h-[38px]");
    expect(box).toContain("min-h-11");
  });

  it("writes no control height anywhere else", () => {
    /*
     * This is the assertion that actually holds the line. The heights were
     * duplicated across `toolButtonClass`, `toggleButtonClass`, `ActionButton`
     * and the Export button, and two of those four drifted. Counting the literal
     * across the whole file catches a fifth copy being added.
     */
    const boxBody = functionBody("rowControlBox");
    // Comment-stripped, so documenting the metric a control USED to hardcode
    // does not read as a live second copy of it.
    const outside = code.replace(boxBody, "");
    expect(outside).not.toMatch(/min-h-\[38px\]/);
    expect(outside).not.toMatch(/min-h-11/);
    // `min-w` too: the icon modes are square targets, not just tall ones.
    expect(boxBody).toContain("min-w-11");
    expect(outside).not.toMatch(/min-w-11/);
  });

  it("routes every control class through the shared box", () => {
    for (const fn of ["toolButtonClass", "toggleButtonClass", "ActionButton"]) {
      expect(functionBody(fn), fn).toContain("rowControlBox(");
    }
    // Export is inline markup rather than a helper, so it is checked by name.
    const exportButton = code.slice(code.indexOf('aria-label="Export edited PDF"') - 900);
    expect(exportButton).toContain("rowControlBox(labelled)");
  });
});

describe("EditorToolbar chrome — one disabled treatment", () => {
  it("uses a single disabled opacity across the row", () => {
    const opacities = new Set([...code.matchAll(/opacity-(\d+)/g)].map((m) => m[1]));
    // 40 = disabled. 60 = the dropdown chevron, which is decoration beside a
    // label, not a state — a different job, so a different value is correct.
    expect([...opacities].sort()).toEqual(["40", "60"]);
  });

  it("still explains a disabled control rather than only dimming it", () => {
    // `cursor-not-allowed` is the pointer half; the tooltip half is the tool's
    // `availability.reason`, asserted in `toolbarLayout.test.ts`.
    expect(source).toContain("cursor-not-allowed opacity-40");
    expect(source).toContain("availability.reason");
  });
});

describe("EditorToolbar chrome — the scroller cannot overlap its own row", () => {
  /*
   * A measured collision, not a hypothetical. The tool row is a flex ITEM of the
   * `overflow-x-auto` scroller, and it carried `min-w-0`, so it shrank below its
   * own content while its own overflow stayed `visible`: at 1100px the row's box
   * was 700.7px around 761px of buttons. The scroller read the shrunken box, saw
   * `scrollWidth === clientWidth`, and offered no scrollbar; the siblings after
   * the row (Organize Pages, More) were laid out from the box's edge, i.e. over
   * the spilled tools. "Crop image tool" occupied x 729-773 with "Organize pages"
   * at x 725.7-769.7 directly on top of it, and since SVG/DOM hit-testing gives
   * ties to the later sibling, clicking Crop opened the Pages panel.
   *
   * The invariant: inside a scroller, the flow children must keep their content
   * width, so the scroller's `scrollWidth` tells the truth and an overflow becomes
   * a scroll rather than a stack.
   */
  it("keeps the tool row at its content width inside the scroller", () => {
    const scroller = code.slice(code.indexOf("overflow-x-auto scrollbar-none"));
    const row = scroller.slice(0, scroller.indexOf('aria-label="Tools"'));
    expect(row).toContain("shrink-0");
    expect(row).not.toContain("min-w-0");
  });

  it("keeps every other flow child of the scroller unshrinkable too", () => {
    // Organize Pages and More are already `shrink-0`; this is the assertion that
    // catches a THIRD group being added without it, which would reproduce the
    // collision one sibling further along.
    const scroller = code.slice(code.indexOf("overflow-x-auto scrollbar-none"));
    const body = scroller.slice(0, scroller.indexOf("Pinned document actions") + 1 || scroller.length);
    const groups = [...body.matchAll(/className="flex ([^"]*)items-center gap-1"/g)].map((m) => m[1]);
    expect(groups.length).toBeGreaterThan(1);
    for (const g of groups) expect(g, `"${g}" must not shrink inside the scroller`).toContain("shrink-0");
  });

  it("still declares the scroller itself shrinkable — it is the thing that scrolls", () => {
    // `min-w-0 flex-1` on the scroller is correct and load-bearing: without it the
    // row pushes the pinned Export cluster off the right edge instead of scrolling.
    expect(code).toContain("flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none");
  });
});

describe("EditorToolbar chrome — no silently truncated label (P4)", () => {
  /*
   * Measured: the labelled row's scroller holds 1162px of content and gets
   * `container − 267.3px`, so it overflowed from 1290px to ≈1440px and "Organize
   * Pages" — at 139.8px the widest control in the row — was clipped 63px mid-word
   * at 1366px, reachable only by scrolling the toolbar sideways.
   *
   * The remedy allowed here is "readable labels where width permits, or icon +
   * tooltip", not an ellipsis. This control takes the second branch: it is the only
   * non-tool button in the row, and the same command is also reachable from the
   * left rail's Pages tab and the bottom capsule's page-overview toggle.
   */
  it("renders Organize Pages as icon + tooltip, never a label that can clip", () => {
    const at = code.indexOf('aria-label="Organize pages"');
    expect(at).toBeGreaterThan(-1);
    const button = code.slice(code.lastIndexOf("<button", at), code.indexOf("</button>", at));
    expect(button).not.toContain("Organize Pages");
    expect(button).not.toContain("labelled ?");
    // The name has to survive somewhere: pointer users get `title`, everyone else
    // gets the accessible name.
    expect(button).toContain("title=");
    expect(button).toContain('aria-label="Organize pages"');
    // Still on the row's shared control box, so dropping the label did not also
    // drop it out of the row's rhythm.
    expect(button).toContain("toggleButtonClass(organizePagesActive, labelled)");
  });

  it("keeps every remaining row label unclipped by never truncating it in the row", () => {
    /*
     * `whitespace-nowrap` and no `truncate`/`text-ellipsis` in the ROW: a label
     * that cannot fit must be removed by design (above), not shortened by the
     * layout engine behind the user's back.
     *
     * `ToolMenu` is deliberately exempt and is subtracted before the scan. Its
     * items are `flex-1 truncate` inside a fixed 208px menu, which is a guard
     * against a future tool label longer than the menu rather than a live
     * ellipsis: measured in Chrome with all three menus open at 1024/1100/1366/
     * 1600px, the widest item ("Rounded rectangle") reports scrollWidth 152
     * against clientWidth 152 — nothing clipped in menus of 2, 3, 7, 11 or 14
     * items. And a menu can grow its own width, which a pinned toolbar row cannot.
     */
    const row = code.replace(functionBody("ToolMenu"), "");
    expect(row).not.toMatch(/\btruncate\b/);
    expect(row).not.toMatch(/text-ellipsis/);
    // The row's labels are explicitly non-wrapping, i.e. they either fit or the
    // scroller scrolls — no reflow into a second line, no clipped glyphs.
    expect(code).toContain('<span className="whitespace-nowrap">');
  });
});

describe("EditorToolbar chrome — the accent hierarchy (P8)", () => {
  it("gives the active tool a pale accent surface, an accent ring and a hover", () => {
    const tone = functionBody("toolButtonClass");
    expect(tone).toContain("bg-editor-accentsoft");
    expect(tone).toContain("ring-editor-accent/25");
    // The defect: a pressed control with no hover response reads as a badge.
    expect(tone).toMatch(/hover:bg-editor-accent\/\d+/);
  });

  it("keeps a pressed panel toggle NEUTRAL, so accent means exactly one thing", () => {
    const toggle = functionBody("toggleButtonClass");
    const pressedTone = toggle.slice(toggle.indexOf("const tone"));
    // The whole point of P1 Phase C4: with the Pages rail open by default, a
    // shared accent style made the row report TWO selected tools.
    expect(pressedTone).not.toMatch(/accent(?!$)/);
    expect(pressedTone).toContain("bg-editor-subtle");
    expect(pressedTone).toContain("ring-editor-borderstrong");
    // A toggle stays a target, so it hovers too.
    expect(pressedTone).toContain("hover:bg-editor-border");
  });

  it("has exactly ONE filled control — the primary action", () => {
    /*
     * `bg-editor-accent` (solid) as opposed to `bg-editor-accentsoft` (pale) or
     * `bg-editor-accent/15` (the active tool's hover tint). Two filled buttons in
     * one row is how a toolbar stops having a primary action at all, so the
     * count, not the presence, is the contract. The `[a-z/]` lookahead is what
     * keeps the pale and translucent forms out of the count.
     */
    const filled = [...code.matchAll(/bg-editor-accent(?![a-z/])/g)];
    expect(filled).toHaveLength(1);
    const at = code.slice(filled[0].index ?? 0, (filled[0].index ?? 0) + 900);
    expect(at).toContain("Export edited PDF");
  });

  it("does not tint a menu item with the primary action's fill", () => {
    // The open cluster/overflow menu marks its current tool the same way the row
    // does — pale accent — rather than inventing a third "selected" look.
    const menu = functionBody("ToolMenu");
    expect(menu).toContain("bg-editor-accentsoft");
    expect(menu).not.toMatch(/bg-editor-accent(?![a-z/])/);
  });
});
