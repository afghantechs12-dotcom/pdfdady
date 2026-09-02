import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requireSameOrigin,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import {
  commentService,
  toCommentThreadResponse,
  withThreadAuthors,
} from "@/src/application/services/commentHttp";
import { COLLABORATION_LIMITS as L } from "@/src/domain/entities/Collaboration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
  expectedRevision: z.number(),
});

/** Marks a thread resolved. */
export async function POST(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ workspaceId: string; documentId: string; threadId: string }> },
) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, documentId, threadId } = await params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "A revision is required.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const thread = await commentService().resolveThread(
      actorResult.actor,
      workspaceId,
      documentId,
      threadId,
      parsed.data.expectedRevision,
    );
    const [decorated] = await withThreadAuthors([toCommentThreadResponse(thread)]);
    return NextResponse.json({ thread: decorated });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
