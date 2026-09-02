import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getWorkspaceActor, mapWorkspaceError, requireSameOrigin, workspaceError, workspaceServices } from "@/src/application/services/workspaceHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  organizationId: z.string().min(1),
  name: z.string().min(1).max(120),
  parentId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
});

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const actorResult = await getWorkspaceActor(request, request.nextUrl.searchParams.get("organizationId") ?? undefined);
  if ("response" in actorResult) return actorResult.response;
  try {
    const rawParentId = request.nextUrl.searchParams.get("parentId");
    const parentId = rawParentId === "null" ? null : rawParentId ?? null;
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? 50);
    const result = await workspaceServices().folders.list(
      actorResult.actor,
      workspaceId,
      parentId,
      request.nextUrl.searchParams.get("cursor") ?? undefined,
      Number.isInteger(limit) ? limit : 50,
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return mapWorkspaceError(request, error); }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const { workspaceId } = await params;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return workspaceError(request, "INVALID_INPUT", "Invalid folder input.", 422);
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;
  try {
    const folder = await workspaceServices().folders.create(actorResult.actor, workspaceId, parsed.data);
    workspaceServices().audit.record({ actorType: "user", actorId: actorResult.actor.userId, organizationId: actorResult.actor.organizationId, action: "folder.create", resourceType: "folder", resourceId: folder.id }).catch(() => {});
    return NextResponse.json({ folder }, { status: 201 });
  } catch (error) { return mapWorkspaceError(request, error); }
}
