"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, FilePlus2, FolderOpen, Loader2, RefreshCw, Upload } from "lucide-react";
import { LogoMark } from "@/components/layout/Logo";
import { DocumentIdentity } from "@/components/editor/DocumentIdentity";
import { EditorWorkspace, type EditorSurfaceHandle } from "@/components/editor/EditorWorkspace";
import {
  GUEST_SAVE_SIGNUP_HREF,
  commitToWorkspace,
  documentTitle,
  handoffFailureMessage,
  resolveStage,
  shellActions,
  viewerInitials,
  workspaceSaveFailureMessage,
  type ShellViewer,
} from "@/components/editor/standaloneShellLogic";
import {
  WorkspaceSaveError,
  createWorkspaceDocument,
  saveWorkspaceVersion,
} from "@/components/editor/workspacePublish";
import { outputFileName } from "@/lib/workflow/fileNames";
import {
  HANDOFF_QUERY_PARAM,
  HandoffError,
  claimHandoff,
  handoffFile,
  type HandoffFailure,
} from "@/lib/workflow/handoff";
import type { SaveStatusView } from "@/src/application/editor/persistence/derivedStatus";

/** Where "Save to Workspace" writes. */
interface SaveTarget {
  workspaceId: string;
  organizationId: string;
  workspaceName: string;
}

export interface StandaloneEditorShellProps {
  viewer: ShellViewer;
  /** Null when the viewer has no Workspace to save to. */
  saveTarget: SaveTarget | null;
}

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; href: string }
  | { kind: "error"; message: string };

/**
 * The standalone `/editor` chrome: a lightweight branded shell around the same
 * {@link EditorWorkspace} the Workspace workbench mounts.
 *
 * Deliberately NOT the authenticated `AppShell`. That shell carries a workspace
 * switcher, the document navigation rail and a settings route — none of which
 * mean anything for a local file a guest opened, and mounting it here would pull
 * Workspace bundles onto a route guests reach from `/tools`. What was actually
 * missing was identity and a way back, so that is what this adds.
 */
export function StandaloneEditorShell({ viewer, saveTarget }: StandaloneEditorShellProps) {
  const [dismissed, setDismissed] = useState(false);
  const [local, setLocal] = useState<{ fileName: string; hasDocument: boolean }>({
    fileName: "",
    hasDocument: false,
  });
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  /**
   * The canonical save status, as the editor computes it. Mirrored here only so the
   * app bar's pill can render it; nothing in this file interprets it.
   *
   * It used to be assembled here instead, out of `dirty` plus a revision watermark
   * plus the last completed export — a second opinion on the most consequential
   * sentence in the product, and the one that put "Unsaved changes" in the app bar
   * while the status bar said "Saved on this device". There is one model now.
   */
  const [status, setStatus] = useState<SaveStatusView | null>(null);
  /**
   * The Workspace document this editing session owns, once it has one.
   *
   * THE FIX FOR DUPLICATE DOCUMENTS. Every "Save to Workspace" used to POST
   * `documents/upload`, which always creates a DocumentRecord, so a second save of
   * the same session produced a second `Untitled PDF.pdf`. The first save now
   * records the document it created and every later save writes a new VERSION of
   * it.
   *
   * A ref, not state: it is written immediately after the create resolves, so a
   * click that arrives before React has re-rendered still sees it and updates
   * rather than creating.
   */
  const workspaceDocumentRef = useRef<string | null>(null);
  /**
   * A rename applied in the app bar. The editor owns the authoritative filename
   * (it feeds export naming), so this only mirrors it for the title; `null` means
   * "no rename yet, use whatever the editor reported".
   */
  const [renamed, setRenamed] = useState<string | null>(null);
  const handleRef = useRef<EditorSurfaceHandle | null>(null);
  /**
   * The banner shown when a tool result could not be opened.
   *
   * Its own state, not a `SaveState`: the failure of an incoming handoff has
   * nothing to retry here (the bytes are on the page the user came from), so
   * folding it into the save banner would offer a Retry that saves an empty editor.
   */
  const [handoffError, setHandoffError] = useState<string | null>(null);
  /**
   * Guards the claim against React's double-invoked mount effect.
   *
   * A handoff is consumed once by design, so a second claim in the same mount
   * finds nothing and would report "that result is no longer waiting" over a
   * document that had just opened correctly.
   */
  const handoffClaimedRef = useRef(false);

  /*
   * THE RECEIVING END of `tool result → editor`. The id in the URL is a key into
   * this browser's own IndexedDB, so the bytes never entered a URL, a history
   * entry, or a server: opening a local tool's result stays as local as producing
   * it was.
   *
   * `window.location` rather than `useSearchParams`, because this reads the query
   * exactly once on mount and reading the hook would put the whole route behind a
   * Suspense boundary for a value nothing renders.
   */
  useEffect(() => {
    if (handoffClaimedRef.current) return;
    const id = new URLSearchParams(window.location.search).get(HANDOFF_QUERY_PARAM);
    if (!id) return;
    handoffClaimedRef.current = true;
    /*
     * The param goes before the claim resolves. It has already been consumed from
     * the database, so leaving it in the address bar would make a reload report a
     * missing handoff — and would leave a URL the user could bookmark that can
     * never work again.
     */
    window.history.replaceState(null, "", window.location.pathname);
    void (async () => {
      try {
        const handoff = await claimHandoff(id);
        await handleRef.current?.openFile(handoffFile(handoff));
      } catch (error) {
        // No document detail is logged: a failed handoff says which category
        // failed, never what the file was.
        const failure: HandoffFailure = error instanceof HandoffError ? error.failure : "missing";
        setHandoffError(handoffFailureMessage(failure));
      }
    })();
  }, []);

  const stage = resolveStage({ dismissed, hasDocument: local.hasDocument });
  const actions = shellActions(viewer, stage, saveTarget !== null);
  const title = documentTitle(renamed ?? local.fileName);

  const onRename = (name: string) => {
    // The editor is told first: it owns the name that becomes the export
    // filename, so a title that updated without it would drift from the file the
    // user actually downloads.
    handleRef.current?.rename(name);
    setRenamed(name);
  };

  const openPdf = () => handleRef.current?.openPdf();

  const onSaveToWorkspace = async () => {
    if (!saveTarget || !handleRef.current || save.kind === "saving") return;
    setSave({ kind: "saving" });
    const surface = handleRef.current;
    /*
     * The DOCUMENT's name, not the displayed title: `documentTitle` substitutes
     * "Untitled PDF" for a document with no name, and appending `.pdf` to that
     * produced the `Untitled PDF.pdf` rows the Workspace list could not tell
     * apart. The policy supplies the untitled base and the single extension.
     */
    const fileName = outputFileName({ sources: [renamed ?? local.fileName], ext: "pdf" });
    // A fresh Uint8Array copy: the exported bytes may be a view over a larger
    // buffer, and Blob would otherwise serialise the whole backing store.
    const asBlob = (bytes: Uint8Array) =>
      new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
    try {
      /*
       * The orchestration lives in `standaloneShellLogic` so the rule that matters
       * — the committed revision is the one exported, not the one on screen when the
       * response lands — is enforced somewhere a Node test can drive it. This file
       * supplies the ports and nothing else.
       */
      await commitToWorkspace({
        exportBytes: () => surface.exportBytes(),
        existingDocumentId: () => workspaceDocumentRef.current,
        create: (bytes) => createWorkspaceDocument(saveTarget, asBlob(bytes), fileName),
        commit: (documentId, bytes, scene, sourceBytes) =>
          saveWorkspaceVersion(saveTarget, documentId, {
            output: asBlob(bytes),
            fileName,
            /*
             * The canonical envelope, stringified and nothing more. No object-type
             * knowledge lives in this file — the editor serialized it, the server
             * checks it is structurally a scene, and the editor's own codec is the
             * only thing that ever interprets it.
             */
            scene: JSON.stringify(scene),
            source: sourceBytes === null ? null : asBlob(sourceBytes),
          }),
        onDocumentCreated: (documentId) => {
          workspaceDocumentRef.current = documentId;
        },
        noteVersionCommitted: (committed) => surface.noteVersionCommitted(committed),
      });
      const documentId = workspaceDocumentRef.current;
      setSave({
        kind: "saved",
        href:
          documentId === null
            ? `/workspaces/${encodeURIComponent(saveTarget.workspaceId)}?organizationId=${encodeURIComponent(saveTarget.organizationId)}`
            : `/workspaces/${encodeURIComponent(saveTarget.workspaceId)}/documents/${encodeURIComponent(documentId)}?organizationId=${encodeURIComponent(saveTarget.organizationId)}`,
      });
    } catch (error) {
      /*
       * The diagnostic goes to the console; the banner gets bounded copy. Nothing
       * about the document reaches either — no bytes, no text, no object contents.
       *
       * `workspaceDocumentRef` is NOT cleared here, and that is the important half:
       * a failed save of an existing document must still target the SAME document
       * when the user retries, or every failure would leave a duplicate behind on
       * the next attempt. Nor is anything marked saved — a failure that advanced a
       * watermark is the one error direction that produces a FALSE SAFE.
       */
      console.error("Save to Workspace failed", error);
      setSave({
        kind: "error",
        message:
          error instanceof WorkspaceSaveError
            ? workspaceSaveFailureMessage(error.failure)
            : workspaceSaveFailureMessage("unknown"),
      });
    }
  };

  return (
    <EditorWorkspace
      handleRef={handleRef}
      onLocalDocumentChange={setLocal}
      onSaveStatusChange={setStatus}
      appHeader={
        <>
          {/* The branded standalone chrome becomes the frame's app-header slot:
              the same application shell, with standalone-specific actions.

              P2 CONTROL RHYTHM. Every interactive child of this bar is `h-8`.
              Measured before: the logo link 26px, "Tools" 32px, "Open PDF" 34px,
              the avatar 28px — four baselines in one 51px row, which is the
              difference between an application bar and a marketing navbar. The
              32px height is the same rhythm the Inspector's controls use, so the
              two halves of the chrome agree. The tool row keeps its own taller
              38px/44px rhythm on purpose: those are drawing targets, not chrome. */}
          <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-editor-border bg-editor-surface px-3 py-2 sm:px-4">
            <Link
              href="/"
              aria-label="PDFDadi home"
              className="flex h-8 shrink-0 items-center gap-2 rounded-control focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/50"
            >
              <LogoMark size={26} />
              <span className="hidden text-[15px] font-bold tracking-tight text-navy sm:inline">
                PDF
                <span className="bg-gradient-to-r from-primary to-aipink bg-clip-text text-transparent">
                  Dadi
                </span>
              </span>
            </Link>

            <span aria-hidden="true" className="hidden h-5 w-px bg-editor-border sm:block" />

            <Link
              href="/tools"
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control px-2 text-[13px] font-medium text-editor-muted transition-colors hover:bg-editor-subtle hover:text-editor-text focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/50"
            >
              <ArrowLeft size={15} aria-hidden="true" />
              Tools
            </Link>

            <div className="order-last min-w-0 flex-1 basis-full sm:order-none sm:basis-auto">
              <DocumentIdentity
                name={title}
                // Rename is offered only once a document is actually being
                // edited: naming the onboarding placeholder would imply the
                // blank page is a document the visitor chose to create.
                onRename={stage === "editing" ? onRename : undefined}
                hint={stage === "onboarding" ? "· nothing opened yet" : undefined}
                status={status}
              />
            </div>

            <div className="ml-auto flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={openPdf}
                className="inline-flex h-8 items-center gap-1.5 rounded-control border border-editor-border bg-editor-surface px-2.5 text-[13px] font-semibold text-editor-text transition-colors hover:bg-editor-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/50"
              >
                <FolderOpen size={15} aria-hidden="true" />
                <span className="hidden sm:inline">Open PDF</span>
              </button>

              {actions.saveToWorkspace && saveTarget ? (
                <button
                  type="button"
                  onClick={onSaveToWorkspace}
                  disabled={save.kind === "saving"}
                  className="inline-flex h-8 items-center gap-1.5 rounded-control bg-editor-accent px-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-editor-accenthover disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/50"
                >
                  {save.kind === "saving" ? (
                    <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Upload size={15} aria-hidden="true" />
                  )}
                  <span className="hidden sm:inline">
                    {save.kind === "saving" ? "Saving…" : "Save to Workspace"}
                  </span>
                </button>
              ) : null}

              {actions.guestSaveUpsell ? (
                <Link
                  href={GUEST_SAVE_SIGNUP_HREF}
                  className="inline-flex h-8 items-center gap-1.5 rounded-control bg-editor-accent px-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-editor-accenthover focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/50"
                >
                  <Upload size={15} aria-hidden="true" />
                  <span className="hidden sm:inline">Save to a free Workspace</span>
                  <span className="sm:hidden">Save</span>
                </Link>
              ) : null}

              {viewer.email ? (
                <Link
                  href="/workspaces"
                  title={viewer.email}
                  aria-label={`Signed in as ${viewer.email}. Go to your Workspaces`}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-editor-accentsoft text-[11px] font-bold text-editor-accent transition-colors hover:bg-primary-softhover focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/50"
                >
                  {viewerInitials(viewer)}
                </Link>
              ) : (
                <Link
                  href="/login?next=%2Feditor"
                  className="hidden h-8 items-center rounded-control px-2 text-[13px] font-medium text-editor-muted transition-colors hover:bg-editor-subtle hover:text-editor-text focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/50 sm:inline-flex"
                >
                  Sign in
                </Link>
              )}
            </div>
          </header>

          {handoffError ? (
            <div
              role="alert"
              className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900"
            >
              <span>{handoffError}</span>
              <button
                type="button"
                onClick={() => setHandoffError(null)}
                className="shrink-0 font-semibold underline focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/50"
              >
                Dismiss
              </button>
            </div>
          ) : null}

          {save.kind === "saved" || save.kind === "error" ? (
            <div
              // A failure is `alert`, a success is `status`: the outcome of an
              // explicit save is exactly the kind of transition that should
              // interrupt, and the retry lives in this banner.
              role={save.kind === "error" ? "alert" : "status"}
              className={`flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2 text-sm ${
                save.kind === "saved"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-red-200 bg-red-50 text-red-700"
              }`}
            >
              <span>
                {save.kind === "saved" ? "Saved to your Workspace." : save.message}
              </span>
              <span className="flex shrink-0 items-center gap-3">
                {save.kind === "saved" ? (
                  <Link href={save.href} className="font-semibold underline">
                    Open it
                  </Link>
                ) : (
                  /*
                    A real Retry: it calls the SAME `onSaveToWorkspace` the button
                    does, so there is exactly one persistence implementation and
                    one watermark rule. The shipped banner offered only Dismiss,
                    which left the user to hunt for the original button.

                    `disabled` while saving is what makes "one click, one retry"
                    true — a second click cannot start a concurrent upload, so no
                    duplicate document is created.
                  */
                  <button
                    type="button"
                    onClick={onSaveToWorkspace}
                    disabled={save.kind !== "error"}
                    className="inline-flex items-center gap-1 font-semibold underline focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/50 disabled:opacity-60"
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    Retry
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setSave({ kind: "idle" })}
                  className="font-semibold underline focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/50"
                >
                  Dismiss
                </button>
              </span>
            </div>
          ) : null}
        </>
      }
      canvasOverlay={
        stage === "onboarding" ? (
          <EditorEmptyState
            onOpen={openPdf}
            onBlank={() => {
              // Arms autosave for the blank page that is already on screen — from
              // this click it is the visitor's document. Dismissing the overlay is
              // the only other thing that happens, because there is nothing to
              // load; without the first call this is the one editing surface in the
              // product with no draft behind it, and the save readout would sit in
              // the status bar honestly saying "No document" while they work.
              handleRef.current?.startBlankDocument();
              setDismissed(true);
            }}
          />
        ) : null
      }
    />
  );
}

/**
 * The first-run state, drawn over the canvas.
 *
 * The blank A4 page behind it is real and already loaded, which is why "Create
 * blank PDF" only dismisses this overlay — there is no second document model and
 * no fake workflow to keep in sync.
 */
function EditorEmptyState({ onOpen, onBlank }: { onOpen: () => void; onBlank: () => void }) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/92 px-6 backdrop-blur-[1px]">
      <div className="w-full max-w-sm text-center">
        <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-panel bg-primary-soft text-primary">
          <FilePlus2 size={22} aria-hidden="true" />
        </span>
        <h2 className="text-lg font-bold tracking-tight text-app-text">Start editing</h2>
        <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-app-muted">
          Open an existing PDF or start with a blank document.
        </p>
        <div className="mt-6 flex flex-col items-stretch gap-2 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={onOpen}
            className="inline-flex items-center justify-center gap-2 rounded-control bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            <FolderOpen size={16} aria-hidden="true" />
            Open PDF
          </button>
          <button
            type="button"
            onClick={onBlank}
            className="inline-flex items-center justify-center gap-2 rounded-control border border-app-border bg-white px-4 py-2.5 text-sm font-semibold text-app-text transition-colors hover:bg-app-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            <FilePlus2 size={16} aria-hidden="true" />
            Create blank PDF
          </button>
        </div>
        <p className="mt-5 text-xs leading-relaxed text-app-muted">
          Your file is edited in your browser. Nothing is uploaded until you save
          it to a Workspace.
        </p>
        <Link
          href="/tools"
          className="mt-3 inline-flex min-h-6 items-center text-xs font-semibold text-primary underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          Or pick a single-purpose tool
        </Link>
      </div>
    </div>
  );
}
