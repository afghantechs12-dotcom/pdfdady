/**
 * Button variant/size class maps, kept separate from the component so they can
 * be asserted in the Node test environment (there is no DOM test setup).
 *
 * Why this file exists at all: `cn` (lib/utils/cn.ts) is a plain string joiner
 * with no Tailwind conflict resolution. When a call site passes
 * `className="bg-white text-navy"` to a variant that already declares
 * `bg-primary text-white`, *both* land in the class attribute and the winner is
 * whichever utility sorts later in the compiled stylesheet — not the one the
 * author intended.
 *
 * That is a real bug we shipped: the homepage dark CTA rendered a white button
 * with white text, because `.bg-white` sorts after `.bg-primary` (the override
 * won) while `.text-navy` sorts *before* `.text-white` (the override lost).
 *
 * The fix is structural: colour decisions live in variants, and each variant
 * declares a complete, self-consistent set — background, foreground, hover and
 * focus ring. `BUTTON_BASE` deliberately does **not** name a ring colour, so no
 * variant has to out-sort it.
 */

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "outline"
  | "onDark"
  | "onDarkOutline";

export type ButtonSize = "sm" | "md" | "lg";

/**
 * Layout/motion/state classes shared by every variant. Contains `ring-2` but no
 * `ring-<colour>`: the colour is the variant's job, so a dark-surface variant
 * never has to override a light-surface ring.
 */
export const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 disabled:opacity-60 disabled:pointer-events-none";

export const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-white hover:bg-primary-hover shadow-card hover:shadow-cardhover focus-visible:ring-primary/40",
  secondary:
    "bg-primary-soft text-primary hover:bg-primary-softhover focus-visible:ring-primary/40",
  ghost:
    "bg-transparent text-navy hover:bg-lavender focus-visible:ring-primary/40",
  outline:
    "bg-white text-navy border border-softborder hover:border-primary hover:text-primary focus-visible:ring-primary/40",

  // ── Dark-surface variants ────────────────────────────────────────────────
  // For buttons on `bg-navy` / `bg-app-sidebar`. The ring is white and offset
  // against the dark panel, because a `primary/40` ring is close to invisible
  // on navy. `forced-colors` keeps a visible border in Windows High Contrast,
  // where background colours are replaced by the system palette.
  //
  // `onDarkOutline`'s border is `white/60`, not `white/40`. At /40 over the
  // closing CTA's gradient the outline was a suggestion rather than an edge —
  // the button read as a text link beside a solid white one. /60 with a faint
  // wash behind it makes it legibly the second of two buttons; it is still the
  // quieter of the pair, and the contrast only went up.
  onDark:
    "bg-white text-navy hover:bg-lavender focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-navy forced-colors:border forced-colors:border-[ButtonBorder]",
  onDarkOutline:
    "bg-white/5 text-white border border-white/60 hover:border-white/90 hover:bg-white/15 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-navy forced-colors:border-[ButtonBorder]",
};

export const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-9 px-4 text-sm rounded-button",
  md: "h-11 px-5 text-sm rounded-button",
  lg: "h-13 px-7 text-base rounded-buttonlg py-3.5",
};
