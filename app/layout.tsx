import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { JsonLd } from "@/components/seo/JsonLd";
import { organizationSchema, websiteSchema } from "@/lib/seo/jsonLd";
import { getSITE } from "@/lib/seo/metadata";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

/**
 * Every route renders per request, because the CSP nonce cannot survive a prerender.
 *
 * Set on the ROOT layout, so it applies to the whole app rather than to a list of
 * routes someone has to remember to extend. Measured on the real standalone artifact
 * before this line existed: `/editor` (already dynamic) served 24 nonced scripts and
 * 0 unnonced, while prerendered `/` served 84 unnonced inline `<script>` and 0 nonced.
 * The nonce arrives on a request header; a prerender happened at build time, when no
 * request existed, and `base-server.js` replays that HTML from the response cache
 * without consulting the nonce at all (the word does not appear in the file). Next 16
 * offers no way to inject one into a prerender.
 *
 * So the choice is per-request rendering or a nonce that reaches nothing on 92 of the
 * app's routes. The alternative — baking one fixed nonce into the static HTML so it
 * can stay static — turns the nonce into a published constant that an injected script
 * can satisfy, which is worse than having no nonce at all because it looks protected.
 *
 * The cost is bounded and measured: ~1–3ms per page, because these pages read their
 * content from `data/admin/store.json`, not a database. It also fixes a standing lie
 * in `lib/seo/metadata.ts`, which promises admin SEO edits apply "on the next page
 * load" — true for dynamic routes, false for every prerendered one until now.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const SITE = await getSITE();
  return {
    metadataBase: new URL(SITE.url),
    title: {
      default: SITE.defaultTitle,
      template: SITE.titleTemplate,
    },
    description: SITE.description,
    applicationName: SITE.name,
    openGraph: {
      type: "website",
      siteName: SITE.name,
      title: SITE.defaultTitle,
      description: SITE.description,
    },
  };
}

/**
 * The root layout owns only what EVERY route needs: fonts, global CSS, and the
 * site-level structured data.
 *
 * The marketing header and footer used to live here, which meant the
 * authenticated Workspace and the full-viewport editor inherited a public
 * navbar (with a "Get Started Free" button aimed at signed-out visitors) and a
 * marketing footer below the application. Page chrome is now the responsibility
 * of each route group: `(marketing)` renders the public header/footer, while
 * `/workspaces` and `/editor` render the authenticated app shell instead.
 *
 * The skip link stays here because every route needs one; each layout supplies
 * the matching `#main` landmark.
 */
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [organization, website] = await Promise.all([
    organizationSchema(),
    websiteSchema(),
  ]);
  return (
    <html lang="en" className={inter.variable}>
      <body className="flex min-h-screen flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-skiplink focus:rounded-button focus:bg-white focus:px-3 focus:py-2 focus:text-navy focus:shadow-card"
        >
          Skip to content
        </a>
        <JsonLd data={[organization, website]} />
        {children}
      </body>
    </html>
  );
}
