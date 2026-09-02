import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requireSameOrigin,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import { tagService } from "@/src/application/services/tagHttp";
import { TAG_LIMITS as L } from "@/src/domain/entities/Tag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const id = z.string().min(1).max(L.maxIdLength);

/**
 * Bounded at the edge as well as in the domain: a request larger than the batch
 * cap is rejected before any authorization work happens, and the service bounds
 * it again for callers that do not come through this route.
 */
const bulkSchema = z.object({
  organizationId: z.string().min(1),
  operation: z.enum(["assign", "remove"]),
  documentIds: z.array(id).min(1).max(L.maxBulkDocuments),
  tagIds: z.array(id).min(1).max(L.maxBulkTags),
});

/** Applies or removes several tags across several documents in one call. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId } = await params;
  const parsed = bulkSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "Invalid bulk tag request.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  const input = { documentIds: parsed.data.documentIds, tagIds: parsed.data.tagIds };
  try {
    const service = tagService();
    // The per-document outcome is returned as the service reported it: a batch
    // where some documents failed is a 200 describing exactly which, not a 409
    // that hides the successes.
    const result =
      parsed.data.operation === "assign"
        ? await service.bulkAssignTags(actorResult.actor, workspaceId, input)
        : await service.bulkRemoveTags(actorResult.actor, workspaceId, input);
    return NextResponse.json({ result });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
