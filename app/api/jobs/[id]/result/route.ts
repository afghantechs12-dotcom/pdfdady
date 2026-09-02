import { NextResponse } from "next/server";
import {
  isProcessingJob,
  loadJobRow,
  processingResultRedirect,
  processingResultStream,
} from "@/lib/server/processingJobApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Redirects to a time-limited signed URL for a completed job's output.
 *
 * Three independent gates stand between a request and somebody's document:
 *
 *  1. **Ownership.** The actor is resolved from the session cookie and a job the
 *     actor does not own gets the same 404 a missing job gets, so the endpoint
 *     never confirms that a stranger's id exists.
 *  2. **Completion.** The service refuses unless the job is `completed` and
 *     unexpired. There is no path that yields a result for a running, failed,
 *     cancelled or expired job — the check lives in the service, so a future
 *     route cannot forget it.
 *  3. **Retention.** The signed URL is minted per request with a short TTL, so a
 *     leaked URL stops working and a purged output returns 410 rather than a
 *     broken download.
 *
 * The bytes come from storage directly, so serving a large output costs a
 * redirect rather than a held connection on the app server.
 *
 * `?inline=1` answers with the bytes from this origin instead, for the one caller
 * that needs them IN the page rather than on disk: `Open in Editor`. Same three
 * gates — it is the same service call — see `processingResultStream`.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const row = await loadJobRow(id);
  if (!isProcessingJob(row)) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }
  return new URL(request.url).searchParams.get("inline") === "1"
    ? processingResultStream(id)
    : processingResultRedirect(id);
}
