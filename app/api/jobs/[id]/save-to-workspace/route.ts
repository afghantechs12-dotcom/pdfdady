import { NextResponse, type NextRequest } from "next/server";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { IObjectStorage } from "@/src/application/ports/storage/ObjectStorage";
import type { IWorkspaceAwareUploadService } from "@/src/application/ports/workspace/WorkspaceAwareUploadService";
import type { PdfToolJobService } from "@/src/application/services/PdfToolJobService";
import { DOCUMENT_INGESTION_LIMITS } from "@/src/domain/entities/DocumentIngestion";
import { resolveJobActor } from "@/lib/server/jobActor";
import {
  isProcessingJob,
  jobErrorResponse,
  legacyJobAccessDenied,
  loadJobRow,
  processingJobService,
} from "@/lib/server/processingJobApi";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requireSameOrigin,
  workspaceError,
  workspaceServices,
} from "@/src/application/services/workspaceHttp";
import { ensureWorkerReady } from "@/src/infrastructure/jobs/workerBootstrap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/jobs/:id/save-to-workspace — a cloud result becomes a Workspace
 * document, without the bytes passing through the browser.
 *
 * WHY SERVER-TO-SERVER. The alternative is what the local tools do: download the
 * result, then upload it. For a server job that means the same object crosses the
 * network twice for no reason, and the download half depends on a signed URL with
 * a TTL — a large output on a slow connection could have its URL expire partway
 * through the save, which is a failure mode the user can do nothing about. Here
 * the bytes go from PDFDadi's own storage into PDFDadi's own upload service and
 * the signed URL is never minted.
 *
 * TWO INDEPENDENT AUTHORIZATIONS, and both are required:
 *
 *  1. **The job.** `resolveSavableOutput` resolves the caller with
 *     `resolveJobActor` and then refuses a job that actor does not own, is not
 *     completed, or has expired — via `ProcessingJobService.getResult` for a
 *     pipeline job and via `legacyJobAccessDenied` + `PdfToolJobService.getStatus`
 *     for a legacy one, which are the same two gates the legacy download uses. So
 *     a job id copied from someone else's session cannot be saved anywhere, in
 *     either shape, and a signed output URL is not accepted as evidence of
 *     anything (this route takes no URL at all).
 *  2. **The destination.** `getWorkspaceActor` re-resolves the caller's
 *     organization and membership, and `uploadToWorkspace` validates the
 *     Workspace inside the application service. The client names a `workspaceId`,
 *     so the client is not trusted about it: what the client sends is a request,
 *     not a grant.
 *
 * The two are checked separately because they are separate facts. Owning a job
 * does not grant access to a Workspace, and being a Workspace member does not
 * grant access to a stranger's job. Passing one and failing the other must fail.
 *
 * No new persistence path: the write is `uploadToWorkspace`, the same application
 * service the Workspace upload route and the editor's first save use, so this
 * route inherits its destination validation, ingestion, save-intent identity and
 * ceilings rather than restating any of them.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return workspaceError(request, "INVALID_INPUT", "Expected a JSON body.", 415);
  }

  const body = (await request.json().catch(() => null)) as {
    workspaceId?: unknown;
    organizationId?: unknown;
    saveIntentKey?: unknown;
  } | null;
  const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
  if (!workspaceId) {
    return workspaceError(request, "INVALID_INPUT", "A `workspaceId` is required.", 422);
  }
  const organizationId =
    typeof body?.organizationId === "string" && body.organizationId.trim()
      ? body.organizationId.trim()
      : undefined;
  /*
   * The client's save INTENTION. Opaque, and not authorization: the two checks
   * below still run in full, and the key is only consulted afterwards, inside the
   * actor's own scope. `sourceIdentity` is the job id rather than anything the
   * client says about the job, so a key minted for one result cannot be presented
   * for another — it is a typed conflict, not a second document.
   */
  const saveIntentKey = typeof body?.saveIntentKey === "string" ? body.saveIntentKey : null;

  const { id } = await params;
  const row = await loadJobRow(id);

  // Job authorization first: an unauthorized caller must not learn anything about
  // the destination, and a 404 here is indistinguishable from an unknown job.
  const resolved = await resolveSavableOutput(id, row);
  if (resolved instanceof NextResponse) return resolved;
  const output = resolved;

  /*
   * Only a PDF. The editor and the Workspace both treat a document as a PDF, and
   * `pdf-to-jpg`-style output is an archive of several files — storing that as one
   * "document" would be a lie about what the user has. The capability record hides
   * the button for those tools; this is the server-side half of the same rule,
   * because a hidden button is not an authorization check.
   */
  if (output.mimeType !== "application/pdf") {
    return workspaceError(
      request,
      "UNSUPPORTED_OUTPUT",
      "This result is not a PDF, so it cannot be stored as a Workspace document.",
      415,
    );
  }
  if (output.bytes > DOCUMENT_INGESTION_LIMITS.maxUploadBytes) {
    return workspaceError(request, "PAYLOAD_TOO_LARGE", "This result is too large to store.", 413);
  }

  const actorResult = await getWorkspaceActor(request, organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    ensureWorkerReady();
    const storage = appContainer.resolve<IObjectStorage>(Tokens.ObjectStorage);
    const data = await storage.get(output.key);

    const uploads = appContainer.resolve<IWorkspaceAwareUploadService>(
      Tokens.WorkspaceAwareUploadService,
    );
    const result = await uploads.uploadToWorkspace(actorResult.actor, workspaceId, {
      ownerType: "org",
      ownerId: actorResult.actor.organizationId,
      data,
      mimeType: output.mimeType,
      // The name the naming policy already produced for the download, so the
      // Workspace document and the downloaded file are called the same thing.
      originalName: output.downloadName,
      name: output.downloadName,
      saveIntent: saveIntentKey
        ? { key: saveIntentKey, sourceKind: "processing-job", sourceIdentity: id }
        : null,
    });

    /*
     * ONE event per logical save. A deduplicated response means this result is
     * already stored — the retry after a lost response is the case this exists for,
     * and it must not add a second "uploaded X" line about the same document.
     */
    if (!result.deduplicated) {
      workspaceServices()
        .audit.record({
          actorType: "user",
          actorId: actorResult.actor.userId,
          organizationId: actorResult.actor.organizationId,
          action: "document.upload",
          resourceType: "document_record",
          resourceId: result.document.id,
          metadata: {
            documentName: result.document.name,
            // The tool, for the activity line. Never the document's contents.
            toolSlug: row?.toolSlug ?? null,
          },
        })
        .catch(() => {});
    }

    return NextResponse.json(result, {
      status: result.deduplicated ? 200 : 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

/**
 * The four facts this route needs about a finished job's output, from whichever
 * of the two job shapes it is — and the same dispatch, in the same order, that
 * `/api/jobs/:id/download` already performs.
 *
 * WHY THIS EXISTS. The route used to answer `404 "Job not found."` to every job
 * whose `type` is not `processing`, while `ServerToolRunner` — the result surface
 * for every server tool that is NOT the pipeline pilot — rendered
 * `Save to Workspace` and posted here anyway (`saveJobResultToWorkspace`, whose
 * own docstring names both surfaces). So the button was offered on eleven tools
 * and could not succeed on ten of them in ANY configuration, nor on the eleventh
 * in the shipped default one: `isProcessingPipelineEnabled` returns false for
 * every slug but `compress-pdf`, and false for that one too unless
 * `PROCESSING_PIPELINE=on` or a `unified_processing_pipeline` flag row says
 * otherwise, which no deployment file sets. A completed `pdf-tool` job whose
 * output was a stored PDF answered 404 to the exact request the button sends.
 * Phase 5's workflow probe passed 155/156 because its journey C exercises the one
 * pilot slug with the flag on.
 *
 * The legacy branch adds no new authority. `legacyJobAccessDenied` is the same
 * ownership gate the legacy download uses, `PdfToolJobService.getStatus` is the
 * same completion check, and everything after this function — the PDF rule, the
 * ceiling, the Workspace actor, `storage.get`, `uploadToWorkspace` — is shared,
 * so the two shapes converge before anything is written. The bytes still never
 * pass through the browser: a legacy job's output is a storage key too.
 */
async function resolveSavableOutput(
  id: string,
  row: Awaited<ReturnType<typeof loadJobRow>>,
): Promise<{ key: string; mimeType: string; bytes: number; downloadName: string } | NextResponse> {
  if (isProcessingJob(row)) {
    try {
      const jobActor = await resolveJobActor();
      const { output } = await processingJobService().getResult(id, jobActor);
      return output;
    } catch (err) {
      return jobErrorResponse(err);
    }
  }

  const denied = await legacyJobAccessDenied(row);
  if (denied) return denied;

  const status = await appContainer
    .resolve<PdfToolJobService>(Tokens.PdfToolJobService)
    .getStatus(id);
  if (!status) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  if (status.status !== "completed" || !status.result) {
    // The same 409 the legacy download answers for a job with no output yet, so a
    // client polling one endpoint and saving through the other reads one story.
    return NextResponse.json(
      { error: "Job output is not available.", status: status.status },
      { status: 409 },
    );
  }
  return {
    key: status.result.outputKey,
    mimeType: status.result.mimeType,
    bytes: status.result.resultSize,
    downloadName: status.result.downloadName,
  };
}
