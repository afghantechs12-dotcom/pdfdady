import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getWorkspaceActor, mapWorkspaceError, requireSameOrigin, workspaceError, workspaceServices } from "@/src/application/services/workspaceHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({
  organizationId: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  slug: z.string().max(80).optional(),
  description: z.string().max(2000).nullable().optional(),
  status: z.enum(["active", "on_hold", "completed", "cancelled"]).optional(),
  revision: z.number().int().positive(),
});

const moveSchema = z.object({
  organizationId: z.string().min(1),
  afterId: z.string().min(1).nullable().optional(),
  beforeId: z.string().min(1).nullable().optional(),
  revision: z.number().int().positive(),
});

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string; projectId: string }> }) {
  const { workspaceId, projectId } = await params;
  const actorResult = await getWorkspaceActor(request, request.nextUrl.searchParams.get("organizationId") ?? undefined);
  if ("response" in actorResult) return actorResult.response;
  try {
    const project = await workspaceServices().projects.get(actorResult.actor, workspaceId, projectId);
    return NextResponse.json({ project });
  } catch (error) { return mapWorkspaceError(request, error); }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ workspaceId: string; projectId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const { workspaceId, projectId } = await params;
  const body = await request.json().catch(() => null);

  // Distinguish a move request (has afterId/beforeId) from a field update.
  if (body && ("afterId" in body || "beforeId" in body)) {
    const parsed = moveSchema.safeParse(body);
    if (!parsed.success) return workspaceError(request, "INVALID_INPUT", "Invalid project move input.", 422);
    const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
    if ("response" in actorResult) return actorResult.response;
    try {
      const project = await workspaceServices().projects.move(actorResult.actor, workspaceId, projectId, parsed.data);
      workspaceServices().audit.record({ actorType: "user", actorId: actorResult.actor.userId, organizationId: actorResult.actor.organizationId, action: "project.move", resourceType: "project", resourceId: project.id }).catch(() => {});
      return NextResponse.json({ project });
    } catch (error) { return mapWorkspaceError(request, error); }
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return workspaceError(request, "INVALID_INPUT", "Invalid project input.", 422);
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;
  try {
    const project = await workspaceServices().projects.update(actorResult.actor, workspaceId, projectId, parsed.data);
    workspaceServices().audit.record({ actorType: "user", actorId: actorResult.actor.userId, organizationId: actorResult.actor.organizationId, action: "project.update", resourceType: "project", resourceId: project.id }).catch(() => {});
    return NextResponse.json({ project });
  } catch (error) { return mapWorkspaceError(request, error); }
}
