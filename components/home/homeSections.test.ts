import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  aiToolCount,
  availableToolCount,
  heroQuickTools,
  heroStats,
  pickShortcutTools,
} from "./homeSections";
import { isFunctional, tools as defaultTools } from "@/data/tools";
import { getPopularToolsSlugs } from "@/data/admin";
import type { Tool } from "@/data/tools";

/**
 * The homepage's derived content, asserted against the pure module rather than
 * rendered markup — restyling a section must not be able to break a product
 * decision, and these are the decisions:
 *
 *  - the shortcut strip never links a tool that cannot run,
 *  - the hero's figures are counted, never written,
 *  - the tool grid stays driven by the admin-editable popular-slugs setting.
 *
 * The registry is admin-mergeable at runtime, so each function is also exercised
 * against a registry that has lost the slugs it asks for.
 */

function toolBySlug(slug: string): Tool {
  const tool = defaultTools.find((t) => t.slug === slug);
  if (!tool) throw new Error(`fixture expects a "${slug}" tool in the registry`);
  return tool;
}

describe("pickShortcutTools", () => {
  it("resolves every shortcut against the default registry", () => {
    const shortcuts = pickShortcutTools(defaultTools);
    expect(shortcuts.length).toBeGreaterThan(0);
    for (const shortcut of shortcuts) {
      expect(shortcut.href).toBeTruthy();
      expect(shortcut.tagline).toBeTruthy();
    }
  });

  it("only offers tools that can actually run", () => {
    const shortcuts = pickShortcutTools(defaultTools);
    for (const shortcut of shortcuts) {
      expect(isFunctional(toolBySlug(shortcut.slug))).toBe(true);
    }
  });

  it("drops a tool that stops being runnable rather than linking it", () => {
    const downgraded = defaultTools.map((t) =>
      t.slug === "merge-pdf" ? { ...t, status: "planned" as const } : t,
    );
    const slugs = pickShortcutTools(downgraded).map((s) => s.slug);
    expect(slugs).not.toContain("merge-pdf");
  });

  it("survives a registry that no longer has the slugs", () => {
    expect(pickShortcutTools([])).toEqual([]);
  });
});

describe("heroStats", () => {
  it("counts runnable tools rather than hard-coding a total", () => {
    const expected = defaultTools.filter(isFunctional).length;
    expect(heroStats(defaultTools)[0]?.value).toBe(String(expected));
  });

  it("moves when the registry does", () => {
    const before = heroStats(defaultTools)[0]?.value;
    const after = heroStats(defaultTools.filter((t) => !isFunctional(t)))[0]
      ?.value;
    expect(after).toBe("0");
    expect(after).not.toBe(before);
  });

  it("counts only client-side tools as running in the browser", () => {
    const expected = defaultTools.filter(
      (t) => t.status === "functional-client",
    ).length;
    expect(heroStats(defaultTools)[1]?.value).toBe(String(expected));
  });

  it("labels the price as today's, not forever", () => {
    // data/pricing.ts prices the free plan "$0 today" deliberately. The hero
    // must not upgrade that into a permanent promise.
    const price = heroStats(defaultTools)[2];
    expect(price?.value).toBe("$0");
    expect(price?.label.toLowerCase()).not.toContain("forever");
  });

  it("never renders an empty figure", () => {
    for (const stat of heroStats([])) {
      expect(stat.value).toBeTruthy();
      expect(stat.label).toBeTruthy();
    }
  });
});

describe("the homepage tool grid stays admin-editable", () => {
  it("is sourced from getPopularToolsSlugs, not a hard-coded homepage list", async () => {
    // A slug list living in homeSections.ts would match the reference grid
    // exactly and quietly override `site.popularSlugs`, leaving the admin panel
    // with a control that does nothing. Assert the wiring, not the styling.
    const source = await readFile(
      new URL("../../app/(marketing)/page.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("getToolsPopular");
  });

  it("resolves the default slugs to tools that exist", async () => {
    const slugs = await getPopularToolsSlugs();
    expect(slugs.length).toBeGreaterThan(0);
    for (const slug of slugs) {
      expect(defaultTools.some((t) => t.slug === slug)).toBe(true);
    }
  });
});

describe("heroQuickTools", () => {
  it("resolves against the default registry", () => {
    const picks = heroQuickTools(defaultTools);
    expect(picks.length).toBeGreaterThan(0);
    for (const pick of picks) {
      expect(pick.href).toBeTruthy();
      expect(pick.name).toBeTruthy();
    }
  });

  it("only offers tools that can receive the chosen file", () => {
    for (const pick of heroQuickTools(defaultTools)) {
      expect(isFunctional(toolBySlug(pick.slug))).toBe(true);
    }
  });

  it("narrows to three fields so the RSC payload stays small", () => {
    // The picker is a client component: whole Tool objects would serialize
    // every icon name, MIME list and description for three fields' worth of use.
    for (const pick of heroQuickTools(defaultTools)) {
      expect(Object.keys(pick).sort()).toEqual(["href", "name", "slug"]);
    }
  });

  it("drops a tool that stops being runnable rather than linking it", () => {
    const downgraded = defaultTools.map((t) =>
      t.slug === "merge-pdf" ? { ...t, status: "planned" as const } : t,
    );
    expect(heroQuickTools(downgraded).map((p) => p.slug)).not.toContain("merge-pdf");
  });

  it("returns nothing when the registry is empty", () => {
    expect(heroQuickTools([])).toEqual([]);
  });
});

describe("the page's counts are derived, never written", () => {
  it("counts only runnable tools as available", () => {
    expect(availableToolCount(defaultTools)).toBe(
      defaultTools.filter(isFunctional).length,
    );
  });

  it("moves the available count when a tool stops being runnable", () => {
    const before = availableToolCount(defaultTools);
    const downgraded = defaultTools.map((t) =>
      t.slug === "merge-pdf" ? { ...t, status: "planned" as const } : t,
    );
    expect(availableToolCount(downgraded)).toBe(before - 1);
  });

  it("counts AI tools as coming-soon-ai only", () => {
    // `planned` covers non-AI work; folding the two together would overstate
    // what the AI preview section is previewing.
    expect(aiToolCount(defaultTools)).toBe(
      defaultTools.filter((t) => t.status === "coming-soon-ai").length,
    );
    expect(aiToolCount(defaultTools)).toBeGreaterThan(0);
  });

  it("excludes planned tools from the AI count", () => {
    const planned: Tool[] = [
      { ...toolBySlug("merge-pdf"), status: "planned" as const },
    ];
    expect(aiToolCount(planned)).toBe(0);
  });

  it("reports zero for an empty registry rather than throwing", () => {
    expect(availableToolCount([])).toBe(0);
    expect(aiToolCount([])).toBe(0);
  });
});
