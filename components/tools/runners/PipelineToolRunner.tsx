"use client";

import { useState } from "react";
import { Cog } from "lucide-react";
import { UploadDropzone } from "@/components/upload/UploadDropzone";
import { Button } from "@/components/ui/Button";
import { ErrorBanner } from "@/components/tools/ErrorBanner";
import { QuotaNotice } from "@/components/tools/QuotaNotice";
import { JobStatePanel } from "@/components/jobs/JobStatePanel";
import { useFileUpload } from "@/hooks/useFileUpload";
import { useProcessingJob } from "@/hooks/useProcessingJob";
import { executionCopyForSlug } from "@/lib/tools/executionPolicy";
import type { ServerToolConfig } from "@/data/serverToolConfig";

/**
 * The unified-pipeline runner: the pilot's front end.
 *
 * Differences from `ServerToolRunner` (which remains the rollback path) are all
 * consequences of the pipeline rather than a redesign:
 *
 *  - **Stages, not a percentage.** The panel renders the stage the worker
 *    reported. Nothing here advances a bar on a timer.
 *  - **Retry is a server decision.** The Retry button appears because the server
 *    said `retryable`, not because the client guessed from a status string.
 *  - **Download is a redirect.** The result is fetched by navigating to
 *    `/api/jobs/:id/result`, which 302s to a short-lived signed URL, so the
 *    output never passes through this component's memory.
 *  - **Submissions carry an idempotency key**, so a double-submit cannot start a
 *    second run.
 *
 * The privacy line comes from `executionCopyForSlug` — the authoritative
 * execution policy — not from a string typed into this file. A tool that moved
 * between execution modes would change its copy automatically, which is the whole
 * reason the policy is centralized.
 */
export function PipelineToolRunner({
  slug,
  config,
}: {
  slug: string;
  config: ServerToolConfig;
}) {
  const upload = useFileUpload({
    accept: config.accept,
    multiple: false,
    maxFiles: 1,
    maxSizeBytes: config.maxSizeBytes,
  });
  const hasFiles = upload.files.length > 0;

  const initialOptions: Record<string, string> = {};
  for (const f of config.options) {
    initialOptions[f.name] = f.kind === "select" ? f.default : "";
  }
  const [options, setOptions] = useState<Record<string, string>>(initialOptions);

  const {
    job,
    submitError,
    submitDenial,
    submitting,
    cancelling,
    retrying,
    downloading,
    submit,
    cancel,
    retry,
    download,
    reset,
  } = useProcessingJob();

  const executionNote =
    executionCopyForSlug(slug)?.description ??
    "Processed on our servers and removed once you have your result.";

  const requiredMissing = config.options.some(
    (f) => f.kind === "password" && f.required && !options[f.name]?.trim(),
  );

  const startOver = () => {
    reset();
    upload.reset();
    setOptions(initialOptions);
  };

  const inputBytes = upload.files[0]?.size ?? null;

  // A submitted job owns the surface: the form is gone until the user starts over.
  if (submitting && !job) {
    return (
      <JobStatePanel
        job={{
          id: "pending",
          toolSlug: slug,
          status: "created",
          stage: "preparing",
          stageLabel: "Preparing",
          progress: 5,
          attempt: 1,
          maxAttempts: 3,
          resultAvailable: false,
          retryable: false,
          // Cancellable while uploading: the hook aborts the request, which is a
          // real stop, not a request to stop.
          cancellable: true,
          errorCategory: null,
          error: null,
          createdAt: new Date().toISOString(),
          startedAt: null,
          finishedAt: null,
          expiresAt: null,
          inputBytes: null,
          outputBytes: null,
          outputFileName: null,
          outputMimeType: null,
        }}
        executionNote={executionNote}
        onCancel={cancel}
      />
    );
  }

  if (job) {
    return (
      <div className="flex flex-col gap-4">
        <JobStatePanel
          job={job}
          executionNote={executionNote}
          cancelling={cancelling}
          retrying={retrying}
          downloading={downloading}
          // The server's counts are authoritative and survive a remount; the
          // local upload size is a fallback for the window before the job's own
          // record comes back. `outputBytes` has no local equivalent — only the
          // processor knows it — so it comes from the job or not at all.
          inputBytes={job.inputBytes ?? inputBytes}
          outputBytes={job.outputBytes}
          showSizeComparison={config.showSizeComparison}
          resultNote={config.resultNote ?? null}
          onCancel={cancel}
          onRetry={retry}
          onDownload={download}
          onStartOver={startOver}
        />
        {submitDenial ? (
          <QuotaNotice reason={submitDenial} />
        ) : (
          submitError && <ErrorBanner message={submitError} />
        )}
      </div>
    );
  }

  return (
    <div>
      <UploadDropzone
        accept={config.accept}
        files={upload.files}
        errors={upload.errors}
        onAddFiles={upload.addFiles}
        onRemoveFile={upload.removeFile}
        title={config.uploadTitle}
        subtitle="or click to browse"
        acceptHint={config.acceptHint}
        trustText="Temporary server processing • Auto deletion"
      />

      {hasFiles && config.options.length > 0 && (
        <div className="mt-6 space-y-4 rounded-xl border border-softborder bg-lavender/40 p-4">
          {config.options.map((field) => (
            <div key={field.name}>
              <label
                htmlFor={`opt-${field.name}`}
                className="mb-1.5 block text-sm font-medium text-navy"
              >
                {field.label}
                {field.kind === "password" && field.required && (
                  <span aria-hidden="true" className="ml-0.5 text-red-500">
                    *
                  </span>
                )}
              </label>
              {field.kind === "select" ? (
                <select
                  id={`opt-${field.name}`}
                  value={options[field.name]}
                  onChange={(e) =>
                    setOptions((o) => ({ ...o, [field.name]: e.target.value }))
                  }
                  className="h-11 w-full rounded-button border border-softborder bg-white px-3 text-navy focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  {field.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`opt-${field.name}`}
                  type="password"
                  placeholder={field.placeholder}
                  aria-required={field.required || undefined}
                  value={options[field.name]}
                  onChange={(e) =>
                    setOptions((o) => ({ ...o, [field.name]: e.target.value }))
                  }
                  className="h-11 w-full rounded-button border border-softborder bg-white px-3 text-navy focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              )}
            </div>
          ))}
        </div>
      )}

      {config.resultNote && (
        <p className="mt-4 rounded-xl bg-lavender/60 px-4 py-2.5 text-xs text-navy-soft">
          {config.resultNote}
        </p>
      )}

      {submitDenial ? (
        <QuotaNotice reason={submitDenial} />
      ) : (
        submitError && <ErrorBanner message={submitError} />
      )}

      <div className="mt-6">
        <Button
          size="lg"
          fullWidth
          leadingIcon={<Cog size={18} />}
          disabled={!hasFiles || requiredMissing || submitting}
          onClick={() => submit({ slug, files: upload.files, options })}
        >
          {config.buttonLabel}
        </Button>
      </div>
    </div>
  );
}
