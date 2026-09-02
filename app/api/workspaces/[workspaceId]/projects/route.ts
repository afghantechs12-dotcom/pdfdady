import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getWorkspaceActor, mapWorkspaceError, requireSameOrigin, workspaceError, workspaceServices } from "@/src/application/services/workspaceHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  organizationId: z.string().min(1),
  name: z.string().min(1).max(120),
  slug: z.string().max(80).optional(),
  description: z.string().max(2000).nullable().optional(),
});

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const actorResult = await getWorkspaceActor(request, request.nextUrl.searchParams.get("organizationId") ?? undefined);
  if ("response" in actorResult) return actorResult.response;
  try {
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? 25);
    const result = await workspaceServices().projects.list(
      actorResult.actor,
      workspaceId,
      request.nextUrl.searchParams.get("cursor") ?? undefined,
      Number.isInteger(limit) ? limit : 25,
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return mapWorkspaceError(request, error); }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const { workspaceId } = await params;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return workspaceError(request, "INVALID_INPUT", "Invalid project input.", 422);
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;
  try {
    const project = await workspaceServices().projects.create(actorResult.actor, workspaceId, parsed.data);
    workspaceServices().audit.record({ actorType: "user", actorId: actorResult.actor.userId, organizationId: actorResult.actor.organizationId, action: "project.create", resourceType: "project", resourceId: project.id }).catch(() => {});
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) { return mapWorkspaceError(request, error); }
}
