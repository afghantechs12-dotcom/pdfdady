"use client";

import {
  AlertCircle,
  CheckCircle2,
  Cog,
  Download,
  RotateCcw,
  ShieldAlert,
  SlashSquare,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { JobStageTrack } from "@/components/jobs/JobStageTrack";
import { ResultWorkflowActions } from "@/components/tools/ResultWorkflowActions";
import {
  loadJobResultBytes,
  saveJobResultToWorkspace,
} from "@/components/jobs/jobResultTransfer";
import type { JobStatusResponse } from "@/lib/tools/processingJobStatus";
import { isActiveStatus } from "@/lib/tools/processingJobStatus";
import { formatBytes } from "@/lib/utils/formatBytes";

export interface JobStatePanelProps {
  job: JobStatusResponse;
  /** Copy describing where the work runs, from the execution policy. */
  executionNote: string;
  /** True while a cancel request is in flight or has been accepted. */
  cancelling?: boolean;
  outputBytes?: number | null;
  inputBytes?: number | null;
  showSizeComparison?: boolean;
  resultNote?: string | null;
  onCancel?: () => void;
  onRetry?: () => void;
  onDownload?: () => void;
  onStartOver?: () => void;
  downloading?: boolean;
  retrying?: boolean;
}

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div className="flex flex-col items-center gap-5 text-center">{children}</div>
);

const Badge = ({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "busy" | "good" | "bad" | "muted";
}) => {
  const tones = {
    busy: "bg-lavender/70 text-primary",
    good: "bg-green-50 text-success",
    bad: "bg-red-50 text-red-600",
    muted: "bg-softborder/40 text-navy-soft",
  } as const;
  return (
    <span
      className={`inline-flex h-14 w-14 items-center justify-center rounded-full ${tones[tone]}`}
    >
      {children}
    </span>
  );
};

/**
 * Every state a job can be shown in, in one component.
 *
 * Reusable on purpose: the next tool migrated into the pipeline should not need a
 * second opinion about what "retryable failure" looks like. Each branch is driven
 * by fields the server computed — `retryable`, `cancellable`, `resultAvailable` —
 * rather than by the client re-deriving policy from a status string. The client
 * cannot, for example, offer Retry on a permanent failure, because it is not the
 * one deciding what is retryable.
 *
 * The five states the brief calls for map to the five branches below: active
 * (with the stage track and Cancel), success (with Download), retryable failure
 * (with Retry), permanent failure (with the reason and no false hope), and
 * cancelled.
 */
export function JobStatePanel({
  job,
  executionNote,
  cancelling,
  outputBytes,
  inputBytes,
  showSizeComparison,
  resultNote,
  onCancel,
  onRetry,
  onDownload,
  onStartOver,
  downloading,
  retrying,
}: JobStatePanelProps) {
  // ---- Active -------------------------------------------------------------
  if (isActiveStatus(job.status)) {
    return (
      <Shell>
        <Badge tone="busy">
          <Cog size={30} className="animate-spin" />
        </Badge>
        <div className="w-full max-w-sm">
          <div className="mb-2.5 flex items-baseline justify-between text-sm">
            <span className="font-medium text-navy">
              {cancelling ? "Cancelling…" : job.stageLabel}
            </span>
            {job.attempt > 1 && (
              <span className="text-xs text-navy-soft">
                Attempt {job.attempt} of {job.maxAttempts}
              </span>
            )}
          </div>
          <JobStageTrack stage={job.stage} />
          <p className="mt-3 text-xs text-navy-soft">
            {cancelling
              ? // Honest about the gap. The worker checks for cancellation
                // between steps, so "stopping" is true and "stopped" is not yet.
                "Stopping the job. Your result will not be delivered."
              : executionNote}
          </p>
        </div>
        {job.cancellable && onCancel && (
          <Button
            size="lg"
            variant="outline"
            leadingIcon={<XCircle size={16} />}
            onClick={onCancel}
            disabled={cancelling}
          >
            {cancelling ? "Cancelling…" : "Cancel"}
          </Button>
        )}
      </Shell>
    );
  }

  // ---- Success ------------------------------------------------------------
  if (job.status === "completed" && job.resultAvailable) {
    const saved =
      showSizeComparison && inputBytes && outputBytes && inputBytes > 0
        ? Math.round((1 - outputBytes / inputBytes) * 100)
        : 0;
    return (
      <Shell>
        <Badge tone="good">
          <CheckCircle2 size={30} />
        </Badge>
        <div>
          <p className="text-lg font-semibold text-navy">Your file is ready</p>
          {/* The name first, as the local panel has always shown it: three tools
              open in three tabs are otherwise three identical "ready" screens. */}
          {job.outputFileName != null && (
            <p className="mt-1 text-sm font-medium text-navy">{job.outputFileName}</p>
          )}
          {outputBytes != null && (
            <p className="mt-1 text-sm text-navy-soft">{formatBytes(outputBytes)}</p>
          )}
          {showSizeComparison && inputBytes != null && outputBytes != null && (
            <p className="mt-2 text-sm text-navy-soft">
              {formatBytes(inputBytes)} → {formatBytes(outputBytes)}
              {saved > 0 && (
                <span className="ml-1 font-semibold text-success">
                  ({saved}% smaller)
                </span>
              )}
            </p>
          )}
        </div>
        {resultNote && (
          <p className="rounded-xl bg-lavender/60 px-4 py-2.5 text-xs text-navy-soft">
            {resultNote}
          </p>
        )}
        <div className="flex flex-col gap-3 sm:flex-row">
          {onDownload && (
            <Button
              size="lg"
              leadingIcon={<Download size={18} />}
              onClick={onDownload}
              disabled={downloading}
            >
              {downloading ? "Preparing…" : "Download"}
            </Button>
          )}
          {onStartOver && (
            <Button
              size="lg"
              variant="outline"
              leadingIcon={<RotateCcw size={16} />}
              onClick={onStartOver}
            >
              Start over
            </Button>
          )}
        </div>

        {/*
         * The same two workflow CTAs, the same words, as a local tool's result —
         * and the same decision module, so a server tool cannot offer an action a
         * local one hides. What differs is only HOW the bytes move, which is
         * exactly what the two ports below express.
         */}
        <ResultWorkflowActions
          toolSlug={job.toolSlug}
          fileName={job.outputFileName ?? "document.pdf"}
          outputMimeType={job.outputMimeType}
          resultAvailable={job.resultAvailable}
          loadBytes={() => loadJobResultBytes(job.id)}
          save={(target) => saveJobResultToWorkspace(job.id, target)}
        />
      </Shell>
    );
  }

  // ---- Cancelled ----------------------------------------------------------
  if (job.status === "cancelled") {
    return (
      <Shell>
        <Badge tone="muted">
          <SlashSquare size={28} />
        </Badge>
        <div>
          <p className="text-lg font-semibold text-navy">Cancelled</p>
          <p className="mt-1 text-sm text-navy-soft">
            No result was produced, and your file has been deleted from the server.
          </p>
        </div>
        {onStartOver && (
          <Button
            size="lg"
            variant="outline"
            leadingIcon={<RotateCcw size={16} />}
            onClick={onStartOver}
          >
            Start over
          </Button>
        )}
      </Shell>
    );
  }

  // ---- Expired ------------------------------------------------------------
  if (job.status === "expired") {
    return (
      <Shell>
        <Badge tone="muted">
          <AlertCircle size={28} />
        </Badge>
        <div>
          <p className="text-lg font-semibold text-navy">This result has expired</p>
          <p className="mt-1 text-sm text-navy-soft">
            Results are deleted automatically after an hour. Upload the file again
            to run the tool.
          </p>
        </div>
        {onStartOver && (
          <Button size="lg" leadingIcon={<RotateCcw size={16} />} onClick={onStartOver}>
            Start over
          </Button>
        )}
      </Shell>
    );
  }

  // ---- Failure: retryable, then permanent --------------------------------
  const retryable = job.status === "failed" && job.retryable;
  return (
    <Shell>
      <Badge tone="bad">{retryable ? <AlertCircle size={28} /> : <ShieldAlert size={28} />}</Badge>
      <div className="max-w-sm">
        <p className="text-lg font-semibold text-navy">
          {retryable ? "That didn't work" : "This file can't be processed"}
        </p>
        {/* The server's category-derived sentence, displayed verbatim. It is
            written to be safe: it names no path, no command, and no internal
            service. */}
        <p className="mt-1 text-sm text-navy-soft">
          {job.error ?? "Something went wrong on our side."}
        </p>
        {!retryable && (
          // A permanent failure says so. Offering Retry here would invite the
          // user to spend three attempts discovering what we already know.
          <p className="mt-3 rounded-xl bg-softborder/30 px-4 py-2.5 text-xs text-navy-soft">
            Retrying won&apos;t change the outcome for this file.
          </p>
        )}
        {retryable && job.attempt >= job.maxAttempts && (
          <p className="mt-3 rounded-xl bg-softborder/30 px-4 py-2.5 text-xs text-navy-soft">
            All {job.maxAttempts} attempts were used.
          </p>
        )}
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        {retryable && job.attempt < job.maxAttempts && onRetry && (
          <Button
            size="lg"
            leadingIcon={<RotateCcw size={16} />}
            onClick={onRetry}
            disabled={retrying}
          >
            {retrying ? "Retrying…" : "Try again"}
          </Button>
        )}
        {onStartOver && (
          <Button
            size="lg"
            variant={retryable && job.attempt < job.maxAttempts ? "outline" : "primary"}
            leadingIcon={<RotateCcw size={16} />}
            onClick={onStartOver}
          >
            Start over
          </Button>
        )}
      </div>
    </Shell>
  );
}

