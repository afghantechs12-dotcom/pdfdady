import { Hero } from "@/components/home/Hero";
import { QuickStart } from "@/components/home/QuickStart";
import { AIPreview } from "@/components/home/AIPreview";
import { PopularTools } from "@/components/home/PopularTools";
import { WorkspaceShowcase } from "@/components/home/WorkspaceShowcase";
import { HowItWorks } from "@/components/home/HowItWorks";
import { WhyChoose } from "@/components/home/WhyChoose";
import { TrustStrip } from "@/components/home/TrustStrip";
import { FAQAccordion } from "@/components/home/FAQAccordion";
import { FinalCTA } from "@/components/home/FinalCTA";
import { JsonLd } from "@/components/seo/JsonLd";
import { faqSchema } from "@/lib/seo/jsonLd";
import {
  getFaqItems,
  getFeatureItems,
  getSiteSettings,
  getToolsList,
  getToolsPopular,
  getTrustList,
} from "@/lib/seo/adminRuntime";
import {
  aiToolCount,
  availableToolCount,
  heroQuickTools,
  heroStats,
  pickShortcutTools,
} from "@/components/home/homeSections";
import { getSITE } from "@/lib/seo/metadata";
import { workflowSteps } from "@/data/howItWorks";
import { productHighlights } from "@/data/productHighlights";
import type { Metadata } from "next";

/** The homepage is the one page the layout template doesn't canonicalize. */
export async function generateMetadata(): Promise<Metadata> {
  const SITE = await getSITE();
  return {
    alternates: { canonical: `${SITE.url}/` },
    openGraph: { url: `${SITE.url}/` },
  };
}

/**
 * The homepage.
 *
 * ## The order
 *
 * Hero → quick tools → what is coming → the tools → how it works → the
 * Workspace → why this is more than tools → privacy → questions → the ask.
 *
 * `QuickStart` sits immediately under the hero and overlaps its lower edge:
 * eleven sections is a long page, and the first thing after the headline should
 * be a way into the tools rather than more prose.
 *
 * `AIPreview` replaces `AIRoadmapNote`. The note existed to shrink an eight-card
 * gradient section promoting unbuilt work down to one honest line, and that
 * constraint has not changed — the brief asks for a visible AI section, so this
 * one is labelled "Preview", contains no input, no upload control and no
 * button that appears to run anything, and links to the catalog's "Coming later"
 * list. `AIRoadmapNote` is left in the tree unused; nothing else imports it.
 *
 * The tool grid keeps reading `getToolsPopular()`. A hand-written slug list in
 * `homeSections.ts` would have matched the reference's grid exactly, but
 * `site.popularSlugs` is an admin-editable override for this grid specifically —
 * hard-coding it would have left the admin panel with a setting that silently
 * did nothing.
 *
 * ## What is deliberately not here
 *
 * Four sections were removed in the target-match pass, none of them deleted:
 *
 *  - `ProcessingExplainer` and `UseCases` moved to `/tools`, where the catalog
 *    they describe actually is. The processing model stays represented here by
 *    the trust band and by the mode badge on every tool card.
 *  - `PricingPreview` — `/pricing` is the page for it, and it is linked from the
 *    header, the footer and the final CTA's neighbourhood.
 *  - `GuidesPreview` — `/blog` is the page for it, linked from the footer.
 *
 * Everything renders on the server. `FAQAccordion` and the `Reveal` wrappers are
 * the only client components, and all of their content is server-rendered
 * children present in the initial HTML.
 */
export default async function HomePage() {
  const [faqs, features, trust, site, allTools, popularTools] =
    await Promise.all([
      getFaqItems(),
      getFeatureItems(),
      getTrustList(),
      getSiteSettings(),
      getToolsList(),
      getToolsPopular(),
    ]);

  // Every figure on this page is derived from the merged registry in
  // homeSections.ts, never written into copy — an admin who adds or removes a
  // tool must not leave the page claiming the old number. The derivations live
  // there rather than here so they are unit-testable without rendering a page.
  const quickTools = heroQuickTools(allTools);
  const availableCount = availableToolCount(allTools);
  const plannedAICount = aiToolCount(allTools);

  return (
    <>
      <JsonLd
        data={faqSchema(faqs.map((f) => ({ question: f.question, answer: f.answer })))}
      />
      <Hero
        trustBullets={site.trustBullets}
        stats={heroStats(allTools)}
        quickTools={quickTools}
      />
      <QuickStart shortcuts={pickShortcutTools(allTools)} />
      <AIPreview aiToolCount={plannedAICount} />
      <PopularTools items={popularTools} availableCount={availableCount} />
      <HowItWorks steps={workflowSteps} />
      <WorkspaceShowcase items={productHighlights} />
      <WhyChoose items={features} />
      <TrustStrip items={trust} />
      <FAQAccordion items={faqs} />
      <FinalCTA />
    </>
  );
}
