import { NextResponse } from "next/server";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { IJobEvents } from "@/src/application/ports/queue/JobEvents";
import type { PdfToolJobService } from "@/src/application/services/PdfToolJobService";
import { TERMINAL_JOB_STATUSES } from "@/src/domain/entities/Job";
import { resolveJobActor } from "@/lib/server/jobActor";
import {
  isProcessingJob,
  legacyJobAccessDenied,
  loadJobRow,
  processingJobService,
  toStatusResponse,
} from "@/lib/server/processingJobApi";
import { TERMINAL_STATUSES } from "@/src/domain/jobs/jobStateMachine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-Sent Events stream of a job's progress. Subscribes to IJobEvents for
 * the live progress (the worker emits via JobContext.progress) and polls the job
 * repository for the terminal state, then sends a final `{ terminal: true }`
 * event and closes. Unsubscribes + clears the poller when the client disconnects.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const row = await loadJobRow(id);
  if (isProcessingJob(row)) {
    return processingProgressStream(id);
  }

  // Gated BEFORE the stream is constructed, so an unauthorized subscriber is
  // refused with a plain 404 rather than handed an open connection that reports
  // `not-found` forever. An SSE connection is a read like any other.
  const denied = await legacyJobAccessDenied(row);
  if (denied) return denied;

  const jobEvents = appContainer.resolve<IJobEvents>(Tokens.JobEvents);
  const jobService =
    appContainer.resolve<PdfToolJobService>(Tokens.PdfToolJobService);

  const enc = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let poller: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (obj: Record<string, unknown>): void => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          // controller already closed (client gone) — swallow.
        }
      };
      const close = (): void => {
        if (closed) return;
        closed = true;
        if (poller) clearInterval(poller);
        if (unsubscribe) unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Replay the last known progress immediately, then subscribe for updates.
      unsubscribe = jobEvents.onProgress(id, (e) => {
        jobService.recordProgress(id, e.pct, e.detail);
        send({ pct: e.pct, detail: e.detail });
      });

      // Poll for terminal state (progress events alone don't signal completion).
      poller = setInterval(() => {
        void jobService.getStatus(id).then((status) => {
          if (!status) {
            send({ terminal: true, status: "not-found" });
            close();
            return;
          }
          if (TERMINAL_JOB_STATUSES.has(status.status)) {
            send({
              terminal: true,
              status: status.status,
              result: status.result,
              error: status.error,
              errorType: status.errorType,
            });
            close();
          }
        });
      }, 250);
    },
    cancel() {
      // Client disconnected — tear down the subscription + poller.
      closed = true;
      if (poller) clearInterval(poller);
      if (unsubscribe) unsubscribe();
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Stage-based progress stream for a unified-pipeline job.
 *
 * Every frame is the job's own recorded stage — `preparing`, `queued`,
 * `processing`, `finalizing`, `done` — plus the percentage that stage maps to.
 * The percentage is derived, never accumulated: nothing here advances a number on
 * a timer, so the stream cannot claim progress the worker has not reported. A job
 * that sits in `processing` for ninety seconds shows "Processing" for ninety
 * seconds, which is the truth, instead of creeping toward 99% and stalling there.
 *
 * Authorization is applied to the stream itself, not just to the polling
 * endpoint: an SSE connection is a read, and an unauthorized read closes
 * immediately with `not-found` — the same answer an unknown id gets.
 */
function processingProgressStream(id: string): NextResponse {
  const enc = new TextEncoder();
  let poller: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (obj: Record<string, unknown>): void => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          // Client gone; the cancel() handler tears down.
        }
      };
      const close = (): void => {
        if (closed) return;
        closed = true;
        if (poller) clearInterval(poller);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      let lastStage: string | null = null;
      const tick = async (): Promise<void> => {
        try {
          const actor = await resolveJobActor();
          const view = await processingJobService().getJob(id, actor);
          const payload = toStatusResponse(view);
          // Only emit on change: a stage stream has nothing to say between
          // stages, and repeating the same frame four times a second would make
          // the client's log useless and the connection pointlessly chatty.
          if (payload.stage !== lastStage) {
            lastStage = payload.stage;
            send(payload as unknown as Record<string, unknown>);
          }
          if (TERMINAL_STATUSES.has(view.status)) {
            send({ terminal: true, ...payload });
            close();
          }
        } catch {
          // Unknown or not ours — indistinguishable by design.
          send({ terminal: true, status: "not-found" });
          close();
        }
      };

      void tick();
      poller = setInterval(() => void tick(), 400);
    },
    cancel() {
      closed = true;
      if (poller) clearInterval(poller);
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
