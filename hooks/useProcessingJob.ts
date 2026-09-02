"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  JobStatusResponse,
  JobStreamFrame,
} from "@/lib/tools/processingJobStatus";
import { isNotFoundFrame } from "@/lib/tools/processingJobStatus";
import { readDenialReason } from "@/components/app/usageViewModel";
import type { DenyReason } from "@/src/domain/metering/decision";

export interface SubmitProcessingJobArgs {
  slug: string;
  files: File[];
  options: Record<string, string>;
}

export interface UseProcessingJobState {
  job: JobStatusResponse | null;
  /** A submission-time error, distinct from a job failure the server recorded. */
  submitError: string | null;
  /**
   * Set when the submission was refused for quota, so the caller can render the
   * denial panel instead of the generic banner. `submitError` is still filled in,
   * so a caller that does not know about this field keeps working.
   */
  submitDenial: DenyReason | null;
  submitting: boolean;
  cancelling: boolean;
  retrying: boolean;
  downloading: boolean;
}

/** Generates the idempotency key for one logical submission. */
function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Drives one processing job from the browser: submit, stream, cancel, retry,
 * download.
 *
 * ## Idempotency
 *
 * The key is generated once per *submission* and held in a ref, not regenerated
 * per request. That is what makes a double-submit safe: a second POST carrying
 * the same key returns the original job (HTTP 200) instead of starting a second
 * Ghostscript run. A disabled button also prevents the second click, but a
 * disabled button does not survive a dropped response, an impatient reload, or a
 * proxy retry — and those are the cases that actually produce duplicate work.
 * The key is the guarantee; the disabled button is a courtesy.
 *
 * ## Streaming
 *
 * Progress arrives over SSE, which sends a frame only when the stage changes and
 * closes after the terminal frame. If the stream drops, `pollOnce` recovers the
 * current status from the polling endpoint — the job's state lives on the server,
 * so a lost connection costs an update, never the job.
 */
export function useProcessingJob() {
  const [state, setState] = useState<UseProcessingJobState>({
    job: null,
    submitError: null,
    submitDenial: null,
    submitting: false,
    cancelling: false,
    retrying: false,
    downloading: false,
  });

  const esRef = useRef<EventSource | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const idempotencyRef = useRef<string | null>(null);
  const jobIdRef = useRef<string | null>(null);

  const patch = useCallback((p: Partial<UseProcessingJobState>) => {
    setState((s) => ({ ...s, ...p }));
  }, []);

  const closeStream = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  const teardown = useCallback(() => {
    closeStream();
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = null;
  }, [closeStream]);

  useEffect(() => () => teardown(), [teardown]);

  const openStream = useCallback(
    (jobId: string) => {
      closeStream();
      const es = new EventSource(`/api/jobs/${jobId}/progress`);
      esRef.current = es;
      es.onmessage = (ev) => {
        let frame: JobStreamFrame;
        try {
          frame = JSON.parse(ev.data) as JobStreamFrame;
        } catch {
          return;
        }
        if (isNotFoundFrame(frame)) {
          closeStream();
          patch({ submitError: "This job could not be found. Please try again." });
          return;
        }
        patch({ job: frame, cancelling: false });
        if ("terminal" in frame && frame.terminal) closeStream();
      };
      es.onerror = () => {
        // EventSource reconnects on its own. Don't surface a transient blip as a
        // failure — the job is unaffected, and a poll will reconcile.
      };
    },
    [closeStream, patch],
  );

  const pollOnce = useCallback(
    async (jobId: string) => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
        if (!res.ok) return;
        patch({ job: (await res.json()) as JobStatusResponse });
      } catch {
        /* offline; the stream or the next poll recovers */
      }
    },
    [patch],
  );

  const submit = useCallback(
    async ({ slug, files, options }: SubmitProcessingJobArgs) => {
      if (files.length === 0) return;
      // One key per logical submission — reused by every retry of *this* POST.
      idempotencyRef.current ??= newIdempotencyKey();

      patch({ submitting: true, submitError: null, submitDenial: null, job: null });
      const controller = new AbortController();
      uploadAbortRef.current = controller;

      try {
        const form = new FormData();
        for (const f of files) form.append("file", f);
        for (const [k, v] of Object.entries(options)) form.append(k, v);

        const res = await fetch(`/api/jobs?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          body: form,
          signal: controller.signal,
          headers: { "Idempotency-Key": idempotencyRef.current },
        });

        if (!res.ok) {
          let message = "Processing failed. Please try again.";
          let body: unknown = null;
          try {
            const data = await res.json();
            body = data;
            if (typeof data?.error === "string") message = data.error;
          } catch {
            /* non-JSON error body */
          }
          patch({
            submitError: message,
            // Null for everything that is not a quota refusal.
            submitDenial: readDenialReason(res.status, body),
            submitting: false,
          });
          return;
        }

        const data = (await res.json()) as { jobId?: string; job?: JobStatusResponse };
        if (!data.jobId) {
          patch({
            submitError: "The server did not accept the job. Please try again.",
            submitting: false,
          });
          return;
        }
        jobIdRef.current = data.jobId;
        patch({ job: data.job ?? null, submitting: false });
        openStream(data.jobId);
      } catch (err) {
        // An abort is the user cancelling or navigating; not an error to show.
        if (err instanceof DOMException && err.name === "AbortError") {
          patch({ submitting: false });
          return;
        }
        patch({
          submitError: "Could not reach the server. Please check your connection.",
          submitting: false,
        });
      } finally {
        uploadAbortRef.current = null;
      }
    },
    [openStream, patch],
  );

  const cancel = useCallback(async () => {
    // Still uploading: there is no job yet, so abort the request instead of
    // asking the server to cancel something it has never heard of.
    if (uploadAbortRef.current) {
      uploadAbortRef.current.abort();
      uploadAbortRef.current = null;
      patch({ submitting: false, job: null });
      return;
    }
    const jobId = jobIdRef.current;
    if (!jobId) return;
    patch({ cancelling: true });
    try {
      const res = await fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" });
      const data = (await res.json()) as { job?: JobStatusResponse; stopped?: boolean };
      // `stopped` distinguishes a job stopped before it started from one being
      // asked to stop mid-run. The panel shows "Cancelling…" for the latter
      // rather than claiming an instant stop we cannot deliver.
      patch({ job: data.job ?? null, cancelling: !data.stopped });
    } catch {
      patch({ cancelling: false });
      await pollOnce(jobId);
    }
  }, [patch, pollOnce]);

  const retry = useCallback(async () => {
    const jobId = jobIdRef.current;
    if (!jobId) return;
    patch({ retrying: true });
    try {
      const res = await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
      const data = (await res.json()) as {
        job?: JobStatusResponse;
        error?: string;
      };
      if (!res.ok) {
        patch({ retrying: false });
        await pollOnce(jobId);
        return;
      }
      patch({ job: data.job ?? null, retrying: false });
      openStream(jobId);
    } catch {
      patch({ retrying: false });
    }
  }, [openStream, patch, pollOnce]);

  const download = useCallback(async () => {
    const jobId = jobIdRef.current;
    if (!jobId) return;
    patch({ downloading: true });
    try {
      // A plain navigation: the route 302s to a short-lived signed URL and the
      // browser saves the file. Fetching it into a Blob first would pull the
      // whole output through JS memory for no benefit.
      window.location.assign(`/api/jobs/${jobId}/result`);
    } finally {
      // Reset shortly after — the navigation does not unmount this component.
      setTimeout(() => patch({ downloading: false }), 1_500);
    }
  }, [patch]);

  const reset = useCallback(() => {
    teardown();
    idempotencyRef.current = null;
    jobIdRef.current = null;
    setState({
      job: null,
      submitError: null,
    submitDenial: null,
      submitting: false,
      cancelling: false,
      retrying: false,
      downloading: false,
    });
  }, [teardown]);

  return { ...state, submit, cancel, retry, download, reset, pollOnce };
}
