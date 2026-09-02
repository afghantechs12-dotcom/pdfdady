import type { JobErrorCategory } from "@/src/domain/jobs/jobErrors";
import type { JobProgressStage } from "@/src/domain/jobs/progressStage";
import { ALL_PROGRESS_STAGES, PROGRESS_STAGE_COPY } from "@/src/domain/jobs/progressStage";

/**
 * The processing-job status wire shape — the single contract between the job API
 * and every client that renders a job.
 *
 * It lives in a dependency-free module on purpose: the server routes and the
 * React components both import this type, and if it were declared next to the
 * route it would drag `next/server` and the DI container into the client bundle.
 *
 * Note what is *not* here: no storage key, no filesystem path, no processor
 * message, no owner id. A client cannot render what it is never sent, which is a
 * stronger guarantee than remembering not to display it.
 */
export interface JobStatusResponse {
  id: string;
  toolSlug: string | null;
  status: "created" | "queued" | "running" | "completed" | "failed" | "cancelled" | "expired";
  stage: JobProgressStage;
  stageLabel: string;
  /** Derived from `stage`. Never accumulated, never invented. */
  progress: number;
  attempt: number;
  maxAttempts: number;
  resultAvailable: boolean;
  retryable: boolean;
  cancellable: boolean;
  errorCategory: JobErrorCategory | null;
  /** Fixed, category-derived copy. Safe to display verbatim. */
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
  /**
   * Byte counts for the result summary ("1.2 MB → 950 KB (21% smaller)").
   *
   * Sizes, not contents — a byte count says nothing about what the document
   * holds, which is why it can cross this boundary while the bytes themselves
   * never do. Null until the job records them: `inputBytes` from submission,
   * `outputBytes` only once the processor has produced output.
   *
   * These are here because the pilot shipped without them and the omission was
   * silent: the panel guards its size display on `outputBytes != null`, so a
   * compression job that saved 21% rendered as a bare "Your file is ready" while
   * the legacy runner it replaced showed the comparison. Dead UI, no error.
   */
  inputBytes: number | null;
  outputBytes: number | null;
  /**
   * The produced file's name and type.
   *
   * The pilot's success panel showed a size and no name, so a user who ran three
   * tools in three tabs could not tell which result was which — the local panel
   * has always shown the filename. It is also what lets this surface offer the
   * same workflow actions as the local one: `Open in Editor` is decided by the
   * capability record AND by the MIME the run actually produced.
   *
   * Still no storage key and no file id: naming a file is not locating it.
   */
  outputFileName: string | null;
  outputMimeType: string | null;
}

/** A terminal SSE frame: a full status plus the flag that ends the stream. */
export interface JobTerminalFrame extends JobStatusResponse {
  terminal: true;
}

/** The stream also emits this when a job is unknown or not the caller's. */
export interface JobNotFoundFrame {
  terminal: true;
  status: "not-found";
}

export type JobStreamFrame = JobStatusResponse | JobTerminalFrame | JobNotFoundFrame;

export function isNotFoundFrame(frame: JobStreamFrame): frame is JobNotFoundFrame {
  return (frame as JobNotFoundFrame).status === "not-found";
}

/**
 * The stages a job passes through, for rendering a track.
 *
 * `done` is excluded: it is the success state, which gets its own panel rather
 * than a fifth dot the user watches. Keeping the list derived from
 * ALL_PROGRESS_STAGES means adding a stage to the domain shows up in the UI
 * automatically instead of silently rendering an incomplete track.
 */
export const VISIBLE_JOB_STAGES: readonly JobProgressStage[] =
  ALL_PROGRESS_STAGES.filter((s) => s !== "done");

export function stageLabel(stage: JobProgressStage): string {
  return PROGRESS_STAGE_COPY[stage].label;
}

/** True while a job is still doing something. */
export function isActiveStatus(status: JobStatusResponse["status"]): boolean {
  return status === "created" || status === "queued" || status === "running";
}
