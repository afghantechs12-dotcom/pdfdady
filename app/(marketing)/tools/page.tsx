import type { Metadata } from "next";
import { getAvailableToolCount } from "@/lib/tools/capability";
import { PageContainer } from "@/components/layout/PageContainer";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { ToolsCatalog } from "@/components/tools/ToolsCatalog";
import { ProcessingExplainer } from "@/components/home/ProcessingExplainer";
import { UseCases } from "@/components/home/UseCases";
import { buildMetadata } from "@/lib/seo/metadata";
import {
  getToolsCategories,
  getToolsList,
  getUseCasesList,
} from "@/lib/seo/adminRuntime";


export async function generateMetadata(): Promise<Metadata> {
  return buildMetadata({
    title: "All PDF Tools",
    description:
      "Browse every PDFDadi tool — organize, optimize, convert, edit and secure PDFs. Each tool states where it runs before you choose a file.",
    path: "/tools",
  });
}

/**
 * The full tool catalog.
 *
 * Two sections moved here from the homepage in the target-match pass, and this
 * is where both belong:
 *
 *  - `ProcessingExplainer` ("Where your file actually goes") explains the three
 *    processing modes. Every card in the catalog below carries a mode badge, so
 *    the explanation now sits with the thing it explains rather than five
 *    screens above it on a different page. The homepage keeps the model — the
 *    trust band states it in prose and the tool cards carry the badges.
 *  - `UseCases` ("What people actually do with it") is a workflow-level view of
 *    the same catalog. Someone browsing 45 tools is exactly the reader for it.
 *
 * Neither was deleted, and neither lost content.
 */
export default async function ToolsPage() {
  const [tools, categories, useCases] = await Promise.all([
    getToolsList(),
    getToolsCategories(),
    getUseCasesList(),
  ]);
  const functionalCount = getAvailableToolCount(tools);

  return (
    <>
      <PageContainer className="section-pad">
        {/*
          The hero was three lines of preamble above a wall of 45 cards. It is now
          one heading and one sentence: someone landing here wants the tools, and
          the count is the only fact worth stating before they see them. The
          previous copy led with the total (45) which counts 13 tools nobody can
          use — the available count leads instead.
        */}
        <SectionHeading
          as="h1"
          title="All PDF tools"
          description={`${functionalCount} tools ready to use right now, free and without an account. A few more are on the way.`}
        />
        <ToolsCatalog tools={tools} categories={categories} />
      </PageContainer>
      <ProcessingExplainer />
      <UseCases items={useCases} />
    </>
  );
}
