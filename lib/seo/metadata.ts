/**
 * Public metadata builder. Reads brand defaults from the admin store so a
 * user-edited SITE.url/name/description/template override the defaults in
 * /data/admin/store.json on the next page load.
 */

import type { Metadata } from "next";
import { getSiteSettings } from "@/lib/seo/adminRuntime";

const DEFAULT_URL = "https://pdfdadi.com";

export async function getSITE() {
  const site = await getSiteSettings();
  const url = site.url.replace(/\/$/, "") || DEFAULT_URL;
  return {
    ...site,
    url,
    logo: `${url}${site.logoUrl.startsWith("/") ? "" : "/"}${site.logoUrl}`,
    ogImage: `${url}${site.ogImageUrl.startsWith("/") ? "" : "/"}${site.ogImageUrl}`,
  };
}

interface BuildMetadataInput {
  title: string;
  description: string;
  path: string;
}

export async function buildMetadata({
  title,
  description,
  path,
}: BuildMetadataInput): Promise<Metadata> {
  const SITE = await getSITE();
  const url = `${SITE.url}${path}`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: SITE.name,
      locale: SITE.locale,
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      site: SITE.twitter,
    },
  };
}

export async function buildToolMetadata(tool: {
  slug?: string;
  name: string;
  description: string;
  href: string;
}): Promise<Metadata> {
  // The static tool pages pass the STATIC tool record; resolve the
  // admin-merged version by slug so title/description edits made in the
  // admin panel reach these pages too (the catalog and sitemap already do).
  let resolved = tool;
  if (tool.slug) {
    const { getToolsList } = await import("@/lib/seo/adminRuntime");
    const merged = (await getToolsList()).find((t) => t.slug === tool.slug);
    if (merged) resolved = merged;
  }
  return buildMetadata({
    title: `${resolved.name} Online`,
    description: resolved.description,
    path: resolved.href,
  });
}

export async function buildArticleMetadata(post: {
  slug: string;
  title: string;
  excerpt: string;
  datePublished: string;
  dateUpdated: string;
  author: { name: string };
  tags: string[];
}): Promise<Metadata> {
  const SITE = await getSITE();
  const path = `/blog/${post.slug}`;
  const url = `${SITE.url}${path}`;
  return {
    title: post.title,
    description: post.excerpt,
    alternates: { canonical: url },
    authors: [{ name: post.author.name }],
    keywords: post.tags,
    openGraph: {
      title: post.title,
      description: post.excerpt,
      url,
      siteName: SITE.name,
      locale: SITE.locale,
      type: "article",
      publishedTime: post.datePublished,
      modifiedTime: post.dateUpdated,
      authors: [post.author.name],
      tags: post.tags,
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description: post.excerpt,
      site: SITE.twitter,
    },
  };
}
