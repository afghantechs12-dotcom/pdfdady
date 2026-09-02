import { Sparkles } from "lucide-react";
import { PageContainer } from "@/components/layout/PageContainer";

/**
 * The AI roadmap note.
 *
 * This replaces a full-width gradient section that promoted eight unbuilt AI
 * tools in a five-card grid, positioned above the use cases and FAQ — more
 * homepage real estate than every real feature combined, for work that has not
 * started (docs/launch-feature-evidence.md, C11).
 *
 * What is left is a single line of text near the bottom of the page. It names
 * no individual tool, because naming "Chat with PDF" and "Summarize" is
 * marketing them; it carries no link, because there is nothing to link to; and
 * it has no interactive element, because every affordance here would be fake.
 * It says "later", not "soon" — no date has been committed to.
 */
export function AIRoadmapNote() {
  return (
    <section aria-labelledby="ai-roadmap" className="pb-4">
      <PageContainer>
        <div className="flex flex-col items-start gap-3 rounded-card border border-softborder bg-white px-5 py-4 sm:flex-row sm:items-center">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary">
            <Sparkles size={17} strokeWidth={2.1} aria-hidden="true" />
          </span>
          <div>
            <h2 id="ai-roadmap" className="text-sm font-semibold text-navy">
              Coming later: AI document features
            </h2>
            <p className="mt-0.5 text-sm text-navy-soft">
              We are working on them. They are not part of PDFDadi yet, so
              nothing on this site depends on them and nothing here is priced
              for them.
            </p>
          </div>
        </div>
      </PageContainer>
    </section>
  );
}
