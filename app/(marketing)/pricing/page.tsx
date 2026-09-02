import type { Metadata } from "next";
import { Check } from "lucide-react";
import { PageContainer } from "@/components/layout/PageContainer";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { buildMetadata } from "@/lib/seo/metadata";
import { getFaqItems, getPricingList, getPage } from "@/lib/seo/adminRuntime";
import {
  ProConfigured,
  ProPriceLabel,
  ProUpgradeAction,
} from "@/components/billing/ProUpgradeAction";
import { cn } from "@/lib/utils/cn";

export async function generateMetadata(): Promise<Metadata> {
  return buildMetadata({
    title: "Pricing",
    // Unconditionally true in every deployment. The previous copy asserted
    // "paid plans are not available yet — there is no checkout", which is a
    // claim about *this deployment's* Stripe configuration baked into static
    // metadata: true with no keys set, false the moment a production build has
    // them. Metadata cannot read a per-request capability, so the honest fix is
    // copy that does not depend on one. The card below reports live state.
    description:
      "Every PDFDadi tool that works today is free, and a Workspace account costs nothing. Pro adds higher limits for server-side work; Business team billing is not built yet.",
    path: "/pricing",
  });
}

/**
 * The pricing page.
 *
 * Reads `getPricingList()` — the same merged admin source the homepage preview
 * uses. There is deliberately no second pricing configuration.
 *
 * The honesty constraints, all of which an earlier version broke somewhere: no
 * monthly/annual toggle and no "save 20%" badge, because there is one billing
 * period; and a plan that cannot be bought gets a real link to contact rather
 * than a disabled control that implies the purchase is one release away.
 *
 * ## Why the page is still static
 *
 * Pro is purchasable when the deployment has Stripe configured, and that is a
 * runtime fact — but reading it here would make this marketing page dynamic for
 * every anonymous visitor and would bake the price in at build time. So the
 * server renders the approved copy from the pricing store and three small client
 * components upgrade the Pro card in place from `/api/billing/summary`. Every one
 * of them falls back to the copy underneath it, which is why a deployment with no
 * Stripe, and a visitor whose summary request fails, both still get a page that
 * is true.
 *
 * ## What is deliberately not swapped
 *
 * Business. It is non-purchasable by domain law, not by configuration, so its
 * card is untouched server copy and gets no live control at all.
 */
export default async function PricingPage() {
  const [plans, intro, faqs] = await Promise.all([
    getPricingList(),
    getPage("pricing"),
    getFaqItems(),
  ]);

  const available = plans.filter((p) => p.available);
  const later = plans.filter((p) => !p.available);

  // The billing-relevant questions from the shared FAQ, rather than a second
  // set of answers that could contradict the homepage.
  const pricingFaqs = faqs.filter((f) => ["free", "account", "storage"].includes(f.id));

  return (
    <PageContainer className="section-pad">
      <SectionHeading
        as="h1"
        title={intro?.title || "Free to start"}
        description={
          intro?.description ??
          "Every tool that works today is free, and so is a Workspace — no card, no trial. Paid plans add higher limits for server-side work; Business team billing is not built yet."
        }
      />

      <div className="mx-auto mt-12 grid max-w-5xl gap-6 md:grid-cols-3">
        {plans.map((plan) => (
          <div
            key={plan.id}
            className={cn(
              "flex flex-col rounded-card border p-6 shadow-card",
              plan.highlighted
                ? "border-primary/40 bg-white ring-1 ring-primary/20"
                : "border-softborder bg-lavender/25",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg font-bold text-navy">{plan.name}</h2>
              {plan.id === "pro" ? (
                <ProConfigured fallback={<Badge tone="neutral">Coming later</Badge>}>
                  <Badge tone="green">Available now</Badge>
                </ProConfigured>
              ) : plan.available ? (
                <Badge tone="green">Available now</Badge>
              ) : (
                <Badge tone="neutral">Coming later</Badge>
              )}
            </div>
            <p className="mt-3 text-2xl font-bold text-navy">
              {plan.id === "pro" ? (
                // The real configured Stripe amount when it can be read, and this
                // exact approved string when it cannot. No third possibility:
                // `formatPlanPrice` returns null rather than inventing a number.
                <ProPriceLabel periodClassName="ml-1 text-sm font-medium text-navy-soft">
                  {plan.price}
                  {plan.period && (
                    <span className="ml-1 text-sm font-medium text-navy-soft">/{plan.period}</span>
                  )}
                </ProPriceLabel>
              ) : (
                <>
                  {plan.price}
                  {plan.period && (
                    <span className="ml-1 text-sm font-medium text-navy-soft">
                      /{plan.period}
                    </span>
                  )}
                </>
              )}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-navy-soft">
              {plan.description}
            </p>

            <ul className="mt-5 flex-1 space-y-2.5">
              {plan.features.map((f) => (
                <li
                  key={f}
                  className="flex items-start gap-2 text-sm text-navy-soft"
                >
                  <Check
                    size={15}
                    strokeWidth={3}
                    aria-hidden="true"
                    className={cn(
                      "mt-1 shrink-0",
                      plan.available ? "text-success" : "text-navy-soft/50",
                    )}
                  />
                  {f}
                </li>
              ))}
            </ul>

            <div className="mt-6">
              {/*
                Every plan links somewhere real. A disabled button was the old
                behaviour and it left an unavailable plan as a dead end — the
                visitor's only remaining question ("when?") had nowhere to go.
              */}
              {plan.id === "pro" ? (
                <ProUpgradeAction surface="pricing_page" variant="primary">
                  <Button href={plan.href} variant={plan.available ? "primary" : "outline"} fullWidth>
                    {plan.cta}
                  </Button>
                </ProUpgradeAction>
              ) : (
                <Button
                  href={plan.href}
                  variant={plan.available ? "primary" : "outline"}
                  fullWidth
                >
                  {plan.cta}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      <p className="mx-auto mt-8 max-w-2xl text-center text-sm text-navy-soft">
        <ProConfigured
          fallback={
            <>
              {available.length === 1 ? "One plan is" : `${available.length} plans are`}{" "}
              available today.{" "}
              {later.length > 0 &&
                `The other ${later.length === 1 ? "one is" : `${later.length} are`} not built yet — no payment details are collected anywhere on this site.`}
            </>
          }
        >
          {/*
            Still true with checkout live: card details are entered on Stripe's
            hosted page, so this site never receives them. The counting sentence is
            dropped rather than recomputed — the plan the visitor can now buy is
            the one the fallback called "not built yet".
          */}
          Free is available today, and Pro can be purchased now. Card details are entered on
          Stripe&rsquo;s hosted checkout page, never on this site.
        </ProConfigured>
      </p>

      {pricingFaqs.length > 0 && (
        <section aria-labelledby="pricing-faq" className="mx-auto mt-16 max-w-3xl">
          <h2
            id="pricing-faq"
            className="text-center text-[clamp(1.5rem,2.5vw,2rem)] font-bold text-navy"
          >
            Questions about cost
          </h2>
          <dl className="mt-8 space-y-4">
            {pricingFaqs.map((faq) => (
              <div
                key={faq.id}
                className="rounded-card border border-softborder bg-white p-5 shadow-card"
              >
                <dt className="text-sm font-semibold text-navy">
                  {faq.question}
                </dt>
                <dd className="mt-2 text-sm leading-relaxed text-navy-soft">
                  {faq.answer}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </PageContainer>
  );
}
