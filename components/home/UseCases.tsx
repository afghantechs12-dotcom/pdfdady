import { PageContainer } from "@/components/layout/PageContainer";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { UseCaseCard } from "@/components/tools/UseCaseCard";
import type { UseCase } from "@/data/useCases";

export function UseCases({ items }: { items: UseCase[] }) {
  return (
    <section aria-labelledby="use-cases" className="section-pad bg-lavender/40">
      <PageContainer>
        <SectionHeading
          id="use-cases"
          title="What people actually do with it"
          description="Four workflows, each built from tools and Workspace features that exist today."
        />
        {/* items-stretch keeps the step lists bottom-aligned across a row. */}
        <div className="mt-12 grid grid-cols-1 items-stretch gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {items.map((uc) => (
            <UseCaseCard
              key={uc.id}
              title={uc.title}
              description={uc.description}
              icon={uc.icon}
              steps={uc.steps}
            />
          ))}
        </div>
      </PageContainer>
    </section>
  );
}
