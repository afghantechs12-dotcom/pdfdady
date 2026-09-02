import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { IWorkspaceAwareUploadService } from "@/src/application/ports/workspace/WorkspaceAwareUploadService";
import { DOCUMENT_INGESTION_LIMITS } from "@/src/domain/entities/DocumentIngestion";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requireSameOrigin,
  workspaceError,
  workspaceServices,
} from "@/src/application/services/workspaceHttp";
import { toVersionResponse, versionService } from "@/src/application/services/versionHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The `%PDF-` file signature. Declared MIME types are client-supplied claims. */
const PDF_SIGNATURE = Buffer.from("%PDF-", "ascii");

/**
 * Upper bound on a stored editor scene.
 *
 * A scene is JSON, but it inlines placed images and signatures as data URLs, so
 * it is not small. The bound is generous rather than tight because the failure it
 * guards against is a runaway store, not a large legitimate document — and it is
 * checked BEFORE the part is read into memory.
 *
 * ponytail: whole-scene JSON with inline assets. The draft path externalises
 * assets by content hash (`inlineSceneAssets`); doing the same here would stop a
 * 20-object document re-uploading the same image 20 times across versions. Worth
 * doing when scene sizes actually bite; the content-addressed store already
 * dedupes IDENTICAL scenes, which covers the common "save twice, changed nothing"
 * case.
 */
const MAX_SCENE_BYTES = 64 * 1024 * 1024;

/**
 * A minimal structural check on a client-supplied scene.
 *
 * NOT a full deserialization: the canonical codec lives in the editor and runs on
 * load, where a bad scene degrades one document instead of failing a request. What
 * this rejects is a blob that is not a scene at all — an image, a PDF, a truncated
 * upload — so the artifact a later reopen fetches is at least the right KIND of
 * thing. `version` is bounded but deliberately NOT compared against the server's
 * idea of the current format: a newer client legitimately writes a newer version,
 * and the reader is what decides whether it can read it.
 */
function looksLikeScene(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const envelope = parsed as Record<string, unknown>;
  if (envelope.format !== "pdfdadi-editor") return false;
  if (typeof envelope.version !== "number" || !Number.isInteger(envelope.version)) return false;
  if (envelope.version < 1 || envelope.version > 1_000_000) return false;
  return typeof envelope.document === "object" && envelope.document !== null;
}

/**
 * POST /api/workspaces/:workspaceId/documents/:documentId/versions/upload
 *
 * Saves edited PDF bytes as a new version OF AN EXISTING document.
 *
 * This route exists because there was no way to do that. The editor's only
 * byte-accepting endpoint was `documents/upload`, which always creates a
 * DocumentRecord, so pressing "Save to Workspace" twice in one editing session
 * produced two `Untitled PDF.pdf` documents — the same logical document, saved
 * twice, recorded as two. The sibling `versions` route takes storage KEYS, and no
 * client-facing route stored bytes under a key, so the client could not use it.
 * This one closes that gap: it stores the bytes, then hands the resulting key to
 * the same {@link VersionService.createVersion} the sibling route calls.
 *
 * WHAT IS DELIBERATE HERE:
 *
 *  - AUTHORIZATION BEFORE STORAGE. `validateDestination` performs
 *    `workspaces.get(actor, workspaceId, write)`, so an actor without write
 *    access is refused BEFORE a byte is written. Without that, the route would be
 *    a storage-write oracle for anyone who can authenticate — the version create
 *    at the end authorizes too, but by then the object is in the bucket.
 *  - THE SIGNATURE IS CHECKED HERE. `uploads.upload` is the generic
 *    content-addressed path and enforces no file type; `uploadToWorkspace`'s
 *    allow-list is not on it. A version whose artifact is not a PDF is a document
 *    that cannot be reopened.
 *  - THE CAS IS THE CLIENT'S. `expectedRevision` comes from the request and is
 *    compared in the domain. A route that read the current revision itself and
 *    passed it along would satisfy the compare-and-swap by construction and
 *    protect nobody — the whole point is that a save built on a stale document is
 *    rejected rather than silently overwriting someone else's.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; documentId: string }> },
) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;

  const { workspaceId, documentId } = await params;

  // Rejected before the body is buffered. The service re-checks the real length,
  // since content-length is client-supplied.
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > DOCUMENT_INGESTION_LIMITS.maxUploadBytes) {
    return workspaceError(request, "PAYLOAD_TOO_LARGE", "Upload too large.", 413);
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return workspaceError(request, "INVALID_INPUT", "Expected a multipart/form-data upload.", 415);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return workspaceError(request, "INVALID_INPUT", "Malformed multipart body.", 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return workspaceError(request, "INVALID_INPUT", "A `file` part is required.", 422);
  }
  if (file.size === 0) {
    return workspaceError(request, "INVALID_INPUT", "An empty file cannot be saved.", 422);
  }
  if (file.size > DOCUMENT_INGESTION_LIMITS.maxUploadBytes) {
    return workspaceError(request, "PAYLOAD_TOO_LARGE", "Upload too large.", 413);
  }

  const rawRevision = form.get("expectedRevision");
  const expectedRevision = typeof rawRevision === "string" ? Number(rawRevision) : NaN;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    return workspaceError(
      request,
      "INVALID_INPUT",
      "An integer `expectedRevision` is required.",
      422,
    );
  }

  const rawOrganizationId = form.get("organizationId");
  const actorResult = await getWorkspaceActor(
    request,
    typeof rawOrganizationId === "string" && rawOrganizationId.trim()
      ? rawOrganizationId.trim()
      : undefined,
  );
  if ("response" in actorResult) return actorResult.response;
  const { actor } = actorResult;

  try {
    const uploads = appContainer.resolve<IWorkspaceAwareUploadService>(
      Tokens.WorkspaceAwareUploadService,
    );
    // Write authorization, before any byte is stored. Throws for an actor who may
    // not write this Workspace; `false` means the destination itself is unusable.
    if (!(await uploads.validateDestination(actor, workspaceId))) {
      return workspaceError(request, "INVALID_INPUT", "This destination cannot be used.", 422);
    }

    const data = Buffer.from(await file.arrayBuffer());
    if (!data.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) {
      return workspaceError(request, "INVALID_INPUT", "Only PDF bytes can be saved.", 422);
    }

    // Computed here rather than read back off the stored row: `StoredFile.sha256`
    // is nullable, and a version manifest with no source checksum is a version
    // whose artifact cannot be verified.
    const checksum = crypto.createHash("sha256").update(data).digest("hex");

    const stored = await uploads.upload({
      ownerType: "org",
      ownerId: actor.organizationId,
      data,
      mimeType: "application/pdf",
      originalName: file.name || "document.pdf",
    });

    /*
     * THE EDITABLE SCENE, and the bytes it is drawn on top of.
     *
     * A version used to be flattened PDF bytes and nothing else, which made
     * "reopen in the editor" a RE-IMPORT: the saved PDF was parsed back into
     * whatever pdf.js could recover from it. Objects came back as source-text
     * runs, and anything the exporter drew but the model could not describe came
     * back as page graphics. That is why a sticky note reopened as bare text.
     *
     * The three manifest slots below are what a version needs to be reopenable,
     * and they mean exactly what the manifest says they mean:
     *
     *   sourceKey      the bytes the scene overlays — the ORIGINAL document
     *   outputKey      the flattened PDF this version publishes (what downloads,
     *                  previews and thumbnails serve)
     *   editorStateKey the serialized editor scene
     *
     * Both extra parts are OPTIONAL, and their absence is the pre-existing
     * behaviour rather than an error: a client that sends only `file` still writes
     * a bytes-only version, so an older tab mid-session keeps working.
     *
     * `source` is re-sent on every save even though it does not change. That costs
     * a checksum lookup, not storage — `uploads.upload` is content-addressed and
     * byte-deduplicated, so the second save of a session stores zero new original
     * bytes.
     */
    const rawScene = form.get("scene");
    let editorState: { key: string; checksum: string } | null = null;
    if (rawScene !== null) {
      const sceneText =
        typeof rawScene === "string"
          ? rawScene
          : rawScene instanceof File && rawScene.size <= MAX_SCENE_BYTES
            ? await rawScene.text()
            : null;
      if (sceneText === null || Buffer.byteLength(sceneText, "utf8") > MAX_SCENE_BYTES) {
        return workspaceError(request, "PAYLOAD_TOO_LARGE", "Editor state too large.", 413);
      }
      if (!looksLikeScene(sceneText)) {
        return workspaceError(request, "INVALID_INPUT", "`scene` is not editor state.", 422);
      }
      const sceneBytes = Buffer.from(sceneText, "utf8");
      const sceneChecksum = crypto.createHash("sha256").update(sceneBytes).digest("hex");
      const storedScene = await uploads.upload({
        ownerType: "org",
        ownerId: actor.organizationId,
        data: sceneBytes,
        mimeType: "application/json",
        originalName: "editor-state.json",
      });
      editorState = { key: storedScene.file.key, checksum: sceneChecksum };
    }

    const rawSource = form.get("source");
    let original: { key: string; checksum: string; byteSize: number } | null = null;
    if (rawSource instanceof File && rawSource.size > 0) {
      if (rawSource.size > DOCUMENT_INGESTION_LIMITS.maxUploadBytes) {
        return workspaceError(request, "PAYLOAD_TOO_LARGE", "Upload too large.", 413);
      }
      const sourceData = Buffer.from(await rawSource.arrayBuffer());
      if (!sourceData.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) {
        return workspaceError(request, "INVALID_INPUT", "`source` must be PDF bytes.", 422);
      }
      const sourceChecksum = crypto.createHash("sha256").update(sourceData).digest("hex");
      const storedSource = await uploads.upload({
        ownerType: "org",
        ownerId: actor.organizationId,
        data: sourceData,
        mimeType: "application/pdf",
        originalName: rawSource.name || "source.pdf",
      });
      original = {
        key: storedSource.file.key,
        checksum: sourceChecksum,
        byteSize: sourceData.byteLength,
      };
    }

    const version = await versionService().createVersion(actor, workspaceId, {
      documentId,
      expectedRevision,
      origin: "save",
      manifest: {
        // With no separate original, the published bytes ARE the source and there
        // is no output to distinguish — byte-for-byte the manifest a bytes-only
        // save has always written.
        sourceKey: original?.key ?? stored.file.key,
        sourceChecksum: original?.checksum ?? checksum,
        sourceByteSize: original?.byteSize ?? data.byteLength,
        ...(original
          ? { outputKey: stored.file.key, outputChecksum: checksum }
          : {}),
        ...(editorState
          ? { editorStateKey: editorState.key, editorStateChecksum: editorState.checksum }
          : {}),
      },
    });

    workspaceServices()
      .audit.record({
        actorType: "user",
        actorId: actor.userId,
        organizationId: actor.organizationId,
        action: "document.version.create",
        resourceType: "document_record",
        resourceId: documentId,
        // The version number, which is what distinguishes this event from the
        // next one on the same document. Deliberately NOT the uploaded file's
        // name: that is the version's own file name, and passing it off as the
        // document's name is the class of misleading metadata this phase removes.
        metadata: { versionNumber: version.versionNumber },
      })
      .catch(() => {});

    return NextResponse.json(
      {
        version: toVersionResponse(version),
        /*
         * The document revision this publish produced — the caller's next
         * compare-and-swap token.
         *
         * Without it the editor had to reuse `version.versionNumber` as its
         * fencing token, which is a different counter: a rename advances the
         * revision without creating a version, so after one rename the editor's
         * own autosave conflicted with the version it had just published. Not a
         * competing tab — itself. Reported, not inferred: `versionNumber + 1` and
         * `revision + 1` are both arithmetic on a column this process does not own.
         */
        document: { revision: version.documentRevision },
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
