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

/**
 * The type is accepted as a bounded string and validated in the domain.
 *
 * Deliberately not a Zod enum: `isComparisonType` and `COMPARISON_SUPPORT` are
 * the single authority on which types exist and which this build can actually
 * run, and a second list here would eventually disagree — at which point the
 * looser of the two would decide what gets queued.
 */
const createSchema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
  leftVersionId: z.string().min(1).max(L.maxIdLength),
  rightVersionId: z.string().min(1).max(L.maxIdLength),
  type: z.string().max(64),
});

type Params = { params: Promise<{ workspaceId: string; documentId: string }> };

/** A document's comparisons, newest first. */
export async function GET(request: NextRequest, { params }: Params) {
  const { workspaceId, documentId } = await params;
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!organizationId || organizationId.length > L.maxIdLength) {
    return workspaceError(request, "INVALID_INPUT", "organizationId is required.", 422);
  }
  const actorResult = await getWorkspaceActor(request, organizationId);
  if ("response" in actorResult) return actorResult.response;

  const rawLimit = request.nextUrl.searchParams.get("limit");

  try {
    const comparisons = await statisticsService().listComparisons(
      actorResult.actor,
      workspaceId,
      documentId,
      { limit: rawLimit === null ? undefined : Number(rawLimit) },
    );
    return NextResponse.json({ comparisons: comparisons.map(toComparisonOperationResponse) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

/**
 * Creates a comparison.
 *
 * An unsupported type is refused here rather than queued and failed later: a
 * queued operation that can only fail wastes the user's wait and reads as a
 * transient problem rather than a missing capability.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, documentId } = await params;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "Invalid comparison request.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const operation = await statisticsService().createComparison(
      actorResult.actor,
      workspaceId,
      documentId,
      {
        leftVersionId: parsed.data.leftVersionId,
        rightVersionId: parsed.data.rightVersionId,
        type: parsed.data.type,
      },
    );
    return NextResponse.json({ comparison: toComparisonOperationResponse(operation) }, { status: 201 });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
