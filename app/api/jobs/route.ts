import { NextResponse } from "next/server";
import { getServerToolConfigMerged } from "@/data/admin";
import { getProcessor } from "@/lib/server/toolProcessing";
import {
  submitToolJob,
  UploadValidationError,
} from "@/lib/server/toolJobSubmit";
import {
  submitProcessingJob,
  UsageLimitError,
} from "@/lib/server/processingJobSubmit";
import { usageLimitResponse } from "@/lib/server/usageLimitResponse";
import { isProcessingPipelineEnabled } from "@/lib/server/processingPilot";
import { resolveJobActor } from "@/lib/server/jobActor";
import { jobErrorResponse, toStatusResponse } from "@/lib/server/processingJobApi";
import { acquireSlot, TooBusyError } from "@/lib/server/concurrency";
import { multipartToolResponse } from "@/lib/server/multipart";
import { RateLimiter, clientIp } from "@/lib/server/rateLimit";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { ILogger } from "@/src/application/ports/Logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same per-IP rate limit as the synchronous tool route. (Separate limiter
// instance — a determined caller could double their budget across the two
// endpoints; multi-instance enforcement is M2. Bounds the burst either way.)
const RATE_WINDOW_MS = 60_000;
const parsedRateMax = Number(process.env.TOOLS_RATE_LIMIT_PER_MIN);
const rateMax =
  Number.isInteger(parsedRateMax) && parsedRateMax > 0 ? parsedRateMax : 20;
const jobLimiter = new RateLimiter({ windowMs: RATE_WINDOW_MS, max: rateMax });

const parsedMaxBody = Number(process.env.TOOLS_MAX_BODY_BYTES);
const MAX_BODY_BYTES =
  Number.isFinite(parsedMaxBody) && parsedMaxBody > 0
    ? parsedMaxBody
    : 110 * 1024 * 1024;

/**
 * Async tool-job submission: stage the input through M2 storage, enqueue a
 * `pdf-tool` job, and return its id immediately (HTTP 202). The client then
 * polls GET /api/jobs/[id], streams GET /api/jobs/[id]/progress, cancels via
 * POST /api/jobs/[id]/cancel, and downloads via GET /api/jobs/[id]/download.
 *
 * The concurrency slot is held only for the buffer + stage phase (formData parse
 * + uploadStream) and released before returning — so the connection never waits
 * on processing. Actual processing concurrency is bounded by the worker
 * (TOOLS_MAX_CONCURRENCY); the queue absorbs bursts beyond that.
 */
export async function POST(request: Request) {
  const slug = new URL(request.url).searchParams.get("slug");
  if (!slug) {
    return NextResponse.json(
      { error: "Missing `slug` query parameter." },
      { status: 400 },
    );
  }
  const config = await getServerToolConfigMerged(slug);
  const processor = getProcessor(slug);
  if (!config || !processor) {
    return NextResponse.json(
      { error: "This tool does not support server processing." },
      { status: 404 },
    );
  }

  if (jobLimiter.hit(clientIp(request))) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down and try again shortly." },
      { status: 429, headers: { "Retry-After": "10" } },
    );
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Upload too large." }, { status: 413 });
  }

  // Which pipeline serves this request is decided here, once, from the
  // authoritative execution policy plus the pilot flag — not from anything the
  // client sent. Flag off (or any failure resolving it) means the legacy path,
  // which is the code already running in production.
  const useUnifiedPipeline = await isProcessingPipelineEnabled(slug);

  let releaseSlot: (() => void) | null = null;
  try {
    // Bound the upload memory, then release before returning — the queue holds
    // the work, not the connection.
    releaseSlot = await acquireSlot();

    // Ownership is resolved from the session cookie on the server. The request
    // body cannot influence who owns the job. Resolved once, above the branch,
    // because BOTH pipelines need it: a legacy row created without an owner is a
    // row no ownership check can ever admit, which is exactly how the legacy
    // endpoints came to serve anyone's job to anyone.
    const actor = await resolveJobActor();

    if (useUnifiedPipeline) {
      const { view, deduplicated } = await submitProcessingJob({
        slug,
        config,
        request,
        actor,
      });
      return NextResponse.json(
        { jobId: view.jobId, job: toStatusResponse(view), deduplicated },
        {
          // 200 for a replayed idempotency key, 202 for newly accepted work: a
          // client retrying after a dropped response can tell that its first
          // attempt landed rather than assuming it needs to submit again.
          status: deduplicated ? 200 : 202,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    const { job } = await submitToolJob({ slug, config, request, actor });
    return NextResponse.json({ jobId: job.id }, { status: 202 });
  } catch (err) {
    // The shared multipart boundary: 400 for a body that cannot be parsed, 413 for
    // one that exceeded the ceiling mid-stream. First, because both are the
    // client's error and neither is a malfunction to log.
    const multipart = multipartToolResponse(err);
    if (multipart) return multipart;
    if (err instanceof TooBusyError) {
      return NextResponse.json(
        { error: err.message },
        { status: 503, headers: { "Retry-After": "15" } },
      );
    }
    if (err instanceof UploadValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    // Only reachable in enforce mode: the service raises this exclusively for a
    // decision `shouldBlock` approved, so an observe-mode would-have-denied
    // never becomes a 429.
    if (err instanceof UsageLimitError) return usageLimitResponse(err);
    if (useUnifiedPipeline) return jobErrorResponse(err);
    // Logged for the same reason as `jobErrorResponse`'s 500: the caller gets a
    // deliberately vague message, so if nothing is written here the fault is
    // invisible to the operator. Slug and error only — never the filename.
    appContainer.resolve<ILogger>(Tokens.Logger).error("job.submit.unhandled", {
      slug,
      errorName: err instanceof Error ? err.name : typeof err,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Unexpected server error while submitting the job." },
      { status: 500 },
    );
  } finally {
    if (releaseSlot) releaseSlot();
  }
}
