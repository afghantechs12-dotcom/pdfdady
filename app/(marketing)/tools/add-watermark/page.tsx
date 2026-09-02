import type { Metadata } from "next";
import { ToolPageTemplate } from "@/components/tools/ToolPageTemplate";
import { AddWatermarkTool } from "@/components/tools/runners/AddWatermarkTool";
import { getToolBySlug } from "@/data/tools";
import { buildToolMetadata } from "@/lib/seo/metadata";

const tool = getToolBySlug("add-watermark")!;

export async function generateMetadata(): Promise<Metadata> {
  return buildToolMetadata(tool);
}

export default function AddWatermarkPage() {
  return (
    <ToolPageTemplate tool={tool}>
      <AddWatermarkTool />
    </ToolPageTemplate>
  );
}
