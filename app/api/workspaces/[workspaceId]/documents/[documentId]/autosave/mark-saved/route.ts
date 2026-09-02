import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getWorkspaceActor, mapWorkspaceError, requireSameOrigin, workspaceError } from "@/src/application/services/workspaceHttp";
import { autosaveService, toAutosaveResponse } from "@/src/application/services/autosaveHttp";
import { AUTOSAVE_DRAFT_LIMITS as L } from "@/src/domain/entities/AutosaveDraft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  organizationId: z.string().min(1),
  deviceId: z.string().min(1).max(L.maxDeviceIdLength),
});

/**
 * Marks the calling device's draft as saved, which also releases its write
 * lease. The draft row survives so a later save can reuse it; only the dirty
 * state and the lease are cleared.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string; documentId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const { workspaceId, documentId } = await params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return workspaceError(request, "INVALID_INPUT", "organizationId and deviceId required.", 422);
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;
  try {
    const draft = await autosaveService().markSaved(actorResult.actor, workspaceId, documentId, parsed.data.deviceId);
    return NextResponse.json({ draft: toAutosaveResponse(draft) });
  } catch (error) { return mapWorkspaceError(request, error); }
}
