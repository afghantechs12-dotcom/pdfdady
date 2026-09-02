import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requireSameOrigin,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import { tagService, toSmartCollectionResponse } from "@/src/application/services/tagHttp";
import { SMART_COLLECTION_LIMITS as L } from "@/src/domain/entities/SmartCollection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The query is accepted as an unknown JSON value and validated by the domain
 * grammar, not by a zod mirror of it. One validator is the point: a second
 * schema here could drift from the allowlist the evaluator actually enforces,
 * and the looser of the two would be the one that decides what gets stored.
 */
const createSchema = z.object({
  organizationId: z.string().min(1),
  name: z.string().min(1).max(L.maxNameLength),
  query: z.unknown(),
});

/** The Workspace's smart collections. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params;
  const actorResult = await getWorkspaceActor(
    request,
    request.nextUrl.searchParams.get("organizationId") ?? undefined,
  );
  if ("response" in actorResult) return actorResult.response;

  const rawLimit = request.nextUrl.searchParams.get("limit");
  const limit = rawLimit === null ? L.defaultListLimit : Number(rawLimit);
  if (rawLimit !== null && !Number.isFinite(limit)) {
    return workspaceError(request, "INVALID_INPUT", "limit must be a number.", 422);
  }

  try {
    const collections = await tagService().listSmartCollections(
      actorResult.actor,
      workspaceId,
      limit,
    );
    return NextResponse.json({ collections: collections.map(toSmartCollectionResponse) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

/** Creates a smart collection from a validated query definition. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId } = await params;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "Invalid collection input.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const collection = await tagService().createSmartCollection(actorResult.actor, workspaceId, {
      name: parsed.data.name,
      query: parsed.data.query,
    });
    return NextResponse.json({ collection: toSmartCollectionResponse(collection) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
