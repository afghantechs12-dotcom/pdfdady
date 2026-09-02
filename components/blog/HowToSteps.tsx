import type { BlogPost } from "@/data/blog";

/**
 * Renders an article's HowTo as a visible numbered step list. The step ids
 * (#step-1, …) match the HowTo JSON-LD so the on-page steps and structured data
 * point at the same anchors.
 */
export function HowToSteps({ howTo }: { howTo: NonNullable<BlogPost["howTo"]> }) {
  return (
    <section
      aria-labelledby="howto-heading"
      className="mt-12 rounded-card border border-softborder bg-white p-6 shadow-card sm:p-8"
    >
      <h2 id="howto-heading" className="text-2xl font-bold text-navy">
        {howTo.name}
      </h2>
      <p className="mt-2 text-navy-soft">{howTo.description}</p>
      <ol className="mt-6 space-y-5">
        {howTo.steps.map((step, i) => (
          <li key={i} id={`step-${i + 1}`} className="flex gap-4 scroll-mt-28">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-bold text-primary">
              {i + 1}
            </span>
            <div className="pt-1">
              <p className="font-semibold text-navy">{step.name}</p>
              <p className="mt-1 text-[0.95rem] leading-7 text-navy-soft">
                {step.text}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
