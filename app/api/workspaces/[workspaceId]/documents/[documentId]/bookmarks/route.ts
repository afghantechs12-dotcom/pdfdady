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

const anchorSchema = z.object({ x: z.number(), y: z.number() }).nullable();

const createSchema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
  pageNumber: z.number(),
  title: z.string().max(L.maxTitleLength * 2),
  note: z.string().max(L.maxNoteLength * 2).nullish(),
  anchor: anchorSchema.optional(),
});

/** A document's bookmarks, in their stored order. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; documentId: string }> },
) {
  const { workspaceId, documentId } = await params;
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!organizationId || organizationId.length > L.maxIdLength) {
    return workspaceError(request, "INVALID_INPUT", "organizationId is required.", 422);
  }
  const actorResult = await getWorkspaceActor(request, organizationId);
  if ("response" in actorResult) return actorResult.response;

  const rawPage = request.nextUrl.searchParams.get("pageNumber");
  const rawLimit = request.nextUrl.searchParams.get("limit");

  try {
    const bookmarks = await metadataService().listBookmarks(
      actorResult.actor,
      workspaceId,
      documentId,
      {
        pageNumber: rawPage === null ? undefined : Number(rawPage),
        limit: rawLimit === null ? undefined : Number(rawLimit),
      },
    );
    return NextResponse.json({ bookmarks: bookmarks.map(toBookmarkResponse) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

/** Creates a bookmark on a page of the document. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; documentId: string }> },
) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, documentId } = await params;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "Invalid bookmark.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    // The schema bounds the body; the domain decides what is *acceptable*. Both
    // run, because a length cap is not a validity check.
    const bookmark = await metadataService().createBookmark(
      actorResult.actor,
      workspaceId,
      documentId,
      {
        pageNumber: parsed.data.pageNumber,
        title: parsed.data.title,
        note: parsed.data.note,
        anchor: parsed.data.anchor,
      },
    );
    return NextResponse.json({ bookmark: toBookmarkResponse(bookmark) }, { status: 201 });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
