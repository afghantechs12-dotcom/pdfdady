import { ArticleBody } from "@/components/blog/ArticleBody";
import { SectionHeading } from "@/components/ui/SectionHeading";
import type { PageContent } from "@/lib/seo/adminRuntime";

/**
 * Renders admin-authored page content (title + optional description + typed
 * ContentBlocks) using the same block renderer the blog uses. Public pages call
 * this only when `getPage(key)` returns non-null, otherwise they keep their
 * built-in static design.
 */
export function AdminPageBody({ content }: { content: PageContent }) {
  return (
    <>
      <SectionHeading as="h1" title={content.title} description={content.description} />
      {content.blocks.length > 0 && (
        <div className="mt-8">
          <ArticleBody blocks={content.blocks} />
        </div>
      )}
    </>
  );
}
