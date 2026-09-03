import { SectionHeader } from "@/components/admin/Section";
import { SimpleListEditor } from "@/components/admin/SimpleListEditor";
import { getUseCases } from "@/data/admin";

export const metadata = { title: { absolute: "Use Cases — PDFDadi Admin" } };

export default async function AdminUseCasesPage() {
  const items = await getUseCases();
  return (
    <>
      <SectionHeader
        eyebrow="Content"
        title="Use cases"
        description="Audiences shown on the homepage. Each entry pairs a Lucide icon with a short description."
      />
      <SimpleListEditor
        title="Use cases"
        description="Reorder with the up/down arrows."
        endpoint="/api/admin/use-cases"
        collection="useCases"
        initial={items}
      />
    </>
  );
}
