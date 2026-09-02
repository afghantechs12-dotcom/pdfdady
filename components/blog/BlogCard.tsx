import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { ArticleIllustration } from "@/components/blog/ArticleIllustration";
import { illustrationForIcon } from "@/components/blog/articleIllustrations";
import { iconToneClasses } from "@/styles/tokens";
import { formatDate } from "@/lib/utils/formatDate";
import { cn } from "@/lib/utils/cn";
import type { BlogPost } from "@/data/blog";

/**
 * Blog card for the listing grid. Semantic <article> with a linked heading.
 *
 * The hero is a workflow illustration rather than a pastel rectangle with one
 * icon (launch polish P1-12): each article's transformation — merge, compress,
 * protect, split — is drawn as a small diagram, which reads as content rather
 * than as a placeholder. Inline SVG, so there are no image requests and no
 * layout shift.
 */
export function BlogCard({ post }: { post: BlogPost }) {
  return (
    <article className="group flex flex-col overflow-hidden rounded-card border border-softborder bg-white shadow-card transition-all duration-200 hover:-translate-y-1 hover:shadow-cardhover">
      <Link
        href={`/blog/${post.slug}`}
        className="flex flex-1 flex-col focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <div
          className={cn(
            "flex h-28 items-center justify-center overflow-hidden border-b border-softborder/60",
            iconToneClasses[post.heroTone],
          )}
        >
          <ArticleIllustration
            id={illustrationForIcon(post.heroIcon)}
            tone={post.heroTone}
          />
        </div>
        <div className="flex flex-1 flex-col p-6">
          <div className="flex items-center gap-2">
            <Badge tone="neutral">{post.category}</Badge>
            <span className="text-xs text-navy-soft">{post.readTime}</span>
          </div>
          <h2 className="mt-3 text-lg font-bold leading-snug text-navy transition-colors group-hover:text-primary">
            {post.title}
          </h2>
          <p className="mt-2 flex-1 text-sm leading-relaxed text-navy-soft">
            {post.excerpt}
          </p>
          <div className="mt-4 flex items-center justify-between">
            <time
              dateTime={post.datePublished}
              className="text-xs text-navy-soft"
            >
              {formatDate(post.datePublished)}
            </time>
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary">
              Read
              <ArrowRight
                size={15}
                className="transition-transform group-hover:translate-x-0.5"
              />
            </span>
          </div>
        </div>
      </Link>
    </article>
  );
}
