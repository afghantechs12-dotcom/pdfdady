/**
 * Public runtime — wraps the data/admin helpers but re-exports them under the
 * /lib namespace so public pages don't import directly from /data/admin (which
 * is intended as an internal admin-only surface).
 *
 * Any page that was previously importing from `@/data/<section>` should switch
 * to importing the same shape from this file. The exports here are
 * server-only — they read the JSON store on every server render, and all
 * public metadata (sitemap, robots, JSON-LD) reads from them so admin edits
 * are reflected immediately on the next page load.
 */

import "server-only";
import {
  getAiTools as _getAiTools,
  getBlogAuthor as _getBlogAuthor,
  getBlogPosts as _getBlogPosts,
  getFaqs as _getFaqs,
  getFeatures as _getFeatures,
  getFooterColumns as _getFooterColumns,
  getNavLinks as _getNavLinks,
  getPopularToolsSlugs as _getPopularToolsSlugs,
  getPageContent as _getPageContent,
  getPricingPlans as _getPricingPlans,
  getSeo as _getSeo,
  getSite as _getSite,
  getToolCategories as _getToolCategories,
  getTools as _getTools,
  getTrust as _getTrust,
  getUseCases as _getUseCases,
  readStore as _readStore,
  mergedGetWordCount,
} from "@/data/admin";
import type { BlogPost } from "@/data/blog";
import type { Tool } from "@/data/tools";

export async function getSiteSettings() {
  return _getSite();
}
export { _getSite as getSITE };
export async function getSeoSettings() {
  return _getSeo();
}
export async function getToolsList() {
  return _getTools();
}
export async function getToolsCategories() {
  return _getToolCategories();
}
export async function getToolsPopularSlugs() {
  return _getPopularToolsSlugs();
}
export async function getToolsPopular(): Promise<Tool[]> {
  const [all, popular] = await Promise.all([_getTools(), _getPopularToolsSlugs()]);
  return popular
    .map((slug) => all.find((t) => t.slug === slug))
    .filter((t): t is Tool => Boolean(t));
}
export async function getFaqItems() {
  return _getFaqs();
}
export async function getFeatureItems() {
  return _getFeatures();
}
export async function getPricingList() {
  return _getPricingPlans();
}
export async function getUseCasesList() {
  return _getUseCases();
}
export async function getTrustList() {
  return _getTrust();
}
export async function getAiToolItems() {
  return _getAiTools();
}
export async function getNav() {
  return _getNavLinks();
}
export async function getFooter() {
  return _getFooterColumns();
}
export async function getBlogAuthorProfile() {
  return _getBlogAuthor();
}
export async function getBlogList(): Promise<BlogPost[]> {
  return _getBlogPosts();
}
export async function getBlogPostBySlug(slug: string): Promise<BlogPost | undefined> {
  const posts = await _getBlogPosts();
  return posts.find((p) => p.slug === slug);
}
export async function getBlogAllCategories(): Promise<string[]> {
  const posts = await _getBlogPosts();
  return Array.from(new Set(posts.map((p) => p.category)));
}
export async function getBlogRelated(
  post: BlogPost,
  limit = 3,
): Promise<BlogPost[]> {
  const all = await _getBlogPosts();
  const explicit = (post.relatedSlugs ?? [])
    .map((s) => all.find((p) => p.slug === s))
    .filter((p): p is BlogPost => Boolean(p));
  if (explicit.length >= limit) return explicit.slice(0, limit);
  const seen = new Set([post.slug, ...explicit.map((p) => p.slug)]);
  const fill = all.filter(
    (p) => !seen.has(p.slug) && p.category === post.category,
  );
  const others = all.filter(
    (p) => !seen.has(p.slug) && p.category !== post.category,
  );
  return [...explicit, ...fill, ...others].slice(0, limit);
}
export { mergedGetWordCount as getBlogWordCount };

export async function getAdminStore() {
  return _readStore();
}

export type { PageKey, PageContent } from "@/data/admin";
export async function getPage(key: import("@/data/admin").PageKey) {
  return _getPageContent(key);
}
