import { NextResponse, type NextRequest } from "next/server";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { IObjectStorage } from "@/src/application/ports/storage/ObjectStorage";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requestId,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import { versionService } from "@/src/application/services/versionHttp";
import { pageDocumentService } from "@/src/application/services/workspacePageData";
import type { DocumentIngestionRepository } from "@/src/application/ports/workspaces/DocumentIngestionRepository";
import {
  contentDisposition,
  contentHeaders,
  parseContentRequest,
  preparationFromIngestion,
  resolveDocumentContent,
  type ContentPreparation,
} from "@/src/application/services/documentContent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The ingestion index, used only to explain *why* content is unavailable. */
function ingestionRepository(): DocumentIngestionRepository {
  return appContainer.resolve<DocumentIngestionRepository>(Tokens.DocumentIngestionRepository);
}

/**
 * Streams a document's PDF bytes to an authorized caller.
 *
 * This is the route the Workspace editor loads a document through, and it is
 * the only path by which a client can cause document bytes to be read. Its
 * shape follows from that:
 *
 * - The caller names a *document* (and optionally a version *number*), never a
 *   storage key. The key comes from the version manifest the service returned,
 *   so a forged or guessed key cannot reach the store.
 * - Authorization runs through `VersionService`, which resolves the document
 *   inside the actor's Workspace and reports a foreign document as missing
 *   rather than forbidden — the distinction would itself disclose existence.
 * - Response keys are never echoed. The client learns the version number and
 *   the content checksum, both of which it needs and neither of which says
 *   where bytes live.
 * - A document with no usable stored artifact returns a bounded, honest error.
 *   It does not fall back to an autosave draft (mutable per-device recovery
 *   state is not a durable version) and does not synthesize an empty PDF.
 * - `private, no-store` caching: these are tenant bytes behind authorization.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; documentId: string }> },
) {
  const { workspaceId, documentId } = await params;

  const parsed = parseContentRequest(request.nextUrl.searchParams);
  if (!parsed.ok) {
    return workspaceError(request, "INVALID_INPUT", parsed.message, 422);
  }

  const actorResult = await getWorkspaceActor(request, parsed.organizationId);
  if ("response" in actorResult) return actorResult.response;
  const { actor } = actorResult;

  try {
    const versions = versionService();
    // Both paths authorize inside the service before returning anything.
    const version =
      parsed.versionNumber === null
        ? await versions.getLatestVersion(actor, workspaceId, documentId)
        : await versions.getVersion(actor, workspaceId, documentId, parsed.versionNumber);

    const resolution = resolveDocumentContent({ documentId, version, artifact: parsed.artifact });
    if (!resolution.ok) {
      // A document with no servable bytes is either mid-preparation or broken,
      // and the client must be able to tell which: one is worth waiting for and
      // the other never resolves. The ingestion row is the authority on that,
      // and only its *state* is reported — never a key, size or checksum.
      let preparation: ContentPreparation = "none";
      let detail: string | null = null;
      try {
        const ingestion = await ingestionRepository().getByDocumentId(workspaceId, documentId);
        preparation = preparationFromIngestion(ingestion?.status ?? null);
        // The stored reason is already bounded and non-disclosing by
        // construction (see DocumentIngestionService).
        if (preparation === "failed") detail = ingestion?.failureReason ?? null;
      } catch {
        // The honest error below does not depend on this lookup, so a failure
        // here degrades the hint rather than the response.
      }

      return NextResponse.json(
        {
          error: {
            code: "CONTENT_UNAVAILABLE",
            message: resolution.message,
            requestId: requestId(request),
            preparation,
            ...(detail ? { detail } : {}),
          },
        },
        { status: resolution.status, headers: { "Cache-Control": "no-store" } },
      );
    }

    /*
     * The record is read for its REVISION, which the editor uses as its
     * compare-and-swap token (see `contentHeaders`) — and, when this is a
     * download, for the name that labels it. One read serves both; a name the
     * caller is already authorized to see, and a counter that says nothing about
     * the document's contents.
     */
    const document = await pageDocumentService().get(actor, workspaceId, documentId);
    const disposition =
      parsed.disposition === "attachment"
        ? contentDisposition("attachment", document.name)
        : "inline";

    const storage = appContainer.resolve<IObjectStorage>(Tokens.ObjectStorage);
    /*
     * A materialized output has no recorded length in the manifest, so the STORE
     * is asked for it. A failed head degrades to "no Content-Length" rather than
     * to a guess: the response still streams, the browser just cannot show a
     * progress bar. Quoting the source's length for the output would truncate the
     * download at the wrong byte.
     */
    let byteSize = resolution.byteSize;
    if (byteSize === null) {
      const head = await storage.head(resolution.sourceKey).catch(() => null);
      byteSize = head?.exists && typeof head.size === "number" ? head.size : null;
    }
    const stream = await storage.getStream(resolution.sourceKey);

    return new NextResponse(stream as ReadableStream, {
      status: 200,
      headers: contentHeaders({
        byteSize,
        disposition,
        versionNumber: resolution.versionNumber,
        documentRevision: document.revision,
      }),
    });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
