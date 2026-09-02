import type {
  ConflictAction,
  ConflictActionId,
} from "@/src/application/editor/persistence/conflictResolution";
import {
  describeGuestDocument,
  fingerprintGuestFile,
  replaceGuestDocument,
  resolveGuestDocument,
  sessionIdentityStorage,
  type DocumentIdentity,
} from "@/src/application/editor/persistence/documentIdentity";
import type { LoadedDraft } from "@/src/application/editor/persistence/draftRepository";
import {
  canRedrawFromSource,
  readRestoredPages,
  type RestoredPage,
} from "@/src/application/editor/persistence/editorCapture";
import type { PersistenceLimitation } from "@/src/infrastructure/persistence/browser/createPersistenceRuntime";

/**
 * Every decision the editor surface has to make about persistence, with no React
 * and no DOM in it.
 *
 * The surface itself is `EditorWorkspace.tsx` — 1300 lines of hooks that this
 * repository's suite cannot execute, because it runs in Node with no jsdom. So the
 * component is allowed to hold wiring and nothing else, and each judgement it would
 * otherwise make inline lives here where a test can run it.
 *
 * Three of those judgements are the reason the file exists, and all three fail
 * silently if they are wrong:
 *
 *  - WHICH DOCUMENT THE CAPTURE BELONGS TO. One editor instance shows a succession
 *    of documents. `capture` reads whatever is in the editor right now; the
 *    coordinator stamps it with whatever document is open right now. Those are two
 *    different facts, and between "the user picked a second file" and "the identity
 *    state caught up" they disagree — so a write in that window stores document B's
 *    pages as document A's draft, and A's recovery then hands back the wrong file.
 *    {@link shouldCaptureDocument} is the interlock: no capture is offered at all
 *    unless the content in the editor is the content the open identity names.
 *
 *  - WHAT A RESTORE IS ALLOWED TO TOUCH. {@link planDraftRestore} carries the rule
 *    that the draft's own scene is authoritative and only the page rasters get
 *    rebuilt. Re-running the open path instead would either mint new page ids (a
 *    document of white pages) or replace the scene with the file on disk — the user
 *    clicks "Restore my work" and every edit is gone.
 *
 *  - WHICH CONFLICT ACTIONS ARE REAL. `presentConflict` offers six, and four of
 *    them are the surface's to carry out. A button that is rendered and does nothing
 *    is worse here than a button that is absent: the user is choosing how to avoid
 *    losing a document. {@link visibleConflictActions} drops the ones this surface
 *    cannot honour and names why.
 */

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

export interface GuestDocumentIdentification {
  identity: DocumentIdentity;
  /** The content+name fingerprint the identity was resolved from. */
  fingerprint: string;
  /** True when this tab has seen this exact file before, so its draft continues. */
  reused: boolean;
  /** False when the fingerprint map could not be stored; recovery is degraded. */
  persisted: boolean;
}

/**
 * The guest identity for a locally-opened file.
 *
 * SESSION storage, deliberately, and not local: the map is keyed by a fingerprint of
 * the file's bytes, and a shared browser profile would otherwise let one person's
 * file name a document another person's draft is filed under. Losing the map on a
 * browser restart costs nothing that cannot be recovered — that is exactly what
 * `PersistenceBinding.findAbandonedGuestDraft` exists for, and it enumerates the
 * draft index rather than needing a fingerprint at all.
 *
 * Never throws. A storage failure degrades to an ephemeral id (`persisted: false`)
 * because an editor that refuses to open a file is strictly worse than one whose
 * fingerprint matching is limited to the abandoned-draft probe.
 */
export function identifyGuestDocument(input: {
  fileName: string;
  bytes: Uint8Array | null;
  byteLength?: number;
  /** Window-like. Injected so this is testable in Node. */
  scope: unknown;
  newId: () => string;
  /**
   * Set when this tab must NOT continue the draft its fingerprint already maps to.
   *
   * The abandoned-draft probe opens a found draft as this tab's identity without
   * loading it, so that the recovery offer can be raised. If the user answers by
   * declining and then asks for a blank document, continuing that draft's key would
   * autosave the blank page over the work they declined to restore.
   */
  forceNewIdentity?: boolean;
}): GuestDocumentIdentification {
  const fingerprint = fingerprintGuestFile({
    fileName: input.fileName,
    bytes: input.bytes,
    byteLength: input.byteLength,
  });
  const storage = sessionIdentityStorage(input.scope);
  const resolved = input.forceNewIdentity
    ? replaceGuestDocument(storage, fingerprint, input.newId)
    : resolveGuestDocument(storage, fingerprint, input.newId);
  return {
    identity: describeGuestDocument(resolved.guestDocumentId),
    fingerprint,
    reused: resolved.reused,
    persisted: resolved.persisted,
  };
}

/**
 * The document name a capture is stored under.
 *
 * The `.pdf` suffix is stripped because the editor's own file name state is already
 * a stem (it becomes `<name>-edited.pdf` on export), and a draft labelled
 * "report.pdf" in one place and "report" in another looks like two documents in the
 * recovery list. Empty falls back rather than storing a nameless draft the user
 * cannot recognise.
 */
export function documentNameForCapture(fileName: string): string {
  const stem = fileName.trim().replace(/\.pdf$/i, "").trim();
  return stem === "" ? "document" : stem;
}

/**
 * Where a workspace document's source PDF can be fetched again.
 *
 * Recorded on every capture even though the bytes are carried too: a draft whose
 * asset blob was evicted by the browser can then still say what it was missing, and
 * a version-pinned reference cannot be mistaken for the current one.
 */
export function workspaceSourceReference(input: {
  workspaceId: string;
  documentId: string;
  versionNumber: number | null;
}): string {
  const version = input.versionNumber === null ? "current" : String(input.versionNumber);
  return `workspace:${input.workspaceId}/${input.documentId}@${version}`;
}

/**
 * Whether the editor's content may be captured for the open document.
 *
 * `loadedKey` is the document whose content is actually in the editor; `openKey` is
 * the document the coordinator has open. They are set by different code at different
 * times and every window where they disagree is a window in which a write would
 * file one document's pages under another document's key. Returning false there
 * means `capture()` returns null, which the coordinator already treats as "nothing
 * to persist" rather than as a failure — so the cost of the interlock is a skipped
 * write, and the cost of not having it is a corrupted draft.
 *
 * Also false while nothing is loaded, which is the state a guest tab is in after a
 * refresh while an abandoned draft's identity is open to raise its recovery offer:
 * capturing there would overwrite the very draft being offered with a blank page.
 */
export function shouldCaptureDocument(input: {
  loadedKey: string | null;
  openKey: string | null;
}): boolean {
  return input.loadedKey !== null && input.loadedKey === input.openKey;
}

/* ------------------------------------------------------------------ */
/* Restoring a draft                                                   */
/* ------------------------------------------------------------------ */

export interface DraftRestorePlan {
  /** The draft's pages, reduced to what a background rebuild needs. */
  pages: RestoredPage[];
  /** Whether the page rasters can be rebuilt at all. */
  redraw: boolean;
  /** The bytes to rebuild from, or null when there are none. */
  sourceBytes: Uint8Array | null;
  /**
   * Set when the restore is incomplete before it is even attempted. A partial
   * recovery has to say so up front: a user handed a document whose original pages
   * are blank, and told it was recovered, may save it over the good one.
   */
  caveat: string | null;
}

/**
 * What a restore is allowed to do with a loaded draft.
 *
 * Note what is NOT here: any path back to `loadPdfIntoEditor`. The draft's scene is
 * the authority on the document, and only the page images are rebuilt — keyed on
 * each page's pinned source index, which is what survives insert, delete, duplicate
 * and reorder.
 */
export function planDraftRestore(draft: LoadedDraft): DraftRestorePlan {
  const pages = readRestoredPages(draft.scene);
  const sourceBytes =
    draft.sourceBytes !== null && draft.sourceBytes.byteLength > 0 ? draft.sourceBytes : null;
  const redraw = sourceBytes !== null && pages.some((page) => page.sourcePageIndex !== null);
  const complete = canRedrawFromSource({ pages, sourceBytes });
  return {
    pages,
    redraw,
    sourceBytes,
    caveat: complete
      ? null
      : "The original PDF pages could not be stored with this draft, so the recovered document keeps your edits but its page images are blank.",
  };
}

/**
 * What to tell the user after a restore has been applied.
 *
 * Always states what WAS recovered first. A message that leads with what failed
 * reads as "the recovery did not work" over a document that is, in fact, back.
 */
export function describeRestoreResult(input: {
  documentName: string;
  /** From the coordinator's outcome: whether the draft had every asset it named. */
  complete: boolean;
  /** Pages that wanted a raster and did not get one. */
  unrenderedPageCount: number;
}): string {
  const restored = `Your unsaved work on "${input.documentName}" is back.`;
  if (input.complete && input.unrenderedPageCount === 0) return restored;
  if (input.unrenderedPageCount > 0) {
    const pages =
      input.unrenderedPageCount === 1 ? "1 page" : `${input.unrenderedPageCount} pages`;
    return `${restored} ${pages} could not be redrawn from the original PDF and appear blank; the edits on them are intact.`;
  }
  return `${restored} Some of the original PDF could not be recovered with it, so parts of the document appear blank.`;
}

/* ------------------------------------------------------------------ */
/* Limitations                                                         */
/* ------------------------------------------------------------------ */

/**
 * The one limitation that means the user's work is not protected at all.
 *
 * Separated from the rest because it is the only one worth a banner. A tab that
 * cannot take the cross-tab lock, or cannot hear its peers, still saves the
 * document; a tab with no store does not, and that is a different sentence.
 */
export function blockingLimitation(
  limitations: readonly PersistenceLimitation[],
): PersistenceLimitation | null {
  return limitations.find((limitation) => limitation.code === "no_local_store") ?? null;
}

/**
 * The limitations that belong in the status detail rather than in a banner.
 *
 * Four stacked alert banners over a document editor is noise, and noise is how a
 * user learns to dismiss the one banner that mattered. These are still SHOWN — in
 * the save-status popover, where someone asking "is my work safe?" is already
 * looking.
 */
export function secondaryLimitations(
  limitations: readonly PersistenceLimitation[],
): PersistenceLimitation[] {
  return limitations.filter((limitation) => limitation.code !== "no_local_store");
}

/**
 * The extra sentence a guest document needs when its fingerprint map is gone.
 *
 * Not a failure: drafts are still written and still recoverable. What is lost is the
 * match from "this file" to "that draft", so reopening the same file starts a new
 * document and the previous draft is only reachable through the recovery offer.
 * Null for a workspace document, whose identity comes from the URL and cannot be
 * lost this way.
 */
export function guestIdentityNotice(input: {
  origin: "guest" | "workspace";
  persisted: boolean;
}): string | null {
  if (input.origin !== "guest" || input.persisted) return null;
  return "This browser will not let the page remember which file this is, so reopening it will not automatically find this draft. Recovery is still offered when the editor next opens.";
}

/* ------------------------------------------------------------------ */
/* Conflicts                                                           */
/* ------------------------------------------------------------------ */

/**
 * Who carries out a conflict action.
 *
 * `coordinator` is one the persistence layer performs and reports. `surface` is one
 * only the editor can do — produce a file, open a tab, upload a second document.
 * `not_applicable` is one that has no meaning on THIS surface, and the reason
 * matters: "review the local version" asks to see the document that is already on
 * screen behind the dialog.
 */
export type ConflictActionSupport = "coordinator" | "surface" | "not_applicable";

export function conflictActionSupport(
  id: ConflictActionId,
  context: { workspaceKnown: boolean },
): ConflictActionSupport {
  switch (id) {
    case "replace_workspace":
      return "coordinator";
    case "review_local":
      // The editor behind this dialog IS the local version. A button that reveals
      // what is already visible teaches the user that the buttons do nothing.
      return "not_applicable";
    case "save_local_copy":
      // Always available and never destructive: it is the answer to "I do not
      // understand any of this, I just want my document".
      return "surface";
    case "review_workspace":
    case "duplicate_as_new":
      return context.workspaceKnown ? "surface" : "not_applicable";
    case "cancel":
      return "surface";
  }
}

/** The actions to render, in the order `presentConflict` chose, minus the empty ones. */
export function visibleConflictActions(
  actions: readonly ConflictAction[],
  context: { workspaceKnown: boolean },
): ConflictAction[] {
  return actions.filter(
    (action) => conflictActionSupport(action.id, context) !== "not_applicable",
  );
}

/**
 * The name for the "keep both" copy.
 *
 * Suffixed rather than prefixed so the copy sorts next to the document it came from,
 * and idempotent: resolving a conflict twice must not produce
 * "report (recovered copy) (recovered copy)".
 */
export function duplicateCopyName(documentName: string): string {
  const stem = documentNameForCapture(documentName);
  return stem.endsWith(RECOVERED_SUFFIX) ? stem : `${stem}${RECOVERED_SUFFIX}`;
}

const RECOVERED_SUFFIX = " (recovered copy)";

/**
 * What "keep both" actually achieved.
 *
 * The upload route de-duplicates by content: an export that is byte-identical to a
 * document already in the workspace returns THAT document instead of creating one.
 * If it returns the document that is in conflict, nothing was kept and saying
 * "saved as a new document" would be a lie the user acts on by closing the tab.
 */
export function describeDuplicateOutcome(input: {
  workspaceId: string;
  newDocumentId: string;
  conflictedDocumentId: string | null;
  deduplicated: boolean;
  name: string;
}): { notice: string; href: string | null; resolved: boolean } {
  const href = `/workspaces/${input.workspaceId}/documents/${input.newDocumentId}`;
  if (input.deduplicated && input.newDocumentId === input.conflictedDocumentId) {
    return {
      notice:
        "Your copy is identical to the version already in the workspace, so nothing new was created — there is nothing left to lose here.",
      href: null,
      resolved: true,
    };
  }
  if (input.deduplicated) {
    return {
      notice: `Your copy matched a document already in this workspace, so "${input.name}" was not created again. Your work is in that document.`,
      href,
      resolved: true,
    };
  }
  return {
    notice: `Saved as a new document, "${input.name}". The version in the workspace is untouched.`,
    href,
    resolved: true,
  };
}

/* ------------------------------------------------------------------ */
/* The abandoned-draft probe                                           */
/* ------------------------------------------------------------------ */

/**
 * Whether to look for work a previous guest tab left behind.
 *
 * Guest only: a workspace document is named by the URL, so its own probe runs when
 * it opens. And only while nothing is open — a probe that ran with a document loaded
 * would offer the user a different document's draft over the one they are editing.
 * Once per mount, because the answer cannot change without a document being opened,
 * and a repeated probe would re-raise an offer the user has already dismissed.
 */
export function shouldProbeAbandonedGuestDraft(input: {
  origin: "guest" | "workspace";
  hasOpenDocument: boolean;
  alreadyProbed: boolean;
}): boolean {
  return input.origin === "guest" && !input.hasOpenDocument && !input.alreadyProbed;
}

/* ------------------------------------------------------------------ */
/* The save-status trigger's accessible name                           */
/* ------------------------------------------------------------------ */

/**
 * What a screen reader says for the save-status disclosure button.
 *
 * Here rather than inline in the component for the reason at the top of this file:
 * the suite has no DOM, so a judgement left in JSX is a judgement no test runs. And
 * this one shipped wrong. In `compact` presentation the trigger's text is
 * `status.short`, and `idle`'s `short` is a bare em-dash — measured at 320px, the
 * control's entire accessible name was "—" (WCAG 4.1.2 Name, Role, Value).
 *
 * The name is the VISIBLE string plus what it leaves out, never a replacement for
 * it. That is not stylistic: five of the nine `short` forms are not substrings of
 * their own `label` ("No local save" / "Not saved on this device", "Not backed up" /
 * "Not saved — no cloud backup"), so an `aria-label` carrying the label would give a
 * visible control a name that does not contain its visible words — WCAG 2.5.3 Label
 * in Name, which is what a speech-input user relies on to say "click Saved here".
 *
 * The long form is appended only when it differs, so the wide presentation does not
 * hear its own label twice. The detail sentence is deliberately absent: it is the
 * control's DESCRIPTION (`title`), and repeating it in the name means every visit to
 * the control replays a paragraph.
 */
export function saveStatusTriggerName(
  status: { label: string; short: string },
  compact: boolean,
): string {
  const visible = compact ? status.short : status.label;
  return visible === status.label ? `${visible}, save status` : `${visible}, ${status.label}, save status`;
}
