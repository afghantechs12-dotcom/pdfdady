import { NextResponse, type NextRequest } from "next/server";
import {
  getWorkspaceActor,
  mapWorkspaceError,
} from "@/src/application/services/workspaceHttp";
import {
  operationCenterService,
  toOperationResponse,
} from "@/src/application/services/commandHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ workspaceId: string }> };

/**
 * Lists a Workspace's current operations, active first.
 *
 * Every read re-authorizes through the service, and the listing is
 * Workspace-scoped rather than filtered client-side: an operation belonging to
 * another Workspace is not in the response at all, so the endpoint cannot be
 * used to confirm that work exists somewhere the actor cannot see.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const { workspaceId } = await params;
  const organizationId =
    new URL(request.url).searchParams.get("organizationId") ?? undefined;

  const actorResult = await getWorkspaceActor(request, organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const operations = await operationCenterService().list(actorResult.actor, workspaceId);
    return NextResponse.json({ operations: operations.map(toOperationResponse) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
