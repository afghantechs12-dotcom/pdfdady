"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

/**
 * A render-crash boundary around the editor surface, and nothing wider.
 *
 * Scope is the entire point. This repository had no error boundary at all, and
 * the temptation on discovering that is to add a global one — but a catch-all
 * turns every programming defect anywhere in the application into the same
 * apologetic card, which is how real bugs stop being noticed. This wraps only
 * the editor: a crash in the canvas, a panel or the toolbar loses the editor and
 * leaves the surrounding application chrome (the app shell, the sidebar, the
 * workspace navigation) alive and usable.
 *
 * It does NOT swallow the error. `componentDidCatch` logs to `console.error`
 * before rendering the fallback, so a defect is exactly as visible in
 * development as it was before — React's own overlay still appears in dev, and
 * the log survives in production.
 *
 * Recovery is a real remount, not a cosmetic reset: clearing `error` re-renders
 * the children from scratch, which recovers a transient failure (a bad render
 * from a state combination the user can leave) and immediately re-throws for a
 * deterministic one, rather than pretending to fix it.
 */
export class EditorErrorBoundary extends Component<
  { children: ReactNode; onReset?: () => void },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Deliberately console.error, not a silent report: a render crash in the
    // editor is a defect, and defects must stay loud in the logs.
    console.error("Editor render failed", error, info.componentStack);
  }

  private reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex h-full w-full items-center justify-center bg-editor-bg px-6 py-12">
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
            The editor stopped unexpectedly
          </h2>
          {/*
            No `error.message`. A render crash's message is a developer artifact
            ("Cannot read properties of undefined") that tells a user nothing and
            can carry internal identifiers; it goes to the console instead.
          */}
          <p className="mx-auto mt-2 max-w-xs text-[13px] leading-relaxed text-editor-muted">
            Something went wrong while drawing this document. Reloading the editor
            usually fixes it. Any unsaved changes in this tab were not saved.
          </p>
          <div className="mt-5 flex justify-center">
            <button
              type="button"
              onClick={this.reset}
              className="inline-flex items-center justify-center gap-1.5 rounded-control bg-editor-accent px-3.5 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-editor-accenthover focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/50"
            >
              <RefreshCw size={15} aria-hidden="true" />
              Reload the editor
            </button>
          </div>
        </div>
      </div>
    );
  }
}
