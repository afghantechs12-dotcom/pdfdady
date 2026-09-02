import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requireSameOrigin,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import { metadataService, toAttachmentResponse } from "@/src/application/services/metadataHttp";
import { METADATA_LIMITS as L } from "@/src/domain/entities/DocumentMetadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
  expectedRevision: z.number().int().min(1),
  name: z.string().max(L.maxAttachmentNameLength * 2).optional(),
  description: z.string().max(L.maxDescriptionLength * 2).nullish(),
});

const deleteSchema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
});

type RouteParams = {
  params: Promise<{ workspaceId: string; documentId: string; attachmentId: string }>;
};

/** Renames or re-describes a Workspace attachment. Embedded attachments are refused. */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, documentId, attachmentId } = await params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "Invalid attachment update.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const updated = await metadataService().updateAttachment(
      actorResult.actor,
      workspaceId,
      documentId,
      attachmentId,
      parsed.data.expectedRevision,
      {
        ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
        ...("description" in parsed.data ? { description: parsed.data.description ?? null } : {}),
      },
    );
    return NextResponse.json({ attachment: toAttachmentResponse(updated) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

/**
 * Deletes a Workspace attachment.
 *
 * Embedded attachments are refused: they belong to the PDF and cannot be
 * removed without rewriting the file.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, documentId, attachmentId } = await params;
  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "organizationId is required.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const removed = await metadataService().deleteAttachment(
      actorResult.actor,
      workspaceId,
      documentId,
      attachmentId,
    );
    return NextResponse.json({ removed });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
