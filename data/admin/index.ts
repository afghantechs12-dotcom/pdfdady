/**
 * Admin store — single JSON file that holds admin-managed content overrides
 * on top of the static defaults in /data/*. The runtime merges these two
 * sources so the public site reads from a single derived, deterministic shape.
 *
 * - Reads happen via `readStore()` (cached per request) in server components
 *   and API routes. Writes happen via `api handlers` only, after auth + zod
 *   validation. The default export for each section is the merged shape used
 *   by existing public callsites.
 */

import { promises as fs } from "fs";
import path from "path";
import { cache } from "react";
import type { Tool, ToolCategory, ToolStatus } from "@/data/tools";
import { tools as defaultToolList, isFunctional as _isFunctional } from "@/data/tools";
import { toolCategories as defaultCategories } from "@/data/toolCategories";
import type {
  BlogPost,
  BlogAuthor,
  ContentBlock,
} from "@/data/blog";
import { blogPosts as defaultBlogPosts, getWordCount as defaultGetWordCount } from "@/data/blog";
import type { FAQItem } from "@/data/faq";
import { faqItems as defaultFaqs } from "@/data/faq";
import type { Feature } from "@/data/features";
import { features as defaultFeatures } from "@/data/features";
import type { PricingPlan } from "@/data/pricing";
import { pricingPlans as defaultPricing } from "@/data/pricing";
import type { UseCase } from "@/data/useCases";
import { useCases as defaultUseCases } from "@/data/useCases";
import type { TrustItem } from "@/data/trust";
import { trustItems as defaultTrust } from "@/data/trust";
import type { AITool } from "@/data/aiTools";
import { aiTools as defaultAiTools } from "@/data/aiTools";
import type { NavLink, FooterColumn } from "@/data/nav";
import { navLinks as defaultNav, footerColumns as defaultFooter } from "@/data/nav";
import type { ServerToolConfig } from "@/data/serverToolConfig";
import { serverToolConfig as defaultServerTools } from "@/data/serverToolConfig";
import { isCanonicalToolSlug } from "@/lib/tools/capability";
import { storeMutex } from "@/lib/server/storeLock";

// Password hashing/verification/first-run detection live in a pure, self-
// contained module (node:crypto only) so they can be unit-tested in isolation
// and reused by the login, password-change, and first-run setup routes without
// pulling in the full data layer. Re-exported here for backward compatibility
// with existing `import { hashPassword, verifyPassword } from "@/data/admin"`.
export { hashPassword, verifyPassword, isAdminPasswordSet } from "@/lib/admin/passwords";

// ---------- File location -----------------------------------------------------

/**
 * Where the admin store lives: the operator-set admin password hash and every
 * CMS edit, in one JSON file (plus its `.bak`).
 *
 * `process.cwd()` is the wrong default in production and cannot be fixed here:
 * `.next/standalone/server.js` chdirs into its own directory before app modules
 * load, so an unconfigured deployment writes the admin password INSIDE THE BUILD
 * OUTPUT — `.next/standalone/data/admin/store.json` — which the next build
 * replaces. Losing the hash is not merely lost content: `isAdminPasswordSet()`
 * goes false and `/admin/setup` re-opens to whoever reaches it first.
 *
 * The shipped image escapes that only because it assembles the standalone output
 * at `/app` and mounts a volume at `/app/data/admin`. Every other supported
 * deployment (`npm run start`, systemd, a PaaS) has to say where the directory
 * is, which is why `productionProblems` refuses a relative one or one inside a
 * `.next` directory instead of leaving the default to be discovered.
 *
 * Read from `process.env` rather than from `getConfig()` because this module is
 * imported by server components on the render path and the config object is not
 * needed for one path; the gate validates the same variable at boot.
 */
export const ADMIN_STORE_DIR =
  process.env.ADMIN_STORE_DIR?.trim() || path.join(process.cwd(), "data", "admin");

export const STORE_PATH = path.join(ADMIN_STORE_DIR, "store.json");

export interface SiteSettings {
  name: string;
  url: string;
  logoUrl: string;
  ogImageUrl: string;
  twitter: string;
  locale: string;
  description: string;
  defaultTitle: string;
  /** Resolved absolute logo URL — built by `getSITE()` for use in JSON-LD. */
  logo?: string;
  /** Resolved absolute OG image URL — built by `getSITE()`. */
  ogImage?: string;
  popularSlugs?: string[]; // optional override for the homepage popular tools grid
  titleTemplate: string;
  social: {
    twitterUrl: string;
    githubUrl: string;
  };
  footerTagline: string;
  footerCardTitle: string;
  footerCardSubtitle: string;
  trustBullets: string[];
}

export interface SeoSettings {
  sitemapExcluded: string[];
  robotsDisallow: string[];
  defaultOgAuthor: string;
  defaultArticleSection: string;
}

export interface AdminBlogAuthor extends BlogAuthor {}

export interface AdminStoreShape {
  site: SiteSettings;
  seo: SeoSettings;
  tools: Record<string, Partial<Tool>>; // by slug
  toolCategories: Record<string, { label?: string; tabLabel?: string }>; // by id
  nav: {
    links?: NavLink[];
    footerColumns?: FooterColumn[];
  };
  faq: Record<string, Partial<FAQItem>>; // by id
  features: Record<string, Partial<Feature>>; // by id
  pricing: Record<string, Partial<PricingPlan>>; // by id
  useCases: Record<string, Partial<UseCase>>; // by id
  trust: Record<string, Partial<TrustItem>>; // by id
  aiTools: Record<string, Partial<AITool>>; // by id
  serverTools: Record<string, Partial<ServerToolConfig>>; // by slug — server tool option/config overrides
  blog: {
    posts: Record<string, Partial<BlogPost>>; // by slug
    author: AdminBlogAuthor;
  };
  pages: {
    about?: Record<string, unknown>;
    contact?: Record<string, unknown>;
    privacy?: Record<string, unknown>;
    terms?: Record<string, unknown>;
    pricing?: Record<string, unknown>;
    serverStatus?: Record<string, unknown>;
  };
  /**
   * Explicit display order for each collection, as an array of ids/slugs.
   * Items missing from the array keep their natural order after the listed
   * ones. Empty/absent → natural order.
   */
  order?: {
    tools?: string[];
    blog?: string[];
    faq?: string[];
    features?: string[];
    pricing?: string[];
    useCases?: string[];
    trust?: string[];
    aiTools?: string[];
  };
  /**
   * Tombstones — ids/slugs of DEFAULT items the admin has removed. Lets the
   * admin hide a built-in item without editing source. Admin-created items are
   * removed by deleting their override entry instead.
   */
  deleted?: {
    tools?: string[];
    blog?: string[];
    faq?: string[];
    features?: string[];
    pricing?: string[];
    useCases?: string[];
    trust?: string[];
    aiTools?: string[];
  };
  settings: {
    adminPasswordHash: string; // "salt:hash" hex
  };
}

export const defaultStore: AdminStoreShape = {
  site: {
    name: "PDFDadi",
    url: "https://pdfdadi.com",
    logoUrl: "/brand-logo",
    ogImageUrl: "/opengraph-image",
    twitter: "@pdfdadi",
    locale: "en_US",
    description:
      "Merge, split, compress, convert and protect PDF files online with fast, secure and simple PDF tools.",
    defaultTitle: "PDFDadi — Free Online PDF Tools",
    titleTemplate: "%s — PDFDadi",
    social: {
      twitterUrl: "https://twitter.com/pdfdadi",
      githubUrl: "https://github.com/pdfdadi",
    },
    footerTagline: "Fast, secure and simple PDF tools for everyday document work.",
    // The card previously read "Made with 💜 for your documents." — decorative,
    // and the one panel in the footer that told the reader nothing. It now
    // restates the product's actual differentiator, which is the same promise
    // the homepage processing-mode section and every tool badge make: you are
    // told where your file is handled before you pick it. Kept to two short
    // lines so the footer does not turn into a second content column.
    // (Launch polish P2-15; the wording matches PROCESSING_MODE_COPY in
    // lib/tools/processingMode.ts, which is the canonical source for the three
    // modes themselves.)
    footerCardTitle: "Processing transparency",
    footerCardSubtitle:
      "Every tool tells you whether your file is handled in your browser, in our secure cloud, or in your Workspace.",
    trustBullets: [
      // Conditional by design. "No sign up required" was true only of the
      // browser tools, not of Workspace; the automatic-deletion bullet was
      // removed because no retention job implements it and Workspace storage
      // is deliberately durable. See docs/launch-feature-evidence.md (C4, C5)
      // and the enforced FORBIDDEN_CLAIMS list.
      "Browser tools need no account",
      "Every tool shows where it runs",
      "Works on any device",
    ],
  },
  seo: {
    sitemapExcluded: [],
    robotsDisallow: [],
    defaultOgAuthor: "PDFDadi Team",
    defaultArticleSection: "Guides",
  },
  tools: {},
  toolCategories: {},
  nav: {},
  faq: {},
  features: {},
  pricing: {},
  useCases: {},
  trust: {},
  aiTools: {},
  serverTools: {},
  blog: {
    posts: {},
    author: {
      name: "PDFDadi Team",
      url: "/about",
      bio: "The PDFDadi Team builds fast, private, browser-based PDF tools. We write practical guides to help you get everyday document work done without installing software or uploading sensitive files.",
    },
  },
  pages: {
    about: {},
    contact: {},
    privacy: {},
    terms: {},
    pricing: {},
    serverStatus: {},
  },
  order: {},
  deleted: {},
  settings: {
    // NO default admin password is shipped. An empty hash means first-run
    // setup has not been completed — login is refused and the operator must
    // set a password via /admin/setup (see lib/admin/passwords.ts
    // isAdminPasswordSet). This closes the "anyone reads the repo, logs in
    // with admin1234" P0 from the audit.
    adminPasswordHash: "",
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (Array.isArray(override)) return override as unknown as T;
  if (!isPlainObject(override)) return base;
  if (!isPlainObject(base)) return override as unknown as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override)) {
    const baseV = (base as Record<string, unknown>)[k];
    out[k] = isPlainObject(v) && isPlainObject(baseV) ? deepMerge(baseV, v) : v;
  }
  return out as T;
}

/**
 * Reorders `items` so that ids present in `order` come first in the given
 * sequence; anything not listed keeps its original relative order after them.
 * Array.sort is stable, so equal-rank items are undisturbed.
 */
function applyOrder<T>(
  items: T[],
  order: string[] | undefined,
  key: (item: T) => string,
): T[] {
  if (!order || order.length === 0) return items;
  const rank = new Map(order.map((id, i) => [id, i] as const));
  const at = (t: T) => (rank.has(key(t)) ? rank.get(key(t))! : Number.MAX_SAFE_INTEGER);
  return [...items].sort((a, b) => at(a) - at(b));
}

/**
 * Merges a default collection with admin overrides. Default items are shallow-
 * merged with their override; brand-new admin-created items (override keys not
 * present in the defaults) are appended as full records; tombstoned default ids
 * are dropped. The result is then reordered by `order`.
 *
 * Full-record overrides for new items are trusted to be complete because the
 * API layer validates the whole shape on write.
 */
function mergeCollection<T extends object>(
  defaults: T[],
  overrides: Record<string, Partial<T>>,
  key: (item: T) => string,
  order: string[] | undefined,
  deleted: string[] | undefined,
): T[] {
  const deletedSet = new Set(deleted ?? []);
  const merged: T[] = [];
  const seen = new Set<string>();
  for (const d of defaults) {
    const id = key(d);
    if (deletedSet.has(id)) continue;
    seen.add(id);
    merged.push({ ...d, ...(overrides[id] ?? {}) } as T);
  }
  for (const [id, ov] of Object.entries(overrides)) {
    if (seen.has(id) || deletedSet.has(id)) continue;
    merged.push({ ...(ov as T) });
  }
  return applyOrder(merged, order, key);
}

const byId = (item: { id: string }) => item.id;


// Cache the IO per server request — admin pages and components re-read a lot.
export const readStore = cache(async (): Promise<AdminStoreShape> => {
  let raw: string;
  try {
    raw = await fs.readFile(STORE_PATH, "utf-8");
  } catch {
    // No store file yet (fresh volume / first run). Try the backup before
    // falling back to the in-code defaults (which have no admin password →
    // first-run setup is triggered).
    try {
      raw = await fs.readFile(`${STORE_PATH}.bak`, "utf-8");
    } catch {
      return defaultStore;
    }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AdminStoreShape>;
    return deepMerge(defaultStore, parsed);
  } catch {
    // Primary file is corrupted (e.g. a write was interrupted before the
    // atomic rename). Try the backup before giving up to the defaults, so a
    // crash never silently resets all admin content.
    try {
      const bakRaw = await fs.readFile(`${STORE_PATH}.bak`, "utf-8");
      const bakParsed = JSON.parse(bakRaw) as Partial<AdminStoreShape>;
      return deepMerge(defaultStore, bakParsed);
    } catch {
      return defaultStore;
    }
  }
});

export async function writeStore(next: AdminStoreShape): Promise<void> {
  const dir = path.dirname(STORE_PATH);
  await fs.mkdir(dir, { recursive: true });
  // Atomic write: serialize to a temp file in the same directory, back up the
  // previous good file, then rename over the target. `fs.rename` is atomic on
  // the same filesystem, so a crash at any point leaves either the previous
  // file or the new file intact — never a truncated half-write.
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf-8");
  try {
    await fs.copyFile(STORE_PATH, `${STORE_PATH}.bak`);
  } catch {
    // No previous file yet (first ever write) — nothing to back up.
  }
  await fs.rename(tmp, STORE_PATH);
  // Public pages are statically rendered; without this, admin edits would
  // never surface until the next build. Called from route handlers only
  // (all writeStore callers are admin API routes), where revalidatePath is
  // legal. Import lazily so merely reading the store never pulls it in.
  try {
    const { revalidatePath } = await import("next/cache");
    revalidatePath("/", "layout");
  } catch {
    // Outside a request scope (e.g. scripts/tests) revalidation is a no-op.
  }
}

export async function updateStore(
  mutator: (s: AdminStoreShape) => void | Promise<void>,
): Promise<AdminStoreShape> {
  // Serialize the read-modify-write so concurrent admin mutations can't
  // interleave and silently clobber each other (last-write-wins). The mutex is
  // in-process; cross-instance coordination is Milestone 2 (Postgres).
  return storeMutex.run(async () => {
    const current = await readStore();
    const draft = JSON.parse(JSON.stringify(current)) as AdminStoreShape;
    await mutator(draft);
    await writeStore(draft);
    return draft;
  });
}

/** Collections that support reordering + tombstone deletes via the store. */
export type OrderableCollection =
  | "tools"
  | "blog"
  | "faq"
  | "features"
  | "pricing"
  | "useCases"
  | "trust"
  | "aiTools";

/** Persists an explicit display order for a collection. */
export async function setOrder(
  collection: OrderableCollection,
  order: string[],
): Promise<void> {
  await updateStore((s) => {
    s.order = { ...(s.order ?? {}), [collection]: order };
  });
}

/**
 * Removes an item from a collection. If the id is a built-in default it is
 * tombstoned so it disappears from the public site; any override + order entry
 * for it is also cleared. Admin-created items are removed outright.
 */
export async function removeCollectionItem(
  collection: OrderableCollection,
  id: string,
): Promise<void> {
  await updateStore((s) => {
    // Drop any override.
    if (collection === "blog") {
      delete s.blog.posts[id];
    } else {
      const map = s[collection] as Record<string, unknown>;
      delete map[id];
    }
    // Tombstone if it's a known default so it stops rendering.
    if (isDefaultId(collection, id)) {
      s.deleted = s.deleted ?? {};
      const list = s.deleted[collection] ?? [];
      if (!list.includes(id)) s.deleted[collection] = [...list, id];
    }
    // Clean the order entry.
    if (s.order?.[collection]) {
      s.order[collection] = s.order[collection]!.filter((x) => x !== id);
    }
  });
}

function isDefaultId(collection: OrderableCollection, id: string): boolean {
  switch (collection) {
    case "tools":
      return defaultToolList.some((t) => t.slug === id);
    case "blog":
      return defaultBlogPosts.some((p) => p.slug === id);
    case "faq":
      return defaultFaqs.some((f) => f.id === id);
    case "features":
      return defaultFeatures.some((f) => f.id === id);
    case "pricing":
      return defaultPricing.some((p) => p.id === id);
    case "useCases":
      return defaultUseCases.some((u) => u.id === id);
    case "trust":
      return defaultTrust.some((t) => t.id === id);
    case "aiTools":
      return defaultAiTools.some((t) => t.id === id);
  }
}

// ---------- Derived, merge-shaped public outputs ------------------------------

export async function getSite(): Promise<SiteSettings> {
  const s = await readStore();
  return s.site;
}

export async function getSeo(): Promise<SeoSettings> {
  const s = await readStore();
  return s.seo;
}

/**
 * The public tool inventory: the canonical registry, with editorial overrides.
 *
 * NOT `registry UNION store`. It was, and that union was the last place a CMS
 * edit could move a public capability claim. An override key with no registry row
 * became a whole new tool — listed in the catalog, counted in "32 tools ready",
 * pushed into the sitemap when its own `status` said `functional-server` — while
 * `capabilityForSlug` returned null for it, so `/tools/<slug>` 404d and
 * `assertRemoteJobTool` refused the job. The tool could not fake success, but the
 * numbers on the homepage were editable content, and a card PDFDadi rendered
 * itself led to a 404. `isCanonicalToolSlug` is now the gate on both sides: the
 * admin write boundary refuses the identity, and this merge ignores any that is
 * already stored (see `getOrphanToolRecords`).
 *
 * Code-owned, never taken from the store: `slug`, `href` and `status`. `href`
 * matters as much as `status` — it used to be built from `o.slug ?? slug`, so an
 * override carrying a different `slug` field pointed a live catalog card at a
 * route that does not exist. Everything else (name, description, icon, tone,
 * category presentation, accepted types, planned reason) is editorial and still
 * overrides, which is what makes the CMS worth having.
 *
 * `deleted.tools` tombstones are ignored for the same reason. No route creates
 * one — `removeCollectionItem` is wired for faq/features/blog/pricing/useCases/
 * trust/aiTools only, and the tools UI's delete button clears the override — so
 * one can only arrive by hand-editing the store, and its effect would be to drop
 * a working tool out of the catalog and the sitemap while its route, its job
 * submission and its capability row all still work. Taking a tool offline is a
 * code change, in both directions.
 */
export async function getTools(): Promise<Tool[]> {
  const s = await readStore();
  // Apply category overrides first so tool overrides see updated category metadata.
  const catMerges: Array<{ id: string; label?: string; tabLabel?: string }> =
    defaultCategories.map((c) => ({ id: c.id, ...s.toolCategories[c.id] }));

  const merged: Tool[] = defaultToolList.map((base) => {
    const o = s.tools[base.slug] ?? {};
    const catId = (o.category ?? base.category) as ToolCategory;
    const catOverride = catMerges.find((c) => c.id === catId);
    return {
      ...base,
      ...o,
      slug: base.slug,
      href: base.href,
      status: base.status,
      category: catId,
      categoryLabel: catOverride?.label,
    } as Tool & { categoryLabel?: string };
  });
  return applyOrder(merged, s.order?.tools, (t) => t.slug);
}

/** A stored tool override whose slug the code does not implement. */
export interface OrphanToolRecord {
  slug: string;
  /** Whatever name the record carries, for an operator deciding whether to keep it. */
  name?: string;
  /** The status the record claims. Advisory only — nothing derives from it. */
  status?: ToolStatus;
}

/**
 * Stored tool records that are not canonical tools.
 *
 * Kept readable rather than deleted on sight: this store is a mounted volume, and
 * a record an operator authored is theirs to review. They reach no public surface
 * (`getTools` above ignores them) and the admin tools page lists them as
 * unsupported, with the existing DELETE route to remove one.
 */
export async function getOrphanToolRecords(): Promise<OrphanToolRecord[]> {
  const s = await readStore();
  return Object.entries(s.tools)
    .filter(([slug]) => !isCanonicalToolSlug(slug))
    .map(([slug, o]) => ({ slug, name: o.name, status: o.status }));
}

/** Admin-editable content page keys (About / Contact / legal / intros). */
export type PageKey =
  | "about"
  | "contact"
  | "privacy"
  | "terms"
  | "pricing"
  | "serverStatus";

export interface PageContent {
  title: string;
  description?: string;
  blocks: ContentBlock[];
}

/**
 * Returns admin-authored content for a page, or null if the admin has not set
 * any (so the public page keeps its built-in static design). "Set" means a
 * non-empty title or at least one content block.
 */
export async function getPageContent(key: PageKey): Promise<PageContent | null> {
  const s = await readStore();
  const raw = s.pages?.[key] as Partial<PageContent> | undefined;
  if (!raw) return null;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const blocks = Array.isArray(raw.blocks) ? (raw.blocks as ContentBlock[]) : [];
  if (!title && blocks.length === 0) return null;
  return {
    title,
    description: typeof raw.description === "string" ? raw.description : undefined,
    blocks,
  };
}

export async function getPopularToolsSlugs(): Promise<string[]> {
  const s = await readStore();
  const override = s.site?.popularSlugs;
  if (Array.isArray(override) && override.length > 0) return override;
  // Ten, so the homepage panel fills two even rows of five. An admin override
  // of any length still wins; this is only the fallback.
  return [
    "merge-pdf",
    "split-pdf",
    "compress-pdf",
    "pdf-to-word",
    "jpg-to-pdf",
    "edit-pdf",
    "protect-pdf",
    "ocr-pdf",
    "pdf-to-jpg",
    "rotate-pdf",
  ];
}

export async function getToolCategories() {
  const s = await readStore();
  return defaultCategories.map((c) => ({
    id: c.id,
    label: s.toolCategories[c.id]?.label ?? c.label,
    tabLabel: s.toolCategories[c.id]?.tabLabel ?? c.tabLabel,
  }));
}

export async function getFaqs(): Promise<FAQItem[]> {
  const s = await readStore();
  return mergeCollection(defaultFaqs, s.faq, byId, s.order?.faq, s.deleted?.faq);
}

export async function getFeatures(): Promise<Feature[]> {
  const s = await readStore();
  return mergeCollection(
    defaultFeatures,
    s.features,
    byId,
    s.order?.features,
    s.deleted?.features,
  );
}

export async function getPricingPlans(): Promise<PricingPlan[]> {
  const s = await readStore();
  return mergeCollection(
    defaultPricing,
    s.pricing,
    byId,
    s.order?.pricing,
    s.deleted?.pricing,
  );
}

export async function getUseCases(): Promise<UseCase[]> {
  const s = await readStore();
  return mergeCollection(
    defaultUseCases,
    s.useCases,
    byId,
    s.order?.useCases,
    s.deleted?.useCases,
  );
}

export async function getTrust(): Promise<TrustItem[]> {
  const s = await readStore();
  return mergeCollection(defaultTrust, s.trust, byId, s.order?.trust, s.deleted?.trust);
}

export async function getAiTools(): Promise<AITool[]> {
  const s = await readStore();
  return mergeCollection(
    defaultAiTools,
    s.aiTools,
    byId,
    s.order?.aiTools,
    s.deleted?.aiTools,
  );
}

/**
 * Merged server-tool configs (limits, labels, upload copy, option fields).
 * Admin overrides are deep-merged onto the code defaults so partial edits are
 * safe. Only slugs that exist in code defaults are exposed — server processing
 * requires a matching processor in lib/server/toolProcessing.ts, so admins can
 * tune existing tools but not invent server tools that have no handler.
 */
export async function getServerTools(): Promise<Record<string, ServerToolConfig>> {
  const s = await readStore();
  const out: Record<string, ServerToolConfig> = {};
  for (const [slug, base] of Object.entries(defaultServerTools)) {
    const ov = s.serverTools?.[slug];
    out[slug] = ov ? (deepMerge(base, ov) as ServerToolConfig) : base;
  }
  return out;
}

export async function getServerToolConfigMerged(
  slug: string,
): Promise<ServerToolConfig | undefined> {
  const all = await getServerTools();
  return all[slug];
}


export async function getNavLinks(): Promise<NavLink[]> {
  const s = await readStore();
  const override = s.nav.links ?? defaultNav;
  return override;
}

export async function getFooterColumns(): Promise<FooterColumn[]> {
  const s = await readStore();
  const override = s.nav.footerColumns ?? defaultFooter;
  return override;
}

export async function getBlogAuthor(): Promise<BlogAuthor> {
  const s = await readStore();
  return { ...s.blog.author };
}

export async function getBlogPosts(): Promise<BlogPost[]> {
  const s = await readStore();
  const overrides = s.blog.posts;
  const deletedSet = new Set(s.deleted?.blog ?? []);
  const seen = new Set<string>();
  const out: BlogPost[] = [];

  for (const base of defaultBlogPosts) {
    if (deletedSet.has(base.slug)) continue;
    seen.add(base.slug);
    out.push(mergePost(base, overrides[base.slug] ?? {}));
  }
  // Brand-new admin-authored posts (no matching default) — the API validates
  // the full post shape on create, so the override is a complete record.
  for (const [slug, ov] of Object.entries(overrides)) {
    if (seen.has(slug) || deletedSet.has(slug)) continue;
    out.push(ov as BlogPost);
  }
  return applyOrder(out, s.order?.blog, (p) => p.slug);
}

function mergePost(base: BlogPost, override: Partial<BlogPost>): BlogPost {
  return {
    ...base,
    ...override,
    author: { ...base.author, ...(override.author ?? {}) },
    tags: override.tags ?? base.tags,
    howTo: override.howTo
      ? { ...(base.howTo ?? { name: "", description: "", steps: [] }), ...override.howTo }
      : base.howTo,
    faq: override.faq ?? base.faq,
    relatedSlugs: override.relatedSlugs ?? base.relatedSlugs,
  };
}

export function mergedGetWordCount(post: BlogPost): number {
  return defaultGetWordCount(post);
}

// ---------- Auth helpers ------------------------------------------------------
// Password hashing/verification/first-run detection now live in
// lib/admin/passwords.ts (pure node:crypto, unit-tested). They are re-exported
// from the top of this file so existing `from "@/data/admin"` imports keep
// working.
