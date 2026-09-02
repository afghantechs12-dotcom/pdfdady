"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Cog,
  Download,
  RotateCcw,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { UploadDropzone } from "@/components/upload/UploadDropzone";
import { Button } from "@/components/ui/Button";
import { ErrorBanner } from "@/components/tools/ErrorBanner";
import { QuotaNotice } from "@/components/tools/QuotaNotice";
import { ResultWorkflowActions } from "@/components/tools/ResultWorkflowActions";
import { saveJobResultToWorkspace } from "@/components/jobs/jobResultTransfer";
import { readDenialReason } from "@/components/app/usageViewModel";
import type { DenyReason } from "@/src/domain/metering/decision";
import { useFileUpload } from "@/hooks/useFileUpload";
import { formatBytes } from "@/lib/utils/formatBytes";
import { downloadBlob } from "@/lib/utils/download";
import { cn } from "@/lib/utils/cn";
import {
  isBatchEligible,
  TOOLS_BATCH_MAX_FILES,
  type ServerToolConfig,
} from "@/data/serverToolConfig";
import { toolErrorMessage, type ToolJobErrorType } from "@/lib/tools/jobError";

type Status = "idle" | "processing" | "done" | "error";

interface ServerResult {
  blob: Blob;
  fileName: string;
  originalSize: number;
  resultSize: number;
  /**
   * The MIME the job reported, and the job it came from.
   *
   * Both are needed by the workflow CTAs and neither was kept before: the panel
   * only ever downloaded the blob. The job id is what lets `Save to Workspace` be
   * a server-to-storage copy instead of a second upload of bytes this runner has
   * already pulled once.
   */
  mimeType: string;
  jobId: string;
}

interface TerminalEvent {
  terminal: true;
  status: "completed" | "failed" | "cancelled" | "not-found";
  result?: {
    downloadName: string;
    mimeType: string;
    originalSize: number;
    resultSize: number;
  } | null;
  error?: string | null;
  errorType?: ToolJobErrorType | null;
}

interface ProgressEvent {
  pct: number;
  detail?: string;
}

/** Maps a terminal job event to a user-facing message (shares toolErrorMessage
 * with the server route so the two can't drift). */
function terminalErrorMessage(e: TerminalEvent): string {
  if (e.status === "cancelled") return "Processing was cancelled.";
  if (e.status === "not-found") return "The job could not be found. Please try again.";
  return toolErrorMessage(e.errorType ?? "unexpected", e.error);
}

export function ServerToolRunner({
  slug,
  config,
}: {
  slug: string;
  config: ServerToolConfig;
}) {
  // Batch-eligible tools accept multiple files (N inputs → one zip of outputs).
  const batchEligible = isBatchEligible(slug);
  const upload = useFileUpload({
    accept: config.accept,
    multiple: batchEligible,
    maxFiles: batchEligible ? TOOLS_BATCH_MAX_FILES : 1,
    maxSizeBytes: config.maxSizeBytes,
  });
  const hasFiles = upload.files.length > 0;

  const initialOptions: Record<string, string> = {};
  for (const f of config.options) {
    initialOptions[f.name] = f.kind === "select" ? f.default : "";
  }
  const [options, setOptions] = useState<Record<string, string>>(initialOptions);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  // A quota refusal, kept apart from `error` so it gets its own panel. The
  // reason is the only thing read from the refusal body.
  const [denial, setDenial] = useState<DenyReason | null>(null);
  const [result, setResult] = useState<ServerResult | null>(null);
  const [progressPct, setProgressPct] = useState(0);
  const [progressDetail, setProgressDetail] = useState<string | null>(null);
  /** How many files were in the submitted batch (1 for a single-file run). */
  const [submittedCount, setSubmittedCount] = useState(1);

  const eventSourceRef = useRef<EventSource | null>(null);
  const downloadAbortRef = useRef<AbortController | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);

  /** Tears down the SSE stream + any in-flight upload/download. */
  const teardown = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    downloadAbortRef.current?.abort();
    downloadAbortRef.current = null;
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = null;
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  const reset = () => {
    teardown();
    setStatus("idle");
    setError(null);
    setDenial(null);
    setResult(null);
    setProgressPct(0);
    setProgressDetail(null);
    setSubmittedCount(1);
    upload.reset();
    setOptions(initialOptions);
  };

  const requiredMissing = config.options.some(
    (f) => f.kind === "password" && f.required && !options[f.name]?.trim(),
  );

  const fetchDownload = async (
    jobId: string,
    terminal: TerminalEvent,
  ): Promise<void> => {
    if (!terminal.result) {
      setError("The result is no longer available. Please try again.");
      setStatus("error");
      return;
    }
    const controller = new AbortController();
    downloadAbortRef.current = controller;
    try {
      const res = await fetch(`/api/jobs/${jobId}/download`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        setError("Could not fetch the result. Please try again.");
        setStatus("error");
        return;
      }
      const blob = await res.blob();
      setResult({
        blob,
        fileName: terminal.result.downloadName,
        originalSize: terminal.result.originalSize,
        resultSize: terminal.result.resultSize,
        mimeType: terminal.result.mimeType,
        jobId,
      });
      setStatus("done");
    } catch {
      if (!controller.signal.aborted) {
        setError("Could not fetch the result. Please try again.");
        setStatus("error");
      }
    } finally {
      downloadAbortRef.current = null;
    }
  };

  const onTerminal = async (jobId: string, e: TerminalEvent): Promise<void> => {
    teardown();
    if (e.status === "completed") {
      await fetchDownload(jobId, e);
    } else {
      setError(terminalErrorMessage(e));
      setStatus("error");
    }
  };

  const submit = async () => {
    if (!hasFiles) return;
    setStatus("processing");
    setError(null);
    setDenial(null);
    setResult(null);
    setProgressPct(0);
    setProgressDetail(null);
    setSubmittedCount(upload.files.length);

    // Abort the upload if the user cancels/leaves before the job is enqueued.
    const uploadController = new AbortController();
    uploadAbortRef.current = uploadController;

    try {
      const form = new FormData();
      // Append every staged file so the server can run a batch job when >1.
      for (const f of upload.files) {
        form.append("file", f);
      }
      for (const f of config.options) {
        form.append(f.name, options[f.name] ?? "");
      }

      const res = await fetch(`/api/jobs?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        body: form,
        signal: uploadController.signal,
      });

      if (!res.ok) {
        let message = "Processing failed. Please try again.";
        let body: unknown = null;
        try {
          const data = await res.json();
          body = data;
          if (data?.error) message = data.error;
        } catch {
          /* non-JSON error */
        }
        // Null for everything that is not a quota refusal, which stays a banner.
        setDenial(readDenialReason(res.status, body));
        setError(message);
        setStatus("error");
        return;
      }

      const { jobId } = await res.json();
      uploadAbortRef.current = null;
      if (!jobId) {
        setError("The server did not accept the job. Please try again.");
        setStatus("error");
        return;
      }

      // Stream progress over SSE; the server sends a terminal event + closes.
      const es = new EventSource(`/api/jobs/${jobId}/progress`);
      eventSourceRef.current = es;
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as ProgressEvent | TerminalEvent;
          // Progress events carry `pct`; terminal events carry `terminal`.
          if ("pct" in data) {
            setProgressPct(data.pct);
            setProgressDetail(data.detail ?? null);
          } else {
            void onTerminal(jobId, data);
          }
        } catch {
          /* ignore malformed chunk */
        }
      };
      es.onerror = () => {
        // EventSource auto-reconnects; if the job is already terminal the server
        // closed cleanly and onmessage handled it. On a real failure, leave the
        // processing UI up — a subsequent status poll or retry will resolve it.
        // (We avoid flapping to an error on a transient reconnect.)
      };
    } catch (err) {
      // An abort (user cancelled during upload, or navigated away) is expected —
      // don't surface it as an error. The teardown/reset path handles state.
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (uploadAbortRef.current?.signal.aborted) return;
      setError("Could not reach the server. Please check your connection.");
      setStatus("error");
    } finally {
      uploadAbortRef.current = null;
    }
  };

  const cancel = async () => {
    // If the upload is still in flight, abort it (no job to cancel yet) and
    // return the user to the form so they can adjust + retry.
    if (uploadAbortRef.current) {
      uploadAbortRef.current.abort();
      uploadAbortRef.current = null;
      setStatus("idle");
      setProgressPct(0);
      setProgressDetail(null);
      return;
    }
    // Otherwise cancel the running job; the SSE terminal event drives the UI.
    try {
      // jobId isn't stored in state (kept in the EventSource URL); re-derive it
      // from the open stream's url.
      const url = eventSourceRef.current?.url ?? "";
      const match = url.match(/\/api\/jobs\/([^/]+)\/progress/);
      const jobId = match?.[1];
      if (jobId) await fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" });
    } catch {
      /* best-effort */
    }
  };

  if (status === "done" && result) {
    const isBatch = submittedCount > 1;
    const pct =
      result.originalSize > 0
        ? Math.round((1 - result.resultSize / result.originalSize) * 100)
        : 0;
    return (
      <div className="flex flex-col items-center gap-5 text-center">
        <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-green-50 text-success">
          <CheckCircle2 size={30} />
        </span>
        <div>
          <p className="text-lg font-semibold text-navy">
            {isBatch ? `${submittedCount} files are ready` : "Your file is ready"}
          </p>
          <p className="mt-1 text-sm text-navy-soft">
            {result.fileName} · {formatBytes(result.resultSize)}
          </p>
          {isBatch ? (
            <p className="mt-2 text-sm text-navy-soft">
              {submittedCount} files processed into one zip.
            </p>
          ) : (
            config.showSizeComparison && (
              <p className="mt-2 text-sm text-navy-soft">
                {formatBytes(result.originalSize)} →{" "}
                {formatBytes(result.resultSize)}
                {pct > 0 && (
                  <span className="ml-1 font-semibold text-success">
                    ({pct}% smaller)
                  </span>
                )}
              </p>
            )
          )}
        </div>
        {config.resultNote && (
          <p className="rounded-xl bg-lavender/60 px-4 py-2.5 text-xs text-navy-soft">
            {config.resultNote}
          </p>
        )}
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button
            size="lg"
            leadingIcon={<Download size={18} />}
            onClick={() => downloadBlob(result.blob, result.fileName)}
          >
            Download
          </Button>
          <Button
            size="lg"
            variant="outline"
            leadingIcon={<RotateCcw size={16} />}
            onClick={reset}
          >
            Start over
          </Button>
        </div>

        {/*
         * Not for a batch. `N inputs → one zip` is several documents, and a zip
         * is not a document the Workspace or the editor can hold — offering to
         * store it as one would be the "multi-output faked as a single document"
         * the workflow is supposed to stop. The single-file case gets the same
         * CTAs as every other result surface, decided by the same module.
         */}
        {!isBatch && (
          <ResultWorkflowActions
            toolSlug={slug}
            fileName={result.fileName}
            sourceFileNames={upload.files.map((f) => f.name)}
            outputMimeType={result.mimeType}
            // Already in memory: this runner downloads the result to show it, so
            // opening the editor costs no transfer at all.
            loadBytes={async () => new Uint8Array(await result.blob.arrayBuffer())}
            save={(target) => saveJobResultToWorkspace(result.jobId, target)}
          />
        )}
      </div>
    );
  }

  if (status === "processing") {
    const label = progressDetail ?? config.processingLabel;
    return (
      <div className="flex flex-col items-center gap-5 text-center">
        <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-lavender/70 text-primary">
          <Cog size={30} className="animate-spin" />
        </span>
        <div className="w-full max-w-sm">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium text-navy">{label}</span>
            <span className="tabular-nums text-navy-soft">{progressPct}%</span>
          </div>
          <div
            role="progressbar"
            aria-valuenow={progressPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={label}
            className="h-2.5 w-full overflow-hidden rounded-full bg-softborder/60"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
              style={{ width: `${Math.max(2, progressPct)}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-navy-soft">
            {submittedCount > 1
              ? `${submittedCount} files are processed on the server and auto-deleted. You can cancel anytime.`
              : "Your file is processed on the server and auto-deleted. You can cancel anytime."}
          </p>
        </div>
        <Button
          size="lg"
          variant="outline"
          leadingIcon={<XCircle size={16} />}
          onClick={cancel}
        >
          Cancel
        </Button>
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
        acceptHint={
          batchEligible
            ? `${config.acceptHint} · Drop up to ${TOOLS_BATCH_MAX_FILES} to batch`
            : config.acceptHint
        }
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
                <>
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
                  {field.required && !options[field.name]?.trim() && (
                    <p className="mt-1.5 text-xs text-navy-soft">
                      Enter a password to continue.
                    </p>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {config.resultNote && (
        <p
          className={cn(
            "mt-4 rounded-xl bg-lavender/60 px-4 py-2.5 text-xs text-navy-soft",
          )}
        >
          {config.resultNote}
        </p>
      )}

      {status === "error" && denial && <QuotaNotice reason={denial} />}
      {status === "error" && !denial && error && <ErrorBanner message={error} />}

      <div className="mt-6">
        <Button
          size="lg"
          fullWidth
          leadingIcon={<Cog size={18} />}
          disabled={!hasFiles || requiredMissing}
          onClick={submit}
        >
          {config.buttonLabel}
        </Button>
      </div>
    </div>
  );
}
