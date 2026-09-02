import type { Metadata } from "next";
import { ToolPageTemplate } from "@/components/tools/ToolPageTemplate";
import { SignTool } from "@/components/tools/runners/SignTool";
import { getToolBySlug } from "@/data/tools";
import { buildToolMetadata } from "@/lib/seo/metadata";

const tool = getToolBySlug("sign-pdf")!;

export async function generateMetadata(): Promise<Metadata> {
  return buildToolMetadata(tool);
}

export default function SignPdfPage() {
  return (
    <ToolPageTemplate tool={tool} layout="preview">
      <SignTool />
    </ToolPageTemplate>
  );
}
