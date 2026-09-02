import { NextResponse } from "next/server";
import { resolveJobActor } from "@/lib/server/jobActor";
import {
  isProcessingJob,
  jobErrorResponse,
  loadJobRow,
  processingJobService,
  toStatusResponse,
} from "@/lib/server/processingJobApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Retries a failed or cancelled processing job.
 *
 * Every refusal is a 409 with a distinct `reason`, so the client can say
 * something specific instead of "try again":
 *
 *  - `permanent_failure` — the failure class cannot succeed on a second run (a
 *    corrupt document stays corrupt). Retrying would waste the user's time and
 *    ours to reach the same answer.
 *  - `attempts_exhausted` — the attempt budget is spent. The budget is per job,
 *    not per press, so this cannot be reset by clicking again.
 *  - `expired` — the staged input is gone with its retention window, so there is
 *    nothing left to process. The user must re-upload.
 *
 * Retry is only available on the pipeline. A legacy job has no retry endpoint,
 * and returning 404 for it is accurate rather than a stub.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const row = await loadJobRow(id);
  if (!isProcessingJob(row)) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }

  try {
    const actor = await resolveJobActor();
    const view = await processingJobService().retryJob(id, actor);
    return NextResponse.json(
      { ok: true, job: toStatusResponse(view) },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return jobErrorResponse(err);
  }
}
