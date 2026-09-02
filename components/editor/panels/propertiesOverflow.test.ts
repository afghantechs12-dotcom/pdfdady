import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Properties inspector showed a horizontal scrollbar during ordinary
 * property editing. Vertical scrolling is fine; horizontal is not — it means
 * something inside refused to shrink to the dock.
 *
 * Two causes, both structural rather than cosmetic:
 *
 * 1. `<fieldset>` carries a browser-default `min-inline-size: min-content`.
 *    Unlike a `<div>`, it will not shrink below its widest content, so one long
 *    value set the floor for the entire panel.
 * 2. A flex item defaults to `min-width: auto` and native `<input>`/`<select>`
 *    have a substantial intrinsic width, so rows need `min-w-0` on both the row
 *    and the control.
 *
 * Asserting on the source is the honest option here: the test environment is
 * Node with no DOM and no layout engine, so a "does it overflow" assertion would
 * be theatre. These check the specific class contracts that prevent it.
 */

const ROOT = join(__dirname, "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

describe("properties panel cannot overflow horizontally", () => {
  const panel = read("components", "editor", "panels", "PropertiesPanel.tsx");
  const controls = read("components", "editor", "InspectorControls.tsx");

  it("the scrolling fieldset opts out of its min-content floor", () => {
    const fieldset = panel.match(/<fieldset[^>]*className="([^"]*)"/);
    expect(fieldset, "fieldset with className not found").not.toBeNull();
    const classes = fieldset![1];
    expect(classes).toContain("min-w-0");
    expect(classes).toContain("overflow-x-hidden");
    expect(classes).toContain("overflow-y-auto");
  });

  it("shared control rows shrink rather than push", () => {
    // The row shell and the control shell are single constants, so one
    // assertion covers every field built from them.
    const row = controls.match(/const ROW =\s*"([^"]*)"/);
    const control = controls.match(/const CONTROL =\s*\n?\s*"([^"]*)"/);
    expect(row, "ROW constant not found").not.toBeNull();
    expect(control, "CONTROL constant not found").not.toBeNull();
    expect(row![1]).toContain("min-w-0");
    expect(control![1]).toContain("min-w-0");
    expect(control![1]).toContain("flex-1");
  });

  it("no inspector control declares a fixed pixel width for its input", () => {
    // A `w-[220px]` on a field would reintroduce the floor regardless of the
    // shared constants. Fixed widths on the *label* column are intended.
    const inputWidths = controls.match(/className=\{?`?\$?\{?CONTROL\}?[^`"]*w-\[\d+px\]/g);
    expect(inputWidths).toBeNull();
  });

  it("the long-token fields are allowed to wrap or truncate", () => {
    // A PDF subset font name is one unbreakable token in two places: the
    // source-font notice (wraps) and the font <select> (truncates).
    expect(panel).toMatch(/break-words[^"]*"?>?[\s\S]{0,120}Source font/);

    // Scope to the SelectField component so the regex cannot drift onto an
    // earlier field's input (an earlier version of this test did exactly that).
    const selectField = controls.slice(controls.indexOf("export function SelectField"));
    const select = selectField.match(/<select[\s\S]*?className=\{`\$\{CONTROL\}([^`]*)`\}/);
    expect(select, "select control not found").not.toBeNull();
    expect(select![1]).toContain("truncate");
  });
});

describe("the inspector dock is wide enough to be readable", () => {
  const workspace = read("components", "editor", "EditorWorkspace.tsx");
  const inspector = read("components", "editor", "EditorInspector.tsx");

  it("docks at a width inside the 300-360px design range", () => {
    // The premium redesign widened the right inspector dock from 272px to 320px
    // (target 300-360px per the reference composition). The dock is now a SINGLE
    // column shared by Properties/Outline/Comments/Versions, so this is the only
    // docked width left to check.
    const aside = workspace.match(/<aside className="flex w-\[(\d+)px\] shrink-0 border-l border-editor-border bg-editor-surface">/);
    expect(aside, "docked inspector aside not found").not.toBeNull();
    const width = Number(aside![1]);
    expect(width).toBeGreaterThanOrEqual(300);
    expect(width).toBeLessThanOrEqual(360);
  });

  it("scrolls vertically only, inside the inspector's tab panel", () => {
    // The scroll container moved from the dock's <aside> to the tabpanel when the
    // two docks merged: the tab strip must stay pinned while the body scrolls.
    // `min-w-0` is what stops one unbreakable token (a PDF subset font name)
    // setting a horizontal-scroll floor for the whole dock.
    const panel = inspector.match(/role="tabpanel"[\s\S]{0,400}?className="([^"]*)"/);
    expect(panel, "inspector tabpanel not found").not.toBeNull();
    const classes = panel![1];
    expect(classes).toContain("min-w-0");
    expect(classes).toContain("overflow-y-auto");
    expect(classes).toContain("overflow-x-hidden");
  });
});
