import { Sparkles } from "lucide-react";
import { PageContainer } from "@/components/layout/PageContainer";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/Icon";
import type { AITool } from "@/data/aiTools";

export function AIToolsSection({ items }: { items: AITool[] }) {
  return (
    <section aria-labelledby="ai-tools" className="section-pad">
      <PageContainer>
        <div className="rounded-[28px] bg-ai-gradient p-8 sm:p-12">
          <div className="mx-auto max-w-2xl text-center">
            <Badge tone="pink" icon={<Sparkles size={14} />}>
              Coming Soon
            </Badge>
            <h2
              id="ai-tools"
              className="mt-4 text-[clamp(1.6rem,3vw,2.25rem)] font-bold text-navy"
            >
              AI PDF Tools — Coming Soon
            </h2>
            <p className="mt-3 text-base text-navy-soft sm:text-lg">
              Smart PDF tools powered by AI to save you even more time.
            </p>
          </div>

          <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {items.map((tool) => (
              <div
                key={tool.id}
                className="flex flex-col items-start gap-3 rounded-card border border-white/60 bg-white/70 p-5 backdrop-blur-sm"
              >
                <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-pink-50 text-aipink">
                  <Icon name={tool.icon} size={20} strokeWidth={2.1} />
                </span>
                <div>
                  <h3 className="text-sm font-semibold text-navy">
                    {tool.name}
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-navy-soft">
                    {tool.description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </PageContainer>
    </section>
  );
}
