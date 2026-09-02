import { SectionHeader } from "@/components/admin/Section";
import {
  BlogAuthorForm,
  BlogManager,
} from "@/components/admin/BlogManager";
import { getBlogAuthor, getBlogPosts } from "@/data/admin";

export const metadata = { title: "Blog — PDFDadi Admin" };

export default async function AdminBlogPage() {
  const [posts, author] = await Promise.all([getBlogPosts(), getBlogAuthor()]);
  return (
    <>
      <SectionHeader
        eyebrow="Content"
        title="Blog"
        description="Create, edit and reorder SEO articles. Each post uses the same typed block format the public site renders."
      />
      <div className="mb-6">
        <BlogAuthorForm initial={author} />
      </div>
      <BlogManager initial={posts} />
    </>
  );
}
