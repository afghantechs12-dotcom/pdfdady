"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Activity, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { useFocusTrap } from "@/lib/a11y/focusTrap";
import { OperationCenter } from "./OperationCenter";
import {
  boundedOperationsForDisplay,
  canCancel,
  isCurrentResponse,
  mergeOperations,
  type OperationView,
} from "./commandLogic";

export interface OperationsIndicatorProps {
  workspaceId: string;
  organizationId: string;
  canWrite?: boolean;
}

/** How often the badge count is refreshed while work is active. */
const POLL_MS = 3000;

/**
 * The top-bar operations indicator and its drawer.
 *
 * The dashboard used to reserve a large card for the operation center whether
 * or not anything was running, so an idle Workspace showed a big empty box
 * saying "No recent operations". The center itself is unchanged — it moves into
 * a drawer, and only a small badge remains in the top bar.
 *
 * The badge counts ACTIVE operations only, and polls only while some are
 * running, so an idle Workspace is not a background request every few seconds
 * for as long as the tab is open. It reuses `mergeOperations` and the sequence
 * guard from the same logic module the center uses, so the badge cannot
 * disagree with the list it opens.
 */
export function OperationsIndicator({
  workspaceId,
  organizationId,
  canWrite = false,
}: OperationsIndicatorProps) {
  const [open, setOpen] = useState(false);
  const [operations, setOperations] = useState<OperationView[]>([]);
  const drawerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sequenceRef = useRef(0);
  const titleId = useId();

  useFocusTrap(drawerRef, open, () => setOpen(false));

  useEffect(() => {
    if (!open) triggerRef.current?.focus({ preventScroll: true });
  }, [open]);

  const refresh = useCallback(async () => {
    const sequence = (sequenceRef.current += 1);
    try {
      const params = new URLSearchParams({ organizationId });
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/operations?${params.toString()}`,
        { credentials: "same-origin" },
      );
      if (!isCurrentResponse(sequence, sequenceRef.current)) return;
      if (!response.ok) return;
      const data = await response.json();
      setOperations((current) => mergeOperations(current, data.operations as OperationView[]));
    } catch {
      // The badge is an affordance, not a report: a failed poll leaves the last
      // known state rather than flashing an error into the top bar. The drawer
      // surfaces real errors when opened.
    }
  }, [workspaceId, organizationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeCount = boundedOperationsForDisplay(operations).filter((op) => canCancel(op)).length;

  useEffect(() => {
    if (activeCount === 0) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [activeCount, refresh]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label={
          activeCount > 0
            ? `Operations, ${activeCount} running`
            : "Operations"
        }
        title="Operations"
        className="relative grid h-9 w-9 place-items-center rounded-control text-app-muted transition-colors hover:bg-lavender hover:text-app-text focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <Activity size={17} aria-hidden="true" />
        {activeCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold text-white"
          >
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            tabIndex={-1}
            aria-label="Close operations"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-app-text/40"
          />
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className={cn(
              "absolute inset-y-0 right-0 flex w-full max-w-md flex-col bg-app-surface shadow-apppanel",
            )}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-app-border px-4 py-3">
              <h2 id={titleId} className="text-[15px] font-bold text-app-text">
                Operations
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close operations"
                className="grid h-9 w-9 place-items-center rounded-control text-app-muted hover:bg-lavender hover:text-app-text focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <X size={17} aria-hidden="true" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <OperationCenter
                workspaceId={workspaceId}
                organizationId={organizationId}
                canWrite={canWrite}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
