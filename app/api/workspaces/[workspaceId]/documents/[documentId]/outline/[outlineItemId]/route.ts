import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requireSameOrigin,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import { metadataService, toOutlineItemResponse } from "@/src/application/services/metadataHttp";
import { METADATA_LIMITS as L } from "@/src/domain/entities/DocumentMetadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
  expectedRevision: z.number().int().min(1),
  title: z.string().max(L.maxTitleLength * 2).optional(),
  pageNumber: z.number().optional(),
});

const deleteSchema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
});

type RouteParams = {
  params: Promise<{ workspaceId: string; documentId: string; outlineItemId: string }>;
};

/** Updates a Workspace outline item. Embedded items are refused. */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, documentId, outlineItemId } = await params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "Invalid outline item update.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const updated = await metadataService().updateOutlineItem(
      actorResult.actor,
      workspaceId,
      documentId,
      outlineItemId,
      parsed.data.expectedRevision,
      {
        ...(parsed.data.title === undefined ? {} : { title: parsed.data.title }),
        ...(parsed.data.pageNumber === undefined ? {} : { pageNumber: parsed.data.pageNumber }),
      },
    );
    return NextResponse.json({ outlineItem: toOutlineItemResponse(updated) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

/**
 * Deletes a Workspace outline item and all its descendants.
 *
 * Embedded items are refused: they belong to the PDF and cannot be removed
 * without rewriting the file, which this build does not do.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, documentId, outlineItemId } = await params;
  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "organizationId is required.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const removed = await metadataService().deleteOutlineItem(
      actorResult.actor,
      workspaceId,
      documentId,
      outlineItemId,
    );
    return NextResponse.json({ removed });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
