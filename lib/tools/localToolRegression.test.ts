import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import {
  LOCAL_TOOL_SLUGS,
  REMOTE_JOB_TOOL_SLUGS,
  ToolExecutionModeError,
  assertRemoteJobTool,
  executionModeForSlug,
  isLocalTool,
} from "./executionPolicy";
import { buildProcessorRegistry } from "@/src/infrastructure/processing/processorRegistry";
import { mergePdfs } from "@/lib/pdf/merge";
import { splitPdf } from "@/lib/pdf/split";
import { editPdf } from "@/lib/pdf/edit";

/**
 * Regression protection for the tools that already work well in the browser.
 *
 * The whole point of this phase is that heavy work stops running inside a
 * request — and the standing risk of building a job pipeline is that it starts
 * attracting work that never needed it. Merge, Split, Rotate and Organize are
 * fast, private and free precisely because the bytes never leave the device.
 * That is a property nobody notices losing: routing merge through a job would
 * still produce a correct PDF, so no functional test would fail, and the only
 * casualty would be the privacy claim printed on the page.
 *
 * So this file asserts locality three independent ways — what the policy says,
 * what the code actually does with the network taken away, and what the module
 * graph is even capable of reaching. A single one of those could be satisfied by
 * accident; all three cannot.
 */

/** The four tools §4 names explicitly, plus the routes they are served on. */
const GUARDED = [
  { slug: "merge-pdf", route: "merge-pdf", runner: "MergeTool" },
  { slug: "split-pdf", route: "split-pdf", runner: "SplitTool" },
  { slug: "rotate-pdf", route: "rotate-pdf", runner: "EditTool" },
  { slug: "organize-pdf", route: "organize-pdf", runner: "EditTool" },
] as const;

describe("local tools: execution policy", () => {
  for (const { slug } of GUARDED) {
    it(`classifies ${slug} as local`, () => {
      expect(executionModeForSlug(slug)).toBe("local");
      expect(isLocalTool(slug)).toBe(true);
    });

    it(`keeps ${slug} out of the remote-job allowlist`, () => {
      expect(REMOTE_JOB_TOOL_SLUGS.has(slug)).toBe(false);
      expect(LOCAL_TOOL_SLUGS.has(slug)).toBe(true);
    });

    it(`refuses to create a job for ${slug} even if asked directly`, () => {
      // The allowlist is not advisory. A caller that reached the job entry point
      // with a local slug — a hand-crafted POST, a copy-pasted fetch, a future
      // refactor — is refused by policy before any byte is staged.
      expect(() => assertRemoteJobTool(slug)).toThrow(ToolExecutionModeError);
      expect(() => assertRemoteJobTool(slug)).toThrow(/runs locally/);
    });
  }

  it("has no processor registered for any local tool", () => {
    // "Requires no worker" stated where the worker would have to look. A local
    // slug that ever gained a processor would be a tool quietly capable of
    // server execution.
    const registry = buildProcessorRegistry();
    for (const slug of LOCAL_TOOL_SLUGS) {
      expect(registry.has(slug)).toBe(false);
    }
  });

  it("guards every local tool, not just the four named ones", () => {
    // The named four are the brief's examples; the guarantee is meant to cover
    // the whole set, and a new browser tool should inherit it without anyone
    // remembering to add it here.
    expect(LOCAL_TOOL_SLUGS.size).toBeGreaterThanOrEqual(GUARDED.length);
    for (const slug of LOCAL_TOOL_SLUGS) {
      expect(() => assertRemoteJobTool(slug)).toThrow(ToolExecutionModeError);
      expect(REMOTE_JOB_TOOL_SLUGS.has(slug)).toBe(false);
    }
  });
});

/**
 * Network sabotage. Every outbound mechanism available to browser code is
 * replaced with something that throws loudly, so "no upload happens" is proven
 * by the operation *succeeding* under those conditions rather than by reading
 * the source and believing it.
 */
const NETWORK_GLOBALS = [
  "fetch",
  "XMLHttpRequest",
  "EventSource",
  "WebSocket",
  "navigator",
] as const;

class NetworkAttempted extends Error {}

describe("local tools: run with the network taken away", () => {
  /**
   * Saved property *descriptors*, not values: `navigator` is a getter-only
   * accessor on the Node global, so assigning to it throws and restoring it by
   * assignment would leave the sabotage installed for every later test file.
   */
  const saved = new Map<string, PropertyDescriptor | undefined>();

  function install(key: string, value: unknown): void {
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }

  beforeEach(() => {
    const boom = (what: string) => () => {
      throw new NetworkAttempted(`A local tool tried to use ${what}.`);
    };
    for (const key of NETWORK_GLOBALS) {
      saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    install("fetch", boom("fetch"));
    install("XMLHttpRequest", boom("XMLHttpRequest"));
    install("EventSource", boom("EventSource"));
    install("WebSocket", boom("WebSocket"));
    install("navigator", { sendBeacon: boom("sendBeacon") });
  });

  afterEach(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as unknown as Record<string, unknown>)[key];
    }
    saved.clear();
  });

  /** A real multi-page PDF, built in-process; no fixture file, no network. */
  async function samplePdf(pages: number, name = "input.pdf"): Promise<File> {
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    for (let i = 0; i < pages; i++) doc.addPage([300, 400]);
    const bytes = await doc.save();
    return new File([bytes], name, { type: "application/pdf" });
  }

  async function pageCountOf(blob: Blob): Promise<number> {
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(await blob.arrayBuffer());
    return doc.getPageCount();
  }

  it("merges two PDFs entirely on the device", async () => {
    const out = await mergePdfs([await samplePdf(2, "a.pdf"), await samplePdf(3, "b.pdf")]);
    expect(await pageCountOf(out.blob)).toBe(5);
    expect(out.blob.size).toBeGreaterThan(0);
  });

  it("splits a PDF entirely on the device", async () => {
    const out = await splitPdf(await samplePdf(6), { from: 2, to: 4 });
    expect(await pageCountOf(out.blob)).toBe(3);
  });

  it("rotates pages entirely on the device", async () => {
    const { degrees } = await import("pdf-lib");
    void degrees;
    const out = await editPdf(await samplePdf(2), [
      { originalIndex: 0, rotation: 90 },
      { originalIndex: 1, rotation: 0 },
    ]);
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(await out.blob.arrayBuffer());
    expect(doc.getPage(0).getRotation().angle).toBe(90);
    expect(doc.getPage(1).getRotation().angle).toBe(0);
  });

  it("reorders and deletes pages entirely on the device", async () => {
    // Organize is delete + reorder in one model, so one call covers both.
    const out = await editPdf(await samplePdf(4), [
      { originalIndex: 3, rotation: 0 },
      { originalIndex: 1, rotation: 0 },
    ]);
    expect(await pageCountOf(out.blob)).toBe(2);
  });

  it("produces a downloadable blob, not a job id", async () => {
    // The shape of the result is the observable difference between the two
    // execution modes: local tools hand back bytes the browser can save, remote
    // tools hand back a handle that has to be polled and then fetched.
    const out = await mergePdfs([await samplePdf(1, "a.pdf"), await samplePdf(1, "b.pdf")]);
    expect(out.blob).toBeInstanceOf(Blob);
    expect(out.mimeType).toBe("application/pdf");
    expect(out).not.toHaveProperty("jobId");
    expect(out).not.toHaveProperty("id");
  });

  it("the sabotage is real (control)", () => {
    // Without this, every test above could be passing because the stubs were
    // never installed.
    const sabotaged = globalThis as unknown as { fetch: () => void };
    expect(() => sabotaged.fetch()).toThrow(NetworkAttempted);
  });
});

/**
 * Static reachability. The tests above prove these code paths *do not* call the
 * server today; this proves they *cannot* — nothing in the module graph behind a
 * local tool page can even see the job pipeline.
 *
 * This is the check that survives refactoring, because it fails on the import
 * rather than on the behaviour: adding `fetch("/api/jobs")` to a local runner
 * would be caught by the first group only if a test happened to exercise that
 * branch, whereas it is caught here as soon as it exists.
 */
describe("local tools: what the module graph can reach", () => {
  const ROOT = process.cwd();

  function resolveSpecifier(fromFile: string, spec: string): string | null {
    let base: string;
    if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
    else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
    else return null; // bare specifier: a package, not our code
    return base;
  }

  async function firstExisting(base: string): Promise<string | null> {
    const candidates = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      path.join(base, "index.ts"),
      path.join(base, "index.tsx"),
    ];
    for (const c of candidates) {
      const stat = await fs.stat(c).catch(() => null);
      if (stat?.isFile()) return c;
    }
    return null;
  }

  /** Every first-party module reachable from `entries`, transitively. */
  async function closureOf(entries: string[]): Promise<Map<string, string>> {
    const seen = new Map<string, string>();
    const queue = [...entries];
    while (queue.length) {
      const file = queue.shift()!;
      if (seen.has(file)) continue;
      const source = await fs.readFile(file, "utf8");
      seen.set(file, source);
      // Static imports, `export ... from`, and dynamic `import(...)` — the last
      // matters because the local tools load pdf-lib that way, and a lazily
      // imported job client would otherwise slip through.
      const specs = [
        ...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g),
      ].map((m) => m[1]);
      for (const spec of specs) {
        const base = resolveSpecifier(file, spec);
        if (!base) continue;
        const resolved = await firstExisting(base);
        if (resolved && !seen.has(resolved)) queue.push(resolved);
      }
    }
    return seen;
  }

  /**
   * Things that mean "this file talks to the processing pipeline".
   *
   * Deliberately about the *pipeline*, not about networking in general: a local
   * tool page may legitimately reach shared code that logs analytics or reads a
   * feature flag, and banning the word `fetch` outright would make this test a
   * nuisance that gets deleted rather than a guard that gets kept.
   */
  const FORBIDDEN: { pattern: RegExp; why: string }[] = [
    { pattern: /["'`]\/api\/jobs/, why: "posts to the job API" },
    { pattern: /\/api\/tools\//, why: "posts to the legacy server-tool API" },
    { pattern: /ProcessingJobService|createProcessingJob/, why: "uses the job service" },
    { pattern: /\bIUploadService\b|uploadStream\(/, why: "uploads file bytes" },
    { pattern: /\bnew EventSource\b/, why: "opens a progress stream" },
    { pattern: /PipelineToolRunner|ServerToolRunner/, why: "renders a server runner" },
    { pattern: /\bPROCESSING_JOB_TYPE\b/, why: "references the job type" },
  ];

  let closure: Map<string, string>;

  beforeEach(async () => {
    const entries = await Promise.all(
      GUARDED.map(({ route }) =>
        firstExisting(path.join(ROOT, "app/(marketing)/tools", route, "page")),
      ),
    );
    const found = entries.filter((e): e is string => e !== null);
    expect(found).toHaveLength(GUARDED.length);
    closure = await closureOf(found);
  });

  it("walks a real graph (control)", () => {
    // A resolver bug that silently found nothing would make every assertion
    // below pass on an empty set.
    expect(closure.size).toBeGreaterThan(GUARDED.length);
    const files = [...closure.keys()];
    expect(files.some((f) => f.endsWith("lib/pdf/merge.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("lib/pdf/edit.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("lib/pdf/split.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("runners/MergeTool.tsx"))).toBe(true);
  });

  /**
   * Comments are stripped before matching.
   *
   * The graph legitimately reaches `executionPolicy.ts`, whose doc comment quotes
   * `/api/jobs` while explaining why a local tool must never post there — the
   * clearest possible statement of this test's own rule, and it was failing the
   * test. A prose mention is not a call site; matching on it punishes explaining
   * the invariant, which is how a guard gets deleted instead of kept.
   */
  function codeOf(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");
  }

  for (const { pattern, why } of FORBIDDEN) {
    it(`reaches nothing that ${why}`, () => {
      const offenders = [...closure]
        .filter(([, source]) => pattern.test(codeOf(source)))
        .map(([file]) => path.relative(ROOT, file));
      expect(offenders).toEqual([]);
    });
  }

  it("would catch a local runner that started creating jobs (control)", () => {
    // Proves the patterns match the thing they are meant to match, by running
    // them against the server runner that legitimately does all of it.
    const serverRunner = path.join(ROOT, "components/tools/runners/ServerToolRunner.tsx");
    return fs.readFile(serverRunner, "utf8").then((source) => {
      const matched = FORBIDDEN.filter(({ pattern }) => pattern.test(codeOf(source)));
      expect(matched.length).toBeGreaterThan(0);
    });
  });

  it("serves each guarded route with its browser runner", async () => {
    for (const { route, runner } of GUARDED) {
      const page = await firstExisting(path.join(ROOT, "app/(marketing)/tools", route, "page"));
      const source = await fs.readFile(page!, "utf8");
      expect(source).toContain(`<${runner} `.trimEnd());
      expect(source).not.toContain("ServerToolRunner");
      expect(source).not.toContain("PipelineToolRunner");
    }
  });
});
