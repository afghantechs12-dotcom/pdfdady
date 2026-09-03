"use client";

import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import { AppCard, EmptyState, Meter, SectionHeader, Skeleton, StatusBadge } from "./primitives";
import { parseUsage, type UsageState } from "./usageViewModel";
import { ProUpgradeAction } from "@/components/billing/ProUpgradeAction";

/**
 * The signed-in user's own allowance.
 *
 * ## Why this cannot break a PDF tool
 *
 * The card fetches on mount, catches everything, and renders "unavailable" on any
 * failure. It shares no state with the tool surfaces and no code path with a job
 * submission, so the worst case is one card in an account page reading
 * "Usage is unavailable" — a tool run is not waiting on this and cannot be told
 * about its failure. An error thrown during render *would* propagate to the
 * nearest boundary, which is why `parseUsage` is total: it returns a state for
 * every input, including an HTML error page from a proxy.
 *
 * ## Why the numbers are not interpreted here
 *
 * All formatting and clamping is in `usageViewModel.ts`, which vitest can test
 * under `environment: "node"`. What remains here is markup. That split is what
 * makes "never show a raw counter key" an asserted property rather than a habit.
 *
 * ## Why observe mode is labelled
 *
 * `mode: "observe"` means the ceilings are being measured, not applied. The badge
 * says so, because a full bar with no explanation is how a user concludes they
 * have been throttled by a limit that is not actually switched on.
 *
 * ## Why the upgrade control lives here
 *
 * This is the one in-app place that already answers "what plan am I on and how
 * much of it have I used", which is where someone decides to upgrade. It reads its
 * own state from `/api/billing/summary` and renders nothing at all when the
 * deployment cannot sell Pro, so this card is unchanged in a deployment without
 * Stripe — and, exactly as above, it cannot affect a tool run either way.
 */
export function UsageCard({
  className,
  organizationId,
}: {
  className?: string;
  organizationId?: string;
}) {
  const [state, setState] = useState<UsageState>({ kind: "loading" });

  useEffect(() => {
    // Aborted on unmount so a slow response cannot set state on a gone card.
    const abort = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/usage", {
          signal: abort.signal,
          // The response is per-visitor and marked no-store; asking the browser
          // not to reuse a cached one keeps a stale allowance off the screen.
          cache: "no-store",
        });
        if (!res.ok) {
          setState({ kind: "unavailable" });
          return;
        }
        setState(parseUsage(await res.json(), Date.now()));
      } catch {
        // Includes the abort. Setting state after an abort is a no-op on an
        // unmounted component, and distinguishing the two buys nothing here.
        if (!abort.signal.aborted) setState({ kind: "unavailable" });
      }
    })();
    return () => abort.abort();
  }, []);

  return (
    <AppCard as="section" className={className}>
      <SectionHeader
        title={
          <span className="flex items-center gap-1.5">
            <Gauge size={15} aria-hidden="true" className="text-primary" />
            Usage
          </span>
        }
        subtitle={state.kind === "ready" ? state.view.planLabel : undefined}
        action={
          state.kind === "ready" && !state.view.enforced ? (
            <StatusBadge tone="neutral">Monitoring</StatusBadge>
          ) : undefined
        }
      />

      {state.kind === "loading" && (
        <div className="mt-3 space-y-3" aria-busy="true">
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-1.5 w-full" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      )}

      {state.kind === "unavailable" && (
        <EmptyState
          compact
          icon={<Gauge size={18} aria-hidden="true" />}
          title="Usage is unavailable"
          description="This does not affect your tools — everything still works."
        />
      )}

      {state.kind === "empty" && (
        <EmptyState
          compact
          icon={<Gauge size={18} aria-hidden="true" />}
          title="No allowance to show"
          description={`${state.planLabel} does not meter the tools you have used.`}
        />
      )}

      {state.kind === "ready" && (
        <div className="mt-3 space-y-4">
          {state.view.meters.map((meter) => (
            <div key={meter.id}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-semibold text-app-text">{meter.label}</span>
                <span className="text-[11px] tabular-nums text-app-muted">{meter.usedLabel}</span>
              </div>
              <Meter
                className="mt-1.5"
                value={meter.used}
                max={meter.limit}
                tone={meter.tone}
                label={`${meter.label}: ${meter.usedLabel}`}
              />
              <div className="mt-1 flex items-baseline justify-between gap-2 text-[11px] text-app-muted">
                {/*
                  Null in observe mode. Rendered as an empty span rather than
                  removed so the reset time stays right-aligned in both modes.
                */}
                <span>{meter.remainingLabel ?? ""}</span>
                {/* Clock-derived: "Resets in 13 hours" today, "1 day" tomorrow. */}
                <span data-relative-time>{meter.resetLabel}</span>
              </div>
            </div>
          ))}

          {/*
            Said to be the plan's ceiling, because it is. Each tool applies its
            own, lower or equal, limit — 50MB in the browser tools, 20–100MB per
            server tool — and an unqualified "largest file per upload" here read
            as a promise that any tool would accept a 100MB file.
          */}
          <p className="border-t border-app-border pt-3 text-[11px] text-app-muted">
            Largest file this plan allows per upload:{" "}
            <span className="font-semibold">{state.view.maxFileLabel}</span>
            <span className="block">Individual tools may allow less; each upload box states its own limit.</span>
          </p>

          {!state.view.enforced && (
            // The badge alone is one word. A user reading a full bar needs the
            // sentence, not a label they have to interpret: in observe mode the
            // number is being measured and nothing has been refused.
            <p className="text-[11px] text-app-muted">
              These allowances are being measured, not applied — nothing is blocked yet.
            </p>
          )}

          {/*
            Below the meters on purpose: the numbers are the reason to upgrade, so
            the control follows them rather than competing with them. Renders
            nothing until the summary says Pro is purchasable.
          */}
          <ProUpgradeAction
            surface="workspace_usage"
            organizationId={organizationId}
            palette="app"
            variant="outline"
          />

          {state.view.degraded && (
            // Said plainly rather than hidden: a floor presented as a total is how
            // someone concludes they have used nothing on a day the counters were
            // unreadable.
            <p className="text-[11px] text-amber-600 dark:text-amber-500">
              Some figures could not be read and may be low.
            </p>
          )}
        </div>
      )}
    </AppCard>
  );
}
