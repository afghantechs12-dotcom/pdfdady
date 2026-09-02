import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requireSameOrigin,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import { tagService } from "@/src/application/services/tagHttp";
import { SMART_COLLECTION_LIMITS as L } from "@/src/domain/entities/SmartCollection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Preview is a read: it evaluates a query draft against live data and returns
 * nothing that is stored, so no CSRF check applies. It is still a Workspace
 * read, so membership is authorized the same way an evaluation is.
 */
const previewSchema = z.object({
  organizationId: z.string().min(1),
  query: z.unknown(),
});

/** What a draft query would match right now, without saving it. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  // A POST-shaped read: the collection query goes in the body because the
  // grammar is too large for a URL. Origin evidence is still required, since the
  // preview discloses which documents match.
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId } = await params;
  const parsed = previewSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "Invalid collection query.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  const rawLimit = request.nextUrl.searchParams.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (limit !== undefined && !Number.isFinite(limit)) {
    return workspaceError(request, "INVALID_INPUT", "limit must be a number.", 422);
  }

  try {
    const preview = await tagService().previewSmartCollectionQuery(
      actorResult.actor,
      workspaceId,
      parsed.data.query,
      limit,
    );
    // The cap the grammar applied is reported so the UI can say "100 of 3,412"
    // instead of pretending the list is the whole membership.
    return NextResponse.json({
      documentIds: preview.documentIds,
      total: preview.total,
      limitApplied:
        preview.documentIds.length >= L.maxResults ? L.maxResults : preview.documentIds.length,
    });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
