import { NextResponse, type NextRequest } from "next/server";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import { metadataService } from "@/src/application/services/metadataHttp";
import { METADATA_LIMITS as L } from "@/src/domain/entities/DocumentMetadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Streams an attachment for download.
 *
 * Authorization runs before any record is disclosed: the Workspace and document
 * are verified first, then the attachment is resolved within that document.
 * An embedded attachment that was catalogued but never extracted returns a clear
 * error rather than a 404, which would suggest the attachment does not exist.
 *
 * Headers:
 * - `Content-Disposition: attachment` — forces a save dialog; never inline.
 * - `Content-Type` — narrowed by `safeDownloadType`; HTML/SVG become
 *   `application/octet-stream` so they cannot execute on our origin.
 * - `X-Content-Type-Options: nosniff` — prevents the browser from overriding
 *   the narrowed type.
 * - `Content-Length` — from the stored byte count, so the browser can show
 *   progress without buffering the whole response.
 */
export async function GET(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ workspaceId: string; documentId: string; attachmentId: string }> },
) {
  const { workspaceId, documentId, attachmentId } = await params;
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!organizationId || organizationId.length > L.maxIdLength) {
    return workspaceError(request, "INVALID_INPUT", "organizationId is required.", 422);
  }
  const actorResult = await getWorkspaceActor(request, organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const download = await metadataService().getAttachmentDownload(
      actorResult.actor,
      workspaceId,
      documentId,
      attachmentId,
    );

    return new NextResponse(download.stream as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": download.contentType,
        "Content-Disposition": download.contentDisposition,
        "Content-Length": String(download.byteSize),
        "X-Content-Type-Options": "nosniff",
        // Prevent the browser from caching a download that may be revoked.
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
