import { tools, isFunctional, type Tool } from "@/data/tools";
import { ToolCard } from "./ToolCard";

interface RelatedToolsProps {
  currentSlug: string;
  limit?: number;
}

/**
 * Same-category working tools first (actually related), topped up with other
 * functional tools if the category is small. Placeholder/planned tools are
 * never suggested.
 */
export function RelatedTools({ currentSlug, limit = 4 }: RelatedToolsProps) {
  const current = tools.find((t) => t.slug === currentSlug);
  const candidates = tools.filter(
    (t) => t.slug !== currentSlug && isFunctional(t),
  );
  const sameCategory = current
    ? candidates.filter((t) => t.category === current.category)
    : [];
  const others = candidates.filter((t) => !sameCategory.includes(t));
  const related: Tool[] = [...sameCategory, ...others].slice(0, limit);

  return (
    <section aria-labelledby="related-tools" className="mt-16">
      <h2 id="related-tools" className="text-lg font-bold text-navy">
        Related tools
      </h2>
      <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {related.map((tool) => (
          <ToolCard key={tool.slug} tool={tool} />
        ))}
      </div>
    </section>
  );
}
