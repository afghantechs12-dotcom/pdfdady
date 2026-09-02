import type { Metadata } from "next";
import { ToolPageTemplate } from "@/components/tools/ToolPageTemplate";
import { JpgToPdfTool } from "@/components/tools/runners/JpgToPdfTool";
import { getToolBySlug } from "@/data/tools";
import { buildToolMetadata } from "@/lib/seo/metadata";

const tool = getToolBySlug("image-to-pdf")!;

export async function generateMetadata(): Promise<Metadata> {
  return buildToolMetadata(tool);
}

export default function ImageToPdfPage() {
  return (
    <ToolPageTemplate tool={tool}>
      <JpgToPdfTool
        accept={["image/jpeg", "image/png"]}
        title="Drop your images here"
        acceptHint="JPG or PNG · One image per page · Max 50MB each"
      />
    </ToolPageTemplate>
  );
}
