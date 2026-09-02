import type { Metadata } from "next";
import { ToolPageTemplate } from "@/components/tools/ToolPageTemplate";
import { EditTool } from "@/components/tools/runners/EditTool";
import { getToolBySlug } from "@/data/tools";
import { buildToolMetadata } from "@/lib/seo/metadata";

const tool = getToolBySlug("organize-pdf")!;

export async function generateMetadata(): Promise<Metadata> {
  return buildToolMetadata(tool);
}

export default function OrganizePdfPage() {
  return (
    <ToolPageTemplate tool={tool}>
      <EditTool />
    </ToolPageTemplate>
  );
}
