"use client";

import { Loader2, RefreshCw } from "lucide-react";
import {
  loadingPageAspect,
  type LoadPresentation,
} from "@/components/editor/documentLoadState";

/**
 * The editor's document-loading presentation: a page being prepared.
 *
 * The shipped build drew a centred `Loader2` on a translucent wash, which told
 * the user only that *something* was happening — and in an application whose
 * entire subject is a page, a spinner is a missed opportunity to show the shape
 * of what is arriving. This draws the page itself: a white sheet at the real
 * aspect ratio with restrained placeholder lines, so the canvas looks like it is
 * filling in rather than blocked.
 *
 * Three constraints shape it:
 *
 * - It is an OVERLAY, not a layout participant. The app bar, toolbar, rails,
 *   Inspector, status bar and the Phase I floating capsule keep their geometry
 *   underneath, so nothing jumps when the document lands. That is also why the
 *   sheet is sized in percentages of the canvas rather than in pixels measured
 *   from the page.
 * - The ratio never blocks. `loadingPageAspect` answers immediately with an A4
 *   default when dimensions are unknown, and refines when the real page size
 *   arrives — waiting to learn the size before drawing is how a skeleton
 *   degrades back into a spinner.
 * - Motion is optional. `motion-reduce:animate-none` is on every animated
 *   element; the sheet, its border and its shadow carry the meaning, and the
 *   pulse only adds life for users who want it.
 */
export function DocumentLoadingOverlay({
  presentation,
  pageSize,
  onRetry,
}: {
  presentation: LoadPresentation;
  /** Real page dimensions when known; null before the PDF is parsed. */
  pageSize?: { width: number; height: number } | null;
  /**
   * Offered only while `presentation.retry` is set — which is the
   * preparation-polling phase, the one busy state a user may not want to keep
   * waiting through. Ordinary loading has nothing to retry and shows no button.
   */
  onRetry?: () => void;
}) {
  const aspect = loadingPageAspect(pageSize ?? null);
  const showRetry = presentation.retry && Boolean(onRetry);

  return (
    <div
      // Not a live region: the announcement is owned by the single dedicated
      // status region in EditorWorkspace, so this cannot compete with it. But it
      // is only aria-hidden when it holds no interactive control — hiding a
      // reachable button from assistive tech would make it unusable.
      aria-hidden={showRetry ? undefined : "true"}
      className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-editor-bg/85 px-6 backdrop-blur-[1px]"
      data-editor-loading="page-skeleton"
    >
      <div
        className="relative w-full max-w-[min(58%,420px)] overflow-hidden rounded-[2px] border border-editor-border bg-editor-page shadow-page"
        style={{ aspectRatio: `1 / ${aspect}` }}
        data-editor-loading-page="true"
      >
        {/*
          Placeholder content lines. Deliberately restrained and deliberately not
          a shimmer sweep: this stands in for a document, and a flashy gradient
          animation over a page the user is waiting to read reads as decoration
          rather than progress.
        */}
        <div className="absolute inset-0 flex flex-col gap-[3.5%] p-[9%]">
          <div className="h-[6%] w-[52%] animate-pulse rounded-sm bg-editor-border motion-reduce:animate-none" />
          <div className="h-[3%] w-0 shrink-0" />
          {[92, 97, 88, 95, 74].map((width, index) => (
            <div
              key={width}
              className="h-[3.2%] animate-pulse rounded-sm bg-editor-border/70 motion-reduce:animate-none"
              style={{ width: `${width}%`, animationDelay: `${index * 90}ms` }}
            />
          ))}
          <div className="h-[2%] w-0 shrink-0" />
          <div className="h-[18%] w-[64%] animate-pulse rounded-sm bg-editor-border/50 motion-reduce:animate-none" />
          <div className="h-[2%] w-0 shrink-0" />
          {[90, 84].map((width, index) => (
            <div
              key={`tail-${width}`}
              className="h-[3.2%] animate-pulse rounded-sm bg-editor-border/70 motion-reduce:animate-none"
              style={{ width: `${width}%`, animationDelay: `${(index + 5) * 90}ms` }}
            />
          ))}
        </div>
      </div>

      {presentation.message ? (
        <div className="flex flex-col items-center gap-3">
          <p className="flex max-w-xs items-center gap-2 text-center text-[13px] font-medium text-editor-muted">
            <Loader2
              className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none text-editor-accent"
              aria-hidden="true"
            />
            {presentation.message}
          </p>
          {showRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 rounded-control border border-editor-border bg-editor-surface px-3 py-1.5 text-[13px] font-semibold text-editor-text transition-colors hover:bg-editor-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/50"
            >
              <RefreshCw size={14} aria-hidden="true" />
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Bounded placeholder thumbnails for the Pages rail during the initial load.
 *
 * `count` comes from `placeholderThumbnailCount`, which returns a small fixed
 * number while the page count is unknown and zero once it is: one skeleton per
 * page would cost more layout on a 200-page document than the real thumbnails it
 * stands in for, and would misrepresent how much is actually loading.
 */
export function PagesPanelSkeleton({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <div className="flex flex-col gap-2 p-2" aria-hidden="true" data-editor-loading="pages-rail">
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className="animate-pulse rounded-sm border border-editor-border bg-editor-page motion-reduce:animate-none"
          style={{ aspectRatio: "1 / 1.414", animationDelay: `${index * 120}ms` }}
        />
      ))}
    </div>
  );
}
