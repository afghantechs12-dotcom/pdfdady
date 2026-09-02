import { NextResponse, type NextRequest } from "next/server";
import { getWorkspaceActor, mapWorkspaceError, workspaceError } from "@/src/application/services/workspaceHttp";
import { searchService } from "@/src/application/services/searchHttp";
import { SEARCH_LIMITS } from "@/src/domain/entities/SearchIndex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Returns authorized Workspace search-index health counts. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const { workspaceId } = await params;
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!organizationId || organizationId.length > SEARCH_LIMITS.maxIdLength) {
    return workspaceError(request, "INVALID_INPUT", "organizationId is required.", 422);
  }
  const actorResult = await getWorkspaceActor(request, organizationId);
  if ("response" in actorResult) return actorResult.response;
  try {
    const statistics = await searchService().getStatistics(actorResult.actor, workspaceId);
    return NextResponse.json({
      ...statistics,
      lastIndexedAt: statistics.lastIndexedAt?.toISOString() ?? null,
    });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
