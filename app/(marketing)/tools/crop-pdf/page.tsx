import type { Metadata } from "next";
import { ToolPageTemplate } from "@/components/tools/ToolPageTemplate";
import { CropTool } from "@/components/tools/runners/CropTool";
import { getToolBySlug } from "@/data/tools";
import { buildToolMetadata } from "@/lib/seo/metadata";

const tool = getToolBySlug("crop-pdf")!;

export async function generateMetadata(): Promise<Metadata> {
  return buildToolMetadata(tool);
}

export default function CropPdfPage() {
  return (
    <ToolPageTemplate tool={tool} layout="preview">
      <CropTool />
    </ToolPageTemplate>
  );
}
