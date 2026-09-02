import type { Metadata } from "next";
import { ToolPageTemplate } from "@/components/tools/ToolPageTemplate";
import { AddPageNumbersTool } from "@/components/tools/runners/AddPageNumbersTool";
import { getToolBySlug } from "@/data/tools";
import { buildToolMetadata } from "@/lib/seo/metadata";

const tool = getToolBySlug("add-page-numbers")!;

export async function generateMetadata(): Promise<Metadata> {
  return buildToolMetadata(tool);
}

export default function AddPageNumbersPage() {
  return (
    <ToolPageTemplate tool={tool}>
      <AddPageNumbersTool />
    </ToolPageTemplate>
  );
}
