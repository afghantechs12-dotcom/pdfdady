import { ArrowRight, Cloud, FolderKanban, Laptop } from "lucide-react";
import { PageContainer } from "@/components/layout/PageContainer";
import { Icon } from "@/components/ui/Icon";
import { Reveal } from "@/components/ui/Reveal";
import { cn } from "@/lib/utils/cn";
import { PROCESSING_MODE_COPY } from "@/lib/tools/processingMode";
import type { TrustItem } from "@/data/trust";

/**
 * The security and privacy band — the page's strongest single visual anchor.
 *
 * ## A trust banner, not a settings screen
 *
 * This was a dark panel containing five bordered, tinted sub-cards: four trust
 * items plus a fifth for the processing legend. Nested cards inside a nested
 * panel read as a dashboard someone had left open, which is the opposite of what
 * a trust band is for. The recomposition keeps every statement and drops the
 * chrome:
 *
 *  - the four items are a 2×2 grid separated by hairline rules (`divide-*` on
 *    `white/10`) rather than four boxes, and lead with a larger icon tile;
 *  - the processing legend is one three-column row across the band's foot, above
 *    a single rule, instead of a card of its own;
 *  - the shield is roughly 60% larger and carries a real glow, so the left half
 *    is carried by the illustration rather than by the heading's font size.
 *
 * The background moved from flat `bg-navy` to deep-navy → violet → electric-blue,
 * which is what makes it the anchor rather than merely the dark bit. It is a
 * gradient on an `isolate`d element with the glows at `-z-10`, so nothing here
 * paints over text.
 *
 * ## What it does not say
 *
 * The reference's four items are slogans ("No File Storage", "Delete After Use"),
 * and both of those are false here — Workspace storage is durable and no
 * retention job implements global auto-deletion. `FORBIDDEN_CLAIMS` in
 * lib/tools/processingMode.ts bans that wording and a test scans this file for
 * it. So the items stay as `data/trust.ts` writes them: four statements a visitor
 * can check against the product, with the full policy one link away.
 *
 * ## The processing legend
 *
 * The homepage used to explain the three processing modes in a standalone
 * "Where your file actually goes" section, which has moved to `/tools` where the
 * catalog it describes lives. The explanation itself must not be lost from the
 * homepage, so the three modes are rendered here, read straight from
 * `PROCESSING_MODE_COPY` — the same source as every tool badge on the page. A
 * mode cannot be described one way in the badge and another way in this band.
 *
 * Contrast: `text-white` on the darkest stop (#150F2E) is ~16:1 and on the
 * lightest (#1E40AF) ~8.6:1; the secondary `text-white/75` is ~11:1 and ~6.4:1.
 * Both are past AA everywhere the gradient goes. The icon tiles use `bg-white/12`
 * rather than a tinted surface, which at this opacity keeps the glyph legible
 * without lifting the tile into the text's contrast band.
 */
export function TrustStrip({ items }: { items: TrustItem[] }) {
  const modes = [
    { copy: PROCESSING_MODE_COPY.browser, icon: Laptop },
    { copy: PROCESSING_MODE_COPY["secure-cloud"], icon: Cloud },
    { copy: PROCESSING_MODE_COPY.workspace, icon: FolderKanban },
  ];

  return (
    <section aria-labelledby="trust-strip" className="section-pad">
      <PageContainer maxWidth="wide">
        <Reveal className="relative isolate overflow-hidden rounded-[28px] bg-gradient-to-br from-[#150F2E] via-[#3B1D8C] to-[#1E40AF] p-6 sm:p-10 lg:p-12">
          {/* Ambient light. Stronger than the previous pair — this band is meant
              to glow — but still behind the content and still low-opacity, so
              text contrast is unaffected. */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
            <div className="absolute -left-24 -top-24 h-[420px] w-[420px] rounded-full bg-primary/45 blur-[100px]" />
            <div className="absolute -bottom-28 right-1/4 h-80 w-80 rounded-full bg-aipink/25 blur-[100px]" />
            <div className="absolute -right-20 top-0 h-80 w-80 rounded-full bg-[#38BDF8]/25 blur-[100px]" />
          </div>

          <div className="grid gap-10 lg:grid-cols-[minmax(0,0.76fr)_minmax(0,1.24fr)] lg:items-center lg:gap-14">
            {/* ── The claim ────────────────────────────────────────────── */}
            <div>
              <ShieldArt />

              <h2
                id="trust-strip"
                className="mt-7 text-[clamp(1.65rem,3vw,2.375rem)] font-bold leading-[1.1] tracking-tight text-white"
              >
                Your privacy comes first
              </h2>
              <p className="mt-4 max-w-md text-[0.9375rem] leading-relaxed text-white/75 sm:text-base">
                We would rather tell you exactly what happens to your file than
                promise something we cannot back up.
              </p>
              <p className="mt-6">
                <a
                  href="/privacy-policy"
                  className="inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/10 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#2A1568] motion-reduce:transition-none"
                >
                  Read the full privacy policy
                  <ArrowRight size={16} aria-hidden="true" />
                </a>
              </p>
            </div>

            {/* ── The four principles ──────────────────────────────────── */}
            {/* Hairline rules instead of card borders. The per-item padding is
                computed rather than written with `nth-child` variants: the rules
                have to be inset from the group's outer edges at both column
                counts, and index arithmetic states that once, legibly. */}
            <ul className="grid divide-y divide-white/10 sm:grid-cols-2 sm:divide-x">
              {items.map((item, i) => (
                <Reveal
                  as="li"
                  key={item.id}
                  delay={i * 70}
                  className={cn(
                    "py-5 sm:px-6 sm:py-6",
                    i === 0 && "pt-0",
                    i === items.length - 1 && "pb-0",
                    i < 2 && "sm:pt-0",
                    i >= 2 && "sm:pb-0",
                    i % 2 === 0 ? "sm:pl-0" : "sm:pr-0",
                  )}
                >
                  <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-white/12 text-white ring-1 ring-inset ring-white/20">
                    <Icon
                      name={item.icon}
                      size={22}
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                  </span>
                  <p className="mt-4 text-[0.9375rem] font-bold text-white">
                    {item.title}
                  </p>
                  <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-white/70">
                    {item.description}
                  </p>
                </Reveal>
              ))}
            </ul>
          </div>

          {/* ── Processing legend ──────────────────────────────────────── */}
          {/* One row across the band's foot. The three modes every tool badge on
              this page uses, read from the same constant they are. */}
          <Reveal delay={140} className="mt-9 border-t border-white/12 pt-7">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-white/50">
              Where your file goes
            </p>
            <dl className="mt-4 grid gap-5 sm:grid-cols-3 sm:gap-8">
              {modes.map((mode) => (
                <div key={mode.copy.mode} className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/12 text-white ring-1 ring-inset ring-white/20"
                  >
                    <mode.icon size={16} strokeWidth={2.2} />
                  </span>
                  <div className="min-w-0">
                    <dt className="text-sm font-bold text-white">
                      {mode.copy.label}
                    </dt>
                    <dd className="mt-1 text-[0.8125rem] leading-snug text-white/70">
                      {mode.copy.description}
                    </dd>
                  </div>
                </div>
              ))}
            </dl>
          </Reveal>
        </Reveal>
      </PageContainer>
    </section>
  );
}

/**
 * The shield.
 *
 * Decorative and wordless by design: a security illustration with a label inside
 * it is a claim, and every claim on this band has to be one `data/trust.ts` can
 * back. This one carries no text, so it asserts nothing — the four items beside
 * it do the asserting.
 *
 * Sized up from `h-24 sm:h-28` to `h-32 sm:h-40 lg:h-44` in the fidelity pass,
 * with a second, wider glow behind it. It is the left column's subject now; the
 * heading below it no longer has to be the only thing holding that half.
 */
function ShieldArt() {
  return (
    <div aria-hidden="true" className="relative inline-flex">
      <div className="absolute -inset-6 -z-10 rounded-full bg-primary/50 blur-[56px]" />
      <div className="absolute -inset-2 -z-10 rounded-full bg-[#38BDF8]/25 blur-[40px]" />
      <svg
        viewBox="0 0 96 108"
        className="animate-shield-breathe h-32 w-auto drop-shadow-[0_18px_36px_rgba(124,58,237,0.5)] sm:h-40 lg:h-44"
        fill="none"
      >
        <defs>
          <linearGradient id="trust-shield" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#C4B5FD" />
            <stop offset="50%" stopColor="#7C3AED" />
            <stop offset="100%" stopColor="#EC4899" />
          </linearGradient>
          <linearGradient id="trust-shield-core" x1="0.2" y1="0" x2="0.8" y2="1">
            <stop offset="0%" stopColor="#A78BFA" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#4F46E5" stopOpacity="0.35" />
          </linearGradient>
        </defs>
        <path
          d="M48 4 8 20v34c0 26 18 42 40 50 22-8 40-24 40-50V20L48 4Z"
          fill="url(#trust-shield)"
          fillOpacity="0.24"
          stroke="url(#trust-shield)"
          strokeWidth="2.5"
        />
        <path
          d="M48 16 20 27v27c0 20 13 32 28 38 15-6 28-18 28-38V27L48 16Z"
          fill="url(#trust-shield-core)"
        />
        <path
          d="M34 55l10 11 20-24"
          stroke="#fff"
          strokeWidth="5.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
