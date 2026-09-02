import {
  ArrowUpRight,
  Check,
  Clock,
  FileText,
  FolderKanban,
  FolderPlus,
  HardDrive,
  Layers,
  PenLine,
  Search,
  Share2,
  Trash2,
  Upload,
} from "lucide-react";
import { PageContainer } from "@/components/layout/PageContainer";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Reveal } from "@/components/ui/Reveal";
import { floatStyle } from "./floatStyle";
import type { ProductHighlight } from "@/data/productHighlights";

/**
 * The Workspace section — the homepage's answer to "why this and not one of the
 * hundred other PDF tool sites", and the page's flagship product showcase.
 *
 * ## One panel, 38/62
 *
 * The reference puts this whole story inside a single large surface: copy and an
 * illustration on the left, a product preview bleeding off the right edge. That
 * framing is what makes it read as a product rather than another feature row, so
 * the section is one bordered panel on a tinted band, and the dashboard preview
 * is deliberately allowed to overflow its column at `lg` (`-mr-10`, clipped by
 * the panel's `overflow-hidden`) — a preview that ends neatly inside a border
 * reads as a picture of an app, one that runs off the edge reads as the app.
 *
 * The split is the fidelity fix. It was 0.86fr/1fr with four paragraph-length
 * bullets, which made a text column the subject and left the preview as a
 * thumbnail beside it. It is now 0.58fr/1fr at `xl` — the preview is ~18% wider
 * and considerably denser — with the copy cut to a paragraph, four one-line
 * benefits and a single primary action. `data/productHighlights.ts` records why
 * its descriptions shrank; no claim changed.
 *
 * ## Nothing here is the real Workspace
 *
 * `components/workspaces/` is banned from this page by
 * lib/seo/publicBundles.test.ts, and rightly: it is the authenticated
 * application, it is client-side, and it needs a session to render anything.
 * The preview below is inline markup — no imports from the app, no data fetch,
 * no interactive control — and it is `aria-hidden` in full, so it cannot be
 * mistaken for a working dashboard by a screen reader or by a keyboard.
 *
 * It is also not a screenshot. `i/` holds full-frame 1900px screengrabs of the
 * pre-redesign UI, which would ship a stale picture of the very screens this
 * section advertises. A vector mock costs no image bytes and has no layout shift.
 * Capturing real imagery is listed as a remaining limitation in the completion
 * report.
 *
 * ## The CTA says "create", not "go to"
 *
 * The reference's button is "Go to Workspace". `/workspaces` is behind auth, so
 * for the visitor this section is written for that button is a redirect to a
 * login screen. The pair below states the actual next step instead, and the
 * second half of it is a text link rather than a second `lg` button: two of those
 * side by side do not fit a 38% column at 1024 without wrapping.
 */
export function WorkspaceShowcase({ items }: { items: ProductHighlight[] }) {
  return (
    <section
      aria-labelledby="workspace-editor"
      className="section-pad bg-gradient-to-b from-white via-lavender/50 to-white"
    >
      <PageContainer maxWidth="wide">
        <Reveal className="relative overflow-hidden rounded-[28px] border border-softborder bg-white shadow-card">
          {/* Ambient tint. Two sources: one behind the preview column, one under
              the illustration, so both halves of the panel sit on light. */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            <div className="absolute -right-24 -top-28 h-[460px] w-[460px] rounded-full bg-primary/10 blur-[90px]" />
            <div className="absolute -bottom-32 -left-24 h-[380px] w-[380px] rounded-full bg-[#3B82F6]/[0.07] blur-[90px]" />
          </div>

          <div className="relative grid items-center gap-10 p-6 sm:p-8 lg:grid-cols-[minmax(0,0.68fr)_minmax(0,1fr)] lg:gap-10 lg:p-10 xl:grid-cols-[minmax(0,0.58fr)_minmax(0,1fr)] xl:gap-12">
            {/* ── Copy ─────────────────────────────────────────────────── */}
            <div>
              <Badge icon={<FolderKanban size={14} aria-hidden="true" />}>
                Workspace &amp; editor
              </Badge>

              <h2
                id="workspace-editor"
                className="mt-4 text-[clamp(1.7rem,2.9vw,2.5rem)] font-bold leading-[1.08] tracking-tight text-navy"
              >
                Your all-in-one PDF Workspace
              </h2>

              <p className="mt-3.5 max-w-md text-[0.9375rem] leading-relaxed text-navy-soft sm:text-base">
                Most PDF sites hand you a download and forget you existed. Save a
                document to a Workspace instead and it keeps its folder, its
                comments and its version history.
              </p>

              {/* Four one-line benefits. Icon-led rather than tick-led: the tick
                  read as a checklist of promises, the feature's own icon reads as
                  a capability. */}
              <ul className="mt-6 space-y-3">
                {items.map((item) => (
                  <li key={item.id} className="flex items-start gap-3">
                    <span
                      aria-hidden="true"
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary-soft to-lavender text-primary ring-1 ring-primary/10"
                    >
                      <Icon name={item.icon} size={16} strokeWidth={2.1} />
                    </span>
                    <span className="min-w-0 pt-0.5">
                      <span className="block text-sm font-semibold leading-snug text-navy">
                        {item.title}
                      </span>
                      <span className="mt-0.5 block text-[0.8125rem] leading-snug text-navy-soft">
                        {item.description}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>

              <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
                <Button
                  href="/register?returnTo=/workspaces"
                  size="lg"
                  trailingIcon={<ArrowUpRight size={18} aria-hidden="true" />}
                >
                  Create a free Workspace
                </Button>
                <a
                  href="/login"
                  className="rounded text-sm font-semibold text-primary underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                >
                  I already have an account
                </a>
              </div>
              <p className="mt-3.5 text-[0.8125rem] text-navy-soft">
                A Workspace is free. Documents you save there stay until you
                delete or archive them.
              </p>

              {/* The decorative anchor. Hidden below `sm`, where 176px of
                  ornament between the copy and the preview is height a phone
                  cannot spare. */}
              <WorkspaceFolderArt className="mt-8 hidden sm:block" />
            </div>

            {/* ── Product preview ──────────────────────────────────────── */}
            <div className="lg:-mr-10 xl:-mr-14">
              <WorkspaceDashboardMock />
            </div>
          </div>
        </Reveal>
      </PageContainer>
    </section>
  );
}

/**
 * The folder-and-documents illustration.
 *
 * The reference anchors this column with a large 3D folder rendered as raster
 * art. This is the vector equivalent: one inline SVG for the folder (two panels,
 * three gradients, the sheets caught between them) plus two HTML sheet cards
 * drifting above it, each on its own phase via `--float-delay` so they do not
 * rise as one object.
 *
 * `aria-hidden` and wordless — it asserts nothing, which is the requirement for
 * illustration on this page. Motion is the shared `float-drift` keyframes, which
 * are in the single `prefers-reduced-motion` off-switch in globals.css, so this
 * needed no new animation and inherits that guarantee.
 */
function WorkspaceFolderArt({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`relative h-[176px] w-full max-w-[320px] select-none ${className}`}
    >
      {/* Floor glow, so the folder reads as standing on the panel. */}
      <div className="absolute bottom-1 left-4 h-24 w-56 rounded-[50%] bg-primary/25 blur-[42px]" />

      {/* Sheets drifting out of the folder. */}
      <div
        className="animate-float-medium absolute left-[104px] top-0 w-[74px] rounded-lg border border-softborder bg-white p-2 shadow-[0_12px_26px_-10px_rgba(76,29,149,0.4)]"
        style={floatStyle("300ms", "-9deg")}
      >
        <span className="inline-flex h-4 w-4 items-center justify-center rounded bg-red-500 text-white">
          <FileText size={9} strokeWidth={2.8} />
        </span>
        <span className="mt-1.5 block h-1 w-full rounded-full bg-navy/15" />
        <span className="mt-1 block h-1 w-3/4 rounded-full bg-navy/10" />
        <span className="mt-1 block h-1 w-full rounded-full bg-navy/10" />
      </div>
      <div
        className="animate-float-fast absolute left-[196px] top-7 w-[64px] rounded-lg border border-softborder bg-white p-2 shadow-[0_12px_26px_-10px_rgba(76,29,149,0.4)]"
        style={floatStyle("1100ms", "8deg")}
      >
        <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded bg-primary text-white">
          <PenLine size={8} strokeWidth={2.8} />
        </span>
        <span className="mt-1.5 block h-1 w-full rounded-full bg-navy/15" />
        <span className="mt-1 block h-1 w-2/3 rounded-full bg-navy/10" />
      </div>

      {/* The folder itself. */}
      <div
        className="animate-float-slow absolute bottom-0 left-0"
        style={floatStyle("0ms", "0deg")}
      >
        <svg
          viewBox="0 0 260 176"
          className="h-[148px] w-auto drop-shadow-[0_18px_30px_rgba(76,29,149,0.28)]"
          fill="none"
        >
          <defs>
            <linearGradient id="ws-folder-back" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#6D28D9" />
              <stop offset="100%" stopColor="#4C1D95" />
            </linearGradient>
            <linearGradient id="ws-folder-front" x1="0" y1="0" x2="0.4" y2="1">
              <stop offset="0%" stopColor="#A78BFA" />
              <stop offset="45%" stopColor="#7C3AED" />
              <stop offset="100%" stopColor="#4F46E5" />
            </linearGradient>
            <linearGradient id="ws-folder-sheen" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.34" />
              <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Back panel, with the tab. */}
          <path
            d="M26 14h56a12 12 0 0 1 9.8 5.1L101 32h133a16 16 0 0 1 16 16v96a16 16 0 0 1-16 16H26a16 16 0 0 1-16-16V30a16 16 0 0 1 16-16Z"
            fill="url(#ws-folder-back)"
          />

          {/* Sheets caught between the panels. */}
          <g transform="rotate(-6 112 96)">
            <rect x="58" y="46" width="108" height="104" rx="8" fill="#FFFFFF" fillOpacity="0.82" />
          </g>
          <g transform="rotate(5 150 92)">
            <rect x="94" y="38" width="108" height="112" rx="8" fill="#FFFFFF" />
            <rect x="106" y="52" width="26" height="26" rx="6" fill="#EF4444" />
            <rect x="106" y="88" width="82" height="6" rx="3" fill="#1E1B2E" fillOpacity="0.14" />
            <rect x="106" y="102" width="62" height="6" rx="3" fill="#1E1B2E" fillOpacity="0.1" />
            <rect x="106" y="116" width="74" height="6" rx="3" fill="#1E1B2E" fillOpacity="0.1" />
          </g>

          {/* Front panel — wider at the bottom than the top, which is what makes
              it lean toward the viewer instead of reading as a flat rectangle. */}
          <path
            d="M24 68 L236 68 L250 140 Q253 158 235 158 L25 158 Q7 158 10 140 Z"
            fill="url(#ws-folder-front)"
          />
          <path
            d="M24 68 L236 68 L241 94 L19 94 Z"
            fill="url(#ws-folder-sheen)"
          />
          <path
            d="M24 69 H236"
            stroke="#FFFFFF"
            strokeOpacity="0.45"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </svg>
      </div>
    </div>
  );
}

/** Recent-file rows in the preview. Not real documents — see the docblock. */
const RECENT = [
  { name: "Contract_v3.pdf", meta: "Edited 2 minutes ago", pages: "12 pages" },
  { name: "Invoice_2026-08.pdf", meta: "Edited yesterday", pages: "3 pages" },
  { name: "Q3_Report_final.pdf", meta: "3 days ago", pages: "28 pages" },
  { name: "Scan_notes.pdf", meta: "Last week", pages: "6 pages" },
  { name: "Lease_signed.pdf", meta: "Last week", pages: "9 pages" },
];

const SIDEBAR = [
  { label: "All documents", icon: Layers, active: true },
  { label: "Recent", icon: Clock, active: false },
  { label: "Shared", icon: Share2, active: false },
  { label: "Trash", icon: Trash2, active: false },
];

const FOLDERS = [
  { name: "Contracts", count: "12 files", tone: "bg-primary/15 text-primary" },
  { name: "Invoices", count: "8 files", tone: "bg-blue-500/15 text-blue-600" },
  { name: "Scans", count: "5 files", tone: "bg-green-500/15 text-green-600" },
];

/** The quick-action row above the folders. Labels of tools that exist. */
const QUICK_ACTIONS = ["Merge", "Convert", "Compress", "Sign"];

/**
 * A stylised rendering of the Workspace dashboard.
 *
 * `aria-hidden` throughout: it conveys nothing a screen-reader user cannot get
 * from the list beside it, and describing a diagram of a UI is noise. Nothing
 * here is interactive — no buttons, no links, no inputs — so it cannot be
 * mistaken for a working control, and the storage figure is decorative rather
 * than a quota claim.
 *
 * ## Sized to be read
 *
 * Type steps up with the container rather than staying at the 9-10px it was at
 * every width: `[11px]` at phone sizes, `[12px]`/`[13px]` from `sm`. A mock whose
 * labels are illegible is a grey smear where a product should be, which was the
 * single biggest reason this section read as small. What gets dropped on a phone
 * instead is *detail*, not size: the sidebar collapses to an icon rail, the
 * quick-action row and the third folder tile go, and the recent list keeps three
 * rows rather than five.
 */
function WorkspaceDashboardMock() {
  return (
    <div aria-hidden="true" className="relative select-none">
      <div className="overflow-hidden rounded-[22px] border border-softborder bg-white shadow-[0_2px_4px_rgba(30,27,46,0.04),0_28px_70px_-28px_rgba(76,29,149,0.38)]">
        {/* Window chrome */}
        <div className="flex items-center gap-2 border-b border-softborder bg-lavender/60 px-4 py-3">
          <span className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-green-400/70" />
          <span className="ml-2 text-[12px] font-semibold text-navy">
            My Workspace
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-[10px] font-semibold text-navy-soft ring-1 ring-softborder">
            <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
            Autosaved
          </span>
        </div>

        <div className="grid grid-cols-[46px_1fr] sm:grid-cols-[136px_1fr] lg:grid-cols-[150px_1fr]">
          {/* ── Sidebar ─────────────────────────────────────────────── */}
          <div className="flex flex-col gap-1 border-r border-softborder bg-lavender/40 p-2 sm:p-3">
            <span className="mb-1.5 flex items-center justify-center gap-1.5 rounded-lg bg-primary px-2 py-2 text-[11px] font-bold text-white sm:justify-start">
              <FolderPlus size={13} strokeWidth={2.6} />
              <span className="hidden sm:inline">New folder</span>
            </span>

            {SIDEBAR.map((item) => (
              <span
                key={item.label}
                className={`flex items-center justify-center gap-2 truncate rounded-lg px-2 py-1.5 text-[11px] font-medium sm:justify-start sm:text-[12px] ${
                  item.active
                    ? "bg-white text-navy shadow-sm"
                    : "text-navy-soft"
                }`}
              >
                <item.icon size={13} strokeWidth={2.2} className="shrink-0" />
                <span className="hidden truncate sm:inline">{item.label}</span>
              </span>
            ))}

            {/* Folder tree — the thing a converter has no equivalent of. */}
            <span className="mt-3 hidden sm:block">
              <span className="block px-2 text-[9px] font-bold uppercase tracking-wider text-navy-soft/70">
                Folders
              </span>
              <span className="mt-1.5 block space-y-1">
                {FOLDERS.map((folder) => (
                  <span
                    key={folder.name}
                    className="flex items-center gap-2 truncate px-2 py-1 text-[11px] font-medium text-navy-soft"
                  >
                    <FolderKanban size={12} strokeWidth={2.2} className="shrink-0 text-primary/70" />
                    <span className="truncate">{folder.name}</span>
                  </span>
                ))}
              </span>
            </span>

            {/* Storage */}
            <span className="mt-auto block pt-4">
              <span className="flex items-center justify-center gap-1.5 text-[10px] font-semibold text-navy-soft sm:justify-start">
                <HardDrive size={11} strokeWidth={2.4} />
                <span className="hidden sm:inline">Storage</span>
              </span>
              <span className="mt-1.5 block h-1.5 w-full overflow-hidden rounded-full bg-navy/10">
                <span className="block h-full w-[38%] rounded-full bg-primary" />
              </span>
            </span>
          </div>

          {/* ── Main pane ───────────────────────────────────────────── */}
          <div className="min-w-0 p-3 sm:p-4 lg:p-5">
            {/* Search + upload */}
            <div className="flex items-center gap-2">
              <span className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-softborder bg-lavender/40 px-3 py-2">
                <Search size={13} className="shrink-0 text-navy-soft" />
                <span className="truncate text-[11px] text-navy-soft sm:text-[12px]">
                  Search documents
                </span>
              </span>
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-navy px-3 py-2 text-[11px] font-bold text-white sm:text-[12px]">
                <Upload size={13} strokeWidth={2.6} />
                Upload
              </span>
            </div>

            {/* Quick actions */}
            <div className="mt-3 hidden flex-wrap items-center gap-1.5 sm:flex">
              {QUICK_ACTIONS.map((action) => (
                <span
                  key={action}
                  className="rounded-full border border-softborder bg-white px-2.5 py-1 text-[10px] font-semibold text-navy-soft"
                >
                  {action}
                </span>
              ))}
            </div>

            {/* Folder tiles */}
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {FOLDERS.map((folder, i) => (
                <span
                  key={folder.name}
                  className={`rounded-xl border border-softborder bg-white p-2.5 shadow-sm ${
                    i === 2 ? "hidden sm:block" : ""
                  }`}
                >
                  <span
                    className={`inline-flex h-7 w-7 items-center justify-center rounded-lg ${folder.tone}`}
                  >
                    <FolderKanban size={14} strokeWidth={2.3} />
                  </span>
                  <span className="mt-2 block truncate text-[11px] font-semibold text-navy sm:text-[12px]">
                    {folder.name}
                  </span>
                  <span className="block text-[10px] text-navy-soft">
                    {folder.count}
                  </span>
                </span>
              ))}
            </div>

            {/* Recent files */}
            <span className="mt-4 flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-navy-soft">
                Recent
              </span>
              <span className="hidden text-[10px] font-semibold text-primary sm:inline">
                View all
              </span>
            </span>
            <div className="mt-2 divide-y divide-softborder overflow-hidden rounded-xl border border-softborder">
              {RECENT.map((file, i) => (
                <span
                  key={file.name}
                  className={`flex items-center gap-2.5 bg-white px-3 py-2.5 ${
                    i >= 3 ? "hidden sm:flex" : ""
                  }`}
                >
                  <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-red-500 text-white">
                    <FileText size={13} strokeWidth={2.5} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] font-semibold text-navy sm:text-[12px]">
                      {file.name}
                    </span>
                    <span className="block truncate text-[10px] text-navy-soft">
                      {file.meta}
                    </span>
                  </span>
                  <span className="hidden shrink-0 text-[10px] text-navy-soft md:inline">
                    {file.pages}
                  </span>
                  <span className="hidden shrink-0 rounded-full bg-lavender px-2 py-0.5 text-[9px] font-bold text-navy-soft sm:inline">
                    PDF
                  </span>
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* A floating "version history" chip, the one thing a converter cannot do. */}
      <span className="absolute -bottom-4 left-4 hidden items-center gap-2 rounded-xl border border-softborder bg-white px-3.5 py-2.5 text-[11px] font-semibold text-navy shadow-card sm:inline-flex lg:-left-7">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-green-500/15 text-green-600">
          <Check size={13} strokeWidth={3} />
        </span>
        Version 4 saved
      </span>
    </div>
  );
}
