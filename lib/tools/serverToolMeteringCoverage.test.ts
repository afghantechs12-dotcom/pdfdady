import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { REMOTE_JOB_TOOL_SLUGS } from "./executionPolicy";
import { getProcessor } from "@/lib/server/toolProcessing";
import { costProfileGaps } from "@/src/domain/metering/cost";

/**
 * Authoritative metering coverage for SERVER tools, asserted structurally.
 *
 * ── The failure this prevents ───────────────────────────────────────────────
 *
 * compress-pdf was metered by hand as the pilot and the other thirteen server
 * tools were not. Nothing failed: every tool worked, every test passed, and the
 * usage dashboard showed one tool because there was only one tool to show. A
 * measurement gap never reports itself — it reports a smaller product.
 *
 * Coverage now comes from two shared seams instead of fourteen call sites:
 * `submitToolJob` (admission, shared by `/api/tools/[slug]` and `/api/jobs`) and
 * `runToolJob` (settlement, shared by both worker handlers). The pilot has its
 * own pair — `submitProcessingJob` and `ProcessingJobHandler`.
 *
 * So the guard against a future unmetered tool is not "does slug X appear in a
 * list", which a new tool would simply be absent from. It is: a server tool can
 * only run by going through one of those seams, and every seam meters. The last
 * test in this file is the load-bearing one — it fails if a third enqueue site
 * appears, which is the only way a new tool could reach a worker unmetered.
 *
 * ── Why source text ────────────────────────────────────────────────────────
 *
 * The behaviour of each seam is covered against real counters in
 * `legacyToolMetering.test.ts` and `meteringPipeline.test.ts`. What is left is a
 * property of the import graph and of statement order — "is admission before
 * staging", "is there a third way in" — which is readable without executing
 * anything. Comments are stripped first, so prose describing a call can neither
 * satisfy nor violate an assertion, this file's own prose included.
 */

const ROOT = process.cwd();

function code(...segments: string[]): string {
  return readFileSync(join(ROOT, ...segments), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");
}

/** Index of `needle`, asserting presence so an absence is never a pass. */
function at(src: string, needle: string): number {
  const idx = src.indexOf(needle);
  expect(idx, `expected to find ${JSON.stringify(needle)}`).toBeGreaterThan(-1);
  return idx;
}

const submit = () => code("lib/server/toolJobSubmit.ts");
const pilotSubmit = () => code("lib/server/processingJobSubmit.ts");
const worker = () => code("src/infrastructure/jobs/PdfToolWorkerHandler.ts");

describe("every server tool is reachable by a metered path", () => {
  it("has a processor for every remote slug, so none is served off-registry", () => {
    // The premise of everything below: a remote slug with no processor could not
    // run at all, and a slug served by something other than this registry would
    // not be routed through the metered handler.
    const missing = [...REMOTE_JOB_TOOL_SLUGS].filter((slug) => !getProcessor(slug));
    expect(missing).toEqual([]);
    expect(REMOTE_JOB_TOOL_SLUGS.size).toBeGreaterThanOrEqual(14);
  });

  it("has a cost profile for every remote slug", () => {
    // A metered tool with no profile settles zero compute — silently free work in
    // the one column the cost model is calibrated against.
    expect(costProfileGaps()).toEqual([]);
  });
});

describe("admission runs once, at the shared submit seam", () => {
  it("authorizes in the legacy submit and refuses with a limit error", () => {
    const s = submit();
    expect(s).toContain("metering.authorize({");
    expect(s).toContain("throw new UsageLimitError(");
    // From the execution policy, not a literal: a tool promoted between modes
    // must not keep reporting the mode it had when the call was written.
    expect(s).toContain("executionModeForSlug(slug)");
  });

  it("authorizes after validation and before anything is staged", () => {
    const s = submit();
    // Order matters twice over. A reservation taken before the batch checks would
    // be taken and thrown away by a 400; one taken after staging would let an
    // over-limit submission write files it is not allowed to process.
    expect(at(s, "TOOLS_BATCH_MAX_FILES")).toBeLessThan(at(s, "metering.authorize({"));
    expect(at(s, "metering.authorize({")).toBeLessThan(at(s, "uploadService.uploadStream({"));
  });

  it("releases the allowance on every exit that is not a running job", () => {
    const s = submit();
    // Staging and enqueue are the two things that can fail after the reservation
    // is held. Every one of those awaits must hand the error to the release path,
    // or a failed submission leaves a phantom operation on the customer's day.
    const guarded = s.match(/\.catch\(releaseOnFailure\)/g) ?? [];
    const risky = s.match(/uploadService\.uploadStream\(\{|jobService\.enqueue(Batch)?\(\{/g) ?? [];
    expect(risky.length).toBeGreaterThanOrEqual(4);
    expect(guarded).toHaveLength(risky.length);
    expect(s).toContain("await metering.release(reservation)");
  });

  it("carries the reservation into the job so the refund lands in its own window", () => {
    const s = submit();
    // Two enqueues, both carrying it. A job without the reference can still be
    // settled, but its refund would land in whatever day the worker finished in.
    expect(s.match(/usage: reservationRef\(reservation\)/g) ?? []).toHaveLength(2);
  });

  it("counts one operation per submission, not one per file", () => {
    const s = submit();
    // `inputBytes` sums the batch and `largestInputBytes` takes the max, but the
    // call is made ONCE for the whole submission. A loop here would make
    // "operations" mean "files", which no plan line says.
    expect(s.match(/metering\.authorize\(\{/g) ?? []).toHaveLength(1);
  });

  it("keeps the pilot's own admission intact", () => {
    // The pilot pipeline is a separate seam with the same obligations. Asserted
    // here too so "all server tools are admitted" is a claim about both paths.
    const p = pilotSubmit();
    expect(p).toContain("metering.authorize({");
    expect(p).toContain("UsageLimitError");
  });
});

describe("settlement runs once, at the shared worker seam", () => {
  it("settles on the success path and on the failure path", () => {
    const w = worker();
    // Both, and only from `runToolJob`: the single and batch handlers both route
    // through it, so all fourteen tools are settled by one call, not fourteen.
    expect(w.match(/await settleToolJobUsage\(deps, job, \{/g) ?? []).toHaveLength(2);
    const run = at(w, "async function runToolJob(");
    const success = at(w, 'result: "success",');
    expect(run).toBeLessThan(success);
  });

  it("settles both handlers by routing them through the one seam", () => {
    const w = worker();
    for (const factory of ["createPdfToolHandler", "createPdfToolBatchHandler"]) {
      const idx = at(w, `export function ${factory}(deps: PdfToolHandlerDeps)`);
      expect(
        w.slice(idx, idx + 200),
        `${factory} must run its body through runToolJob`,
      ).toContain("runToolJob(deps, job, ctx,");
    }
  });

  it("reports the normalized category and never the thrown text", () => {
    const w = worker();
    expect(w).toContain("classifyFailure(err, { cancelled })");
    expect(w).toContain("errorCategory: category,");
    // `diagnostic` is the half `classifyFailure` builds from the error's own
    // message. It belongs in the job's failure record, never in the meter.
    const settleIdx = at(w, "async function settleToolJobUsage(");
    expect(w.slice(settleIdx)).not.toContain("diagnostic");
  });

  it("distinguishes a cancelled run from a failed one", () => {
    // The allowance comes back either way, but a cancellation must not inflate
    // the failure rate for the tool.
    expect(worker()).toContain('cancelled || category === "cancelled" ? "cancelled" : "failure"');
  });

  it("settles from the job row's owner, not the payload's file owner", () => {
    const w = worker();
    const settleIdx = at(w, "async function settleToolJobUsage(");
    const body = w.slice(settleIdx, settleIdx + 2500);
    // Every legacy payload stages its input under the shared "anon" bucket, so
    // settling from the payload would file all usage under a single id.
    expect(body).toContain("ownerType: job.ownerType ?? \"system\"");
    expect(body).toContain("ownerId: job.ownerId ?? \"system\"");
    expect(body).not.toMatch(/ownerId: payload\??\.ownerId/);
  });

  it("cannot fail the job it is measuring", () => {
    const w = worker();
    const settleIdx = at(w, "async function settleToolJobUsage(");
    const body = w.slice(settleIdx, settleIdx + 2500);
    // The output is already in storage by the time this runs. A throw here would
    // make measurement a dependency of the product.
    expect(body).toMatch(/\} catch \(err\) \{[\s\S]*logger\.warn\(/);
    expect(body).toContain("if (!deps.metering) return;");
  });
});

describe("no server tool can reach a worker unmetered", () => {
  /**
   * The actual "a future REMOTE_JOB tool has no metering path" guard.
   *
   * A new server tool has exactly two options: route through one of the two
   * metered submit seams, or introduce a third enqueue site. The first is
   * covered by every test above. The second is what this catches — including the
   * case nobody would think to add a test for, because the new tool would simply
   * be absent from any list a slug-based test iterated over.
   */
  it("submits tool work only from a file that also authorizes it", () => {
    // The two services are the machinery, not entry points: they take the
    // reservation as a parameter and cannot manufacture one.
    const SERVICES = new Set([
      "src/application/services/PdfToolJobService.ts",
      "src/application/services/ProcessingJobService.ts",
    ]);
    // Calls that put tool work on the queue. `queue.enqueue` on a raw IQueue is
    // NOT one of these — the workspace jobs (`document.ingestion`,
    // `document.comparison`) use it with their own job types and are not tools.
    const SUBMITS = /\.enqueue(Batch)?\(\{|\.submitJob\(\{|\.createJob\(\{|\.createJob\(\s*$/m;
    /** …and the work being submitted is a TOOL's, not a workspace job's. */
    const TOOL_WORK =
      /PDF_TOOL_(BATCH_)?JOB_TYPE|PROCESSING_JOB_TYPE|PdfToolJobService|ProcessingJobService/;

    const offenders: string[] = [];
    for (const file of sourceFiles(["app", "lib", "src", "components", "hooks"])) {
      if (SERVICES.has(file)) continue;
      const src = code(...file.split("/"));
      if (!SUBMITS.test(src) || !TOOL_WORK.test(src)) continue;
      // The invariant, stated positively: a file that submits server work must
      // be a file that took an allowance for it. A new tool with its own submit
      // path fails here — which is the case no slug-based test could catch,
      // because the new tool would simply be absent from the list it iterates.
      if (!src.includes("metering.authorize(")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
    // And the scan sees the seams it is meant to police, so it cannot pass by
    // finding nothing at all.
    for (const [name, src] of [["legacy", submit()], ["pilot", pilotSubmit()]] as const) {
      expect(SUBMITS.test(src), `${name} submit must look like a submission`).toBe(true);
      expect(TOOL_WORK.test(src), `${name} submit must look like tool work`).toBe(true);
    }
  });

  it("keeps the workspace job types off the tool submit path", () => {
    // The two files the scan above deliberately does not treat as tool
    // submissions. Asserted rather than assumed: they are excluded because they
    // enqueue their OWN job types, not because of where they live.
    for (const [file, type] of [
      ["src/application/services/ComparisonJobHandler.ts", "COMPARISON_JOB_TYPE"],
      ["src/application/services/DocumentIngestionJobHandler.ts", "DOCUMENT_INGESTION_JOB_TYPE"],
    ]) {
      const src = code(...file.split("/"));
      expect(src, `${file} must enqueue its own type`).toContain(`type: ${type}`);
      expect(src, `${file} must not enqueue tool work`).not.toMatch(
        /PDF_TOOL_(BATCH_)?JOB_TYPE|PROCESSING_JOB_TYPE/,
      );
    }
  });

  it("registers the tool handlers in one place, with metering wired", () => {
    const boot = code("src/infrastructure/jobs/workerBootstrap.ts");
    // One registration site for the legacy job types, so there is no second
    // worker wired without the metering dep. The handler treats it as optional —
    // deliberately, so a worker without it still processes files — which makes
    // this the assertion that production actually has it.
    expect(boot.match(/metering,/g) ?? []).toHaveLength(2);
    expect(at(boot, "Tokens.UsageMeteringService")).toBeLessThan(
      at(boot, "createPdfToolHandler({"),
    );
    for (const type of ["PDF_TOOL_JOB_TYPE", "PDF_TOOL_BATCH_JOB_TYPE"]) {
      expect(boot.match(new RegExp(`register\\(\\s*${type}`, "g")) ?? []).toHaveLength(1);
    }
  });

  it("answers a refused submission with a limit status, not a malfunction", () => {
    // A client that gets 500 retries; a client that gets 429 waits. Both routes
    // that reach `submitToolJob` must map it, or an enforce-mode ceiling would
    // read as an outage and be hammered.
    for (const route of ["app/api/tools/[slug]/route.ts", "app/api/jobs/route.ts"]) {
      const src = code(...route.split("/"));
      expect(src, `${route} must map UsageLimitError`).toContain("UsageLimitError");
      expect(src, `${route} must answer 429`).toMatch(/429/);
    }
  });
});

/** Every non-test `.ts`/`.tsx` under `dirs`, as repo-relative paths. */
function sourceFiles(dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(ROOT, rel))) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const child = `${rel}/${entry}`;
      if (statSync(join(ROOT, child)).isDirectory()) {
        walk(child);
      } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        out.push(child);
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return out;
}
