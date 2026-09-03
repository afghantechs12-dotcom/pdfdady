import { SectionHeader } from "@/components/admin/Section";
import { PagesManager, type PageContent } from "@/components/admin/PagesManager";
import { readStore } from "@/data/admin";

export const metadata = { title: { absolute: "Pages — PDFDadi Admin" } };

export default async function AdminPagesPage() {
  const s = await readStore();
  const initial: Record<string, PageContent> = {};
  for (const key of ["about", "contact", "privacy", "terms", "pricing", "serverStatus"] as const) {
    const p = (s.pages as Record<string, { title?: string; description?: string; blocks?: PageContent["blocks"] }>)[key];
    initial[key] = {
      title: p?.title ?? "",
      description: p?.description ?? "",
      blocks: p?.blocks ?? [],
    };
  }
  return (
    <>
      <SectionHeader
        eyebrow="Content"
        title="Pages"
        description="Edit the body copy shown on /about, /contact, /privacy-policy, /terms, the pricing intro and the server-status intro. Each page uses the same typed blocks as the blog."
      />
      <PagesManager initial={initial} />
    </>
  );
}
