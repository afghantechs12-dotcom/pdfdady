import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getWorkspaceActor, mapWorkspaceError, requireSameOrigin, workspaceError, workspaceServices } from "@/src/application/services/workspaceHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const renameSchema = z.object({
  organizationId: z.string().min(1),
  name: z.string().min(1).max(120),
  revision: z.number().int().positive(),
});

const moveSchema = z.object({
  organizationId: z.string().min(1),
  newParentId: z.string().nullable().optional(),
  afterId: z.string().nullable().optional(),
  beforeId: z.string().nullable().optional(),
  revision: z.number().int().positive(),
});

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string; folderId: string }> }) {
  const { workspaceId, folderId } = await params;
  const actorResult = await getWorkspaceActor(request, request.nextUrl.searchParams.get("organizationId") ?? undefined);
  if ("response" in actorResult) return actorResult.response;
  try {
    const folder = await workspaceServices().folders.get(actorResult.actor, workspaceId, folderId);
    return NextResponse.json({ folder });
  } catch (error) { return mapWorkspaceError(request, error); }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ workspaceId: string; folderId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const { workspaceId, folderId } = await params;
  const body = await request.json().catch(() => null);

  if (body && ("newParentId" in body || "afterId" in body || "beforeId" in body)) {
    const parsed = moveSchema.safeParse(body);
    if (!parsed.success) return workspaceError(request, "INVALID_INPUT", "Invalid folder move input.", 422);
    const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
    if ("response" in actorResult) return actorResult.response;
    try {
      const folder = await workspaceServices().folders.move(actorResult.actor, workspaceId, folderId, parsed.data);
      workspaceServices().audit.record({ actorType: "user", actorId: actorResult.actor.userId, organizationId: actorResult.actor.organizationId, action: "folder.move", resourceType: "folder", resourceId: folder.id }).catch(() => {});
      return NextResponse.json({ folder });
    } catch (error) { return mapWorkspaceError(request, error); }
  }

  const parsed = renameSchema.safeParse(body);
  if (!parsed.success) return workspaceError(request, "INVALID_INPUT", "Invalid folder input.", 422);
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;
  try {
    const folder = await workspaceServices().folders.rename(actorResult.actor, workspaceId, folderId, parsed.data.name, parsed.data.revision);
    workspaceServices().audit.record({ actorType: "user", actorId: actorResult.actor.userId, organizationId: actorResult.actor.organizationId, action: "folder.rename", resourceType: "folder", resourceId: folder.id }).catch(() => {});
    return NextResponse.json({ folder });
  } catch (error) { return mapWorkspaceError(request, error); }
}
