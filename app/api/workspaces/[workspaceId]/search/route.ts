import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getWorkspaceActor, mapWorkspaceError, requireSameOrigin, workspaceError } from "@/src/application/services/workspaceHttp";
import { searchService, toSearchHitResponse } from "@/src/application/services/searchHttp";
import { SEARCH_LIMITS } from "@/src/domain/entities/SearchIndex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  organizationId: z.string().min(1).max(SEARCH_LIMITS.maxIdLength),
  query: z.string().max(SEARCH_LIMITS.maxQueryLength),
  limit: z.number().int().positive().max(SEARCH_LIMITS.maxResults).optional(),
  cursor: z.string().max(128).optional(),
  filters: z.object({
    lifecycleState: z.enum(["active", "archived", "trashed"]).optional(),
    favorite: z.boolean().optional(),
    projectId: z.string().max(SEARCH_LIMITS.maxIdLength).optional(),
    folderId: z.string().max(SEARCH_LIMITS.maxIdLength).optional(),
    createdById: z.string().max(SEARCH_LIMITS.maxIdLength).optional(),
  }).strict().optional(),
}).strict();

/** Performs an authorized, bounded Workspace search. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  // A POST-shaped read: the body carries the query because a long query does not
  // belong in a URL. Origin evidence is still required — the response discloses
  // which documents exist, and that is worth protecting from a hostile origin
  // even though nothing is written.
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId } = await params;
  const parsed = querySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return workspaceError(request, "INVALID_INPUT", "Invalid search request.", 422);
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;
  try {
    const results = await searchService().search(actorResult.actor, workspaceId, {
      query: parsed.data.query,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor,
      filters: parsed.data.filters,
    });
    return NextResponse.json({ ...results, hits: results.hits.map(toSearchHitResponse) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
