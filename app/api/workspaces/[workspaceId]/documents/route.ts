import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getWorkspaceActor, mapWorkspaceError, requireSameOrigin, workspaceError, workspaceServices } from "@/src/application/services/workspaceHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  organizationId: z.string().min(1),
  name: z.string().min(1).max(255),
  folderId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
});

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const actorResult = await getWorkspaceActor(request, request.nextUrl.searchParams.get("organizationId") ?? undefined);
  if ("response" in actorResult) return actorResult.response;
  try {
    const sp = request.nextUrl.searchParams;
    const view = sp.get("view") as "all" | "favorites" | "recent" | "archived" | "trashed" | null;
    const rawFolderId = sp.get("folderId");
    const folderId = rawFolderId === "null" ? null : rawFolderId ?? undefined;
    // Allowlisted rather than cast: an unrecognized value falls back to the
    // default instead of reaching the query builder as an arbitrary string.
    const rawSortBy = sp.get("sortBy");
    const sortBy = (["name", "createdAt", "updatedAt", "lastAccessedAt"] as const).find(
      (field) => field === rawSortBy,
    );
    const result = await workspaceServices().documents.list(actorResult.actor, workspaceId, {
      folderId,
      projectId: sp.get("projectId") ?? undefined,
      view: view ?? "all",
      sortBy: sortBy ?? "name",
      sortOrder: sp.get("sortOrder") === "desc" ? "desc" : "asc",
      cursor: sp.get("cursor") ?? undefined,
      limit: Number(sp.get("limit") ?? 25),
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return mapWorkspaceError(request, error); }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const { workspaceId } = await params;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return workspaceError(request, "INVALID_INPUT", "Invalid document input.", 422);
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;
  try {
    const document = await workspaceServices().documents.create(actorResult.actor, workspaceId, parsed.data);
    workspaceServices().audit.record({ actorType: "user", actorId: actorResult.actor.userId, organizationId: actorResult.actor.organizationId, action: "document.create", resourceType: "document_record", resourceId: document.id, metadata: { documentName: document.name } }).catch(() => {});
    return NextResponse.json({ document }, { status: 201 });
  } catch (error) { return mapWorkspaceError(request, error); }
}
