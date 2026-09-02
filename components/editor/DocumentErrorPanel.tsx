"use client";

import { useEffect, useRef } from "react";
import {
  AlertTriangle,
  FileQuestion,
  FolderOpen,
  Lock,
  RefreshCw,
  WifiOff,
  Clock,
  LogIn,
} from "lucide-react";
import type { LoadErrorAction, LoadErrorKind, LoadErrorPresentation } from "@/components/editor/documentLoadState";

/** One icon per kind, so the panel reads as a category before it is read as text. */
const KIND_ICON: Record<LoadErrorKind, typeof AlertTriangle> = {
  auth: LogIn,
  forbidden: Lock,
  "not-found": FileQuestion,
  "content-unavailable": Clock,
  "invalid-pdf": AlertTriangle,
  network: WifiOff,
  "timed-out": Clock,
  unknown: AlertTriangle,
};

const ACTION_ICON: Record<LoadErrorAction["kind"], typeof AlertTriangle> = {
  retry: RefreshCw,
  "open-another": FolderOpen,
  "sign-in": LogIn,
};

/**
 * The terminal document-open error, drawn over the canvas.
 *
 * Everything it renders comes from {@link LoadErrorPresentation} — copy authored
 * by `presentLoadError`, never a server string and never an exception. The panel
 * has no `detail` prop at all, which is what makes "no raw exception rendering"
 * a property of the type rather than a rule someone has to remember.
 *
 * Focus moves here once, when the panel appears. A load error replaces the
 * content the user was waiting for, so leaving focus on whatever the toolbar had
 * would leave a keyboard or screen-reader user unaware that the wait ended in a
 * failure. It is NOT a focus trap and it does not re-steal focus on rerender:
 * the effect keys on the error's identity, so a resize or a parent render cannot
 * yank focus back out from under someone who has tabbed to Retry.
 */
export function DocumentErrorPanel({
  presentation,
  onAction,
  secondary,
}: {
  presentation: LoadErrorPresentation;
  onAction: (action: LoadErrorAction["kind"]) => void;
  /**
   * The host's own way out — the workbench passes its "Back to Workspace" link.
   *
   * A slot rather than a synthesized action because only the host knows where
   * back IS. It also carries the recovery for kinds that honestly have no retry:
   * a 404 offers no button of its own, and this link is what keeps the panel
   * from being a dead end.
   */
  secondary?: React.ReactNode;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const Icon = KIND_ICON[presentation.kind];

  useEffect(() => {
    // Keyed on `kind`: one move per distinct failure, not one per render.
    headingRef.current?.focus();
  }, [presentation.kind]);

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-editor-bg/92 px-6 backdrop-blur-[1px]"
      data-editor-error={presentation.kind}
    >
      <div
        role="alert"
        className="w-full max-w-sm rounded-panel border border-editor-border bg-editor-surface p-6 text-center shadow-apppanel"
      >
        <span
          aria-hidden="true"
          className={`mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-panel ${
            presentation.kind === "content-unavailable" || presentation.kind === "timed-out"
              ? "bg-editor-accentsoft text-editor-accent"
              : "bg-red-50 text-red-600"
          }`}
        >
          <Icon size={20} aria-hidden="true" />
        </span>

        {/*
          `tabIndex={-1}` makes the heading programmatically focusable without
          adding it to the tab order — the panel is a destination for focus, not
          an extra stop on the way to the actions.
        */}
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-[15px] font-bold tracking-tight text-editor-text focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/50"
        >
          {presentation.heading}
        </h2>
        <p className="mx-auto mt-2 max-w-xs text-[13px] leading-relaxed text-editor-muted">
          {presentation.description}
        </p>

        {presentation.actions.length > 0 || secondary ? (
          <div className="mt-5 flex flex-col items-stretch gap-2 sm:flex-row sm:justify-center">
            {presentation.actions.map((action, index) => {
              const ActionIcon = ACTION_ICON[action.kind];
              const primary = index === 0;
              return (
                <button
                  key={action.kind}
                  type="button"
                  onClick={() => onAction(action.kind)}
                  className={
                    primary
                      ? "inline-flex items-center justify-center gap-1.5 rounded-control bg-editor-accent px-3.5 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-editor-accenthover focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/50"
                      : "inline-flex items-center justify-center gap-1.5 rounded-control border border-editor-border bg-editor-surface px-3.5 py-2 text-[13px] font-semibold text-editor-text transition-colors hover:bg-editor-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/50"
                  }
                >
                  <ActionIcon size={15} aria-hidden="true" />
                  {action.label}
                </button>
              );
            })}
            {secondary ? (
              <span className="inline-flex items-center justify-center text-[13px] font-semibold text-editor-muted">
                {secondary}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
