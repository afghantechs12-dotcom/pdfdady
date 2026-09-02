import type { Metadata } from "next";
import Link from "next/link";
import { ToolPageTemplate } from "@/components/tools/ToolPageTemplate";
import { EditTool } from "@/components/tools/runners/EditTool";
import { getToolBySlug } from "@/data/tools";
import { buildToolMetadata } from "@/lib/seo/metadata";

const tool = getToolBySlug("edit-pdf")!;

export async function generateMetadata(): Promise<Metadata> {
  return buildToolMetadata(tool);
}

export default function EditPdfPage() {
  return (
    <ToolPageTemplate tool={tool} layout="preview">
      <EditTool />
      {/*
        This route does page operations only — `EditTool` is the same component
        `/tools/organize-pdf` renders. The editor that adds text, images and
        signatures is the standalone surface at `/editor`, and without this line
        a visitor who followed "Edit PDF" would conclude the product has no such
        thing. Linked rather than embedded: `components/editor/` is a banned
        import on public pages (lib/seo/publicBundles.test.ts).
      */}
      <p className="mt-6 rounded-xl bg-lavender/60 px-4 py-2.5 text-xs text-navy-soft">
        Need to add text, images, signatures or annotations?{" "}
        <Link href="/editor" className="font-semibold text-primary underline">
          Open the full editor
        </Link>
        .
      </p>
    </ToolPageTemplate>
  );
}
