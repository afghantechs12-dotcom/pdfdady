import type {
  ProcessingContext,
  ProcessingOutcome,
  ToolProcessor,
} from "@/src/application/ports/processing/ToolProcessor";
import { getProcessor } from "@/lib/server/toolProcessing";

/**
 * Adapts one of the existing `lib/server/toolProcessing.ts` processors to the
 * `ToolProcessor` port.
 *
 * Wrapping rather than rewriting is deliberate. Those functions carry a lot of
 * hard-won detail — the LibreOffice profile isolation, the qpdf-then-Ghostscript
 * repair fallback, the OCR language allowlist, the page cap — and reimplementing
 * them to fit a new interface would put working, security-relevant code at risk
 * for no user-visible gain. The adapter's only jobs are to translate the context
 * shape and to report the one stage boundary the legacy signature has no way to
 * express.
 */
export class LegacyToolProcessor implements ToolProcessor {
  constructor(
    readonly id: string,
    readonly timeoutMs: number,
  ) {
    // Fail at construction, not at first use: a registry wired to a slug with no
    // implementation should break the worker's startup, where it is obvious,
    // rather than a single user's job at 2am.
    if (!getProcessor(id)) {
      throw new Error(`No legacy processor exists for "${id}".`);
    }
  }

  async process(context: ProcessingContext): Promise<ProcessingOutcome> {
    const run = getProcessor(this.id);
    if (!run) throw new Error(`No legacy processor exists for "${this.id}".`);

    context.reportStage("processing");

    const output = await run({
      inputPath: context.inputPath,
      jobDir: context.workDir,
      baseName: context.baseName,
      options: context.options,
      signal: context.signal,
    });

    context.reportStage("finalizing");

    return {
      outputPath: output.outputPath,
      downloadName: output.downloadName,
      mimeType: output.mimeType,
    };
  }
}
