import { PageContainer } from "@/components/layout/PageContainer";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { Icon } from "@/components/ui/Icon";
import { Reveal } from "@/components/ui/Reveal";
import { cn } from "@/lib/utils/cn";
import { floatStyle } from "./floatStyle";
import type { Feature } from "@/data/features";

/**
 * The "why choose PDFDadi" strip.
 *
 * The `id="features"` anchor is load-bearing: the public header and footer both
 * link to `/#features`. Renaming the section must not move it.
 *
 * ## Why the copy is not the reference's copy
 *
 * The reference's four benefits are a generic SaaS set, and the target-match
 * brief's suggested replacements ("Transparent processing", "Private by design")
 * are what the trust band immediately below this one already says at full width.
 * The items therefore stay as `getFeatureItems()` supplies them — four
 * evidence-backed capabilities from docs/launch-feature-evidence.md, admin-
 * editable, and distinct from both the Workspace panel above (what the product
 * *is*) and the trust band below (where files go). What changed here is the
 * visual weight, which was the actual mismatch.
 *
 * ## Borderless, but no longer quiet
 *
 * This was four bordered, shadowed, hover-lifting cards; then four 64px icon
 * tiles with no chrome at all, which fixed the box-on-box problem and created a
 * new one — the middle of the page had nothing to look at. `BenefitArt` is the
 * answer: a 112px illustration per item (an aura, a tilted gradient tile and two
 * drifting accent chips) on a per-item accent, with the card chrome still absent.
 * Large illustration, title, one line — separated by hairline rules at desktop.
 *
 * Rendered with local markup rather than the shared `FeatureItem`, which is used
 * on tool pages; restyling it to get this would have changed every tool page as a
 * side effect.
 *
 * `divide-x` draws the rules and `divide-y` handles the stacked case, so no
 * per-item index arithmetic is needed and the rules stay correct at one, two and
 * four columns.
 */
export function WhyChoose({ items }: { items: Feature[] }) {
  return (
    <section
      id="features"
      aria-labelledby="why-choose"
      className="section-pad bg-gradient-to-b from-white via-lavender/30 to-white"
    >
      <PageContainer>
        <Reveal>
          <SectionHeading
            id="why-choose"
            title="Why choose PDFDadi"
            description="The difference between finishing a job and being able to pick it back up."
          />
        </Reveal>

        <ul className="mt-8 grid grid-cols-1 divide-y divide-softborder sm:grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-y-0">
          {items.map((feature, i) => (
            <Reveal
              as="li"
              key={feature.id}
              delay={i * 70}
              className="group px-2 py-8 text-center sm:px-5 lg:py-3"
            >
              <BenefitArt icon={feature.icon} tone={TONES[i % TONES.length]} />
              <h3 className="mt-5 text-[1.0625rem] font-bold text-navy">
                {feature.title}
              </h3>
              <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-navy-soft">
                {feature.description}
              </p>
            </Reveal>
          ))}
        </ul>
      </PageContainer>
    </section>
  );
}

/**
 * One item's accent, as class fragments.
 *
 * Four distinct hues rather than four violets: the brief asks for PDFDadi's
 * purple/blue language *plus* appropriate semantic accents, and four identical
 * tiles in the brand colour is most of why the row read as one grey band. The
 * order is stable, so a given position keeps its colour across renders; an
 * admin-added fifth feature wraps back to the first.
 */
interface BenefitTone {
  /** The blurred halo behind the tile. */
  aura: string;
  /** The tile itself. */
  tile: string;
  /** The two drifting accent chips. */
  chip: string;
}

const TONES: BenefitTone[] = [
  { aura: "bg-primary/25", tile: "from-[#A78BFA] to-[#6D28D9]", chip: "bg-primary" },
  { aura: "bg-[#3B82F6]/25", tile: "from-[#60A5FA] to-[#2563EB]", chip: "bg-blue-500" },
  { aura: "bg-aipink/25", tile: "from-[#F9A8D4] to-[#DB2777]", chip: "bg-aipink" },
  { aura: "bg-[#14B8A6]/25", tile: "from-[#5EEAD4] to-[#0D9488]", chip: "bg-teal-500" },
];

/**
 * The illustration for one benefit.
 *
 * Four layers: a blurred aura, a soft ring, the tilted gradient tile carrying the
 * feature's own icon, and two accent chips drifting out of phase with each other.
 * `aria-hidden` — the heading beside it names the benefit, and a screen reader
 * gains nothing from "gradient square".
 *
 * The tile counter-rotates on hover (`group-hover`) toward upright, which reads
 * as the object turning to face you; both the rotation and the drift are off
 * under `prefers-reduced-motion`, the drift because `float-drift` is in the
 * globals.css off-switch and the rotation because `motion-reduce` cancels it.
 */
function BenefitArt({ icon, tone }: { icon: string; tone: BenefitTone }) {
  return (
    <span
      aria-hidden="true"
      className="relative mx-auto block h-28 w-28 select-none"
    >
      {/* Aura + ring */}
      <span className={cn("absolute inset-3 rounded-full blur-[26px]", tone.aura)} />
      <span className="absolute inset-1 rounded-full border border-softborder/70 bg-white/40" />

      {/* The tile */}
      <span
        className={cn(
          "absolute left-1/2 top-1/2 inline-flex h-[68px] w-[68px] -translate-x-1/2 -translate-y-1/2 rotate-[-7deg] items-center justify-center rounded-[22px] bg-gradient-to-br text-white shadow-[0_14px_28px_-10px_rgba(30,27,46,0.45)] transition-transform duration-300 group-hover:rotate-0 motion-reduce:transition-none motion-reduce:group-hover:rotate-[-7deg]",
          tone.tile,
        )}
      >
        <Icon name={icon} size={30} strokeWidth={2} />
      </span>

      {/* Accent chips */}
      <span
        className="animate-float-medium absolute right-1 top-2 block h-3 w-3 rounded-full bg-white shadow-sm ring-1 ring-softborder"
        style={floatStyle("200ms", "0deg")}
      >
        <span className={cn("absolute inset-[3px] rounded-full", tone.chip)} />
      </span>
      <span
        className="animate-float-fast absolute bottom-2.5 left-0 block h-2 w-2 rounded-full opacity-70"
        style={floatStyle("900ms", "0deg")}
      >
        <span className={cn("absolute inset-0 rounded-full", tone.chip)} />
      </span>
    </span>
  );
}
