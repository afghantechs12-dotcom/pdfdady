import { NextResponse, type NextRequest } from "next/server";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import {
  statisticsService,
  toComparisonResultResponse,
} from "@/src/application/services/statisticsHttp";
import { STATISTICS_LIMITS as L } from "@/src/domain/entities/DocumentStatistics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ workspaceId: string; documentId: string; comparisonId: string }>;
};

/**
 * The comparison result, re-authorized on the way out.
 *
 * Returned as structured data rather than as a storage key or a signed URL: a
 * result is small and bounded by construction, so there is no object to hand out
 * and no key to leak. A comparison that has not completed has no result, and
 * says so rather than returning an empty diff that would read as "no
 * differences".
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
    const result = await statisticsService().getComparisonResult(
      actorResult.actor,
      workspaceId,
      documentId,
      comparisonId,
    );
    return NextResponse.json({ result: toComparisonResultResponse(result) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
