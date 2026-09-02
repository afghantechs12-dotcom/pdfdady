import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getWorkspaceActor, mapWorkspaceError, requireSameOrigin, workspaceError, workspaceServices } from "@/src/application/services/workspaceHttp";

export const runtime = "nodejs";

const bulkLifecycleSchema = z.object({
  organizationId: z.string().min(1),
  documentIds: z.array(z.string().min(1)).min(1).max(50),
  state: z.enum(["active", "archived", "trashed"]),
});

const bulkMoveSchema = z.object({
  organizationId: z.string().min(1),
  documentIds: z.array(z.string().min(1)).min(1).max(50),
  targetFolderId: z.string().nullable(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const { workspaceId } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return workspaceError(request, "INVALID_INPUT", "Bulk operation body required.", 422);

  if ("state" in body) {
    const parsed = bulkLifecycleSchema.safeParse(body);
    if (!parsed.success) return workspaceError(request, "INVALID_INPUT", "Invalid bulk lifecycle input.", 422);
    const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
    if ("response" in actorResult) return actorResult.response;
    try {
      const result = await workspaceServices().documents.bulkSetLifecycle(actorResult.actor, workspaceId, parsed.data.documentIds, parsed.data.state);
      workspaceServices().audit.record({ actorType: "user", actorId: actorResult.actor.userId, organizationId: actorResult.actor.organizationId, action: "document.bulk_lifecycle", resourceType: "document_record", metadata: { state: parsed.data.state, count: parsed.data.documentIds.length } }).catch(() => {});
      return NextResponse.json(result);
    } catch (error) { return mapWorkspaceError(request, error); }
  }

  if ("targetFolderId" in body) {
    const parsed = bulkMoveSchema.safeParse(body);
    if (!parsed.success) return workspaceError(request, "INVALID_INPUT", "Invalid bulk move input.", 422);
    const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
    if ("response" in actorResult) return actorResult.response;
    try {
      const result = await workspaceServices().documents.bulkMove(actorResult.actor, workspaceId, parsed.data.documentIds, parsed.data.targetFolderId);
      workspaceServices().audit.record({ actorType: "user", actorId: actorResult.actor.userId, organizationId: actorResult.actor.organizationId, action: "document.bulk_move", resourceType: "document_record", metadata: { count: parsed.data.documentIds.length } }).catch(() => {});
      return NextResponse.json(result);
    } catch (error) { return mapWorkspaceError(request, error); }
  }

  return workspaceError(request, "INVALID_INPUT", "Unknown bulk operation.", 422);
}
