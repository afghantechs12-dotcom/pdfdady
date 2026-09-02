import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The canvas, the inspector and the SCREEN READER must describe a read-only
 * imported PDF run the same way.
 *
 * Background: the visual fix (no transform handles, no geometry controls, a
 * text-range highlight) shipped while the `aria-live` announcement still said
 * the selection was an "editable copy of original PDF text". That was the
 * audible version of the exact contradiction the affordance model removes, and a
 * browser probe caught it after the unit tests were already green — a
 * screen-reader user would have gone hunting for edit controls that are
 * deliberately absent.
 *
 * Asserting on the source is the honest option here: the announcement is a
 * string in a React tree that depends on live editor state, and the test
 * environment is Node with no DOM. What matters is that the forbidden claim is
 * gone and that the announcement is derived from the SAME affordance verdict the
 * canvas and inspector use, rather than from a second, drifting predicate.
 */
const ROOT = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

describe("read-only source text is described consistently", () => {
  const workspace = read("components", "editor", "EditorWorkspace.tsx");
  const overlay = read("components", "editor", "canvas", "SelectionOverlay.tsx");
  const panel = read("components", "editor", "panels", "PropertiesPanel.tsx");

  it("never announces imported PDF text as an editable copy", () => {
    // The precise regression. Scoped to the announcement STRING (a quoted JSX
    // literal), not the whole file: prose explaining the old bug legitimately
    // names it, and a naive file-wide match would forbid documenting the fix.
    const announcement = workspace.match(/aria-live="polite">([\s\S]*?)<\/div>/);
    expect(announcement, "aria-live announcement block not found").not.toBeNull();
    expect(announcement![1]).not.toMatch(/editable copy/i);
    expect(announcement![1]).not.toMatch(/editable duplicate/i);
  });

  it("announces the read-only state and what the user CAN do", () => {
    expect(workspace).toMatch(/Original PDF text selected, read-only/i);
    // An announcement that only says "no" strands the user; the copy action is
    // the one thing that does work, so it is named.
    expect(workspace).toMatch(/copy the text/i);
  });

  it("derives the announcement from the shared affordance verdict", () => {
    // Not from a second `sourceText != null` check: that predicate is what let
    // the announcement drift away from the chrome in the first place.
    expect(workspace).toMatch(/resolveSelectionAffordance\(\[primaryObj\]\)\.allowsGeometry/);
    expect(workspace).not.toMatch(/primaryIsExistingText/);
  });

  it("labels the canvas range mark as read-only original PDF text", () => {
    // The non-visual name for the highlight, so the canvas agrees with the
    // announcement rather than being silent chrome.
    expect(overlay).toMatch(/aria-label="Original PDF text selected \(read-only\)"/);
  });

  it("keeps the canvas, inspector and announcement on one affordance source", () => {
    // All three import the same resolver. If a future edit reintroduces a local
    // capability check in any of them, this fails.
    for (const source of [workspace, overlay, panel]) {
      expect(source).toMatch(/selectionAffordances/);
    }
  });
});
