/**
 * What a finished tool result offers the user next — one decision, both surfaces.
 *
 * The recording's merge result had a Download and a Start over and nothing else,
 * so the workflow ended there: the produced file could only re-enter the product
 * by being downloaded, found in a Downloads folder and uploaded again. The CTAs
 * that fix that have to appear on two different result surfaces (`ResultActions`
 * for the eighteen browser tools, `JobStatePanel` for the server jobs) and must
 * never disagree about which of them a given tool may show.
 *
 * So the decision lives here, as data in and flags out, and both surfaces render
 * it. Nothing below asks *which tool* — the capability record answers that, and it
 * is derived from the processors that actually produce the bytes
 * (`lib/tools/capability.ts`). A per-component action matrix is exactly how
 * `pdf-to-word` would end up offering "Open in Editor".
 */

import type { ToolCapability } from "@/lib/tools/capability";
import type { HandoffFailure } from "@/lib/workflow/handoff";
import {
  classifyWorkspaceSaveFailure,
  type WorkspaceSaveFailure,
} from "@/components/editor/standaloneShellLogic";

/**
 * Where this result could be saved, as the browser currently knows it.
 *
 *  - `loading` — the destination has not come back yet. Showing a Save button now
 *    and discovering there is nowhere to put it is worse than showing it a moment
 *    later.
 *  - `guest` — nobody is signed in. There IS an action here, and it is a truthful
 *    one: sign in. What it must not do is upload first.
 *  - `none` — signed in, but no Workspace this actor may write to. No action: a
 *    button that always fails is not an offer.
 *  - `choose` — signed in, several authorized Workspaces, none picked yet. Save
 *    cannot start: the user is a member of more than one Workspace and the product
 *    used to answer that by saving into the account default and leaving them to
 *    move the document afterwards.
 *  - `ready` — one authorized Workspace, chosen or the only one there was.
 */
export type SaveDestination = "loading" | "guest" | "none" | "choose" | "ready";

export interface ResultWorkflowInput {
  /** From `capabilityForSlug`. Null when the surface does not know its tool. */
  capability: Pick<ToolCapability, "editorOpenableOutput" | "workspaceSaveableOutput"> | null;
  /**
   * The MIME the run ACTUALLY produced, when the surface knows it.
   *
   * Checked in addition to the capability, not instead of it: the capability says
   * what the tool produces in general, this says what this run produced. Null
   * means "not reported", which is the browser tools' case — their processors are
   * all `application/pdf` and `capability.test.ts` proves it.
   */
  outputMimeType: string | null;
  /**
   * False once the bytes can no longer be fetched — a server result past its
   * expiry. Both actions need the bytes, so both go away with them rather than
   * failing when pressed.
   */
  resultAvailable: boolean;
  destination: SaveDestination;
}

export interface ResultWorkflowActionSet {
  openInEditor: boolean;
  saveToWorkspace: boolean;
  /** The truthful stand-in for Save when signed out. Never uploads. */
  signInToSave: boolean;
}

export function resultWorkflowActions(input: ResultWorkflowInput): ResultWorkflowActionSet {
  // A run that REPORTED its MIME overrides the tool's general capability, in both
  // directions and for both actions. The declared capability describes the tool;
  // the MIME describes the bytes on screen. Both save routes refuse a non-PDF
  // output (415 `UNSUPPORTED_OUTPUT`, and the `%PDF-` signature check inside
  // `WorkspaceAwareUploadService`), so a Save button offered over a reported zip
  // would be a button that cannot succeed.
  const producedPdf = input.outputMimeType === null || input.outputMimeType === PDF_MIME;
  const editable = input.capability?.editorOpenableOutput === true && producedPdf;
  // Read from its OWN capability field. `protect-pdf` is the tool that proves the
  // difference: no editor open, a real Workspace destination.
  const saveable = input.capability?.workspaceSaveableOutput === true && producedPdf;
  const usable = input.resultAvailable;
  return {
    openInEditor: usable && editable,
    saveToWorkspace: usable && saveable && input.destination === "ready",
    signInToSave: usable && saveable && input.destination === "guest",
  };
}

/**
 * Save belongs on this result but cannot start yet: the user has a destination to
 * choose.
 *
 * Asks `resultWorkflowActions` rather than re-deriving anything, so the selector
 * cannot appear for a result that would have no Save button at all — an expired
 * result, a non-PDF run, a tool whose output the Workspace does not ingest.
 */
export function awaitingDestinationChoice(input: ResultWorkflowInput): boolean {
  if (input.destination !== "choose") return false;
  return resultWorkflowActions({ ...input, destination: "ready" }).saveToWorkspace;
}

/**
 * Which destination is selected for the user before they touch anything.
 *
 * Exactly one authorized Workspace is not a choice, so making them make it is
 * friction with no decision in it. Two or more IS a choice, and it is theirs:
 * answering `null` is what keeps `destination` at `choose` and Save inert until
 * they pick. Silently preferring the account default here is the bug this whole
 * selector exists to remove.
 */
export function resolveInitialSelection(destinations: readonly ResultSaveTarget[]): string | null {
  return destinations.length === 1 ? destinations[0]!.workspaceId : null;
}

export const PDF_MIME = "application/pdf";

/** Where a signed-out user goes, and where they come back to. */
export function signInHref(toolSlug: string | null): string {
  const next = toolSlug === null ? "/tools" : `/tools/${toolSlug}`;
  return `/login?next=${encodeURIComponent(next)}`;
}

/** Where this Workspace destination writes, for the client's own fetches. */
export interface ResultSaveTarget {
  workspaceId: string;
  organizationId: string;
  workspaceName: string;
}

/** The page a saved result links to. The document when known, else the Workspace. */
export function savedDocumentHref(target: ResultSaveTarget, documentId: string | null): string {
  const org = `organizationId=${encodeURIComponent(target.organizationId)}`;
  const workspace = `/workspaces/${encodeURIComponent(target.workspaceId)}`;
  return documentId === null
    ? `${workspace}?${org}`
    : `${workspace}/documents/${encodeURIComponent(documentId)}?${org}`;
}

/**
 * The save's own state. `saved` carries the document, which is what makes a
 * second press an "Open document" link rather than a second upload.
 */
export type ResultSaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; documentId: string | null; href: string }
  | { kind: "error"; message: string };

/**
 * Copy for a failed save of a RESULT (not of an editing session).
 *
 * The classification is `classifyWorkspaceSaveFailure` — the same one the editor's
 * Workspace save uses, because the statuses come from the same routes. Only the
 * sentences differ, and they differ in the one way that matters: the user's file
 * is still downloadable from the page they are standing on, so every message says
 * so instead of promising their edits are safe.
 */
export function resultSaveFailureMessage(failure: WorkspaceSaveFailure): string {
  switch (failure) {
    case "unauthorized":
      return "You are not signed in to a Workspace that can store this file. Sign in again, or download it instead.";
    case "too_large":
      return "This file is too large to store in your Workspace. Download it instead.";
    case "conflict":
      return "Your Workspace rejected this save. Download the file, then try again.";
    case "unknown":
      return "Could not save to your Workspace. Your file is still ready to download.";
  }
}

/** Classifies a failed save response. Re-exported so surfaces need one import. */
export function classifyResultSaveFailure(
  status: number,
  code: string | null,
): WorkspaceSaveFailure {
  return classifyWorkspaceSaveFailure(status, code);
}

/**
 * Copy for a result that could not be handed to the editor.
 *
 * Only the producing side's failures are reachable here — the handoff is written
 * and then navigated to, so it cannot be `missing` or `expired` yet. Both messages
 * point at the download, which is the thing that still works.
 */
export function openInEditorFailureMessage(failure: HandoffFailure): string {
  switch (failure) {
    case "too_large":
      return "This file is too large to open directly in the editor. Download it and open it from your device.";
    case "unavailable":
      return "This browser is not allowing local storage for this site, so the file cannot be handed to the editor. Download it and open it there instead.";
    case "missing":
    case "expired":
      return "Could not open this file in the editor. Download it and open it there instead.";
  }
}

/**
 * What "already saved" means for a result: the SAME document, not a second one.
 *
 * A result's bytes never change after the run, so a second press of Save has
 * nothing new to store. The server agrees independently and durably: a result
 * save is identified by `(workspaceId, sha256(bytes))`, which is the unique
 * `DocumentIngestion` index — so a retry after a lost response finds the row,
 * and two concurrent requests collide on it and converge on the one document
 * that won. Both halves are wanted, and only one of them is load-bearing: this
 * one keeps a second click from costing an upload, that one keeps a
 * double-submit, a remounted page or a restarted process from costing a
 * document. See `src/application/services/resultSaveIdempotency.test.ts`.
 */
export function shouldStartSave(state: ResultSaveState): boolean {
  return state.kind === "idle" || state.kind === "error";
}
