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

const updateSchema = z.object({
  organizationId: z.string().min(1),
  expectedRevision: z.number().int().min(1),
  name: z.string().min(1).max(L.maxNameLength).optional(),
  query: z.unknown().optional(),
});

const deleteSchema = z.object({
  organizationId: z.string().min(1),
});

/** The collection definition plus the documents it currently matches. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; collectionId: string }> },
) {
  const { workspaceId, collectionId } = await params;
  const actorResult = await getWorkspaceActor(
    request,
    request.nextUrl.searchParams.get("organizationId") ?? undefined,
  );
  if ("response" in actorResult) return actorResult.response;

  const rawLimit = request.nextUrl.searchParams.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (limit !== undefined && !Number.isFinite(limit)) {
    return workspaceError(request, "INVALID_INPUT", "limit must be a number.", 422);
  }

  try {
    const evaluated = await tagService().evaluateSmartCollection(
      actorResult.actor,
      workspaceId,
      collectionId,
      limit,
    );
    return NextResponse.json({
      collection: toSmartCollectionResponse(evaluated.collection),
      documentIds: evaluated.documentIds,
      total: evaluated.total,
    });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

/** Renames a collection or replaces its query, compare-and-swapping on revision. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; collectionId: string }> },
) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, collectionId } = await params;
  const body = await request.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "Invalid collection input.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  // `query` may legitimately be any JSON value, so its presence is decided by
  // the raw body's own key rather than by the parsed value being non-undefined.
  const hasQuery =
    typeof body === "object" && body !== null && Object.prototype.hasOwnProperty.call(body, "query");

  try {
    const collection = await tagService().updateSmartCollection(
      actorResult.actor,
      workspaceId,
      collectionId,
      parsed.data.expectedRevision,
      {
        ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
        ...(hasQuery ? { query: parsed.data.query } : {}),
      },
    );
    return NextResponse.json({ collection: toSmartCollectionResponse(collection) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

/** Deletes a collection. No document is affected by the deletion. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; collectionId: string }> },
) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, collectionId } = await params;
  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "Invalid collection input.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    await tagService().deleteSmartCollection(actorResult.actor, workspaceId, collectionId);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
