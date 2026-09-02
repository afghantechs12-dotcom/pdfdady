import { NextResponse, type NextRequest } from "next/server";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import { metadataService, toMetadataResponse } from "@/src/application/services/metadataHttp";
import { METADATA_LIMITS as L } from "@/src/domain/entities/DocumentMetadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Everything the properties panel needs for one document, in one authorized
 * read: the Workspace-owned metadata, what this build established about the
 * PDF's own structures, the record counts and the attachment quota.
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
    return NextResponse.json({
      properties: {
        documentId: properties.documentId,
        metadata: properties.metadata ? toMetadataResponse(properties.metadata) : null,
        embedded: properties.embedded,
        counts: properties.counts,
        attachmentBytes: properties.attachmentBytes,
      },
    });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
