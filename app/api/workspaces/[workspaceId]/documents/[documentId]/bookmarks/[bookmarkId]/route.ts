import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requireSameOrigin,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import { metadataService, toBookmarkResponse } from "@/src/application/services/metadataHttp";
import { METADATA_LIMITS as L } from "@/src/domain/entities/DocumentMetadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
  expectedRevision: z.number().int().min(1),
  pageNumber: z.number().optional(),
  title: z.string().max(L.maxTitleLength * 2).optional(),
  note: z.string().max(L.maxNoteLength * 2).nullish(),
  anchor: z.object({ x: z.number(), y: z.number() }).nullish(),
});

const deleteSchema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
});

type RouteParams = {
  params: Promise<{ workspaceId: string; documentId: string; bookmarkId: string }>;
};

/** Updates a bookmark, compare-and-swap on its revision. */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, documentId, bookmarkId } = await params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "Invalid bookmark update.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const updated = await metadataService().updateBookmark(
      actorResult.actor,
      workspaceId,
      documentId,
      bookmarkId,
      parsed.data.expectedRevision,
      {
        // Only keys the client actually sent are forwarded: an absent key means
        // "leave it alone", and passing undefined through would be read as a
        // request to clear the field.
        ...(parsed.data.pageNumber === undefined ? {} : { pageNumber: parsed.data.pageNumber }),
        ...(parsed.data.title === undefined ? {} : { title: parsed.data.title }),
        ...("note" in parsed.data ? { note: parsed.data.note ?? null } : {}),
        ...("anchor" in parsed.data ? { anchor: parsed.data.anchor ?? null } : {}),
      },
    );
    return NextResponse.json({ bookmark: toBookmarkResponse(updated) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, documentId, bookmarkId } = await params;
  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "organizationId is required.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const removed = await metadataService().deleteBookmark(
      actorResult.actor,
      workspaceId,
      documentId,
      bookmarkId,
    );
    return NextResponse.json({ removed });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
