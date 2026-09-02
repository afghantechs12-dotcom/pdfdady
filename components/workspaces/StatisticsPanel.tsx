"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertCircle, BarChart3, Loader2, RefreshCw, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  atActiveComparisonLimit,
  canCancel,
  canRecalculate,
  canRetry,
  canShowResult,
  canSubmitComparison,
  comparisonAnnouncement,
  comparisonStatusLabel,
  comparisonTypeLabel,
  comparisonTypeOptions,
  describeStatisticsError,
  emptyComparisonDraft,
  showsProgress,
  sortComparisonsForDisplay,
  statisticsRows,
  statisticsStatusLabel,
  summarizeDifferences,
  validateComparisonDraft,
  type ComparisonDraft,
  type StatisticsCountsView,
} from "./statisticsLogic";
import type { ComparisonStatus, ComparisonType } from "@/src/domain/entities/DocumentStatistics";

/** One version, as the panel receives it. */
export interface StatisticsVersionOption {
  id: string;
  versionNumber: number;
  label: string | null;
}

interface StatisticsResponse {
  versionId: string;
  counts: StatisticsCountsView;
  status: "pending" | "ready" | "failed";
  error: string | null;
  calculatedAt: string | null;
}

interface ComparisonResponse {
  id: string;
  type: ComparisonType;
  status: ComparisonStatus;
  progress: number;
  cancelRequested: boolean;
  hasResult: boolean;
  error: string | null;
  createdAt: string;
}

interface ComparisonResultResponse {
  summary: { added: number; removed: number; changed: number; truncated: boolean };
  differences: Array<{ kind: string; pageNumber: number | null; excerpt: string | null }>;
}

export interface StatisticsPanelProps {
  workspaceId: string;
  organizationId: string;
  documentId: string;
  /** Versions available to measure and compare, newest first. */
  versions: StatisticsVersionOption[];
  /** Whether the actor may recalculate or start a comparison. The API re-checks. */
  canWrite?: boolean;
}

/** How often a running comparison is polled. */
const POLL_MS = 2000;

/**
 * The M7.11 statistics and comparison panel.
 *
 * Three rules from the domain survive into this screen.
 *
 * A count that was not measured reads as "Not measured", never as "0" — the
 * service keeps those apart precisely so a document nobody scanned for images
 * does not claim it has none, and flattening them here would undo that.
 *
 * A comparison is only ever shown as completed when a real result exists.
 * `canShowResult` requires both the status *and* the result, because a completed
 * status with no result row is a state an interrupted worker can produce, and
 * rendering it would present an empty diff as "no differences found".
 *
 * Visual comparison is offered, disabled, with the reason attached, rather than
 * hidden: a missing option reads as a product that never had the feature, while
 * a disabled one that explains itself tells the user what is true.
 *
 * Errors appear in place in a live region rather than through `alert()`: a
 * blocking dialog steals focus and cannot be read back in context.
 */
export function StatisticsPanel({
  workspaceId,
  organizationId,
  documentId,
  versions,
  canWrite = false,
}: StatisticsPanelProps) {
  const [selectedVersionId, setSelectedVersionId] = useState(versions[0]?.id ?? "");
  const [statistics, setStatistics] = useState<StatisticsResponse | null>(null);
  const [statisticsLoading, setStatisticsLoading] = useState(false);
  const [recalculating, setRecalculating] = useState(false);

  const [comparisons, setComparisons] = useState<ComparisonResponse[]>([]);
  const [draft, setDraft] = useState<ComparisonDraft>(emptyComparisonDraft());
  const [submitting, setSubmitting] = useState(false);
  const [openResultId, setOpenResultId] = useState<string | null>(null);
  const [result, setResult] = useState<ComparisonResultResponse | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const headingId = useId();
  const versionSelectId = useId();
  const leftSelectId = useId();
  const rightSelectId = useId();
  const typeSelectId = useId();
  const statusId = useId();

  const abortRef = useRef<AbortController | null>(null);

  const query = `organizationId=${encodeURIComponent(organizationId)}`;
  const base = `/api/workspaces/${workspaceId}/documents/${documentId}`;

  const report = useCallback(async (response: Response) => {
    const body = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    setError(describeStatisticsError(response.status, body?.error?.message));
  }, []);

  const loadStatistics = useCallback(
    async (versionId: string) => {
      if (versionId === "") return;
      setStatisticsLoading(true);
      try {
        const response = await fetch(
          `${base}/statistics?${query}&versionId=${encodeURIComponent(versionId)}`,
          { credentials: "same-origin" },
        );
        if (!response.ok) {
          await report(response);
          return;
        }
        const body = (await response.json()) as { statistics: StatisticsResponse | null };
        // Null is meaningful: nothing has been calculated for this version yet,
        // which is different from a calculation that found zeroes.
        setStatistics(body.statistics);
        setError(null);
      } catch {
        setError("Could not load statistics. Check your connection and try again.");
      } finally {
        setStatisticsLoading(false);
      }
    },
    [base, query, report],
  );

  const loadComparisons = useCallback(async () => {
    try {
      const response = await fetch(`${base}/comparisons?${query}`, { credentials: "same-origin" });
      if (!response.ok) return;
      const body = (await response.json()) as { comparisons: ComparisonResponse[] };
      setComparisons(body.comparisons);
    } catch {
      // A failed poll is not worth an error banner; the next one may succeed.
    }
  }, [base, query]);

  useEffect(() => {
    void loadStatistics(selectedVersionId);
  }, [loadStatistics, selectedVersionId]);

  useEffect(() => {
    void loadComparisons();
  }, [loadComparisons]);

  // Poll only while something is actually running, so an idle panel is silent.
  const hasActive = comparisons.some((c) => c.status === "pending" || c.status === "running");
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => void loadComparisons(), POLL_MS);
    return () => clearInterval(timer);
  }, [hasActive, loadComparisons]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  async function recalculate() {
    if (!canRecalculate(recalculating, canWrite) || selectedVersionId === "") return;
    setRecalculating(true);
    setError(null);
    try {
      const response = await fetch(`${base}/statistics`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        // No measured content: the server derives it. A client may ask for a
        // recalculation, not answer it.
        body: JSON.stringify({ organizationId, versionId: selectedVersionId, force: true }),
      });
      if (!response.ok) {
        await report(response);
        return;
      }
      const body = (await response.json()) as { statistics: StatisticsResponse };
      setStatistics(body.statistics);
      setAnnouncement("Statistics recalculated.");
    } catch {
      setError("Could not recalculate. Check your connection and try again.");
    } finally {
      setRecalculating(false);
    }
  }

  async function startComparison() {
    const validation = validateComparisonDraft(draft);
    if (!validation.ok) {
      setError(validation.reason);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`${base}/comparisons`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, ...draft }),
      });
      if (!response.ok) {
        await report(response);
        return;
      }
      setDraft(emptyComparisonDraft());
      setAnnouncement("Comparison started.");
      await loadComparisons();
    } catch {
      setError("Could not start the comparison. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function act(comparisonId: string, action: "cancel" | "retry") {
    setError(null);
    try {
      const response = await fetch(`${base}/comparisons/${comparisonId}/${action}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId }),
      });
      if (!response.ok) {
        await report(response);
        return;
      }
      setAnnouncement(action === "cancel" ? "Cancellation requested." : "Comparison retried.");
      await loadComparisons();
    } catch {
      setError("That action could not be completed. Check your connection and try again.");
    }
  }

  async function openResult(comparisonId: string) {
    if (openResultId === comparisonId) {
      setOpenResultId(null);
      setResult(null);
      return;
    }
    try {
      const response = await fetch(`${base}/comparisons/${comparisonId}/result?${query}`, {
        credentials: "same-origin",
      });
      if (!response.ok) {
        await report(response);
        return;
      }
      const body = (await response.json()) as { result: ComparisonResultResponse };
      setResult(body.result);
      setOpenResultId(comparisonId);
    } catch {
      setError("Could not load the comparison result.");
    }
  }

  const typeOptions = comparisonTypeOptions();
  const ordered = sortComparisonsForDisplay(comparisons);
  const atLimit = atActiveComparisonLimit(
    comparisons.map((c) => ({
      id: c.id,
      type: c.type,
      status: c.status,
      progress: c.progress,
      cancelRequested: c.cancelRequested,
      hasResult: c.hasResult,
      error: c.error,
    })),
  );

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-card border border-softborder bg-white p-5 sm:p-6"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 id={headingId} className="flex items-center gap-2 text-lg font-bold text-navy">
          <BarChart3 className="h-5 w-5 text-primary" aria-hidden="true" />
          Statistics &amp; comparison
        </h2>
        {versions.length > 0 && (
          <div className="flex items-center gap-2">
            <label htmlFor={versionSelectId} className="text-sm font-medium text-navy-soft">
              Version
            </label>
            <select
              id={versionSelectId}
              value={selectedVersionId}
              onChange={(event) => setSelectedVersionId(event.target.value)}
              className="rounded-button border border-softborder px-3 py-2 text-sm text-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  {version.label ?? `Version ${version.versionNumber}`}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Errors and action results share one polite live region, so a screen
          reader hears the same thing the screen shows. */}
      <div id={statusId} aria-live="polite" className="sr-only">
        {error ?? announcement}
      </div>

      {error && (
        <p
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-button bg-red-50 p-3 text-sm text-red-700"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}

      {versions.length === 0 ? (
        <p className="mt-6 text-sm text-navy-soft">
          This document has no saved versions yet. Statistics are calculated per version.
        </p>
      ) : (
        <>
          {/* ---- statistics ---- */}
          <div className="mt-6">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-navy-soft">
                Document statistics
              </h3>
              {canWrite && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={recalculate}
                  disabled={!canRecalculate(recalculating, canWrite)}
                >
                  {recalculating ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
                  )}
                  {recalculating ? "Recalculating…" : "Recalculate"}
                </Button>
              )}
            </div>

            {statisticsLoading ? (
              <p className="mt-4 flex items-center gap-2 text-sm text-navy-soft">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Loading statistics…
              </p>
            ) : statistics === null ? (
              <p className="mt-4 text-sm text-navy-soft">
                No statistics have been calculated for this version yet.
              </p>
            ) : (
              <>
                <p className="mt-2 text-xs text-navy-soft">
                  {statisticsStatusLabel(statistics.status, statistics.calculatedAt)}
                </p>
                {statistics.status === "failed" && statistics.error && (
                  <p className="mt-2 text-sm text-red-700">{statistics.error}</p>
                )}
                <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                  {statisticsRows(statistics.counts).map((row) => (
                    <div key={row.key}>
                      <dt className="text-xs font-medium text-navy-soft">{row.label}</dt>
                      <dd
                        className={
                          row.unmeasured
                            ? "mt-1 text-sm italic text-slate-400"
                            : "mt-1 text-lg font-semibold text-navy"
                        }
                      >
                        {row.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
          </div>

          {/* ---- comparison composer ---- */}
          {canWrite && versions.length >= 2 && (
            <div className="mt-8 border-t border-softborder pt-6">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-navy-soft">
                Compare versions
              </h3>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <label htmlFor={leftSelectId} className="block text-xs font-medium text-navy-soft">
                    From
                  </label>
                  <select
                    id={leftSelectId}
                    value={draft.leftVersionId}
                    onChange={(event) => setDraft({ ...draft, leftVersionId: event.target.value })}
                    className="mt-1 w-full rounded-button border border-softborder px-3 py-2 text-sm text-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    <option value="">Select a version</option>
                    {versions.map((version) => (
                      <option key={version.id} value={version.id}>
                        {version.label ?? `Version ${version.versionNumber}`}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex-1">
                  <label htmlFor={rightSelectId} className="block text-xs font-medium text-navy-soft">
                    To
                  </label>
                  <select
                    id={rightSelectId}
                    value={draft.rightVersionId}
                    onChange={(event) => setDraft({ ...draft, rightVersionId: event.target.value })}
                    className="mt-1 w-full rounded-button border border-softborder px-3 py-2 text-sm text-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    <option value="">Select a version</option>
                    {versions.map((version) => (
                      <option key={version.id} value={version.id}>
                        {version.label ?? `Version ${version.versionNumber}`}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex-1">
                  <label htmlFor={typeSelectId} className="block text-xs font-medium text-navy-soft">
                    Type
                  </label>
                  <select
                    id={typeSelectId}
                    value={draft.type}
                    onChange={(event) =>
                      setDraft({ ...draft, type: event.target.value as ComparisonType })
                    }
                    className="mt-1 w-full rounded-button border border-softborder px-3 py-2 text-sm text-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    {typeOptions.map((option) => (
                      // Unsupported types stay visible but disabled, with the
                      // reason as the title, rather than silently missing.
                      <option
                        key={option.value}
                        value={option.value}
                        disabled={!option.supported}
                        title={option.reason ?? undefined}
                      >
                        {option.label}
                        {option.supported ? "" : " (unavailable)"}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  type="button"
                  onClick={startComparison}
                  disabled={!canSubmitComparison(draft, submitting) || atLimit}
                >
                  {submitting ? "Starting…" : "Compare"}
                </Button>
              </div>

              {/* The honest explanation, shown as soon as the type is chosen
                  rather than after a queued operation fails. */}
              {typeOptions.find((o) => o.value === draft.type && !o.supported)?.reason && (
                <p className="mt-2 text-sm text-amber-700">
                  {typeOptions.find((o) => o.value === draft.type)?.reason}
                </p>
              )}
              {atLimit && (
                <p className="mt-2 text-sm text-amber-700">
                  This document already has the maximum number of comparisons in progress. Wait for
                  one to finish.
                </p>
              )}
            </div>
          )}

          {/* ---- comparison history ---- */}
          <div className="mt-8 border-t border-softborder pt-6">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-navy-soft">
              Comparisons
            </h3>
            {ordered.length === 0 ? (
              <p className="mt-3 text-sm text-navy-soft">No comparisons yet.</p>
            ) : (
              <ul className="mt-3 flex flex-col gap-3">
                {ordered.map((comparison) => {
                  const view = {
                    id: comparison.id,
                    type: comparison.type,
                    status: comparison.status,
                    progress: comparison.progress,
                    cancelRequested: comparison.cancelRequested,
                    hasResult: comparison.hasResult,
                    error: comparison.error,
                  };
                  return (
                    <li
                      key={comparison.id}
                      className="rounded-button border border-softborder p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold text-navy">
                            {comparisonTypeLabel(comparison.type)}
                          </p>
                          <p className="text-xs text-navy-soft">{comparisonStatusLabel(view)}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          {canShowResult(view) && (
                            <Button
                              type="button"
                              variant="secondary"
                              onClick={() => openResult(comparison.id)}
                            >
                              {openResultId === comparison.id ? "Hide result" : "View result"}
                            </Button>
                          )}
                          {canWrite && canCancel(view) && (
                            <Button
                              type="button"
                              variant="secondary"
                              onClick={() => act(comparison.id, "cancel")}
                            >
                              <X className="mr-1 h-4 w-4" aria-hidden="true" />
                              Cancel
                            </Button>
                          )}
                          {canWrite && canRetry(view) && (
                            <Button
                              type="button"
                              variant="secondary"
                              onClick={() => act(comparison.id, "retry")}
                            >
                              <RotateCcw className="mr-1 h-4 w-4" aria-hidden="true" />
                              Retry
                            </Button>
                          )}
                        </div>
                      </div>

                      {showsProgress(view) && (
                        <div
                          role="progressbar"
                          aria-valuenow={comparison.progress}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-label={comparisonAnnouncement(view)}
                          className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100"
                        >
                          <div
                            className="h-full rounded-full bg-primary transition-all"
                            style={{ width: `${comparison.progress}%` }}
                          />
                        </div>
                      )}

                      {comparison.status === "failed" && comparison.error && (
                        <p className="mt-2 text-sm text-red-700">{comparison.error}</p>
                      )}

                      {/* A completed comparison with no result row says so
                          rather than presenting an empty diff as agreement. */}
                      {comparison.status === "completed" && !comparison.hasResult && (
                        <p className="mt-2 text-sm text-amber-700">
                          This comparison finished, but no result is available.
                        </p>
                      )}

                      {openResultId === comparison.id && result && (
                        <div className="mt-3 border-t border-softborder pt-3">
                          <p className="text-sm font-medium text-navy">
                            {summarizeDifferences(result.summary)}
                          </p>
                          {result.differences.length > 0 && (
                            <ul className="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto">
                              {result.differences.slice(0, 200).map((difference, index) => (
                                <li key={index} className="text-xs text-navy-soft">
                                  <span className="font-semibold uppercase">{difference.kind}</span>
                                  {difference.pageNumber !== null && ` · page ${difference.pageNumber}`}
                                  {/* Rendered as a text node: an excerpt
                                      containing markup displays as characters. */}
                                  {difference.excerpt !== null && ` · ${difference.excerpt}`}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
