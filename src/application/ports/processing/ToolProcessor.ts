import type { JobProgressStage } from "@/src/domain/jobs/progressStage";

/**
 * What a processor is given.
 *
 * Only paths and already-validated option values — no request, no job record, no
 * database handle. A processor cannot read another job's data, cannot change a
 * job's status, and cannot see who submitted the work, because none of that is
 * reachable from here. Its whole job is bytes in, bytes out.
 */
export interface ProcessingContext {
  /** Absolute path of the materialized input inside this job's temp directory. */
  inputPath: string;
  /** Additional inputs for multi-file tools, in submission order. */
  additionalInputPaths: string[];
  /** The job's private temp directory. The only place a processor may write. */
  workDir: string;
  /**
   * Extension-less base name for the output, already sanitized. Safe to
   * concatenate into a filename; never a path.
   */
  baseName: string;
  /** Validated tool options, keyed by the tool's declared option names. */
  options: Record<string, string>;
  /** Aborted on cancellation and on the execution ceiling. */
  signal: AbortSignal;
  /** Reports a named stage. There is no percentage parameter, by design. */
  reportStage(stage: JobProgressStage): void;
}

/** What a processor produces: one file on disk, plus how to serve it. */
export interface ProcessingOutcome {
  /** Absolute path inside `workDir`. */
  outputPath: string;
  /** Filename offered to the user. Never used as a path. */
  downloadName: string;
  mimeType: string;
  /** Set only when the processor genuinely determined it. */
  pageCount?: number;
}

/**
 * A unit of heavy work, addressed by tool slug.
 *
 * The registry exists so the worker never grows an if/else chain over slugs. A
 * chain is not merely ugly: it puts the dispatch decision inside the component
 * that also owns temp directories, timeouts, cancellation and status writes, so
 * adding a tool means editing the code that enforces the safety properties.
 * With a registry, a new tool is a new object and the worker is untouched.
 */
export interface ToolProcessor {
  /** Tool slug this processor serves, e.g. `compress-pdf`. */
  readonly id: string;
  /**
   * Hard execution ceiling in milliseconds.
   *
   * Per-processor rather than global because the ceilings differ by an order of
   * magnitude — a qpdf page operation and an OCR pass over 200 pages are not the
   * same kind of wait — and a single global value would have to be set to the
   * slowest, which would let a hung fast tool occupy a slot for minutes.
   */
  readonly timeoutMs: number;
  process(context: ProcessingContext): Promise<ProcessingOutcome>;
}

/** Thrown when no processor is registered for a slug. */
export class ProcessorNotFoundError extends Error {
  constructor(public readonly slug: string) {
    super(`No processor registered for "${slug}".`);
    this.name = "ProcessorNotFoundError";
  }
}

export interface IToolProcessorRegistry {
  get(slug: string): ToolProcessor | undefined;
  require(slug: string): ToolProcessor;
  has(slug: string): boolean;
  ids(): string[];
}
