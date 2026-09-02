import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The client half of the funnel, asserted on its source.
 *
 * WHY SOURCE TEXT. vitest here is `environment: "node"` with no DOM and no React
 * renderer (`vitest.config.ts`), so `useAnalytics` cannot be mounted in this
 * suite and `MergeTool` cannot be rendered. The service behaviour is covered
 * against the real repository in `ProductAnalyticsService.test.ts` and the HTTP
 * contract in `app/api/analyticsRoutes.test.ts`. What is left is whether the
 * client can hurt the tool it is attached to, and that is a property of how these
 * two files are written:
 *
 *  - `track` must return void and never be awaited, or a merge ends up queued
 *    behind an ingest request.
 *  - the fetch must be caught, or an adblocker prints an error on a working page.
 *  - the emit must fire after `downloadBlob`, or a throwing beacon costs the user
 *    the file they just asked for.
 *  - the dedupe key must advance per run, or every repeat visitor is counted once.
 *  - no filename and no identity may be passed, ever.
 *
 * The funnel used to live in `MergeTool` and is now shared: `ToolAnalyticsProvider`
 * owns the run scope and `usePdfProcessor` owns the outcome. These assertions
 * moved with it rather than being deleted — an invariant that only held for the
 * one tool that had it hand-wired is worth less than the same invariant on the
 * seam all eighteen route through.
 *
 * Comments are stripped before matching, so a comment describing a call cannot
 * satisfy an assertion that the call exists — this file's own prose included.
 */

function code(...segments: string[]): string {
  const src = readFileSync(path.join(process.cwd(), ...segments), "utf8");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");
}

/** Index of `needle`, asserting presence so an absence is never a pass. */
function at(src: string, needle: string): number {
  const idx = src.indexOf(needle);
  expect(idx, `expected to find ${JSON.stringify(needle)}`).toBeGreaterThan(-1);
  return idx;
}

const hook = () => code("hooks", "useAnalytics.ts");
const provider = () => code("components", "tools", "ToolAnalyticsProvider.tsx");
const processor = () => code("hooks", "usePdfProcessor.ts");
const merge = () => code("components", "tools", "runners", "MergeTool.tsx");
const results = () => code("components", "tools", "ResultActions.tsx");

describe("the helper cannot block or break the tool", () => {
  it("sends without awaiting and without returning a promise", () => {
    const h = hook();
    expect(h).toContain("void fetch(");
    // `track`/`trackOnce` are declared `=> void`. An async signature would let a
    // call site `await` a beacon.
    expect(h).toMatch(/track: \([^)]*\) => void/s);
    expect(h).not.toMatch(/async function send/);
    expect(h).not.toMatch(/await fetch\(/);
  });

  it("swallows a rejected send and a throwing fetch", () => {
    const h = hook();
    const idx = at(h, "void fetch(");
    expect(h.slice(idx)).toMatch(/\}\)\.catch\(\(\) => \{/);
    // The synchronous throw, too: a rejection handler does not cover `fetch`
    // itself blowing up.
    expect(h).toMatch(/try \{[\s\S]*void fetch\([\s\S]*\} catch \{/);
  });

  it("uses keepalive so the last funnel step survives the navigation it reports", () => {
    expect(hook()).toContain("keepalive: true");
  });

  it("no-ops during server rendering instead of reaching for window", () => {
    expect(hook()).toContain('typeof window === "undefined"');
  });

  it("posts to the ingest endpoint and nowhere else", () => {
    const h = hook();
    expect(h).toContain('ANALYTICS_ENDPOINT = "/api/analytics/events"');
    // No third-party collector, no absolute URL: same-origin only, so nothing
    // leaves the deployment.
    expect(h).not.toMatch(/fetch\(\s*["'`]https?:/);
  });
});

describe("the helper leaks no identity and no document", () => {
  it("sends no id, and offers no way to set one", () => {
    const h = hook();
    // Stitching is server-side from the HttpOnly cookie. A client that can name
    // a subject is a client that can impersonate one.
    expect(h).not.toContain("identify");
    expect(h).not.toMatch(/\b(userId|ownerId|subjectHash|anonymousId|distinctId)\b/);
    // Cookies are sent by the browser as HttpOnly; the helper never reads them.
    expect(h).not.toContain("document.cookie");
    expect(h).not.toContain("localStorage");
  });

  it("types properties as primitives, so a File or a document object cannot be passed", () => {
    const h = hook();
    expect(h).toContain("AnalyticsPropertyValue = string | number | boolean");
    expect(h).toMatch(
      /ClientAnalyticsProperties = Record<string, AnalyticsPropertyValue>/,
    );
  });

  it("passes no filename or file object from any emit site", () => {
    // The provider is now the ONLY place a client event is constructed, so this
    // is the whole surface rather than one tool's worth of it.
    const p = provider();
    for (const call of p.match(/trackOnce\([\s\S]*?\);/g) ?? []) {
      expect(call).not.toMatch(/\bname\b\s*:/);
      expect(call).not.toMatch(/fileName|files\[|\.name\b|upload\.files\b/);
    }
    // And no runner may hand one in: the funnel's parameters are a count, a
    // category and a format — three primitives, no File and no string from the
    // document.
    expect(p).toMatch(/noteFileSelection: \(fileCount: number\) => void/);
    expect(p).toMatch(/noteRunFailed: \(errorCategory: LocalToolErrorCategory\) => void/);
    expect(p).toMatch(/noteDownload: \(format: string\) => void/);
  });

  it("sends the produced format as a bounded extension, not the filename", () => {
    const r = results();
    // `format` is a declared property for `download`, and the only value derived
    // from a filename anywhere in the client. The bound is the regex: a capture
    // of `[a-z0-9]+` cannot carry "Q3-layoffs" no matter what the file is called.
    expect(r).toContain("funnel.noteDownload(extensionOf(result.fileName))");
    expect(r).toMatch(/fileName\.match\(\/\\\.\(\[a-z0-9\]\+\)\$\/i\)/);
    // No other emit reads the filename.
    expect(r.match(/funnel\.note\w+\(/g) ?? []).toHaveLength(1);
  });

  it("reports the user-facing message to the user and the category to analytics", () => {
    const proc = processor();
    // Two fields, two audiences. The failure emit takes the category only — the
    // message never reaches a beacon, and a category is one of six constants.
    expect(proc).toMatch(/message: string;/);
    expect(proc).toMatch(/errorCategory: LocalToolErrorCategory;/);
    expect(proc).toContain("funnel.noteRunFailed(localErrorCategoryOf(err))");
    expect(proc).not.toMatch(/noteRunFailed\([^)]*message/);
  });
});

describe("every local tool reports the real funnel", () => {
  it("emits every step the local funnel needs", () => {
    const p = provider();
    const proc = processor();
    // `tool_view` fires from the provider, which is the only place that knows the
    // slug: `EditTool` serves four slugs and `SplitTool` two, so a runner that
    // named itself would mislabel three quarters of its own traffic.
    expect(p).toContain("ANALYTICS_EVENTS.tool_view");
    for (const step of ["ANALYTICS_EVENTS.file_selected", "ANALYTICS_EVENTS.tool_start"]) {
      expect(p, `missing funnel step ${step}`).toContain(step);
    }
    for (const step of ["ANALYTICS_EVENTS.job_succeeded", "ANALYTICS_EVENTS.job_failed"]) {
      expect(p, `missing funnel step ${step}`).toContain(step);
    }
    expect(p).toContain("ANALYTICS_EVENTS.download");
    // And the runner half: the processor drives start, outcome and selection.
    for (const call of ["funnel.noteRunStart()", "funnel.noteRunSucceeded()", "funnel.noteFileSelection("]) {
      expect(proc, `processor must call ${call}`).toContain(call);
    }
  });

  /**
   * Local tools run in the tab; nothing is submitted anywhere. `rollupFunnel`
   * clamps each step to the step before it, so a `job_submitted` no local tool
   * can emit would pull `job_succeeded` and `download` down to zero and report a
   * working tool as broken.
   */
  it("emits no job_submitted for tools that submit nothing", () => {
    expect(provider()).not.toContain("job_submitted");
    expect(processor()).not.toContain("job_submitted");
  });

  it("reports the outcome from the run, not from the click or a status effect", () => {
    const proc = processor();
    const failed = at(proc, "funnel.noteRunFailed(");
    const succeeded = at(proc, "funnel.noteRunSucceeded()");
    // Both emits live inside `run`, which is the only place the outcome is known
    // AND the only place the thrown error — the source of the category — is
    // visible. A status effect would have to re-derive the category from state.
    const run = at(proc, "const run = useCallback(");
    expect(run).toBeLessThan(failed);
    expect(failed).toBeLessThan(succeeded);
    // Structural, not conventional: the catch returns, so there is no control
    // path on which a failed run reaches the success emit.
    expect(proc.slice(failed, succeeded)).toMatch(/return;/);
    // The one effect in this hook is the file-selection one; the outcome is not
    // derived from state anywhere.
    const effects = proc.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/g) ?? [];
    expect(effects).toHaveLength(1);
    expect(effects[0]).toContain("noteFileSelection");
  });

  it("starts the work without waiting on the beacon", () => {
    const proc = processor();
    expect(at(proc, "funnel.noteRunStart()")).toBeLessThan(at(proc, "await task()"));
    expect(proc).not.toMatch(/await funnel\./);
    expect(proc).not.toMatch(/\.then\(\(\) => task\(\)/);
  });

  it("survives a throwing beacon so analytics cannot cost the user their file", () => {
    // Every emit is wrapped, at the seam rather than at eleven call sites. This
    // matters most here: `run` calls the funnel around the user's actual PDF work.
    const p = provider();
    expect(p).toMatch(/const safe = \(emit: \(\) => void\) => \{\s*try \{\s*emit\(\);\s*\} catch \{/);
    for (const emit of p.match(/note\w+: \([^)]*\) =>\s*safe\(/g) ?? []) {
      expect(emit).toContain("safe(");
    }
    // All five, so a new step cannot be added outside the wrapper.
    expect(p.match(/safe\(\(\) => \{?/g) ?? []).toHaveLength(5);
  });

  it("counts a repeat run as a second funnel, not a duplicate", () => {
    const p = provider();
    // Every per-run key is prefixed with the run counter…
    const keys = p.match(/trackOnce\(\s*`([^`]*)`/g) ?? [];
    expect(keys.length).toBeGreaterThanOrEqual(5);
    for (const key of keys) {
      // `tool_view` is the one deliberate exception: it is per-page, not per-run,
      // and scoping it to a run would count one visitor as many.
      if (key.includes("tool_view")) continue;
      expect(key, `${key} must be scoped to the run`).toContain("${runRef.current}");
    }
    // …and the counter advances at the START of a run, before any key for that
    // run is built. Advancing on reset instead would leave a download emitted
    // after "start over" filed under the run that has already ended.
    // The implementation, not the interface declaration of the same name.
    const startIdx = p.search(/noteRunStart: \(\) =>\s*safe\(/);
    expect(startIdx).toBeGreaterThan(-1);
    const branch = p.slice(startIdx, startIdx + 300);
    expect(at(branch, "runRef.current += 1")).toBeLessThan(
      at(branch, "ANALYTICS_EVENTS.tool_start"),
    );
  });

  it("dedupes selection on the file count, so adding files is a signal and a re-render is not", () => {
    expect(provider()).toMatch(/file_selected:\$\{fileCount\}/);
    expect(processor()).toMatch(/\}, \[fileCount, funnel\]\)/);
  });

  it("makes a zero-file render not a selection", () => {
    // The effect runs on mount with `fileCount: 0`. Reporting that would put a
    // `file_selected` on every page view and flatten the step that measures
    // whether anyone actually brought a file.
    expect(provider()).toMatch(/if \(fileCount <= 0\) return;/);
  });

  it("keeps the funnel out of the runners entirely", () => {
    // The absence IS the coverage guarantee. A runner that hand-rolls its own
    // events is a runner that can drift from the taxonomy, mislabel its slug, or
    // silently stop emitting — and eleven of them did not have this at all until
    // it moved to the seam.
    const m = merge();
    expect(m).not.toContain("ANALYTICS_EVENTS");
    expect(m).not.toContain("trackOnce");
    expect(m).not.toContain("useAnalytics");
  });
});

describe("the download itself is never at risk", () => {
  it("hands the file to the browser before the beacon runs", () => {
    const r = results();
    expect(at(r, "downloadBlob(result.blob, result.fileName)")).toBeLessThan(
      at(r, "funnel.noteDownload("),
    );
  });

  it("needs no prop, so a runner cannot forget to pass one", () => {
    const r = results();
    // The step used to be an optional `onDownload` prop and exactly one of the
    // eleven runners passed it. An optional tracking prop is a step that is
    // absent by default, which is the worst default for a measurement.
    expect(r).not.toContain("onDownload");
    expect(r).toContain("useToolFunnel()");
    // Context, not a prop: the runner and this component are siblings, so the run
    // scope `download` shares with `job_succeeded` has to live above both.
    expect(r).toMatch(/interface ResultActionsProps \{\s*result: ProcessedResult;\s*onReset: \(\) => void;\s*\}/);
  });

  it("emits download only from the download click", () => {
    const r = results();
    // Not from render, not from an effect: a `download` counted when the success
    // panel appears counts everyone who saw the button as having taken the file.
    expect(r).not.toContain("useEffect");
    const click = at(r, "onClick={() => {");
    expect(click).toBeLessThan(at(r, "funnel.noteDownload("));
  });
});
