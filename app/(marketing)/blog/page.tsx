import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PageContainer } from "@/components/layout/PageContainer";
import { Badge } from "@/components/ui/Badge";
import { Breadcrumbs } from "@/components/seo/Breadcrumbs";
import { JsonLd } from "@/components/seo/JsonLd";
import { BlogGrid } from "@/components/blog/BlogGrid";
import { ArticleIllustration } from "@/components/blog/ArticleIllustration";
import { illustrationForIcon } from "@/components/blog/articleIllustrations";
import { buildMetadata } from "@/lib/seo/metadata";
import { blogCollectionSchema } from "@/lib/seo/jsonLd";
import { iconToneClasses } from "@/styles/tokens";
import { formatDate } from "@/lib/utils/formatDate";
import { cn } from "@/lib/utils/cn";
import {
  getBlogAllCategories,
  getBlogList,
} from "@/lib/seo/adminRuntime";

export async function generateMetadata(): Promise<Metadata> {
  return buildMetadata({
    title: "PDF Guides, Tips & Tutorials",
    description:
      "Practical, step-by-step guides for working with PDFs: merge, compress, convert, edit, protect and more. Free tips from the PDFDadi team.",
    path: "/blog",
  });
}

export default async function BlogPage() {
  const [posts, categories] = await Promise.all([
    getBlogList(),
    getBlogAllCategories(),
  ]);
  const featured = posts.find((p) => p.featured) ?? posts[0];
  const rest = posts.filter((p) => p.slug !== featured.slug);

  return (
    <PageContainer className="section-pad">
      <JsonLd data={await blogCollectionSchema(posts)} />
      <Breadcrumbs items={[{ name: "Blog", path: "/blog" }]} />

      <header className="mt-6 max-w-2xl">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">
          The PDFDadi Blog
        </p>
        <h1 className="mt-2 text-[clamp(2rem,4vw,3rem)] font-bold leading-tight text-navy">
          Guides & tips for working with PDFs
        </h1>
        <p className="mt-4 text-lg text-navy-soft">
          Clear, step-by-step tutorials to help you merge, compress, convert,
          edit and protect your documents — free and private, right in your
          browser.
        </p>
      </header>

      {/* Featured post */}
      <Link
        href={`/blog/${featured.slug}`}
        className="group mt-10 block overflow-hidden rounded-card border border-softborder bg-white shadow-card transition-all hover:-translate-y-1 hover:shadow-cardhover"
      >
        <div className="grid md:grid-cols-2">
          <div
            className={cn(
              "flex min-h-[180px] items-center justify-center overflow-hidden p-8 md:min-h-[300px]",
              iconToneClasses[featured.heroTone],
            )}
          >
            <ArticleIllustration
              id={illustrationForIcon(featured.heroIcon)}
              tone={featured.heroTone}
              className="h-auto w-full max-w-[340px]"
            />
          </div>
          <div className="flex flex-col justify-center p-7 sm:p-10">
            <div className="flex items-center gap-2">
              <Badge tone="purple">Featured</Badge>
              <Badge tone="neutral">{featured.category}</Badge>
            </div>
            <h2 className="mt-4 text-2xl font-bold leading-snug text-navy transition-colors group-hover:text-primary sm:text-3xl">
              {featured.title}
            </h2>
            <p className="mt-3 text-navy-soft">{featured.excerpt}</p>
            <div className="mt-5 flex items-center gap-4 text-sm text-navy-soft">
              <time dateTime={featured.datePublished}>
                {formatDate(featured.datePublished)}
              </time>
              <span aria-hidden>·</span>
              <span>{featured.readTime}</span>
            </div>
            <span className="mt-6 inline-flex items-center gap-1.5 font-semibold text-primary">
              Read article
              <ArrowRight
                size={16}
                className="transition-transform group-hover:translate-x-0.5"
              />
            </span>
          </div>
        </div>
      </Link>

      {/* Filterable grid of the rest */}
      <div className="mt-14">
        <BlogGrid posts={rest} categories={categories} />
      </div>
    </PageContainer>
  );
}
