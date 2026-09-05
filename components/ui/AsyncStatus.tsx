"use client";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

export type AsyncPhase = "idle" | "pending" | "success" | "empty" | "error" | "retrying" | "cancelled";
export interface RealProgress { completed: number; total: number; unit: "bytes" | "pages" | "jobs" }

export function validProgress(progress?: RealProgress): RealProgress | null {
  return progress && Number.isFinite(progress.completed) && Number.isFinite(progress.total) &&
    progress.total > 0 && progress.completed >= 0 && progress.completed <= progress.total ? progress : null;
}

/** Text feedback is immediate. Only the decorative busy icon has a reveal delay. */
export function PendingMark() {
  const [visible, setVisible] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setVisible(true), 150); return () => clearTimeout(timer); }, []);
  return <span className="inline-flex h-4 w-4 shrink-0" aria-hidden="true">
    {visible && <Loader2 size={16} className="animate-spin motion-reduce:animate-none" />}
  </span>;
}

/** The owner supplies a known phase and optional real work units, never a timer %. */
export function AsyncStatus({ phase, message, fileName, progress, children }: {
  phase: AsyncPhase; message: string; fileName?: string; progress?: RealProgress; children?: React.ReactNode;
}) {
  const busy = phase === "pending" || phase === "retrying";
  const measured = validProgress(progress);
  return <div data-async-state={phase} aria-busy={busy || undefined} className="space-y-2 text-sm">
    {fileName && <p className="break-words font-semibold">{fileName}</p>}
    <p role="status" aria-live="polite" aria-atomic="true" className="flex items-center gap-2">
      {busy && <PendingMark />}{message}
    </p>
    {busy && measured && <progress aria-label={message} className="h-2 w-full accent-primary" value={measured.completed} max={measured.total} />}
    {children}
  </div>;
}
