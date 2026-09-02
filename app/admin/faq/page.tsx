import { SectionHeader } from "@/components/admin/Section";
import { FaqManager } from "@/components/admin/FaqManager";
import { getFaqs } from "@/data/admin";

export const metadata = { title: "FAQ — PDFDadi Admin" };

export default async function AdminFaqPage() {
  const items = await getFaqs();
  return (
    <>
      <SectionHeader
        eyebrow="Content"
        title="FAQ"
        description="Edit the homepage frequently asked questions. Each item is rendered both as visible UI and as FAQPage structured data."
      />
      <FaqManager initial={items} />
    </>
  );
}
