import type { MetadataRoute } from "next";
import { getSITE } from "@/lib/seo/metadata";
import { getSeoSettings } from "@/lib/seo/adminRuntime";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const [SITE, seo] = await Promise.all([getSITE(), getSeoSettings()]);
  // "/admin" (no trailing slash) also matches /admin itself; "/api" keeps
  // crawlers out of the 24 API routes.
  const disallow = ["/admin", "/api", ...seo.robotsDisallow];
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow,
      },
    ],
    sitemap: `${SITE.url}/sitemap.xml`,
  };
}
