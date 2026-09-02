import { SectionHeader } from "@/components/admin/Section";
import { SimpleListEditor } from "@/components/admin/SimpleListEditor";
import { getFeatures } from "@/data/admin";

export const metadata = { title: "Features — PDFDadi Admin" };

export default async function AdminFeaturesPage() {
  const items = await getFeatures();
  return (
    <>
      <SectionHeader
        eyebrow="Content"
        title="Features"
        description="The five selling points shown in the homepage Why Choose section."
      />
      <SimpleListEditor
        title="Features"
        description="Order is the order shown on the homepage."
        endpoint="/api/admin/features"
        collection="features"
        initial={items}
      />
    </>
  );
}
