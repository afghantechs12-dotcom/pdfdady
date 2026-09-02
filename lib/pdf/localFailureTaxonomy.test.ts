import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PdfProcessingError, localErrorCategoryOf } from "./types";
import { loadPdfDocument } from "./loadDocument";
import {
  ALL_LOCAL_TOOL_ERROR_CATEGORIES,
  UNEXPECTED_LOCAL_ERROR_CATEGORY,
  isLocalToolErrorCategory,
} from "@/src/domain/jobs/jobErrors";

/**
 * The local failure taxonomy: that it is closed, that it is reachable, and that
 * the category never carries anything from the document.
 *
 * The category half of a failure is the half that reaches analytics, so these
 * tests are about *separation* more than about classification. A test that only
 * checked "encrypted file → password_required" would pass just as well if the
 * message had been used as the category, which is the actual failure mode the
 * taxonomy exists to prevent.
 */

const PDF_DIR = join(process.cwd(), "lib/pdf");

function fileOf(bytes: Uint8Array, name: string): File {
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

async function encryptedPdfBytes(): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  // The minimum that makes a document *structurally* encrypted: an /Encrypt
  // entry in the trailer. No real cipher is needed — pdf-lib refuses to touch
  // the file on the presence of the entry, which is exactly the condition users
  // hit with a real password-protected PDF.
  doc.context.trailerInfo.Encrypt = doc.context.register(
    doc.context.obj({ Filter: "Standard", V: 1, R: 2, O: "x", U: "y", P: -1 }),
  );
  return doc.save({ useObjectStreams: false });
}

async function plainPdfBytes(): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  return doc.save();
}

describe("PdfProcessingError", () => {
  it("carries the category as data, not as anything derived from the message", () => {
    const err = new PdfProcessingError('"Q3-layoffs.pdf" is encrypted', "password_required");
    expect(err.category).toBe("password_required");
    expect(isLocalToolErrorCategory(err.category)).toBe(true);
  });

  it("keeps the category free of document content even when the message is not", () => {
    const err = new PdfProcessingError(
      'We couldn\'t read "salary-review-final.pdf". It may be corrupted.',
      "corrupt_document",
    );
    // The whole point: the analytics-bound half is one of six constants, so
    // there is no concatenation by which a filename could ride along.
    expect(ALL_LOCAL_TOOL_ERROR_CATEGORIES as readonly string[]).toContain(
      localErrorCategoryOf(err),
    );
    expect(localErrorCategoryOf(err)).not.toContain("salary-review-final");
  });
});

describe("localErrorCategoryOf", () => {
  it("classifies a non-PdfProcessingError throw as an internal error", () => {
    // A TypeError from a bad page index is a bug, and the taxonomy says so
    // rather than laundering it into a processing failure.
    expect(localErrorCategoryOf(new TypeError("x is not a function"))).toBe(
      UNEXPECTED_LOCAL_ERROR_CATEGORY,
    );
    expect(localErrorCategoryOf("a thrown string")).toBe(UNEXPECTED_LOCAL_ERROR_CATEGORY);
    expect(localErrorCategoryOf(undefined)).toBe(UNEXPECTED_LOCAL_ERROR_CATEGORY);
  });

  it("reads nothing off the thrown value but its category", () => {
    // An impostor with the right name and a tempting `category`-shaped payload
    // must NOT be trusted: the guard is instanceof, so a message that happens to
    // look like a classification cannot become one.
    const impostor = Object.assign(new Error("password"), {
      name: "PdfProcessingError",
      category: "password_required",
    });
    expect(localErrorCategoryOf(impostor)).toBe(UNEXPECTED_LOCAL_ERROR_CATEGORY);
  });

  it("returns a member of the closed union for every input shape", () => {
    for (const thrown of [new Error("boom"), {}, null, 42, new PdfProcessingError("m", "invalid_input")]) {
      expect(isLocalToolErrorCategory(localErrorCategoryOf(thrown))).toBe(true);
    }
  });
});

describe("loadPdfDocument", () => {
  it("classifies a password-protected PDF as password_required", async () => {
    // Regression: this was permanently unreachable. pdf-lib's CJS build makes
    // `err instanceof EncryptedPDFError` false for every encrypted document
    // (tslib downlevel returns a plain Error), so every password-protected file
    // was reported to the user as "may be corrupted" and bucketed as
    // corrupt_document — a category that then reads as a rash of damaged files.
    const file = fileOf(await encryptedPdfBytes(), "protected.pdf");
    await expect(loadPdfDocument(file)).rejects.toMatchObject({
      category: "password_required",
    });
  });

  it("points the user at the unlock tool without leaking the failure internals", async () => {
    const file = fileOf(await encryptedPdfBytes(), "protected.pdf");
    const err = await loadPdfDocument(file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfProcessingError);
    const message = (err as Error).message;
    expect(message).toContain("Unlock PDF");
    // No stack, no library internals, no thrown-error text.
    expect(message).not.toMatch(/EncryptedPDFError|pdf-lib|at Object\.|node_modules/);
  });

  it("classifies unparseable bytes as corrupt_document", async () => {
    const file = fileOf(new TextEncoder().encode("not a pdf at all"), "notes.txt");
    await expect(loadPdfDocument(file)).rejects.toMatchObject({
      category: "corrupt_document",
    });
  });

  it("classifies an unreadable File handle as corrupt_document, not a bug", async () => {
    // A revoked blob or removed device: nothing was parsed, so this is a read
    // failure and must not be reported as an internal error.
    const unreadable = {
      name: "gone.pdf",
      arrayBuffer: () => Promise.reject(new Error("NotReadableError")),
    } as unknown as File;
    await expect(loadPdfDocument(unreadable)).rejects.toMatchObject({
      category: "corrupt_document",
    });
  });

  it("loads a normal PDF without classifying anything", async () => {
    const doc = await loadPdfDocument(fileOf(await plainPdfBytes(), "fine.pdf"));
    expect(doc.getPageCount()).toBe(1);
  });
});

describe("throw-site coverage", () => {
  /**
   * Every `new PdfProcessingError(` in this directory must pass a category from
   * the closed union.
   *
   * The constructor's required parameter already makes an untagged throw a type
   * error, so this test is not the primary guard — it is the guard against the
   * *next* shortcut: a variable, a ternary, or a value coerced from an error
   * message. What travels to analytics has to be a literal decided at the throw
   * site, and this is where that is enforceable.
   */
  it("passes a literal category from the closed union at every throw site", () => {
    const union = ALL_LOCAL_TOOL_ERROR_CATEGORIES.map((c) => `"${c}"`);
    const offenders: string[] = [];
    for (const entry of readdirSync(PDF_DIR)) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      const source = readFileSync(join(PDF_DIR, entry), "utf8");
      for (const match of source.matchAll(/new PdfProcessingError\(/g)) {
        // A window rather than an argument parse: messages are multi-line
        // template literals containing parens and quotes, and every regex that
        // tries to find "the last argument" trips over one of them. What matters
        // is only that a union LITERAL is present in the call — a variable or a
        // value read off an error message would not be.
        const call = source.slice(match.index, match.index + 500);
        if (!union.some((literal) => call.includes(literal))) {
          offenders.push(`${entry}: ${call.slice(0, 80).replace(/\n\s*/g, " ")}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("finds throw sites at all, so the scan above cannot pass vacuously", () => {
    const total = readdirSync(PDF_DIR)
      .filter((e) => e.endsWith(".ts") && !e.endsWith(".test.ts"))
      .reduce(
        (sum, e) =>
          sum +
          [...readFileSync(join(PDF_DIR, e), "utf8").matchAll(/new PdfProcessingError\(/g)].length,
        0,
      );
    expect(total).toBeGreaterThan(15);
  });
});
