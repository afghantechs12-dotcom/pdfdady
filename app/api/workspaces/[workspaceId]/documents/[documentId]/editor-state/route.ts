import { NextResponse, type NextRequest } from "next/server";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { IObjectStorage } from "@/src/application/ports/storage/ObjectStorage";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requestId,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import { versionService } from "@/src/application/services/versionHttp";
import { parseContentRequest } from "@/src/application/services/documentContent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/workspaces/:workspaceId/documents/:documentId/editor-state
 *
 * Streams the SERIALIZED EDITOR SCENE a version was saved with, so reopening a
 * Workspace document restores the document the user was editing rather than
 * re-importing the PDF it exported to.
 *
 * Why a separate route from `content`, rather than another `artifact` value: this
 * one serves `application/json`, is not a document download, has no
 * Content-Disposition story, and is meaningless to every consumer except the
 * editor. Folding it into the PDF route would give that route two content types
 * and two audiences.
 *
 * WHAT IS DELIBERATE:
 *
 *  - AUTHORIZATION IS THE VERSION SERVICE'S. The scene is reached only through a
 *    version the service resolved inside the actor's Workspace, exactly as the
 *    content route does. A foreign document reports as missing, not forbidden.
 *  - THE CLIENT NEVER NAMES A KEY. It names a document and optionally a version
 *    number; the key comes from that version's manifest.
 *  - NO KEY OR CHECKSUM IS ECHOED. Uploaded objects are content-addressed
 *    (`ca/<aa>/<bb>/<sha256>`), so the scene's checksum is its storage location
 *    under another name. The version number is the only identifier returned.
 *  - THE BODY IS NOT VALIDATED HERE. The canonical codec that can actually judge
 *    a scene lives in the editor and runs on load, where a bad scene degrades one
 *    document instead of failing a request; the write path already rejected
 *    anything that is not structurally a scene envelope. Re-parsing a
 *    multi-megabyte scene server-side to learn what the reader is about to learn
 *    anyway would buy nothing and buffer everything.
 *  - 404, NOT AN EMPTY SCENE, when a version has none. Versions written by
 *    import — and every version written before scenes were stored — legitimately
 *    have no editable state, and the client's answer to that is to fall back to
 *    loading the PDF. An empty scene would look like a document with no objects.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; documentId: string }> },
) {
  const { workspaceId, documentId } = await params;

  // The same bounded parse the content route uses; `artifact`/`download` are
  // meaningless here and simply ignored.
  const parsed = parseContentRequest(request.nextUrl.searchParams);
  if (!parsed.ok) {
    return workspaceError(request, "INVALID_INPUT", parsed.message, 422);
  }

  const actorResult = await getWorkspaceActor(request, parsed.organizationId);
  if ("response" in actorResult) return actorResult.response;
  const { actor } = actorResult;

  try {
    const versions = versionService();
    const version =
      parsed.versionNumber === null
        ? await versions.getLatestVersion(actor, workspaceId, documentId)
        : await versions.getVersion(actor, workspaceId, documentId, parsed.versionNumber);

    // Re-checked rather than assumed: the service scopes reads to the Workspace,
    // but the version/document pairing is the caller's claim until verified.
    if (!version || version.documentId !== documentId) {
      return notFound(request);
    }
    // A manifest that could not be read within bounds may carry a truncated key.
    if (version.manifestDegraded) return notFound(request);

    const key = version.manifest.editorStateKey;
    if (typeof key !== "string" || key.trim() === "") return notFound(request);

    const storage = appContainer.resolve<IObjectStorage>(Tokens.ObjectStorage);
    const head = await storage.head(key).catch(() => null);
    if (!head?.exists) return notFound(request);
    const stream = await storage.getStream(key);

    return new NextResponse(stream as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...(head.size > 0 ? { "Content-Length": String(head.size) } : {}),
        "X-Content-Type-Options": "nosniff",
        // Tenant data behind authorization: a shared cache holding it is a
        // cross-tenant disclosure, and a browser cache holding it survives a
        // sign-out.
        "Cache-Control": "private, no-store, max-age=0",
        "X-Document-Version": String(version.versionNumber),
      },
    });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

/**
 * One response for every "there is no scene here" case.
 *
 * Deliberately undifferentiated: "no such version", "this version has no editable
 * state" and "the stored object is gone" are the same fact to the client — load
 * the PDF instead — and telling them apart would report on storage.
 */
function notFound(request: NextRequest): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: "EDITOR_STATE_UNAVAILABLE",
        message: "This version has no saved editor state.",
        requestId: requestId(request),
      },
    },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}
