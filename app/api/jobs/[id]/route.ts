import { NextResponse } from "next/server";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { PdfToolJobService } from "@/src/application/services/PdfToolJobService";
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
 * Polls a job's status.
 *
 * Dispatches on the stored job type, so one endpoint serves both pipelines and
 * the legacy path keeps working byte-for-byte while the pilot is behind its flag.
 * A `processing` job is read through ProcessingJobService, which enforces
 * ownership; the response carries a real stage and a category-derived message,
 * never a processor's own error text.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const row = await loadJobRow(id);
  if (isProcessingJob(row)) {
    try {
      const actor = await resolveJobActor();
      const view = await processingJobService().getJob(id, actor);
      return NextResponse.json(toStatusResponse(view), {
        headers: { "Cache-Control": "no-store" },
      });
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
  return NextResponse.json(status, {
    headers: { "Cache-Control": "no-store" },
  });
}
