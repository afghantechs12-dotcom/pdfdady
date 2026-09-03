import { SectionHeader } from "@/components/admin/Section";
import { ToolsManager } from "@/components/admin/ToolsManager";
import {
  getOrphanToolRecords,
  getToolCategories,
  getTools,
} from "@/data/admin";

export const metadata = { title: { absolute: "Tools — PDFDadi Admin" } };

export default async function AdminToolsPage() {
  const [tools, cats, orphans] = await Promise.all([
    getTools(),
    getToolCategories(),
    getOrphanToolRecords(),
  ]);
  return (
    <>
      <SectionHeader
        eyebrow="Tools"
        title="Tools manager"
        description="Edit the editorial content of every PDF tool this build implements: name, description, icon, category and accepted file types. Edits override the defaults in /data/tools.ts. Which tools exist, whether each is available and where it runs are owned by the code."
      />
      <ToolsManager initial={tools} categories={cats} orphans={orphans} />
    </>
  );
}
