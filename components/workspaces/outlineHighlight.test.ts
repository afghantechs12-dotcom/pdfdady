import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { currentOutlineIndex } from "./metadataLogic";

/**
 * Outline current-page highlight and the Inspector tab strip
 * (Phase H — H29, H33, H34, H45).
 *
 * The highlight rule is a pure function and is tested as one. The strip is
 * asserted on source text because the suite has no DOM renderer — and what needs
 * protecting there is the ARIA contract, which is visible in the source.
 */

const ROOT = join(__dirname, "..", "..");
const inspectorSource = readFileSync(
  join(ROOT, "components", "workspaces", "DocumentInspector.tsx"),
  "utf8",
);
const stripSource = readFileSync(
  join(ROOT, "components", "editor", "EditorInspector.tsx"),
  "utf8",
);

const outline = (...pages: number[]) => pages.map((pageNumber) => ({ pageNumber }));

describe("currentOutlineIndex", () => {
  it("highlights the entry that starts the current page", () => {
    expect(currentOutlineIndex(outline(1, 5, 9), 5)).toBe(1);
  });

  it("highlights the nearest preceding section when the page starts no entry", () => {
    // Page 7 is inside the section that began on page 5.
    expect(currentOutlineIndex(outline(1, 5, 9), 7)).toBe(1);
  });

  it("highlights nothing before the first entry", () => {
    // Claiming the reader is inside a section they have not reached would be a lie.
    expect(currentOutlineIndex(outline(3, 8), 1)).toBe(-1);
  });

  it("highlights the last entry once past every start", () => {
    expect(currentOutlineIndex(outline(1, 5, 9), 40)).toBe(2);
  });

  it("prefers the last of several entries sharing a page", () => {
    // Two headings on page 5: the reader is inside the second.
    expect(currentOutlineIndex(outline(1, 5, 5, 9), 5)).toBe(2);
  });

  it("returns -1 for an unknown page rather than guessing", () => {
    expect(currentOutlineIndex(outline(1, 5), null)).toBe(-1);
    expect(currentOutlineIndex(outline(1, 5), Number.NaN)).toBe(-1);
  });

  it("returns -1 for an empty outline", () => {
    expect(currentOutlineIndex([], 3)).toBe(-1);
  });

  it("does not reorder a non-monotonic outline", () => {
    // An appendix cross-reference pointing backwards is legitimate. Sorting by
    // page would silently rewrite the document's own structure.
    const items = outline(1, 20, 5);
    // Page 6: entries at 1 and 5 qualify; 5 is the nearest preceding start.
    expect(currentOutlineIndex(items, 6)).toBe(2);
    // Page 21: the highest qualifying start is 20.
    expect(currentOutlineIndex(items, 21)).toBe(1);
  });

  it("ignores entries with an unusable page number", () => {
    expect(currentOutlineIndex([{ pageNumber: Number.NaN }, { pageNumber: 2 }], 5)).toBe(1);
  });
});

describe("the outline tab renders the highlight", () => {
  const outlineBlock = inspectorSource.slice(
    inspectorSource.indexOf("function OutlineTab"),
    inspectorSource.indexOf("function CommentsTab"),
  );

  it("uses the shared rule rather than comparing page numbers inline", () => {
    expect(outlineBlock).toContain("currentOutlineIndex(items, currentPage)");
  });

  it("announces the highlight, not just colours it", () => {
    // Colour alone excludes screen-reader users from a statement about location.
    expect(outlineBlock).toMatch(/aria-current=\{active \? "location" : undefined\}/);
  });

  it("keeps navigation inert when the editor cannot jump pages", () => {
    expect(outlineBlock).toContain("disabled={!onNavigateToPage}");
  });

  it("does not offer outline editing, which is out of scope", () => {
    // The API supports mutations; adding CRUD is a new feature, not polish.
    expect(outlineBlock).not.toMatch(/method:\s*"(POST|PATCH|DELETE)"/);
    expect(outlineBlock).not.toMatch(/>\s*(Add|Rename|Delete) (bookmark|outline)/i);
  });

  it("keeps the empty state honest", () => {
    expect(outlineBlock).toContain("This document has no outline.");
  });
});

describe("the Inspector tab strip keeps its ARIA contract (H45)", () => {
  it("still declares tablist, tab and tabpanel roles", () => {
    expect(stripSource).toContain('role="tablist"');
    expect(stripSource).toContain('aria-label="Inspector"');
    expect(stripSource).toContain('role="tab"');
    expect(stripSource).toContain('role="tabpanel"');
  });

  it("still uses roving tabindex, not a focus trap", () => {
    expect(stripSource).toContain("tabIndex={selected ? 0 : -1}");
  });

  it("still handles arrow, Home and End keys", () => {
    for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
      expect(stripSource).toContain(`"${key}"`);
    }
  });

  it("still links each tab to its panel in both directions", () => {
    expect(stripSource).toContain("aria-controls={`${baseId}-panel-${tab}`}");
    expect(stripSource).toContain("aria-labelledby={`${baseId}-tab-${activeTab}`}");
  });

  it("marks the selected tab with aria-selected, not styling alone", () => {
    expect(stripSource).toContain("aria-selected={selected}");
  });
});

describe("the tab strip styling (H29, H40)", () => {
  it("sticks to the top so it survives a long scrolling panel", () => {
    expect(stripSource).toMatch(/sticky top-0/);
  });

  it("is opaque where it sticks, so content cannot show through", () => {
    // The sticky container's own class list, not the surrounding comment.
    const container = stripSource.match(/className="sticky top-0[^"]*"/)?.[0] ?? "";
    expect(container).toContain("bg-editor-surface");
    expect(container).toContain("z-10");
  });

  it("marks the active tab with the accent colour and a 2px indicator", () => {
    // Asserted as independent facts: the indicator width is on the shared class
    // list and the accent colours are on the selected branch, so requiring them
    // to be adjacent in one string would break on any reordering.
    expect(stripSource).toContain("border-b-2");
    const selectedBranch = stripSource.match(/selected\s*\?\s*"([^"]*)"/)?.[1] ?? "";
    expect(selectedBranch).toContain("border-editor-accent");
    expect(selectedBranch).toContain("text-editor-accent");
    // And the inactive branch must not claim the indicator.
    const inactive = stripSource.match(/:\s*"(border-transparent[^"]*)"/)?.[1] ?? "";
    expect(inactive).toContain("border-transparent");
  });

  it("keeps every tab the same width so hit areas are consistent", () => {
    expect(stripSource).toContain("flex-1 basis-0");
  });

  /**
   * These two replace a pair that pinned `min-w-0 flex-1` and
   * `max-[1320px]:hidden` — the exact mechanism that produced the defect. The old
   * assertions were satisfied by a strip that truncated "Properties" to "Proper…"
   * inside a 49px box (measured at a 1600px viewport, where the media query had
   * decided there was room). Pinning the mechanism that broke is not coverage, so
   * these assert the OUTCOME instead: no tab may be able to render an ellipsis.
   */
  it("never truncates a tab label — no `truncate`, no ellipsis on primary navigation", () => {
    const tabButton = stripSource.match(/"flex flex-1 basis-0[^"]*"/)?.[0] ?? "";
    expect(tabButton).not.toContain("truncate");
    expect(tabButton).not.toContain("min-w-0");
    // The label itself must be unbreakable rather than clipped.
    expect(stripSource).toContain('<span className="whitespace-nowrap">{label}</span>');
    // And nothing may key the label's visibility off the VIEWPORT: the dock is a
    // fixed 320px, so viewport width says nothing about whether a label fits.
    expect(stripSource).not.toMatch(/max-\[\d+px\]:hidden/);
  });

  it("keeps an accessible name on each tab even when the label is hidden", () => {
    // In the `icon-only` presentation the glyph is `aria-hidden`, so the button's
    // name has to come from the element itself or the tab is an unnamed control.
    expect(stripSource).toContain("title={label}");
    expect(stripSource).toContain("aria-label={label}");
  });

  it("decides icon/label from the tab count, which is what the 320px dock divides", () => {
    expect(stripSource).toContain("inspectorTabPresentation(tabs.length)");
  });
});

describe("the Inspector fits inside its own dock", () => {
  /**
   * The dock is `flex w-[320px]`, so the Inspector is a flex ITEM, and a flex
   * item's automatic minimum size is its min-content width. Measured without
   * this: `clientWidth 319, scrollWidth 357` on the dock, with the tab strip and
   * the Rotate / Duplicate / Delete row running 38px past it and "Delete" clipped
   * against the window edge. Every descendant already had `min-w-0`; the chain
   * broke at the root.
   */
  it("lets the root shrink to the dock instead of to its widest child", () => {
    const root = stripSource.match(/className="flex h-full min-h-0[^"]*"/)?.[0] ?? "";
    expect(root).toContain("min-w-0");
    expect(root).toContain("w-full");
  });
});
