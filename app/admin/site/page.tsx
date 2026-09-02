import { SectionHeader } from "@/components/admin/Section";
import { SiteSettingsForm } from "@/components/admin/SiteSettingsForm";
import { getSite } from "@/data/admin";

export const metadata = { title: "Site Settings — PDFDadi Admin" };

export default async function AdminSitePage() {
  const initial = await getSite();
  return (
    <>
      <SectionHeader
        eyebrow="Site"
        title="Site settings"
        description="Brand name, default titles, social URLs, footer copy and trust bullets — all edits apply instantly across the public site."
      />
      <SiteSettingsForm initial={initial} />
    </>
  );
}
