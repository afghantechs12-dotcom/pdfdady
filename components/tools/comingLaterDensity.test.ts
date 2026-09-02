import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCatalog } from "./catalogLogic";
import { tools as realTools } from "@/data/tools";
import { toolCategories } from "@/data/toolCategories";

/**
 * The "Coming later" section is collapsed by default.
 *
 * 13 planned tools rendered as 13 grey cards carried more visual weight than
 * any single category of tools that actually work, and sat at the bottom of the
 * page advertising nothing the visitor could do. (Launch polish P2-16.)
 *
 * The honesty properties are what matter here, not the styling:
 *
 *  - the stated count comes from the real catalog, so it cannot drift;
 *  - collapsed cards are absent from the DOM rather than merely hidden, so they
 *    are not keyboard tab stops inside a closed section and not crawlable text
 *    the visitor cannot see;
 *  - a search or filter forces the section open, so a query that matches a
 *    planned tool never hides its own result.
 */

const CATEGORIES = toolCategories.map((c) => ({ id: c.id, label: c.label }));
const source = readFileSync(join(__dirname, "ToolsCatalog.tsx"), "utf8");

describe("coming-later density", () => {
  it("the real catalog still has planned tools to collapse", () => {
    const catalog = buildCatalog(realTools, CATEGORIES, {
      search: "",
      category: "all",
      mode: "all",
    });
    // If this ever reaches 0, the disclosure should be reconsidered rather than
    // left wrapping an empty list.
    expect(catalog.comingLater.length).toBeGreaterThan(0);
  });

  it("states the count from the data instead of a hardcoded number", () => {
    // A literal "13 planned tools" in the markup would go stale the moment a
    // tool ships. The count must be derived.
    expect(source).toContain("{tools.length} planned");
    expect(source).not.toMatch(/>\s*13 planned/);
  });

  it("renders the grid only when expanded", () => {
    // The grid is behind `expanded &&`, so collapsed means absent, not hidden.
    expect(source).toMatch(/\{expanded && \(/);
    expect(source).not.toMatch(/hidden.*coming-later-grid/);
  });

  it("exposes the disclosure with accessible expand/collapse state", () => {
    expect(source).toContain('aria-expanded={expanded}');
    expect(source).toContain('aria-controls="coming-later-grid"');
  });

  it("an active search forces the section open", () => {
    expect(source).toContain("forceOpen={filtersActive}");
    // And the toggle hides itself in that state, rather than offering to
    // collapse something that would immediately reopen.
    expect(source).toMatch(/\{!forceOpen && \(/);
  });

  it("planned tools remain non-interactive cards when revealed", () => {
    const catalog = buildCatalog(realTools, CATEGORIES, {
      search: "",
      category: "all",
      mode: "all",
    });
    // ToolCard decides this from status; assert the data still says "planned"
    // so expanding cannot produce a link to a page that does not work.
    for (const tool of catalog.comingLater) {
      expect(["planned", "coming-soon-ai"]).toContain(tool.status);
    }
  });
});
