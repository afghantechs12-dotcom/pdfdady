import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ToolPageTemplate } from "@/components/tools/ToolPageTemplate";
import { ServerToolRunner } from "@/components/tools/runners/ServerToolRunner";
import { PipelineToolRunner } from "@/components/tools/runners/PipelineToolRunner";
import {
  PILOT_TOOL_SLUG,
  isProcessingPipelineEnabled,
} from "@/lib/server/processingPilot";
import {
  AiComingSoonNotice,
  PlannedNotice,
} from "@/components/tools/StatusNotice";
import { getServerToolConfigMerged } from "@/data/admin";
import { capabilityForSlug, TOOL_CAPABILITIES } from "@/lib/tools/capability";
import { buildToolMetadata } from "@/lib/seo/metadata";
import { getToolsList } from "@/lib/seo/adminRuntime";

// Functional-client tools have their own explicit folders with custom runners.
// This dynamic route serves server tools, planned tools, and AI tools.
export async function generateStaticParams() {
  // Canonical state, not merged: a `status` override that flips a browser tool to
  // server would otherwise emit a param here that collides with that tool's own
  // folder route, and one that flips a server tool to browser would drop a param
  // for a page this route still has to serve.
  return TOOL_CAPABILITIES.filter(
    (c) => c.implementationState !== "functional-client",
  ).map((c) => ({ slug: c.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const tools = await getToolsList();
  const tool = tools.find((t) => t.slug === slug);
  return tool ? buildToolMetadata(tool) : {};
}

export default async function DynamicToolPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const tools = await getToolsList();
  const tool = tools.find((t) => t.slug === slug);
  // Editorial copy comes from the merged admin list (`tool`); which page this is
  // comes from the compiled registry (`capability`). The admin tool editor has a
  // `status` select, so before this split an override could set `chat-with-pdf`
  // to `functional-server` and this route would render a real upload form for a
  // tool with no processor — a form whose only possible outcome is a failed job.
  // A CMS may rename a tool. It may not decide what this repository implements.
  const capability = capabilityForSlug(slug);

  if (!tool || !capability || capability.implementationState === "functional-client") {
    notFound();
  }

  if (capability.implementationState === "functional-server") {
    const config = await getServerToolConfigMerged(slug);
    if (!config) notFound();
    // The pilot flag chooses the runner, and nothing else about the page changes:
    // same template, same privacy note (both runners are `remote_job`, so the
    // execution policy gives them the same copy). Flipping the flag off returns
    // this page to the exact component that shipped before, which is what makes
    // the rollback a configuration change rather than a deployment.
    // This render must happen per request, because the flag it reads is one an
    // operator can flip at runtime.
    //
    // Without `connection()`, `generateStaticParams` above prerenders this page
    // during the build and freezes whichever runner the BUILD machine's flag
    // said, while `/api/jobs` goes on reading the flag per request. The two then
    // disagree, and the disagreement is not a near miss: the stale legacy runner
    // submits, the route creates a unified-pipeline job, and the legacy SSE
    // client reads the pipeline's terminal frame — which carries a `stage` and
    // no `result` — as a failure. The user is told "Processing failed" about a
    // job that completed, whose output is sitting in storage. Turning the pilot
    // on without a rebuild would have shipped exactly that.
    //
    // Kept after the root layout became `force-dynamic` for the CSP nonce, even
    // though that now makes every render per-request anyway. This line is what
    // ties the pilot's correctness to the pilot, rather than to a rendering mode
    // set three directories up for an unrelated reason: delete the layout's
    // `dynamic` export and the runner/route disagreement above comes back
    // silently. It costs nothing — `connection()` on an already-dynamic render
    // is a resolved promise.
    if (slug === PILOT_TOOL_SLUG) await connection();
    const pipeline = await isProcessingPipelineEnabled(slug);
    return (
      <ToolPageTemplate tool={tool} privacyNote="server">
        {pipeline ? (
          <PipelineToolRunner slug={slug} config={config} />
        ) : (
          <ServerToolRunner slug={slug} config={config} />
        )}
      </ToolPageTemplate>
    );
  }

  if (capability.implementationState === "coming-soon-ai") {
    return (
      <ToolPageTemplate tool={tool} privacyNote="none">
        <AiComingSoonNotice toolName={tool.name} />
      </ToolPageTemplate>
    );
  }

  // planned
  return (
    <ToolPageTemplate tool={tool} privacyNote="none">
      <PlannedNotice
        toolName={tool.name}
        reason={tool.plannedReason ?? "This tool is being prepared."}
      />
    </ToolPageTemplate>
  );
}
