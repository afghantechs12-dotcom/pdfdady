import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getWorkspaceActor, mapWorkspaceError, requireSameOrigin, workspaceError, workspaceServices } from "@/src/application/services/workspaceHttp";

const updateSchema = z.object({ organizationId: z.string().min(1), name: z.string().min(1).max(120).optional(), slug: z.string().max(80).optional(), description: z.string().max(2000).nullable().optional(), revision: z.number().int().positive() });
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const actorResult = await getWorkspaceActor(request, request.nextUrl.searchParams.get("organizationId") ?? undefined);
  if ("response" in actorResult) return actorResult.response;
  try { return NextResponse.json(await workspaceServices().workspaces.get(actorResult.actor, workspaceId)); } catch (error) { return mapWorkspaceError(request, error); }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return workspaceError(request, "INVALID_INPUT", "Invalid Workspace settings.", 422);
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;
  try {
    const workspace = await workspaceServices().workspaces.update(actorResult.actor, (await params).workspaceId, parsed.data);
    await workspaceServices().audit.record({ actorType: "user", actorId: actorResult.actor.userId, organizationId: actorResult.actor.organizationId, action: "workspace.update", resourceType: "workspace", resourceId: workspace.id });
    return NextResponse.json({ workspace });
  } catch (error) { return mapWorkspaceError(request, error); }
}
