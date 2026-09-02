import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getToolBySlug, isFunctional, tools as TOOLS } from "@/data/tools";
import { features } from "@/data/features";
import { serverToolConfig } from "@/data/serverToolConfig";
import { MAX_SIZE } from "@/lib/validation/fileSchemas";
import {
  aiToolCount,
  availableToolCount,
  heroStats,
  runnableSlugs,
} from "@/components/home/homeSections";
import { HERO_DEPICTED_SLUGS } from "@/components/home/HeroShowcase";
import { getAiComingSoonCount, getAvailableToolCount, getBrowserToolCount } from "./capability";

/**
 * The claims the marketing surfaces make (T7, T8, T12, T14, T15, T16).
 *
 * Every assertion here answers a recorded observation of the running site, and
 * every one of them is about the same failure mode: a page stating a product fact
 * of its own. A number typed into a heading, a size typed into a hint, a hero
 * control named after an unbuilt tool. None of those can be caught by a test of
 * the thing they describe — only by a test that the page does not state them
 * independently.
 *
 * Source-text scanning is deliberate. Vitest runs under `environment: "node"` so
 * these `.tsx` files cannot be rendered, and the property under test ("this page
 * does not hardcode the count") is a property of the source, not of the output.
 */

const MB = 1024 * 1024;

function read(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

/** Source with comments removed, so a comment mentioning a claim is not a hit. */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");
}

describe("T7 — the homepage counts nothing itself", () => {
  it("derives every hero figure from the registry", () => {
    const stats = heroStats(TOOLS);
    expect(stats[0]?.value).toBe(String(getAvailableToolCount(TOOLS)));
    expect(stats[1]?.value).toBe(String(getBrowserToolCount(TOOLS)));
    expect(availableToolCount(TOOLS)).toBe(getAvailableToolCount(TOOLS));
    expect(aiToolCount(TOOLS)).toBe(getAiComingSoonCount(TOOLS));
  });

  it("changes when the registry changes, so the figure cannot be stale", () => {
    // The teeth: a hardcoded "32" would satisfy the test above on today's
    // registry and keep satisfying it after a tool was withdrawn.
    const twoBrowser = TOOLS.filter((t) => t.status === "functional-client").slice(0, 2);
    expect(heroStats(twoBrowser)[0]?.value).toBe("2");
    expect(heroStats([])[0]?.value).toBe("0");
  });

  it("states no tool count as a literal in the page or the header", () => {
    for (const file of [
      "app/(marketing)/page.tsx",
      "app/(marketing)/layout.tsx",
      "components/home/Hero.tsx",
    ]) {
      // Any of the counts a surface might plausibly type by hand.
      expect(code(file)).not.toMatch(/\b(31|32|33|45)\s*(tools|PDF tools)\b/i);
    }
  });
});

describe("T8 — the tools page and its header count the same way", () => {
  it("reads the shared selector rather than filtering again", () => {
    for (const file of ["app/(marketing)/tools/page.tsx", "app/(marketing)/layout.tsx"]) {
      expect(code(file)).toContain("getAvailableToolCount");
      // `tools.filter(isFunctional).length` inline is how two pages come to
      // disagree after one of them is edited.
      expect(code(file)).not.toMatch(/filter\(isFunctional\)/);
    }
  });

  it("counts the admin-merged list the page actually renders", () => {
    const src = code("app/(marketing)/tools/page.tsx");
    expect(src).toMatch(/getAvailableToolCount\(tools\)/);
  });
});

describe("T12 — every stated file limit is the limit that applies", () => {
  it("matches each server tool's hint to its own configured ceiling", () => {
    for (const [slug, config] of Object.entries(serverToolConfig)) {
      const stated = config.acceptHint.match(/Max (\d+)MB/);
      expect(stated, `${slug} states no size in its hint`).not.toBeNull();
      expect(Number(stated?.[1]), `${slug} hint disagrees with maxSizeBytes`).toBe(
        Math.round(config.maxSizeBytes / MB),
      );
    }
  });

  it("does not give every server tool the same ceiling", () => {
    // Not vacuous: the per-tool limits genuinely differ (20/50/100MB), which is
    // why a single global figure on a marketing page is wrong for most tools.
    const sizes = new Set(Object.values(serverToolConfig).map((c) => c.maxSizeBytes));
    expect(sizes.size).toBeGreaterThan(1);
  });

  it("matches every browser-tool hint to the browser validator's limit", () => {
    const browserSurfaces = [
      "components/tools/runners/MergeTool.tsx",
      "components/tools/runners/SplitTool.tsx",
      "components/tools/runners/CropTool.tsx",
      "components/tools/runners/SignTool.tsx",
      "components/tools/runners/EditTool.tsx",
      "components/tools/runners/AnnotateTool.tsx",
      "components/tools/runners/FillFormsTool.tsx",
      "components/tools/runners/AddWatermarkTool.tsx",
      "components/tools/runners/AddPageNumbersTool.tsx",
      "components/tools/runners/RemoveMetadataTool.tsx",
      "components/tools/runners/JpgToPdfTool.tsx",
      "app/(marketing)/tools/jpg-to-pdf/page.tsx",
      "app/(marketing)/tools/png-to-pdf/page.tsx",
      "app/(marketing)/tools/image-to-pdf/page.tsx",
    ];
    let stated = 0;
    for (const file of browserSurfaces) {
      for (const match of read(file).matchAll(/Max (\d+)MB/g)) {
        stated += 1;
        expect(Number(match[1]), `${file} states a limit the validator does not enforce`).toBe(
          Math.round(MAX_SIZE / MB),
        );
      }
    }
    // Not vacuous: the scan found hints. A renamed file would otherwise pass.
    expect(stated).toBeGreaterThanOrEqual(14);
  });

  it("derives the homepage upload hint from the tool's own config", () => {
    // The recorded ambiguity was "PDF files up to 50MB" on the homepage beside
    // "Largest file per upload 100MB" in the Workspace. The hero figure is one
    // tool's limit and must stay computed from it, not typed.
    const hero = code("components/home/HeroUpload.tsx");
    expect(hero).toContain("upload.config.maxSizeBytes");
    expect(hero).not.toMatch(/up to 50 ?MB/);
  });
});

describe("T14 — the promotional mock shows only what exists", () => {
  it("labels no hero control with a tool that is not built", () => {
    // The recorded defect: the hero editor showed `Redact`, a `planned` tool, as
    // an ordinary control beside real ones.
    const src = read("components/home/HeroShowcase.tsx");
    const labels = [...src.matchAll(/label: "([^"]+)"/g)].map((m) => m[1].toLowerCase());
    expect(labels.length).toBeGreaterThan(5);
    const unbuilt = TOOLS.filter((t) => t.status === "planned" || t.status === "coming-soon-ai");
    for (const tool of unbuilt) {
      // "Redact PDF" -> "redact": a control is labelled with the verb.
      const verb = tool.name.toLowerCase().replace(/\s*pdf\s*/g, "").trim();
      if (!verb) continue;
      expect(labels, `hero labels a control "${verb}", which is ${tool.status}`).not.toContain(verb);
    }
  });

  it("marks the AI panel as a preview wherever it names the assistant", () => {
    const src = read("components/home/HeroShowcase.tsx");
    const idx = src.indexOf("AI Assistant");
    expect(idx).toBeGreaterThan(-1);
    // The marker must be in the same panel, not somewhere else in the file.
    expect(src.slice(idx, idx + 400)).toContain("Preview");
  });

  it("keeps the same marker on the navigation item that leads to it", () => {
    expect(read("data/nav.ts")).toMatch(/label: "AI Assistant"[^}]*badge: "Preview"/);
  });
});

describe("T15 — the jobs claim covers what the runners implement", () => {
  it("promises progress and cancellation only", () => {
    const operations = features.find((f) => f.id === "operations");
    expect(operations?.description).toMatch(/progress/i);
    expect(operations?.description).toMatch(/cancel/i);
    // Retry is implemented in PipelineToolRunner, which serves compress-pdf only
    // and only behind the unified-pipeline flag. A homepage claim of retry is
    // therefore false of 13 of the 14 server tools.
    expect(operations?.description).not.toMatch(/retr(y|ied)/i);
  });

  it("is true of the runner every server tool uses", () => {
    const runner = read("components/tools/runners/ServerToolRunner.tsx");
    expect(runner).toContain("EventSource");
    expect(runner).toMatch(/\/cancel/);
    expect(runner).not.toMatch(/\/retry/);
    // Not vacuous: retry does exist. `useProcessingJob` implements it and the
    // pilot runner is the only UI that surfaces it.
    expect(read("hooks/useProcessingJob.ts")).toMatch(/\/api\/jobs\/\$\{jobId\}\/retry/);
    expect(read("components/tools/runners/PipelineToolRunner.tsx")).toContain("onRetry=");
    expect(read("components/tools/runners/ServerToolRunner.tsx")).not.toContain("onRetry=");
  });
});

describe("T16 — version history is claimed for the surface that has it", () => {
  it("scopes the claim to saving from the editor into a Workspace", () => {
    const versions = features.find((f) => f.id === "versions");
    expect(versions?.description).toMatch(/editor/i);
    expect(versions?.description).toMatch(/workspace/i);
    // The Workspace document surface autosaves drafts and publishes no version
    // (Phase 3). "Every save keeps a version" was therefore false of one of the
    // two editing surfaces.
    expect(versions?.description).not.toMatch(/every save|each save|automatically keeps/i);
  });

  it("does not promise autosave publishes anything", () => {
    const autosave = features.find((f) => f.id === "autosave");
    expect(autosave?.description).not.toMatch(/version/i);
  });
});

describe("T17 — the hero illustration depicts only tools that exist", () => {
  it("names a real, runnable tool on every tile and card", () => {
    // Anti-vacuity: the composition is five dock tiles and five float cards.
    expect(HERO_DEPICTED_SLUGS.length).toBeGreaterThanOrEqual(5);

    for (const slug of HERO_DEPICTED_SLUGS) {
      const tool = getToolBySlug(slug);
      expect(tool, `${slug} is not in the registry`).toBeDefined();
      expect(isFunctional(tool!), `${slug} is ${tool!.status}`).toBe(true);
    }
  });

  it("drops a tile whose tool stopped being runnable", () => {
    // The filter is what makes the assertion above hold at runtime too: the
    // registry is admin-mergeable, so a slug can lose `functional-*` after this
    // suite has passed. `runnableSlugs` is the only thing the illustration is
    // allowed to depict.
    const runnable = runnableSlugs(TOOLS);
    expect(runnable).toEqual(expect.arrayContaining(HERO_DEPICTED_SLUGS));

    // Not vacuous: unrunnable tools exist and are excluded. `pdf-to-excel` is
    // the one the hero used to depict.
    const planned = TOOLS.filter((t) => !isFunctional(t)).map((t) => t.slug);
    expect(planned.length).toBeGreaterThan(5);
    expect(planned).toContain("pdf-to-excel");
    for (const slug of planned) expect(runnable).not.toContain(slug);
  });
});
