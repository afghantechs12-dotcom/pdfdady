import { SectionHeader } from "@/components/admin/Section";
import { NavForm } from "@/components/admin/NavForm";
import { getFooterColumns, getNavLinks } from "@/data/admin";

export const metadata = { title: "Navigation — PDFDadi Admin" };

export default async function AdminNavPage() {
  const [links, footerColumns] = await Promise.all([getNavLinks(), getFooterColumns()]);
  return (
    <>
      <SectionHeader
        eyebrow="Site"
        title="Navigation & footer"
        description="The header bar and footer columns appear on every page. Reorder with the up/down arrows or add and remove entries."
      />
      <NavForm initialLinks={links} initialFooter={footerColumns} />
    </>
  );
}
