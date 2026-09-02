import { NextResponse, type NextRequest } from "next/server";
import { getWorkspaceActor, mapWorkspaceError, workspaceError } from "@/src/application/services/workspaceHttp";
import { searchService, toSearchStatusResponse } from "@/src/application/services/searchHttp";
import { SEARCH_LIMITS } from "@/src/domain/entities/SearchIndex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Returns a document's authorized search-index status. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; documentId: string }> },
): Promise<Response> {
  const { workspaceId, documentId } = await params;
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!organizationId || organizationId.length > SEARCH_LIMITS.maxIdLength) {
    return workspaceError(request, "INVALID_INPUT", "organizationId is required.", 422);
  }
  const actorResult = await getWorkspaceActor(request, organizationId);
  if ("response" in actorResult) return actorResult.response;
  try {
    const status = await searchService().getIndexStatus(actorResult.actor, workspaceId, documentId);
    return NextResponse.json({ searchIndex: toSearchStatusResponse(status) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
