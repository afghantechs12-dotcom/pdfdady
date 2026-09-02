import {
  LOCAL_TOOL_SLUGS,
  REMOTE_JOB_TOOL_SLUGS,
  type ToolExecutionMode,
} from "@/lib/tools/executionPolicy";

/**
 * HOW MUCH a piece of work costs to serve. One authoritative table.
 *
 * "Compute units" are a made-up currency, and saying so plainly is the point:
 * there is no cloud bill to reconcile against yet, so anything claiming to be
 * dollars would be fiction. What a unit *does* have to be is ordinally honest —
 * if OCR is roughly ten times the work of a page rotation, the numbers must say
 * so, because the questions this phase must answer ("how much processing do
 * different tools consume") are comparative, not absolute.
 *
 * The model is deliberately the simplest one that can be checked against
 * reality later:
 *
 *     units = base + perMegabyte × MB + perPage × pages
 *
 * `base` covers the fixed cost every server job pays regardless of input:
 * staging bytes into storage, spawning a process, materializing to disk,
 * uploading the result. `perMegabyte` covers the I/O and memory that scale with
 * the file. `perPage` covers per-page CPU, and is zero for tools that treat the
 * document as one opaque unit (a password change rewrites the encryption
 * dictionary; it does not care how many pages are behind it).
 *
 * These are estimates from what each tool actually does — see the native
 * dependency of each in `REMOTE_JOB_REASON`. They are calibratable: once real
 * `durationMs` rows exist, `measureCostUnits` can be compared against
 * `estimateCostUnits` and the constants revised. That is why the estimate and
 * the measurement are two named functions rather than one.
 */
export interface ToolCostProfile {
  /** Fixed cost of running the job at all. */
  base: number;
  /** Additional cost per megabyte of input. */
  perMegabyte: number;
  /** Additional cost per page, when the page count is known. */
  perPage: number;
}

const BYTES_PER_MB = 1024 * 1024;

/**
 * Cost profile per remote tool, keyed by slug.
 *
 * A guard test asserts these keys are exactly `REMOTE_JOB_TOOL_SLUGS`, so a new
 * server tool cannot be added without stating what it costs — the same
 * discipline `REMOTE_JOB_REASON` applies to *why* a tool is remote.
 */
export const TOOL_COST_PROFILES: Record<string, ToolCostProfile> = {
  // Ghostscript re-encodes every embedded image; cost tracks pages and bytes.
  "compress-pdf": { base: 2, perMegabyte: 1, perPage: 0.1 },
  // qpdf structural recovery, with a Ghostscript rewrite fallback that can double it.
  "repair-pdf": { base: 3, perMegabyte: 1, perPage: 0.1 },
  // Ghostscript PDF/A conversion plus ICC embedding — a full rewrite of the file.
  "pdf-to-pdfa": { base: 4, perMegabyte: 1.5, perPage: 0.2 },
  // By far the most expensive: Tesseract runs a recognition pass per page.
  "ocr-pdf": { base: 6, perMegabyte: 2, perPage: 2.5 },
  // LibreOffice: a heavyweight process start dominates; per-page layout is cheap.
  "word-to-pdf": { base: 8, perMegabyte: 1, perPage: 0.1 },
  "powerpoint-to-pdf": { base: 8, perMegabyte: 1, perPage: 0.15 },
  "excel-to-pdf": { base: 8, perMegabyte: 1, perPage: 0.15 },
  // Same LibreOffice start-up cost, plus PDF import reconstruction.
  "pdf-to-word": { base: 9, perMegabyte: 1.5, perPage: 0.3 },
  // A headless renderer per request; input is markup, so bytes matter little.
  "html-to-pdf": { base: 7, perMegabyte: 0.5, perPage: 0.2 },
  // poppler rasterizes at print resolution — per page, and the output is large.
  "pdf-to-jpg": { base: 3, perMegabyte: 1, perPage: 0.8 },
  "pdf-to-png": { base: 3, perMegabyte: 1, perPage: 1 },
  // qpdf AES encrypt/decrypt: one pass over the bytes, no per-page work.
  "protect-pdf": { base: 1, perMegabyte: 0.5, perPage: 0 },
  "unlock-pdf": { base: 1, perMegabyte: 0.5, perPage: 0 },
  // qpdf flattening walks annotations and form fields into page content.
  "flatten-pdf": { base: 2, perMegabyte: 0.75, perPage: 0.15 },
};

/**
 * The cost of a tool that runs on the user's own device: zero, to us.
 *
 * This is a statement about who pays, not a claim that browser work is free.
 * A local tool consumes the *user's* CPU and never touches a server process, so
 * charging it against a server allowance would be billing someone for their own
 * laptop. Local usage is still recorded — it answers "what do users actually
 * use" — it just never denies anything.
 */
export const LOCAL_TOOL_COST_PROFILE: ToolCostProfile = {
  base: 0,
  perMegabyte: 0,
  perPage: 0,
};

/** The profile for a slug, or null when the slug is unknown. */
export function costProfileFor(slug: string): ToolCostProfile | null {
  if (LOCAL_TOOL_SLUGS.has(slug)) return LOCAL_TOOL_COST_PROFILE;
  return TOOL_COST_PROFILES[slug] ?? null;
}

export interface CostInput {
  slug: string;
  inputBytes: number | null;
  /** Only when genuinely known; an estimate must not invent one. */
  pageCount?: number | null;
}

/**
 * Rounds a computed cost to a whole, non-negative unit.
 *
 * Counters are integers — a fractional cost silently truncated by the database
 * would make a month of small jobs cost nothing at all. Rounding UP to a minimum
 * of 1 for any real work means a thousand tiny operations still register as a
 * thousand units, which is the honest reading of "this owner did a lot".
 */
function toUnits(raw: number, isRealWork: boolean): number {
  if (!Number.isFinite(raw) || raw <= 0) return isRealWork ? 1 : 0;
  return Math.max(isRealWork ? 1 : 0, Math.ceil(raw));
}

/**
 * The PRE-FLIGHT cost, computed before the work runs.
 *
 * This is what the admission check reserves, so it must be computable from what
 * a submission actually knows: the slug and the byte count. It cannot know the
 * page count — reading it would mean parsing the PDF at the API edge, which is
 * the work we are trying to authorize. When pages are unknown the per-page term
 * drops out, which makes the estimate a floor rather than a guess.
 */
export function estimateCostUnits(input: CostInput): number {
  const profile = costProfileFor(input.slug);
  if (!profile) return 0;
  const mb = Math.max(0, (input.inputBytes ?? 0)) / BYTES_PER_MB;
  const pages = input.pageCount && input.pageCount > 0 ? input.pageCount : 0;
  const raw = profile.base + profile.perMegabyte * mb + profile.perPage * pages;
  const isRealWork = profile !== LOCAL_TOOL_COST_PROFILE;
  return toUnits(raw, isRealWork);
}

export interface MeasuredCostInput extends CostInput {
  /** Wall-clock processing time, when the job actually ran. */
  durationMs?: number | null;
}

/**
 * The POST-HOC cost, computed from what really happened.
 *
 * Same formula, now with the page count the processor reported. `durationMs` is
 * accepted but does NOT enter the arithmetic, and that is a decision rather than
 * an oversight: billing by wall-clock would charge users for our slow days — a
 * cold LibreOffice start, a noisy neighbour, a retry after a deploy. It is
 * recorded alongside the cost so the constants above can be calibrated against
 * observed duration later, which is the honest use of it.
 */
export function measureCostUnits(input: MeasuredCostInput): number {
  return estimateCostUnits({
    slug: input.slug,
    inputBytes: input.inputBytes,
    pageCount: input.pageCount ?? null,
  });
}

/** Whether a tool's cost counts against a *server* allowance at all. */
export function isServerCosted(slug: string, mode: ToolExecutionMode): boolean {
  return mode === "remote_job" && REMOTE_JOB_TOOL_SLUGS.has(slug);
}

/**
 * Self-check: every remote tool has a profile, and no profile names a slug that
 * is not a remote tool.
 *
 * Exported rather than living in the test file so the invariant is stated next
 * to the table it constrains — the pattern `executionPolicyDisagreements()`
 * established.
 */
export function costProfileGaps(): string[] {
  const problems: string[] = [];
  for (const slug of REMOTE_JOB_TOOL_SLUGS) {
    const profile = TOOL_COST_PROFILES[slug];
    if (!profile) {
      problems.push(`${slug}: remote job tool with no cost profile`);
      continue;
    }
    if (profile.base <= 0) {
      problems.push(`${slug}: base cost must be positive — every server job costs something`);
    }
    if (profile.perMegabyte < 0 || profile.perPage < 0) {
      problems.push(`${slug}: negative cost coefficient`);
    }
  }
  for (const slug of Object.keys(TOOL_COST_PROFILES)) {
    if (!REMOTE_JOB_TOOL_SLUGS.has(slug)) {
      problems.push(`${slug}: cost profile for a slug that is not a remote job tool`);
    }
  }
  return problems;
}
