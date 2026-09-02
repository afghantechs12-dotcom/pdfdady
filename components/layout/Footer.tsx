import Link from "next/link";
import { Twitter, Github, Linkedin } from "lucide-react";
import { Logo } from "./Logo";
import { PageContainer } from "./PageContainer";
import type { FooterColumn } from "@/data/nav";

/**
 * The site footer.
 *
 * ## The column count is data-driven
 *
 * `footerColumns` currently has six entries and is admin-mergeable, so the grid
 * must not hard-code a track per column. An earlier version declared five tracks
 * (`[1.4fr_1fr_1fr_1fr_1.2fr]`) while rendering brand + six columns + a card —
 * eight items into five tracks, which wrapped into a ragged second row at
 * desktop widths. The links now sit in their own auto-flow grid so adding or
 * removing a column reflows instead of breaking the layout.
 *
 * ## There is no newsletter box
 *
 * The reference design puts a subscribe field here. There is no mailing list, no
 * endpoint to post to, no storage for an address and no consent copy — a field
 * that swallowed an email and did nothing would be the plainest kind of fake
 * functionality. The slot instead carries the site's existing footer card, which
 * says something true. For the same reason there is no language picker (no i18n
 * exists to switch) and no social link beyond the two accounts `data/nav.ts`
 * actually records.
 *
 * ## Polish notes
 *
 * The column headings use the same eyebrow idiom as the rest of the page
 * (11px/bold/`0.14em`) instead of a footer-only variant. Each link is an
 * `inline-block` with its own vertical padding, so the hit area is ~28px tall
 * rather than the 18px a bare inline 13px link gives you, and the rows separate
 * visually without the group growing much. The bottom bar is left-aligned when
 * stacked, matching everything above it, and only becomes a justified row once
 * there is width for two ends.
 */
export function Footer({
  columns,
  tagline,
  cardTitle,
  cardSubtitle,
  socials,
}: {
  columns: FooterColumn[];
  tagline: string;
  cardTitle: string;
  cardSubtitle: string;
  socials: { twitter: string; github: string };
}) {
  const year = new Date().getFullYear();
  const iconByProvider: Record<string, typeof Twitter> = {
    twitter: Twitter,
    github: Github,
    linkedin: Linkedin,
  };
  const labelByProvider: Record<string, string> = {
    twitter: "Twitter",
    github: "GitHub",
    linkedin: "LinkedIn",
  };
  const socialIcons = [
    { provider: "twitter", url: socials.twitter },
    { provider: "github", url: socials.github },
  ];

  return (
    <footer className="border-t border-softborder bg-lavender/60">
      <PageContainer className="py-10 lg:py-12">
        <div className="grid gap-9 lg:grid-cols-[minmax(0,1fr)_minmax(0,2.8fr)] lg:gap-12">
          {/* ── Brand ──────────────────────────────────────────────────────── */}
          <div className="max-w-xs">
            <Logo />
            <p className="mt-3.5 text-sm leading-relaxed text-navy-soft">
              {tagline}
            </p>

            <div className="mt-4 flex items-center gap-2.5">
              {socialIcons.map(({ provider, url }) => {
                const Icon = iconByProvider[provider] ?? Twitter;
                return (
                  <a
                    key={provider}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={labelByProvider[provider] ?? provider}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white text-navy-soft shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:hover:translate-y-0"
                  >
                    <Icon size={16} aria-hidden="true" />
                  </a>
                );
              })}
            </div>

            <div className="mt-5 rounded-panel bg-white p-4 shadow-card">
              <p className="text-sm font-semibold text-navy">{cardTitle}</p>
              <p className="mt-1 text-xs leading-relaxed text-navy-soft">
                {cardSubtitle}
              </p>
            </div>
          </div>

          {/* ── Link columns ───────────────────────────────────────────────── */}
          {/* 2 → 3 → 6 tracks. Six columns only from `xl`, where each track is
              ~130px and the longest label ("Add Watermark") still fits on one
              line; below that they wrap into rows rather than squeeze. */}
          <nav
            aria-label="Footer"
            className="grid grid-cols-2 gap-x-6 gap-y-7 sm:grid-cols-3 xl:grid-cols-6"
          >
            {columns.map((col) => (
              <div key={col.title}>
                <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-navy">
                  {col.title}
                </h3>
                <ul className="mt-2.5 space-y-1">
                  {col.links.map((link) => (
                    <li key={link.href}>
                      <Link
                        href={link.href}
                        className="inline-block rounded-button py-1 text-[0.8125rem] text-navy-soft transition-colors hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        <div className="mt-9 flex flex-col items-start justify-between gap-2 border-t border-softborder pt-5 sm:flex-row sm:items-center sm:gap-3">
          <p className="text-[0.8125rem] text-navy-soft">
            © {year} PDFDadi. All rights reserved.
          </p>
          <p className="text-[0.8125rem] text-navy-soft">
            Built for people who work with documents every day.
          </p>
        </div>
      </PageContainer>
    </footer>
  );
}
