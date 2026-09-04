import { NextResponse } from "next/server";

import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { IJobRepository } from "@/src/application/ports/repositories/JobRepository";
import type { IDownloadService } from "@/src/application/ports/storage/DownloadService";
import type { IObjectStorage } from "@/src/application/ports/storage/ObjectStorage";
import type { ILogger } from "@/src/application/ports/Logger";
import { resolveJobActor } from "@/lib/server/jobActor";
import type { Job } from "@/src/domain/entities/Job";
import {
  ProcessingJobService,
  PROCESSING_JOB_TYPE,
  JobConflictError,
  JobNotFoundError,
  type JobView,
} from "@/src/application/services/ProcessingJobService";
import {
  assertActorOwnsJob,
  JobAuthorizationError,
} from "@/src/application/services/jobOwnership";
import { PROGRESS_STAGE_COPY, isProgressStage } from "@/src/domain/jobs/progressStage";
import type { JobStatusResponse } from "@/lib/tools/processingJobStatus";

/** Loads a job row so a route can tell a processing job from a legacy one. */
export async function loadJobRow(id: string): Promise<Job | null> {
  const jobRepo = appContainer.resolve<IJobRepository>(Tokens.JobRepository);
  return jobRepo.get(id);
}

export function isProcessingJob(job: Job | null): boolean {
  return job?.type === PROCESSING_JOB_TYPE;
}

export function processingJobService(): ProcessingJobService {
  return appContainer.resolve<ProcessingJobService>(Tokens.ProcessingJobService);
}

/**
 * Maps a thrown error to a response.
 *
 * `JobAuthorizationError` becomes **404, not 403**. A 403 would confirm that the
 * id exists and belongs to somebody else, which turns the endpoint into an
 * existence oracle: an attacker enumerating ids learns which are real. Answering
 * "not found" to every unauthorized request leaks nothing, and the service
 * already raises the same error for a missing job so the two are
 * indistinguishable from the outside.
 *
 * `JobConflictError` carries a machine-readable `reason` so the client can
 * distinguish "you already used your attempts" from "this failure will never
 * succeed" without parsing prose.
 */
export function jobErrorResponse(err: unknown): NextResponse {
  if (err instanceof JobAuthorizationError || err instanceof JobNotFoundError) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }
  if (err instanceof JobConflictError) {
    return NextResponse.json(
      { error: err.message, reason: err.reason },
      { status: 409 },
    );
  }
  // Anything unclassified is ours, not the caller's, and its message is not
  // safe to echo: it may name a filesystem path, a command, or a host. Which is
  // exactly why it has to be LOGGED — until this line, a 500 from here left no
  // trace anywhere, so the one detail that could explain it was discarded at the
  // only moment it existed. Server-side only, and no user content: the message
  // and error name, never a filename.
  appContainer.resolve<ILogger>(Tokens.Logger).error("job.request.unhandled", {
    errorName: err instanceof Error ? err.name : typeof err,
    errorMessage: err instanceof Error ? err.message : String(err),
  });
  return NextResponse.json(
    { error: "Unexpected server error." },
    { status: 500 },
  );
}

/**
 * Ownership gate for the LEGACY (`pdf-tool` / `pdf-tool-batch`) job branches.
 * Returns a 404 response when the caller does not own the row, or `null` to
 * proceed.
 *
 * The pipeline enforces ownership inside `ProcessingJobService`, which works
 * because every pipeline entry point goes through it. The legacy service cannot:
 * `PdfToolJobService.getStatus`/`awaitCompletion` are also called by
 * `/api/tools/[slug]`, which reads back the job it just created on the SAME
 * request — an actor check down there would reject the submitter. So the legacy
 * gate sits at the route boundary instead, which is precisely where the
 * addressable-by-id risk lives.
 *
 * Takes the already-loaded row rather than an id: every caller has fetched it to
 * decide legacy-vs-pipeline, and re-reading would add a query while opening a
 * window where the row checked is not the row used.
 *
 * A missing row is denied here too, by the same code path — so "no such job" and
 * "not your job" are not merely mapped to the same status, they are the same
 * branch. That is what keeps the endpoint from being an existence oracle even if
 * one of the two answers is later edited.
 *
 * Returning a response instead of throwing keeps the SSE route honest — it must
 * decide before constructing the `ReadableStream`, not from inside it, where a
 * throw would surface as a broken stream rather than a refusal.
 */
export async function legacyJobAccessDenied(
  row: Job | null,
): Promise<NextResponse | null> {
  try {
    if (!row) throw new JobAuthorizationError();
    const actor = await resolveJobActor();
    assertActorOwnsJob(actor, row);
    return null;
  } catch (err) {
    // Any failure here is a denial, including one from resolving the actor. If we
    // cannot establish who is asking, we cannot establish that it is their job.
    return jobErrorResponse(
      err instanceof JobAuthorizationError ? err : new JobAuthorizationError(),
    );
  }
}

/**
 * Projects the service's JobView onto the wire shape.
 *
 * This is the boundary where internal detail stops. `JobView` already excludes
 * storage keys and processor messages; this narrows further to exactly the fields
 * a client renders, so a field added to the domain does not leak by default — it
 * has to be added here deliberately.
 */
export function toStatusResponse(view: JobView): JobStatusResponse {
  const stage = isProgressStage(view.stage) ? view.stage : "preparing";
  const copy = PROGRESS_STAGE_COPY[stage];
  return {
    id: view.jobId,
    toolSlug: view.toolSlug,
    status: view.status,
    stage,
    stageLabel: copy.label,
    progress: Math.round(copy.fraction * 100),
    attempt: view.attempt,
    maxAttempts: view.maxAttempts,
    resultAvailable: view.resultAvailable,
    retryable: view.retryable,
    cancellable: view.cancellable,
    errorCategory: view.errorCategory,
    error: view.errorMessage,
    createdAt: view.createdAt,
    startedAt: view.startedAt,
    finishedAt: view.finishedAt,
    expiresAt: view.expiresAt,
    // Deliberately added, per the comment above: the client renders a size
    // comparison and cannot render what it is never sent.
    inputBytes: view.inputBytes,
    outputBytes: view.outputBytes,
    outputFileName: view.outputFileName,
    outputMimeType: view.outputMimeType,
  };
}

/**
 * The same result, streamed from this origin instead of redirected to storage.
 *
 * Exists for ONE caller: `Open in Editor` on a cloud result. The editor is a
 * browser application, so those bytes have to reach the browser — and the 302
 * above cannot carry them there. A presigned R2 URL is cross-origin, so a
 * `fetch` that followed the redirect would need bucket CORS to be configured for
 * the site's origin, and if it were not the button would fail in production while
 * working in development (where the signed URL is a local route on the same
 * origin). Streaming through this route removes that difference, and keeps the
 * signed URL out of the browser entirely.
 *
 * Download is deliberately NOT changed: it stays a redirect, so the app server
 * remains out of the data path for the action almost every user takes. This path
 * costs a held connection, which is the price of a feature that needs the bytes
 * in the page.
 *
 * Authorization is the same three gates as `processingResultRedirect`, through
 * the same service call — ownership, completion, expiry — because it is the same
 * `getResult`. What it adds is a content-type check: only a PDF is streamed,
 * since the only reason to stream is the editor and the editor opens PDFs.
 */
export async function processingResultStream(id: string): Promise<NextResponse> {
  try {
    const actor = await resolveJobActor();
    const result = await processingJobService().getResult(id, actor);
    if (result.output.mimeType !== "application/pdf") {
      return NextResponse.json(
        { error: "This result is not a PDF." },
        { status: 415 },
      );
    }
    const storage = appContainer.resolve<IObjectStorage>(Tokens.ObjectStorage);
    const stream = await storage.getStream(result.output.key);
    return new NextResponse(stream as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": result.output.mimeType,
        "Content-Length": String(result.output.bytes),
        // Tenant bytes behind authorization, and inline: this response is read by
        // `fetch`, never navigated to, so it must not become a download.
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return jobErrorResponse(err);
  }
}

/**
 * The one implementation of "hand a completed processing job's output to its
 * owner". `/result` and the legacy `/download` path both call it, so there is a
 * single place where the ownership check, the completion check and the signed-URL
 * TTL are decided. Two copies of this would be two places for one of those three
 * to go missing.
 */
export async function processingResultRedirect(id: string): Promise<NextResponse> {
  try {
    const actor = await resolveJobActor();
    const result = await processingJobService().getResult(id, actor);

    const downloads = appContainer.resolve<IDownloadService>(Tokens.DownloadService);
    const dl = await downloads.getUrl(result.output.fileId);
    if (!dl) {
      return NextResponse.json(
        { error: "This result is no longer available. Please run the tool again." },
        { status: 410 },
      );
    }

    return new NextResponse(null, {
      status: 302,
      headers: {
        Location: dl.url,
        // The name is derived server-side from the tool and a sanitized base
        // name; quotes and newlines are stripped so it cannot break the header.
        "Content-Disposition": `attachment; filename="${result.output.downloadName.replace(
          /["\\\r\n]/g,
          "",
        )}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return jobErrorResponse(err);
  }
}
