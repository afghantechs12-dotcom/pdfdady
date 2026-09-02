/**
 * Decorative hero background built entirely from CSS gradients and inline
 * SVG (no raster images) for fast load and zero layout shift.
 * Phase 1.1: static structure. Subtle motion added in a later phase.
 */
export function HeroBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden bg-lavender-gradient"
    >
      {/* Soft wave behind hero */}
      <svg
        className="absolute inset-x-0 top-0 h-[420px] w-full text-primary/5"
        viewBox="0 0 1440 420"
        preserveAspectRatio="none"
        fill="currentColor"
      >
        <path d="M0,160 C320,260 520,40 760,120 C1020,210 1180,60 1440,140 L1440,0 L0,0 Z" />
      </svg>

      {/* Dotted pattern on the right */}
      <div className="dotted-pattern absolute right-0 top-24 hidden h-72 w-72 opacity-60 [mask-image:radial-gradient(circle,black,transparent_70%)] lg:block" />

      {/*
        Three floating paper shapes used to sit here, two of them over the copy
        column (`left-[8%] top-32` and `bottom-10 left-[20%]`). They were placed
        against a much shorter hero; with the upload row and the stats row now
        inline in that column they landed behind the headline's second line and
        behind the stats, where a white rounded rectangle behind live text reads
        as a rendering fault rather than as depth. HeroShowcase carries the
        floating-paper motif on the visual side, so they are not replaced.
      */}
    </div>
  );
}
