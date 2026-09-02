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
  toCommentMessageResponse,
  withCommentAuthors,
} from "@/src/application/services/commentHttp";
import { COLLABORATION_LIMITS as L } from "@/src/domain/entities/Collaboration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
  body: z.string().max(L.maxBodyLength * 2),
  parentMessageId: z.string().max(L.maxIdLength).nullish(),
});

/** A thread's messages, oldest first. */
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
  const rawSince = request.nextUrl.searchParams.get("since");
  if (rawSince !== null && rawSince.length > L.maxIdLength) {
    return workspaceError(request, "INVALID_INPUT", "The 'since' value is not valid.", 422);
  }

  try {
    const messages = await commentService().listMessages(
      actorResult.actor,
      workspaceId,
      documentId,
      threadId,
      {
        limit: rawLimit === null ? undefined : Number(rawLimit),
        since: rawSince ?? undefined,
      },
    );
    // Author names resolved server-side in ONE batched query, so the panel can
    // render a person instead of a cuid without N client round-trips.
    return NextResponse.json({
      messages: await withCommentAuthors(messages.map(toCommentMessageResponse)),
    });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

/** Adds a message, or a reply to one. */
export async function POST(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ workspaceId: string; documentId: string; threadId: string }> },
) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, documentId, threadId } = await params;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "Invalid comment.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const message = await commentService().addMessage(
      actorResult.actor,
      workspaceId,
      documentId,
      threadId,
      { body: parsed.data.body, parentMessageId: parsed.data.parentMessageId },
    );
    const [decorated] = await withCommentAuthors([toCommentMessageResponse(message)]);
    return NextResponse.json({ message: decorated }, { status: 201 });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
