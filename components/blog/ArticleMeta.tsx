import { CalendarDays, RefreshCw, Clock, User } from "lucide-react";
import { formatDate } from "@/lib/utils/formatDate";
import type { BlogPost } from "@/data/blog";

/**
 * Byline row under an article title: author, published date, updated date (when
 * different), and read time. Uses <time datetime> so the dates are
 * machine-readable and consistent with the Article schema.
 */
export function ArticleMeta({ post }: { post: BlogPost }) {
  const wasUpdated = post.dateUpdated !== post.datePublished;
  return (
    <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-navy-soft">
      <span className="inline-flex items-center gap-1.5 font-medium text-navy">
        <User size={15} className="text-primary" />
        {post.author.name}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <CalendarDays size={15} />
        <time dateTime={post.datePublished}>
          {formatDate(post.datePublished)}
        </time>
      </span>
      {wasUpdated && (
        <span className="inline-flex items-center gap-1.5">
          <RefreshCw size={15} />
          Updated{" "}
          <time dateTime={post.dateUpdated}>
            {formatDate(post.dateUpdated)}
          </time>
        </span>
      )}
      <span className="inline-flex items-center gap-1.5">
        <Clock size={15} />
        {post.readTime}
      </span>
    </div>
  );
}
