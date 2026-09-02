import { Header } from "@/components/layout/Header";
import { getAvailableToolCount } from "@/lib/tools/capability";
import { Footer } from "@/components/layout/Footer";
import { resolveNavToolMenus } from "@/components/layout/headerLogic";
import { getSITE } from "@/lib/seo/metadata";
import { getNav, getFooter, getToolsList } from "@/lib/seo/adminRuntime";
import { navToolMenus } from "@/data/nav";


/**
 * Layout for the PUBLIC marketing site: the home page, tool pages, blog,
 * pricing, and the legal pages.
 *
 * This is where the public header and footer live. They are deliberately not in
 * the root layout: the authenticated Workspace and the editor are applications,
 * not pages on a marketing site, and rendering a "Get Started Free" call to
 * action above a signed-in user's documents is both wrong and confusing.
 *
 * Nav and footer content stay admin-editable through the same runtime helpers
 * the root layout used before, so the marketing chrome is unchanged.
 *
 * The header's dropdown menus are resolved HERE, on the server, and passed down
 * as plain `{slug, name, href}` objects. Resolving them inside the header —
 * which is a client component — would pull the entire 45-entry tool catalog
 * into every public page's client bundle, the regression
 * lib/seo/publicBundles.test.ts exists to catch.
 */
export default async function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [SITE, nav, footer, tools] = await Promise.all([
    getSITE(),
    getNav(),
    getFooter(),
    getToolsList(),
  ]);

  const toolMenus = resolveNavToolMenus(navToolMenus, tools);
  // Counted from the merged registry rather than written into the label, so the
  // "View all N tools" link cannot drift from what is actually available.
  const availableCount = getAvailableToolCount(tools);

  return (
    <>
      <Header
        navLinks={nav}
        toolMenus={toolMenus}
        availableCount={availableCount}
      />
      <main id="main" className="flex-1">
        {children}
      </main>
      <Footer
        columns={footer}
        tagline={SITE.footerTagline}
        cardTitle={SITE.footerCardTitle}
        cardSubtitle={SITE.footerCardSubtitle}
        socials={{ twitter: SITE.social.twitterUrl, github: SITE.social.githubUrl }}
      />
    </>
  );
}
