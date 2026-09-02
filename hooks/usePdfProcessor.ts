"use client";

import { useCallback, useEffect, useState } from "react";
import {
  localErrorCategoryOf,
  type ProcessedResult,
} from "@/lib/pdf/types";
import { useToolFunnel } from "@/components/tools/ToolAnalyticsProvider";
import { outputFileName, splitFileName } from "@/lib/workflow/fileNames";
import { newSaveIntentKey } from "@/lib/workflow/saveIntent";
import type { LocalToolErrorCategory } from "@/src/domain/jobs/jobErrors";

export type ProcessStatus = "idle" | "processing" | "done" | "error";

/**
 * What a failed local run reports.
 *
 * One object rather than two sibling fields, because the two halves must never
 * disagree: a `message` set with a null `errorCategory` is an uncategorized
 * failure in the dashboard, and two independent `useState`s is exactly how that
 * happens after someone adds a code path.
 */
export interface LocalToolFailure {
  /** For the person. Free text, interpolates their filename, may change with copy. */
  message: string;
  /** For measurement. Closed union, carries nothing from the document. */
  errorCategory: LocalToolErrorCategory;
}

export interface UsePdfProcessorOptions {
  /**
   * How many files the user has chosen right now.
   *
   * Required, and the reason it is required: it is the only thing this hook cannot
   * observe for itself, and without it there is no `file_selected` step. Making it
   * a mandatory argument turns "a new local tool reports its funnel" into a
   * compile error rather than a code-review habit — every runner already has
   * `upload.files.length` at hand.
   */
  fileCount: number;
}

/**
 * "Invoice 2024.pdf" + generic "edited.pdf" → "Invoice 2024-edited.pdf".
 *
 * The composition itself lives in {@link outputFileName} — the ONE place in the
 * product allowed to build a generated name. This function's whole job is to
 * translate a processor's generic name (`merged.pdf`) into that policy's terms:
 * its base is the tool's suffix, its extension is the output format.
 */
function personalizeFileName(generic: string, sources: readonly File[]): string {
  const { base: suffix, ext } = splitFileName(generic);
  return outputFileName({ sources: sources.map((f) => f.name), suffix, ext });
}

/**
 * Runs one local PDF task and reports the funnel for it.
 *
 * ── Why the analytics live here and not in the runners ──────────────────────
 *
 * Every local tool in the product routes its work through this hook, so this is
 * the narrowest seam that covers all eighteen local slugs. The alternative — the
 * shape the first instrumented tool used — is roughly fifty lines of dedupe keys,
 * refs and status effects copied into each runner, where a new tool is
 * instrumented only if whoever added it remembered to, and every copy is a place
 * for the keys to drift.
 *
 * ── Why the outcome is emitted from `run`, not from an effect on `status` ────
 *
 * `run` is where the outcome is *known*. An effect watching `status` has to
 * re-derive it, needs its own dedupe key to survive Strict Mode, and re-fires on
 * any dependency change — and it cannot see the thrown error, which is where the
 * category comes from. Here the success emit sits after the `try` and the catch
 * `return`s, so "a failed run never reports a success" is structural rather than
 * asserted.
 *
 * Nothing here is awaited. `noteRun*` returns void and swallows its own errors
 * (see `ToolAnalyticsProvider`), so a blocked ingest cannot delay a merge and a
 * throwing tracker cannot turn a working run into a failed one.
 */
export function usePdfProcessor({ fileCount }: UsePdfProcessorOptions) {
  const [status, setStatus] = useState<ProcessStatus>("idle");
  const [result, setResult] = useState<ProcessedResult | null>(null);
  const [error, setError] = useState<LocalToolFailure | null>(null);
  const funnel = useToolFunnel();

  // Keyed on the count, so 2 files then 3 files is two signals — a user adding
  // more files is real funnel progress — while a re-render at the same count is
  // not. `funnel` is a stable object, so this cannot loop.
  useEffect(() => {
    funnel.noteFileSelection(fileCount);
  }, [fileCount, funnel]);

  const run = useCallback(
    async (task: () => Promise<ProcessedResult>, source?: File | readonly File[]) => {
      // A multi-input tool passes all of them: the naming policy is what decides
      // that ten merged files become `first-and-9-more-merged.pdf` rather than a
      // name built from whichever file happened to be first.
      const sources = source === undefined ? [] : Array.isArray(source) ? source : [source as File];
      funnel.noteRunStart();
      setStatus("processing");
      setError(null);
      setResult(null);
      try {
        const res = await task();
        // One intention per successful run, minted HERE — the one seam every local
        // tool passes through, so a new tool gets save identity without its author
        // having to know that save identity exists. Not in the processors (eleven
        // places to forget), and not at the Save button (a second press, or a
        // remount that re-renders the same result, would each be a new intention
        // and each cost a duplicate document).
        setResult({
          ...res,
          fileName: sources.length > 0 ? personalizeFileName(res.fileName, sources) : res.fileName,
          saveIntentKey: newSaveIntentKey(),
        });
        setStatus("done");
      } catch (err) {
        // The message is chosen for the user; the category is read off the error
        // as data. Nothing here inspects the message to decide the category —
        // that would be pattern-matching on copy, and one concatenation away from
        // putting a filename in the ledger.
        setError({
          message: localFailureMessage(err),
          errorCategory: localErrorCategoryOf(err),
        });
        setStatus("error");
        funnel.noteRunFailed(localErrorCategoryOf(err));
        return;
      }
      funnel.noteRunSucceeded();
    },
    [funnel],
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setResult(null);
    setError(null);
  }, []);

  return { status, result, error, run, reset };
}

/**
 * The sentence shown for a thrown value.
 *
 * A non-`PdfProcessingError` gets the generic line: its message is a developer
 * artefact (a TypeError, a pdf-lib internal) and showing it to a user is both
 * useless to them and a leak of internals.
 */
function localFailureMessage(err: unknown): string {
  return err instanceof Error && err.name === "PdfProcessingError"
    ? err.message
    : "Something went wrong while processing your file. Please try again.";
}
