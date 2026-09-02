"use client";

import { useEffect, useState } from "react";
import { AlertCircle } from "lucide-react";

import { ProUpgradeAction } from "@/components/billing/ProUpgradeAction";
import { parseUsage, quotaNoticeView, type UsageState } from "@/components/app/usageViewModel";
import type { DenyReason } from "@/src/domain/metering/decision";

/**
 * What a user sees when a submission was refused for quota.
 *
 * ## Why this is not just `ErrorBanner`
 *
 * A one-line red sentence answers "it failed" but not the two questions a refused
 * user actually has: what limit, and what can I do about it. This adds the plan
 * name, the reset time when there is one, and the upgrade control — and nothing
 * else, because the banner is still the right answer for every other failure.
 *
 * ## Why it fetches `/api/usage` instead of reading the refusal body
 *
 * The refusal carries a reason and nothing more. The plan and the window come from
 * the server's own usage projection, which is per-owner and authoritative; a panel
 * that recomputed "0 of 100 left" from numbers echoed back in the 429 would be a
 * client deciding what someone's quota is.
 *
 * ## Why nothing here can break the tool
 *
 * Both async paths are total. The usage fetch catches everything and falls back to
 * a panel with no plan line, and `ProUpgradeAction` owns its own state and renders
 * nothing at all when the deployment cannot sell Pro — so a billing outage costs
 * this panel a button, not the user their PDF. The panel is rendered *after* a
 * failed submit, so there is no path where it stands between anyone and a tool run.
 */
export function QuotaNotice({ reason }: { reason: DenyReason }) {
  const [usage, setUsage] = useState<UsageState>({ kind: "loading" });

  useEffect(() => {
    const abort = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/usage", { signal: abort.signal, cache: "no-store" });
        setUsage(res.ok ? parseUsage(await res.json(), Date.now()) : { kind: "unavailable" });
      } catch {
        if (!abort.signal.aborted) setUsage({ kind: "unavailable" });
      }
    })();
    return () => abort.abort();
  }, []);

  const view = quotaNoticeView(reason, usage);

  return (
    <div
      role="alert"
      className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <div className="flex items-start gap-2">
        <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-semibold">{view.headline}</p>
          <p className="mt-0.5">{view.detail}</p>
          {(view.planLabel || view.resetLabel) && (
            <p className="mt-1.5 text-[12px] opacity-80">
              {[view.planLabel, view.resetLabel].filter(Boolean).join(" · ")}
            </p>
          )}
          {/* Renders nothing until the billing summary says Pro is purchasable. */}
          <ProUpgradeAction
            surface="quota_denied"
            palette="app"
            variant="outline"
            fullWidth={false}
            className="mt-2"
          />
        </div>
      </div>
    </div>
  );
}
