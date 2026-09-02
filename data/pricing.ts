export interface PricingPlan {
  id: string;
  name: string;
  price: string;
  period?: string;
  description: string;
  features: string[];
  cta: string;
  href: string;
  available: boolean;
  highlighted?: boolean;
}

/**
 * The plans shown on /pricing and in the homepage preview.
 *
 * This is the single pricing source — the admin store merges overrides on top
 * of it and both surfaces read the merged result, so there is no second
 * configuration to keep in sync.
 *
 * Two entries were removed at launch review:
 *
 *  - **Premium AI** advertised Chat with PDF, Summarize and Translate as a
 *    purchasable tier. None of it is built (M8 has not started), and its CTA
 *    linked to `/` — a dead end that looked like a checkout (C12).
 *  - The free plan's "No sign up required" bullet was true of the browser
 *    tools only, not of the Workspace the same plan grants.
 *
 * What remains is honest about the state of billing. There is no annual discount,
 * so no toggle and no "save 20%" badge. Whether Pro can be *bought* is not a
 * fact this file can state: it depends on whether the deployment has Stripe
 * configured, which is resolved per request by `/api/billing/summary` and
 * rendered by `ProConfigured` / `ProPriceLabel` / `ProUpgradeAction`. The strings
 * below are the approved fallback for a deployment that cannot take money, which
 * is why `price` reads "Not yet available" and `cta` points at contact rather
 * than at a disabled "Subscribe" button.
 *
 * Business is different, and deliberately so: it is non-purchasable by domain law
 * (`BillingPriceMap` has no `business` slot — see src/domain/billing/subscription.ts),
 * not by configuration, so it gets no live control at all and its copy is
 * unconditional.
 *
 * The free plan reads "$0 today", not "$0 forever": whether the free tier stays
 * free after paid plans arrive is a business decision, not a fact.
 *
 * ## The team-collaboration correction
 *
 * Business previously listed "Shared team workspaces" and "Per-member roles" as
 * things it would bring later. Both already work, today, on every plan:
 * `WorkspaceMembers` adds an existing account to a Workspace with a
 * viewer/commenter/editor/owner role, and no plan gate exists anywhere in
 * `WorkspaceMembershipService`. Advertising a shipped feature as a future paid
 * one is the same class of error as advertising an unshipped one as present, so
 * the bullets moved to Free and Business now lists only what is genuinely absent.
 */
export const pricingPlans: PricingPlan[] = [
  {
    id: "free",
    name: "Free",
    price: "$0",
    // "forever" implied a pricing commitment the product has not made: whether
    // the free tier stays free after paid plans arrive is a business decision,
    // not a fact. "$0 today" is what is actually true of this plan, and it stays
    // true in a deployment that can sell Pro. (Launch polish P1-13.)
    period: "today",
    description:
      "Every tool that works today, plus a Workspace to keep documents in.",
    features: [
      "Every PDF tool that is available today",
      "Browser tools without an account",
      "Workspace with folders, tags and search",
      "The full editor, autosave and version history",
      // Works today, on this plan. See the team-collaboration note above.
      "Shared Workspaces with viewer, commenter, editor and owner roles",
    ],
    cta: "Get Started Free",
    href: "/register?returnTo=/workspaces",
    available: true,
    highlighted: true,
  },
  {
    id: "pro",
    name: "Pro",
    price: "Not yet available",
    description:
      "Higher limits for heavy server-side work — larger files and longer jobs.",
    features: [
      "Larger file size limits",
      "Priority processing for queued jobs",
      "Longer document retention",
    ],
    cta: "Contact us",
    href: "/contact",
    available: false,
  },
  {
    id: "business",
    name: "Business",
    price: "Not yet available",
    // Not "shared workspaces for a team once team management ships": team
    // Workspaces and per-member roles ship today on Free. What Business is
    // waiting on is billing — there is no Business price to charge — and the
    // organization-level administration around it.
    description:
      "Organization-level billing and administration for a team. Not built yet; shared Workspaces and roles are already on Free.",
    features: [
      "One invoice for the whole organization",
      "Invitation emails for people without an account yet",
      "Support with a response commitment",
    ],
    cta: "Contact us",
    href: "/contact",
    available: false,
  },
];
