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
  tabStateInputRejection,
  toSessionResponse,
  toTabStateResponse,
} from "@/src/application/services/sessionHttp";
import { WORKSPACE_SESSION_LIMITS as L } from "@/src/domain/entities/WorkspaceSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ workspaceId: string; tabId: string }> };

/**
 * One open tab: read its view state, update it, activate it, or close it.
 *
 * Every method pins the session to the Workspace in the path before acting, and
 * every mutation is same-origin checked. View state is bounded by
 * `WORKSPACE_SESSION_LIMITS` in the service; this route additionally refuses a
 * payload that names document content or a storage reference, so an attempt to
 * push bytes through the session store fails loudly rather than being silently
 * dropped.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const { workspaceId, tabId } = await params;
  const url = request.nextUrl.searchParams;
  const organizationId = url.get("organizationId") ?? undefined;
  const sessionId = url.get("sessionId");
  if (!sessionId || sessionId.length > L.maxIdLength) {
    return workspaceError(request, "INVALID_INPUT", "sessionId is required.", 422);
  }

  const actorResult = await getWorkspaceActor(request, organizationId);
  if ("response" in actorResult) return actorResult.response;
  const { actor } = actorResult;

  try {
    const service = tabService();
    const session = await service.getWorkspaceSession(actor, sessionId);
    if (!session || !sessionBelongsToWorkspace(session, workspaceId)) {
      return workspaceError(request, "NOT_FOUND", "Session not found.", 404);
    }

    const state = await service.getTabState(actor, sessionId, tabId);
    if (!state) return workspaceError(request, "NOT_FOUND", "Tab not found.", 404);

    return NextResponse.json({ state: toTabStateResponse(state) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

/**
 * Bounded view state. Every field is optional so a scroll update need not
 * restate the selection, and the service merges rather than replaces — an
 * omitted key keeps its stored value instead of being cleared.
 */
const stateSchema = z
  .object({
    activePage: z.number().int().min(1).max(L.maxPage).optional(),
    viewport: z
      .object({
        scale: z.number().min(L.minScale).max(L.maxScale),
        offsetX: z.number().min(-L.maxOffset).max(L.maxOffset),
        offsetY: z.number().min(-L.maxOffset).max(L.maxOffset),
      })
      .optional(),
    tool: z.string().max(L.maxToolLength).optional(),
    selection: z
      .object({
        start: z.number().int().min(0).max(L.maxSelectionOffset),
        end: z.number().int().min(0).max(L.maxSelectionOffset),
      })
      .optional(),
    dirty: z.boolean().optional(),
    conflict: z.boolean().optional(),
    paneId: z.string().max(L.maxIdLength).optional(),
  })
  .strict();

const patchSchema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
  sessionId: z.string().min(1).max(L.maxIdLength),
  /** Present to make this tab the active one. */
  activate: z.boolean().optional(),
  state: stateSchema.optional(),
});

export async function PATCH(request: NextRequest, { params }: Params) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, tabId } = await params;

  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "A valid tab update is required.", 422);
  }
  if (parsed.data.state !== undefined) {
    const rejection = tabStateInputRejection((body as { state: unknown }).state);
    if (rejection) return workspaceError(request, "INVALID_INPUT", rejection, 422);
  }
  if (parsed.data.state === undefined && parsed.data.activate !== true) {
    return workspaceError(request, "INVALID_INPUT", "Nothing to update.", 422);
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

    let updated = session;
    if (parsed.data.activate === true) {
      updated = await service.switchTab(actor, parsed.data.sessionId, tabId);
    }
    if (parsed.data.state !== undefined) {
      updated = await service.updateTabState(actor, parsed.data.sessionId, tabId, parsed.data.state);
    }

    return NextResponse.json({ session: toSessionResponse(updated) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

const closeSchema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
  sessionId: z.string().min(1).max(L.maxIdLength),
});

export async function DELETE(request: NextRequest, { params }: Params) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, tabId } = await params;

  const parsed = closeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "A valid session reference is required.", 422);
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

    const updated = await service.closeTab(actor, parsed.data.sessionId, tabId);
    return NextResponse.json({ session: toSessionResponse(updated) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
