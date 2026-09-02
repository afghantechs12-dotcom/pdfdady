import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getWorkspaceActor, mapWorkspaceError, requireSameOrigin, workspaceError, workspaceServices } from "@/src/application/services/workspaceHttp";

export const runtime = "nodejs";
const schema = z.object({ organizationId: z.string().min(1), state: z.enum(["active", "archived", "trashed"]) });

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string; projectId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const { workspaceId, projectId } = await params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return workspaceError(request, "INVALID_INPUT", "State and organizationId required.", 422);
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;
  try {
    const project = await workspaceServices().projects.setLifecycle(actorResult.actor, workspaceId, projectId, parsed.data.state);
    workspaceServices().audit.record({ actorType: "user", actorId: actorResult.actor.userId, organizationId: actorResult.actor.organizationId, action: `project.${parsed.data.state}`, resourceType: "project", resourceId: project.id }).catch(() => {});
    return NextResponse.json({ project });
  } catch (error) { return mapWorkspaceError(request, error); }
}
