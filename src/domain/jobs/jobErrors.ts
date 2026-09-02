/**
 * The stable, user-safe error vocabulary for processing jobs.
 *
 * Two separate concerns are deliberately kept apart here:
 *
 *   1. What the user is told — `JobErrorCategory` plus its fixed message. These
 *      strings are the ONLY thing that may reach a browser. A category never
 *      interpolates a filename, a path, a command line, a binary name or an
 *      exception message, because every one of those has leaked internals in
 *      some product at some point. `safeMessageFor` takes no arguments for
 *      exactly that reason: there is no parameter through which a caller could
 *      accidentally smuggle stderr into the response.
 *
 *   2. Whether retrying could plausibly help — `isRetryableCategory`. This is a
 *      property of the failure, not of the caller's mood: a corrupt document
 *      will be just as corrupt on attempt three, so retrying it burns CPU and
 *      lies to the user about the nature of the problem.
 *
 * The categories are a closed union so that the UI, the retry policy and the
 * usage events all reason over the same set, and adding one is a type error
 * everywhere it must be handled.
 */
export type JobErrorCategory =
  | "invalid_input"
  | "unsupported_format"
  | "password_required"
  | "corrupt_document"
  | "file_too_large"
  | "processor_timeout"
  | "processor_failed"
  | "dependency_unavailable"
  | "cancelled"
  | "internal_error";

export const ALL_JOB_ERROR_CATEGORIES: readonly JobErrorCategory[] = [
  "invalid_input",
  "unsupported_format",
  "password_required",
  "corrupt_document",
  "file_too_large",
  "processor_timeout",
  "processor_failed",
  "dependency_unavailable",
  "cancelled",
  "internal_error",
];

/**
 * The exact sentence shown to a user for each category.
 *
 * Each one names what the user can do next where such a thing exists, and
 * stays silent where it does not — `internal_error` does not invent advice,
 * because "try again later" is the honest extent of what we know.
 */
const SAFE_MESSAGES: Record<JobErrorCategory, string> = {
  invalid_input: "That file could not be used for this tool. Check the file and try again.",
  unsupported_format: "This tool does not support that file type.",
  password_required: "This PDF is password-protected. Remove the password first, then try again.",
  corrupt_document: "This PDF appears to be damaged, so it could not be read.",
  file_too_large: "That file is larger than this tool allows.",
  processor_timeout: "This file took too long to process and was stopped. A smaller file usually works.",
  processor_failed: "Processing this file did not succeed.",
  dependency_unavailable: "This tool is temporarily unavailable. Please try again shortly.",
  cancelled: "You cancelled this job.",
  internal_error: "Something went wrong on our side. Please try again.",
};

/**
 * Categories where another attempt has a real chance of a different outcome:
 * a killed subprocess, a missing/booting binary, an unexplained crash. Notably
 * absent are every category describing the *input* — those are deterministic.
 */
const RETRYABLE: ReadonlySet<JobErrorCategory> = new Set<JobErrorCategory>([
  "processor_timeout",
  "processor_failed",
  "dependency_unavailable",
  "internal_error",
]);

/** Whether a further attempt is worth making for this category. */
export function isRetryableCategory(category: JobErrorCategory): boolean {
  return RETRYABLE.has(category);
}

/** The user-facing sentence for a category. Never includes dynamic detail. */
export function safeMessageFor(category: JobErrorCategory): string {
  return SAFE_MESSAGES[category] ?? SAFE_MESSAGES.internal_error;
}

/** Narrowing guard for values arriving from the database or an HTTP body. */
export function isJobErrorCategory(value: unknown): value is JobErrorCategory {
  return (
    typeof value === "string" &&
    (ALL_JOB_ERROR_CATEGORIES as readonly string[]).includes(value)
  );
}

/** Coerces an unknown persisted value into a category, defaulting safely. */
export function toJobErrorCategory(value: unknown): JobErrorCategory {
  return isJobErrorCategory(value) ? value : "internal_error";
}

// ---------------------------------------------------------------------------
// Local (browser) tool failures
// ---------------------------------------------------------------------------

/**
 * The failure classes a BROWSER-LOCAL tool can actually produce.
 *
 * ── Why this is a subset of JobErrorCategory, not its own vocabulary ────────
 *
 * Local and remote failures land in the SAME ledger column (`usage_events.
 * errorCategory`) and are read by the same admin grouping. Two vocabularies in
 * one column is how a dashboard starts lying: `processing_failed` from a browser
 * and `processor_failed` from a worker would appear as two unrelated causes with
 * half the volume each, and no query could ever add them up again. So local
 * failures are a *narrowing* of the server vocabulary — every member below is a
 * `JobErrorCategory`, pinned by the `satisfies` clause, so a rename on either
 * side is a type error rather than a silently split bucket.
 *
 * ── Why these six, and not the other four ──────────────────────────────────
 *
 * Derived from the throw sites in `lib/pdf/*`, not from the example list in a
 * brief. A category that nothing can emit is worse than a missing one: it shows
 * up in the failure table as a permanent zero, which reads as "we checked, it
 * never happens" rather than "nothing was ever wired to report it".
 *
 *  - `file_too_large` is excluded. Oversized files are rejected by
 *    `useFileUpload`'s validation *before* any processing starts, so no run
 *    begins and there is no `job_failed` to categorize. Add it here the day a
 *    local processor gains its own size ceiling.
 *  - `cancelled` is excluded. No local tool exposes a cancel affordance —
 *    `usePdfProcessor.run` has no abort path. Add it with the affordance.
 *  - `processor_timeout` / `dependency_unavailable` are server concepts: there
 *    is no subprocess to kill and no binary to be missing in a browser tab.
 */
export type LocalToolErrorCategory =
  | "invalid_input"
  | "unsupported_format"
  | "password_required"
  | "corrupt_document"
  | "processor_failed"
  | "internal_error";

export const ALL_LOCAL_TOOL_ERROR_CATEGORIES = [
  "invalid_input",
  "unsupported_format",
  "password_required",
  "corrupt_document",
  "processor_failed",
  "internal_error",
  // The `satisfies` is the load-bearing part: it makes "every local category is
  // also a server category" a compile-time fact rather than a comment.
] as const satisfies readonly JobErrorCategory[];

/**
 * The category for a local failure nobody classified.
 *
 * `processor_failed`, not `internal_error`: a `PdfProcessingError` that reached
 * the user carried a deliberate, user-facing sentence, so *something* decided to
 * fail — that is a processing failure, not an unhandled bug. `internal_error` is
 * reserved for a throw that was never a PdfProcessingError at all, which is the
 * only case where "we do not know what happened" is the truth.
 */
export const DEFAULT_LOCAL_ERROR_CATEGORY: LocalToolErrorCategory = "processor_failed";

/** The category for a throw that was not a PdfProcessingError: a real bug. */
export const UNEXPECTED_LOCAL_ERROR_CATEGORY: LocalToolErrorCategory = "internal_error";

export function isLocalToolErrorCategory(value: unknown): value is LocalToolErrorCategory {
  return (
    typeof value === "string" &&
    (ALL_LOCAL_TOOL_ERROR_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * Coerces an unknown value into a local category.
 *
 * Defaults to `processor_failed` rather than `internal_error` for the same reason
 * as `DEFAULT_LOCAL_ERROR_CATEGORY`: this is called on a value that came off a
 * `PdfProcessingError`, so a failure did happen and was described.
 */
export function toLocalToolErrorCategory(value: unknown): LocalToolErrorCategory {
  return isLocalToolErrorCategory(value) ? value : DEFAULT_LOCAL_ERROR_CATEGORY;
}
