import Link from "next/link";
import {
  getAiComingSoonCount,
  getAvailableToolCount,
  getPlannedToolCount,
} from "@/lib/tools/capability";
import {
  Wrench,
  BookOpen,
  HelpCircle,
  DollarSign,
  Sparkles,
  Settings,
  Search,
  FileSearch,
} from "lucide-react";
import { SectionHeader } from "@/components/admin/Section";
import { Card } from "@/components/admin/Card";
import {
  getBlogPosts,
  getFaqs,
  getPricingPlans,
  getTools,
  getUseCases,
  getFeatures,
  getTrust,
  readStore,
} from "@/data/admin";

export const metadata = { title: "Dashboard — PDFDadi Admin" };

export default async function AdminDashboardPage() {
  const [tools, posts, faqs, pricing, useCases, features, trust, store] =
    await Promise.all([
      getTools(),
      getBlogPosts(),
      getFaqs(),
      getPricingPlans(),
      getUseCases(),
      getFeatures(),
      getTrust(),
      readStore(),
    ]);

  // Counted through the shared capability selectors, so the admin dashboard and
  // every public surface answer "how many tools are live" the same way.
  const functional = getAvailableToolCount(tools);
  const planned = getPlannedToolCount(tools);
  const ai = getAiComingSoonCount(tools);

  const stats = [
    { label: "Total tools", value: tools.length, icon: Wrench, tone: "purple" },
    { label: "Live now", value: functional, icon: Wrench, tone: "green" },
    { label: "Planned", value: planned, icon: Wrench, tone: "orange" },
    { label: "AI coming", value: ai, icon: Sparkles, tone: "pink" },
    { label: "Blog posts", value: posts.length, icon: BookOpen, tone: "purple" },
    { label: "FAQ items", value: faqs.length, icon: HelpCircle, tone: "blue" },
    {
      label: "Pricing plans",
      value: pricing.length,
      icon: DollarSign,
      tone: "green",
    },
  ];

  const quickLinks: Array<{ href: string; label: string; icon: React.ComponentType<{ size?: number }>; description: string }> = [
    {
      href: "/admin/site",
      label: "Site settings",
      icon: Settings,
      description: "Brand name, domain, OG defaults, footer copy.",
    },
    {
      href: "/admin/seo",
      label: "SEO & sitemap",
      icon: Search,
      description: "Default authors, sitemap exclusions, robots disallow rules.",
    },
    {
      href: "/admin/nav",
      label: "Navigation & footer",
      icon: FileSearch,
      description: "Header links and footer columns shown on every page.",
    },
    {
      href: "/admin/tools",
      label: "Tools manager",
      icon: Wrench,
      description: "Add, edit, reorder and feature tools across categories.",
    },
    {
      href: "/admin/blog",
      label: "Blog posts",
      icon: BookOpen,
      description: "Write, edit and reorder SEO articles.",
    },
    {
      href: "/admin/pages",
      label: "Pages",
      icon: FileSearch,
      description: "About, Contact, Privacy Policy, Terms and more.",
    },
  ];

  return (
    <>
      <SectionHeader
        eyebrow="Overview"
        title="Admin dashboard"
        description="Manage every piece of content that appears on PDFDadi — tools, blog, SEO, copy and pages. Changes save instantly to the live site."
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <div
              key={s.label}
              className="rounded-card border border-softborder bg-white p-4 shadow-card"
            >
              <span
                className={
                  "inline-flex h-9 w-9 items-center justify-center rounded-xl " +
                  toneClass(s.tone)
                }
              >
                <Icon size={16} />
              </span>
              <p className="mt-3 text-2xl font-bold text-navy">{s.value}</p>
              <p className="text-xs text-navy-soft">{s.label}</p>
            </div>
          );
        })}
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card
            title="Quick actions"
            description="Jump straight into the most-edited sections."
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {quickLinks.map((q) => {
                const Icon = q.icon;
                return (
                  <Link
                    key={q.href}
                    href={q.href}
                    className="flex items-start gap-3 rounded-2xl border border-softborder bg-white p-4 transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-card"
                  >
                    <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-primary-soft text-primary">
                      <Icon size={16} />
                    </span>
                    <div>
                      <p className="text-sm font-bold text-navy">{q.label}</p>
                      <p className="mt-0.5 text-xs text-navy-soft">
                        {q.description}
                      </p>
                    </div>
                  </Link>
                );
              })}
            </div>
          </Card>
        </div>

        <Card title="Site health" description="Top-level signals.">
          <ul className="space-y-3 text-sm">
            <li className="flex items-center justify-between">
              <span className="text-navy-soft">Site name</span>
              <span className="font-semibold text-navy">{store.site.name}</span>
            </li>
            <li className="flex items-center justify-between">
              <span className="text-navy-soft">Domain</span>
              <span className="truncate font-mono text-xs text-navy">
                {store.site.url}
              </span>
            </li>
            <li className="flex items-center justify-between">
              <span className="text-navy-soft">Status</span>
              <span className="font-semibold text-green-700">All good</span>
            </li>
            <li className="flex items-center justify-between">
              <span className="text-navy-soft">Use cases</span>
              <span className="font-semibold text-navy">{useCases.length}</span>
            </li>
            <li className="flex items-center justify-between">
              <span className="text-navy-soft">Features</span>
              <span className="font-semibold text-navy">{features.length}</span>
            </li>
            <li className="flex items-center justify-between">
              <span className="text-navy-soft">Trust items</span>
              <span className="font-semibold text-navy">{trust.length}</span>
            </li>
          </ul>
          <Link
            href="/admin/site"
            className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:text-primary-hover"
          >
            Open site settings →
          </Link>
        </Card>
      </div>
    </>
  );
}

function toneClass(tone: string) {
  switch (tone) {
    case "green":
      return "bg-green-50 text-green-600";
    case "blue":
      return "bg-blue-50 text-blue-600";
    case "orange":
      return "bg-orange-50 text-orange-600";
    case "pink":
      return "bg-pink-50 text-pink-600";
    default:
      return "bg-purple-50 text-purple-600";
  }
}
