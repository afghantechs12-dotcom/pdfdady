"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CloudAlert, TriangleAlert } from "lucide-react";
import type {
  ConflictActionId,
  ConflictPresentation,
} from "@/src/application/editor/persistence/conflictResolution";
import { formatAbsolute } from "@/src/application/editor/persistence/recoveryPrompt";
import { visibleConflictActions } from "./editorPersistenceWiring";

/**
 * The conflict dialog: the workspace holds a version that does not include the
 * user's changes, and someone has to decide what happens to both.
 *
 * The copy is `presentConflict`'s — including the safety sentence, which is the one
 * that has to be exactly right ("your changes are stored in this browser" vs "your
 * changes are only in this tab"). The action set is filtered by
 * {@link visibleConflictActions} so no button is rendered that this surface cannot
 * carry out; a dead button in a dialog about losing a document is worse than a
 * missing one.
 *
 * THE OVERWRITE IS BEHIND A SECOND CONFIRMATION, IN PLACE.
 *
 * `replace_workspace` is the only action that destroys something, and the
 * coordinator refuses it without `confirmed: true`. That confirmation is asked for
 * here, in the same dialog, rather than by a nested modal: the user is already
 * making a careful decision and a second window over it hides the explanation they
 * are deciding from. Cancelling the confirmation returns to the choice, and the
 * conflict is still standing — `cancel` deliberately does not clear it, because a
 * conflict that stops looking unresolved is how the workspace copy gets overwritten
 * by the next autosave.
 */

export interface ConflictDialogProps {
  conflict: ConflictPresentation;
  /** False hides the actions that need a workspace to act on. */
  workspaceKnown: boolean;
  busy?: boolean;
  /** Set while an action failed, so the dialog can say so without closing. */
  error?: string | null;
  onAction: (action: ConflictActionId, options?: { confirmed?: boolean }) => void;
}

export function ConflictDialog({
  conflict,
  workspaceKnown,
  busy = false,
  error = null,
  onAction,
}: ConflictDialogProps) {
  const headingId = useId();
  const bodyId = useId();
  const [confirming, setConfirming] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstActionRef.current?.focus();
  }, []);

  /*
   * Escape maps to `cancel`, the action the presentation already defines as "decide
   * later" — so the keyboard's dismiss gesture goes through the same path as the
   * button and leaves the conflict standing rather than silently clearing it.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (confirming) setConfirming(false);
      else onAction("cancel");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming, onAction]);

  const actions = visibleConflictActions(conflict.actions, { workspaceKnown });

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4" role="presentation">
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={bodyId}
        className="w-full max-w-xl overflow-hidden rounded-xl border border-editor-border bg-editor-surface shadow-2xl"
      >
        <div className="flex items-start gap-3 border-b border-editor-border px-5 py-4">
          <CloudAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
          <div className="min-w-0">
            <h2 id={headingId} className="text-base font-semibold text-editor-text">
              {conflict.headline}
            </h2>
            <p id={bodyId} className="mt-1 text-sm text-editor-muted">
              {conflict.explanation}
            </p>
          </div>
        </div>

        {/* The safety sentence gets its own band: it is the one line that says where
            the user's work actually is right now. */}
        <p className="border-b border-editor-border bg-editor-subtle px-5 py-3 text-sm font-medium text-editor-text">
          {conflict.safety}
        </p>

        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 border-b border-editor-border px-5 py-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-editor-muted">Your version</dt>
            <dd className="text-editor-text">
              Revision {conflict.local.revision}
              {conflict.local.savedOnThisDevice ? ", stored in this browser" : ", in this tab only"}
              {conflict.local.at !== null ? ` · ${formatAbsolute(conflict.local.at)}` : ""}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-editor-muted">Workspace copy</dt>
            <dd className="text-editor-text">
              {/* REVISION, like the local column. `serverVersion` holds the document
                  record's revision — the compare-and-swap token — which a rename or a
                  move advances without publishing anything, so it is regularly ahead
                  of the version number in the header. Two numbers labelled "version"
                  that disagree is the confusion this dialog exists to end. */}
              {conflict.remote.serverVersion === null
                ? "Unknown"
                : `Revision ${conflict.remote.serverVersion}`}
              {conflict.remote.expectedServerVersion !== null &&
              conflict.remote.expectedServerVersion !== conflict.remote.serverVersion
                ? ` · you last saw ${conflict.remote.expectedServerVersion}`
                : ""}
            </dd>
          </div>
        </dl>

        {conflict.detail !== null ? (
          <p className="border-b border-editor-border px-5 py-2 text-xs text-editor-muted">
            {conflict.detail}
          </p>
        ) : null}

        {error !== null ? (
          <p role="alert" className="flex items-start gap-2 border-b border-red-200 bg-red-50 px-5 py-3 text-sm text-red-700">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </p>
        ) : null}

        {confirming ? (
          <div className="px-5 py-4">
            <p className="text-sm font-semibold text-red-700">
              Replace the workspace version with yours?
            </p>
            <p className="mt-1 text-sm text-editor-muted">
              The version currently in the workspace will be replaced. It stays in the
              document&apos;s version history, but anyone looking at the document will see
              yours.
            </p>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming(false)}
                className="rounded-lg border border-editor-border px-3 py-1.5 text-sm font-semibold text-editor-text outline-none hover:bg-editor-subtle focus-visible:ring-2 focus-visible:ring-editor-accent disabled:opacity-50"
              >
                Go back
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onAction("replace_workspace", { confirmed: true })}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white outline-none hover:bg-red-700 focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50"
              >
                Replace it
              </button>
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-editor-border">
            {actions.map((action, index) => (
              <li key={action.id} className="flex items-start gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p
                    className={`text-sm font-semibold ${action.destructive ? "text-red-700" : "text-editor-text"}`}
                  >
                    {action.label}
                  </p>
                  <p className="mt-0.5 text-xs text-editor-muted">{action.description}</p>
                </div>
                <button
                  ref={index === 0 ? firstActionRef : undefined}
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    action.requiresConfirmation ? setConfirming(true) : onAction(action.id)
                  }
                  className={
                    action.destructive
                      ? "shrink-0 rounded-lg border border-red-300 px-3 py-1.5 text-sm font-semibold text-red-700 outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50"
                      : "shrink-0 rounded-lg border border-editor-border px-3 py-1.5 text-sm font-semibold text-editor-text outline-none hover:bg-editor-subtle focus-visible:ring-2 focus-visible:ring-editor-accent disabled:opacity-50"
                  }
                >
                  {action.destructive ? "Continue" : "Choose"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
