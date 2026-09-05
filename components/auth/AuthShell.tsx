import Link from "next/link";
import { FileText, FolderKanban, ShieldCheck, History } from "lucide-react";
import { LogoMark } from "@/components/layout/Logo";

/**
 * Premium split layout shared by /login and /signup.
 *
 * Desktop shows a deep-navy branding panel beside the form card; below `lg` the
 * panel collapses to a compact header so the form owns the viewport and the
 * on-screen keyboard never hides the submit button. The illustration is built
 * from CSS/SVG shapes rather than an image so there is no extra request and no
 * layout shift.
 */

/**
 * The four claims on the branding panel.
 *
 * Trimmed at launch review. "Projects, folders, and tags that scale with your
 * team" implied team management that does not exist; "nothing is ever lost" is
 * an absolute guarantee of the same species as the unqualified security claim
 * the evidence matrix removed (C1) — version history is real and good, but it
 * does not make data loss impossible. Each line now states a capability that
 * docs/launch-feature-evidence.md §2 backs.
 */
const FEATURES = [
  {
    icon: FileText,
    title: "Edit PDFs properly",
    body: "Text, pages, shapes and annotations in a real editor.",
  },
  {
    icon: FolderKanban,
    title: "Organize in a Workspace",
    body: "Folders, tags, projects and full-text search.",
  },
  {
    icon: History,
    title: "Version history",
    body: "Every save keeps the one before it, and you can restore it.",
  },
  {
    icon: ShieldCheck,
    title: "Access is checked per request",
    body: "Documents belong to your workspace and are authorized on every call.",
  },
];

/** Abstract document preview: a page with text lines and a highlighted block. */
function DocumentIllustration() {
  return (
    <div aria-hidden="true" className="relative mx-auto mt-10 hidden w-full max-w-sm lg:block">
      <div className="absolute -left-6 top-6 h-full w-full rotate-[-6deg] rounded-2xl border border-white/10 bg-white/5" />
      <div className="absolute -right-4 top-3 h-full w-full rotate-[4deg] rounded-2xl border border-white/10 bg-white/[0.07]" />
      <div className="relative rounded-2xl border border-white/15 bg-white/10 p-5 backdrop-blur-sm">
        {/*
          The macOS window traffic lights, quoting another product's chrome to
          say "a document in an app". Deliberately NOT tokenised: they are not
          PDFDadi's palette, and naming them as brand colours would invite a
          later pass to "align" them and lose the reference.
        */}
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-[#FF5F57]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#FEBC2E]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28C840]" />
        </div>
        <div className="mt-5 space-y-2.5">
          <div className="h-2.5 w-3/4 rounded-full bg-white/70" />
          <div className="h-2 w-full rounded-full bg-white/25" />
          <div className="h-2 w-11/12 rounded-full bg-white/25" />
          <div className="h-2 w-4/5 rounded-full bg-white/25" />
          <div className="my-4 rounded-lg border border-primary/40 bg-primary/25 px-3 py-2">
            <div className="h-2 w-2/3 rounded-full bg-white/80" />
          </div>
          <div className="h-2 w-full rounded-full bg-white/20" />
          <div className="h-2 w-3/5 rounded-full bg-white/20" />
        </div>
      </div>
    </div>
  );
}

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-app-bg lg:grid lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
      {/* Branding panel — full column on desktop, compact header on mobile. */}
      <aside className="relative overflow-hidden bg-navy px-6 py-8 text-white sm:px-10 lg:flex lg:flex-col lg:justify-center lg:px-14 lg:py-16">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-primary/30 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-32 -left-20 h-80 w-80 rounded-full bg-aipink/20 blur-3xl"
        />

        <div className="relative">
          <Link
            href="/"
            aria-label="PDFDadi home"
            className="inline-flex items-center gap-2.5 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <LogoMark size={36} />
            <span className="text-xl font-bold tracking-tight text-white">
              PDF
              <span className="bg-gradient-to-r from-violet-300 to-aura-pinksoft bg-clip-text text-transparent">
                Dadi
              </span>
            </span>
          </Link>

          <p className="mt-6 max-w-md text-lg font-semibold leading-snug text-white sm:text-2xl lg:mt-10 lg:text-3xl">
            The professional workspace for every PDF you work on.
          </p>
          <p className="mt-3 hidden max-w-md text-sm leading-relaxed text-white/70 sm:block">
            Edit, organize and collaborate on documents in one secure place —
            without the desktop software.
          </p>

          <ul className="mt-8 hidden max-w-md space-y-4 lg:block">
            {FEATURES.map(({ icon: Icon, title: featureTitle, body }) => (
              <li key={featureTitle} className="flex gap-3.5">
                <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/15">
                  <Icon size={17} className="text-violet-300" aria-hidden="true" />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-white">{featureTitle}</span>
                  <span className="mt-0.5 block text-sm leading-relaxed text-white/60">{body}</span>
                </span>
              </li>
            ))}
          </ul>

          <DocumentIllustration />

          <p className="mt-10 hidden items-center gap-2 text-xs text-white/55 lg:flex">
            <ShieldCheck size={14} aria-hidden="true" />
            Documents are encrypted in transit and access is checked on every request.
          </p>
        </div>
      </aside>

      {/* Form panel */}
      <main id="main" className="flex items-center justify-center px-4 py-10 sm:px-8 sm:py-14">
        <div className="w-full max-w-lg">
          <div className="rounded-[18px] border border-softborder bg-white p-6 shadow-card sm:p-8">
            <h1 className="text-2xl font-bold tracking-tight text-navy sm:text-[1.75rem]">{title}</h1>
            <p className="mt-2 text-sm leading-relaxed text-navy-soft">{subtitle}</p>
            {children}
          </div>
          <div className="mt-6 text-center text-sm text-navy-soft">{footer}</div>
        </div>
      </main>
    </div>
  );
}
