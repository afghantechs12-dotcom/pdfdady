import type { Metadata } from "next";
import { ToolPageTemplate } from "@/components/tools/ToolPageTemplate";
import { FillFormsTool } from "@/components/tools/runners/FillFormsTool";
import { getToolBySlug } from "@/data/tools";
import { buildToolMetadata } from "@/lib/seo/metadata";

const tool = getToolBySlug("fill-pdf-forms")!;

export async function generateMetadata(): Promise<Metadata> {
  return buildToolMetadata(tool);
}

export default function FillFormsPage() {
  return (
    <ToolPageTemplate tool={tool}>
      <FillFormsTool />
    </ToolPageTemplate>
  );
}
