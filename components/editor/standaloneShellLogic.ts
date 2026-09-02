/**
 * Presentation logic for the standalone `/editor` shell (final launch polish).
 *
 * The standalone editor used to mount the bare {@link EditorWorkspace} in a
 * full-viewport overlay: no brand, no way back into the product, and a blank A4
 * page as the entire first-run explanation. Visitors arriving from `/tools`
 * could not tell they were still on PDFDadi.
 *
 * The logic lives here rather than in the component so the rules that matter —
 * which actions a guest may see, where "save your work" sends them, and when the
 * onboarding state gives way to the canvas — are unit-testable without a DOM.
 */

import type { SerializedEditorState } from "@/src/application/editor/ports/ISerializer";
import type { HandoffFailure } from "@/lib/workflow/handoff";

/** What the shell knows about the visitor. Guests are a supported case. */
export interface ShellViewer {
  /** Null for a signed-out visitor. */
  email: string | null;
  name: string | null;
}

/**
 * Where the editor is in its first-run story.
 *
 * `onboarding` is the state a fresh visit lands in. It is NOT a separate editor:
 * the editor instance already exists with its blank A4 document behind the
 * overlay, so choosing "Create blank PDF" reveals the canvas rather than
 * constructing anything.
 */
export type ShellStage = "onboarding" | "editing";

/**
 * Resolves the stage. Opening a PDF or explicitly choosing a blank document
 * both move to `editing`, and neither can be undone by a re-render — once the
 * editor has content, re-showing onboarding over it would hide the user's work.
 */
export function resolveStage(opts: {
  /** Set once the visitor has chosen blank, or a PDF has loaded. */
  dismissed: boolean;
  /** True when a PDF has been opened into the editor. */
  hasDocument: boolean;
}): ShellStage {
  return opts.dismissed || opts.hasDocument ? "editing" : "onboarding";
}

/** The label under the document title: the file, or the unsaved-doc default. */
export function documentTitle(fileName: string | null): string {
  const trimmed = (fileName ?? "").trim();
  return trimmed === "" ? "Untitled PDF" : trimmed;
}

/**
 * The signup destination for a guest's "Save your work to a free Workspace".
 *
 * `returnTo` points back at `/editor`, not at `/workspaces`: the visitor has
 * unsaved work on this surface and sending them to a dashboard would read as
 * having thrown it away. The path is a fixed literal — nothing user-supplied
 * reaches it, so there is no open-redirect surface to validate here.
 */
export const GUEST_SAVE_SIGNUP_HREF = "/signup?returnTo=%2Feditor";

/**
 * Which shell-owned actions are offered.
 *
 * Export is deliberately absent: it belongs to the editor toolbar and is always
 * available there, so duplicating it in the header would give the same command
 * two homes. A guest genuinely cannot save to a Workspace, so that button is
 * absent rather than present-and-failing.
 */
export interface ShellActions {
  openPdf: boolean;
  saveToWorkspace: boolean;
  /** The guest-facing upsell, shown only when saving is unavailable. */
  guestSaveUpsell: boolean;
}

/**
 * `hasWorkspace` is separate from authentication: a signed-in user whose
 * Workspace could not be resolved has nowhere to save to, and offering the
 * button anyway would produce a failure the shell already knows about.
 */
export function shellActions(
  viewer: ShellViewer,
  stage: ShellStage,
  hasWorkspace = true,
): ShellActions {
  const authenticated = viewer.email !== null;
  return {
    openPdf: true,
    // Saving an untouched onboarding document would upload a blank page the
    // visitor never asked for.
    saveToWorkspace: authenticated && hasWorkspace && stage === "editing",
    guestSaveUpsell: !authenticated && stage === "editing",
  };
}

/** Initials for the account affordance; falls back to the email's first char. */
export function viewerInitials(viewer: ShellViewer): string {
  const source = (viewer.name ?? "").trim() || (viewer.email ?? "").trim();
  if (source === "") return "?";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

/**
 * How a Workspace save ended, when it did not succeed.
 *
 * Kept as a category rather than the server's sentence: the API's messages are
 * written for an API consumer ("Document revision 4 does not match the expected
 * revision 3. Reload and retry."), and pasting one into the banner would put a
 * revision number in front of someone who has never heard of one. The category is
 * what the shell can act on — only `conflict` and `unknown` are worth retrying.
 */
export type WorkspaceSaveFailure = "conflict" | "too_large" | "unauthorized" | "unknown";

/**
 * Classifies a failed save response. `code` is the API's error code when the body
 * parsed, null when it did not — a save that returns HTML from a proxy must still
 * end in an honest message rather than a thrown TypeError.
 */
export function classifyWorkspaceSaveFailure(
  status: number,
  code: string | null,
): WorkspaceSaveFailure {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 413) return "too_large";
  // 409 is the compare-and-swap rejecting a save built on a stale revision —
  // someone else (or another tab) saved this document first.
  if (status === 409 || code === "WORKSPACE_OPERATION_REJECTED") return "conflict";
  return "unknown";
}

/** The banner copy. Bounded, and never a claim that anything was saved. */
export function workspaceSaveFailureMessage(failure: WorkspaceSaveFailure): string {
  switch (failure) {
    case "conflict":
      return "This document changed in your Workspace since your last save. Your edits are still here — retry to save them over the Workspace copy.";
    case "too_large":
      return "This document is too large to save to your Workspace. Export it instead.";
    case "unauthorized":
      return "You no longer have permission to save to this Workspace. Sign in again, or export a copy.";
    case "unknown":
      return "Could not save to your Workspace. Your edits are still here — please try again.";
  }
}

/**
 * What to tell a user whose tool result did not make it into the editor.
 *
 * Every case keeps the download honest, because that is the one thing still true
 * on the result page they came from: nothing was lost, the file is still there.
 * Nothing here claims a document is open.
 */
export function handoffFailureMessage(failure: HandoffFailure): string {
  switch (failure) {
    case "missing":
      // Already claimed (a reload of this URL), or never written. Both mean the
      // same thing to the person: go back and press the button again.
      return "That result is no longer waiting to be opened. Go back to the tool and choose “Open in Editor” again, or open the file you downloaded.";
    case "expired":
      return "That result waited too long to be opened. Run the tool again, or open the file you downloaded.";
    case "too_large":
      return "That result is too large to hand straight to the editor. Download it and open it from your device.";
    case "unavailable":
      return "This browser is not allowing local storage for this site, so results cannot be handed to the editor. Download the file and open it here instead.";
  }
}

/**
 * What a successful explicit Workspace version commit proved, as the server
 * reported it.
 *
 * `serverVersion` is the published DOCUMENT VERSION NUMBER, taken from the
 * response and never from a client-side counter. It is null when the response
 * could not name one — the FIRST save of a session goes through
 * `documents/upload`, whose version row is created asynchronously by ingestion, so
 * there is no version to quote yet. Null records the commit without quoting a
 * number, which is why the status can say "saved" without inventing "version
 * null".
 */
export interface WorkspaceCommitAck {
  documentId: string | null;
  serverVersion: number | null;
  /**
   * The DOCUMENT REVISION the commit produced, as the response reported it.
   *
   * Kept apart from `serverVersion` because they are different counters: this one
   * is the compare-and-swap token a later write is fenced against, and it advances
   * for changes that create no version at all (a rename). Feeding the version
   * number into that slot is what made a session's next autosave conflict with the
   * version it had just published. Null when the response did not name one, which
   * leaves the session's token where it was rather than guessing.
   */
  documentRevision: number | null;
}

/** Everything {@link commitToWorkspace} is allowed to touch. */
export interface WorkspaceCommitPorts {
  /**
   * The bytes to publish, the editor revision they were rendered from, and what
   * it takes to reopen that revision as an editing session.
   */
  exportBytes: () => Promise<{
    bytes: Uint8Array;
    revision: number;
    scene: SerializedEditorState;
    sourceBytes: Uint8Array | null;
  }>;
  /** The Workspace document this session already owns, or null on a first save. */
  existingDocumentId: () => string | null;
  /**
   * First save: creates the document from the published bytes. Throws on any
   * non-2xx.
   *
   * Bytes only, and deliberately so: this route hands the upload to asynchronous
   * ingestion, which cuts version 1 itself as an IMPORT — there is no editing
   * session behind that version and no request in which a scene could ride along.
   * The scene is published by the `commit` that follows.
   */
  create: (bytes: Uint8Array) => Promise<WorkspaceCommitAck>;
  /**
   * Every save of an existing document: publishes a new version. Throws on any
   * non-2xx.
   *
   * Carries all three artifacts because a version that can only be reopened by
   * re-importing its own flattened output is not a checkpoint of the document the
   * user was editing. `sourceBytes` are the pages the scene sits on; without them
   * the published bytes would be both the output and the thing the scene is
   * restored over, which draws every object twice.
   */
  commit: (
    documentId: string,
    bytes: Uint8Array,
    scene: SerializedEditorState,
    sourceBytes: Uint8Array | null,
  ) => Promise<WorkspaceCommitAck>;
  /** Records the created document id, before anything can await again. */
  onDocumentCreated: (documentId: string | null) => void;
  /** The canonical persistence machine's commit acknowledgement. */
  noteVersionCommitted: (input: {
    revision: number;
    serverVersion: number | null;
    documentRevision?: number | null;
    etag: string | null;
  }) => void;
}

/**
 * The explicit "Save to Workspace" commit, extracted from the React shell so the
 * one thing that has to be right about it can actually be tested: the revision
 * handed to `noteVersionCommitted` is the one captured WITH the exported bytes, not
 * whatever the editor has reached by the time the response lands.
 *
 * `noteVersionCommitted` is reached only after the request resolved successfully.
 * A throw — a 4xx, a 5xx, an aborted request, a body that would not parse — leaves
 * it uncalled, so a failed save cannot advance the committed watermark. There is no
 * catch here on purpose: the caller owns the banner.
 */
export async function commitToWorkspace(ports: WorkspaceCommitPorts): Promise<WorkspaceCommitAck> {
  const { bytes, revision, scene, sourceBytes } = await ports.exportBytes();
  const existing = ports.existingDocumentId();
  let documentId = existing;

  if (documentId === null) {
    const created = await ports.create(bytes);
    /*
     * Before any further await, so a second click that arrives first still updates
     * this document rather than creating another — and so a FAILING scene commit
     * below still leaves the session owning the document it just created. That is
     * what makes Retry publish a version of it instead of creating a second one.
     */
    ports.onDocumentCreated(created.documentId);
    documentId = created.documentId;
    if (documentId === null) {
      // The route accepted the upload but named no document. Nothing further can
      // be published against it, and the watermark must not advance for a save
      // whose scene was never stored.
      return created;
    }
  }

  /*
   * ONE path publishes the scene, for both a first save and every later one.
   *
   * A first save therefore costs two requests, and the second races the ingestion
   * job still cutting version 1 against the same revision — which the commit port
   * resolves by waiting for that import to land before it reads the revision it
   * swaps on, rather than reporting a conflict nobody caused. The alternative was
   * to let a first save report success while storing only flattened bytes, which is the
   * defect: the watermark would say "saved" about a version that reopens as a
   * re-import of its own export.
   */
  const ack = await ports.commit(documentId, bytes, scene, sourceBytes);
  ports.noteVersionCommitted({
    revision,
    serverVersion: ack.serverVersion,
    documentRevision: ack.documentRevision,
    etag: null,
  });
  return ack;
}
