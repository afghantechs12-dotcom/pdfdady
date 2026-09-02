import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tools as TOOLS, type ToolCategory } from "@/data/tools";
import { REMOTE_JOB_TOOL_SLUGS } from "./executionPolicy";
import { PROCESSING_MODE_COPY } from "./processingMode";
import {
  PROCESSING_LIFECYCLE_NOTES,
  TOOL_CAPABILITIES,
  canUseTool,
  capabilityForSlug,
  capabilityInventoryProblems,
  getAiComingSoonCount,
  getAvailableToolCount,
  getBrowserToolCount,
  getLifecycleCopyForMode,
  getPlannedToolCount,
  getServerToolCount,
  getToolExecutionLabel,
  getUnavailableToolCount,
  lifecycleCopyDisagreements,
} from "./capability";

/**
 * The canonical capability inventory (T1–T6, T13, T17).
 *
 * The recorded failure this file exists for is not a bug in one page: it is that
 * "how many tools work", "where does this one run", "what does waiting look
 * like" and "can this be run at all" were each answered independently by every
 * surface that needed them. So the assertions here are mostly about
 * *derivation*: a page must not be able to state a different number, and a
 * capability row must not be able to describe a tool the code cannot run.
 *
 * Reading the file: `capabilityInventoryProblems()` holds the cross-field rules
 * (they belong in source, where an author adding a tool sees them), and the tests
 * below cover the counts, the two-axis labels, and the source-level facts a pure
 * module cannot see — which runner posts where, and what a route renders.
 */

const CATEGORIES: Record<ToolCategory, true> = {
  organize: true,
  optimize: true,
  "convert-to": true,
  "convert-from": true,
  edit: true,
  security: true,
  ai: true,
};

describe("T1 — the inventory is complete and internally consistent", () => {
  it("finds no cross-field disagreement", () => {
    // Availability vs execution location vs lifecycle vs processing mode vs
    // execution mode, checked in both directions, plus the upload ceiling and the
    // remote-job allowlist. See capabilityInventoryProblems() for each rule.
    expect(capabilityInventoryProblems()).toEqual([]);
  });

  it("covers every registry tool exactly once", () => {
    expect(TOOL_CAPABILITIES).toHaveLength(TOOLS.length);
    expect(new Set(TOOL_CAPABILITIES.map((c) => c.slug)).size).toBe(TOOLS.length);
    expect(new Set(TOOL_CAPABILITIES.map((c) => c.route)).size).toBe(TOOLS.length);
  });

  it("gives every tool a valid category and an explicit availability", () => {
    for (const c of TOOL_CAPABILITIES) {
      expect(CATEGORIES[c.category]).toBe(true);
      expect(typeof c.available).toBe("boolean");
      expect(["browser", "pdfdadi-server", "none"]).toContain(c.executionLocation);
    }
  });

  it("gives every available tool a processing mode and every unavailable one none", () => {
    for (const c of TOOL_CAPABILITIES) {
      if (c.available) {
        expect(c.processingMode).not.toBeNull();
        expect(c.processingLifecycle).not.toBe("unavailable");
        expect(c.maxUploadBytes).toBeGreaterThan(0);
      } else {
        expect(c.processingMode).toBeNull();
        expect(c.processingLifecycle).toBe("unavailable");
        expect(c.maxUploadBytes).toBeNull();
      }
    }
  });

  it("returns null for an unknown slug instead of falling back to a default", () => {
    // A fallback row is how an unbuilt tool acquires an execution location.
    expect(capabilityForSlug("not-a-tool")).toBeNull();
    expect(capabilityForSlug("")).toBeNull();
    expect(getToolExecutionLabel({ slug: "x", status: "planned" })).toBeNull();
  });
});

describe("T2 — the counts every surface quotes", () => {
  it("matches the intended inventory", () => {
    // The plan's stated inventory. These are assertions about reality, not
    // targets: if a tool ships or is withdrawn, the failure here is the prompt to
    // update the number deliberately rather than let one page drift from another.
    expect(TOOLS).toHaveLength(45);
    expect(getAvailableToolCount()).toBe(32);
    expect(getBrowserToolCount()).toBe(18);
    expect(getServerToolCount()).toBe(14);
    expect(getUnavailableToolCount()).toBe(13);
    expect(getPlannedToolCount()).toBe(5);
    expect(getAiComingSoonCount()).toBe(8);
  });

  it("adds up, so no tool is counted twice or missed", () => {
    expect(getBrowserToolCount() + getServerToolCount()).toBe(getAvailableToolCount());
    expect(getAvailableToolCount() + getUnavailableToolCount()).toBe(TOOLS.length);
    expect(getPlannedToolCount() + getAiComingSoonCount()).toBe(getUnavailableToolCount());
  });

  it("counts the list it is given, not a frozen module-load snapshot", () => {
    // Pages render the admin-merged registry. A selector that ignored its
    // argument would report the compiled count on a page showing merged tools.
    const oneServerTool = TOOLS.filter((t) => t.status === "functional-server").slice(0, 1);
    expect(getAvailableToolCount(oneServerTool)).toBe(1);
    expect(getBrowserToolCount(oneServerTool)).toBe(0);
    expect(getAvailableToolCount([])).toBe(0);
  });
});

describe("T3 — every card and route agree with the inventory", () => {
  it("derives each route from the slug", () => {
    for (const c of TOOL_CAPABILITIES) {
      expect(c.route).toBe(`/tools/${c.slug}`);
    }
  });

  it("carries the registry's own name, href and status", () => {
    for (const tool of TOOLS) {
      const c = capabilityForSlug(tool.slug);
      expect(c).not.toBeNull();
      expect(c?.name).toBe(tool.name);
      expect(c?.route).toBe(tool.href);
      expect(c?.implementationState).toBe(tool.status);
    }
  });
});

describe("T4 — the execution label states two things, not one", () => {
  it("keeps the privacy vocabulary exactly as PROCESSING_MODE_COPY defines it", () => {
    // The privacy half is a claim about where the file goes and must not be
    // reworded here: a second wording is a second claim to keep true.
    const browser = getToolExecutionLabel({ slug: "merge-pdf", status: "functional-client" });
    expect(browser?.location).toBe(PROCESSING_MODE_COPY.browser.label);
    expect(browser?.privacy).toBe(PROCESSING_MODE_COPY.browser.description);
    const server = getToolExecutionLabel({ slug: "compress-pdf", status: "functional-server" });
    expect(server?.location).toBe(PROCESSING_MODE_COPY["secure-cloud"].label);
    expect(server?.privacy).toBe(PROCESSING_MODE_COPY["secure-cloud"].description);
  });

  it("says something different about waiting than about privacy", () => {
    const browser = getToolExecutionLabel({ slug: "merge-pdf", status: "functional-client" });
    const server = getToolExecutionLabel({ slug: "compress-pdf", status: "functional-server" });
    expect(browser?.lifecycle).not.toBe(server?.lifecycle);
    expect(browser?.lifecycle).not.toBe(browser?.privacy);
    // The recorded complaint: "Secure cloud" alone left a visitor unable to tell
    // whether the page would block or hand them a job with a cancel button.
    expect(server?.lifecycle).toMatch(/background job/i);
    expect(browser?.lifecycle).toMatch(/your device/i);
  });

  it("agrees with the per-tool lifecycle for every tool, mode-level shortcut included", () => {
    // PrivacyNote knows the mode, not the slug, so it takes the mode-level
    // sentence. That is sound only while lifecycle is a function of mode; this is
    // the check that makes the shortcut safe rather than lucky.
    expect(lifecycleCopyDisagreements()).toEqual([]);
    expect(getLifecycleCopyForMode("workspace")).toBeNull();
  });

  it("describes no execution for a tool that cannot run", () => {
    for (const c of TOOL_CAPABILITIES.filter((x) => !x.available)) {
      expect(getToolExecutionLabel({ slug: c.slug, status: c.implementationState })).toBeNull();
    }
  });
});

describe("T5 — processing lifecycle is not 'browser vs cloud' again", () => {
  it("classifies Merge as local work with no queue", () => {
    const c = capabilityForSlug("merge-pdf");
    expect(c?.executionLocation).toBe("browser");
    expect(c?.processingMode).toBe("browser");
    expect(c?.processingLifecycle).toBe("immediate-local");
    expect(REMOTE_JOB_TOOL_SLUGS.has("merge-pdf")).toBe(false);
  });

  it("classifies Compress as a background job on PDFDadi servers", () => {
    const c = capabilityForSlug("compress-pdf");
    expect(c?.executionLocation).toBe("pdfdadi-server");
    expect(c?.processingMode).toBe("secure-cloud");
    expect(c?.processingLifecycle).toBe("async-job");
    expect(REMOTE_JOB_TOOL_SLUGS.has("compress-pdf")).toBe(true);
    // The one tool behind the unified-pipeline flag. Nothing else may claim it.
    expect(c?.pipelinePilot).toBe(true);
    expect(TOOL_CAPABILITIES.filter((x) => x.pipelinePilot).map((x) => x.slug)).toEqual([
      "compress-pdf",
    ]);
  });

  it("classifies a non-pilot server tool the same way, minus the pilot flag", () => {
    const c = capabilityForSlug("word-to-pdf");
    expect(c?.processingLifecycle).toBe("async-job");
    expect(c?.pipelinePilot).toBe(false);
  });

  it("records in source why no tool is classified as a synchronous server call", () => {
    // The plan expected one legacy synchronous server tool. There is none: all 14
    // submit through POST /api/jobs. `POST /api/tools/[slug]` still implements the
    // synchronous conversion but has no production caller, so classifying any tool
    // sync-server would describe a code path no user reaches.
    expect(TOOL_CAPABILITIES.some((c) => c.processingLifecycle === "sync-server")).toBe(false);
    expect(PROCESSING_LIFECYCLE_NOTES["sync-server"]).toMatch(/no production UI calls it/);
  });

  it("is backed by the runner that actually posts the job", () => {
    // The teeth under "async-job": the classification is a claim about wiring, and
    // wiring lives in a .tsx this node-environment suite cannot render.
    const runner = read("components/tools/runners/ServerToolRunner.tsx");
    expect(runner).toContain("/api/jobs?slug=");
    expect(runner).toContain("EventSource");
    expect(runner).toMatch(/\/cancel/);
    // No server runner may fall back to the synchronous route: that would make the
    // progress-and-cancel promise conditional on a code path with neither.
    for (const file of [
      "components/tools/runners/ServerToolRunner.tsx",
      "components/tools/runners/PipelineToolRunner.tsx",
    ]) {
      expect(read(file)).not.toContain("/api/tools/");
    }
  });
});

describe("T6 — an unavailable tool cannot look operational", () => {
  it("refuses every unavailable tool for every actor", () => {
    const env = { serverProcessingAvailable: true };
    for (const c of TOOL_CAPABILITIES.filter((x) => !x.available)) {
      const signedInPro = canUseTool(c.slug, { signedIn: true, plan: "pro" }, env);
      expect(signedInPro.allowed).toBe(false);
      if (!signedInPro.allowed) expect(signedInPro.reason).toBe("not-implemented");
    }
  });

  it("allows every available tool for an anonymous visitor", () => {
    // Not vacuous: the refusal above is about implementation state, not sign-in.
    // No tool gates on an account — `resolveJobActor` mints an anonymous owner.
    const env = { serverProcessingAvailable: true };
    for (const c of TOOL_CAPABILITIES.filter((x) => x.available)) {
      expect(canUseTool(c.slug, { signedIn: false, plan: "guest" }, env).allowed).toBe(true);
    }
  });

  it("refuses a server tool when the deployment has no server processing", () => {
    const off = { serverProcessingAvailable: false };
    const server = canUseTool("compress-pdf", { signedIn: true, plan: "free" }, off);
    expect(server.allowed).toBe(false);
    if (!server.allowed) expect(server.reason).toBe("server-processing-unavailable");
    // Build state, environment state and plan entitlement are separate axes: a
    // browser tool is unaffected by a server outage.
    expect(canUseTool("merge-pdf", { signedIn: false, plan: "guest" }, off).allowed).toBe(true);
  });

  it("refuses an unknown slug rather than admitting it", () => {
    const r = canUseTool("../../etc/passwd", { signedIn: true, plan: "pro" }, {
      serverProcessingAvailable: true,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("unknown-tool");
  });

  it("keeps unavailable tools out of the job allowlist", () => {
    for (const c of TOOL_CAPABILITIES.filter((x) => !x.available)) {
      expect(REMOTE_JOB_TOOL_SLUGS.has(c.slug)).toBe(false);
    }
  });

  it("renders a notice, not an upload control, on an unavailable tool route", () => {
    const page = read("app/(marketing)/tools/[slug]/page.tsx");
    expect(page).toContain("AiComingSoonNotice");
    expect(page).toContain("PlannedNotice");
    const notices = read("components/tools/StatusNotice.tsx");
    // No upload zone, no submit control, and a way back to what does work.
    expect(notices).not.toContain("UploadDropzone");
    expect(notices).not.toMatch(/<input[^>]*type="file"/);
    expect(notices).toContain('href="/tools"');
  });
});

describe("T13 — the AI tools are stated as unbuilt", () => {
  it("marks all eight as coming soon, Chat with PDF included", () => {
    const ai = TOOL_CAPABILITIES.filter((c) => c.implementationState === "coming-soon-ai");
    expect(ai).toHaveLength(8);
    for (const c of ai) {
      expect(c.available).toBe(false);
      expect(c.executionLocation).toBe("none");
      expect(c.category).toBe("ai");
    }
    const chat = capabilityForSlug("chat-with-pdf");
    expect(chat?.implementationState).toBe("coming-soon-ai");
    expect(chat?.available).toBe(false);
    expect(chat?.processingLifecycle).toBe("unavailable");
  });

  it("gives no AI tool an execution location, not even a planned AI server", () => {
    // "planned-ai-server" would be a location for work that has no server. The
    // location axis describes where a file goes today; an unbuilt tool sends it
    // nowhere.
    for (const c of TOOL_CAPABILITIES.filter((c) => c.category === "ai")) {
      expect(c.executionLocation).toBe("none");
      expect(c.maxUploadBytes).toBeNull();
    }
  });
});

describe("T17 — the CMS cannot edit implementation truth", () => {
  it("reads the compiled registry, never the admin store", () => {
    // The store CAN override `status` (data/admin/index.ts merges it), so the
    // capability model must not read the merged list: an editor flipping a
    // coming-soon tool to functional would otherwise change what the site claims
    // the code can do. Editorial fields (title, description, SEO copy, icon)
    // still come from the merged store — those are not implementation truth.
    const src = read("lib/tools/capability.ts");
    expect(src).toContain('from "@/data/tools"');
    expect(src).not.toContain("data/admin");
    expect(src).not.toContain("adminRuntime");
    expect(src).not.toContain("getServerToolConfigMerged");
  });

  it("still cannot be executed even if the store claims a tool is functional", () => {
    // Three independent code-side gates, none of them store-driven.
    expect(read("app/api/jobs/route.ts")).toMatch(/assertRemoteJobTool|getProcessor/);
    expect(read("data/admin/index.ts")).toContain("defaultServerTools");
    for (const c of TOOL_CAPABILITIES.filter((x) => !x.available)) {
      expect(REMOTE_JOB_TOOL_SLUGS.has(c.slug)).toBe(false);
    }
  });
});

function read(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

/**
 * T22 — the OUTPUT dimensions, checked against the code that produces the bytes.
 *
 * `outputKind`, `editorOpenableOutput`, `workspaceSaveableOutput` and `multiOutput`
 * are the facts every result CTA is derived from, and three of them are
 * hand-written tables. A hand-written table that nothing checks is how the
 * Workspace flag came to be a bare `false` beside a doc comment describing a guard
 * that did not exist — and then a copy of the editor flag. So these read the
 * processors: the server registry is parsed out of
 * `lib/server/toolProcessing.ts` and each processor's own `mimeType` literal is
 * what the capability is compared against.
 */
describe("T22 — output capability matches the processors", () => {
  const serverSource = readFileSync(
    path.join(__dirname, "..", "server", "toolProcessing.ts"),
    "utf8",
  );

  /** The `processors` object literal, slug → the function name it resolves to. */
  const registry = (() => {
    const at = serverSource.indexOf("export const processors");
    expect(at, "processors registry not found").toBeGreaterThan(-1);
    const body = serverSource.slice(at, serverSource.indexOf("};", at));
    const map = new Map<string, string>();
    for (const line of body.split("\n")) {
      // `"compress-pdf": compress,` or `"pdf-to-jpg": (ctx) => pdfToImages(ctx, "jpeg"),`
      const direct = line.match(/^\s*"([a-z0-9-]+)":\s*([A-Za-z][A-Za-z0-9]*),/);
      if (direct) {
        map.set(direct[1], direct[2]);
        continue;
      }
      const arrow = line.match(/^\s*"([a-z0-9-]+)":\s*\([^)]*\)\s*=>\s*([A-Za-z][A-Za-z0-9]*)\(/);
      if (arrow) map.set(arrow[1], arrow[2]);
    }
    return map;
  })();

  /** Every `mimeType:` literal inside one processor function's body. */
  function mimeTypesOf(fnName: string): string[] {
    const at = serverSource.indexOf(`async function ${fnName}(`);
    expect(at, `processor not found: ${fnName}`).toBeGreaterThan(-1);
    const open = serverSource.indexOf("{", at);
    let depth = 0;
    let end = open;
    for (let i = open; i < serverSource.length; i += 1) {
      if (serverSource[i] === "{") depth += 1;
      else if (serverSource[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const body = serverSource.slice(open, end);
    const own = [...body.matchAll(/mimeType:\s*\n?\s*"([^"]+)"/g)].map((m) => m[1]);
    if (own.length > 0) return own;
    // `htmlToPdf` is `return officeToPdf(ctx)`. One level of delegation is
    // followed rather than special-cased, so the check keeps working if another
    // processor is expressed the same way.
    const delegate = body.match(/return\s+([A-Za-z][A-Za-z0-9]*)\(ctx/);
    expect(delegate, `no mimeType and no delegation in ${fnName}`).not.toBeNull();
    return mimeTypesOf(delegate![1]);
  }

  it("parses the registry it is going to check", () => {
    // A silent parse failure here would make every case below vacuous.
    expect(registry.size).toBe(14);
    expect(registry.get("compress-pdf")).toBe("compress");
    expect(registry.get("pdf-to-jpg")).toBe("pdfToImages");
  });

  it("claims `pdf` for exactly the server tools whose processor emits application/pdf", () => {
    for (const [slug, fn] of registry) {
      const capability = capabilityForSlug(slug);
      expect(capability, slug).not.toBeNull();
      const mimes = mimeTypesOf(fn);
      expect(mimes.length, `${slug}: no mimeType in ${fn}`).toBeGreaterThan(0);
      const allPdf = mimes.every((m) => m === "application/pdf");
      expect(capability!.outputKind === "pdf", `${slug} outputKind vs ${fn} (${mimes})`).toBe(
        allPdf,
      );
    }
  });

  it("claims `multiOutput` for exactly the processors that can emit an archive", () => {
    for (const [slug, fn] of registry) {
      const emitsZip = mimeTypesOf(fn).includes("application/zip");
      expect(capabilityForSlug(slug)!.multiOutput, slug).toBe(emitsZip);
    }
  });

  it("claims `pdf` for every browser tool, because every browser processor emits one", () => {
    const dir = path.join(__dirname, "..", "pdf");
    const emitted = new Set<string>();
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file === "types.ts") continue;
      for (const m of readFileSync(path.join(dir, file), "utf8").matchAll(
        /mimeType:\s*"([^"]+)"/g,
      )) {
        emitted.add(m[1]);
      }
    }
    expect(emitted.size, "no browser processor mimeType found").toBeGreaterThan(0);
    expect([...emitted]).toEqual(["application/pdf"]);
    for (const capability of TOOL_CAPABILITIES) {
      if (capability.implementationState !== "functional-client") continue;
      expect(capability.outputKind, capability.slug).toBe("pdf");
      expect(capability.multiOutput, capability.slug).toBe(false);
    }
  });

  it("does not offer the editor an encrypted PDF", () => {
    // `protect-pdf` really does produce a PDF — the capability that must differ is
    // openability, not the kind.
    const protect = capabilityForSlug("protect-pdf")!;
    expect(protect.outputKind).toBe("pdf");
    expect(protect.editorOpenableOutput).toBe(false);
    expect(mimeTypesOf(registry.get("protect-pdf")!)).toEqual(["application/pdf"]);
    // And the encryption is really there, so this is not a stale exception.
    expect(serverSource).toMatch(/--encrypt/);
  });

  it("never claims an editable or saveable output for a non-PDF result", () => {
    for (const capability of TOOL_CAPABILITIES) {
      if (capability.outputKind === "pdf") continue;
      expect(capability.editorOpenableOutput, capability.slug).toBe(false);
      expect(capability.workspaceSaveableOutput, capability.slug).toBe(false);
    }
  });

  /**
   * C5 — the two output questions are INDEPENDENT, and one tool proves it.
   *
   * `workspaceSaveableOutput` was `output.editorOpenable` — the same expression,
   * so every "saveable" assertion in this file was really an assertion about the
   * editor. Counting is not enough to catch that (the counts matched), so this
   * names the tool where the answers differ and reads the source for the two
   * expressions being separate.
   */
  it("C5 — answers the editor question and the Workspace question separately", () => {
    const protect = capabilityForSlug("protect-pdf")!;
    expect(protect.editorOpenableOutput).toBe(false);
    expect(protect.workspaceSaveableOutput).toBe(true);

    // A multi-file run is the mirror image: refused a Workspace for its own
    // reason (there is no single document), not because of the editor.
    const jpg = capabilityForSlug("pdf-to-jpg")!;
    expect(jpg.multiOutput).toBe(true);
    expect(jpg.workspaceSaveableOutput).toBe(false);

    // And the two flags are not the same expression. A rename that reunites them
    // would pass every count above.
    const source = read("lib/tools/capability.ts");
    expect(source).not.toMatch(/workspaceSaveableOutput:\s*output\.editorOpenable\b/);
    expect(source).toMatch(/workspaceSaveableOutput:\s*output\.workspaceSaveable\b/);
    expect(source).toMatch(/editorOpenableOutput:\s*output\.editorOpenable\b/);

    // The whole matrix disagrees on at least one tool, which is the fact that
    // makes the two fields worth having.
    const differ = TOOL_CAPABILITIES.filter(
      (c) => c.editorOpenableOutput !== c.workspaceSaveableOutput,
    ).map((c) => c.slug);
    expect(differ).toEqual(["protect-pdf"]);
  });

  it("C5 — the inventory self-check refuses each dimension's own contradiction", () => {
    // The invariants exist and are green on the real matrix.
    expect(capabilityInventoryProblems()).toEqual([]);
  });

  it("claims nothing at all for a tool that does not run", () => {
    for (const capability of TOOL_CAPABILITIES) {
      if (capability.available) continue;
      expect(capability.outputKind, capability.slug).toBe("none");
      expect(capability.editorOpenableOutput, capability.slug).toBe(false);
      expect(capability.workspaceSaveableOutput, capability.slug).toBe(false);
      expect(capability.multiOutput, capability.slug).toBe(false);
    }
  });

  it("states the resulting counts, so a flip cannot be silent", () => {
    const openable = TOOL_CAPABILITIES.filter((c) => c.editorOpenableOutput);
    const saveable = TOOL_CAPABILITIES.filter((c) => c.workspaceSaveableOutput);
    // 18 browser tools + 10 server PDF tools can be opened: `protect-pdf` is a
    // PDF but opaque; `pdf-to-jpg`, `pdf-to-png` and `pdf-to-word` are not PDFs
    // at all. 29 can be SAVED — the same set plus `protect-pdf`, whose bytes
    // Workspace stores without ever parsing them. The two numbers differing by
    // exactly one is the point; identical numbers is what hid the copy.
    expect(openable).toHaveLength(28);
    expect(saveable).toHaveLength(29);
    expect(saveable.map((c) => c.slug)).toContain("protect-pdf");
    expect(openable.map((c) => c.slug)).not.toContain("protect-pdf");
    expect(TOOL_CAPABILITIES.filter((c) => c.multiOutput).map((c) => c.slug)).toEqual([
      "pdf-to-jpg",
      "pdf-to-png",
    ]);
  });
});
