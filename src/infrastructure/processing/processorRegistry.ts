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
 */
export const COMPRESS_PDF_TIMEOUT_MS = Number(
  process.env.PROCESSING_COMPRESS_TIMEOUT_MS ?? 180_000,
);

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
