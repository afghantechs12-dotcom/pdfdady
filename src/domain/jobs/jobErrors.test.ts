import { describe, expect, it } from "vitest";
import {
  ALL_JOB_ERROR_CATEGORIES,
  isJobErrorCategory,
  isRetryableCategory,
  safeMessageFor,
  toJobErrorCategory,
} from "./jobErrors";

/**
 * These tests are the enforcement of the brief's error-safety rule. The rule is
 * not "remember to sanitize" — it is that the only failure text a user can ever
 * receive is one of ten fixed sentences chosen from a closed set, with no
 * parameter through which anything else could arrive.
 */
describe("job error categories", () => {
  it("is exactly the ten categories the contract names", () => {
    expect([...ALL_JOB_ERROR_CATEGORIES].sort()).toEqual([
      "cancelled",
      "corrupt_document",
      "dependency_unavailable",
      "file_too_large",
      "internal_error",
      "invalid_input",
      "password_required",
      "processor_failed",
      "processor_timeout",
      "unsupported_format",
    ]);
  });

  it("has no duplicates", () => {
    expect(new Set(ALL_JOB_ERROR_CATEGORIES).size).toBe(
      ALL_JOB_ERROR_CATEGORIES.length,
    );
  });
});

describe("safe messages", () => {
  it("gives every category a non-empty sentence", () => {
    for (const c of ALL_JOB_ERROR_CATEGORIES) {
      const msg = safeMessageFor(c);
      expect(msg.length).toBeGreaterThan(0);
      expect(msg.trim()).toBe(msg);
    }
  });

  it("never leaks internal detail through any category's message", () => {
    // The forbidden shapes are the ones a processor's own error text is full of:
    // absolute paths, temp dirs, binary names, flags, stack frames, hosts, ports.
    const forbidden = [
      /\//, // any path separator
      /\\/,
      /\/tmp/i,
      /\bgs\b/,
      /ghostscript/i,
      /qpdf|soffice|libreoffice|tesseract|pdftoppm/i,
      /--?[a-z]{2,}=/i, // command-line flags with values
      /\bat\s+\w+\s+\(/, // stack frame
      /localhost|127\.0\.0\.1|:\d{4,5}\b/,
      /[A-Za-z]:\\/, // windows path
      /\$\{|process\.env/,
    ];
    for (const c of ALL_JOB_ERROR_CATEGORIES) {
      const msg = safeMessageFor(c);
      for (const pattern of forbidden) {
        expect(
          pattern.test(msg),
          `category "${c}" message matched ${pattern}: ${msg}`,
        ).toBe(false);
      }
    }
  });

  it("takes no arguments, so no caller can smuggle text into it", () => {
    // This is the structural half of the guarantee. A `safeMessageFor(category,
    // detail)` signature would eventually be called with a stderr string by
    // someone trying to be helpful; there is no such parameter to misuse.
    expect(safeMessageFor.length).toBe(1);
  });

  it("returns a stable sentence for a category across calls", () => {
    for (const c of ALL_JOB_ERROR_CATEGORIES) {
      expect(safeMessageFor(c)).toBe(safeMessageFor(c));
    }
  });
});

describe("retryability", () => {
  it("marks only the four transient classes retryable", () => {
    const retryable = ALL_JOB_ERROR_CATEGORIES.filter(isRetryableCategory);
    expect([...retryable].sort()).toEqual([
      "dependency_unavailable",
      "internal_error",
      "processor_failed",
      "processor_timeout",
    ]);
  });

  it("treats every deterministic input problem as permanent", () => {
    // A corrupt document stays corrupt; a missing password stays missing. Three
    // more attempts reach the same answer and waste the user's time.
    for (const c of [
      "invalid_input",
      "unsupported_format",
      "password_required",
      "corrupt_document",
      "file_too_large",
    ] as const) {
      expect(isRetryableCategory(c)).toBe(false);
    }
  });

  it("treats cancellation as non-retryable", () => {
    // Automatically retrying something the user asked to stop would be the
    // opposite of what they asked for. (Their explicit Retry press is a separate,
    // deliberate command.)
    expect(isRetryableCategory("cancelled")).toBe(false);
  });
});

describe("category coercion", () => {
  it("recognises the members of the set and nothing else", () => {
    for (const c of ALL_JOB_ERROR_CATEGORIES) expect(isJobErrorCategory(c)).toBe(true);
    for (const bad of [
      "INVALID_INPUT",
      "invalid input",
      "",
      "boom",
      null,
      undefined,
      42,
      {},
      [],
    ]) {
      expect(isJobErrorCategory(bad)).toBe(false);
    }
  });

  it("coerces unknown persisted values to internal_error", () => {
    // Rows written by an older version, or a hand-edited value, must not crash a
    // read and must not be echoed to a user as a category.
    for (const bad of ["", "weird", null, undefined, 7]) {
      expect(toJobErrorCategory(bad)).toBe("internal_error");
    }
  });

  it("round-trips a valid value unchanged", () => {
    for (const c of ALL_JOB_ERROR_CATEGORIES) {
      expect(toJobErrorCategory(c)).toBe(c);
    }
  });
});
