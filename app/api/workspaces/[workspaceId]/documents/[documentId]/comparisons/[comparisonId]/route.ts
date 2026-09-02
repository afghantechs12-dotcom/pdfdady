import { NextResponse, type NextRequest } from "next/server";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import {
  statisticsService,
  toComparisonViewResponse,
} from "@/src/application/services/statisticsHttp";
import { STATISTICS_LIMITS as L } from "@/src/domain/entities/DocumentStatistics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ workspaceId: string; documentId: string; comparisonId: string }>;
};

/**
 * One comparison with its status and, once it has one, its result.
 *
 * The status and the result travel together so a client cannot render
 * "completed" from one response and then find no result in another.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const { workspaceId, documentId, comparisonId } = await params;
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!organizationId || organizationId.length > L.maxIdLength) {
    return workspaceError(request, "INVALID_INPUT", "organizationId is required.", 422);
  }
  const actorResult = await getWorkspaceActor(request, organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const view = await statisticsService().getComparison(
      actorResult.actor,
      workspaceId,
      documentId,
      comparisonId,
    );
    return NextResponse.json(toComparisonViewResponse(view));
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
