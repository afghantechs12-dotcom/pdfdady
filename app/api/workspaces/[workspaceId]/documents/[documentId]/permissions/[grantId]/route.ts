import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requireSameOrigin,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import {
  commentService,
  toDocumentPermissionGrantResponse,
} from "@/src/application/services/commentHttp";
import { COLLABORATION_LIMITS as L } from "@/src/domain/entities/Collaboration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
});

/**
 * Revokes a share.
 *
 * Takes effect on the next authorization call rather than at the next login:
 * every collaboration operation re-reads grants, so there is no cached decision
 * to wait out.
 */
export async function DELETE(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ workspaceId: string; documentId: string; grantId: string }> },
) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, documentId, grantId } = await params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "organizationId is required.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const grant = await commentService().revokeGrant(
      actorResult.actor,
      workspaceId,
      documentId,
      grantId,
    );
    return NextResponse.json({ grant: toDocumentPermissionGrantResponse(grant) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
