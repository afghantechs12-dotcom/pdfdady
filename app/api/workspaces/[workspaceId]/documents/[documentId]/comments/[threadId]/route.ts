import { NextResponse, type NextRequest } from "next/server";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import {
  commentService,
  toCommentMessageResponse,
  toCommentThreadResponse,
  withCommentAuthors,
  withThreadAuthors,
} from "@/src/application/services/commentHttp";
import { COLLABORATION_LIMITS as L } from "@/src/domain/entities/Collaboration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One thread with its messages. */
export async function GET(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ workspaceId: string; documentId: string; threadId: string }> },
) {
  const { workspaceId, documentId, threadId } = await params;
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!organizationId || organizationId.length > L.maxIdLength) {
    return workspaceError(request, "INVALID_INPUT", "organizationId is required.", 422);
  }
  const actorResult = await getWorkspaceActor(request, organizationId);
  if ("response" in actorResult) return actorResult.response;

  const rawLimit = request.nextUrl.searchParams.get("limit");

  try {
    const result = await commentService().getThread(
      actorResult.actor,
      workspaceId,
      documentId,
      threadId,
      { limit: rawLimit === null ? undefined : Number(rawLimit) },
    );
    return NextResponse.json({
      thread: (await withThreadAuthors([
        toCommentThreadResponse(result.thread, result.stale),
      ]))[0],
      messages: await withCommentAuthors(result.messages.map(toCommentMessageResponse)),
    });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
