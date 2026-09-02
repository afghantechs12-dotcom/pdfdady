import type { IAnalytics } from "@/src/application/ports/observability/Analytics";
import type { IMetrics } from "@/src/application/ports/observability/Metrics";
import type { ILogger } from "@/src/application/ports/Logger";
import type { JobErrorCategory } from "@/src/domain/jobs/jobErrors";
import type { ToolExecutionMode } from "@/lib/tools/executionPolicy";

/** The event name every processing outcome is reported under. */
export const PROCESSING_USAGE_EVENT = "tool_processing_completed";

export type ProcessingUsageResult = "success" | "failure" | "cancelled";

/**
 * One usage record for one attempt.
 *
 * Read this as a list of what is deliberately absent as much as what is present:
 * no filename, no page text, no form values, no signature data, no storage key,
 * no owner id, no stderr. Byte counts and a page count are dimensions of the
 * work, not contents of the document — you cannot reconstruct anything about a
 * user's file from "it was 4.2MB and had 12 pages" — whereas a filename very
 * often is the sensitive part ("Q3-layoffs.pdf", "scan-passport.pdf").
 *
 * `ownerType` is included but `ownerId` is not: knowing that traffic split
 * between signed-in and anonymous visitors is operationally necessary, knowing
 * *which* visitor is not.
 */
export interface ProcessingUsageEvent {
  toolSlug: string;
  executionMode: ToolExecutionMode;
  jobId: string;
  ownerType: string | null;
  result: ProcessingUsageResult;
  /** Which attempt produced this outcome; 1 for a first run. */
  attempt: number;
  inputBytes: number | null;
  outputBytes: number | null;
  /** Wall-clock processing duration in ms, when the job actually ran. */
  durationMs: number | null;
  /** Only for `failure` and `cancelled`. */
  errorCategory: JobErrorCategory | null;
  /** Only when the processor genuinely determined it. */
  pageCount: number | null;
}

/**
 * Coarse size buckets.
 *
 * Exact byte counts are recorded too (the brief asks for them, and capacity
 * planning needs them), but the bucket is what dashboards and funnels should
 * group by: an exact size is a weak fingerprint that can correlate one event to
 * another across a dataset, and a bucket cannot.
 */
export function sizeBucket(bytes: number | null): string {
  if (bytes === null || Number.isNaN(bytes)) return "unknown";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return "<1MB";
  if (mb < 5) return "1-5MB";
  if (mb < 25) return "5-25MB";
  if (mb < 100) return "25-100MB";
  return ">100MB";
}

/**
 * Emits usage telemetry for processing outcomes.
 *
 * Every emission path swallows its own errors: telemetry is never allowed to
 * fail a job the user's file already went through. A dropped metric costs a row
 * in a dashboard; a thrown metric would cost the user their result.
 */
export class ProcessingUsageRecorder {
  constructor(
    private readonly analytics: IAnalytics,
    private readonly metrics: IMetrics,
    private readonly logger: ILogger,
  ) {}

  record(event: ProcessingUsageEvent): void {
    const tags = {
      tool: event.toolSlug,
      mode: event.executionMode,
      result: event.result,
      category: event.errorCategory ?? "none",
    };

    try {
      this.metrics.increment("processing.job.outcome", 1, tags);
      if (event.durationMs !== null) {
        this.metrics.histogram("processing.job.duration_ms", event.durationMs, tags);
      }
      if (event.outputBytes !== null) {
        this.metrics.histogram("processing.job.output_bytes", event.outputBytes, tags);
      }
      if (event.inputBytes !== null) {
        this.metrics.histogram("processing.job.input_bytes", event.inputBytes, tags);
      }
    } catch (err) {
      this.logger.warn("Processing metrics emit failed", { error: String(err) });
    }

    try {
      this.analytics.track(PROCESSING_USAGE_EVENT, {
        tool: event.toolSlug,
        executionMode: event.executionMode,
        jobId: event.jobId,
        ownerType: event.ownerType,
        result: event.result,
        attempt: event.attempt,
        inputBytes: event.inputBytes,
        outputBytes: event.outputBytes,
        inputSizeBucket: sizeBucket(event.inputBytes),
        outputSizeBucket: sizeBucket(event.outputBytes),
        durationMs: event.durationMs,
        errorCategory: event.errorCategory,
        pageCount: event.pageCount,
      });
    } catch (err) {
      this.logger.warn("Processing analytics emit failed", { error: String(err) });
    }
  }
}
