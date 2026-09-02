import { PageContainer } from "@/components/layout/PageContainer";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { Icon } from "@/components/ui/Icon";
import { Reveal } from "@/components/ui/Reveal";
import type { WorkflowStep } from "@/data/howItWorks";

/**
 * The workflow explainer.
 *
 * Three steps, matching the reference's Upload → Edit → Download rhythm.
 * `data/howItWorks.ts` records why the fourth was merged rather than deleted:
 * the Workspace half of the story is still in step 3, so nothing true was cut to
 * reach three columns.
 *
 * Rendered as an ordered list because the steps genuinely are sequential; a div
 * grid would lose that for anyone not seeing the connector.
 *
 * ## Scale
 *
 * The composition was right and the scale was not: a 72px circle with a 28px
 * glyph and a 28px number badge read as a footnote next to the tool grid above
 * it. Everything grew by roughly a third — a 104px circle carrying a 60px
 * gradient tile, a 36px badge, a 3px connector at 35% opacity — while the section
 * got *shorter*, because the step copy was cut at the same time. Growing the art
 * without cutting the words would have bought impact with page length, which the
 * brief spends elsewhere.
 *
 * The connector is a dotted rule drawn between adjacent icons, hidden below `lg`
 * where the steps stack, and never drawn after the last step. Its geometry is
 * expressed against the `lg` circle size (104px → `top-[3.25rem]`, inset
 * `3.75rem` each side) so it meets the circles with a small gap rather than
 * touching them. The circles carry a thick ring in the band's own colour so the
 * rule appears to stop at their edge instead of running underneath.
 */
export function HowItWorks({ steps }: { steps: WorkflowStep[] }) {
  return (
    <section aria-labelledby="how-it-works" className="section-pad bg-lavender/40">
      <PageContainer>
        <Reveal>
          <SectionHeading
            id="how-it-works"
            title="How PDFDadi works"
            description="Three steps from a file on your desk to a file you can use."
          />
        </Reveal>

        <ol className="mt-8 grid gap-8 sm:grid-cols-3 sm:gap-5 lg:gap-10">
          {steps.map((step, i) => (
            <Reveal
              as="li"
              key={step.id}
              delay={i * 90}
              className="group relative text-center"
            >
              {/* Connector to the next step — desktop only, never after the last. */}
              {i < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className="absolute left-[calc(50%+3.75rem)] top-[3.25rem] hidden h-0 w-[calc(100%-7.5rem)] border-t-[3px] border-dashed border-primary/35 lg:block"
                />
              )}

              <span className="relative z-10 inline-flex">
                {/* The circle. A white disc with a gradient tile inside it: at
                    this size a bare glyph on white left the middle of the circle
                    empty, which is what made the row read as small. */}
                <span className="inline-flex h-24 w-24 items-center justify-center rounded-full bg-white shadow-card ring-8 ring-lavender/40 lg:h-[6.5rem] lg:w-[6.5rem]">
                  <span className="inline-flex h-[54px] w-[54px] items-center justify-center rounded-[20px] bg-gradient-to-br from-violet-400 to-primary-hover text-white shadow-[0_10px_22px_-8px_rgba(76,29,149,0.55)] transition-transform duration-300 group-hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0 lg:h-[60px] lg:w-[60px]">
                    <Icon
                      name={step.icon}
                      size={28}
                      strokeWidth={2.1}
                      aria-hidden="true"
                    />
                  </span>
                </span>

                {/* The step number, as a badge on the circle. */}
                <span className="absolute -right-1.5 -top-1.5 inline-flex h-9 w-9 items-center justify-center rounded-full bg-navy text-sm font-bold text-white ring-4 ring-lavender/40">
                  {i + 1}
                </span>
              </span>

              <h3 className="mt-5 text-lg font-bold text-navy">{step.title}</h3>
              <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-navy-soft">
                {step.description}
              </p>
            </Reveal>
          ))}
        </ol>
      </PageContainer>
    </section>
  );
}
