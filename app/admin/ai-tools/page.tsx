import { SectionHeader } from "@/components/admin/Section";
import { SimpleListEditor } from "@/components/admin/SimpleListEditor";
import { getAiTools } from "@/data/admin";

export const metadata = { title: "AI Tools — PDFDadi Admin" };

export default async function AdminAiToolsPage() {
  const items = await getAiTools();
  return (
    <>
      <SectionHeader
        eyebrow="Content"
        title="AI tools preview"
        description="Coming-soon AI tools on the homepage teaser. These are previews until the AI features ship."
      />
      <SimpleListEditor
        title="AI tools"
        description="Reorder with the up/down arrows."
        endpoint="/api/admin/ai-tools"
        collection="aiTools"
        initial={items as unknown as Parameters<typeof SimpleListEditor>[0]["initial"]}
        titleKey="name"
      />
    </>
  );
}
