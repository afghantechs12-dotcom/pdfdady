import { NextResponse } from "next/server";
import { getServerToolConfigMerged } from "@/data/admin";
import { getProcessor } from "@/lib/server/toolProcessing";
import {
  submitToolJob,
  UploadValidationError,
  UsageLimitError,
} from "@/lib/server/toolJobSubmit";
import { usageLimitResponse } from "@/lib/server/usageLimitResponse";
import { resolveJobActor } from "@/lib/server/jobActor";
import { acquireSlot, TooBusyError } from "@/lib/server/concurrency";
import { multipartToolResponse } from "@/lib/server/multipart";
import { RateLimiter, clientIp } from "@/lib/server/rateLimit";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { IObjectStorage } from "@/src/application/ports/storage/ObjectStorage";
import type { PdfToolJobService } from "@/src/application/services/PdfToolJobService";
import { toolErrorMessage, type ToolJobErrorType } from "@/lib/tools/jobError";
import { attachmentDisposition } from "@/src/application/services/documentContent";

// API tools require Node APIs (child process, fs), so force the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-IP rate limit on the unauthenticated public tool API. Default 20
// requests/minute/IP; tune via TOOLS_RATE_LIMIT_PER_MIN. Single-instance guard
// — behind multiple instances enforce at the load balancer / Redis too (M2).
const RATE_WINDOW_MS = 60_000;
const parsedRateMax = Number(process.env.TOOLS_RATE_LIMIT_PER_MIN);
const rateMax = Number.isInteger(parsedRateMax) && parsedRateMax > 0 ? parsedRateMax : 20;
const toolLimiter = new RateLimiter({ windowMs: RATE_WINDOW_MS, max: rateMax });

// Hard cap on the total request body size, checked from Content-Length BEFORE
// the multipart body is buffered into memory. Bounds the worst-case memory
// used by a single request; the per-file limit in validateUpload remains the
// authoritative check. Default 110MB; tune via TOOLS_MAX_BODY_BYTES.
const parsedMaxBody = Number(process.env.TOOLS_MAX_BODY_BYTES);
const MAX_BODY_BYTES =
  Number.isFinite(parsedMaxBody) && parsedMaxBody > 0
    ? parsedMaxBody
    : 110 * 1024 * 1024;

// Map a categorized tool-job failure to the legacy HTTP status. The handler
// recorded the category in job.result.errorType; the message is in job.error.
// The user-facing message comes from the shared toolErrorMessage map (same one
// the client uses) so the two can't drift. Status mapping is HTTP-specific and
// stays here.
const TOOL_ERROR_STATUS: Record<ToolJobErrorType, number> = {
  "missing-dependency": 503,
  processing: 422,
  command: 422,
  unexpected: 500,
};

function failureResponse(
  errorType: ToolJobErrorType | null,
  message: string | null,
): NextResponse {
  const type: ToolJobErrorType = errorType ?? "unexpected";
  return NextResponse.json(
    { error: toolErrorMessage(type, message) },
    { status: TOOL_ERROR_STATUS[type] },
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const config = await getServerToolConfigMerged(slug);
  const processor = getProcessor(slug);

  if (!config || !processor) {
    return NextResponse.json(
      { error: "This tool does not support server processing." },
      { status: 404 },
    );
  }

  // Rate limit BEFORE any heavy work.
  if (toolLimiter.hit(clientIp(request))) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down and try again shortly." },
      { status: 429, headers: { "Retry-After": "10" } },
    );
  }

  // Reject oversized bodies BEFORE buffering the multipart payload.
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Upload too large." }, { status: 413 });
  }

  let releaseSlot: (() => void) | null = null;
  try {
    // Acquire the concurrency slot BEFORE buffering the multipart body, so the
    // memory-heavy parse + stage phase is bounded by TOOLS_MAX_CONCURRENCY. The
    // slot is held through the await so legacy concurrency matches the pre-M3
    // behavior (one slot per in-flight conversion).
    releaseSlot = await acquireSlot();

    // This route streams the bytes back on the submitting request and never
    // hands out a job id, so nothing here can be addressed by a second caller.
    // The owner is stamped anyway: it makes "a legacy job row always has an
    // owner" a property of the system rather than of one code path, so the
    // wiring tests can assert it and a future route that DOES return this id
    // inherits a checkable row.
    const actor = await resolveJobActor();

    // Parse + validate + stage the input through M2 storage + enqueue the job.
    // Validation errors (400) surface here; tool failures surface via status.
    const { job } = await submitToolJob({ slug, config, request, actor });

    const jobService =
      appContainer.resolve<PdfToolJobService>(Tokens.PdfToolJobService);
    const status = await jobService.awaitCompletion(job.id);

    if (status.status === "completed" && status.result) {
      // Stream the output straight from storage to the response — the output is
      // never buffered whole in the app server (the pre-M3 readBuffer peak).
      const storage =
        appContainer.resolve<IObjectStorage>(Tokens.ObjectStorage);
      const body = await storage.getStream(status.result.outputKey);
      return new NextResponse(body, {
        status: 200,
        headers: {
          "Content-Type": status.result.mimeType,
          "Content-Disposition": attachmentDisposition(status.result.downloadName),
          "Content-Length": String(status.result.resultSize),
          "X-Original-Size": String(status.result.originalSize),
          "X-Result-Size": String(status.result.resultSize),
          "Cache-Control": "no-store",
        },
      });
    }

    if (status.status === "cancelled") {
      return NextResponse.json(
        { error: "Processing was cancelled." },
        { status: 422 },
      );
    }

    // failed (or timed out without reaching a terminal state).
    return failureResponse(status.errorType, status.error);
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
    // Only reachable in enforce mode — the service raises this exclusively for a
    // decision `shouldBlock` approved, so an observe-mode would-have-denied never
    // becomes a 429. Mapped here and not left to the 500 below because a limit is
    // an answer, not a malfunction: a client that gets 500 retries, and a client
    // that gets 429 with Retry-After waits. Mirrors `/api/jobs`.
    if (err instanceof UsageLimitError) return usageLimitResponse(err);
    return NextResponse.json(
      { error: "Unexpected server error while processing the file." },
      { status: 500 },
    );
  } finally {
    if (releaseSlot) releaseSlot();
  }
}
