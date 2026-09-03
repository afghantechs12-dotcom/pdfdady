import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { Logo } from "@/components/layout/Logo";

export const metadata = {
  // A plain string, deliberately: the ROOT layout declares an
  // admin-editable `title.template` ("%s — PDFDadi"), so a title that
  // brands itself comes out as "Page not found — PDFDadi — PDFDadi".
  title: "Page not found",
  robots: { index: false, follow: false },
};

/**
 * The 404 for every unknown PUBLIC url.
 *
 * Until this file existed there was no root `not-found.tsx`, so every mistyped
 * marketing url — and every dead inbound link — got Next's framework default
 * page: the words "404 | This page could not be found", no brand, no navigation,
 * and no way back to the product. Because that page ships its own inline
 * `prefers-color-scheme: dark` styles, on a dark-mode machine it rendered as a
 * near-black screen, which is what `docs/evidence/final-prelaunch/visual/`
 * recorded as the reference for surface `18-not-found` before this fix.
 *
 * Chrome is deliberately local rather than the marketing Header/Footer.
 * `app/(marketing)/layout.tsx` owns those, and a root `not-found.tsx` renders
 * OUTSIDE every route group — inside the root layout only. Reaching for the
 * header here would mean duplicating the layout's four admin-runtime awaits and
 * the nav-menu resolution, which is a second copy of layout logic that drifts.
 * A wordmark that links home plus the two destinations that actually help
 * (the home page, and the tool directory) is the whole job.
 *
 * The `id="main"` matters: the root layout renders a skip link pointing at
 * `#main` on every route, and each route group supplies the landmark. Without
 * one here the skip link on this page would target nothing.
 */
export default function NotFound() {
  return (
    <main
      id="main"
      className="flex flex-1 flex-col items-center justify-center bg-lavender px-6 py-16"
    >
      <Logo size="md" className="mb-10" />
      <div className="w-full max-w-md rounded-card border border-softborder bg-white p-8 text-center shadow-card">
        <span
          aria-hidden="true"
          className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-full bg-primary-soft text-primary"
        >
          <FileQuestion size={28} aria-hidden="true" />
        </span>
        <p className="mt-5 text-sm font-semibold uppercase tracking-widest text-primary">
          Error 404
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-navy">
          We couldn&apos;t find that page
        </h1>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-navy-soft">
          The link may be out of date, or the address may have a typo in it.
          Everything else is still where you left it.
        </p>
        <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-button bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Back to home
          </Link>
          <Link
            href="/tools"
            className="inline-flex items-center justify-center rounded-button border border-softborder bg-white px-5 py-2.5 text-sm font-semibold text-navy transition-colors hover:bg-lavender focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Browse all PDF tools
          </Link>
        </div>
      </div>
    </main>
  );
}
