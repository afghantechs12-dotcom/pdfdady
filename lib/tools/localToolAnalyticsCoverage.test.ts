import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_TOOL_SLUGS } from "./executionPolicy";

/**
 * Analytics coverage for LOCAL tools, asserted structurally.
 *
 * ── The failure this prevents ───────────────────────────────────────────────
 *
 * Merge was instrumented by hand and the other seventeen slugs were not. Nothing
 * failed: every tool worked, every test passed, and the funnel dashboard showed
 * one tool because there was only one tool to show. That is the shape of a
 * measurement gap — it never reports itself, it reports a smaller product.
 *
 * Coverage now comes from two shared seams instead of eighteen call sites:
 * `ToolAnalyticsProvider` (mounted by `ToolPageTemplate`, so every tool page has
 * it) and `usePdfProcessor` (used by every local runner, so every run reports).
 * These tests assert the seams stay load-bearing — that a new local tool cannot
 * be added *around* them without a red test.
 *
 * ── Why source text ────────────────────────────────────────────────────────
 *
 * vitest here is `environment: "node"`: no DOM, no React renderer, so a page
 * cannot be mounted to observe what it emits. The question these tests ask is
 * structural anyway — "does this file route through the seam" — and that is a
 * property of the import graph, which is readable without a renderer. Comments
 * are stripped first, so prose describing a wrapper cannot stand in for one.
 */

const ROOT = process.cwd();
const TOOLS_DIR = join(ROOT, "app/(marketing)/tools");
const RUNNERS_DIR = join(ROOT, "components/tools/runners");

function code(...segments: string[]): string {
  return readFileSync(join(ROOT, ...segments), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");
}

/** Runner components: the files that own a local tool's UI and its run. */
const RUNNERS = readdirSync(RUNNERS_DIR).filter(
  (f) => f.endsWith("Tool.tsx") && !f.endsWith(".test.tsx"),
);

/** The two runners that drive SERVER work, and so are metered, not this. */
const SERVER_RUNNERS = new Set(["ServerToolRunner.tsx", "PipelineToolRunner.tsx"]);
const LOCAL_RUNNERS = RUNNERS.filter((f) => !SERVER_RUNNERS.has(f));

describe("every local tool page mounts the funnel", () => {
  it("has a dedicated page for every local slug", () => {
    // The premise of the next test. A slug served only by the dynamic
    // `[slug]/page.tsx` would not be covered by a per-directory scan, so the
    // scan has to be checked against the policy list rather than the filesystem.
    const missing = [...LOCAL_TOOL_SLUGS].filter((slug) => {
      try {
        readFileSync(join(TOOLS_DIR, slug, "page.tsx"));
        return false;
      } catch {
        return true;
      }
    });
    expect(missing).toEqual([]);
  });

  it("renders through ToolPageTemplate, which is what mounts the provider", () => {
    // Not "imports the provider" — that would be eighteen places to forget. The
    // template already wraps every tool page and already holds the `tool` object,
    // so it is the one place that knows the correct slug for a shared runner.
    const uncovered = [...LOCAL_TOOL_SLUGS].filter(
      (slug) => !code("app/(marketing)/tools", slug, "page.tsx").includes("ToolPageTemplate"),
    );
    expect(uncovered).toEqual([]);
  });

  it("mounts the provider from the template with the page's own slug and mode", () => {
    const template = code("components/tools/ToolPageTemplate.tsx");
    expect(template).toContain("<ToolAnalyticsProvider");
    expect(template).toContain("toolSlug={tool.slug}");
    // The mode comes from the execution policy, not from a literal: a tool that
    // is promoted from local to remote must not keep reporting itself as local.
    expect(template).toContain("executionModeForTool(tool)");
  });

  it("wraps the children, so the provider is above every runner it serves", () => {
    const template = code("components/tools/ToolPageTemplate.tsx");
    const open = template.indexOf("<ToolAnalyticsProvider");
    const children = template.indexOf("{children}");
    const close = template.indexOf("</ToolAnalyticsProvider>");
    expect(open).toBeGreaterThan(-1);
    expect(open).toBeLessThan(children);
    expect(children).toBeLessThan(close);
  });
});

describe("every local runner reports through the shared processor", () => {
  it("uses usePdfProcessor rather than its own status state", () => {
    // A runner holding its own `useState<"idle"|"processing">` is a runner whose
    // outcome nothing observes. The hook is where `job_succeeded`/`job_failed`
    // are emitted, so bypassing it is exactly the uninstrumented case.
    const uncovered = LOCAL_RUNNERS.filter(
      (file) => !code("components/tools/runners", file).includes("usePdfProcessor("),
    );
    expect(uncovered).toEqual([]);
    expect(LOCAL_RUNNERS.length).toBeGreaterThanOrEqual(11);
  });

  it("reports its file count, which the type system now requires", () => {
    // `fileCount` is a REQUIRED option, so `file_selected` cannot be skipped by
    // omission — a new runner that forgets it fails `tsc`, not just this test.
    // This asserts the value is real rather than a placeholder someone passed to
    // silence the compiler.
    const offenders: string[] = [];
    for (const file of LOCAL_RUNNERS) {
      const src = code("components/tools/runners", file);
      const call = src.match(/usePdfProcessor\(\{[^}]*\}\)/)?.[0] ?? "";
      if (!/fileCount:\s*\w+(\.\w+)*\.files\.length/.test(call)) offenders.push(`${file}: ${call}`);
    }
    expect(offenders).toEqual([]);
  });

  it("hands the download step to ResultActions rather than its own button", () => {
    // `download` is emitted by `ResultActions`. A runner with a bespoke download
    // button would produce a working download and no `download` event, which
    // reads on the dashboard as a tool nobody completes.
    const offenders = LOCAL_RUNNERS.filter((file) => {
      const src = code("components/tools/runners", file);
      return src.includes("downloadBlob") && !src.includes("ResultActions");
    });
    expect(offenders).toEqual([]);
  });

  it("shows the user-facing message and never the raw category", () => {
    // The two halves of a failure have two audiences. A runner that rendered
    // `proc.error.errorCategory` would put `corrupt_document` on screen; one that
    // sent `proc.error.message` to analytics would put a filename in the ledger.
    const offenders: string[] = [];
    for (const file of LOCAL_RUNNERS) {
      const src = code("components/tools/runners", file);
      if (/message=\{[^}]*errorCategory/.test(src)) offenders.push(`${file}: renders category`);
      if (/note\w+\([^)]*\.message/.test(src)) offenders.push(`${file}: sends message`);
    }
    expect(offenders).toEqual([]);
  });

  it("emits nothing itself, so no runner can drift from the taxonomy", () => {
    const offenders = LOCAL_RUNNERS.filter((file) => {
      const src = code("components/tools/runners", file);
      return src.includes("ANALYTICS_EVENTS") || src.includes("useAnalytics");
    });
    expect(offenders).toEqual([]);
  });
});

describe("local analytics cannot touch authoritative usage", () => {
  it("posts only to the ingest endpoint from the whole client funnel", () => {
    // Quota is server-side and increments from a job or a metered route. A
    // browser event that reached a usage endpoint would let a page inflate — or,
    // with an adblocker, deflate — a customer's entitlement counter.
    for (const file of [
      "components/tools/ToolAnalyticsProvider.tsx",
      "hooks/usePdfProcessor.ts",
      "hooks/useAnalytics.ts",
      "components/tools/ResultActions.tsx",
    ]) {
      const src = code(...file.split("/"));
      expect(src, `${file} must not reach a usage endpoint`).not.toMatch(/api\/usage|api\/jobs/);
      expect(src, `${file} must not reserve or settle`).not.toMatch(
        /\b(reserve|settle|increment|consume)\w*Usage\b/i,
      );
    }
  });

  it("keeps the local processing path free of any network call", () => {
    // The privacy claim printed on every local tool page. `usePdfProcessor` runs
    // the user's document; it must not be the place a fetch appears.
    expect(code("hooks/usePdfProcessor.ts")).not.toMatch(/\bfetch\(|XMLHttpRequest|navigator\.sendBeacon/);
  });
});

describe("the funnel's own vocabulary stays closed", () => {
  it("uses only canonical event names, never a per-tool string", () => {
    const provider = code("components/tools/ToolAnalyticsProvider.tsx");
    // Every emit names a member of ANALYTICS_EVENTS. A literal like
    // `"merge_started"` would be dropped by ingest validation and would never
    // appear in a funnel — a silent no-op that looks like instrumentation.
    const emits = provider.match(/trackOnce\([\s\S]*?\);/g) ?? [];
    expect(emits.length).toBeGreaterThanOrEqual(6);
    for (const emit of emits) {
      expect(emit, `not a canonical event: ${emit}`).toMatch(/ANALYTICS_EVENTS\.\w+/);
    }
  });

  it("types the failure category as the closed local union", () => {
    const provider = code("components/tools/ToolAnalyticsProvider.tsx");
    expect(provider).toContain("LocalToolErrorCategory");
    // Not `string`: a widened parameter is how a raw message becomes a category.
    expect(provider).not.toMatch(/noteRunFailed: \(errorCategory: string\)/);
  });
});
