"use client";

import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { useAnalytics } from "@/hooks/useAnalytics";
import { ANALYTICS_EVENTS } from "@/src/domain/metering/events";
import type { LocalToolErrorCategory } from "@/src/domain/jobs/jobErrors";
import type { ToolExecutionMode } from "@/lib/tools/executionPolicy";

/**
 * One funnel, owned above the runners, so no tool can be instrumented wrongly or
 * not at all.
 *
 * ── Why a context and not a prop ────────────────────────────────────────────
 *
 * The funnel needs the tool's slug, and the runner does not know it. `EditTool`
 * serves four slugs (rotate / organize / delete-pages / reorder-pages),
 * `SplitTool` two, `JpgToPdfTool` three — every one of those pages renders the
 * runner with no arguments. A `TOOL_SLUG` constant per runner, which is what the
 * first instrumented tool used, would therefore report four different tools as
 * one funnel and make "which tool do people abandon" unanswerable for a third of
 * the catalogue.
 *
 * Deriving it from `usePathname()` was the smaller diff and is rejected: it
 * breaks silently on a route change, and silent measurement breakage is the exact
 * failure this milestone exists to remove. `ToolPageTemplate` already receives
 * the `Tool` object and already wraps every tool page, so the slug is available
 * there for free — and a page cannot render a tool shell without also declaring
 * which tool it is.
 *
 * ── Why the run scope lives here ───────────────────────────────────────────
 *
 * Two components emit into one funnel: the runner (via `usePdfProcessor`) and
 * `ResultActions` (the download). They are siblings in the tree, so the only
 * place a dedupe scope can be shared without threading a callback through every
 * runner is above both of them. Threading it is what a per-tool implementation
 * does, and eleven hand-wired callbacks is eleven chances to forget one.
 *
 * ── Why every emit is swallowed ────────────────────────────────────────────
 *
 * `usePdfProcessor.run` calls into this object before and after the user's PDF
 * work. A throw from an analytics helper would surface as a failed conversion, so
 * `safe()` is the boundary: nothing in here can reach the tool. `useAnalytics`
 * already swallows the network half; this covers the synchronous half.
 */

/** What a local tool reports, and the only vocabulary its callers need. */
export interface ToolFunnel {
  /**
   * The user has chosen `fileCount` files. Deduped per (run, count), so adding a
   * file is a second signal and a re-render is not.
   */
  noteFileSelection: (fileCount: number) => void;
  /**
   * Processing has begun. Advances the run scope, so a retry after a failure —
   * where nothing was reset — is measured as a second run rather than swallowed
   * as a duplicate of the first.
   */
  noteRunStart: () => void;
  /** The run produced a file. Never called for a failed run. */
  noteRunSucceeded: () => void;
  /** The run threw. Carries the closed-taxonomy category, never a message. */
  noteRunFailed: (errorCategory: LocalToolErrorCategory) => void;
  /**
   * The browser has been handed the file. The last step of the local funnel.
   * `format` is the produced extension, read from the result rather than assumed
   * to be `pdf` — a tool that one day returns a zip should say so.
   */
  noteDownload: (format: string) => void;
}

/**
 * The funnel used when no provider is above the caller.
 *
 * A no-op rather than a throw: a missing provider must not blank a working PDF
 * tool. It would still be a measurement hole, so `toolPageInstrumentation.test.ts`
 * asserts that every page rendering a local runner goes through
 * `ToolPageTemplate` — the test is the guard, this constant is only the fallback.
 */
const NO_FUNNEL: ToolFunnel = {
  noteFileSelection: () => {},
  noteRunStart: () => {},
  noteRunSucceeded: () => {},
  noteRunFailed: () => {},
  noteDownload: () => {},
};

const ToolFunnelContext = createContext<ToolFunnel | null>(null);

/** The funnel for the surrounding tool page. Never null, never throws. */
export function useToolFunnel(): ToolFunnel {
  return useContext(ToolFunnelContext) ?? NO_FUNNEL;
}

/**
 * The slug, for the same reason and by the same route as the funnel.
 *
 * `ResultActions` needs it too — the workflow CTAs on a finished result are
 * decided by the tool's capability record, and a result surface that cannot name
 * its tool cannot read that record. Every argument in the block above applies
 * unchanged: the runner does not know its slug, four of them serve several, and
 * `ToolPageTemplate` already has it.
 *
 * Null when there is no provider, which is the honest answer: a surface that
 * cannot name its tool must offer only the actions that need no capability
 * (`resultWorkflowActions` returns all-false for a null capability), never a
 * guess.
 */
const ToolSlugContext = createContext<string | null>(null);

export function useToolSlug(): string | null {
  return useContext(ToolSlugContext);
}

interface ToolAnalyticsProviderProps {
  toolSlug: string;
  /**
   * From the execution policy, not from a literal. `null` for a tool that cannot
   * run yet: those pages emit no `tool_view`, because a view of a "coming soon"
   * notice is not a view of a tool and counting it would inflate the top of every
   * funnel with pages that have no bottom.
   */
  executionMode: ToolExecutionMode | null;
  children: React.ReactNode;
}

export function ToolAnalyticsProvider({
  toolSlug,
  executionMode,
  children,
}: ToolAnalyticsProviderProps) {
  const { trackOnce } = useAnalytics({
    // Carried on every event from this subtree, so no call site restates them and
    // none can disagree about which tool it is.
    context: executionMode ? { toolSlug, executionMode } : { toolSlug },
  });

  // A ref, not state: it exists only to namespace dedupe keys, and re-rendering
  // the whole tool because a counter moved would be a render for nobody.
  const runRef = useRef(0);

  useEffect(() => {
    if (!executionMode) return;
    trackOnce(`tool_view:${toolSlug}`, ANALYTICS_EVENTS.tool_view);
  }, [trackOnce, toolSlug, executionMode]);

  const funnel = useMemo<ToolFunnel>(() => {
    const safe = (emit: () => void) => {
      try {
        emit();
      } catch {
        // Analytics is not a feature the user asked for. It does not get to fail
        // their merge.
      }
    };
    return {
      noteFileSelection: (fileCount) =>
        safe(() => {
          if (fileCount <= 0) return;
          trackOnce(
            `${runRef.current}:file_selected:${fileCount}`,
            ANALYTICS_EVENTS.file_selected,
            { fileCount },
          );
        }),
      noteRunStart: () =>
        safe(() => {
          // Advance first: every key below this point belongs to the new run.
          runRef.current += 1;
          // No `fileCount`: the taxonomy does not declare it for `tool_start`, so
          // sending it is a property the ingest silently drops.
          trackOnce(`${runRef.current}:tool_start`, ANALYTICS_EVENTS.tool_start);
        }),
      noteRunSucceeded: () =>
        safe(() => {
          trackOnce(`${runRef.current}:job_succeeded`, ANALYTICS_EVENTS.job_succeeded);
        }),
      noteRunFailed: (errorCategory) =>
        safe(() => {
          // The category, and nothing else. The user-facing message interpolates
          // their filename by design (see `PdfProcessingError`), so it is the one
          // half of a local failure that may never travel.
          trackOnce(`${runRef.current}:job_failed`, ANALYTICS_EVENTS.job_failed, {
            errorCategory,
          });
        }),
      noteDownload: (format) =>
        safe(() => {
          trackOnce(`${runRef.current}:download`, ANALYTICS_EVENTS.download, { format });
        }),
    };
  }, [trackOnce]);

  return (
    <ToolSlugContext.Provider value={toolSlug}>
      <ToolFunnelContext.Provider value={funnel}>{children}</ToolFunnelContext.Provider>
    </ToolSlugContext.Provider>
  );
}
