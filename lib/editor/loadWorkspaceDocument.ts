/**
 * Loading a Workspace document's bytes into the editor.
 *
 * The editor's own open path takes a `File` from a file input. A Workspace
 * document arrives over HTTP instead, from the authorized content route — so
 * this adapts one to the other without duplicating the PDF.js pipeline in
 * `loadPdfIntoEditor`.
 *
 * What deliberately does *not* happen here: the client never names a storage
 * key, never receives one, and never caches the bytes anywhere but the editor's
 * own in-memory state. The URL addresses a document, and the server decides
 * which bytes that means.
 *
 *
 * A VERSION SAVED FROM AN EDITING SESSION IS REOPENED AS THAT SESSION.
 *
 * Re-importing the exported PDF was the second half of the Phase 3 fidelity
 * defect: every object the exporter had flattened came back as whatever pdf.js
 * could see in the flattened bytes, so a sticky note reopened as a source-text
 * run with no panel, a shape reopened as page graphics, and nothing was editable
 * as itself. So a version that carries an editable scene is reopened FROM that
 * scene, and the PDF path is the fallback for versions that have none — every
 * imported version, and every version written before scenes were stored.
 *
 * Two rules make the scene path safe:
 *
 *  - THE SCENE OVERLAYS THE ORIGINAL, NEVER THE OUTPUT. `artifact=source` asks
 *    for the bytes the scene was drawn on top of. Restoring a scene over the
 *    flattened export would draw every object twice.
 *  - BOTH HALVES COME FROM ONE VERSION. The scene response names its version and
 *    the bytes are then requested by that number, so a save landing between the
 *    two requests cannot pair one version's scene with another's pages.
 */

import { loadPdfIntoEditor, PdfOpenError } from "@/lib/editor/loadPdf";
import { restoreBackgrounds } from "@/lib/editor/restoreBackgrounds";
import type { SerializedEditorState } from "@/src/application/editor/ports/ISerializer";
import type { EditorState } from "@/src/domain/editor/document";
import { readRestoredPages } from "@/src/application/editor/persistence/editorCapture";

/** A Workspace document the workbench can open. */
export interface WorkspaceDocumentSource {
  documentId: string;
  workspaceId: string;
  organizationId: string;
  /** Display name, used for the tab title and export filename. */
  name: string;
  /** A specific version, or null for the document's current one. */
  versionNumber?: number | null;
}

/** Why a document could not be opened, in words a user can act on. */
export class WorkspaceDocumentLoadError extends Error {
  constructor(
    message: string,
    /** True when the document exists but has no openable content yet. */
    readonly recoverable: boolean,
    /**
     * The server's preparation state, when it reported one.
     *
     * `processing` is the only value worth waiting on: the upload is still being
     * turned into a version. `failed` means preparation finished badly and
     * polling would spin forever, which is exactly the state a spinner must not
     * be shown for.
     */
    readonly preparation: "processing" | "failed" | "none" = "none",
    /**
     * A bounded, non-disclosing reason from the server, when authorized.
     *
     * For DIAGNOSTICS ONLY. This is ingestion-flavoured text ("The stored bytes
     * do not match the uploaded checksum") that is safe to log but was never
     * written for a user-facing panel — the presentation layer authors its own
     * copy from `code`/`preparation` instead of echoing this.
     */
    readonly detail: string | null = null,
    /** HTTP status, so a caller can distinguish auth from absence. */
    readonly status: number | null = null,
    /**
     * The server's machine-readable error code, when it sent one.
     *
     * Carried because status is not evidence of meaning: the content route
     * answers 409 with `CONTENT_UNAVAILABLE`, while `mapWorkspaceError` answers
     * 409 with `WORKSPACE_OPERATION_REJECTED` for any rejected domain operation.
     * Without the code, an unrelated conflict would be described to the user as
     * a document still being prepared.
     */
    readonly code: string | null = null,
    /**
     * True when the request never produced a response at all.
     *
     * A fetch rejection is a different failure from any HTTP status: there is no
     * server verdict to report, and the user's action is to check their
     * connection rather than their permissions. Without this flag such a
     * rejection escaped as a raw `TypeError` and was presented identically to an
     * application failure.
     */
    readonly network: boolean = false,
    /** True when bytes arrived but PDF.js could not open them. */
    readonly invalidPdf: boolean = false,
    /**
     * The two numbers behind a page-cap refusal, when that is why the open
     * failed. `detail` already carried the sentence, but the panel authors its
     * own copy and reads no text off this error, so the sentence never reached
     * the user; these numbers do.
     */
    readonly pageCap: { pages: number; max: number } | null = null,
  ) {
    super(message);
    this.name = "WorkspaceDocumentLoadError";
  }
}

/**
 * The authorized content URL for a document. Never contains a storage key.
 *
 * `artifact` selects between the version's PUBLISHED bytes (`auto` — the
 * flattened output when it has one) and the bytes an editable scene is drawn on
 * top of (`source`). Omitted for `auto` so the URL of an ordinary open is
 * unchanged.
 */
export function documentContentUrl(
  source: WorkspaceDocumentSource,
  artifact: "auto" | "source" = "auto",
  versionNumber: number | null = source.versionNumber ?? null,
): string {
  const params = new URLSearchParams({ organizationId: source.organizationId });
  if (versionNumber != null) params.set("version", String(versionNumber));
  if (artifact !== "auto") params.set("artifact", artifact);
  return `/api/workspaces/${encodeURIComponent(source.workspaceId)}/documents/${encodeURIComponent(
    source.documentId,
  )}/content?${params.toString()}`;
}

/** The authorized editor-state URL for a document. Never contains a storage key. */
export function documentEditorStateUrl(source: WorkspaceDocumentSource): string {
  const params = new URLSearchParams({ organizationId: source.organizationId });
  if (source.versionNumber != null) params.set("version", String(source.versionNumber));
  return `/api/workspaces/${encodeURIComponent(source.workspaceId)}/documents/${encodeURIComponent(
    source.documentId,
  )}/editor-state?${params.toString()}`;
}

/**
 * Maps a failed content response to a load error.
 *
 * What is carried out of here is EVIDENCE, not copy: the status, the server's
 * error code, the preparation state and a diagnostic detail. The user-facing
 * sentence is authored by `presentLoadError` from that evidence.
 *
 * The server's own message is still captured for `Error.message` — it is what a
 * developer sees in a console trace and what a thrown error should describe —
 * but the panel does not render it.
 */
export async function describeContentFailure(response: Response): Promise<WorkspaceDocumentLoadError> {
  let message: string | null = null;
  let preparation: "processing" | "failed" | "none" = "none";
  let detail: string | null = null;
  let code: string | null = null;
  try {
    const data = await response.json();
    const candidate = data?.error?.message;
    if (typeof candidate === "string" && candidate.length > 0 && candidate.length <= 500) {
      message = candidate;
    }
    const state = data?.error?.preparation;
    if (state === "processing" || state === "failed") preparation = state;
    const reason = data?.error?.detail;
    if (typeof reason === "string" && reason.length > 0 && reason.length <= 500) {
      detail = reason;
    }
    const errorCode = data?.error?.code;
    if (typeof errorCode === "string" && errorCode.length > 0 && errorCode.length <= 100) {
      code = errorCode;
    }
  } catch {
    // A non-JSON error body is not worth surfacing verbatim.
  }

  // 401 and 403 are kept apart all the way through: an expired session and a
  // denied authorization need different words and different actions.
  if (response.status === 401 || response.status === 403) {
    return new WorkspaceDocumentLoadError(
      message ?? "You do not have access to this document.",
      false,
      "none",
      null,
      response.status,
      code,
    );
  }
  if (response.status === 404) {
    return new WorkspaceDocumentLoadError(
      message ?? "This document was not found.",
      false,
      "none",
      null,
      response.status,
      code,
    );
  }
  if (response.status === 409) {
    // The document exists but may have no usable stored file yet. Recoverable
    // only while something is still working on it — a failed preparation is
    // reported as terminal so the caller shows an error instead of polling
    // forever. Whether this conflict is even ABOUT content is decided by `code`
    // downstream, not assumed here.
    return new WorkspaceDocumentLoadError(
      message ?? "This document has no saved content yet.",
      preparation !== "failed",
      preparation,
      detail,
      response.status,
      code,
    );
  }
  return new WorkspaceDocumentLoadError(
    message ?? "Could not open this document.",
    false,
    "none",
    null,
    response.status,
    code,
  );
}

/**
 * Whether a thrown value is an abort rather than a failure.
 *
 * Abort is not an error condition here: the load effect aborts in-flight
 * requests when a document's identity changes and StrictMode's dev double-invoke
 * aborts the first pass. Classifying either as a network failure would show a
 * "connection problem" panel over a document that is loading perfectly well, so
 * aborts are rethrown untouched for the caller's cancellation checks to see.
 */
export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/**
 * Hard cap on a scene response the editor will read.
 *
 * Mirrors the cap the upload route enforces on the way in, so the only way past
 * it is a scene that was never accepted. A response over the cap is treated as
 * "no scene" and the document opens from its PDF — a refused open would be a
 * worse answer than a re-imported one.
 */
export const MAX_SCENE_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * Recognises a scene envelope in an arbitrary parsed JSON value.
 *
 * A STRUCTURAL check only: the canonical codec is the authority on whether a
 * scene is loadable, and it runs next. What this rejects is a body that is not a
 * scene at all — so the caller can fall back to the PDF instead of handing the
 * codec something that will throw. `version` is deliberately not compared to the
 * editor's own format version; the codec migrates what it can and refuses what it
 * cannot, and duplicating that judgement here would mean two places to update.
 */
export function sceneEnvelopeOf(value: unknown): SerializedEditorState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.format !== "pdfdadi-editor") return null;
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) {
    return null;
  }
  if (typeof raw.document !== "object" || raw.document === null) return null;
  if (typeof raw.activePageId !== "string") return null;
  return raw as unknown as SerializedEditorState;
}

/**
 * Fetches the editable scene a version was saved with, or null when it has none.
 *
 * NULL FOR EVERY FAILURE, not just for 404. A version with no scene, a scene the
 * store lost, a truncated body, a body that is not a scene: all of them mean the
 * same thing to the caller — open the PDF instead. The one exception is an abort,
 * which is cancellation and is rethrown so the load effect can see it.
 *
 * Authorization failures are also reported as "no scene" rather than raised: the
 * content request that follows asks the same questions of the same service, so a
 * genuine 401/403 surfaces there with the wording that path already authored.
 */
async function fetchEditorScene(
  source: WorkspaceDocumentSource,
  signal?: AbortSignal,
): Promise<{ scene: SerializedEditorState; versionNumber: number | null } | null> {
  let response: Response;
  try {
    response = await fetch(documentEditorStateUrl(source), {
      credentials: "same-origin",
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    return null;
  }

  if (!response.ok) return null;

  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_SCENE_RESPONSE_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    if (isAbortError(error)) throw error;
    return null;
  }

  const scene = sceneEnvelopeOf(parsed);
  if (scene === null) return null;

  const rawVersion = response.headers.get("X-Document-Version");
  const versionNumber = rawVersion !== null && /^\d+$/.test(rawVersion) ? Number(rawVersion) : null;
  return { scene, versionNumber };
}

/**
 * A Workspace document, opened.
 *
 * Two shapes, because reopening a version saved from an editing session and
 * reopening an imported PDF are genuinely different operations and the caller has
 * to apply them differently: a `scene` goes through the editor's own canonical
 * codec (which owns migrations and the plugin object registry), a `state` is
 * already live state seeded from the PDF. Collapsing them into one field would
 * mean deserializing here with a second, registry-less codec.
 */
export type LoadedWorkspaceDocument = {
  backgrounds: Map<string, string>;
  sourceBytes: Uint8Array;
  versionNumber: number | null;
  /**
   * The document record's revision, from `X-Document-Revision`.
   *
   * NOT `versionNumber`. This is the counter a write is fenced against, and the
   * two only look alike: a rename advances the revision without creating a
   * version. Null when the server did not disclose one, which a caller must treat
   * as "read it before writing" rather than as zero.
   */
  documentRevision: number | null;
} & (
  | { scene: SerializedEditorState; state: null }
  | { scene: null; state: EditorState }
);

/**
 * Fetches a Workspace document and produces what the editor should open.
 *
 * The response's `X-Document-Version` header is returned alongside so a caller
 * can record which checkpoint a tab was opened against — that is what later lets
 * a save detect that the document moved underneath it.
 */
export async function loadWorkspaceDocument(
  source: WorkspaceDocumentSource,
  signal?: AbortSignal,
): Promise<LoadedWorkspaceDocument> {
  // Asked for first, because the answer decides WHICH bytes to ask for next.
  const restored = await fetchEditorScene(source, signal);

  let response: Response;
  try {
    response = await fetch(
      documentContentUrl(
        source,
        restored ? "source" : "auto",
        // Pinned to the scene's own version so the two halves cannot come from
        // different checkpoints.
        restored ? (restored.versionNumber ?? source.versionNumber ?? null) : undefined,
      ),
      { credentials: "same-origin", signal },
    );
  } catch (error) {
    // A fetch that rejects produced no response at all: offline, DNS failure,
    // TLS failure, connection reset. Previously this escaped as a raw TypeError
    // and was presented with the same generic wording as an application failure,
    // which sent users looking for a problem with the document instead of their
    // connection.
    if (isAbortError(error)) throw error;
    throw new WorkspaceDocumentLoadError(
      error instanceof Error ? error.message : "Network request failed",
      false,
      "none",
      null,
      null,
      null,
      true,
    );
  }

  if (!response.ok) throw await describeContentFailure(response);

  let bytes: Uint8Array;
  let versionNumber: number | null;
  let documentRevision: number | null;
  let fileName: string;
  try {
    const buffer = await response.arrayBuffer();
    bytes = new Uint8Array(buffer);
    fileName = /\.pdf$/i.test(source.name) ? source.name : `${source.name}.pdf`;

    const rawVersion = response.headers.get("X-Document-Version");
    versionNumber = rawVersion !== null && /^\d+$/.test(rawVersion) ? Number(rawVersion) : null;
    const rawRevision = response.headers.get("X-Document-Revision");
    documentRevision = rawRevision !== null && /^\d+$/.test(rawRevision) ? Number(rawRevision) : null;
  } catch (error) {
    // The body failed mid-stream. The connection, not the PDF, is the problem.
    if (isAbortError(error)) throw error;
    throw new WorkspaceDocumentLoadError(
      error instanceof Error ? error.message : "Response body could not be read",
      false,
      "none",
      null,
      null,
      null,
      true,
    );
  }

  if (restored) {
    /*
     * The scene is authoritative and only the page IMAGES are rebuilt — the same
     * discipline the local draft-recovery path follows, through the same helpers,
     * for the same reason: `loadPdfIntoEditor` mints fresh page ids, so rendering
     * through it would miss every background key, and applying its state would
     * hand back the file as it was imported with every edit gone.
     *
     * A page whose raster cannot be rebuilt is white, not missing. The objects on
     * it are intact, which is the property this phase is about.
     */
    const pages = readRestoredPages(restored.scene);
    let backgrounds = new Map<string, string>();
    try {
      backgrounds = (
        await restoreBackgrounds({ pages, sourceBytes: bytes, documentName: source.name, signal })
      ).backgrounds;
    } catch (error) {
      if (isAbortError(error)) throw error;
      // Only a failure to OPEN the source PDF reaches here; per-page failures are
      // absorbed inside. The scene still opens, over blank pages.
      console.error("Workspace document: could not rasterise the version's source PDF", error);
      for (const page of pages) backgrounds.set(page.pageId, "");
    }
    return {
      scene: restored.scene,
      state: null,
      backgrounds,
      sourceBytes: bytes,
      versionNumber: restored.versionNumber ?? versionNumber,
      documentRevision,
    };
  }

  try {
    const loaded = await loadPdfIntoEditor(new File([bytes], fileName, { type: "application/pdf" }));
    return { ...loaded, scene: null, versionNumber, documentRevision };
  } catch (error) {
    if (isAbortError(error)) throw error;
    // A PdfOpenError is the real discriminator for "bytes arrived, PDF.js
    // refused them" — including the deliberately user-facing page-cap guidance.
    if (error instanceof PdfOpenError) {
      throw new WorkspaceDocumentLoadError(
        error.message,
        false,
        "none",
        error.message,
        null,
        null,
        false,
        true,
        error.pageCap,
      );
    }
    throw new WorkspaceDocumentLoadError(
      error instanceof Error ? error.message : "PDF could not be opened",
      false,
      "none",
      null,
      null,
      null,
      false,
      true,
    );
  }
}
