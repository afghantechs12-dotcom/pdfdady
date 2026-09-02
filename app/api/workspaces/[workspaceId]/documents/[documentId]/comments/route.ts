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
  toCommentThreadResponse,
  withCommentAuthors,
  withThreadAuthors,
} from "@/src/application/services/commentHttp";
import { COLLABORATION_LIMITS as L } from "@/src/domain/entities/Collaboration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The anchor is accepted as an open record and validated in the domain.
 *
 * Deliberately not modelled as a discriminated Zod union: the domain's
 * `validateAnchor` is the single authority on anchor shape, and a second schema
 * here would eventually disagree with it — at which point the looser of the two
 * would decide what gets stored. Zod bounds the *size* of what we parse; the
 * domain decides what is valid.
 */
const createSchema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
  anchor: z.record(z.string().max(64), z.unknown()),
  body: z.string().max(L.maxBodyLength * 2),
  versionId: z.string().max(L.maxIdLength).nullish(),
});

/** A document's comment threads, newest first. */
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

  const rawStatus = request.nextUrl.searchParams.get("status");
  const rawPage = request.nextUrl.searchParams.get("pageNumber");
  const rawLimit = request.nextUrl.searchParams.get("limit");
  const rawCursor = request.nextUrl.searchParams.get("cursor");

  if (rawStatus !== null && rawStatus !== "open" && rawStatus !== "resolved") {
    return workspaceError(request, "INVALID_INPUT", "The status filter is not valid.", 422);
  }
  if (rawCursor !== null && rawCursor.length > L.maxIdLength) {
    return workspaceError(request, "INVALID_INPUT", "The cursor is not valid.", 422);
  }

  try {
    const result = await commentService().listThreadsWithMessages(
      actorResult.actor,
      workspaceId,
      documentId,
      {
        status: rawStatus ?? undefined,
        pageNumber: rawPage === null ? undefined : Number(rawPage),
        limit: rawLimit === null ? undefined : Number(rawLimit),
        cursor: rawCursor ?? undefined,
      },
    );
    /**
     * Threads carry their messages, because the panel renders the conversation
     * inline; a summary-only listing gave it `messages: undefined` and the tab
     * crashed on `thread.messages.length`.
     *
     * Identities are resolved in exactly TWO batched passes for the whole
     * payload — one over every thread creator, one over every message author
     * across every thread — never per thread and never on the client. Flattened
     * first, then redistributed, so a 20-thread page still issues 2 user
     * queries rather than 21.
     */
    const decoratedThreads = await withThreadAuthors(
      result.threads.map((entry) => toCommentThreadResponse(entry.thread, entry.stale)),
    );
    const flatMessages = await withCommentAuthors(
      result.threads.flatMap((entry) => entry.messages.map(toCommentMessageResponse)),
    );
    const byThread = new Map<string, typeof flatMessages>();
    for (const message of flatMessages) {
      const bucket = byThread.get(message.threadId);
      if (bucket) bucket.push(message);
      else byThread.set(message.threadId, [message]);
    }
    return NextResponse.json({
      threads: decoratedThreads.map((thread) => ({
        ...thread,
        messages: byThread.get(thread.id) ?? [],
      })),
      nextCursor: result.nextCursor,
    });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

/** Creates a thread together with its first message. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; documentId: string }> },
) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, documentId } = await params;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "Invalid comment.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const created = await commentService().createThread(
      actorResult.actor,
      workspaceId,
      documentId,
      {
        anchor: parsed.data.anchor,
        body: parsed.data.body,
        versionId: parsed.data.versionId,
      },
    );
    return NextResponse.json(
      {
        thread: (await withThreadAuthors([
          toCommentThreadResponse(created.thread, created.stale),
        ]))[0],
        messages: await withCommentAuthors(created.messages.map(toCommentMessageResponse)),
      },
      { status: 201 },
    );
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
