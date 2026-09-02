"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Focus-trap utilities for modal dialogs and slide-overs (WCAG 2.2 AA).
 *
 * `nextFocusTarget` is the pure tab-cycle core — given the ordered focusable
 * elements, the currently-focused one, and whether Shift is held, it returns
 * the element that should receive focus next (wrapping at the ends). It is kept
 * pure and exported so it can be unit-tested without a DOM; the {@link useFocusTrap}
 * hook wires it to real keydown events.
 */

/** CSS selector matching natively focusable elements (the hook filters to visible). */
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Returns the element that should receive focus when Tab (or Shift+Tab) is
 * pressed inside a trap. Wraps from the last to the first (and vice versa) so
 * focus can never leave the container. Pure: no DOM access, safe to test.
 */
export function nextFocusTarget<T extends HTMLElement>(
  elements: T[],
  current: T | null,
  shift: boolean,
): T | null {
  if (elements.length === 0) return null;
  if (!current) return shift ? elements[elements.length - 1] : elements[0];
  const idx = elements.indexOf(current);
  if (idx === -1) return shift ? elements[elements.length - 1] : elements[0];
  const nextIdx = shift
    ? (idx - 1 + elements.length) % elements.length
    : (idx + 1) % elements.length;
  return elements[nextIdx];
}

/** Queries the visible, focusable descendants of `container`, in DOM order. */
export function getFocusableElements<T extends HTMLElement>(container: T): HTMLElement[] {
  const nodes = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  // Skip elements that are hidden (display:none / visibility:hidden) or offsetParent null,
  // except for elements inside a fixed-position container (which report offsetParent null).
  return nodes.filter((el) => {
    if (el.hasAttribute("disabled")) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const style = typeof window !== "undefined" ? window.getComputedStyle(el) : null;
    if (style && (style.display === "none" || style.visibility === "hidden")) return false;
    return true;
  });
}

/**
 * Traps keyboard focus inside `containerRef` while `active` is true. On
 * activation it records the currently-focused element (to restore later), moves
 * focus to the first focusable descendant, and intercepts Tab/Shift+Tab so focus
 * cycles within the container. On deactivation it restores focus to the element
 * that had it before the trap opened. Pass `onEscape` to close on Escape.
 */
export function useFocusTrap(
  containerRef: React.RefObject<HTMLElement | null>,
  active: boolean,
  onEscape?: () => void,
): void {
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      const container = containerRef.current;
      if (!container) return;
      if (e.key === "Escape" && onEscape) {
        onEscape();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = getFocusableElements(container);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const target = nextFocusTarget(focusable, document.activeElement as HTMLElement | null, e.shiftKey);
      if (target) {
        e.preventDefault();
        target.focus();
      }
    },
    [containerRef, onEscape],
  );

  useEffect(() => {
    if (!active) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const container = containerRef.current;
    if (container) {
      const focusable = getFocusableElements(container);
      // Focus the container itself (or its first focusable child) on open.
      (focusable[0] ?? container).focus();
      if (!focusable[0] && !container.hasAttribute("tabindex")) {
        container.setAttribute("tabindex", "-1");
      }
    }
    document.addEventListener("keydown", handleKey, true);
    return () => {
      document.removeEventListener("keydown", handleKey, true);
      // Restore focus to the element that had it before the trap opened.
      const prev = previouslyFocused.current;
      if (prev && typeof prev.focus === "function") prev.focus();
    };
  }, [active, containerRef, handleKey]);
}
