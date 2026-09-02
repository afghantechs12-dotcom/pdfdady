import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { SplitViewService, SplitViewState } from "@/src/application/services/SplitViewService";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requireSameOrigin,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import { sessionBelongsToWorkspace, tabService } from "@/src/application/services/sessionHttp";
import { WORKSPACE_SESSION_LIMITS as L } from "@/src/domain/entities/WorkspaceSession";
import { PANE_IDS, SPLIT_VIEW_LIMITS } from "@/src/domain/entities/SplitView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ workspaceId: string }> };

function splitViewService(): SplitViewService {
  return appContainer.resolve<SplitViewService>(Tokens.SplitViewService);
}

/**
 * Projects split state for the client.
 *
 * Tabs are reduced to their identity and title. The full tab payload is already
 * available from the session routes, and repeating it here would mean two
 * differently-shaped copies of the same tab in one client — which is how a pane
 * ends up rendering a stale title.
 *
 * Nothing about *content* crosses this boundary: no PDF bytes, no rendered
 * images, no storage keys, and no history beyond the service's own bounded,
 * in-memory record.
 */
function toSplitViewResponse(state: SplitViewState) {
  return {
    sessionId: state.sessionId,
    layout: state.layout,
    activePane: state.activePane,
    panes: state.panes.map((pane) => ({
      id: pane.id,
      active: pane.active,
      activeTabId: pane.activeTabId,
      tabs: pane.tabs.map((tab) => ({
        id: tab.id,
        documentId: tab.documentId,
        title: tab.title,
      })),
    })),
  };
}

/**
 * Reads the split arrangement for a session.
 *
 * The state is *derived* from the session's tabs rather than stored separately,
 * so this route cannot disagree with the tab routes about what is open.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const { workspaceId } = await params;
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
    const session = await tabService().getWorkspaceSession(actor, sessionId);
    if (!session || !sessionBelongsToWorkspace(session, workspaceId)) {
      return workspaceError(request, "NOT_FOUND", "Session not found.", 404);
    }

    const service = splitViewService();
    const state = await service.getState(actor, sessionId);
    return NextResponse.json({
      split: toSplitViewResponse(state),
      syncMode: service.getSyncMode(sessionId),
    });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

/**
 * Split-view mutations.
 *
 * A closed set of operations rather than a state-replacement endpoint. Accepting
 * a whole arrangement would mean accepting arbitrary client objects into
 * something that decides what a pane renders; naming the operations keeps the
 * server the authority on what a valid arrangement is.
 *
 * Nothing persisted here is unbounded: pane assignment writes a two-valued
 * `paneId` onto a tab through the session service (inheriting its bounds and
 * optimistic concurrency), and sync mode is in-memory only.
 */
const mutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("assign"),
    organizationId: z.string().min(1).max(L.maxIdLength),
    sessionId: z.string().min(1).max(L.maxIdLength),
    tabId: z.string().min(1).max(L.maxIdLength),
    paneId: z.enum(PANE_IDS),
  }),
  z.object({
    action: z.literal("close-pane"),
    organizationId: z.string().min(1).max(L.maxIdLength),
    sessionId: z.string().min(1).max(L.maxIdLength),
    paneId: z.enum(PANE_IDS),
  }),
  z.object({
    action: z.literal("focus"),
    organizationId: z.string().min(1).max(L.maxIdLength),
    sessionId: z.string().min(1).max(L.maxIdLength),
    paneId: z.enum(PANE_IDS),
  }),
  z.object({
    action: z.literal("sync"),
    organizationId: z.string().min(1).max(L.maxIdLength),
    sessionId: z.string().min(1).max(L.maxIdLength),
    mode: z.enum(["off", "scroll", "zoom", "both"]),
  }),
  z.object({
    action: z.literal("navigate"),
    organizationId: z.string().min(1).max(L.maxIdLength),
    sessionId: z.string().min(1).max(L.maxIdLength),
    kind: z.enum(["page", "bookmark", "comment", "search"]),
    pageNumber: z.number().int().min(1).max(SPLIT_VIEW_LIMITS.maxPage),
    targetId: z.string().min(1).max(SPLIT_VIEW_LIMITS.maxIdLength).nullish(),
  }),
  z.object({
    action: z.literal("history"),
    organizationId: z.string().min(1).max(L.maxIdLength),
    sessionId: z.string().min(1).max(L.maxIdLength),
    direction: z.enum(["back", "forward"]),
  }),
]);

export async function POST(request: NextRequest, { params }: Params) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId } = await params;

  const parsed = mutationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "A valid split view request is required.", 422);
  }
  const input = parsed.data;

  const actorResult = await getWorkspaceActor(request, input.organizationId);
  if ("response" in actorResult) return actorResult.response;
  const { actor } = actorResult;

  try {
    const session = await tabService().getWorkspaceSession(actor, input.sessionId);
    if (!session || !sessionBelongsToWorkspace(session, workspaceId)) {
      return workspaceError(request, "NOT_FOUND", "Session not found.", 404);
    }

    const service = splitViewService();
    let state: SplitViewState;

    switch (input.action) {
      case "assign":
        state = await service.assignTabToPane(actor, input.sessionId, input.tabId, input.paneId);
        break;
      case "close-pane":
        state = await service.closePane(actor, input.sessionId, input.paneId);
        break;
      case "focus":
        state = await service.focusPane(actor, input.sessionId, input.paneId);
        break;
      case "sync":
        // Ephemeral by design; the service holds it in memory for the session.
        service.setSyncMode(input.sessionId, input.mode);
        state = await service.getState(actor, input.sessionId);
        break;
      case "navigate":
        // Navigation applies to the *active* pane and is recorded in that
        // pane's bounded, in-memory history.
        state = await service.navigate(actor, input.sessionId, {
          kind: input.kind,
          pageNumber: input.pageNumber,
          targetId: input.targetId ?? null,
        });
        break;
      case "history": {
        const stepped =
          input.direction === "back"
            ? await service.back(actor, input.sessionId)
            : await service.forward(actor, input.sessionId);
        // Null means there was nowhere to go. The current arrangement is
        // returned rather than an error: a disabled-looking back button that
        // 409s is worse than one that does nothing.
        state = stepped ?? (await service.getState(actor, input.sessionId));
        break;
      }
    }

    return NextResponse.json({
      split: toSplitViewResponse(state),
      syncMode: service.getSyncMode(input.sessionId),
    });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
