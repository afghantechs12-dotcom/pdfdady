import { PageContainer } from "@/components/layout/PageContainer";
import { PROCESSING_MODE_COPY } from "@/lib/tools/processingMode";
import { Cloud, FolderKanban, ShieldCheck } from "lucide-react";

/**
 * The processing explanation, directly under the hero.
 *
 * The homepage previously made a single global promise — that files are only
 * ever processed locally and are not sent anywhere — which was false for 14 of
 * the 32 available tools and for every Workspace document. Rather than replace
 * one blanket claim with a vaguer one, this section states all three modes side
 * by side and says which applies when.
 *
 * The copy is not written here. Every string comes from
 * `PROCESSING_MODE_COPY`, which is derived from the tool registry, so the
 * homepage cannot drift from what the tool pages say or from what the code
 * does. See docs/launch-feature-evidence.md §3.
 */
const MODE_ICONS = {
  browser: ShieldCheck,
  "secure-cloud": Cloud,
  workspace: FolderKanban,
} as const;

const MODE_WHEN: Record<keyof typeof MODE_ICONS, string> = {
  browser: "Merging, splitting, rotating, editing, signing, images to PDF",
  "secure-cloud": "Compression, OCR, repair, Office conversion, passwords",
  workspace: "Anything you choose to save to an account",
};

export function ProcessingExplainer() {
  const modes = ["browser", "secure-cloud", "workspace"] as const;

  return (
    <section aria-labelledby="processing" className="section-pad">
      <PageContainer>
        <div className="mx-auto max-w-2xl text-center">
          <h2
            id="processing"
            className="text-[clamp(1.75rem,3vw,2.5rem)] font-bold text-navy"
          >
            Where your file actually goes
          </h2>
          <p className="mt-3 text-base text-navy-soft sm:text-lg">
            It depends on the tool, so we say which one applies before you
            choose a file — rather than making one promise that could only be
            true of some of them.
          </p>
        </div>

        <dl className="mt-12 grid gap-5 md:grid-cols-3">
          {modes.map((mode) => {
            const copy = PROCESSING_MODE_COPY[mode];
            const ModeIcon = MODE_ICONS[mode];
            return (
              <div
                key={mode}
                className="flex flex-col rounded-card border border-softborder bg-white p-6 shadow-card"
              >
                <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-primary-soft text-primary">
                  <ModeIcon size={20} strokeWidth={2.1} aria-hidden="true" />
                </span>
                <dt className="mt-4 text-base font-semibold text-navy">
                  {copy.label}
                </dt>
                <dd className="mt-2 flex-1 text-sm leading-relaxed text-navy-soft">
                  {copy.description}
                </dd>
                <p className="mt-4 border-t border-softborder pt-3 text-xs leading-relaxed text-navy-soft">
                  <span className="font-semibold text-navy">Used for: </span>
                  {MODE_WHEN[mode]}
                </p>
              </div>
            );
          })}
        </dl>
      </PageContainer>
    </section>
  );
}
