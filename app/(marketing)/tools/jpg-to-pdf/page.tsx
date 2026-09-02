import type { Metadata } from "next";
import { ToolPageTemplate } from "@/components/tools/ToolPageTemplate";
import { JpgToPdfTool } from "@/components/tools/runners/JpgToPdfTool";
import { getToolBySlug } from "@/data/tools";
import { buildToolMetadata } from "@/lib/seo/metadata";

const tool = getToolBySlug("jpg-to-pdf")!;

export async function generateMetadata(): Promise<Metadata> {
  return buildToolMetadata(tool);
}

export default function JpgToPdfPage() {
  return (
    <ToolPageTemplate tool={tool}>
      <JpgToPdfTool
        accept={["image/jpeg", "image/png"]}
        title="Drop your JPG images here"
        acceptHint="JPG (PNG also accepted) · One image per page · Max 50MB each"
      />
    </ToolPageTemplate>
  );
}
