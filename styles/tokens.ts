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
  navy: "#1E1B2E", // dark heading/text
  navySoft: "#4B4760", // secondary text
  lavenderBg: "#F5F3FF", // soft page background
  border: "#E9E5F5", // soft border
  success: "#22C55E", // green
  warning: "#F59E0B", // orange accent
  aiPink: "#EC4899", // AI accent
  white: "#FFFFFF",
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
 * Z-index layers.
 *
 * Collected here because the editor already uses a fixed full-viewport overlay
 * at z-50 and the public header is sticky at z-50 — two unrelated surfaces
 * competing for one number is exactly how a header ends up on top of a modal.
 */
export const zIndex = {
  base: 0,
  sticky: 30, // sticky section sub-navigation (tools category rail)
  header: 40, // the public header
  drawer: 60, // mobile navigation drawer + its backdrop
  overlay: 70, // the full-viewport editor
  dialog: 80, // modal dialogs
  toast: 90, // transient notifications
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
