import type { Metadata } from "next";
import { ToolPageTemplate } from "@/components/tools/ToolPageTemplate";
import { MergeTool } from "@/components/tools/runners/MergeTool";
import { getToolBySlug } from "@/data/tools";
import { buildToolMetadata } from "@/lib/seo/metadata";

const tool = getToolBySlug("merge-pdf")!;

export async function generateMetadata(): Promise<Metadata> {
  return buildToolMetadata(tool);
}

export default function MergePdfPage() {
  return (
    <ToolPageTemplate tool={tool}>
      <MergeTool />
    </ToolPageTemplate>
  );
}
