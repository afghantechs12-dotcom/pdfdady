import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requireSameOrigin,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import { tagService, toTagResponse } from "@/src/application/services/tagHttp";
import { TAG_LIMITS as L } from "@/src/domain/entities/Tag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const tagId = z.string().min(1).max(L.maxIdLength);

const assignSchema = z.object({
  organizationId: z.string().min(1),
  tagId,
});

const removeSchema = assignSchema;

/** The tags currently on one document. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; documentId: string }> },
) {
  const { workspaceId, documentId } = await params;
  const actorResult = await getWorkspaceActor(
    request,
    request.nextUrl.searchParams.get("organizationId") ?? undefined,
  );
  if ("response" in actorResult) return actorResult.response;

  try {
    const tags = await tagService().listDocumentTags(actorResult.actor, workspaceId, documentId);
    return NextResponse.json({ tags: tags.map(toTagResponse) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

/** Assigns a tag to the document. Repeating the call is idempotent. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; documentId: string }> },
) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, documentId } = await params;
  const parsed = assignSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "Invalid tag assignment.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    await tagService().assignTag(actorResult.actor, workspaceId, documentId, parsed.data.tagId);
    const tags = await tagService().listDocumentTags(actorResult.actor, workspaceId, documentId);
    return NextResponse.json({ tags: tags.map(toTagResponse) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

/** Removes a tag from the document. Repeating the call is idempotent. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; documentId: string }> },
) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, documentId } = await params;
  const parsed = removeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "Invalid tag assignment.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    await tagService().removeTag(actorResult.actor, workspaceId, documentId, parsed.data.tagId);
    const tags = await tagService().listDocumentTags(actorResult.actor, workspaceId, documentId);
    return NextResponse.json({ tags: tags.map(toTagResponse) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
