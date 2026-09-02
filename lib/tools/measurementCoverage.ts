import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tools as TOOLS, type Tool, type ToolStatus } from "@/data/tools";
import { executionModeForTool, type ToolExecutionMode } from "./executionPolicy";
import { costProfileFor } from "@/src/domain/metering/cost";
import { getProcessor } from "@/lib/server/toolProcessing";
import { buildProcessorRegistry } from "@/src/infrastructure/processing/processorRegistry";
import {
  isJobErrorCategory,
  isLocalToolErrorCategory,
  toJobErrorCategory,
} from "@/src/domain/jobs/jobErrors";
import { localErrorCategoryOf } from "@/lib/pdf/types";

/**
 * The measurement-coverage audit: every executable tool, and what measures it.
 *
 * ## Why this exists as its own artifact
 *
 * Coverage in this codebase comes from shared seams — `ToolPageTemplate` mounts
 * the funnel, `usePdfProcessor` reports the outcome, `submitToolJob` authorizes,
 * `runToolJob` settles — and each seam has its own guard test. That is the right
 * place to assert a seam holds. What no seam test can answer is the question an
 * operator actually asks: *is there a tool nobody is measuring?* A tool added
 * outside every seam is absent from every list those tests scan, and absence is
 * exactly what none of them can see.
 *
 * So this module walks the authoritative registry — `data/tools.ts`, the same
 * table the pages, the job allowlist and the cost model derive from — and
 * classifies every entry. A new tool appears here the moment it is registered,
 * with whatever coverage it actually has, which is the property that makes the
 * audit fail *for* the new tool rather than silently omitting it.
 *
 * ## Build-time only
 *
 * This reads the filesystem and imports the server processor registries, so it
 * belongs to tests and tooling, never to a bundle. It is not a runtime feature
 * and no request path calls it.
 *
 * ## What each coverage column means
 *
 * - `analyticsCoverage` — is this tool's funnel observed at all. For a local
 *   tool the evidence is a dedicated page rendered through `ToolPageTemplate`,
 *   because that is what mounts the provider that emits `tool_view` onward. For
 *   a server tool it is a registered processor, because a slug with no processor
 *   cannot reach the instrumented worker.
 * - `authoritativeMeteringCoverage` — does a customer's allowance move. Server
 *   tools must have both a processor (a metered path) and a cost profile
 *   (something to settle). Local tools are `not_applicable` by design, and that
 *   is a *requirement*, not an omission: a browser-run tool that consumed a
 *   server allowance would charge for work the server never did.
 * - `failureTaxonomyCoverage` — can a failure be counted without leaking. The
 *   evidence is that the classifier for this tool's execution mode is total:
 *   it answers a closed-union member for an arbitrary thrown value. A classifier
 *   that could return a raw message flips every tool in its mode to `missing`,
 *   which is the failure this column exists to catch.
 */

export type CoverageVerdict =
  /** Measured, with evidence named in `notes`. */
  | "covered"
  /** Not measured here *by design*, and the design is asserted below. */
  | "not_applicable"
  /** Should be measured and is not. Any occurrence is a gap. */
  | "missing";

export interface ToolCoverageRow {
  slug: string;
  name: string;
  status: ToolStatus;
  /** `null` for a non-executable tool: planned, or AI not yet built. */
  executionMode: ToolExecutionMode | null;
  analyticsCoverage: CoverageVerdict;
  authoritativeMeteringCoverage: CoverageVerdict;
  failureTaxonomyCoverage: CoverageVerdict;
  /** Why each verdict is what it is, for the row that fails. */
  notes: readonly string[];
}

/**
 * The per-tool facts the classification reads.
 *
 * Separated from `classifyTool` so the classifier is a pure function of evidence
 * and can be exercised against a tool that does *not* exist yet — which is the
 * only honest way to test "a new tool without coverage fails the audit".
 */
export interface ToolCoverageEvidence {
  /** A dedicated page that renders through `ToolPageTemplate`. */
  hasInstrumentedPage: boolean;
  /** Registered in either server processor registry. */
  hasServerProcessor: boolean;
  /** A cost profile that settles something. */
  hasCostProfile: boolean;
  /** The local thrown-value classifier answers a closed-union member. */
  localFailureClassifierTotal: boolean;
  /** The job error normalizer answers a closed-union member. */
  jobFailureClassifierTotal: boolean;
}

const TOOLS_DIR = "app/(marketing)/tools";

/** Whether this slug's page routes through the template that mounts the funnel. */
function hasInstrumentedPage(slug: string): boolean {
  const page = join(process.cwd(), TOOLS_DIR, slug, "page.tsx");
  if (!existsSync(page)) return false;
  return readFileSync(page, "utf8").includes("ToolPageTemplate");
}

/**
 * Totality of the two failure classifiers, probed rather than assumed.
 *
 * Both are declared to return a closed union, but a `String(err)` slipped into
 * either would satisfy the type and put a filename in the ledger. Probing with a
 * value that is deliberately *not* a tagged error is what distinguishes "returns
 * a category" from "returns whatever it was given".
 */
function classifiersAreTotal(): Pick<
  ToolCoverageEvidence,
  "localFailureClassifierTotal" | "jobFailureClassifierTotal"
> {
  const leaky = new Error('"Q3-layoffs.pdf" could not be read at /var/tmp/staging/abc');
  return {
    localFailureClassifierTotal: isLocalToolErrorCategory(localErrorCategoryOf(leaky)),
    jobFailureClassifierTotal: isJobErrorCategory(toJobErrorCategory(leaky.message)),
  };
}

/** The evidence for one registered slug. */
export function gatherEvidence(slug: string): ToolCoverageEvidence {
  const pipeline = buildProcessorRegistry();
  return {
    hasInstrumentedPage: hasInstrumentedPage(slug),
    // Either registry counts: the pilot runs through the pipeline registry and
    // the other thirteen through the legacy one, and both worker paths meter.
    hasServerProcessor: pipeline.has(slug) || getProcessor(slug) !== undefined,
    hasCostProfile: costProfileFor(slug) !== null,
    ...classifiersAreTotal(),
  };
}

/** Classifies one tool from its evidence. Pure. */
export function classifyTool(
  tool: Pick<Tool, "slug" | "name" | "status">,
  evidence: ToolCoverageEvidence,
): ToolCoverageRow {
  const executionMode = executionModeForTool(tool as Tool);
  const notes: string[] = [];

  if (executionMode === null) {
    // Not executable, so there is nothing to measure — but the row is still
    // emitted. A tool that vanished from the audit on becoming "planned" would
    // vanish again on the day it ships.
    notes.push(`${tool.status}: not executable, nothing to measure`);
    return {
      slug: tool.slug,
      name: tool.name,
      status: tool.status,
      executionMode,
      analyticsCoverage: "not_applicable",
      authoritativeMeteringCoverage: "not_applicable",
      failureTaxonomyCoverage: "not_applicable",
      notes,
    };
  }

  if (executionMode === "local") {
    const analytics = evidence.hasInstrumentedPage ? "covered" : "missing";
    if (analytics === "missing") {
      notes.push("no page rendering through ToolPageTemplate, so no funnel is mounted");
    }
    // A local tool with a server processor is not "extra coverage" — it is a
    // browser-only privacy claim with a server path behind it.
    const metering: CoverageVerdict = evidence.hasServerProcessor
      ? "missing"
      : "not_applicable";
    if (metering === "missing") {
      notes.push("local tool has a server processor: it could consume a remote allowance");
    }
    const taxonomy = evidence.localFailureClassifierTotal ? "covered" : "missing";
    if (taxonomy === "missing") {
      notes.push("local failure classifier does not return a closed-union category");
    }
    return {
      slug: tool.slug,
      name: tool.name,
      status: tool.status,
      executionMode,
      analyticsCoverage: analytics,
      authoritativeMeteringCoverage: metering,
      failureTaxonomyCoverage: taxonomy,
      notes,
    };
  }

  const analytics = evidence.hasServerProcessor ? "covered" : "missing";
  if (analytics === "missing") {
    notes.push("no registered processor, so it cannot reach an instrumented worker");
  }
  const metering =
    evidence.hasServerProcessor && evidence.hasCostProfile ? "covered" : "missing";
  if (metering === "missing" && !evidence.hasCostProfile) {
    notes.push("no cost profile: a metered run would settle zero compute");
  }
  const taxonomy = evidence.jobFailureClassifierTotal ? "covered" : "missing";
  if (taxonomy === "missing") {
    notes.push("job error normalizer does not return a closed-union category");
  }
  return {
    slug: tool.slug,
    name: tool.name,
    status: tool.status,
    executionMode,
    analyticsCoverage: analytics,
    authoritativeMeteringCoverage: metering,
    failureTaxonomyCoverage: taxonomy,
    notes,
  };
}

/** The whole registry, classified. One row per tool, always. */
export function auditMeasurementCoverage(): readonly ToolCoverageRow[] {
  // Evidence that is global rather than per-slug is computed once; the
  // filesystem and registry lookups are per-slug.
  const classifiers = classifiersAreTotal();
  const pipeline = buildProcessorRegistry();
  return TOOLS.map((tool) =>
    classifyTool(tool, {
      hasInstrumentedPage: hasInstrumentedPage(tool.slug),
      hasServerProcessor: pipeline.has(tool.slug) || getProcessor(tool.slug) !== undefined,
      hasCostProfile: costProfileFor(tool.slug) !== null,
      ...classifiers,
    }),
  );
}

/**
 * Every gap in the audit, as one line each.
 *
 * The self-check shape the codebase already uses (`costProfileGaps`,
 * `executionPolicyDisagreements`): an empty array is the invariant, and the
 * strings are for the human who has to fix it.
 */
export function measurementCoverageGaps(): string[] {
  const gaps: string[] = [];
  for (const row of auditMeasurementCoverage()) {
    for (const [column, verdict] of [
      ["analyticsCoverage", row.analyticsCoverage],
      ["authoritativeMeteringCoverage", row.authoritativeMeteringCoverage],
      ["failureTaxonomyCoverage", row.failureTaxonomyCoverage],
    ] as const) {
      if (verdict === "missing") {
        gaps.push(`${row.slug} (${row.executionMode ?? "not executable"}) ${column}: ${row.notes.join("; ")}`);
      }
    }
  }
  return gaps;
}
