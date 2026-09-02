import { SectionHeader } from "@/components/admin/Section";
import { SimpleListEditor } from "@/components/admin/SimpleListEditor";
import { getTrust } from "@/data/admin";

export const metadata = { title: "Trust Strip — PDFDadi Admin" };

export default async function AdminTrustPage() {
  const items = await getTrust();
  return (
    <>
      <SectionHeader
        eyebrow="Content"
        title="Trust strip"
        description="Short trust signals shown at the bottom of the homepage."
      />
      <SimpleListEditor
        title="Trust items"
        description="Reorder with the up/down arrows."
        endpoint="/api/admin/trust"
        collection="trust"
        initial={items}
      />
    </>
  );
}
