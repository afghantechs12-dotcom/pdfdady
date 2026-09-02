import type { Metadata } from "next";
import { ToolPageTemplate } from "@/components/tools/ToolPageTemplate";
import { AnnotateTool } from "@/components/tools/runners/AnnotateTool";
import { getToolBySlug } from "@/data/tools";
import { buildToolMetadata } from "@/lib/seo/metadata";

const tool = getToolBySlug("annotate-pdf")!;

export async function generateMetadata(): Promise<Metadata> {
  return buildToolMetadata(tool);
}

export default function AnnotatePdfPage() {
  return (
    <ToolPageTemplate tool={tool} layout="preview">
      <AnnotateTool />
    </ToolPageTemplate>
  );
}
