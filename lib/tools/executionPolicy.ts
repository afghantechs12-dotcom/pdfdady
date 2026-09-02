import { tools as TOOLS, type Tool, type ToolStatus } from "@/data/tools";
import {
  PROCESSING_MODE_COPY,
  processingModeForStatus,
  type ProcessingMode,
  type ProcessingModeCopy,
} from "./processingMode";

/**
 * WHERE a tool runs. One authoritative answer, for every consumer.
 *
 * This module is deliberately the *only* place in the codebase that decides
 * whether a tool executes on the user's device or as a server job. Before it
 * existed the same decision was re-derived in at least four places — the
 * dynamic tool page (which filtered on `functional-client`), the job API route
 * (which asked whether a processor happened to be registered), the privacy note
 * (which took a hard-coded `"server"` string as a prop), and the runner
 * component chosen per page. Four derivations of one fact is four chances for
 * them to disagree, and the failure mode is not cosmetic: a tool that renders
 * "runs in your browser" while POSTing bytes to `/api/jobs` is a false privacy
 * claim.
 *
 * `ToolExecutionMode` is the execution vocabulary; `ProcessingMode` (in
 * ./processingMode.ts) remains the *user-facing* vocabulary. They are related
 * but not the same thing — `workspace` is a storage mode with no execution
 * meaning, and `null` (a tool that cannot run yet) has no execution mode at
 * all. `processingModeForExecutionMode` is the sanctioned bridge, so the copy a
 * user reads is derived from the code path their bytes actually take.
 *
 * Derivation, not duplication: the matrix below is computed from `TOOLS`, so a
 * tool cannot be added to the registry and forgotten here.
 */
export type ToolExecutionMode = "local" | "remote_job";

/**
 * Maps a registry status to an execution mode.
 *
 * `planned` and `coming-soon-ai` return null on purpose: they are not
 * executable, and inventing a mode for them would let a caller render a working
 * upload affordance for a tool with no implementation behind it.
 */
export function executionModeForStatus(status: ToolStatus): ToolExecutionMode | null {
  switch (status) {
    case "functional-client":
      return "local";
    case "functional-server":
      return "remote_job";
    case "planned":
    case "coming-soon-ai":
      return null;
  }
}

/** The execution mode for a tool object. */
export function executionModeForTool(tool: Tool): ToolExecutionMode | null {
  return executionModeForStatus(tool.status);
}

const BY_SLUG: ReadonlyMap<string, Tool> = new Map(TOOLS.map((t) => [t.slug, t]));

/**
 * The execution mode for a slug, or null when the slug is unknown or the tool
 * is not executable. Callers must treat null as "refuse", never as a default.
 */
export function executionModeForSlug(slug: string): ToolExecutionMode | null {
  const tool = BY_SLUG.get(slug);
  return tool ? executionModeForTool(tool) : null;
}

function slugsForMode(mode: ToolExecutionMode): ReadonlySet<string> {
  return new Set(
    TOOLS.filter((t) => executionModeForTool(t) === mode).map((t) => t.slug),
  );
}

/** Every tool that runs entirely on the user's device. Derived from TOOLS. */
export const LOCAL_TOOL_SLUGS: ReadonlySet<string> = slugsForMode("local");

/**
 * Every tool that must run as a server job — and therefore the allowlist the
 * job API validates against. A slug outside this set is rejected before any
 * upload is staged or any processor is looked up.
 */
export const REMOTE_JOB_TOOL_SLUGS: ReadonlySet<string> = slugsForMode("remote_job");

/** True when this tool's bytes must never leave the browser. */
export function isLocalTool(slug: string): boolean {
  return executionModeForSlug(slug) === "local";
}

/** True when this tool is permitted to create a processing job. */
export function requiresRemoteJob(slug: string): boolean {
  return executionModeForSlug(slug) === "remote_job";
}

/**
 * Why each remote tool cannot run locally, keyed by slug.
 *
 * This is not documentation for its own sake. "Prefer local execution when it
 * improves privacy, speed, cost or scalability without reducing quality" is
 * only a real policy if each exception is justified and re-checkable; a guard
 * test asserts these keys are exactly `REMOTE_JOB_TOOL_SLUGS`, so a new server
 * tool cannot be added without stating why it is not local.
 *
 * Every entry below reduces to the same shape: the work needs a native binary
 * (Ghostscript, qpdf, LibreOffice, poppler, OCRmyPDF) with no WebAssembly build
 * in this project that matches its output quality. Where a local
 * implementation *is* viable, see LOCAL_PREFERENCE_REVIEW.
 */
export const REMOTE_JOB_REASON: Record<string, string> = {
  "compress-pdf": "Needs Ghostscript image/stream re-encoding; pdf-lib cannot resample embedded images.",
  "repair-pdf": "Needs qpdf structural recovery with a Ghostscript rewrite fallback.",
  "pdf-to-pdfa": "Needs Ghostscript's PDF/A conversion and ICC profile embedding.",
  "ocr-pdf": "Needs OCRmyPDF + Tesseract language data (hundreds of MB, not shippable to a browser).",
  "word-to-pdf": "Needs LibreOffice for OOXML layout fidelity.",
  "powerpoint-to-pdf": "Needs LibreOffice for OOXML layout fidelity.",
  "excel-to-pdf": "Needs LibreOffice for OOXML layout fidelity.",
  "html-to-pdf": "Needs a server-side renderer; rendering untrusted HTML in the user's page is unsafe.",
  "pdf-to-word": "Needs LibreOffice's PDF import filter to reconstruct a flow document.",
  "pdf-to-jpg": "Needs poppler (pdftoppm) rasterization at print resolution.",
  "pdf-to-png": "Needs poppler (pdftoppm) rasterization at print resolution.",
  "protect-pdf": "Needs qpdf AES encryption; pdf-lib cannot write encrypted PDFs.",
  "unlock-pdf": "Needs qpdf decryption.",
  "flatten-pdf": "Needs qpdf to flatten annotations and form fields into page content.",
};

/**
 * Remote tools whose local viability was considered and the outcome.
 *
 * Recorded so the "prefer local" rule is auditable rather than assumed. Both
 * entries are candidates, not commitments — moving them is out of scope for
 * this phase, and doing it badly would reduce output quality, which the rule
 * explicitly forbids trading away.
 */
export const LOCAL_PREFERENCE_REVIEW: { slug: string; verdict: string }[] = [
  {
    slug: "pdf-to-jpg",
    verdict:
      "Candidate: pdfjs-dist already renders pages to canvas in the editor, so browser rasterization is achievable. Kept remote for now because pdftoppm's DPI/colour handling is the current quality baseline and changing it silently would regress output.",
  },
  {
    slug: "pdf-to-png",
    verdict: "Same as pdf-to-jpg — same renderer, same reason.",
  },
];

export interface ToolExecutionEntry {
  slug: string;
  name: string;
  status: ToolStatus;
  mode: ToolExecutionMode | null;
  /** Populated for remote tools only; explains the native dependency. */
  reason: string | null;
}

/**
 * The full tool-execution matrix, derived from the registry at module load.
 *
 * Exported so tests, the security review and any future admin surface all read
 * one table rather than re-deriving it.
 */
export const TOOL_EXECUTION_MATRIX: readonly ToolExecutionEntry[] = TOOLS.map((t) => {
  const mode = executionModeForTool(t);
  return {
    slug: t.slug,
    name: t.name,
    status: t.status,
    mode,
    reason: mode === "remote_job" ? (REMOTE_JOB_REASON[t.slug] ?? null) : null,
  };
});

/** Bridges execution mode to the user-facing processing vocabulary. */
export function processingModeForExecutionMode(mode: ToolExecutionMode): ProcessingMode {
  return mode === "local" ? "browser" : "secure-cloud";
}

/**
 * The privacy/processing copy for a tool, derived from its execution mode.
 *
 * This is what tool pages should call instead of passing a literal
 * `"browser"`/`"server"` prop, so the sentence a user reads and the code path
 * their file takes cannot drift apart.
 */
export function executionCopyForSlug(slug: string): ProcessingModeCopy | null {
  const mode = executionModeForSlug(slug);
  return mode ? PROCESSING_MODE_COPY[processingModeForExecutionMode(mode)] : null;
}

/** Thrown when a caller tries to run a tool through the wrong execution path. */
export class ToolExecutionModeError extends Error {
  readonly slug: string;
  constructor(slug: string, message: string) {
    super(message);
    this.name = "ToolExecutionModeError";
    this.slug = slug;
  }
}

/**
 * The server-side allowlist gate. Every processing-job entry point calls this
 * before staging bytes, so an unknown slug, a browser-only tool or an
 * unimplemented tool is refused by policy rather than by whatever the next
 * layer happens to do.
 */
export function assertRemoteJobTool(slug: string): void {
  const mode = executionModeForSlug(slug);
  if (mode === "remote_job") return;
  if (mode === "local") {
    throw new ToolExecutionModeError(
      slug,
      `Tool "${slug}" runs locally and must not create a server job.`,
    );
  }
  throw new ToolExecutionModeError(slug, `Tool "${slug}" is not available for processing.`);
}

/**
 * Consistency check between this policy and ./processingMode.ts.
 *
 * Both modules derive from `ToolStatus`, so they can only disagree if one is
 * edited without the other. Exported (rather than living in the test) so the
 * invariant is stated next to the code it constrains.
 */
export function executionPolicyDisagreements(): string[] {
  const problems: string[] = [];
  for (const tool of TOOLS) {
    const exec = executionModeForTool(tool);
    const processing = processingModeForStatus(tool.status);
    if (exec === null && processing !== null) {
      problems.push(`${tool.slug}: no execution mode but processing mode "${processing}"`);
    }
    if (exec !== null && processing !== processingModeForExecutionMode(exec)) {
      problems.push(
        `${tool.slug}: execution mode "${exec}" implies "${processingModeForExecutionMode(exec)}" but processingMode says "${processing}"`,
      );
    }
  }
  return problems;
}
