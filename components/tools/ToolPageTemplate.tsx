import { Icon } from "@/components/ui/Icon";
import { PageContainer } from "@/components/layout/PageContainer";
import { RelatedTools } from "./RelatedTools";
import { PrivacyNote } from "./PrivacyNote";
import { Breadcrumbs } from "@/components/seo/Breadcrumbs";
import { JsonLd } from "@/components/seo/JsonLd";
import { softwareApplicationSchema } from "@/lib/seo/jsonLd";
import { ToolAnalyticsProvider } from "./ToolAnalyticsProvider";
import { executionModeForTool } from "@/lib/tools/executionPolicy";
import { iconToneClasses } from "@/styles/tokens";
import { cn } from "@/lib/utils/cn";
import type { Tool } from "@/data/tools";

interface ToolPageTemplateProps {
  tool: Tool;
  children: React.ReactNode; // interactive body or status notice
  privacyNote?: "client" | "server" | "none";
  /**
   * "narrow" (default) is the classic single-column card. "preview" widens the
   * shell so a tool can render controls beside a live <PdfPreview>; the runner
   * owns the internal two-column grid.
   */
  layout?: "narrow" | "preview";
}

export function ToolPageTemplate({
  tool,
  children,
  privacyNote = "client",
  layout = "narrow",
}: ToolPageTemplateProps) {
  const isPreview = layout === "preview";
  return (
    <PageContainer
      className="py-6 sm:py-10"
      maxWidth={isPreview ? "wide" : "narrow"}
    >
      <JsonLd data={softwareApplicationSchema(tool)} />
      <Breadcrumbs
        items={[
          { name: "Tools", path: "/tools" },
          { name: tool.name, path: tool.href },
        ]}
        className={isPreview ? undefined : "mx-auto"}
      />

      <header className="mt-5 text-left">
        <span
          className={cn(
            "inline-flex h-12 w-12 items-center justify-center rounded-2xl",
            iconToneClasses[tool.iconTone],
          )}
        >
          <Icon name={tool.icon} size={28} strokeWidth={2.1} />
        </span>
        <h1 className="mt-5 text-[clamp(1.9rem,4vw,2.75rem)] font-bold text-navy">
          {tool.name}
        </h1>
        <p className="mt-2 max-w-2xl text-base text-navy-soft">
          {tool.description}
        </p>
      </header>

      <div
        className={cn(
          "mt-6 min-h-80 rounded-card border border-softborder bg-white shadow-card",
          isPreview ? "p-5 sm:p-6" : "p-6 sm:p-8",
        )}
      >
        {/*
          Every tool page passes through here, and this is the only place that
          knows *which* tool it is — three runners serve nine slugs between them,
          so a runner cannot name itself. Wrapping here means a tool page cannot
          exist without its funnel, and the slug reported is the one the page
          declared.
        */}
        <ToolAnalyticsProvider
          toolSlug={tool.slug}
          executionMode={executionModeForTool(tool)}
        >
          {children}
        </ToolAnalyticsProvider>
      </div>

      {privacyNote !== "none" && <PrivacyNote variant={privacyNote} />}

      <RelatedTools currentSlug={tool.slug} />
    </PageContainer>
  );
}
