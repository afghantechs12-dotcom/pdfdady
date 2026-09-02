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
  toDocumentStatisticsResponse,
} from "@/src/application/services/statisticsHttp";
import { STATISTICS_LIMITS as L } from "@/src/domain/entities/DocumentStatistics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Statistics are addressed by version *id* rather than by the version number
 * used under `/versions/[versionNumber]`.
 *
 * Two reasons. The service resolves a version by id within the document — that
 * check is what stops a version from another document being measured through a
 * document the actor happens to see — and Next.js permits only one slug name per
 * path segment, so nesting an id under the existing `[versionNumber]` segment is
 * not available. Keeping statistics at document level also matches how the
 * listing reads: statistics for *a document's* versions.
 *
 * The request carries no measured content, deliberately. Statistics are stored
 * as fact and read by every member of the Workspace, so accepting counts from
 * the client would let anyone with write access record numbers nobody measured —
 * and a fabricated count is indistinguishable from a real one afterwards. The
 * server assembles the content itself from what it already extracted, exactly as
 * M7.8 reindexing does: a client may ask for a recalculation, not answer it.
 */
const recalculateSchema = z
  .object({
    organizationId: z.string().min(1).max(L.maxIdLength),
    versionId: z.string().min(1).max(L.maxIdLength),
    force: z.boolean().optional(),
  })
  .strict();

type Params = { params: Promise<{ workspaceId: string; documentId: string }> };

/**
 * Statistics for one version (`?versionId=`), or the document's computed rows.
 *
 * A single version read returns null when nothing has been computed: "not
 * calculated yet" and "calculated, all zero" are different states, and the panel
 * decides whether to offer a recalculate action based on which one it got.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const { workspaceId, documentId } = await params;
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!organizationId || organizationId.length > L.maxIdLength) {
    return workspaceError(request, "INVALID_INPUT", "organizationId is required.", 422);
  }
  const actorResult = await getWorkspaceActor(request, organizationId);
  if ("response" in actorResult) return actorResult.response;

  const versionId = request.nextUrl.searchParams.get("versionId");
  if (versionId !== null && (versionId === "" || versionId.length > L.maxIdLength)) {
    return workspaceError(request, "INVALID_INPUT", "The version id is not valid.", 422);
  }
  const rawLimit = request.nextUrl.searchParams.get("limit");

  try {
    const service = statisticsService();
    if (versionId !== null) {
      const statistics = await service.getStatistics(
        actorResult.actor,
        workspaceId,
        documentId,
        versionId,
      );
      return NextResponse.json({
        statistics: statistics === null ? null : toDocumentStatisticsResponse(statistics),
      });
    }
    const rows = await service.listStatistics(actorResult.actor, workspaceId, documentId, {
      limit: rawLimit === null ? undefined : Number(rawLimit),
    });
    return NextResponse.json({ statistics: rows.map(toDocumentStatisticsResponse) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

/** Computes and stores statistics for one version. */
export async function POST(request: NextRequest, { params }: Params) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, documentId } = await params;
  const parsed = recalculateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "Invalid statistics request.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    // The trusted path: content comes from server-held extraction, never from
    // this request body.
    const statistics = await statisticsService().recalculateFromServerContent(
      actorResult.actor,
      workspaceId,
      documentId,
      parsed.data.versionId,
      { force: parsed.data.force === true },
    );
    return NextResponse.json({ statistics: toDocumentStatisticsResponse(statistics) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
