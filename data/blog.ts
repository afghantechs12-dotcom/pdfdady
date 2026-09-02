import type { IconTone } from "@/styles/tokens";

// Re-exported so consumers can keep importing from "@/data/blog"; the value
// lives in its own module to avoid a blog.ts <-> blogPosts.ts import cycle.
export { AUTHOR_PDFDADI_TEAM } from "./blogAuthor";

/**
 * Blog content model — the single source of truth for BOTH the rendered UI and
 * the JSON-LD structured data, so the two can never diverge. Article bodies are
 * expressed as typed ContentBlocks (not markdown) which keeps rendering
 * on-brand, dependency-free, and lets us derive HowTo / FAQ / wordCount schema
 * from the exact content shown to the reader.
 */

export type ContentBlock =
  | { type: "heading"; level: 2 | 3; id: string; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered?: boolean; items: string[] }
  | { type: "callout"; variant: "info" | "tip" | "warning"; text: string }
  | { type: "quote"; text: string; cite?: string }
  | { type: "toolCta"; toolSlug: string; label?: string };

export interface HowToStep {
  name: string;
  text: string;
}

export interface BlogFaqItem {
  question: string;
  answer: string;
}

export interface BlogAuthor {
  name: string;
  url: string;
  bio: string;
}

export interface BlogPost {
  slug: string;
  title: string;
  excerpt: string;
  category: string;
  tags: string[];
  author: BlogAuthor;
  datePublished: string; // ISO 8601 (YYYY-MM-DD)
  dateUpdated: string; // ISO 8601
  readTime: string;
  featured?: boolean;
  heroIcon: string; // lucide-react icon name
  heroTone: IconTone;
  relatedToolSlug?: string;
  body: ContentBlock[];
  howTo?: { name: string; description: string; steps: HowToStep[] };
  faq?: BlogFaqItem[];
  relatedSlugs?: string[];
}

// Articles are defined in ./blogPosts and re-exported here so this file stays
// the stable import surface (`@/data/blog`).
export { blogPosts } from "./blogPosts";

// ---- Derived helpers -------------------------------------------------------

import { blogPosts } from "./blogPosts";

export function getPostBySlug(slug: string): BlogPost | undefined {
  return blogPosts.find((p) => p.slug === slug);
}

export function getAllCategories(): string[] {
  return Array.from(new Set(blogPosts.map((p) => p.category)));
}

export function getRelatedPosts(post: BlogPost, limit = 3): BlogPost[] {
  const explicit = (post.relatedSlugs ?? [])
    .map((s) => blogPosts.find((p) => p.slug === s))
    .filter((p): p is BlogPost => Boolean(p));

  if (explicit.length >= limit) return explicit.slice(0, limit);

  // Fill remaining slots with same-category, then any other recent posts.
  const seen = new Set([post.slug, ...explicit.map((p) => p.slug)]);
  const fill = blogPosts.filter(
    (p) => !seen.has(p.slug) && p.category === post.category,
  );
  const others = blogPosts.filter(
    (p) => !seen.has(p.slug) && p.category !== post.category,
  );
  return [...explicit, ...fill, ...others].slice(0, limit);
}

/** Word count across text-bearing blocks — used for Article `wordCount` schema. */
export function getWordCount(post: BlogPost): number {
  const countWords = (s: string) =>
    s.trim().split(/\s+/).filter(Boolean).length;
  let total = countWords(post.title) + countWords(post.excerpt);
  for (const block of post.body) {
    if (block.type === "paragraph" || block.type === "heading") {
      total += countWords(block.text);
    } else if (block.type === "list") {
      total += block.items.reduce((n, i) => n + countWords(i), 0);
    } else if (block.type === "callout" || block.type === "quote") {
      total += countWords(block.text);
    }
  }
  if (post.howTo) {
    total += post.howTo.steps.reduce(
      (n, s) => n + countWords(s.name) + countWords(s.text),
      0,
    );
  }
  if (post.faq) {
    total += post.faq.reduce(
      (n, f) => n + countWords(f.question) + countWords(f.answer),
      0,
    );
  }
  return total;
}
