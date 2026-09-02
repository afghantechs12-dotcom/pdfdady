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
 * What this build can do with a document's embedded PDF structures.
 *
 * Reported as uninspected for every document in this release: no PDF parsing
 * runs here, so claiming a field count or an outline would be inventing it.
 * The limitations list is what a panel shows instead of an empty state, and
 * `writable: { metadata: false, outline: false, attachments: false }` is what
 * prevents a UI from offering an edit button for embedded records.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; documentId: string }> },
) {
  const { workspaceId, documentId } = await params;
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!organizationId || organizationId.length > L.maxIdLength) {
    return workspaceError(request, "INVALID_INPUT", "organizationId is required.", 422);
  }
  const actorResult = await getWorkspaceActor(request, organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const properties = await metadataService().getDocumentProperties(
      actorResult.actor,
      workspaceId,
      documentId,
    );
    return NextResponse.json({ embedded: properties.embedded });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
