import type { MetadataRoute } from "next";
import {
  getBlogList,
  getSeoSettings,
  getToolsList,
} from "@/lib/seo/adminRuntime";
import { getSITE } from "@/lib/seo/metadata";
import { capabilityForSlug } from "@/lib/tools/capability";

type Freq =
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "always"
  | "hourly"
  | "never";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [SITE, tools, posts, seo] = await Promise.all([
    getSITE(),
    getToolsList(),
    getBlogList(),
    getSeoSettings(),
  ]);
  const now = new Date();
  const excluded = new Set(seo.sitemapExcluded);

  const freq = (f: Freq): Freq => f;

  const staticEntries: MetadataRoute.Sitemap = [
    { url: `${SITE.url}/`, lastModified: now, changeFrequency: freq("daily"), priority: 1 },
    { url: `${SITE.url}/tools`, lastModified: now, changeFrequency: freq("weekly"), priority: 0.9 },
    { url: `${SITE.url}/blog`, lastModified: now, changeFrequency: freq("weekly"), priority: 0.8 },
    { url: `${SITE.url}/pricing`, lastModified: now, changeFrequency: freq("monthly"), priority: 0.6 },
    { url: `${SITE.url}/about`, lastModified: now, changeFrequency: freq("monthly"), priority: 0.5 },
    { url: `${SITE.url}/contact`, lastModified: now, changeFrequency: freq("yearly"), priority: 0.3 },
    { url: `${SITE.url}/privacy-policy`, lastModified: now, changeFrequency: freq("yearly"), priority: 0.3 },
    { url: `${SITE.url}/terms`, lastModified: now, changeFrequency: freq("yearly"), priority: 0.3 },
  ].filter((e) => !excluded.has(new URL(e.url).pathname));

  // Only working tools belong in the sitemap — "planned" / "coming-soon-ai"
  // slugs render thin placeholder stubs and shouldn't be pushed to crawlers.
  //
  // Availability and the URL both come from the capability row, not from the
  // merged record: a submitted URL is a promise that the route exists and works,
  // and the capability row is the only thing that answers for either. The
  // previous filter matched `tool.status`, which let a stored record claiming
  // `functional-server` into the sitemap for a slug nothing implements — a
  // crawler was pointed at a 404. `getToolsList` no longer emits such a record,
  // and this second gate means neither surface has to be trusted alone.
  const toolEntries: MetadataRoute.Sitemap = tools
    .flatMap((tool) => {
      const capability = capabilityForSlug(tool.slug);
      if (!capability?.available) return [];
      return [
        {
          url: `${SITE.url}${capability.route}`,
          lastModified: now,
          changeFrequency: freq("weekly"),
          priority: 0.8,
        },
      ];
    });

  const blogEntries: MetadataRoute.Sitemap = posts.map((post) => ({
    url: `${SITE.url}/blog/${post.slug}`,
    lastModified: new Date(`${post.dateUpdated}T00:00:00Z`),
    changeFrequency: freq("monthly"),
    priority: 0.7,
  }));

  return [...staticEntries, ...toolEntries, ...blogEntries];
}
