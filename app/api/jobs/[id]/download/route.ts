import { NextResponse } from "next/server";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { PdfToolJobService } from "@/src/application/services/PdfToolJobService";
import type { IDownloadService } from "@/src/application/ports/storage/DownloadService";
import {
  isProcessingJob,
  legacyJobAccessDenied,
  loadJobRow,
  processingResultRedirect,
} from "@/lib/server/processingJobApi";
import { attachmentDisposition } from "@/src/application/services/documentContent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Redirects (302) to a time-limited signed URL for a completed job's output.
 * The client fetches bytes directly from storage (R2 presign in prod, the local
 * HMAC route in dev) — the app server stays out of the data path. 404 if the job
 * is unknown, 409 if it hasn't completed (no output yet). The download name is
 * available in the job status (GET /api/jobs/[id]); Content-Disposition is set
 * on the redirect as a best-effort hint for direct browser downloads.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // A pipeline job's output is served by the same authorized path as `/result`,
  // so a client that still points at `/download` gets the ownership and
  // completion checks rather than the legacy unauthorized behaviour.
  const row = await loadJobRow(id);
  if (isProcessingJob(row)) {
    return processingResultRedirect(id);
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
  if (status.status !== "completed" || !status.result) {
    return NextResponse.json(
      { error: "Job output is not available.", status: status.status },
      { status: 409 },
    );
  }

  const downloadService =
    appContainer.resolve<IDownloadService>(Tokens.DownloadService);
  const dl = await downloadService.getUrl(status.result.outputFileId);
  if (!dl) {
    // The output expired (retention sweep) or was removed.
    return NextResponse.json(
      { error: "The output is no longer available. Please re-run the job." },
      { status: 410 },
    );
  }

  return new NextResponse(null, {
    status: 302,
    headers: {
      Location: dl.url,
      "Content-Disposition": attachmentDisposition(status.result.downloadName),
      "Cache-Control": "no-store",
    },
  });
}
