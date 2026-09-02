import { SectionHeader } from "@/components/admin/Section";
import { CategoriesManager } from "@/components/admin/CategoriesManager";
import { getToolCategories } from "@/data/admin";

export const metadata = { title: "Tool Categories — PDFDadi Admin" };

export default async function AdminToolCategoriesPage() {
  const cats = await getToolCategories();
  return (
    <>
      <SectionHeader
        eyebrow="Tools"
        title="Tool categories"
        description="Edit the human labels used by the All Tools tabs and the homepage groupings. The category IDs are fixed so they must stay stable."
      />
      <CategoriesManager initial={cats} />
    </>
  );
}
