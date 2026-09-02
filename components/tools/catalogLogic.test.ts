import { describe, expect, it } from "vitest";
import {
  buildCatalog,
  isAvailable,
  matchesCategory,
  matchesMode,
  matchesSearch,
  normalize,
} from "./catalogLogic";
import { tools as realTools } from "@/data/tools";
import { toolCategories } from "@/data/toolCategories";
import type { Tool } from "@/data/tools";

function makeTool(over: Partial<Tool>): Tool {
  return {
    slug: "merge-pdf",
    name: "Merge PDF",
    description: "Combine multiple PDF files into one document.",
    href: "/tools/merge-pdf",
    icon: "Combine",
    iconTone: "purple",
    status: "functional-client",
    category: "organize",
    accept: ["application/pdf"],
    multiple: true,
    ...over,
  };
}

const CATEGORIES = toolCategories.map((c) => ({ id: c.id, label: c.label }));
const ALL = { search: "", category: "all" as const, mode: "all" as const };

describe("normalize", () => {
  it("lowercases, trims and strips accents", () => {
    expect(normalize("  Ünïcode ")).toBe("unicode");
  });
});

describe("matchesSearch", () => {
  const tool = makeTool({});

  it("matches an empty query", () => {
    expect(matchesSearch(tool, "")).toBe(true);
    expect(matchesSearch(tool, "   ")).toBe(true);
  });

  it("matches on name, case-insensitively", () => {
    expect(matchesSearch(tool, "MERGE")).toBe(true);
  });

  it("matches on description", () => {
    expect(matchesSearch(tool, "combine")).toBe(true);
  });

  it("treats spaces and hyphens as equivalent, so slugs are reachable", () => {
    const jpg = makeTool({ slug: "jpg-to-pdf", name: "JPG to PDF", description: "Images." });
    expect(matchesSearch(jpg, "jpg to pdf")).toBe(true);
    expect(matchesSearch(jpg, "jpg-to-pdf")).toBe(true);
  });

  it("requires every term to match, not just one", () => {
    expect(matchesSearch(tool, "merge document")).toBe(true);
    expect(matchesSearch(tool, "merge spreadsheet")).toBe(false);
  });

  it("does not match unrelated queries", () => {
    expect(matchesSearch(tool, "watermark")).toBe(false);
  });
});

describe("matchesMode", () => {
  it("passes everything through when unset", () => {
    expect(matchesMode(makeTool({ status: "planned" }), "all")).toBe(true);
  });

  it("selects by the tool's derived processing mode", () => {
    expect(matchesMode(makeTool({ status: "functional-client" }), "browser")).toBe(true);
    expect(matchesMode(makeTool({ status: "functional-client" }), "secure-cloud")).toBe(false);
    expect(matchesMode(makeTool({ status: "functional-server" }), "secure-cloud")).toBe(true);
  });

  it("never matches a tool that cannot run", () => {
    // A planned tool has no processing location, so no mode filter can reach it.
    for (const mode of ["browser", "secure-cloud", "workspace"] as const) {
      expect(matchesMode(makeTool({ status: "planned" }), mode)).toBe(false);
      expect(matchesMode(makeTool({ status: "coming-soon-ai" }), mode)).toBe(false);
    }
  });
});

describe("matchesCategory / isAvailable", () => {
  it("filters by category", () => {
    expect(matchesCategory(makeTool({}), "organize")).toBe(true);
    expect(matchesCategory(makeTool({}), "security")).toBe(false);
    expect(matchesCategory(makeTool({}), "all")).toBe(true);
  });

  it("treats only functional statuses as available", () => {
    expect(isAvailable(makeTool({ status: "functional-client" }))).toBe(true);
    expect(isAvailable(makeTool({ status: "functional-server" }))).toBe(true);
    expect(isAvailable(makeTool({ status: "planned" }))).toBe(false);
    expect(isAvailable(makeTool({ status: "coming-soon-ai" }))).toBe(false);
  });
});

describe("buildCatalog", () => {
  it("never puts an unavailable tool in an available group", () => {
    const result = buildCatalog(realTools, CATEGORIES, ALL);
    for (const group of result.availableGroups) {
      for (const tool of group.tools) {
        expect(isAvailable(tool), `${tool.slug} is not runnable`).toBe(true);
      }
    }
  });

  it("puts every planned and AI tool in the coming-later list", () => {
    const result = buildCatalog(realTools, CATEGORIES, ALL);
    const expected = realTools.filter((t) => !isAvailable(t)).map((t) => t.slug).sort();
    expect(result.comingLater.map((t) => t.slug).sort()).toEqual(expected);
  });

  it("counts only available tools", () => {
    const result = buildCatalog(realTools, CATEGORIES, ALL);
    expect(result.availableCount).toBe(realTools.filter(isAvailable).length);
    expect(result.availableCount).toBeGreaterThan(0);
  });

  it("drops the coming-later list entirely when a mode filter is active", () => {
    // Otherwise "Browser" would list planned tools underneath the browser
    // ones, implying they are browser tools.
    const result = buildCatalog(realTools, CATEGORIES, { ...ALL, mode: "browser" });
    expect(result.comingLater).toEqual([]);
    for (const group of result.availableGroups) {
      for (const tool of group.tools) {
        expect(tool.status).toBe("functional-client");
      }
    }
  });

  it("omits empty category groups", () => {
    const result = buildCatalog(realTools, CATEGORIES, { ...ALL, search: "merge" });
    for (const group of result.availableGroups) {
      expect(group.tools.length).toBeGreaterThan(0);
    }
  });

  it("composes search, category and mode", () => {
    const result = buildCatalog(realTools, CATEGORIES, {
      search: "pdf",
      category: "organize",
      mode: "browser",
    });
    for (const group of result.availableGroups) {
      expect(group.id).toBe("organize");
      for (const tool of group.tools) {
        expect(tool.status).toBe("functional-client");
      }
    }
  });

  it("reports emptiness for a query that matches nothing", () => {
    const result = buildCatalog(realTools, CATEGORIES, {
      ...ALL,
      search: "definitely-not-a-tool-xyz",
    });
    expect(result.isEmpty).toBe(true);
    expect(result.availableGroups).toEqual([]);
  });

  it("finds a known tool by a natural-language query", () => {
    const result = buildCatalog(realTools, CATEGORIES, { ...ALL, search: "pdf to word" });
    const slugs = result.availableGroups.flatMap((g) => g.tools.map((t) => t.slug));
    expect(slugs).toContain("pdf-to-word");
  });
});
