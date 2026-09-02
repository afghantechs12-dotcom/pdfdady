import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requireSameOrigin,
  workspaceError,
  workspaceServices,
} from "@/src/application/services/workspaceHttp";

export const runtime = "nodejs";

const schema = z.object({ organizationId: z.string().min(1) });

/**
 * POST — "a person opened this document."
 *
 * The `Opened` column in the file manager read `lastAccessedAt`, which nothing in
 * the product ever wrote: `DocumentRecordService.touchAccessed` and the repository
 * method under it both existed with zero callers, so the column showed `—` for every
 * document forever. This route is the missing caller.
 *
 * WHY AN EXPLICIT EVENT rather than a side effect of reading the bytes. The content
 * route is the tempting place — it is on the path of every open — but it is a GET,
 * and a GET that writes turns a prefetch, a retry, or a range request into a phantom
 * open. It also fires two or three times for one open (the scene, then the pages it
 * sits on). "Opened" is a statement about a person, so it is recorded once, by a
 * POST, at the moment an editor finished loading the document for them.
 *
 * What deliberately does NOT record an open: listing a Workspace, loading a
 * document's metadata for a card or a preview, running a tool over it, and a load
 * that failed. None of those put the document in front of anybody.
 *
 * NO VERSION, NO REVISION BUMP. `touchAccessed` writes one timestamp column
 * through `touchLastAccessed`; it does not go through `update`, so it does not
 * advance the document's compare-and-swap revision and cannot invalidate an open
 * editor's autosave fence — opening a document in a second tab must not make the
 * first tab's next save a conflict.
 *
 * Authorization is the ordinary one, at read level: `touchAccessed` re-resolves
 * Workspace membership and 404s a document that is not in that Workspace. A viewer
 * may record an open because a viewer may open documents.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; documentId: string }> },
) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;

  const { workspaceId, documentId } = await params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "organizationId required.", 422);
  }

  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    await workspaceServices().documents.touchAccessed(actorResult.actor, workspaceId, documentId);
    // Nothing to return: the client already knows what it opened, and the only
    // consumer of the timestamp is the next Workspace listing.
    return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
