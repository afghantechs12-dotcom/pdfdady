/**
 * Progress as named stages rather than invented percentages.
 *
 * A Ghostscript run does not report how far through a file it is, so any
 * percentage a worker emits mid-processing is fabricated. The previous handler
 * emitted 5 / 15 / 90 / 100 and the UI drew a bar from it, which told the user
 * a story the system had no way to know. Stages are the honest resolution: each
 * one corresponds to a real boundary the worker actually crosses.
 *
 * `fraction` exists only so a progress bar has something monotonic to animate
 * toward, and is documented as a stage marker — not a measurement of work done.
 * The UI labels the stage; the number is decoration.
 */
export type JobProgressStage =
  | "preparing"
  | "queued"
  | "processing"
  | "finalizing"
  | "done";

export const ALL_PROGRESS_STAGES: readonly JobProgressStage[] = [
  "preparing",
  "queued",
  "processing",
  "finalizing",
  "done",
];

export interface ProgressStageCopy {
  stage: JobProgressStage;
  /** Shown next to the spinner. Present tense; describes a real boundary. */
  label: string;
  /** Position of the stage marker, 0..1. A marker, not a measurement. */
  fraction: number;
}

export const PROGRESS_STAGE_COPY: Record<JobProgressStage, ProgressStageCopy> = {
  preparing: { stage: "preparing", label: "Preparing", fraction: 0.05 },
  queued: { stage: "queued", label: "Queued", fraction: 0.2 },
  processing: { stage: "processing", label: "Processing", fraction: 0.5 },
  finalizing: { stage: "finalizing", label: "Finalizing", fraction: 0.9 },
  done: { stage: "done", label: "Done", fraction: 1 },
};

/** Narrowing guard for a stage read back from the database. */
export function isProgressStage(value: unknown): value is JobProgressStage {
  return (
    typeof value === "string" &&
    (ALL_PROGRESS_STAGES as readonly string[]).includes(value)
  );
}

/** Ordering helper so a late out-of-order event cannot move the UI backwards. */
export function stageRank(stage: JobProgressStage): number {
  return ALL_PROGRESS_STAGES.indexOf(stage);
}
