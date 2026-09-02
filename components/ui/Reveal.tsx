"use client";

import { useEffect, useRef, useState, type ElementType, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * Reveals its children when they scroll into view.
 *
 * This is the homepage's only new client component, and it is deliberately the
 * only one. Its children arrive as `ReactNode` — already rendered on the server
 * — so wrapping a section in `<Reveal>` does **not** make that section a client
 * component or add a byte of it to the client bundle. The alternative (an
 * animation library applied per section) would have converted most of the
 * homepage to client components and tripped the bundle guard in
 * lib/seo/publicBundles.test.ts.
 *
 * ## The visibility contract
 *
 * Content must never depend on JavaScript to become visible. The CSS resting
 * state is therefore the *visible* one: this component adds `reveal-armed`
 * (which hides the element) only after it has confirmed, at runtime, that it
 * can also un-hide it. If JS never runs, if `IntersectionObserver` is missing,
 * or if the user prefers reduced motion, nothing is ever armed and the content
 * simply shows — no flash, no empty page, and crawlers see everything.
 *
 * Arming happens in a layout-effect-like position (a `useEffect` that runs
 * before paint is not guaranteed, so `useState` drives the class through the
 * normal render path) rather than in the markup, which is what makes the
 * no-JS case safe.
 */
export function Reveal({
  children,
  delay = 0,
  as: Tag = "div",
  className,
}: {
  children: ReactNode;
  /** Stagger, in milliseconds. Applied as a CSS transition-delay. */
  delay?: number;
  /** Element to render. Use `li`/`section` where the parent demands it. */
  as?: ElementType;
  className?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  // `armed` gates the hidden state; `visible` releases it. Both start false so
  // the first server render and the first client render agree — arming during
  // hydration would be a mismatch.
  const [armed, setArmed] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // Either guard failing means we never hide the content in the first place.
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced || typeof IntersectionObserver === "undefined") return;

    // Already on screen at mount (above the fold): reveal without animating in
    // from a hidden state the user would have seen flash.
    const rect = node.getBoundingClientRect();
    if (rect.top < window.innerHeight && rect.bottom > 0) {
      setVisible(true);
      return;
    }

    setArmed(true);

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          setVisible(true);
          // One-shot: re-hiding a section the user has already read is
          // distracting, and it would re-run on every scroll past.
          observer.disconnect();
        }
      },
      // Fires slightly before the element's top edge reaches the viewport, so
      // the transition is underway by the time it is properly in view.
      { rootMargin: "0px 0px -12% 0px", threshold: 0.01 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <Tag
      ref={ref}
      className={cn(armed && "reveal-armed", visible && "reveal-visible", className)}
      style={delay ? ({ "--reveal-delay": `${delay}ms` } as React.CSSProperties) : undefined}
    >
      {children}
    </Tag>
  );
}
