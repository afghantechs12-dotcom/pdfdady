"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw } from "lucide-react";

/**
 * The route boundary for `/workspaces`.
 *
 * Expected outcomes — no such Workspace, no access, archived — never reach here:
 * they are a controlled `notFound()` or a handled state on the page itself. This
 * is for the genuinely unexpected, so it deliberately shows nothing from the
 * error: no message, no digest, no id, no stack. Those go to the server log,
 * where they are useful and not user-visible.
 */
export default function WorkspacesRouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Workspace route failed", error);
  }, [error]);

  return (
    <main className="grid min-h-screen place-items-center bg-app-bg px-6">
      <div
        role="alert"
        className="w-full max-w-sm rounded-appcard border border-app-border bg-app-surface p-6 text-center shadow-apppanel"
      >
        <span
          aria-hidden="true"
          className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-appcard bg-red-50 text-red-600"
        >
          <AlertTriangle size={20} aria-hidden="true" />
        </span>
        <h1 className="text-[15px] font-bold tracking-tight text-app-text">
          This Workspace could not be loaded
        </h1>
        <p className="mx-auto mt-2 max-w-xs text-[13px] leading-relaxed text-app-muted">
          Something went wrong on our side. Nothing in your Workspace was changed.
        </p>
        <div className="mt-5 flex flex-col items-stretch gap-2 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center justify-center gap-1.5 rounded-control bg-primary px-3.5 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <RefreshCw size={15} aria-hidden="true" />
            Try again
          </button>
          <Link
            href="/workspaces"
            className="inline-flex items-center justify-center rounded-control border border-app-border bg-app-surface px-3.5 py-2 text-[13px] font-semibold text-app-text transition-colors hover:bg-app-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Your Workspaces
          </Link>
        </div>
      </div>
    </main>
  );
}
