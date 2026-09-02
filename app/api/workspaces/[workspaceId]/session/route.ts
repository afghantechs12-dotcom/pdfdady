import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requireSameOrigin,
  workspaceError,
  workspaceServices,
} from "@/src/application/services/workspaceHttp";
import {
  sessionBelongsToWorkspace,
  tabService,
  toSessionResponse,
} from "@/src/application/services/sessionHttp";
import { WORKSPACE_SESSION_LIMITS as L } from "@/src/domain/entities/WorkspaceSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ workspaceId: string }> };

/**
 * Returns the actor's workbench session for this Workspace, creating one only
 * when asked to.
 *
 * A GET never creates: the workbench page renders on every navigation, and a
 * read that provisioned would leave a trail of empty sessions behind ordinary
 * browsing. `POST` is the create path, and it is idempotent per
 * (Workspace, user) because the repository's `create` returns the existing row.
 *
 * Payloads carry logical tab references and bounded view state only — never
 * document bytes, data URLs, page images or storage keys.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const { workspaceId } = await params;
  const organizationId = request.nextUrl.searchParams.get("organizationId") ?? undefined;

  const actorResult = await getWorkspaceActor(request, organizationId);
  if ("response" in actorResult) return actorResult.response;
  const { actor } = actorResult;

  try {
    // Establishes that the actor may see this Workspace at all before any
    // session is disclosed.
    await workspaceServices().workspaces.get(actor, workspaceId, false);

    const service = tabService();
    const existing = await service.getWorkspaceSessionForWorkspace(actor, workspaceId);
    if (!existing) return NextResponse.json({ session: null });

    return NextResponse.json({ session: toSessionResponse(existing) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

const createSchema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
});

/** Creates (or returns) the actor's session for this Workspace. */
export async function POST(request: NextRequest, { params }: Params) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId } = await params;

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "organizationId is required.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const session = await tabService().createWorkspaceSession(actorResult.actor, workspaceId);
    return NextResponse.json({ session: toSessionResponse(session) }, { status: 201 });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

const deleteSchema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
  sessionId: z.string().min(1).max(L.maxIdLength),
});

/** Ends a session, closing every tab in it. */
export async function DELETE(request: NextRequest, { params }: Params) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId } = await params;

  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "A valid session reference is required.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;
  const { actor } = actorResult;

  try {
    const service = tabService();
    const session = await service.getWorkspaceSession(actor, parsed.data.sessionId);
    // Absent, unowned and belonging-to-another-Workspace all read the same from
    // outside, which is what keeps this from being a session-existence probe.
    if (!session || !sessionBelongsToWorkspace(session, workspaceId)) {
      return workspaceError(request, "NOT_FOUND", "Session not found.", 404);
    }

    const deleted = await service.deleteWorkspaceSession(actor, parsed.data.sessionId);
    return NextResponse.json({ deleted });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
