import { MissingDependencyError } from "@/lib/server/dependencyCheck";
import { ProcessingError } from "@/lib/server/toolProcessing";
import { CommandError, CommandAbortedError } from "@/lib/server/runCommand";
import { UploadValidationError } from "@/lib/server/validateUpload";
import type { JobErrorCategory } from "@/src/domain/jobs/jobErrors";

/**
 * Turns whatever a processor threw into a stable category.
 *
 * This is the only place a raw exception is inspected, and the reason it exists
 * separately from the handler is that the handler must never make this decision
 * ad hoc: the retry policy reads the category to decide whether another attempt
 * is worth making, so misclassifying "corrupt file" as "processor failed" would
 * silently start burning three Ghostscript runs on every damaged upload.
 *
 * The pattern matches are on *our own* error messages, not on vendor stderr,
 * with one deliberate exception: the qpdf/Ghostscript password and damage
 * signatures below are stable, load-bearing strings that distinguish an
 * actionable user problem ("this PDF is encrypted") from an opaque failure. They
 * are matched here, in one place, and never forwarded — the user gets the fixed
 * sentence for the category, never the stderr that produced it.
 */

/** Substrings in tool stderr that reliably mean "needs a password". */
const PASSWORD_SIGNATURES = [
  "invalid password",
  "password is not correct",
  "encrypted with a password",
  "this file is encrypted",
  "/encrypt",
];

/** Substrings that reliably mean the document itself is unreadable. */
const CORRUPT_SIGNATURES = [
  "damaged",
  "not a pdf file",
  "unable to find trailer",
  "xref not found",
  "syntax error",
  "cannot find startxref",
  "unexpected eof",
];

function haystack(err: unknown): string {
  if (err instanceof CommandError) {
    return `${err.message}\n${err.stderr ?? ""}`.toLowerCase();
  }
  return (err instanceof Error ? err.message : String(err)).toLowerCase();
}

export interface FailureClassification {
  category: JobErrorCategory;
  /** Internal-only diagnostic text. Stored in `Job.error`, never serialized out. */
  diagnostic: string;
}

/**
 * Classifies a thrown value.
 *
 * Order matters: cancellation is checked before anything else because an aborted
 * subprocess exits non-zero and would otherwise look like a processing failure,
 * and a cancelled job must never be reported to the user as an error with a
 * Retry button implying something went wrong.
 */
export function classifyFailure(
  err: unknown,
  ctx: { cancelled?: boolean; timedOut?: boolean } = {},
): FailureClassification {
  const diagnostic = err instanceof Error ? `${err.name}: ${err.message}` : String(err);

  if (ctx.cancelled || err instanceof CommandAbortedError) {
    return { category: "cancelled", diagnostic };
  }
  if (ctx.timedOut) {
    return { category: "processor_timeout", diagnostic };
  }
  if (err instanceof MissingDependencyError) {
    return { category: "dependency_unavailable", diagnostic };
  }
  if (err instanceof UploadValidationError) {
    return { category: "invalid_input", diagnostic };
  }

  const text = haystack(err);

  if (PASSWORD_SIGNATURES.some((s) => text.includes(s))) {
    return { category: "password_required", diagnostic };
  }
  if (CORRUPT_SIGNATURES.some((s) => text.includes(s))) {
    return { category: "corrupt_document", diagnostic };
  }

  // A CommandError's `timedOut`-shaped message: runCommand surfaces the timeout
  // through the message rather than a distinct class, so this is the fallback
  // for a ceiling hit inside a processor that manages its own timeout.
  if (text.includes("timed out") || text.includes("etimedout")) {
    return { category: "processor_timeout", diagnostic };
  }

  if (err instanceof ProcessingError) {
    return { category: "processor_failed", diagnostic };
  }
  if (err instanceof CommandError) {
    return { category: "processor_failed", diagnostic };
  }

  // Nothing recognizable. `internal_error` is retryable, which is the right
  // default for a failure we do not understand — but the bounded attempt budget
  // stops that from becoming a loop.
  return { category: "internal_error", diagnostic };
}
