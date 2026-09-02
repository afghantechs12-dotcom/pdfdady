"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, RefreshCw } from "lucide-react";

/**
 * The route-level boundary for `/editor`.
 *
 * Scoped to this route rather than added as a `global-error.tsx`: a
 * global boundary would replace the entire application — including the marketing
 * site and every unrelated route — with one apologetic card, which both hides
 * real defects and overreaches enormously for a phase about editor loading
 * states. `/editor` IS the editor, so the route boundary and the editor boundary
 * are the same scope here; the Workspace workbench gets its own in-tree
 * `EditorErrorBoundary` because there the editor is only part of the page.
 *
 * `reset()` is Next's real remount of the route segment, not a cosmetic
 * dismissal. The error is logged rather than shown: a render crash's message is
 * a developer artifact, and Next's dev overlay still surfaces it in development.
 */
export default function EditorRouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Editor route failed", error);
  }, [error]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-editor-bg px-6">
      <div
        role="alert"
        className="w-full max-w-sm rounded-panel border border-editor-border bg-editor-surface p-6 text-center shadow-apppanel"
      >
        <span
          aria-hidden="true"
          className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-panel bg-red-50 text-red-600"
        >
          <AlertTriangle size={20} aria-hidden="true" />
        </span>
        <h2 className="text-[15px] font-bold tracking-tight text-editor-text">
          The editor could not be loaded
        </h2>
        <p className="mx-auto mt-2 max-w-xs text-[13px] leading-relaxed text-editor-muted">
          Something went wrong while starting the editor. Reloading usually fixes
          it — no file you opened was uploaded anywhere.
        </p>
        <div className="mt-5 flex flex-col items-stretch gap-2 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center justify-center gap-1.5 rounded-control bg-editor-accent px-3.5 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-editor-accenthover focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/50"
          >
            <RefreshCw size={15} aria-hidden="true" />
            Reload the editor
          </button>
          <Link
            href="/tools"
            className="inline-flex items-center justify-center gap-1.5 rounded-control border border-editor-border bg-editor-surface px-3.5 py-2 text-[13px] font-semibold text-editor-text transition-colors hover:bg-editor-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/50"
          >
            <ArrowLeft size={15} aria-hidden="true" />
            Back to tools
          </Link>
        </div>
      </div>
    </div>
  );
}
