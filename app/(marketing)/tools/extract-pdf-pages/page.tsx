import type { Metadata } from "next";
import { ToolPageTemplate } from "@/components/tools/ToolPageTemplate";
import { SplitTool } from "@/components/tools/runners/SplitTool";
import { getToolBySlug } from "@/data/tools";
import { buildToolMetadata } from "@/lib/seo/metadata";

const tool = getToolBySlug("extract-pdf-pages")!;

export async function generateMetadata(): Promise<Metadata> {
  return buildToolMetadata(tool);
}

export default function ExtractPdfPagesPage() {
  return (
    <ToolPageTemplate tool={tool}>
      <SplitTool />
    </ToolPageTemplate>
  );
}
