"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertCircle, Activity, Loader2, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  EMPTY_OPERATIONS_TEXT,
  boundedOperationsForDisplay,
  canCancel,
  canOpenResult,
  canRetry,
  isCurrentResponse,
  mergeOperations,
  operationAnnouncement,
  operationLabel,
  showsOperationProgress,
  type OperationView,
} from "./commandLogic";

export interface OperationCenterProps {
  workspaceId: string;
  organizationId: string;
  /** Whether the actor may cancel or retry. The API re-checks regardless. */
  canWrite?: boolean;
  /** Renders the link for a completed operation that produced something. */
  resultHref?: (operation: OperationView) => string | null;
}

/** How often the list is refreshed while work is active. */
const POLL_MS = 3000;

/**
 * The M7.14 operation center.
 *
 * Long-running work — uploads, comparisons, exports, reindexing — is visible in
 * one place with honest state. Three rules hold that up.
 *
 * **A finished operation never goes back to running.** Polling delivers
 * duplicate and reordered responses as a matter of course; `mergeOperations`
 * refuses to move a terminal entry backwards, so the panel cannot claim work
 * restarted when nothing did.
 *
 * **A result is offered only when one exists.** `canOpenResult` requires the
 * completed status *and* the server's `hasResult`, because a completed operation
 * with nothing attached is a state an interrupted worker produces and a link
 * there would open nothing.
 *
 * **Progress is never invented.** Only a running operation gets a determinate
 * progress bar; anything else shows its status text alone rather than a bar
 * moving on no information.
 */
export function OperationCenter({
  workspaceId,
  organizationId,
  canWrite = false,
  resultHref,
}: OperationCenterProps) {
  const [operations, setOperations] = useState<OperationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const headingId = useId();
  const sequenceRef = useRef(0);
  // What was already announced, so a poll that returns the same terminal state
  // does not repeat itself into the live region.
  const announcedRef = useRef(new Set<string>());

  const visible = useMemo(() => boundedOperationsForDisplay(operations), [operations]);
  const hasActive = useMemo(
    () => visible.some((operation) => canCancel(operation)),
    [visible],
  );

  const refresh = useCallback(async () => {
    const sequence = (sequenceRef.current += 1);
    try {
      const params = new URLSearchParams({ organizationId });
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/operations?${params.toString()}`,
      );
      const data = await response.json();
      // A slow reply that lands after a newer one is dropped rather than
      // overwriting current state with stale data.
      if (!isCurrentResponse(sequence, sequenceRef.current)) return;
      if (!response.ok) throw new Error(data.error?.message ?? "Operations could not be loaded.");

      setOperations((current) => {
        const merged = mergeOperations(current, data.operations as OperationView[]);
        for (const operation of merged) {
          const key = `${operation.id}:${operation.status}`;
          if (
            (operation.status === "completed" ||
              operation.status === "failed" ||
              operation.status === "cancelled") &&
            !announcedRef.current.has(key)
          ) {
            announcedRef.current.add(key);
            setAnnouncement(operationAnnouncement(operation));
          }
        }
        return merged;
      });
      setError(null);
    } catch (caught) {
      if (!isCurrentResponse(sequence, sequenceRef.current)) return;
      setError(caught instanceof Error ? caught.message : "Operations could not be loaded.");
    } finally {
      if (isCurrentResponse(sequence, sequenceRef.current)) setLoading(false);
    }
  }, [workspaceId, organizationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Polled only while something is active, so an idle panel is not a background
  // request every few seconds for as long as the tab is open.
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [hasActive, refresh]);

  const act = useCallback(
    async (operation: OperationView, action: "cancel" | "retry") => {
      setBusyId(operation.id);
      try {
        const response = await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/operations/${encodeURIComponent(
            operation.id,
          )}/${action}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ organizationId }),
          },
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message ?? "That action could not run.");

        setAnnouncement(
          action === "cancel"
            ? `${operation.label} was cancelled.`
            : `${operation.label} was restarted.`,
        );
        await refresh();
        setError(null);
      } catch (caught) {
        // In place, in a live region: a blocking alert() steals focus and cannot
        // be read back in context.
        setError(caught instanceof Error ? caught.message : "That action could not run.");
      } finally {
        setBusyId(null);
      }
    },
    [workspaceId, organizationId, refresh],
  );

  return (
    <section aria-labelledby={headingId} className="rounded-2xl border border-softborder bg-white p-4 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 id={headingId} className="flex items-center gap-2 text-base font-bold text-navy">
          <Activity className="h-4 w-4 text-primary" aria-hidden="true" />
          Operations
        </h2>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-navy-soft" aria-hidden="true" />}
      </div>

      {error !== null && (
        <p
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-button bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}

      {!loading && visible.length === 0 && (
        <p className="mt-4 text-sm text-navy-soft">{EMPTY_OPERATIONS_TEXT}</p>
      )}

      <ul className="mt-4 space-y-3">
        {visible.map((operation) => {
          const href = canOpenResult(operation) ? resultHref?.(operation) ?? null : null;
          return (
            <li
              key={operation.id}
              className="rounded-button border border-softborder p-3 sm:flex sm:items-center sm:justify-between sm:gap-4"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-navy">{operation.label}</p>
                <p className="mt-0.5 text-xs text-navy-soft">{operationLabel(operation)}</p>

                {showsOperationProgress(operation) && (
                  <div
                    role="progressbar"
                    aria-valuenow={operation.progress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${operation.label} progress`}
                    className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-lavender"
                  >
                    <div
                      className="h-full rounded-full bg-primary motion-safe:transition-all"
                      style={{ width: `${operation.progress}%` }}
                    />
                  </div>
                )}

                {operation.error !== null && (
                  <p className="mt-1 text-xs text-red-700">{operation.error}</p>
                )}
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2 sm:mt-0 sm:shrink-0">
                {href !== null && (
                  <Button href={href} variant="secondary" size="sm">
                    Open result
                  </Button>
                )}
                {canWrite && canCancel(operation) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={busyId === operation.id}
                    onClick={() => void act(operation, "cancel")}
                    leadingIcon={<X className="h-4 w-4" aria-hidden="true" />}
                  >
                    Cancel
                  </Button>
                )}
                {canWrite && canRetry(operation) && (
                  <Button
                    variant="outline"
                    size="sm"
                    loading={busyId === operation.id}
                    onClick={() => void act(operation, "retry")}
                    leadingIcon={<RotateCcw className="h-4 w-4" aria-hidden="true" />}
                  >
                    Retry
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </section>
  );
}
