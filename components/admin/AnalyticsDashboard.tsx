"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Card } from "./Card";
import { formatBytes } from "@/lib/utils/formatBytes";
import type {
  AnalyticsReport,
  CalibrationReport,
} from "@/src/application/services/UsageAnalyticsReadService";

/**
 * What `GET /api/admin/analytics` returns: the dashboard report plus the
 * calibration verdict for the same window. One request, because a readiness
 * verdict shown beside a set of numbers has to have been computed over those
 * numbers.
 */
type AdminAnalytics = AnalyticsReport & { calibration: CalibrationReport };

/**
 * The processing analytics surface.
 *
 * Everything rendered here arrives pre-aggregated from `GET /api/admin/analytics`
 * — counts, sums and ratios the database computed. There is no client-side
 * reduction over a row list, because no row list is ever sent: see the read
 * service for why a `subjectHash` must not travel even to an admin.
 *
 * The window is a fixed set of choices rather than a date picker. A picker is the
 * feature that produces "the last three years" as a default someone bookmarks;
 * these four options all fall inside the server's cap, so the UI cannot ask for
 * something the server will silently clamp.
 */
const WINDOWS = [
  { label: "24 hours", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
] as const;

type Status = "loading" | "ready" | "error";

export function AnalyticsDashboard() {
  const [days, setDays] = useState<number>(7);
  const [status, setStatus] = useState<Status>("loading");
  const [report, setReport] = useState<AdminAnalytics | null>(null);
  // Which funnel is expanded. Local, not a query parameter: every tool's funnel
  // already arrives in the one report, so switching between them is a render, not
  // a refetch — and a refetch would make comparing two tools a slow flicker.
  const [funnelSlug, setFunnelSlug] = useState<string | null>(null);

  const load = useCallback(async (windowDays: number, signal?: AbortSignal) => {
    setStatus("loading");
    try {
      // `from` only. `to` is left to the server so the window always ends now,
      // and a clock skew between browser and server cannot produce an empty
      // report that reads as "nothing happened today".
      const from = new Date(Date.now() - windowDays * 86_400_000).toISOString();
      const res = await fetch(`/api/admin/analytics?from=${encodeURIComponent(from)}`, {
        signal,
        cache: "no-store",
      });
      if (!res.ok) {
        setStatus("error");
        return;
      }
      setReport((await res.json()) as AdminAnalytics);
      setStatus("ready");
    } catch {
      if (!signal?.aborted) setStatus("error");
    }
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    void load(days, abort.signal);
    return () => abort.abort();
  }, [days, load]);

  const p = report?.processing;
  // The selected funnel, falling back to the one the server featured rather than
  // to `funnels[0]`: on a window with no activity the server still returns a real
  // spine of zeroes, and an empty list would render the detail card as broken.
  const selectedFunnel =
    report?.funnels.find((f) => f.toolSlug === funnelSlug) ?? report?.funnel ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="inline-flex rounded-full border border-softborder bg-white p-0.5"
          role="group"
          aria-label="Reporting window"
        >
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              type="button"
              onClick={() => setDays(w.days)}
              aria-pressed={days === w.days}
              className={
                days === w.days
                  ? "rounded-full bg-primary px-3 py-1.5 text-xs font-bold text-white"
                  : "rounded-full px-3 py-1.5 text-xs font-semibold text-navy-soft hover:text-navy"
              }
            >
              {w.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void load(days)}
          className="inline-flex items-center gap-1.5 rounded-full border border-softborder bg-white px-3 py-1.5 text-xs font-semibold text-navy-soft hover:text-navy"
        >
          <RefreshCw size={13} aria-hidden="true" />
          Refresh
        </button>
        {status === "loading" && (
          <span className="text-xs text-navy-soft" role="status">
            Loading…
          </span>
        )}
        {report?.degraded && (
          // A partial read is stated, not smoothed over: an operator comparing
          // today with yesterday needs to know today's numbers are floors.
          <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-700">
            Some queries failed — figures are minimums
          </span>
        )}
        {report?.window.clamped && (
          <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-700">
            Window adjusted to the reportable range
          </span>
        )}
      </div>

      {status === "error" && (
        <Card title="Analytics unavailable" description="The report could not be read.">
          <p className="text-sm text-navy-soft">
            Tool processing is unaffected — this page only reads the usage ledger.
          </p>
        </Card>
      )}

      {report && selectedFunnel && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Processing runs" value={num(p?.runs)} />
            <Stat label="Succeeded" value={num(p?.succeeded)} />
            <Stat label="Failed" value={num(p?.failed)} />
            <Stat
              label="Success rate"
              value={p?.successRate === null || p?.successRate === undefined ? "—" : pct(p.successRate)}
            />
            <Stat label="Bytes processed" value={formatBytes(p?.inputBytes ?? 0)} />
            <Stat
              label="Avg duration"
              value={p?.averageDurationMs === null || p?.averageDurationMs === undefined
                ? "—"
                : `${(p.averageDurationMs / 1000).toFixed(2)} s`}
              // A mean over three attempts and one over three thousand look
              // identical on a tile; the sample size stops it being read as solid.
              hint={p?.durationSamples ? `${num(p.durationSamples)} timed` : "no timings"}
            />
            <Stat label="Compute units" value={num(p?.computeUnits)} />
            <Stat label="Tools active" value={num(report.toolCount)} />
          </div>

          <Card
            title="Local vs remote"
            description="Completed operations by where the work ran. Local runs never consume a server allowance."
          >
            {report.execution.length === 0 ? (
              <Empty />
            ) : (
              <ul className="space-y-2">
                {report.execution.map((row) => (
                  <li key={row.label} className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-semibold text-navy">{modeLabel(row.label)}</span>
                    <span className="tabular-nums text-navy-soft">{num(row.count)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Top tools" description={`Busiest first. ${num(report.toolCount)} tool(s) had activity in this window.`}>
            {report.topTools.length === 0 ? (
              <Empty />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-softborder text-left text-xs uppercase tracking-wide text-navy-soft">
                      <th className="py-2 pr-3 font-bold">Tool</th>
                      <th className="py-2 pr-3 text-right font-bold">Runs</th>
                      <th className="py-2 pr-3 text-right font-bold">OK</th>
                      <th className="py-2 pr-3 text-right font-bold">Failed</th>
                      <th className="py-2 pr-3 text-right font-bold">Bytes</th>
                      <th className="py-2 text-right font-bold">Avg</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-softborder">
                    {report.topTools.map((tool) => (
                      <tr key={tool.toolSlug}>
                        <td className="py-2 pr-3 font-semibold text-navy">{tool.toolSlug}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-navy-soft">{num(tool.total)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-navy-soft">{num(tool.succeeded)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-navy-soft">{num(tool.failed)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-navy-soft">{formatBytes(tool.inputBytes)}</td>
                        <td className="py-2 text-right tabular-nums text-navy-soft">
                          {tool.averageDurationMs === null ? "—" : `${(tool.averageDurationMs / 1000).toFixed(2)} s`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card
            title="Tool funnels"
            description="Every instrumented tool, busiest first. Counted as event occurrences over the window, deduplicated per visit at the source — not distinct visitors."
          >
            {report.funnels.length === 0 ? (
              <Empty label="No funnel activity in this window." />
            ) : (
              <div className="mb-5 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-softborder text-left text-xs uppercase tracking-wide text-navy-soft">
                      <th className="pb-2 pr-3 font-semibold">Tool</th>
                      <th className="pb-2 pr-3 font-semibold">Mode</th>
                      <th className="pb-2 pr-3 text-right font-semibold">Entered</th>
                      <th className="pb-2 pr-3 text-right font-semibold">Completed</th>
                      <th className="pb-2 pr-3 text-right font-semibold">Conv.</th>
                      <th className="pb-2 text-right font-semibold">Failed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.funnels.map((f) => {
                      const last = f.steps.at(-1);
                      const selected = (funnelSlug ?? report.funnel.toolSlug) === f.toolSlug;
                      return (
                        <tr
                          key={f.toolSlug}
                          onClick={() => setFunnelSlug(f.toolSlug)}
                          className={`cursor-pointer border-b border-softborder/60 last:border-0 ${
                            selected ? "bg-lavender/50" : ""
                          }`}
                        >
                          <td className="py-2 pr-3 font-medium text-navy">{f.toolSlug}</td>
                          <td className="py-2 pr-3 text-navy-soft">
                            {/* The spine each tool was measured against, so two rows are
                                only compared once the reader can see they count different
                                sequences. */}
                            {f.executionMode === "remote_job"
                              ? "server"
                              : f.executionMode === "local"
                                ? "in-browser"
                                : "retired"}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums text-navy-soft">
                            {num(f.steps[0]?.count ?? 0)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums text-navy-soft">
                            {num(last?.count ?? 0)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums text-navy-soft">
                            {pct(last?.conversionFromStart ?? 0)}
                          </td>
                          <td className="py-2 text-right tabular-nums text-navy-soft">
                            {num(f.failed)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {report.funnelToolCount > report.funnels.length && (
                  <p className="mt-2 text-xs text-navy-soft">
                    Showing {report.funnels.length} of {report.funnelToolCount} tools with activity.
                  </p>
                )}
              </div>
            )}
          </Card>

          <Card
            title={`${selectedFunnel.toolSlug} funnel`}
            description="The steps of the selected tool, against the spine its execution mode can produce."
          >
            {selectedFunnel.steps.every((s) => s.count === 0) ? (
              <Empty />
            ) : (
              <ul className="space-y-3">
                {selectedFunnel.steps.map((step, index) => (
                  <li key={step.step}>
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="font-semibold text-navy">
                        {index + 1}. {step.step}
                        {selectedFunnel.worstStep === step.step && (
                          <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                            biggest drop
                          </span>
                        )}
                      </span>
                      <span className="tabular-nums text-navy-soft">
                        {num(step.count)}
                        {index > 0 && ` · ${pct(step.conversionFromPrevious)} of previous`}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-lavender">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${Math.round(step.conversionFromStart * 100)}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-4 border-t border-softborder pt-3 text-xs text-navy-soft">
              {num(selectedFunnel.failed)} failure event(s) in this window, reported beside the funnel
              rather than as a step — a failure is not progress toward a download.
            </p>
          </Card>

          <Card
            title="Failure categories"
            description="Normalized causes across both in-browser runs and server attempts. One label space, so a class means the same thing wherever it was recorded."
          >
            {report.errorCategories.length === 0 ? (
              <Empty label="No categorized failures in this window." />
            ) : (
              <ul className="space-y-2">
                {report.errorCategories.map((row) => (
                  <li key={row.label} className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-semibold text-navy">{row.label}</span>
                    <span className="tabular-nums text-navy-soft">{num(row.count)}</span>
                  </li>
                ))}
              </ul>
            )}
            {report.uncategorizedLocalFailures > 0 && (
              <p className="mt-4 border-t border-softborder pt-3 text-xs text-navy-soft">
                {num(report.uncategorizedLocalFailures)} in-browser failure(s) carry no category —
                recorded before local tools classified their failures. Nothing is invented for them.
              </p>
            )}
          </Card>

          <Card
            title="Limits & enforcement readiness"
            description="Whether the observed traffic supports turning a limit on. Nothing here is enforced unless the mode says so."
          >
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span
                className={
                  report.calibration.observation.limitMode === "enforce"
                    ? "rounded-full bg-rose-50 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-rose-700"
                    : "rounded-full bg-lavender px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-navy"
                }
              >
                {/* The mode is the first thing on this card because it changes what
                    every other number below it MEANS: in observe mode the refusals
                    are hypothetical, and in enforce mode they happened to someone. */}
                {modeDescription(report.calibration.observation.limitMode)}
              </span>
              <span
                className={
                  report.calibration.readiness.ready_for_enforcement
                    ? "rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700"
                    : "rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-700"
                }
              >
                {report.calibration.readiness.ready_for_enforcement
                  ? "Ready for enforcement"
                  : "Not ready for enforcement"}
              </span>
              <span className="text-xs text-navy-soft">
                {readinessReasonLabel(report.calibration.readiness.reason)}
              </span>
            </div>

            {/* The window the READINESS figures were measured over, which is not the
                window the rest of this page uses: calibration defaults wider, because
                a fourteen-day threshold cannot be met inside a seven-day range. */}
            <p className="mb-3 text-xs text-navy-soft">
              Measured over {num(report.calibration.window.days)} day(s) to{" "}
              {new Date(report.calibration.window.to).toISOString().slice(0, 10)}
              {report.calibration.window.clamped && " (range clamped)"}.
            </p>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <Stat
                label="Days with traffic"
                value={num(report.calibration.readiness.observed.days)}
                // "Days observed" read as the span of the window. It is the count of
                // distinct days that actually carry server traffic — the difference is
                // the whole reason a wider date range cannot clear this threshold.
                hint={`${report.calibration.readiness.thresholds.minObservationDays} needed, days with server traffic`}
              />
              <Stat
                label="Server operations"
                value={num(report.calibration.readiness.observed.operations)}
                hint={`${num(report.calibration.readiness.thresholds.minOperations)} needed`}
              />
              <Stat
                label="Server tools used"
                value={num(report.calibration.readiness.observed.toolsObserved)}
                hint={`${num(report.calibration.readiness.thresholds.minTools)} needed`}
              />
              <Stat
                label="Per day"
                value={report.calibration.readiness.observed.operationsPerDay.toFixed(1)}
                // Named a mean, because it is one. The ledger is aggregated by tool,
                // not by day, so no percentile of daily volume is available from it
                // and a p95 shown here would be fabricated.
                hint="mean, not a percentile"
              />
              <Stat
                label="Guest share"
                value={
                  report.calibration.readiness.observed.guestShare === null
                    ? "—"
                    : pct(report.calibration.readiness.observed.guestShare)
                }
                hint="of recorded operations"
              />
              <Stat
                label="Limit events"
                value={num(report.calibration.observation.limitEvents)}
                hint="recorded refusal decisions"
              />
            </div>

            {report.calibration.readiness.observed.excludedOperations > 0 && (
              <p className="mt-3 text-xs text-navy-soft">
                {/* Stated rather than silently dropped: two operation counts on one
                    page that disagree by an unexplained amount is how someone
                    concludes the ledger is broken. */}
                {num(report.calibration.readiness.observed.excludedOperations)} further
                attempt(s) in this window ran in the browser or under a slug the
                registry no longer knows. They are excluded above: they consumed no
                server capacity, so they cannot help authorize a server limit.
              </p>
            )}

            {report.calibration.observation.degraded && (
              <p
                role="status"
                className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900"
              >
                {/* Louder than the rest of the card on purpose. Every figure above is
                    a floor rather than a total, and a floor that happens to clear a
                    threshold has not measured anything. */}
                At least one usage query failed. Every figure above is a minimum, not a
                total, and enforcement stays refused until the reads succeed.
              </p>
            )}

            <p className="mt-4 text-sm text-navy-soft">
              {report.calibration.readiness.observed.wouldHaveBlocked === null ? (
                <>
                  Would-have-blocked events are only counted while observing — in this
                  mode a refusal either happened or was never evaluated.
                </>
              ) : (
                <>
                  <span className="font-bold text-navy">
                    {num(report.calibration.readiness.observed.wouldHaveBlocked)}
                  </span>{" "}
                  operation(s) would have been refused by the current allowances. Nobody
                  was actually refused.
                </>
              )}
            </p>

            {report.calibration.readiness.gaps.length > 0 && (
              <ul className="mt-3 space-y-1 border-t border-softborder pt-3 text-xs text-navy-soft">
                {report.calibration.readiness.gaps.map((gap) => (
                  <li key={gap}>· {gap}</li>
                ))}
              </ul>
            )}

            {report.calibration.observation.inputSizeBuckets.length > 0 && (
              <div className="mt-4 border-t border-softborder pt-3">
                <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-navy-soft">
                  Input sizes
                </p>
                <ul className="space-y-1">
                  {report.calibration.observation.inputSizeBuckets.map((bucket) => (
                    <li key={bucket.label} className="flex justify-between gap-3 text-sm">
                      <span className="font-semibold text-navy">{bucket.label}</span>
                      <span className="tabular-nums text-navy-soft">{num(bucket.count)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-4 border-t border-softborder pt-3">
              <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-navy-soft">
                Suggested daily operation ceilings
              </p>
              <ul className="space-y-1">
                {report.calibration.recommendations
                  .filter((rec) => rec.meter === "server_operations")
                  .map((rec) => (
                    <li key={rec.plan} className="flex justify-between gap-3 text-sm">
                      <span className="font-semibold text-navy">{rec.plan}</span>
                      <span className="tabular-nums text-navy-soft">
                        {/* No number at all on the insufficient arm. A figure with a
                            "low confidence" caveat is the one that gets shipped anyway. */}
                        {rec.status === "available"
                          ? `${num(rec.suggestedPerDay)} (now ${rec.currentLimit === null ? "unlimited" : num(rec.currentLimit)})`
                          : "insufficient data"}
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

/** Operator-facing name for the enforcement mode. */
function modeDescription(mode: string): string {
  if (mode === "observe") return "Monitoring only";
  if (mode === "enforce") return "Enforcing limits";
  if (mode === "off") return "Limits off";
  return mode;
}

/** Why the verdict is what it is, in a sentence an operator can act on. */
function readinessReasonLabel(reason: string): string {
  switch (reason) {
    case "insufficient_observation_data":
      return "Not enough observed traffic yet.";
    case "observation_degraded":
      return "A usage query failed — these figures are minimums, so they cannot authorize a limit.";
    case "not_observing":
      return "Limit decisions are not being recorded, so nothing is being calibrated against.";
    case "already_enforcing":
      return "Limits are already being applied.";
    case "observation_sufficient":
      return "The observation window clears every threshold.";
    default:
      return reason;
  }
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-card border border-softborder bg-white p-4 shadow-card">
      <p className="text-[11px] font-bold uppercase tracking-wider text-navy-soft">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-navy">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-navy-soft">{hint}</p>}
    </div>
  );
}

/** Zero-data state. Said once, in one place, so every section agrees on the wording. */
function Empty({ label = "No activity in this window." }: { label?: string }) {
  return <p className="text-sm text-navy-soft">{label}</p>;
}

function num(value: number | undefined): string {
  return (value ?? 0).toLocaleString("en-US");
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Ledger values are internal identifiers; these are the operator-facing names. */
function modeLabel(value: string): string {
  if (value === "local") return "In the browser";
  if (value === "remote_job") return "On the server";
  if (value === "unattributed") return "Mode not recorded";
  return value;
}
