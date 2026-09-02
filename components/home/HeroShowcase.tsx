import {
  Crop,
  FileText,
  Image as ImageIcon,
  MousePointer2,
  PenTool,
  Presentation,
  Redo2,
  Sheet,
  Shapes,
  Sparkles,
  Type,
  Undo2,
} from "lucide-react";
import { floatStyle, type FloatStyle } from "./floatStyle";
import { colors, aura } from "@/styles/tokens";

/**
 * The hero's product illustration.
 *
 * A stylised editor window with format cards floating around it, a format dock
 * beneath it and a privacy shield beside it — built entirely from divs, CSS and
 * inline SVG. `aria-hidden` throughout: it is decoration, it contains no
 * information the headline beside it does not carry, and none of it is
 * interactive.
 *
 * ## Why a vector mock and not a screenshot
 *
 * The same reason recorded in WorkspaceShowcase. `i/` holds full-frame
 * screengrabs of the pre-redesign UI, so a real image would ship a stale picture
 * of screens this very redesign is changing. A vector mock costs no image bytes,
 * has no layout shift, needs no lazy-loading, and cannot go out of date the way
 * a screenshot of an unreleased build does. Capturing real product imagery
 * remains an open item.
 *
 * ## Why it does not import the editor
 *
 * It would be more "real" to render the actual editor chrome here. It is also
 * exactly what lib/seo/publicBundles.test.ts forbids: `components/editor/` is a
 * banned import on public pages, because the editor's client bundle is orders of
 * magnitude larger than everything else the homepage ships combined. Every
 * control below is a div that looks like a control.
 *
 * ## Depth
 *
 * Four independent layers, in back-to-front order: a blue rim glow and a purple
 * floor glow (both blurred, both behind), the tilted window itself, the format
 * dock overlapping its lower edge, and the float cards above everything. The
 * tilt is a CSS variable rather than a literal transform because the float
 * animation has to re-declare it — a bare `translateY` keyframe would flatten
 * the window the instant the animation started.
 *
 * ## Motion
 *
 * CSS-only, driven by keyframes in globals.css, and disabled wholesale under
 * `prefers-reduced-motion` — including the resting tilt and the dock tiles'
 * resting rotation, which flatten to an upright static composition. Each
 * floating element carries its own `--float-delay` so they drift out of phase; a
 * shared duration reads as one rigid object sliding up and down.
 */
export function HeroShowcase({ runnableSlugs }: { runnableSlugs: string[] }) {
  // Every tile and card names a real tool, so the illustration is filtered by
  // what the merged registry can actually run: a tool that stops being runnable
  // loses its chip instead of leaving a promise on the homepage. See
  // `HERO_DEPICTED_SLUGS` below and `homeSections.runnableSlugs`.
  const runnable = new Set(runnableSlugs);
  const dock = DOCK.filter((item) => runnable.has(item.slug));
  const floaters = FLOATERS.filter((card) => runnable.has(card.slug));

  return (
    <div aria-hidden="true" className="relative select-none">
      {/* ── Ambient depth ─────────────────────────────────────────────────── */}
      <div className="pointer-events-none absolute -inset-10 -z-10">
        {/* Purple floor glow — sits low and wide, so the window reads as
            standing on a surface rather than pasted onto the background. Taken
            up from /25 to /35 in the fidelity pass: at the previous opacity the
            window's own shadow was doing all the work and the composition sat
            flat on the page instead of hovering over it. */}
        <div className="animate-glow-pulse absolute bottom-2 left-1/2 h-[320px] w-[115%] -translate-x-1/2 rounded-[50%] bg-primary/35 blur-[80px]" />
        {/* Blue rim glow along the top-left edge. */}
        <div className="animate-glow-pulse absolute -left-6 top-2 h-[300px] w-[300px] rounded-full bg-aura-blue/25 blur-[80px] [animation-delay:1.4s]" />
        <div className="animate-glow-pulse absolute -right-4 top-16 h-56 w-56 rounded-full bg-aipink/20 blur-[70px] [animation-delay:2.6s]" />
      </div>

      {/* ── The editor window ─────────────────────────────────────────────── */}
      <div
        className="animate-editor-float animate-fade-up relative z-10 [--editor-tilt:none] [--fade-delay:200ms] lg:[--editor-tilt:perspective(1800px)_rotateY(-6deg)_rotateX(2deg)_rotate(-0.5deg)]"
        style={{ transform: "var(--editor-tilt)" }}
      >
        <div className="rounded-[24px] border border-white/70 bg-white/95 p-2.5 shadow-[0_2px_4px_rgba(30,27,46,0.04),0_18px_40px_-12px_rgba(76,29,149,0.28),0_48px_100px_-30px_rgba(76,29,149,0.45)] backdrop-blur">
          {/* Title bar */}
          <div className="flex items-center gap-2 rounded-t-[16px] bg-gradient-to-r from-violet-800 via-primary to-purple-600 px-3.5 py-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-white/45" />
            <span className="h-2.5 w-2.5 rounded-full bg-white/35" />
            <span className="h-2.5 w-2.5 rounded-full bg-white/25" />
            <span className="ml-2 text-[11px] font-semibold text-white/95">
              PDFDadi Editor
            </span>
            <span className="ml-2 hidden rounded-full bg-white/15 px-2 py-0.5 text-[9px] font-medium text-white/85 sm:inline">
              proposal-2026.pdf
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              <span className="rounded-md bg-white/15 px-2 py-1 text-[9px] font-semibold text-white/90">
                Share
              </span>
              <span className="rounded-md bg-white px-2 py-1 text-[9px] font-bold text-primary">
                Export
              </span>
            </span>
          </div>

          {/* Toolbar */}
          <div className="flex items-center gap-1 border-x border-softborder bg-white px-2.5 py-2">
            {TOOLBAR.map((item, i) => (
              <span
                key={item.label}
                className={`inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[9px] font-medium ${
                  i === 0 ? "bg-primary-soft text-primary" : "text-navy-soft"
                }`}
              >
                <item.icon size={11} strokeWidth={2.4} />
                <span className="hidden sm:inline">{item.label}</span>
              </span>
            ))}
            <span className="ml-auto flex items-center gap-1.5">
              <span className="hidden rounded border border-softborder px-1.5 py-0.5 text-[9px] font-medium text-navy-soft sm:inline">
                100%
              </span>
              <Undo2 size={11} className="text-navy-soft" strokeWidth={2.4} />
              <Redo2 size={11} className="text-navy-soft" strokeWidth={2.4} />
            </span>
          </div>

          <div className="relative grid grid-cols-[34px_1fr] gap-2 border-x border-softborder bg-lavender/40 p-2 sm:grid-cols-[38px_50px_1fr]">
            {/* Left editing rail */}
            <div className="flex flex-col gap-1.5 rounded-lg bg-white p-1.5 shadow-sm">
              {RAIL.map((item, i) => (
                <span
                  key={item.label}
                  className={`inline-flex h-6 w-full items-center justify-center rounded-md ${
                    i === 0 ? "bg-primary text-white" : "bg-lavender text-navy-soft"
                  }`}
                >
                  <item.icon size={12} strokeWidth={2.4} />
                </span>
              ))}
              <span className="mt-auto block h-1 w-full rounded-full bg-softborder" />
            </div>

            {/* Page thumbnails */}
            <div className="hidden flex-col gap-1.5 sm:flex">
              <span className="block h-[52px] rounded border-2 border-primary bg-white shadow-sm" />
              <span className="block h-[52px] rounded border border-softborder bg-white" />
              <span className="block h-[52px] rounded border border-softborder bg-white" />
              <span className="hidden h-[52px] rounded border border-softborder bg-white lg:block" />
            </div>

            {/* The document page */}
            <div className="relative rounded-lg bg-white p-4 shadow-[0_1px_3px_rgba(16,24,40,0.08),0_8px_20px_-8px_rgba(16,24,40,0.12)]">
              <p className="text-[15px] font-bold leading-tight text-navy">
                Business Proposal
              </p>
              <p className="mt-0.5 text-[11px] font-semibold text-primary">
                Driving growth together
              </p>

              <div className="mt-3 space-y-1.5">
                <span className="block h-1.5 w-full rounded-full bg-navy/10" />
                <span className="block h-1.5 w-11/12 rounded-full bg-navy/10" />
                <span className="block h-1.5 w-4/5 rounded-full bg-navy/10" />
              </div>

              {/* Image / content block — a gradient panel with a skyline motif
                  and a selection frame, so it reads as a placed object. */}
              <div className="relative mt-3.5">
                <div className="relative h-[92px] overflow-hidden rounded-md bg-gradient-to-br from-violet-900 via-primary to-fuchsia-600">
                  <svg
                    viewBox="0 0 200 92"
                    className="absolute inset-0 h-full w-full text-white/25"
                    fill="currentColor"
                    preserveAspectRatio="none"
                  >
                    <rect x="18" y="48" width="20" height="44" rx="2" />
                    <rect x="44" y="32" width="24" height="60" rx="2" />
                    <rect x="74" y="54" width="18" height="38" rx="2" />
                    <rect x="98" y="20" width="26" height="72" rx="2" />
                    <rect x="130" y="42" width="20" height="50" rx="2" />
                    <rect x="156" y="58" width="22" height="34" rx="2" />
                  </svg>
                  <span className="absolute right-3 top-3 h-6 w-6 rounded-full bg-white/35 blur-[2px]" />
                </div>
                {/* Selection handles. */}
                <span className="pointer-events-none absolute -inset-1 rounded-lg border border-dashed border-primary/60" />
                {["-left-1.5 -top-1.5", "-right-1.5 -top-1.5", "-bottom-1.5 -left-1.5", "-bottom-1.5 -right-1.5"].map(
                  (pos) => (
                    <span
                      key={pos}
                      className={`absolute ${pos} h-2 w-2 rounded-[2px] border border-primary bg-white`}
                    />
                  ),
                )}
              </div>

              <div className="mt-3.5 space-y-1.5">
                <span className="block h-1.5 w-full rounded-full bg-navy/10" />
                <span className="block h-1.5 w-3/4 rounded-full bg-navy/10" />
              </div>

              {/* Signature */}
              <div className="mt-3.5 flex items-end justify-between border-t border-softborder pt-2.5">
                <div>
                  <svg
                    viewBox="0 0 90 26"
                    className="h-6 w-[84px] text-navy"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M3 19c6-13 11-15 14-6s6 11 10 2 8-12 12-3 7 10 11 4 9-9 14-2 11 6 15 1" />
                  </svg>
                  <p className="text-[9px] font-medium text-navy-soft">
                    Digital Signature
                  </p>
                </div>
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-green-100">
                  <svg
                    viewBox="0 0 24 24"
                    className="h-3.5 w-3.5 text-green-600"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                </span>
              </div>

              {/*
                The AI panel, floating over the page's lower-right corner.
                Labelled "Preview" for the same reason the header's nav item is:
                nothing behind it runs, and a mock that looks live in the hero is
                a promise the product cannot keep. See components/home/AIPreview.
              */}
              <div className="absolute -bottom-3 -right-3 hidden w-[152px] rounded-xl border border-primary/15 bg-white/95 p-2.5 shadow-[0_12px_30px_-10px_rgba(76,29,149,0.4)] backdrop-blur md:block">
                <div className="flex items-center gap-1.5">
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-gradient-to-br from-primary to-aipink text-white">
                    <Sparkles size={11} strokeWidth={2.6} />
                  </span>
                  <span className="text-[9px] font-bold text-navy">
                    AI Assistant
                  </span>
                  <span className="ml-auto rounded-full bg-primary-soft px-1.5 py-0.5 text-[7px] font-bold uppercase tracking-wide text-primary">
                    Preview
                  </span>
                </div>
                <div className="mt-2 space-y-1">
                  <span className="block h-1 w-full rounded-full bg-navy/10" />
                  <span className="block h-1 w-4/5 rounded-full bg-navy/10" />
                  <span className="block h-1 w-2/3 rounded-full bg-primary/25" />
                </div>
              </div>
            </div>
          </div>

          {/* Bottom navigation controls */}
          <div className="flex items-center gap-2 rounded-b-[16px] border-x border-b border-softborder bg-white px-3 py-2">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded border border-softborder text-[10px] font-bold text-navy-soft">
              ‹
            </span>
            <span className="text-[9px] font-semibold text-navy">1 / 24</span>
            <span className="inline-flex h-5 w-5 items-center justify-center rounded border border-softborder text-[10px] font-bold text-navy-soft">
              ›
            </span>
            <span className="ml-auto flex items-center gap-1">
              <span className="block h-1 w-12 rounded-full bg-softborder" />
              <span className="block h-1 w-5 rounded-full bg-primary" />
            </span>
          </div>
        </div>
      </div>

      {/* ── Format dock ───────────────────────────────────────────────────── */}
      {/*
        Overlaps the window's lower edge and hangs into the section below it,
        which is what stitches the hero to the quick-tool strip visually. Hidden
        below `sm`, where it would land on top of the copy instead of under the
        window.
      */}
      <div className="absolute -bottom-7 left-1/2 z-20 hidden -translate-x-1/2 items-end gap-2.5 sm:flex">
        {dock.map((item, i) => (
          <div
            key={item.label}
            className={`animate-dock-float flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-2xl border border-white/70 bg-white shadow-[0_10px_24px_-8px_rgba(76,29,149,0.4)] lg:h-14 lg:w-14 ${item.className}`}
            style={floatStyle(`${i * 220}ms`, item.rotate)}
          >
            <span
              className={`inline-flex h-6 w-6 items-center justify-center rounded-lg text-white lg:h-7 lg:w-7 ${item.tone}`}
            >
              <item.icon size={13} strokeWidth={2.6} />
            </span>
            <span className="text-[7px] font-bold uppercase tracking-wide text-navy-soft lg:text-[8px]">
              {item.label}
            </span>
          </div>
        ))}
      </div>

      {/* ── Privacy shield ────────────────────────────────────────────────── */}
      {/*
        Abstract and wordless on purpose. The reference puts an absolute-security
        badge here; that wording is in FORBIDDEN_CLAIMS and is not something this
        product can assert. The shape carries the reassurance, the trust band
        further down the page carries the actual, checkable statements.

        (The claim itself is not quoted here — lib/tools/processingMode.test.ts
        scans this file as plain text and cannot tell a comment from copy.)
      */}
      <div className="animate-shield-breathe absolute -left-6 bottom-16 z-20 hidden lg:block">
        <div className="relative">
          <div className="absolute inset-0 -z-10 rounded-full bg-aura-blue/40 blur-2xl" />
          <svg
            viewBox="0 0 64 72"
            className="h-[84px] w-auto drop-shadow-[0_14px_28px_rgba(37,99,235,0.4)]"
          >
            <defs>
              <linearGradient id="pdfdadi-shield" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor={aura.blueLight} />
                <stop offset="55%" stopColor={aura.indigo} />
                <stop offset="100%" stopColor={colors.primary} />
              </linearGradient>
            </defs>
            <path
              d="M32 2 60 12v26c0 16-12 27-28 32C16 65 4 54 4 38V12L32 2Z"
              fill="url(#pdfdadi-shield)"
            />
            <path
              d="M32 2 60 12v26c0 16-12 27-28 32V2Z"
              fill={colors.navy}
              opacity="0.12"
            />
            <path
              d="M21 36l8 8 15-16"
              fill="none"
              stroke={colors.white}
              strokeWidth="5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </div>

      {/* ── Floating format cards ─────────────────────────────────────────── */}
      {/* Hidden below `sm`: at phone widths they would overlap the window and
          the headline rather than framing them. */}
      {floaters.map((card) => (
        <FloatCard key={card.label} {...card} />
      ))}
    </div>
  );
}

/** The editor toolbar's tool row. Labels only — none of it is interactive. */
const TOOLBAR = [
  { label: "Select", icon: MousePointer2 },
  { label: "Text", icon: Type },
  { label: "Image", icon: ImageIcon },
  { label: "Shape", icon: Shapes },
  { label: "Sign", icon: PenTool },
  // Crop, not Redact: Redact is a `planned` tool with no implementation, and a
  // hero control labelled with an unbuilt tool is a promise the product cannot
  // keep. Crop is a real editor tool (components/editor/toolbarLayout.ts,
  // "modify" group).
  { label: "Crop", icon: Crop },
] as const;

/** The left editing rail. */
const RAIL = [
  { label: "Select", icon: MousePointer2 },
  { label: "Text", icon: Type },
  { label: "Image", icon: ImageIcon },
  { label: "Shape", icon: Shapes },
  { label: "Sign", icon: PenTool },
] as const;

/**
 * The format dock under the window.
 *
 * Colours follow the conventional association for each format (PDF red, Word
 * blue, Excel green, PowerPoint orange, image violet) without using any
 * trademarked mark — the tiles carry a generic glyph and a short label, not a
 * logo.
 */
const DOCK = [
  {
    label: "PDF",
    slug: "merge-pdf",
    tone: "bg-red-500",
    icon: FileText,
    rotate: "-6deg",
    className: "",
  },
  {
    label: "Word",
    slug: "word-to-pdf",
    tone: "bg-blue-600",
    icon: FileText,
    rotate: "-2deg",
    className: "",
  },
  {
    label: "Excel",
    slug: "excel-to-pdf",
    tone: "bg-green-600",
    icon: Sheet,
    rotate: "1deg",
    className: "",
  },
  {
    label: "Slides",
    slug: "powerpoint-to-pdf",
    tone: "bg-orange-500",
    icon: Presentation,
    rotate: "4deg",
    className: "hidden lg:flex",
  },
  {
    label: "JPG",
    slug: "jpg-to-pdf",
    tone: "bg-violet-500",
    icon: ImageIcon,
    rotate: "7deg",
    className: "hidden lg:flex",
  },
] as const;

/** The cards drifting around the window. */
const FLOATERS = [
  {
    className: "animate-float-slow -left-5 top-8 hidden sm:flex lg:-left-12",
    delay: "0ms",
    rotate: "-8deg",
    tone: "bg-red-500",
    label: "PDF",
    slug: "merge-pdf",
    caption: "24 pages",
    icon: FileText,
  },
  {
    className: "animate-float-medium -left-3 top-1/2 hidden sm:flex lg:-left-10",
    delay: "900ms",
    rotate: "6deg",
    tone: "bg-blue-600",
    label: "Word",
    slug: "pdf-to-word",
    caption: "Converted",
    icon: FileText,
  },
  /*
    The right-hand three hug the window's right edge rather than reaching past
    it. They used to sit at lg:-right-8/-10/-12, which — on top of the visual
    column's own negative right margin — put them beyond the viewport edge at
    1024 and 1440, so each card rendered visibly sliced. The window may overflow
    its column (§2.1); a card cut in half by the window edge of the browser is
    just clipping. Verified against qa-screenshots/ at all seven viewports.
  */
  {
    className: "animate-float-fast -right-3 top-3 hidden sm:flex lg:-right-2",
    delay: "400ms",
    rotate: "9deg",
    tone: "bg-green-600",
    label: "Excel",
    slug: "excel-to-pdf",
    caption: "To PDF",
    icon: Sheet,
  },
  {
    className: "animate-float-slow -right-4 top-1/3 hidden sm:flex lg:-right-3",
    delay: "1400ms",
    rotate: "-6deg",
    tone: "bg-violet-500",
    label: "JPG",
    slug: "pdf-to-jpg",
    caption: "12 images",
    icon: ImageIcon,
  },
  {
    className: "animate-float-medium bottom-24 -right-2 hidden sm:flex lg:-right-1",
    delay: "700ms",
    rotate: "5deg",
    tone: "bg-purple-600",
    label: "Sign",
    slug: "sign-pdf",
    caption: "Signed",
    icon: PenTool,
  },
] as const;

/**
 * Every tool the illustration depicts, deduplicated.
 *
 * `lib/tools/productClaims.test.ts` asserts each one resolves in the registry
 * and is functional. Before it existed the Excel card said "Extracted" over the
 * `pdf-to-excel` slug, which is `planned` — the hero advertised a tool that does
 * not exist, and no test could see it because nothing tied the arrays to
 * `data/tools.ts`.
 */
export const HERO_DEPICTED_SLUGS: string[] = [
  ...new Set([...DOCK, ...FLOATERS].map((chip) => chip.slug)),
];

/**
 * One floating format chip. Positioned and animated entirely by the caller.
 *
 * The shadow is a three-part stack — a tight contact shadow, a mid ambient and a
 * long soft cast — plus an inset hairline. One large blur alone made the cards
 * read as flat stickers printed on the glow; the contact shadow is what puts them
 * in front of the window.
 */
function FloatCard({
  className,
  delay,
  rotate,
  tone,
  label,
  caption,
  icon: Icon,
}: {
  className: string;
  delay: string;
  rotate: string;
  tone: string;
  label: string;
  caption: string;
  icon: typeof FileText;
}) {
  const style: FloatStyle = floatStyle(delay, rotate);
  return (
    <div
      style={style}
      className={`absolute z-30 items-center gap-2 rounded-xl border border-white/70 bg-white/95 px-3 py-2.5 shadow-[0_1px_2px_rgba(30,27,46,0.06),0_8px_16px_-6px_rgba(76,29,149,0.3),0_22px_44px_-14px_rgba(76,29,149,0.5)] ring-1 ring-inset ring-white/70 backdrop-blur ${className}`}
    >
      <span
        className={`inline-flex h-7 w-7 items-center justify-center rounded-lg text-white ${tone}`}
      >
        <Icon size={15} strokeWidth={2.4} />
      </span>
      <span>
        <span className="block text-[11px] font-bold leading-none text-navy">
          {label}
        </span>
        <span className="mt-0.5 block text-[9px] font-medium leading-none text-navy-soft">
          {caption}
        </span>
      </span>
    </div>
  );
}
