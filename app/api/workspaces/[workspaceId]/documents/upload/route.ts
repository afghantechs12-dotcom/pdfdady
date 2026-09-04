import { NextResponse, type NextRequest } from "next/server";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { IWorkspaceAwareUploadService } from "@/src/application/ports/workspace/WorkspaceAwareUploadService";
import { DOCUMENT_INGESTION_LIMITS } from "@/src/domain/entities/DocumentIngestion";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  workspaceError,
  workspaceServices,
} from "@/src/application/services/workspaceHttp";
import { workspaceUploadGate } from "@/lib/server/workspaceUploadGate";
import { ensureWorkerReady } from "@/src/infrastructure/jobs/workerBootstrap";
import type { SaveIntentRequest } from "@/src/domain/entities/WorkspaceSaveIntent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Optional text fields accompanying the file part. */
function optionalField(form: FormData, name: string): string | null {
  const value = form.get(name);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null") return null;
  return trimmed;
}

/**
 * The save intention this request carries, or null.
 *
 * `saveIntentSource` says which local result the key was minted for. It defaults
 * to a constant rather than to the filename: a name is renamed, retyped and
 * shared, so inferring identity from it would make two unrelated saves of
 * "document.pdf" look like one intention.
 */
function saveIntent(form: FormData): SaveIntentRequest | null {
  const key = optionalField(form, "saveIntentKey");
  if (key === null) return null;
  return {
    key,
    sourceKind: "local-result",
    sourceIdentity: optionalField(form, "saveIntentSource") ?? "local-result",
  };
}

/**
 * POST /api/workspaces/:workspaceId/documents/upload
 *
 * Accepts `multipart/form-data` with a `file` part plus optional `name`,
 * `folderId`, `projectId`, and `organizationId` fields. Authorization,
 * validation, storage, and ingestion all happen in the upload service — this
 * route only applies the shared upload gate (CSRF, ceiling, media type, session,
 * rate limit, bounded parse) and maps errors to the shared workspace error shape.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  // CSRF, the ceiling, the media type, the session and the rate limit, in that
  // order and none of them touching the body. The service re-checks the real byte
  // length below, since a declared length is client-supplied.
  const gate = await workspaceUploadGate(request, {
    maxBytes: DOCUMENT_INGESTION_LIMITS.maxUploadBytes,
    tooLargeMessage: "Upload too large.",
  });
  if ("response" in gate) return gate.response;
  const form = gate.form;

  const { workspaceId } = await params;

  const file = form.get("file");
  if (!(file instanceof File)) {
    return workspaceError(request, "INVALID_INPUT", "A `file` part is required.", 422);
  }
  if (file.size > DOCUMENT_INGESTION_LIMITS.maxUploadBytes) {
    return workspaceError(request, "PAYLOAD_TOO_LARGE", "Upload too large.", 413);
  }

  const actorResult = await getWorkspaceActor(
    request,
    optionalField(form, "organizationId") ?? undefined,
    gate.sessionUser,
  );
  if ("response" in actorResult) return actorResult.response;

  try {
    // The upload enqueues an ingestion job; this makes sure something is
    // actually draining the queue. Called here rather than at module load so a
    // deployment with no upload traffic runs no background loop, and it is
    // idempotent — repeat calls are no-ops.
    ensureWorkerReady();

    const uploads = appContainer.resolve<IWorkspaceAwareUploadService>(
      Tokens.WorkspaceAwareUploadService,
    );
    const data = Buffer.from(await file.arrayBuffer());
    const result = await uploads.uploadToWorkspace(actorResult.actor, workspaceId, {
      ownerType: "org",
      ownerId: actorResult.actor.organizationId,
      data,
      mimeType: file.type,
      originalName: file.name,
      name: optionalField(form, "name") ?? undefined,
      folderId: optionalField(form, "folderId"),
      projectId: optionalField(form, "projectId"),
      /*
       * The user's save INTENTION, when the client has one.
       *
       * Present for a tool result the user pressed Save on: the same intention
       * retried converges on the document it already made, and the same bytes saved
       * again deliberately become a second document under their own name.
       *
       * Absent for a file-manager upload and for the editor's first save, which
       * keep the content-dedup behaviour they have always had — dragging a file in
       * twice is not two intentions, it is the same file arriving twice.
       *
       * Never authorization: everything above has already resolved the actor and
       * the Workspace, and the key is scoped to that actor inside the service.
       */
      saveIntent: saveIntent(form),
    });

    /*
     * ONE event per logical save, not one per request.
     *
     * A deduplicated response created no document: the bytes were already in this
     * Workspace and the canonical id was handed back. Recording an upload for it
     * would put a second "uploaded X" line in the activity feed for a retry the
     * user cannot even see the effect of — and a retry is exactly what a lost
     * response produces.
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
          /*
           * The NAME, so the activity line can say what was uploaded.
           *
           * "uploaded an item" was the whole of defect E: the dashboard resolved a
           * name by looking the resource id up in the page of documents it happened
           * to have loaded, so anything outside that page — or since renamed, or
           * archived — lost its name. A name recorded WITH the event is the only kind
           * that survives.
           *
           * A name and nothing else. No page text, no form values, no annotation
           * contents: audit metadata is not a place to put document content.
           */
          metadata: { documentName: result.document.name },
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
