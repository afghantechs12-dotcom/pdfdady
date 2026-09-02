"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils/cn";
import { useFocusTrap } from "@/lib/a11y/focusTrap";

/**
 * A reusable, accessible modal dialog (WCAG 2.2 AA).
 *
 * Renders a backdrop + a `role="dialog"` / `aria-modal="true"` container that
 * traps keyboard focus while open, closes on Escape or backdrop click, and
 * restores focus to the element that opened it on close. The caller provides
 * the dialog content (e.g. a form inside a Card) and an `onClose`.
 *
 * Body scroll is locked while open so a long dialog can't scroll the page behind
 * it — important on mobile and for screen-reader users.
 */
export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name for the dialog. Provide either `ariaLabel` or `labelledById`. */
  ariaLabel?: string;
  labelledById?: string;
  children: React.ReactNode;
  /** Max-width tailwind class for the dialog panel. */
  sizeClassName?: string;
  className?: string;
}

export function Modal({
  open,
  onClose,
  ariaLabel,
  labelledById,
  children,
  sizeClassName = "max-w-lg",
  className,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open, onClose);

  // Lock body scroll while the dialog is open; restore on close.
  useEffect(() => {
    if (!open) return;
    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    return () => {
      body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-dialog flex items-start justify-center overflow-y-auto p-4 sm:p-6">
      {/* Backdrop: a labeled button so it's keyboard-reachable and click-to-close. */}
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="fixed inset-0 bg-navy/40 backdrop-blur-sm"
        tabIndex={-1}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={labelledById ? undefined : ariaLabel}
        aria-labelledby={labelledById}
        className={cn(
          "relative my-8 w-full rounded-2xl bg-white shadow-xl",
          sizeClassName,
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
