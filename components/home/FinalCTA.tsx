import { FileText, FolderKanban } from "lucide-react";
import { PageContainer } from "@/components/layout/PageContainer";
import { Button } from "@/components/ui/Button";
import { Reveal } from "@/components/ui/Reveal";

/**
 * The closing call to action.
 *
 * Two paths, because there genuinely are two: run a tool without an account, or
 * create a Workspace. Offering only the second would misrepresent the first as
 * gated; offering only the first would repeat the hero.
 *
 * ## Gradient, not navy
 *
 * The reference closes on a wide purple→blue band, which also stops this from
 * being the second dark navy slab in three sections — `TrustStrip` is already
 * that, and two identical bands read as one section repeated. `animate-gradient-
 * drift` moves the gradient's background position only, so there is no transform,
 * no repaint of the text, and nothing to shift layout; it is in the reduced-motion
 * off-switch list in globals.css.
 *
 * The fidelity pass made the gradient richer *and* darker at once: three stops
 * (violet-800 → primary-hover → indigo-600) on the diagonal instead of two on the
 * horizontal. Contrast went up rather than down — the old middle stop was
 * `primary` (#7C3AED), the lightest surface on the band, where `text-white/80`
 * measured ~4.2:1. Against the new stops white is 7.1:1 / 6.3:1 and `text-white/80`
 * is 5.1:1 / 4.6:1, so the secondary line passes AA everywhere the gradient goes.
 * The decorative art sits at `-z-10` behind nothing but padding.
 */
export function FinalCTA() {
  return (
    <section aria-labelledby="final-cta" className="section-pad">
      <PageContainer maxWidth="wide">
        <Reveal className="animate-gradient-drift relative isolate overflow-hidden rounded-[28px] bg-gradient-to-br from-violet-800 via-primary-hover to-indigo-600 px-6 py-10 sm:px-10 lg:px-12 lg:py-12">
          {/* Soft light sources, kept behind the content. The third is the same
              sky blue the trust band uses, which is what ties the page's two
              gradient panels together without making them the same panel. */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
            <div className="absolute -left-20 -top-24 h-72 w-72 rounded-full bg-white/15 blur-[80px]" />
            <div className="absolute -bottom-28 right-0 h-72 w-72 rounded-full bg-aipink/25 blur-[90px]" />
            <div className="absolute -right-16 -top-20 h-64 w-64 rounded-full bg-aura-sky/20 blur-[80px]" />
          </div>

          <div className="grid items-center gap-8 lg:grid-cols-[auto_1fr_auto] lg:gap-10">
            {/* ── Decorative documents ─────────────────────────────────── */}
            <div className="hidden shrink-0 lg:block">
              <CTADocuments />
            </div>

            {/* ── The ask ──────────────────────────────────────────────── */}
            <div className="text-center lg:text-left">
              <h2
                id="final-cta"
                className="text-[clamp(1.6rem,3vw,2.25rem)] font-bold leading-tight tracking-tight text-white"
              >
                Ready to simplify your PDF tasks?
              </h2>
              <p className="mx-auto mt-3 max-w-xl text-[0.9375rem] leading-relaxed text-white/80 sm:text-base lg:mx-0">
                Run any browser tool right now without signing up. Create a free
                Workspace when you want the document to still be there tomorrow.
              </p>
            </div>

            {/* ── Actions ──────────────────────────────────────────────── */}
            <div className="flex shrink-0 flex-col gap-3 sm:flex-row lg:flex-col xl:flex-row">
              <Button href="/register?returnTo=/workspaces" size="lg" variant="onDark">
                Get started free
              </Button>
              <Button href="/tools" size="lg" variant="onDarkOutline">
                Explore all tools
              </Button>
            </div>
          </div>
        </Reveal>
      </PageContainer>
    </section>
  );
}

/**
 * A folder with documents spilling out of it.
 *
 * Decorative and `aria-hidden`: it carries no text and makes no claim, which is
 * the requirement for illustration on this page. Built from two rotated cards and
 * a folder tile rather than an image, so it costs no bytes and cannot shift
 * layout while loading.
 *
 * Roughly 15% larger than the first pass, and only at `lg` and up where it is
 * visible at all — the band is padded to the height of the heading and the button
 * stack, so growing the art inside that padding costs no section height.
 */
function CTADocuments() {
  return (
    <div aria-hidden="true" className="relative h-[152px] w-[190px] select-none">
      {/* Back page */}
      <div className="absolute left-9 top-0 h-[100px] w-[76px] rotate-[-12deg] rounded-lg border border-white/25 bg-white/20 backdrop-blur-sm" />

      {/* Front page, with content bars */}
      <div className="absolute left-[78px] top-2 h-[100px] w-[76px] rotate-[9deg] rounded-lg border border-white/30 bg-white p-2.5 shadow-[0_12px_28px_-8px_rgba(30,27,46,0.55)]">
        <span className="inline-flex h-[18px] w-[18px] items-center justify-center rounded bg-red-500 text-white">
          <FileText size={10} strokeWidth={2.8} />
        </span>
        <span className="mt-2 block h-1 w-full rounded-full bg-navy/15" />
        <span className="mt-1.5 block h-1 w-4/5 rounded-full bg-navy/10" />
        <span className="mt-1.5 block h-1 w-full rounded-full bg-navy/10" />
        <span className="mt-1.5 block h-1 w-3/5 rounded-full bg-navy/10" />
      </div>

      {/* Folder in front */}
      <div className="absolute bottom-0 left-0 flex h-[74px] w-[138px] items-end gap-2.5 rounded-xl rounded-tl-none border border-white/30 bg-white/25 p-3.5 backdrop-blur-sm">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-white/90 text-primary">
          <FolderKanban size={18} strokeWidth={2.2} />
        </span>
        <span className="flex-1 pb-1">
          <span className="block h-1.5 w-full rounded-full bg-white/60" />
          <span className="mt-2 block h-1.5 w-2/3 rounded-full bg-white/40" />
        </span>
      </div>
    </div>
  );
}
