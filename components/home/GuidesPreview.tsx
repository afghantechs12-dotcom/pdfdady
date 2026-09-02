import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PageContainer } from "@/components/layout/PageContainer";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/Icon";
import { Reveal } from "@/components/ui/Reveal";
import { iconToneClasses } from "@/styles/tokens";
import { formatDate } from "@/lib/utils/formatDate";
import { cn } from "@/lib/utils/cn";
import type { BlogPost } from "@/data/blog";

/**
 * Three guides on the homepage.
 *
 * Does not reuse `BlogCard`, which renders its title as an `h2` — correct on
 * the blog index where each card is a top-level item, but on the homepage that
 * would put the article titles at the same level as the section heading above
 * them and break the outline. Same visual treatment, `h3` titles.
 */
export function GuidesPreview({ posts }: { posts: BlogPost[] }) {
  if (posts.length === 0) return null;

  return (
    <section aria-labelledby="guides" className="section-pad">
      <PageContainer>
        <Reveal>
          <SectionHeading
            id="guides"
            title="Helpful guides"
            align="left"
            description="How to get specific jobs done, written by the people who built the tools."
            action={{ label: "All guides", href: "/blog" }}
          />
        </Reveal>

        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {posts.map((post, i) => (
            <Reveal
              as="article"
              key={post.slug}
              delay={i * 70}
              className="group flex flex-col overflow-hidden rounded-card border border-softborder bg-white shadow-card transition-shadow duration-200 hover:shadow-cardhover motion-reduce:transition-none"
            >
              <Link
                href={`/blog/${post.slug}`}
                className="flex flex-1 flex-col focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50"
              >
                <div
                  className={cn(
                    "flex h-28 items-center justify-center",
                    iconToneClasses[post.heroTone],
                  )}
                  aria-hidden="true"
                >
                  <Icon name={post.heroIcon} size={34} strokeWidth={1.8} />
                </div>
                <div className="flex flex-1 flex-col p-5">
                  <div className="flex items-center gap-2">
                    <Badge tone="neutral">{post.category}</Badge>
                    <span className="text-xs text-navy-soft">
                      {post.readTime}
                    </span>
                  </div>
                  <h3 className="mt-3 text-base font-bold leading-snug text-navy transition-colors group-hover:text-primary">
                    {post.title}
                  </h3>
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
                      <ArrowRight size={15} aria-hidden="true" />
                    </span>
                  </div>
                </div>
              </Link>
            </Reveal>
          ))}
        </div>
      </PageContainer>
    </section>
  );
}
