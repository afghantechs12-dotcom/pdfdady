import { NextResponse } from "next/server";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { PdfToolJobService } from "@/src/application/services/PdfToolJobService";
import { TERMINAL_JOB_STATUSES } from "@/src/domain/entities/Job";
import { resolveJobActor } from "@/lib/server/jobActor";
import {
  isProcessingJob,
  jobErrorResponse,
  legacyJobAccessDenied,
  loadJobRow,
  processingJobService,
  toStatusResponse,
} from "@/lib/server/processingJobApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cancels a job — honestly.
 *
 * The response distinguishes two genuinely different outcomes, because they feel
 * different to a user and conflating them would be a lie:
 *
 *  - `stopped: true` — the job had not started. It is cancelled, now, for
 *    certain. No processing will occur.
 *  - `stopped: false` — the job is mid-flight. Cancellation has been *requested*:
 *    the worker polls for it and aborts the subprocess, which usually takes well
 *    under a second but is not instantaneous. What is guaranteed is the part that
 *    matters — the result will never be published, because publishing requires a
 *    `running → completed` transition that a cancelled job can no longer make.
 *
 * The client is expected to show "Cancelling…" for the second case rather than
 * jumping straight to "Cancelled". Claiming an instant stop we cannot deliver
 * would be the kind of small dishonesty that makes a user distrust the rest of
 * the UI.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const row = await loadJobRow(id);
  if (isProcessingJob(row)) {
    try {
      const actor = await resolveJobActor();
      const { view, stopped } = await processingJobService().cancelJob(id, actor);
      return NextResponse.json(
        { ok: true, stopped, job: toStatusResponse(view) },
        { status: 202, headers: { "Cache-Control": "no-store" } },
      );
    } catch (err) {
      return jobErrorResponse(err);
    }
  }

  // Ownership gate for the legacy branch. First statement after the dispatch,
  // and before any job data is read: this endpoint used to answer for any id to
  // any caller, which is how an anonymous visitor could read (and download) a
  // stranger's job.
  const denied = await legacyJobAccessDenied(row);
  if (denied) return denied;

  const jobService =
    appContainer.resolve<PdfToolJobService>(Tokens.PdfToolJobService);
  const status = await jobService.getStatus(id);
  if (!status) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }
  if (TERMINAL_JOB_STATUSES.has(status.status)) {
    return NextResponse.json(
      { error: "Job has already finished.", status: status.status },
      { status: 409 },
    );
  }
  await jobService.cancel(id);
  return NextResponse.json(
    { ok: true, id },
    { status: 202, headers: { "Cache-Control": "no-store" } },
  );
}
