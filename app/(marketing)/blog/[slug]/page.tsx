import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { Badge } from "@/components/ui/Badge";
import { PageContainer } from "@/components/layout/PageContainer";
import { Breadcrumbs } from "@/components/seo/Breadcrumbs";
import { JsonLd } from "@/components/seo/JsonLd";
import { ArticleBody } from "@/components/blog/ArticleBody";
import { ArticleMeta } from "@/components/blog/ArticleMeta";
import { TableOfContents, hasToc } from "@/components/blog/TableOfContents";
import { HowToSteps } from "@/components/blog/HowToSteps";
import { ArticleFaq } from "@/components/blog/ArticleFaq";
import { AuthorBox } from "@/components/blog/AuthorBox";
import { RelatedArticles } from "@/components/blog/RelatedArticles";
import { buildArticleMetadata } from "@/lib/seo/metadata";
import {
  articleSchema,
  howToSchema,
  faqSchema,
} from "@/lib/seo/jsonLd";
import { iconToneClasses } from "@/styles/tokens";
import { cn } from "@/lib/utils/cn";
import {
  getBlogList,
  getBlogPostBySlug,
  getBlogRelated,
} from "@/lib/seo/adminRuntime";

export async function generateStaticParams() {
  const posts = await getBlogList();
  return posts.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = await getBlogPostBySlug(slug);
  if (!post) return {};
  return buildArticleMetadata(post);
}

export default async function ArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = await getBlogPostBySlug(slug);
  if (!post) notFound();

  const related = await getBlogRelated(post, 3);
  const showToc = hasToc(post);
  const [article, howTo] = await Promise.all([
    articleSchema(post),
    howToSchema(post),
  ]);

  return (
    <article>
      {/* Structured data — all derived from the same post object shown below */}
      <JsonLd
        data={[article, howTo, post.faq ? faqSchema(post.faq) : null]}
      />

      <PageContainer maxWidth="wide" className="section-pad">
        <Breadcrumbs
          items={[
            { name: "Blog", path: "/blog" },
            { name: post.title, path: `/blog/${post.slug}` },
          ]}
        />

        {/* Header */}
        <header className="mx-auto mt-6 max-w-3xl">
          <div className="flex items-center gap-2">
            <Badge tone="purple">{post.category}</Badge>
          </div>
          <h1 className="mt-4 text-[clamp(1.9rem,4vw,2.9rem)] font-bold leading-tight text-navy">
            {post.title}
          </h1>
          <p className="mt-4 text-lg leading-relaxed text-navy-soft">
            {post.excerpt}
          </p>
          <ArticleMeta post={post} />
        </header>

        {/* Hero band */}
        <div
          className={cn(
            "mx-auto mt-8 flex h-48 max-w-3xl items-center justify-center rounded-card sm:h-64",
            iconToneClasses[post.heroTone],
          )}
        >
          <Icon name={post.heroIcon} size={88} strokeWidth={1.4} />
        </div>

        {/* Body + sticky TOC */}
        <div
          className={cn(
            "mx-auto mt-10 gap-10",
            showToc
              ? "lg:grid lg:max-w-6xl lg:grid-cols-[minmax(0,1fr)_260px]"
              : "max-w-3xl",
          )}
        >
          <div className="min-w-0 max-w-3xl">
            <ArticleBody blocks={post.body} />

            {post.howTo && <HowToSteps howTo={post.howTo} />}
            {post.faq && post.faq.length > 0 && (
              <ArticleFaq items={post.faq} />
            )}
            <AuthorBox author={post.author} />
          </div>

          {showToc && (
            <aside className="hidden lg:block">
              <div className="sticky top-24">
                <TableOfContents blocks={post.body} />
              </div>
            </aside>
          )}
        </div>

        <div className="mx-auto max-w-6xl">
          <RelatedArticles posts={related} />
        </div>
      </PageContainer>
    </article>
  );
}
