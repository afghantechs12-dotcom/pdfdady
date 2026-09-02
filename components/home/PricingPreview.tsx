import { Check } from "lucide-react";
import { PageContainer } from "@/components/layout/PageContainer";
import { Button } from "@/components/ui/Button";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { Reveal } from "@/components/ui/Reveal";
import type { PricingPlan } from "@/data/pricing";

/**
 * The pricing preview.
 *
 * Reads the same `getPricingList()` source the /pricing page uses — there is no
 * second pricing configuration. Only the plans that `data/pricing.ts` marks
 * available get a call to action; the rest are listed by name.
 *
 * ## Why this section states no billing state of its own
 *
 * Whether Pro can be bought is a per-request fact (`/api/billing/summary`, gated
 * on Stripe configuration) and this is a static server section, so it previously
 * asserted "nothing on this site can be bought yet" — false in any deployment
 * with Stripe wired up. The copy now says only what is true in every deployment
 * and sends the visitor to /pricing, which resolves the live state through
 * `ProConfigured`. A homepage preview does not need a second billing gate.
 */
export function PricingPreview({ plans }: { plans: PricingPlan[] }) {
  const available = plans.filter((p) => p.available);
  const later = plans.filter((p) => !p.available);
  if (available.length === 0) return null;

  return (
    <section aria-labelledby="pricing-preview" className="section-pad">
      <PageContainer>
        <Reveal>
          <SectionHeading
            id="pricing-preview"
            title="What it costs"
            description="Every tool that works today is free, and so is a Workspace. Paid plans add higher limits for server-side work."
          />
        </Reveal>

        <div className="mx-auto mt-10 grid max-w-4xl gap-5 md:grid-cols-2">
          {available.map((plan) => (
            <Reveal
              key={plan.id}
              className="flex flex-col rounded-card border-2 border-primary/30 bg-white p-7 shadow-card"
            >
              <h3 className="text-lg font-bold text-navy">{plan.name}</h3>
              <p className="mt-1 flex items-baseline gap-1.5">
                <span className="text-3xl font-bold text-navy">
                  {plan.price}
                </span>
                {plan.period && (
                  <span className="text-sm text-navy-soft">{plan.period}</span>
                )}
              </p>
              <p className="mt-3 text-sm leading-relaxed text-navy-soft">
                {plan.description}
              </p>
              <ul className="mt-5 flex flex-1 flex-col gap-2.5">
                {plan.features.map((feature) => (
                  <li
                    key={feature}
                    className="flex items-start gap-2 text-sm text-navy-soft"
                  >
                    <Check
                      size={14}
                      strokeWidth={3}
                      aria-hidden="true"
                      className="mt-1 shrink-0 text-success"
                    />
                    {feature}
                  </li>
                ))}
              </ul>
              <Button href={plan.href} size="lg" fullWidth className="mt-6">
                {plan.cta}
              </Button>
            </Reveal>
          ))}

          {later.length > 0 && (
            <Reveal
              delay={90}
              className="flex flex-col rounded-card border border-softborder bg-lavender/40 p-7"
            >
              <h3 className="text-lg font-bold text-navy">Coming later</h3>
              <p className="mt-3 text-sm leading-relaxed text-navy-soft">
                Nothing below is needed to use the tools. The pricing page shows
                which of these can be bought right now:
              </p>
              <ul className="mt-5 flex flex-1 flex-col gap-2.5">
                {later.map((plan) => (
                  <li key={plan.id} className="text-sm text-navy-soft">
                    <span className="font-semibold text-navy">
                      {plan.name}
                    </span>{" "}
                    — {plan.description}
                  </li>
                ))}
              </ul>
              <Button
                href="/pricing"
                size="lg"
                variant="outline"
                fullWidth
                className="mt-6"
              >
                See the details
              </Button>
            </Reveal>
          )}
        </div>
      </PageContainer>
    </section>
  );
}
