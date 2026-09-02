import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getWorkspaceActor, mapWorkspaceError, requireSameOrigin, workspaceError } from "@/src/application/services/workspaceHttp";
import { toVersionResponse, versionService } from "@/src/application/services/versionHttp";
import { DOCUMENT_VERSION_LIMITS as L } from "@/src/domain/entities/DocumentVersion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  organizationId: z.string().min(1),
  expectedRevision: z.number().int().min(0).max(L.maxCounter),
});

type Params = { params: Promise<{ workspaceId: string; documentId: string; versionNumber: string }> };

/**
 * Restores an earlier version.
 *
 * This creates a *new* version carrying the old one's artifacts rather than
 * rewinding the document, so the response is the version that was created — not
 * the one that was restored from.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const { workspaceId, documentId, versionNumber } = await params;
  if (!/^\d{1,10}$/.test(versionNumber)) {
    return workspaceError(request, "INVALID_INPUT", "Invalid version number.", 422);
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "organizationId and expectedRevision are required.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const version = await versionService().restoreVersion(
      actorResult.actor,
      workspaceId,
      documentId,
      Number(versionNumber),
      parsed.data.expectedRevision,
    );
    return NextResponse.json({ version: toVersionResponse(version) });
  } catch (error) { return mapWorkspaceError(request, error); }
}
