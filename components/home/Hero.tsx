import { ArrowRight, Check } from "lucide-react";
import { PageContainer } from "@/components/layout/PageContainer";
import { Button } from "@/components/ui/Button";
import { HeroBackground } from "@/components/background/HeroBackground";
import { HeroShowcase } from "./HeroShowcase";
import { HeroUpload, type QuickTool } from "./HeroUpload";
import { GET_STARTED_HREF } from "@/components/layout/headerLogic";

/** One checkable number shown under the hero's calls to action. */
export interface HeroStat {
  /** The figure itself, pre-formatted. */
  value: string;
  /** What it counts. */
  label: string;
}

/**
 * The homepage hero.
 *
 * ## Why there are no avatars or a star rating here
 *
 * The reference design this redesign follows puts an avatar cluster and a
 * "★★★★★ — trusted by users worldwide" line in this slot. PDFDadi has no
 * testimonials, no review corpus and no user count it can evidence, and
 * docs/launch-feature-evidence.md records a deliberate decision to remove
 * exactly that kind of claim (no ratings, no `AggregateRating`, no
 * "trusted by millions"). Re-adding it as decoration would undo that.
 *
 * The slot is kept — the layout needs the weight — but filled with figures
 * counted from the tool registry at render time (`stats`). They occupy the same
 * space, and they cannot drift: adding or removing a tool changes them.
 *
 * ## The two pills
 *
 * "Free to start" rather than "100% Free" or "Free while we build". "100% Free"
 * promises a tier that stays free, which is a business decision, not a fact —
 * data/pricing.ts prices the free plan at "$0 **today**". "Free while we build"
 * was the previous wording and reads as "nothing here costs money", which is
 * false in a deployment with Stripe configured, where Pro is purchasable. "Free
 * to start" is true in both, and matches the /pricing heading.
 *
 * "No account for browser tools" rather than the reference's bare "No Sign up
 * Required", which is true only of the browser tools — the same free plan grants
 * a Workspace, and that does need one. pricing.ts removed the unqualified
 * version of this bullet for the same reason.
 *
 * ## Composition
 *
 * A 40/60 split: copy left, `HeroShowcase` right. The visual is the larger half
 * on purpose — it is the page's centrepiece, and it is a vector product mock
 * rather than a screenshot, so it ships no image bytes and cannot go stale.
 *
 * The upload control lives HERE, inline in the copy column, rather than in a
 * standalone panel below the hero. That panel was a full-width white card with
 * 56px of internal padding around a 200px drop target, and it pushed every
 * section on the page down by roughly a third of a viewport to do the job this
 * one row does. Nothing was removed: it is the same `HeroUpload`, the same
 * `useFileUpload`, the same file handoff to a tool page.
 *
 * ## Height
 *
 * The copy column, not the visual, sets the hero's height — so the fidelity
 * pass compressed the copy column. The three stat blocks (a 24px figure over a
 * 12px label, three abreast) became one horizontal proof line, the row gaps came
 * down a step each, and the section's own padding lost 4-8px per side. The visual
 * is untouched apart from the depth notes in HeroShowcase; nothing was removed
 * and no figure changed, because every figure is counted rather than written.
 */
export function Hero({
  trustBullets,
  stats,
  quickTools,
  runnableSlugs,
}: {
  trustBullets: string[];
  stats: HeroStat[];
  quickTools: QuickTool[];
  /** Passed through to `HeroShowcase`, whose tiles each depict a real tool. */
  runnableSlugs: string[];
}) {
  return (
    <section className="relative isolate overflow-hidden pb-8 pt-8 sm:pt-10 lg:pb-12 lg:pt-14">
      <HeroBackground />
      <PageContainer maxWidth="wide">
        {/*
          38-43% / 57-62%, opening to 62.5% for the visual at 2xl — the container
          is capped at 1360px, so the only way to give the mock the extra 5% the
          brief asks for on a very large desktop is to take it from a copy column
          that has spare width there anyway.
        */}
        <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,0.68fr)_minmax(0,1fr)] lg:gap-12 xl:gap-14 2xl:grid-cols-[minmax(0,0.6fr)_minmax(0,1fr)]">
          {/* ── Copy ──────────────────────────────────────────────────────── */}
          <div>
            <div className="animate-fade-up flex flex-wrap items-center gap-2">
              <Pill>Free to start</Pill>
              <Pill>No account for browser tools</Pill>
            </div>

            {/*
              The break sits after "way", not after "to". Breaking after "to"
              left the natural wrap free to drop a lone "to" onto its own line at
              desktop widths. This way every line carries weight — the last one
              is the highlighted word — and nothing is forced `nowrap`, which at
              this size would have pushed the line past the column edge.
            */}
            {/*
              NO entrance animation on this one element, deliberately. It is the
              homepage's LCP element, and `animate-fade-up` fades opacity 0 -> 1
              over 600ms after a 60ms delay: measured against the production build,
              the headline's LCP landed at 764ms while first paint was 100ms. The
              most important sentence in the product was a ghost for two thirds of
              a second, for a fade nobody asked for. The cascade below it is
              unchanged — supporting copy arriving after a headline that is already
              there is the effect the choreography was reaching for anyway.
            */}
            <h1 className="mt-4 text-[clamp(2.4rem,4.6vw,3.9rem)] font-bold leading-[1.02] tracking-[-0.03em] text-navy">
              The smarter way
              <br className="hidden sm:block" /> to work with{" "}
              <span className="relative whitespace-nowrap text-primary">
                PDFs.
                {/* Hand-drawn underline. Decorative, so it is hidden from AT. */}
                <svg
                  aria-hidden="true"
                  viewBox="0 0 200 12"
                  preserveAspectRatio="none"
                  className="absolute -bottom-1 left-0 h-2.5 w-full text-primary/30"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="4"
                  strokeLinecap="round"
                >
                  <path d="M3 8c40-6 92-7 194-3" />
                </svg>
              </span>
            </h1>

            <p className="animate-fade-up mt-4 max-w-xl text-[1.0625rem] leading-relaxed text-navy-soft [--fade-delay:120ms]">
              Edit, convert, merge, compress, sign and organize PDFs with
              powerful tools — then keep what you make in a Workspace and pick it
              up later, with your edits and version history still there.
            </p>

            <ul className="animate-fade-up mt-4 flex flex-wrap gap-x-5 gap-y-2 [--fade-delay:180ms]">
              {trustBullets.map((bullet) => (
                <li
                  key={bullet}
                  className="inline-flex items-center gap-2 text-sm font-medium text-navy-soft"
                >
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-green-50 text-success">
                    <Check size={13} strokeWidth={3} aria-hidden="true" />
                  </span>
                  {bullet}
                </li>
              ))}
            </ul>

            <div className="animate-fade-up mt-5 flex flex-col gap-3 sm:flex-row [--fade-delay:240ms]">
              <Button
                href={GET_STARTED_HREF}
                size="lg"
                trailingIcon={<ArrowRight size={18} aria-hidden="true" />}
              >
                Get Started Free
              </Button>
              <Button href="/tools" size="lg" variant="outline">
                Explore All Tools
              </Button>
            </div>

            {/* The real drop target, compact. See the component docblock. */}
            <div className="animate-fade-up mt-4 max-w-lg [--fade-delay:280ms]">
              <HeroUpload quickTools={quickTools} variant="inline" />
            </div>

            {/*
              The reference's social-proof row. Figures, not sentiment — see the
              component docblock — and one line rather than three blocks, which
              is where most of the hero's height reduction came from.

              Still a `dl`: each item is a term and its value. `order` puts the
              value in front visually while the DOM keeps `dt` before `dd`, so a
              screen reader reads "tools ready: 32" and a sighted reader sees
              "32 tools ready".
            */}
            <dl className="animate-fade-up mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-softborder pt-4 text-sm [--fade-delay:320ms]">
              {stats.map((stat, i) => (
                <div key={stat.label} className="flex items-center gap-3">
                  {i > 0 && (
                    <span
                      aria-hidden="true"
                      className="inline-block h-1 w-1 rounded-full bg-navy/25"
                    />
                  )}
                  <span className="flex items-baseline gap-1.5">
                    <dt className="order-2 font-medium text-navy-soft">
                      {stat.label}
                    </dt>
                    <dd className="order-1 text-lg font-bold leading-none text-navy">
                      {stat.value}
                    </dd>
                  </span>
                </div>
              ))}
            </dl>
          </div>

          {/* ── Product mock ──────────────────────────────────────────────── */}
          {/*
            A small negative right margin lets the window run toward the edge of
            the container the way the reference does. It stays small: the
            floating cards sit outside the window's box, so every pixel here
            comes off them first.

            The larger pull is `2xl`, not `xl`. `max-w-panel` is 1360px, so below
            ~1424px the container is narrower than its cap and there is no spare
            gutter for a negative margin to eat into — it comes out of the
            padding instead. At exactly 1280 (the `xl` breakpoint) that left 8px,
            and the right-hand float cards at `-right-2` plus their rotation
            measured 4px past the viewport edge: clipped by `overflow-hidden`, so
            no scrollbar, but visibly sliced. From `2xl` the container is capped
            and there is ≥88px of real gutter either side. Measured at all seven
            viewports with scripts/responsive-qa.mjs.
          */}
          <div className="lg:-mr-2 2xl:-mr-6">
            <HeroShowcase runnableSlugs={runnableSlugs} />
          </div>
        </div>
      </PageContainer>
    </section>
  );
}

/** A small capability pill. Purely presentational. */
function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/15 bg-primary-soft/70 px-3 py-1 text-xs font-semibold text-primary">
      <span
        aria-hidden="true"
        className="inline-block h-1.5 w-1.5 rounded-full bg-primary"
      />
      {children}
    </span>
  );
}
