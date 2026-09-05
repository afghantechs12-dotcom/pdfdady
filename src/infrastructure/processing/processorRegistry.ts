import { ToolProcessorRegistry } from "./ToolProcessorRegistry";
import { LegacyToolProcessor } from "./LegacyToolProcessor";
import type { IToolProcessorRegistry } from "@/src/application/ports/processing/ToolProcessor";

/**
 * Execution ceiling for the pilot processor.
 *
 * Ghostscript on a 100MB scanned PDF is genuinely slow, so the ceiling has to be
 * generous enough not to kill legitimate work; three minutes matches the
 * LibreOffice ceiling already used elsewhere in the codebase. Overridable so an
 * operator can tighten it without a deploy.
 *
 * The guard is the same shape as `lib/server/concurrency.ts`, and it is here for
 * the same reason those neighbours have it: this number is handed straight to
 * `setTimeout` in `ProcessingJobHandler`, which coerces NaN, "" and any negative
 * value to ~1ms — so `PROCESSING_COMPRESS_TIMEOUT_MS=` or a typo would not fall
 * back to three minutes, it would abort every pipeline compress job on the first
 * tick and report it as a timeout. Found while writing the production environment
 * contract: this was the one numeric reader in the processing layer that took the
 * value unchecked while `processingWorker.ts` and `StuckJobRecoveryService.ts`
 * both guarded theirs.
 */
const parsedCompressTimeout = Number(process.env.PROCESSING_COMPRESS_TIMEOUT_MS);
export const COMPRESS_PDF_TIMEOUT_MS =
  Number.isFinite(parsedCompressTimeout) && parsedCompressTimeout > 0
    ? parsedCompressTimeout
    : 180_000;

/**
 * The processors registered for the unified pipeline.
 *
 * Exactly one, deliberately. This phase migrates a single pilot tool; the other
 * thirteen server tools keep running on the existing path until the pilot has
 * proven itself in production. Adding them here is the whole of the work to
 * migrate them later — which is the point of the registry.
 */
export function buildProcessorRegistry(): IToolProcessorRegistry {
  return new ToolProcessorRegistry([
    new LegacyToolProcessor("compress-pdf", COMPRESS_PDF_TIMEOUT_MS),
  ]);
}
