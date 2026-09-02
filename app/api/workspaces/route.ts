import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getWorkspaceActor, mapWorkspaceError, requireSameOrigin, workspaceError, workspaceServices } from "@/src/application/services/workspaceHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({ organizationId: z.string().min(1), name: z.string().min(1).max(120), slug: z.string().max(80).optional(), description: z.string().max(2000).nullable().optional() });

export async function GET(request: NextRequest) {
  const actorResult = await getWorkspaceActor(request, request.nextUrl.searchParams.get("organizationId") ?? undefined);
  if ("response" in actorResult) return actorResult.response;
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 25);
  const result = await workspaceServices().workspaces.list(actorResult.actor, request.nextUrl.searchParams.get("cursor") ?? undefined, Number.isInteger(limit) ? limit : 25);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return workspaceError(request, "INVALID_INPUT", "Invalid Workspace input.", 422);
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;
  try {
    const workspace = await workspaceServices().workspaces.create(actorResult.actor, parsed.data);
    await workspaceServices().audit.record({ actorType: "user", actorId: actorResult.actor.userId, organizationId: actorResult.actor.organizationId, action: "workspace.create", resourceType: "workspace", resourceId: workspace.id });
    return NextResponse.json({ workspace }, { status: 201 });
  } catch (error) { return mapWorkspaceError(request, error); }
}
