"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { useAnalytics } from "@/hooks/useAnalytics";
import { offerPosts } from "@/src/domain/billing/proOffer";
import {
  awaitingEntitlement,
  loadProSummary,
  refreshProSummary,
  startBillingSession,
  type ProSummaryView,
} from "./proSummaryClient";

/**
 * The Pro card's live control.
 *
 * ## Why the server copy is the fallback, not a spinner
 *
 * `/pricing` is prerendered. This component renders `children` — the approved copy
 * from the pricing store — until a summary arrives, so the first paint is a real
 * sentence rather than a skeleton, and a visitor whose summary request fails keeps
 * a page that says something true. That is also why every failure path here ends
 * back at the fallback instead of at an error state.
 *
 * ## Why a purchase is never a redirect this component chose
 *
 * The button POSTs to `/api/billing/checkout` and navigates to the URL the server
 * returns. It does not build a Stripe URL, does not know a price id, and does not
 * write a plan anywhere. Coming back with `?checkout=success` grants nothing: the
 * only thing that changes an entitlement is the signed webhook, which is why the
 * success path here *re-reads the server* instead of assuming the upgrade worked.
 *
 * ## Why some states are text and not a disabled button
 *
 * `current` and `owner_only` render a sentence. A greyed-out "Upgrade" is how a
 * member concludes the purchase is one click away from working — the same reason
 * the page's unavailable plans link to contact instead of showing a dead control.
 */

/** Poll bound for the post-checkout wait: Stripe's webhook usually lands in seconds. */
const ACTIVATION_TRIES = 6;
const ACTIVATION_DELAY_MS = 2_000;

const MUTED: Record<"marketing" | "app", string> = {
  marketing: "text-navy-soft",
  app: "text-app-muted",
};

function returnedFromCheckout(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("checkout") === "success";
}

/** Drops `?checkout=` so a reload does not replay the activation wait. */
function clearCheckoutParam(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("checkout")) return;
  url.searchParams.delete("checkout");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Loads the summary once per page, then waits out the webhook if we just paid.
 *
 * The wait is bounded and its failure mode is the honest one: after the last try
 * the card simply shows whatever the server currently says. A subscription that
 * really was created still lands when the webhook is retried, and no state here
 * is what decides it.
 */
function useProSummary(organizationId?: string) {
  const [summary, setSummary] = useState<ProSummaryView | null>(null);
  const [activating, setActivating] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      let current = await loadProSummary(organizationId);
      if (!alive) return;
      setSummary(current);

      if (!returnedFromCheckout()) return;
      clearCheckoutParam();
      for (let i = 0; alive && i < ACTIVATION_TRIES && awaitingEntitlement(current); i++) {
        setActivating(true);
        await sleep(ACTIVATION_DELAY_MS);
        if (!alive) return;
        current = await refreshProSummary(organizationId);
        if (!alive) return;
        setSummary(current);
      }
      if (alive) setActivating(false);
    })();
    return () => {
      alive = false;
    };
  }, [organizationId]);

  return { summary, activating };
}

export interface ProUpgradeActionProps {
  /** Analytics dimension only — `pricing_page`, `workspace_dashboard`. */
  surface: string;
  organizationId?: string;
  palette?: "marketing" | "app";
  variant?: "primary" | "outline";
  fullWidth?: boolean;
  className?: string;
  /**
   * The approved server-rendered control, shown until (and unless) a summary
   * arrives. Optional: an in-app surface has no pre-approved copy to fall back to,
   * and rendering nothing until the plan is known beats rendering a guess.
   */
  children?: React.ReactNode;
}

export function ProUpgradeAction({
  surface,
  organizationId,
  palette = "marketing",
  variant = "primary",
  fullWidth = true,
  className,
  children,
}: ProUpgradeActionProps) {
  const { summary, activating } = useProSummary(organizationId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pathname = usePathname();
  const { trackOnce } = useAnalytics({ context: { surface } });

  // Fired once the plan is known, so `fromPlan` is the caller's real plan rather
  // than a placeholder. `trackOnce` keeps Strict Mode's double effect to one event.
  useEffect(() => {
    if (summary) trackOnce(`upgrade_view:${surface}`, "upgrade_view", { fromPlan: summary.plan });
  }, [summary, surface, trackOnce]);

  const onClick = useCallback(async () => {
    if (!summary || busy || !offerPosts(summary.action)) return;
    setBusy(true);
    setError(null);
    const result = await startBillingSession(
      summary.action === "manage" ? "manage" : "checkout",
      organizationId,
    );
    if ("url" in result) {
      // Stays busy on purpose: the navigation is in flight, and re-enabling the
      // button here is how a second checkout session gets created.
      window.location.assign(result.url);
      return;
    }
    setError(result.error);
    setBusy(false);
  }, [summary, busy, organizationId]);

  const muted = MUTED[palette];

  if (activating) {
    return (
      <p role="status" aria-live="polite" className={`text-sm ${muted} ${className ?? ""}`}>
        Finishing your upgrade — this can take a few seconds.
      </p>
    );
  }

  // No summary yet, or a deployment that cannot take money: the approved copy.
  if (!summary || summary.action === "unavailable") return <>{children}</>;

  if (summary.action === "sign_in") {
    return (
      <Control note={summary.note} muted={muted} className={className}>
        <Button
          href={`/login?next=${encodeURIComponent(pathname || "/pricing")}`}
          variant={variant}
          fullWidth={fullWidth}
        >
          {summary.actionLabel}
        </Button>
      </Control>
    );
  }

  if (!offerPosts(summary.action)) {
    return (
      <p className={`text-sm font-semibold text-center ${muted} ${className ?? ""}`}>
        {summary.actionLabel}
        {summary.note && <span className={`mt-1 block text-xs font-normal ${muted}`}>{summary.note}</span>}
      </p>
    );
  }

  return (
    <Control note={summary.note} muted={muted} className={className}>
      <Button
        type="button"
        onClick={onClick}
        disabled={busy}
        loading={busy}
        variant={variant}
        fullWidth={fullWidth}
      >
        {summary.actionLabel}
      </Button>
      {error && (
        // Inline and announced. There is no toast system in this app, and a
        // failure the user must act on cannot be a console message.
        <p role="status" aria-live="polite" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      )}
    </Control>
  );
}

function Control({
  note,
  muted,
  className,
  children,
}: {
  note: string | null;
  muted: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      {children}
      {note && <p className={`mt-2 text-xs ${muted}`}>{note}</p>}
    </div>
  );
}

/**
 * Swaps a piece of static copy once we know this deployment can sell Pro.
 *
 * Exists because the pricing page makes two claims outside the button — a "Coming
 * later" badge and a footnote saying the plan is not built yet — and a working
 * checkout next to either of them is the page lying. `fallback` is the
 * server-rendered claim and stays until a summary proves otherwise, so an
 * unconfigured deployment (and any visitor whose summary never loads) sees the
 * conservative version.
 */
export function ProConfigured({
  organizationId,
  fallback,
  children,
}: {
  organizationId?: string;
  fallback: React.ReactNode;
  children: React.ReactNode;
}) {
  const { summary } = useProSummary(organizationId);
  return <>{summary?.configured ? children : fallback}</>;
}

/**
 * The plan's price, live from the configured Stripe price when it can be read.
 *
 * `children` is the approved copy from the pricing store and stays on screen
 * whenever the real amount is unknown. No number is ever synthesized here — see
 * `formatPlanPrice`, which returns null rather than guessing, which is what makes
 * "we never show a price we did not read" a property instead of an intention.
 */
export function ProPriceLabel({
  organizationId,
  periodClassName,
  children,
}: {
  organizationId?: string;
  periodClassName?: string;
  children: React.ReactNode;
}) {
  const { summary } = useProSummary(organizationId);
  if (!summary?.priceLabel) return <>{children}</>;
  return (
    <>
      {summary.priceLabel}
      {summary.pricePeriod && <span className={periodClassName}>/{summary.pricePeriod}</span>}
    </>
  );
}
