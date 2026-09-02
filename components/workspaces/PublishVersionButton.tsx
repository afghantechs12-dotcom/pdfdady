"use client";

import { useCallback, useRef, useState } from "react";
import { CloudUpload, Loader2 } from "lucide-react";
import type { EditorSurfaceHandle } from "@/components/editor/EditorWorkspace";
import {
  commitToWorkspace,
  workspaceSaveFailureMessage,
} from "@/components/editor/standaloneShellLogic";
import { WorkspaceSaveError, saveWorkspaceVersion } from "@/components/editor/workspacePublish";
import { outputFileName } from "@/lib/workflow/fileNames";
import type { SaveStatusView } from "@/src/application/editor/persistence/derivedStatus";

/**
 * "Publish version" for a document the Workspace already holds.
 *
 * The gap this closes: the workbench mounted the editor with no `handleRef`, so
 * `exportBytes` and `noteVersionCommitted` were unreachable and a Workspace
 * document could be edited, autosaved as a draft, and never published as a
 * version. The editor was not missing the ability — the surrounding chrome was
 * missing the wire.
 *
 * NO SECOND SAVE SYSTEM. Everything below is a port assignment: the ordering rule
 * lives in `commitToWorkspace`, the two requests in `workspacePublish`, the
 * durability watermarks in the Phase 2/3 coordinator, and the failure copy in
 * `standaloneShellLogic`. That is the same stack the standalone editor's "Save to
 * Workspace" runs on, so the two surfaces cannot drift on what a published version
 * means or which revision it was fenced against.
 *
 * What is different here, and is the whole reason this exists separately: the
 * document ID is KNOWN. `existingDocumentId` always answers, so the create branch
 * is unreachable — a publish from the workbench cannot produce a second Workspace
 * document for a document that is already in it.
 */

/** The facts a publish control needs, all scoped to ONE document. */
interface PublishSession {
  /**
   * The document `status` and `publishing` describe.
   *
   * Carried in state rather than assumed, because a pane outlives its tabs: the
   * editor is keyed on the tab and remounts, this hook does not. Without the
   * comparison, a tab switch would leave the previous document's "ready" and
   * "Publishing…" on a button that now points somewhere else — and "ready" is what
   * stands between a click and exporting a blank canvas over a real document.
   */
  documentId: string;
  /** The canonical save projection, or null before the editor has reported one. */
  status: SaveStatusView | null;
  publishing: boolean;
}

export interface WorkspacePublish {
  /** Give this to the editor's `handleRef`. */
  surfaceRef: React.MutableRefObject<EditorSurfaceHandle | null>;
  /** Give this to the editor's `onSaveStatusChange`. */
  onSaveStatus: (status: SaveStatusView | null) => void;
  /** True once THIS document is open and armed, per the canonical projection. */
  ready: boolean;
  publishing: boolean;
  publish: () => void;
}

export function useWorkspacePublish(input: {
  workspaceId: string;
  organizationId: string;
  documentId: string;
  documentName: string;
  /** Where a failure is reported. The workbench already owns an alert banner. */
  onFailure: (message: string) => void;
}): WorkspacePublish {
  const { workspaceId, organizationId, documentId, documentName, onFailure } = input;
  const surfaceRef = useRef<EditorSurfaceHandle | null>(null);
  /*
   * The double-click guard, in a ref rather than derived from state: two clicks in
   * one tick both read the same rendered state, and the second would issue a second
   * version of identical bytes. A ref is written before the first await.
   */
  const inFlightRef = useRef(false);
  const [session, setSession] = useState<PublishSession>({
    documentId,
    status: null,
    publishing: false,
  });

  // Null when the state describes a document this control is no longer pointed at.
  const live = session.documentId === documentId ? session : null;

  const onSaveStatus = useCallback(
    (status: SaveStatusView | null) =>
      setSession((prev) =>
        prev.documentId === documentId
          ? { ...prev, status }
          : { documentId, status, publishing: false },
      ),
    [documentId],
  );

  const publish = useCallback(() => {
    const surface = surfaceRef.current;
    if (surface === null || inFlightRef.current) return;
    inFlightRef.current = true;
    setSession((prev) => ({
      documentId,
      status: prev.documentId === documentId ? prev.status : null,
      publishing: true,
    }));

    /*
     * The DOCUMENT's name through the canonical policy, so a document called
     * `report.pdf` publishes `report.pdf` and not `report.pdf.pdf`. No suffix: a
     * new version of a document is not a new kind of file.
     */
    const fileName = outputFileName({ sources: [documentName], ext: "pdf" });
    // A fresh copy: exported bytes may be a view over a larger buffer, and Blob
    // would otherwise serialise the whole backing store.
    const asBlob = (bytes: Uint8Array) =>
      new Blob([new Uint8Array(bytes)], { type: "application/pdf" });

    void (async () => {
      try {
        await commitToWorkspace({
          exportBytes: () => surface.exportBytes(),
          // Always known, which is what makes the create branch unreachable.
          existingDocumentId: () => documentId,
          create: () => {
            // Not a fallback. A workbench publish that reached this would be
            // creating a duplicate of the document it is editing, and failing is
            // the only correct outcome.
            throw new Error("a workbench publish never creates a document");
          },
          commit: (id, bytes, scene, sourceBytes) =>
            saveWorkspaceVersion({ workspaceId, organizationId }, id, {
              output: asBlob(bytes),
              fileName,
              // The canonical envelope, stringified and nothing more: no object-type
              // knowledge lives in this file.
              scene: JSON.stringify(scene),
              source: sourceBytes === null ? null : asBlob(sourceBytes),
            }),
          onDocumentCreated: () => {},
          /*
           * The surface captured before the export, not `surfaceRef.current` when
           * the response lands: the user may have switched tabs, and telling a
           * different document's machine that a version was committed would move a
           * watermark over work that was never published.
           */
          noteVersionCommitted: (committed) => surface.noteVersionCommitted(committed),
        });
      } catch (error) {
        /*
         * The diagnostic goes to the console; the banner gets bounded copy, reusing
         * the standalone shell's classified messages so a conflict reads the same in
         * both surfaces. Nothing about the document reaches either.
         *
         * Nothing is marked published. A failure that advanced a watermark is the
         * one error direction that produces a false "saved", and the editing state
         * is left exactly as it was — the edits are still on screen, still dirty,
         * and the same button retries.
         */
        console.error("Publish version failed", error);
        onFailure(
          error instanceof WorkspaceSaveError
            ? workspaceSaveFailureMessage(error.failure)
            : workspaceSaveFailureMessage("unknown"),
        );
      } finally {
        inFlightRef.current = false;
        setSession((prev) =>
          prev.documentId === documentId ? { ...prev, publishing: false } : prev,
        );
      }
    })();
  }, [documentId, documentName, workspaceId, organizationId, onFailure]);

  return {
    surfaceRef,
    onSaveStatus,
    /*
     * `idle` is the canonical projection's "nothing is open" — it is the state a
     * mounted editor reports until its load finishes and arms persistence. Gating
     * on it is what stops a click during load from exporting the editor's default
     * blank page and publishing it as a version of a real document.
     */
    ready: live?.status != null && live.status.kind !== "idle",
    publishing: live?.publishing === true,
    publish,
  };
}

/**
 * The control itself. Deliberately has no success state: a published version is
 * reported by the canonical save readout inside the editor ("saved to your
 * workspace as version N"), which is the same projection the tab's unsaved dot and
 * the status bar read. A local "Published!" watermark beside it would be a second
 * answer to "is my work safe", which is the defect this codebase already paid for
 * once.
 */
export function PublishVersionButton({ publish }: { publish: WorkspacePublish }) {
  return (
    <button
      type="button"
      onClick={publish.publish}
      disabled={!publish.ready || publish.publishing}
      // Named unconditionally: the label is hidden on narrow layouts, and an
      // icon-only button whose only name is a tooltip has no name at all to a
      // screen reader that never hovers.
      aria-label={publish.publishing ? "Publishing version" : "Publish version"}
      title={
        publish.ready
          ? "Save your edits as a new version of this document"
          : "Available once the document has finished opening"
      }
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control bg-primary px-2.5 text-[12px] font-semibold text-white transition-colors hover:bg-primary-hover disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      {publish.publishing ? (
        <Loader2 size={13} aria-hidden="true" className="animate-spin" />
      ) : (
        <CloudUpload size={13} aria-hidden="true" />
      )}
      <span className="hidden sm:inline">
        {publish.publishing ? "Publishing…" : "Publish version"}
      </span>
    </button>
  );
}
