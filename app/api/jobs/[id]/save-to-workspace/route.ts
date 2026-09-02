import { NextResponse, type NextRequest } from "next/server";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { IObjectStorage } from "@/src/application/ports/storage/ObjectStorage";
import type { IWorkspaceAwareUploadService } from "@/src/application/ports/workspace/WorkspaceAwareUploadService";
import { DOCUMENT_INGESTION_LIMITS } from "@/src/domain/entities/DocumentIngestion";
import { resolveJobActor } from "@/lib/server/jobActor";
import {
  isProcessingJob,
  jobErrorResponse,
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
 *  1. **The job.** `resolveJobActor` says who is calling and
 *     `ProcessingJobService.getResult` refuses a job that actor does not own, is
 *     not completed, or has expired — the same three gates as the download. So a
 *     job id copied from someone else's session cannot be saved anywhere, and a
 *     signed output URL is not accepted as evidence of anything (this route takes
 *     no URL at all).
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
 * route inherits its destination validation, ingestion, checksum dedup and
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
  } | null;
  const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
  if (!workspaceId) {
    return workspaceError(request, "INVALID_INPUT", "A `workspaceId` is required.", 422);
  }
  const organizationId =
    typeof body?.organizationId === "string" && body.organizationId.trim()
      ? body.organizationId.trim()
      : undefined;

  const { id } = await params;
  const row = await loadJobRow(id);
  if (!isProcessingJob(row)) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }

  // Job authorization first: an unauthorized caller must not learn anything about
  // the destination, and a 404 here is indistinguishable from an unknown job.
  let output;
  try {
    const jobActor = await resolveJobActor();
    ({ output } = await processingJobService().getResult(id, jobActor));
  } catch (err) {
    return jobErrorResponse(err);
  }

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
