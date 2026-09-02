import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Reveal } from "./Reveal";

/**
 * U26 — reduced-motion behavior exists.
 *
 * Two independent guards, and this file checks both because they cover
 * different users: the CSS `@media` block covers someone who flips the setting
 * after load and every animation with no JS involvement, while `Reveal`'s
 * runtime check covers someone who had it set before load and stops the
 * element from ever being hidden in the first place.
 *
 * The coverage test is the interesting one. Adding an animation to
 * `app/globals.css` and forgetting the off-switch list is a silent
 * accessibility regression — nothing fails, the animation simply keeps running
 * for a user who asked it not to. Deriving the expected list from the file
 * rather than hardcoding it is what makes that impossible.
 *
 * Limit, stated out loud: this proves the rules exist and cover every animated
 * class. That the emulated media query actually stops the homepage moving is
 * scenario L4 of the Phase 6 browser probe, not this file.
 */

const CSS = readFileSync("app/globals.css", "utf8");
const RM_START = CSS.indexOf("@media (prefers-reduced-motion: reduce) {");
const BEFORE = CSS.slice(0, RM_START);
const REDUCED = CSS.slice(RM_START);

/** Class selectors declaring an `animation:` or `transition:`, with their bodies. */
const motionClasses = (css: string) => {
  const found = new Map<string, string>();
  for (const [, name, body] of css.matchAll(/\.([a-z][a-z0-9-]*)\s*\{([^}]*)\}/g)) {
    if (/\banimation(?:-name)?\s*:/.test(body) || /\btransition\s*:/.test(body)) {
      found.set(name, body);
    }
  }
  return found;
};

describe("U26 — reduced-motion behavior exists", () => {
  it("has a reduced-motion block at all", () => {
    expect(RM_START).toBeGreaterThan(0);
    // Outside `@layer`, so it wins over Tailwind's own utilities by source order.
    expect(BEFORE).toContain("@tailwind utilities;");
  });

  it("switches off every animated class the stylesheet declares", () => {
    const animated = [...motionClasses(BEFORE).keys()];
    // Vacuity guard: the parse found the real list, not an empty one.
    expect(animated).toContain("animate-fade-up");
    expect(animated).toContain("animate-gradient-drift");
    expect(animated.length).toBeGreaterThanOrEqual(10);
    for (const name of animated) {
      // `[,{]`, not a bare comma: the last selector in the grouped list is
      // followed by the opening brace instead.
      expect(REDUCED, `.${name} is animated but is not reduced`).toMatch(
        new RegExp(`\\.${name}\\s*[,{]`),
      );
    }
    // `.reveal-armed` declares no animation of its own — it is the hidden state
    // the transition moves away from — so the parse above cannot find it. It
    // still has to be reduced, or a reduced-motion user gets a blank section.
    expect(REDUCED).toMatch(/\.reveal-armed\s*[,{]/);
  });

  it("removes the movement without removing the content", () => {
    // Cancelling an animation whose `from` state is invisible would leave the
    // element hidden forever — the failure mode that makes a naive
    // `animation: none` reset worse than no reduced-motion support at all.
    const block = REDUCED.slice(REDUCED.indexOf(".animate-fade-up,"));
    expect(block).toContain("animation: none !important");
    expect(block).toContain("transition: none !important");
    expect(block).toContain("opacity: 1 !important");
    expect(block).toContain("transform: none !important");
  });

  it("stops decorative pulsing but only slows an activity spinner", () => {
    // Tailwind's utilities, used across the product. A frozen spinner reads as
    // a hung interface, so `animate-spin` keeps turning at a slower rate while
    // `animate-pulse` — decoration — stops outright.
    expect(REDUCED).toMatch(/\.animate-pulse\s*\{[^}]*animation:\s*none\s*!important/);
    expect(REDUCED).toMatch(/\.animate-spin\s*\{[^}]*animation-duration:\s*2\.4s\s*!important/);
    expect(REDUCED).not.toMatch(/\.animate-spin\s*\{[^}]*animation:\s*none/);
  });

  it("also disables smooth scrolling, which no animation class covers", () => {
    expect(REDUCED).toMatch(/html\s*\{[^}]*scroll-behavior:\s*auto/);
  });

  it("Reveal renders its children visible, unarmed, with no client JS", () => {
    const html = renderToStaticMarkup(h(Reveal, { delay: 120, children: h("p", null, "Section copy") }));
    expect(html).toContain("Section copy");
    // The resting CSS state is the visible one; `reveal-armed` is what hides it.
    // A server render that already carried it would leave the page blank for a
    // crawler, for a JS failure, and for the reduced-motion user below.
    expect(html).not.toContain("reveal-armed");
    expect(html).not.toContain("reveal-visible");
  });

  it("Reveal keeps its own runtime guard, so it never arms under reduced motion", () => {
    const source = readFileSync("components/ui/Reveal.tsx", "utf8");
    // A source guard on purpose: `useEffect` does not run under SSR, so the
    // armed path is unreachable in this environment and only the browser probe
    // can exercise it. This pins the ordering the rendered test relies on —
    // the query is consulted BEFORE `setArmed(true)`.
    const check = source.indexOf('matchMedia?.("(prefers-reduced-motion: reduce)")');
    const arm = source.indexOf("setArmed(true)");
    expect(check).toBeGreaterThan(0);
    expect(arm).toBeGreaterThan(check);
    expect(source).toMatch(/if \(reduced \|\| typeof IntersectionObserver === "undefined"\) return;/);
  });
});
