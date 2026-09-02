/**
 * PDFDadi design system tokens.
 * Single source of truth for brand colors, radius, shadow, and spacing.
 * Mirrored into tailwind.config.ts so utilities like `bg-primary`,
 * `rounded-card`, and `shadow-upload` are available.
 */

export const colors = {
  primary: "#7C3AED", // brand purple
  primaryHover: "#6D28D9",
  primarySoft: "#EDE9FE", // light purple surfaces
  primarySoftHover: "#E3DCFB", // hover for a primarySoft surface
  navy: "#1E1B2E", // dark heading/text
  navySoft: "#4B4760", // secondary text
  lavenderBg: "#F5F3FF", // soft page background
  border: "#E9E5F5", // soft border
  success: "#22C55E", // green
  warning: "#F59E0B", // orange accent
  aiPink: "#EC4899", // AI accent
  white: "#FFFFFF",
} as const;

/**
 * The decorative palette: the blur auras and gradient stops behind the marketing
 * sections. Named here because they were not named anywhere.
 *
 * Six components (`HeroShowcase`, `TrustStrip`, `WorkspaceShowcase`, `WhyChoose`,
 * `FinalCTA`, `Logo`) each wrote these as arbitrary Tailwind values —
 * `bg-[#3B82F6]/25`, `stopColor="#4F46E5"`, `bg-[#38BDF8]/20` — so the homepage
 * carried a second palette with no token behind it and no way to tell a
 * deliberate accent from a typo. Two of them (`sky`, `blue`) are not derivable
 * from the brand set at all; they are here because they SHIP, and naming what
 * ships is the only way a later pass can see it and decide.
 *
 * These are decoration and nothing else: no text, border or control colour comes
 * from this group, because none of them is contrast-checked against a surface.
 * `indigo` and `violet` are the brand-adjacent gradient stops; `blue` and `sky`
 * are the cool auras; `pinkSoft` is the AI accent's wash.
 */
export const aura = {
  violet: "#8B5CF6",
  indigo: "#4F46E5",
  blue: "#3B82F6",
  blueLight: "#60A5FA",
  blueDeep: "#2563EB",
  sky: "#38BDF8",
  pinkSoft: "#F9A8D4",
  pinkDeep: "#DB2777", // the logo gradient's closing stop
  // The two deep stops of the security panel's gradient. No Tailwind palette
  // entry matches either, which is why they were hand-written; they are here so
  // that "no arbitrary hex in a component" can be an enforced rule rather than
  // an aspiration. Every other stop on the homepage turned out to be an exact
  // palette colour (violet-400, purple-600, fuchsia-600, blue-800, teal-*) and
  // now says so by name instead of by hex.
  night: "#150F2E",
  // Mid-panel value of the security band, used as a focus-ring OFFSET colour so
  // the white ring reads against the gradient. Contrast-relevant despite living
  // in the decorative group, which is why it may not stay an eyeballed literal.
  indigoPanel: "#2A1568",
  indigoDeep: "#3B1D8C",
  // The violet ramp used by the inline SVG gradients (hero device, Workspace
  // illustration, security panel, logo). Tailwind's violet-300/400/900 by value;
  // named here because an SVG `stopColor` is an attribute, not a class, so the
  // Tailwind palette is out of reach and these were hand-written hex in four
  // components. The brand gradient — the LOGO's gradient — was the part of the
  // identity least reachable from the token file.
  violetPale: "#C4B5FD",
  violetSoft: "#A78BFA",
  violetDeep: "#4C1D95",
} as const;

export const radius = {
  button: "12px", // 12–14px range
  buttonLg: "14px",
  card: "24px", // 20–28px range
  upload: "30px", // 28–32px range
} as const;

export const shadow = {
  card: "0 4px 20px rgba(124, 58, 237, 0.06)",
  cardHover: "0 10px 30px rgba(124, 58, 237, 0.12)",
  upload: "0 12px 40px rgba(124, 58, 237, 0.10)",
} as const;

export const spacing = {
  section: "clamp(64px, 8vw, 120px)", // vertical rhythm between sections
  container: "1200px", // max content width
} as const;

/**
 * Vertical rhythm scale for public page sections.
 *
 * Screenshots 9, 10 and 12 all showed the same defect: sections separated by
 * gaps large enough that the page reads as unfinished rather than spacious.
 * Naming the three densities here is what stops the fix from becoming a scatter
 * of per-page `py-*` values — the thing this milestone is explicitly not
 * allowed to do.
 *
 * `tight`   — related blocks that belong to one idea (hero → trust strip).
 * `default` — the standard gap between two independent sections.
 * `loose`   — reserved for a deliberate full-bleed break (final CTA).
 */
export const sectionRhythm = {
  tight: "clamp(40px, 4vw, 64px)",
  default: "clamp(56px, 6vw, 88px)",
  loose: "clamp(72px, 8vw, 112px)",
} as const;

/**
 * Motion durations. Every transition on the public site uses one of these, and
 * all of them are disabled under `prefers-reduced-motion` in globals.css.
 */
export const motion = {
  fast: "120ms", // hover/focus feedback
  base: "200ms", // the default for colour and shadow
  slow: "300ms", // panel and drawer movement
} as const;

/**
 * Z-index layers — the GLOBAL stacking order, mirrored into `tailwind.config.ts`
 * so every layer is a named utility (`z-drawer`, `z-dialog`, …).
 *
 * This table existed before Phase 6 and nothing consumed it. What shipped
 * instead was five arbitrary escape hatches in four files — `z-[55]`, `z-[60]`,
 * `z-[70]`, `z-[75]`, `z-[100]` — i.e. the global layer order written down five
 * times and nowhere authoritative. The numbers below are the ones that were
 * actually in the tree, named; only `menu`, `editor`, `popover` and `skipLink`
 * are new, and each replaces a literal rather than introducing a layer.
 *
 * Tailwind's numeric scale (`z-0` … `z-50`) stays available and is the right
 * choice INSIDE a component's own stacking context — a card's hover aura at
 * `-z-10`, a label above its input. The named layers are for surfaces that
 * compete across the whole page, which is the only kind that can be wrong.
 *
 * `drawer` covers a drawer AND its backdrop deliberately: they are siblings in
 * one stacking context, so DOM order decides which paints on top and the panel
 * is always rendered after its scrim. The old `z-[55]` scrim / `z-[60]` panel
 * pair was solving with a magic number what source order already settles.
 */
export const zIndex = {
  base: 0,
  sticky: 30, // sticky section sub-navigation (tools category rail)
  header: 40, // the public header, the authenticated top bar
  menu: 50, // dropdowns anchored in flow beneath the header
  editor: 50, // the full-viewport standalone editor surface
  drawer: 60, // mobile navigation drawer + its backdrop
  popover: 70, // menus/popovers PORTALLED to document.body, above the editor
  dialog: 80, // modal dialogs
  toast: 90, // transient notifications
  skipLink: 100, // above every layer, or "skip to content" cannot be seen
} as const;

/**
 * Breakpoints, mirroring Tailwind's defaults. Declared explicitly so the
 * responsive QA matrix in Phase 9 has a named contract to test against rather
 * than magic pixel values spread across components.
 */
export const breakpoints = {
  sm: "640px",
  md: "768px",
  lg: "1024px",
  xl: "1280px",
  "2xl": "1536px",
} as const;

/**
 * The single focus-ring treatment for the public site.
 *
 * WCAG 2.2 AA requires a visible focus indicator; having one string means a new
 * component cannot quietly ship with a different (or missing) one.
 */
export const focusRing =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white";

export type IconTone =
  | "purple"
  | "blue"
  | "green"
  | "orange"
  | "pink"
  | "teal"
  | "red";

export const iconToneClasses: Record<IconTone, string> = {
  purple: "bg-purple-50 text-purple-600",
  blue: "bg-blue-50 text-blue-600",
  green: "bg-green-50 text-green-600",
  orange: "bg-orange-50 text-orange-600",
  pink: "bg-pink-50 text-pink-600",
  teal: "bg-teal-50 text-teal-600",
  red: "bg-red-50 text-red-600",
};
