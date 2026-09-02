"use client";

import { useRef } from "react";
import { X } from "lucide-react";
import { useFocusTrap } from "@/lib/a11y/focusTrap";

/**
 * A right-side panel presented over the canvas, for widths where docking it
 * would crush the page (see `editorPanelLayout`).
 *
 * A real dialog: focus is trapped while open, Escape closes it, and focus
 * returns to the toggle that opened it — all supplied by the existing
 * {@link useFocusTrap}, so this behaves exactly like the app's other slide-overs
 * rather than being a second, subtly different implementation.
 *
 * ## The scrim's z-index is a correctness property, not styling
 *
 * MEASURED DEFECT: with this drawer open and `aria-modal="true"`, clicking the
 * bottom capsule's zoom control still changed the document's zoom from 100% to
 * 125%. Focus was trapped and the markup claimed modality, but the pointer was
 * not blocked — so the drawer was modal to keyboards and screen readers while
 * lying to the mouse.
 *
 * The cause was pure stacking. The scrim was `z-20`; the floating capsule's
 * positioned wrapper inside `<main>` is `z-30`. Both are in the same stacking
 * context, so the capsule painted ABOVE the scrim and kept receiving clicks. A
 * modal that does not intercept pointer events is not modal, and `aria-modal` on
 * an element that fails to block input is an accessibility claim that is false.
 *
 * The scrim therefore sits at `z-40` — above the capsule (z-30) and the object
 * toolbar, below the find bar's own chrome — and the panel above it at `z-50`.
 * The behavioural assertion (drawer open → clicking the capsule does NOT change
 * zoom) is what the probe checks; the z-index is merely how it is achieved.
 */
export function EditorPanelDrawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, onClose);

  return (
    <>
      {/*
        Scrim: dismisses on click, and is not a tab stop. `z-40` so it genuinely
        covers the floating capsule (z-30) — see the note above; at z-20 the
        capsule stayed clickable through it and mutated the document behind a
        modal dialog.
      */}
      <div
        className="absolute inset-0 z-40 bg-navy/20"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="absolute inset-y-0 right-0 z-50 flex w-[min(320px,88vw)] flex-col border-l border-editor-border bg-editor-surface shadow-apppanel"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-editor-border px-3 py-2">
          <h2 className="truncate text-sm font-semibold text-editor-text">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-editor-muted transition-colors hover:bg-editor-subtle hover:text-editor-text focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/50"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </>
  );
}
