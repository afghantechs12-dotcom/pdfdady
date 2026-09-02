import type { BlogPost } from "@/data/blog";
import { getBlogWordCount as _getBlogWordCount } from "@/lib/seo/adminRuntime";
// getSITE must come from metadata.ts (NOT the raw adminRuntime re-export):
// only this version resolves SITE.logo/ogImage and normalizes SITE.url, which
// the Organization schema below depends on.
import { getSITE as _getSITE } from "@/lib/seo/metadata";

/**
 * schema.org / JSON-LD builders. Sources data from the admin store at request
 * time so user overrides show up in the structured data automatically.
 */

type Json = Record<string, unknown>;

export async function organizationSchema(): Promise<Json> {
  const SITE = await _getSITE();
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${SITE.url}/#organization`,
    name: SITE.name,
    url: SITE.url,
    logo: {
      "@type": "ImageObject",
      url: SITE.logo,
      width: 512,
      height: 512,
    },
    description: SITE.description,
    sameAs: [SITE.social.twitterUrl, SITE.social.githubUrl],
  };
}

export async function websiteSchema(): Promise<Json> {
  const SITE = await _getSITE();
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${SITE.url}/#website`,
    url: SITE.url,
    name: SITE.name,
    description: SITE.description,
    publisher: { "@id": `${SITE.url}/#organization` },
    inLanguage: "en",
    // No SearchAction: /tools has no ?q= search endpoint, and declaring a
    // non-functional one violates Google's Sitelinks-Search guidance.
  };
}

export interface BreadcrumbItem {
  name: string;
  path: string;
}

export async function breadcrumbSchema(
  items: BreadcrumbItem[],
): Promise<Json> {
  const SITE = await _getSITE();
  const abs = (path: string) =>
    path.startsWith("http") ? path : `${SITE.url}${path}`;
  return await Promise.resolve({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: abs(item.path),
    })),
  });
}

export async function articleSchema(post: BlogPost): Promise<Json> {
  const SITE = await _getSITE();
  const url = `${SITE.url}/blog/${post.slug}`;
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    "@id": `${url}/#article`,
    isPartOf: { "@id": `${SITE.url}/#website` },
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    headline: post.title,
    description: post.excerpt,
    image: [`${url}/opengraph-image`],
    datePublished: post.datePublished,
    dateModified: post.dateUpdated,
    author: {
      "@type": "Organization",
      name: post.author.name,
      url: post.author.url.startsWith("http")
        ? post.author.url
        : `${SITE.url}${post.author.url}`,
    },
    publisher: { "@id": `${SITE.url}/#organization` },
    keywords: post.tags.join(", "),
    articleSection: post.category,
    wordCount: _getBlogWordCount(post),
    inLanguage: "en",
  };
}

export async function howToSchema(post: BlogPost): Promise<Json | null> {
  const SITE = await _getSITE();
  if (!post.howTo) return null;
  return {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: post.howTo.name,
    description: post.howTo.description,
    image: [`${SITE.url}/blog/${post.slug}/opengraph-image`],
    totalTime: "PT2M",
    step: post.howTo.steps.map((s, i) => ({
      "@type": "HowToStep",
      position: i + 1,
      name: s.name,
      text: s.text,
      url: `${SITE.url}/blog/${post.slug}#step-${i + 1}`,
    })),
  };
}

export function faqSchema(
  items: { question: string; answer: string }[],
): Json | null {
  if (!items.length) return null;
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };
}

export async function softwareApplicationSchema(tool: {
  name: string;
  description: string;
  href: string;
}): Promise<Json> {
  const SITE = await _getSITE();
  const abs = (path: string) =>
    path.startsWith("http") ? path : `${SITE.url}${path}`;
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: `${tool.name} — ${SITE.name}`,
    description: tool.description,
    url: abs(tool.href),
    applicationCategory: "UtilitiesApplication",
    operatingSystem: "Any (web browser)",
    browserRequirements: "Requires a modern web browser. No installation.",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
    publisher: { "@id": `${SITE.url}/#organization` },
    isAccessibleForFree: true,
  };
}

export async function blogCollectionSchema(
  posts: BlogPost[],
): Promise<Json> {
  const SITE = await _getSITE();
  return {
    "@context": "https://schema.org",
    "@type": "Blog",
    "@id": `${SITE.url}/blog/#blog`,
    url: `${SITE.url}/blog`,
    name: `${SITE.name} Blog`,
    description:
      "Practical guides and tips for working with PDFs — merging, compressing, converting, editing and protecting documents.",
    publisher: { "@id": `${SITE.url}/#organization` },
    inLanguage: "en",
    blogPost: posts.map((post) => ({
      "@type": "BlogPosting",
      headline: post.title,
      description: post.excerpt,
      url: `${SITE.url}/blog/${post.slug}`,
      datePublished: post.datePublished,
      dateModified: post.dateUpdated,
      author: { "@type": "Organization", name: post.author.name },
    })),
  };
}
