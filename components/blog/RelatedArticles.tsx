import { BlogCard } from "./BlogCard";
import type { BlogPost } from "@/data/blog";

/**
 * "Related articles" grid shown at the foot of an article for internal linking
 * (helps both users and crawlers discover more content).
 */
export function RelatedArticles({ posts }: { posts: BlogPost[] }) {
  if (!posts.length) return null;
  return (
    <section aria-labelledby="related-heading" className="mt-16">
      <h2 id="related-heading" className="text-2xl font-bold text-navy">
        Related articles
      </h2>
      <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {posts.map((post) => (
          <BlogCard key={post.slug} post={post} />
        ))}
      </div>
    </section>
  );
}
