"use client";

import { useEffect, useId, useRef, useState } from "react";
import { History, TriangleAlert } from "lucide-react";
import type {
  RecoveryActionId,
  RecoveryPrompt,
} from "@/src/application/editor/persistence/recoveryPrompt";

/**
 * The recovery offer: "we found work you did not save — what would you like to do?"
 *
 * Every word is `buildRecoveryPrompt`'s. The details table, the caveat, the action
 * labels and which action is destructive are all decided there and unit tested; this
 * renders them and reports the id that was chosen.
 *
 * WHY IT IS MODAL, AND WHY IT HAS NO CLOSE BUTTON.
 *
 * A prompt the user can walk past becomes a prompt the user walks past, and the
 * draft behind it is then discarded by the next thing that opens a document. So when
 * `requiresChoice` is set there is no dismiss affordance at all — not an X, not an
 * Escape, not an outside click. Every exit is one of the labelled decisions, and
 * "Open the saved version" is the one that means "no thanks": it is explicit, it is
 * offered first among the non-destructive choices, and it leaves the draft intact
 * until the user asks for it to be deleted.
 *
 * When `requiresChoice` is false the restore has already happened automatically and
 * this is a notice about it, so Escape closes it like any other notice.
 */

export interface RecoveryPromptDialogProps {
  prompt: RecoveryPrompt;
  /** True while an action is running, so a slow restore cannot be double-fired. */
  busy?: boolean;
  onAction: (action: RecoveryActionId) => void;
  /** Only called for a non-blocking notice; a required choice has no dismiss path. */
  onDismiss: () => void;
}

export function RecoveryPromptDialog({
  prompt,
  busy = false,
  onAction,
  onDismiss,
}: RecoveryPromptDialogProps) {
  const headingId = useId();
  const bodyId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);

  // Focus moves into the dialog, because the thing that opened it was a page load
  // rather than a click — there is no "the button you just pressed" to return to.
  useEffect(() => {
    firstActionRef.current?.focus();
  }, []);

  useEffect(() => {
    if (prompt.requiresChoice) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prompt.requiresChoice, onDismiss]);

  /*
   * A focus trap for the blocking case only. Tab past the last control returns to
   * the first: the page behind is a document editor whose every shortcut would
   * otherwise be reachable while a decision about that document is outstanding.
   */
  useEffect(() => {
    if (!prompt.requiresChoice) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], summary, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [prompt.requiresChoice]);

  /*
   * `review_details` is dropped, not rendered. The details it refers to are
   * disclosed in this dialog by the button above; a second control that navigated
   * somewhere to show them would take the user away from the decision they are in
   * the middle of, and the offer would be gone when they came back.
   */
  const visibleActions = prompt.actions.filter((action) => action.id !== "review_details");

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4"
      role="presentation"
    >
      <div
        ref={panelRef}
        role={prompt.requiresChoice ? "alertdialog" : "dialog"}
        aria-modal={prompt.requiresChoice ? true : undefined}
        aria-labelledby={headingId}
        aria-describedby={bodyId}
        className="w-full max-w-lg overflow-hidden rounded-xl border border-editor-border bg-editor-surface shadow-2xl"
      >
        <div className="flex items-start gap-3 border-b border-editor-border px-5 py-4">
          <History className="mt-0.5 h-5 w-5 shrink-0 text-editor-accent" aria-hidden="true" />
          <div className="min-w-0">
            <h2 id={headingId} className="text-base font-semibold text-editor-text">
              {prompt.headline}
            </h2>
            <p id={bodyId} className="mt-1 text-sm text-editor-muted">
              {prompt.requiresChoice ? prompt.summary : prompt.automaticNotice}
            </p>
          </div>
        </div>

        {prompt.caveat !== null ? (
          <p className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-800">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{prompt.caveat}</span>
          </p>
        ) : null}

        {prompt.details.length > 0 ? (
          <div className="border-b border-editor-border px-5 py-3">
            <button
              type="button"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((was) => !was)}
              className="text-sm font-semibold text-editor-accent underline outline-none focus-visible:ring-2 focus-visible:ring-editor-accent"
            >
              {detailsOpen ? "Hide details" : "Show details"}
            </button>
            {detailsOpen ? (
              <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
                {prompt.details.map((detail) => (
                  <div key={detail.label} className="contents">
                    <dt className="text-editor-muted">{detail.label}</dt>
                    <dd className="text-editor-text">{detail.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2 px-5 py-4">
          {visibleActions.map((action, index) => {
            const primary = index === 0 && !action.destructive;
            return (
              <button
                key={action.id}
                ref={index === 0 ? firstActionRef : undefined}
                type="button"
                disabled={busy}
                onClick={() => onAction(action.id)}
                className={
                  action.destructive
                    ? "rounded-lg border border-red-300 px-3 py-1.5 text-sm font-semibold text-red-700 outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50"
                    : primary
                      ? "rounded-lg bg-editor-accent px-3 py-1.5 text-sm font-semibold text-white outline-none hover:bg-editor-accenthover focus-visible:ring-2 focus-visible:ring-editor-accent disabled:opacity-50"
                      : "rounded-lg border border-editor-border px-3 py-1.5 text-sm font-semibold text-editor-text outline-none hover:bg-editor-subtle focus-visible:ring-2 focus-visible:ring-editor-accent disabled:opacity-50"
                }
              >
                {action.label}
              </button>
            );
          })}
          {!prompt.requiresChoice ? (
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-lg border border-editor-border px-3 py-1.5 text-sm font-semibold text-editor-text outline-none hover:bg-editor-subtle focus-visible:ring-2 focus-visible:ring-editor-accent"
            >
              Dismiss
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
