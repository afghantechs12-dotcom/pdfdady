import type { Metadata } from "next";
import { ToolPageTemplate } from "@/components/tools/ToolPageTemplate";
import { RemoveMetadataTool } from "@/components/tools/runners/RemoveMetadataTool";
import { getToolBySlug } from "@/data/tools";
import { buildToolMetadata } from "@/lib/seo/metadata";

const tool = getToolBySlug("remove-pdf-metadata")!;

export async function generateMetadata(): Promise<Metadata> {
  return buildToolMetadata(tool);
}

export default function RemoveMetadataPage() {
  return (
    <ToolPageTemplate tool={tool}>
      <RemoveMetadataTool />
    </ToolPageTemplate>
  );
}
