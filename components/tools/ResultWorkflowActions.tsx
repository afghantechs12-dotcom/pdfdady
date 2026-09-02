"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink, FolderOpen, Loader2, LogIn, Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { capabilityForSlug } from "@/lib/tools/capability";
import { HandoffError, createHandoff, sweepHandoffs } from "@/lib/workflow/handoff";
import {
  awaitingDestinationChoice,
  classifyResultSaveFailure,
  openInEditorFailureMessage,
  resolveInitialSelection,
  resultSaveFailureMessage,
  resultWorkflowActions,
  savedDocumentHref,
  shouldStartSave,
  signInHref,
  type ResultSaveState,
  type ResultSaveTarget,
  type SaveDestination,
} from "@/components/tools/resultWorkflow";

export interface ResultWorkflowActionsProps {
  /** The canonical tool slug. Null when the surface cannot name its tool. */
  toolSlug: string | null;
  /** The produced filename — already through the naming policy. */
  fileName: string;
  /** The input names, for provenance. Never their contents. */
  sourceFileNames?: readonly string[];
  /** The MIME the run produced, when the surface knows it. */
  outputMimeType?: string | null;
  /** False once a server result has expired. Both actions need the bytes. */
  resultAvailable?: boolean;
  /**
   * The result's bytes, fetched only when an action needs them.
   *
   * Lazy on purpose: a browser tool already holds them, and a server tool would
   * otherwise download every result the moment it finished, whether or not the
   * user wanted anything but the file on their disk.
   */
  loadBytes: () => Promise<Uint8Array>;
  /**
   * Persists this result into the given Workspace and answers with the route's
   * response.
   *
   * Injected because the two surfaces persist DIFFERENTLY and pretending otherwise
   * would be the expensive kind of shared abstraction: a browser tool uploads the
   * bytes it holds, while a server job's output is copied storage-to-storage on the
   * server and never passes through the browser at all.
   */
  save: (target: ResultSaveTarget) => Promise<Response>;
}

/**
 * `Open in Editor` and `Save to Workspace` for a finished result — the same two
 * buttons, the same words, on every result surface in the product.
 *
 * Every condition comes from `resultWorkflowActions`, which reads the tool's
 * capability record. Nothing here asks which tool it is: that is what put
 * "Open in Editor" one careless commit away from appearing on `pdf-to-word`.
 *
 * WHAT THIS DOES NOT DO. It does not upload anything until the user presses Save.
 * A browser tool's result reaches the editor through this browser's own IndexedDB,
 * so choosing `Open in Editor` on a local result sends nothing to a server — the
 * privacy promise on the tool page stays true through the whole workflow.
 */
export function ResultWorkflowActions({
  toolSlug,
  fileName,
  sourceFileNames = [],
  outputMimeType = null,
  resultAvailable = true,
  loadBytes,
  save,
}: ResultWorkflowActionsProps) {
  const router = useRouter();
  const selectId = useId();
  const capability = toolSlug === null ? null : capabilityForSlug(toolSlug);
  /**
   * What the session lookup found, before the user's own choice is applied.
   *
   * `ready` here means "signed in, with somewhere to save" — not "a destination is
   * settled". Which of those it is comes from `selectedWorkspaceId` below.
   */
  const [lookup, setLookup] = useState<SaveDestination>("loading");
  const [destinations, setDestinations] = useState<readonly ResultSaveTarget[]>([]);
  const [defaultWorkspaceId, setDefaultWorkspaceId] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<ResultSaveState>({ kind: "idle" });
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  /**
   * Guards the upload against a double click.
   *
   * A ref, not `saveState`: it is set synchronously inside the handler, so a second
   * click that lands before React has re-rendered still sees it. The server
   * deduplicates by content checksum as well — this only keeps the second click
   * from costing an upload.
   */
  const savingRef = useRef(false);

  const workspaceSaveable = capability?.workspaceSaveableOutput === true;

  /*
   * The destination is asked for ONLY by a surface that could use it. A tool whose
   * output is not Workspace-saveable makes no session call at all, so a public,
   * statically-rendered tool page does not acquire an authentication round trip
   * because a result appeared on it.
   */
  useEffect(() => {
    if (!workspaceSaveable) {
      setLookup("none");
      return;
    }
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/workflow/save-target", {
          headers: { Accept: "application/json" },
        });
        if (!live) return;
        const body = (await res.json().catch(() => null)) as
          | {
              authenticated?: boolean;
              destinations?: ResultSaveTarget[];
              defaultWorkspaceId?: string | null;
            }
          | null;
        if (!live) return;
        if (!res.ok || body?.authenticated !== true) {
          setLookup("guest");
          return;
        }
        const offered = body.destinations ?? [];
        if (offered.length === 0) {
          setLookup("none");
          return;
        }
        setDestinations(offered);
        setDefaultWorkspaceId(body.defaultWorkspaceId ?? null);
        // One Workspace is not a choice. Several are, and the user makes it:
        // `null` here is what holds Save inert until they do.
        setSelectedWorkspaceId(resolveInitialSelection(offered));
        setLookup("ready");
      } catch {
        // A failed lookup is not a signed-out user: claiming they must sign in
        // would be a guess. No destination, download still offered.
        if (live) setLookup("none");
      }
    })();
    return () => {
      live = false;
    };
  }, [workspaceSaveable]);

  /*
   * The chosen destination, looked up in the list the SERVER authorized. A
   * `workspaceId` this browser did not receive from `/api/workflow/save-target`
   * cannot become a target here — and both save routes re-authorize the one that
   * does, because a selection is client input either way.
   */
  const target = destinations.find((d) => d.workspaceId === selectedWorkspaceId) ?? null;
  const destination: SaveDestination = lookup === "ready" && target === null ? "choose" : lookup;
  const workflowInput = { capability, outputMimeType, resultAvailable, destination };
  const actions = resultWorkflowActions(workflowInput);
  /** Save belongs here, but the user has a Workspace to pick first. */
  const choosing = awaitingDestinationChoice(workflowInput);

  const onOpenInEditor = async () => {
    if (opening) return;
    setOpening(true);
    setOpenError(null);
    try {
      const bytes = await loadBytes();
      const id = await createHandoff({
        fileName,
        bytes,
        provenance: {
          toolSlug,
          sourceFileNames: [...sourceFileNames],
          workspaceId: null,
          sourceDocumentId: null,
        },
      });
      // Opportunistic, unawaited: clearing out results nobody claimed is not
      // something the user should wait for on their way to the editor.
      void sweepHandoffs().catch(() => {});
      router.push(`/editor?handoff=${encodeURIComponent(id)}`);
    } catch (error) {
      setOpening(false);
      setOpenError(
        openInEditorFailureMessage(error instanceof HandoffError ? error.failure : "missing"),
      );
    }
  };

  const onSave = async () => {
    if (!target || savingRef.current || !shouldStartSave(saveState)) return;
    savingRef.current = true;
    setSaveState({ kind: "saving" });
    try {
      const res = await save(target);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { code?: string } }
          | null;
        setSaveState({
          kind: "error",
          message: resultSaveFailureMessage(
            classifyResultSaveFailure(res.status, body?.error?.code ?? null),
          ),
        });
        return;
      }
      const body = (await res.json().catch(() => null)) as
        | { document?: { id?: string } }
        | null;
      const documentId = body?.document?.id ?? null;
      setSaveState({
        kind: "saved",
        documentId,
        href: savedDocumentHref(target, documentId),
      });
    } catch (error) {
      // The diagnostic, never the document: no filename, no bytes, no response body.
      console.error("Save result to Workspace failed", error);
      setSaveState({ kind: "error", message: resultSaveFailureMessage("unknown") });
    } finally {
      savingRef.current = false;
    }
  };

  if (!actions.openInEditor && !actions.saveToWorkspace && !actions.signInToSave && !choosing) {
    return null;
  }

  return (
    <div className="flex w-full flex-col items-center gap-3">
      {/*
       * The destination choice, shown only when there IS one. A single authorized
       * Workspace is already selected, so the selector would be a control with one
       * option and no decision in it.
       *
       * A native `<select>` with a real `<label htmlFor>`: keyboard and screen
       * reader behaviour come from the platform rather than from a custom listbox
       * this panel would have to get right. Only the Workspace NAME is shown — the
       * ids the save routes need travel in the request, not on screen.
       */}
      {destinations.length > 1 && (actions.saveToWorkspace || choosing) && saveState.kind !== "saved" ? (
        <div className="w-full max-w-xs text-left">
          <label htmlFor={selectId} className="mb-1.5 block text-sm font-medium text-navy">
            Save to which Workspace?
          </label>
          <select
            id={selectId}
            value={selectedWorkspaceId ?? ""}
            onChange={(event) => setSelectedWorkspaceId(event.target.value || null)}
            disabled={saveState.kind === "saving"}
            className="h-11 w-full rounded-button border border-softborder bg-white px-3 text-navy focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            <option value="">Choose a Workspace…</option>
            {destinations.map((destinationOption) => (
              <option key={destinationOption.workspaceId} value={destinationOption.workspaceId}>
                {destinationOption.workspaceName}
                {destinationOption.workspaceId === defaultWorkspaceId ? " (default)" : ""}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row">
        {actions.openInEditor ? (
          <Button
            size="lg"
            variant="outline"
            leadingIcon={
              opening ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <FolderOpen size={16} />
              )
            }
            onClick={onOpenInEditor}
            disabled={opening}
          >
            {opening ? "Opening…" : "Open in Editor"}
          </Button>
        ) : null}

        {(actions.saveToWorkspace || choosing) && saveState.kind !== "saved" ? (
          <Button
            size="lg"
            variant="outline"
            leadingIcon={
              saveState.kind === "saving" ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Upload size={16} />
              )
            }
            onClick={onSave}
            disabled={choosing || saveState.kind === "saving"}
          >
            {saveState.kind === "saving" ? "Saving…" : "Save to Workspace"}
          </Button>
        ) : null}

        {actions.signInToSave ? (
          <Button
            href={signInHref(toolSlug)}
            size="lg"
            variant="outline"
            leadingIcon={<LogIn size={16} />}
          >
            Sign in to save to Workspace
          </Button>
        ) : null}
      </div>

      {saveState.kind === "saved" ? (
        <p role="status" className="text-sm text-navy-soft">
          Saved to your Workspace.{" "}
          <Link href={saveState.href} className="font-semibold text-primary underline">
            Open document
            <ExternalLink size={13} className="ml-1 inline align-[-1px]" aria-hidden="true" />
          </Link>
        </p>
      ) : null}

      {saveState.kind === "error" ? (
        <p role="alert" className="max-w-sm text-sm text-red-600">
          {saveState.message}
        </p>
      ) : null}

      {openError ? (
        <p role="alert" className="max-w-sm text-sm text-red-600">
          {openError}
        </p>
      ) : null}
    </div>
  );
}
