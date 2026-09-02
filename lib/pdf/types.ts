import {
  UNEXPECTED_LOCAL_ERROR_CATEGORY,
  type LocalToolErrorCategory,
} from "@/src/domain/jobs/jobErrors";

export interface ProcessedResult {
  blob: Blob;
  fileName: string;
  mimeType: string;
}

export type ToolProcessor = (
  files: File[],
  options?: Record<string, unknown>,
) => Promise<ProcessedResult>;

export type PageOp =
  | { type: "rotate"; pageIndex: number; degrees: 90 | 180 | 270 }
  | { type: "delete"; pageIndex: number };

/**
 * Thrown by processors with a user-friendly message and a stable category.
 *
 * The two fields answer two different audiences and must never be conflated:
 *
 *  - `message` is for the person. It is free text, it interpolates their
 *    filename, and it changes whenever the copy improves.
 *  - `category` is for measurement. It is a closed union, it carries nothing
 *    from the document, and it is the only half that may reach analytics.
 *
 * That split is the whole point of carrying the category here rather than
 * deriving it downstream. A classifier that reads `message` would be pattern-
 * matching on copy — so improving a sentence would silently re-bucket a failure
 * class, and the substring it matched would be one string-concatenation away
 * from putting `"Q3-layoffs.pdf" is encrypted` into the ledger. The category is
 * decided where the failure is known and travels as data.
 */
export class PdfProcessingError extends Error {
  readonly category: LocalToolErrorCategory;
  /**
   * `category` is REQUIRED, with no default.
   *
   * A default would make "someone added a throw site and never classified it"
   * indistinguishable from "this really is a generic processing failure" — and
   * the whole point of the taxonomy is that a bucket means something. Required
   * makes coverage a type error at the moment the throw is written, which is
   * cheaper than any test that scans this directory for untagged constructors.
   */
  constructor(message: string, category: LocalToolErrorCategory) {
    super(message);
    this.name = "PdfProcessingError";
    this.category = category;
  }
}

/**
 * The analytics category for anything a local processor threw.
 *
 * A non-`PdfProcessingError` is a bug — a TypeError from a bad index, an
 * unhandled rejection out of pdf-lib — and `internal_error` says exactly that.
 * Nothing about the thrown value itself is read: not its message, not its name,
 * not its stack. This function takes `unknown` and returns one of six constants,
 * so there is no path through it by which document content or a filename could
 * become an analytics property.
 */
export function localErrorCategoryOf(err: unknown): LocalToolErrorCategory {
  return err instanceof PdfProcessingError ? err.category : UNEXPECTED_LOCAL_ERROR_CATEGORY;
}
