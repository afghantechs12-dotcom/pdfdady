import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requireSameOrigin,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import {
  statisticsService,
  toComparisonOperationResponse,
} from "@/src/application/services/statisticsHttp";
import { STATISTICS_LIMITS as L } from "@/src/domain/entities/DocumentStatistics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
});

type Params = {
  params: Promise<{ workspaceId: string; documentId: string; comparisonId: string }>;
};

/**
 * Requests cancellation.
 *
 * A request rather than an instant stop: long work observes it at its next
 * checkpoint, and reporting "cancelled" the moment the button is pressed would
 * claim the work stopped when it may still be running. A pending operation,
 * which nothing has picked up, is cancelled outright.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, documentId, comparisonId } = await params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "organizationId is required.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const operation = await statisticsService().cancelComparison(
      actorResult.actor,
      workspaceId,
      documentId,
      comparisonId,
    );
    return NextResponse.json({ comparison: toComparisonOperationResponse(operation) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
