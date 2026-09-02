import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getWorkspaceActor, mapWorkspaceError, requireSameOrigin, workspaceError, workspaceServices } from "@/src/application/services/workspaceHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({
  organizationId: z.string().min(1),
  name: z.string().min(1).max(255).optional(),
  revision: z.number().int().positive(),
});

const moveSchema = z.object({
  organizationId: z.string().min(1),
  targetFolderId: z.string().nullable().optional(),
  afterId: z.string().nullable().optional(),
  beforeId: z.string().nullable().optional(),
  revision: z.number().int().positive(),
});

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string; documentId: string }> }) {
  const { workspaceId, documentId } = await params;
  const actorResult = await getWorkspaceActor(request, request.nextUrl.searchParams.get("organizationId") ?? undefined);
  if ("response" in actorResult) return actorResult.response;
  try {
    const document = await workspaceServices().documents.get(actorResult.actor, workspaceId, documentId);
    return NextResponse.json({ document });
  } catch (error) { return mapWorkspaceError(request, error); }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ workspaceId: string; documentId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const { workspaceId, documentId } = await params;
  const body = await request.json().catch(() => null);

  if (body && ("targetFolderId" in body || "afterId" in body || "beforeId" in body)) {
    const parsed = moveSchema.safeParse(body);
    if (!parsed.success) return workspaceError(request, "INVALID_INPUT", "Invalid document move input.", 422);
    const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
    if ("response" in actorResult) return actorResult.response;
    try {
      const document = await workspaceServices().documents.move(actorResult.actor, workspaceId, documentId, parsed.data);
      workspaceServices().audit.record({ actorType: "user", actorId: actorResult.actor.userId, organizationId: actorResult.actor.organizationId, action: "document.move", resourceType: "document_record", resourceId: document.id, metadata: { documentName: document.name } }).catch(() => {});
      return NextResponse.json({ document });
    } catch (error) { return mapWorkspaceError(request, error); }
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return workspaceError(request, "INVALID_INPUT", "Invalid document input.", 422);
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;
  try {
    const document = await workspaceServices().documents.rename(actorResult.actor, workspaceId, documentId, parsed.data.name ?? "", parsed.data.revision);
    workspaceServices().audit.record({ actorType: "user", actorId: actorResult.actor.userId, organizationId: actorResult.actor.organizationId, action: "document.rename", resourceType: "document_record", resourceId: document.id, metadata: { documentName: document.name } }).catch(() => {});
    return NextResponse.json({ document });
  } catch (error) { return mapWorkspaceError(request, error); }
}
