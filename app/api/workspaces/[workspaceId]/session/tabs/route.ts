import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requireSameOrigin,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import {
  sessionBelongsToWorkspace,
  tabService,
  toSessionResponse,
  toTabResponse,
} from "@/src/application/services/sessionHttp";
import { WORKSPACE_SESSION_LIMITS as L } from "@/src/domain/entities/WorkspaceSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ workspaceId: string }> };

/**
 * Opens a document in a new tab, or reorders the open tabs.
 *
 * Both are session mutations, so both are same-origin checked. The session is
 * pinned to the Workspace in the path before anything is done with it: a user
 * owns sessions in every Workspace they belong to, and without that check a
 * request to this Workspace's URL could drive another one's session.
 *
 * A tab is a logical reference — document id, version id, title. No bytes, no
 * data URLs, no page images and no storage keys are accepted or returned.
 */
const openSchema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
  sessionId: z.string().min(1).max(L.maxIdLength),
  documentId: z.string().min(1).max(L.maxIdLength),
  versionId: z.string().min(1).max(L.maxIdLength),
  title: z.string().min(1).max(L.maxTitleLength),
});

export async function POST(request: NextRequest, { params }: Params) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId } = await params;

  const parsed = openSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "A valid tab request is required.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;
  const { actor } = actorResult;

  try {
    const service = tabService();
    const session = await service.getWorkspaceSession(actor, parsed.data.sessionId);
    if (!session || !sessionBelongsToWorkspace(session, workspaceId)) {
      return workspaceError(request, "NOT_FOUND", "Session not found.", 404);
    }

    const result = await service.createTab(
      actor,
      parsed.data.sessionId,
      parsed.data.documentId,
      parsed.data.versionId,
      parsed.data.title,
    );
    return NextResponse.json(
      { tab: toTabResponse(result.tab), session: toSessionResponse(result.session) },
      { status: 201 },
    );
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

const reorderSchema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
  sessionId: z.string().min(1).max(L.maxIdLength),
  // Bounded to the session's own tab cap. The service additionally requires the
  // list to name every open tab exactly once.
  orderedTabIds: z.array(z.string().min(1).max(L.maxIdLength)).min(1).max(L.maxTabs),
});

export async function PATCH(request: NextRequest, { params }: Params) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId } = await params;

  const parsed = reorderSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "A valid tab order is required.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;
  const { actor } = actorResult;

  try {
    const service = tabService();
    const session = await service.getWorkspaceSession(actor, parsed.data.sessionId);
    if (!session || !sessionBelongsToWorkspace(session, workspaceId)) {
      return workspaceError(request, "NOT_FOUND", "Session not found.", 404);
    }

    const updated = await service.reorderTabs(actor, parsed.data.sessionId, parsed.data.orderedTabIds);
    return NextResponse.json({ session: toSessionResponse(updated) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
