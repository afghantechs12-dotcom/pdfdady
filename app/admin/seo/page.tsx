import { SectionHeader } from "@/components/admin/Section";
import { SeoForm } from "@/components/admin/SeoForm";
import { getSeo } from "@/data/admin";

export const metadata = { title: "SEO — PDFDadi Admin" };

export default async function AdminSeoPage() {
  const initial = await getSeo();
  return (
    <>
      <SectionHeader
        eyebrow="Site"
        title="SEO & metadata"
        description="Default authorship, sitemap exclusions and robots.txt disallow rules. Per-page metadata remains editable on each tool, blog post and page."
      />
      <SeoForm initial={initial} />
    </>
  );
}
