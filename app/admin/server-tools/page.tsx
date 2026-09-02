import { SectionHeader } from "@/components/admin/Section";
import {
  ServerToolsManager,
  type ServerToolEntry,
} from "@/components/admin/ServerToolsManager";
import { getServerTools, getTools } from "@/data/admin";

export const metadata = { title: "Server Tools — PDFDadi Admin" };

export default async function AdminServerToolsPage() {
  const [configs, tools] = await Promise.all([getServerTools(), getTools()]);
  const nameBySlug = new Map(tools.map((t) => [t.slug, t.name]));

  const entries: ServerToolEntry[] = Object.entries(configs)
    .map(([slug, config]) => ({
      slug,
      name: nameBySlug.get(slug) ?? slug,
      config,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <SectionHeader
        eyebrow="Tools"
        title="Server Tools"
        description="Configure how each server-processed tool (compress, OCR, convert, protect, unlock…) accepts uploads and presents its options. Limits, labels, upload copy and option fields all update the live tool page and the upload API immediately."
      />
      <ServerToolsManager initial={entries} />
    </>
  );
}
