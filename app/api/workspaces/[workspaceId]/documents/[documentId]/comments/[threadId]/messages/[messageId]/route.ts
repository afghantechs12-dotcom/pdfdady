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

const patchSchema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
  body: z.string().max(L.maxBodyLength * 2),
  expectedRevision: z.number(),
});

const deleteSchema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
  expectedRevision: z.number(),
});

/** Edits a message. Only its author may do this. */
export async function PATCH(
  request: NextRequest,
  {
    params,
  }: {
    params: Promise<{
      workspaceId: string;
      documentId: string;
      threadId: string;
      messageId: string;
    }>;
  },
) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, documentId, threadId, messageId } = await params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "Invalid comment edit.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const message = await commentService().editMessage(
      actorResult.actor,
      workspaceId,
      documentId,
      threadId,
      messageId,
      { body: parsed.data.body, expectedRevision: parsed.data.expectedRevision },
    );
    const [decorated] = await withCommentAuthors([toCommentMessageResponse(message)]);
    return NextResponse.json({ message: decorated });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

/** Deletes a message. Its author, or a workspace editor, may do this. */
export async function DELETE(
  request: NextRequest,
  {
    params,
  }: {
    params: Promise<{
      workspaceId: string;
      documentId: string;
      threadId: string;
      messageId: string;
    }>;
  },
) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, documentId, threadId, messageId } = await params;
  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "Invalid deletion request.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const message = await commentService().deleteMessage(
      actorResult.actor,
      workspaceId,
      documentId,
      threadId,
      messageId,
      parsed.data.expectedRevision,
    );
    const [decorated] = await withCommentAuthors([toCommentMessageResponse(message)]);
    return NextResponse.json({ message: decorated });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
