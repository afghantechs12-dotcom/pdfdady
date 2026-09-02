"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  Cloud,
  CloudAlert,
  CloudOff,
  HardDrive,
  History,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { saveStatusTriggerName } from "@/components/editor/persistence/editorPersistenceWiring";
import type {
  SaveStatusBreakdown,
  SaveStatusIcon,
  SaveStatusTone,
  SaveStatusView,
} from "@/src/application/editor/persistence/derivedStatus";
import { formatAbsolute } from "@/src/application/editor/persistence/recoveryPrompt";
import type { PersistenceLimitation } from "@/src/infrastructure/persistence/browser/createPersistenceRuntime";

/**
 * The save-status readout: the one place the editor tells the user where their work
 * is.
 *
 * It computes nothing. Every word comes from `deriveSaveStatus`, which is the single
 * place four independent state dimensions become one sentence, and which is unit
 * tested against every combination. A component that decided its own wording would
 * be a second opinion on the most consequential sentence in the product — and the
 * one that cannot be tested here, because this suite has no DOM.
 *
 * Two things it does decide, both about accessibility:
 *
 *  - THE LIVE REGION IS CONDITIONAL. `unsaved` changes on every keystroke, and a
 *    live region carrying it would narrate the entire document as it is typed. Only
 *    a status the policy marked `announce` is placed in the region, which is why
 *    arrivals and failures are heard and ordinary editing is not.
 *
 *  - THE ICON IS A SHAPE, NOT A COLOUR. Nine states, nine distinct glyphs, so the
 *    tone classes are reinforcement rather than the carrier. A user who cannot tell
 *    the amber ring from the green one still gets the label and the glyph.
 */

/**
 * Exported because the app bar's pill renders the SAME status and must not invent a
 * second glyph or a second palette for it. One state, one shape, one colour,
 * wherever it is shown.
 */
export const SAVE_STATUS_ICONS: Record<SaveStatusIcon, typeof Check> = {
  check: Check,
  // lucide has no cloud-with-tick; a plain cloud beside the "Saved" label carries
  // "it is in the workspace", and the label is what states the claim.
  "cloud-check": Cloud,
  "cloud-off": CloudOff,
  "cloud-alert": CloudAlert,
  "device-check": HardDrive,
  spinner: Loader2,
  alert: CircleAlert,
  warning: TriangleAlert,
  history: History,
};

export const SAVE_STATUS_TONE_TEXT: Record<SaveStatusTone, string> = {
  neutral: "text-editor-muted",
  progress: "text-editor-muted",
  success: "text-emerald-700",
  warning: "text-amber-700",
  danger: "text-red-700",
};

const TONE_RING: Record<SaveStatusTone, string> = {
  neutral: "focus-visible:ring-editor-accent",
  progress: "focus-visible:ring-editor-accent",
  success: "focus-visible:ring-emerald-500",
  warning: "focus-visible:ring-amber-500",
  danger: "focus-visible:ring-red-500",
};

export interface SaveStatusIndicatorProps {
  status: SaveStatusView;
  breakdown: SaveStatusBreakdown;
  /**
   * The capabilities this browser context does not have. Shown here rather than as
   * banners: someone opening this popover is already asking "is my work safe?", and
   * four stacked alerts over an editor teach a user to dismiss alerts.
   */
  limitations: readonly PersistenceLimitation[];
  /** The extra sentence a guest document needs when its identity could not be stored. */
  identityNotice?: string | null;
  onRetry: (channel: "local" | "remote") => void;
  /** Opens the conflict dialog. Present only while a conflict is standing. */
  onResolve?: () => void;
  /** Flushes now. The button is offered whenever there is anything to flush. */
  onSaveNow?: () => void;
  /** Narrow presentation: the short label, with the full sentence still in the title. */
  compact?: boolean;
}

export function SaveStatusIndicator({
  status,
  breakdown,
  limitations,
  identityNotice = null,
  onRetry,
  onResolve,
  onSaveNow,
  compact = false,
}: SaveStatusIndicatorProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const containerRef = useRef<HTMLDivElement>(null);

  // Dismissal that does not trap the user: Escape and an outside click both close,
  // because this is a disclosure over a canvas the user needs to keep using.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const Icon = SAVE_STATUS_ICONS[status.icon];
  const secondary = limitations;
  const visible = compact ? status.short : status.label;

  return (
    <div ref={containerRef} className="relative flex items-center gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((was) => !was)}
        title={status.detail}
        className={`flex min-h-6 items-center gap-1.5 rounded px-1.5 outline-none hover:bg-editor-subtle focus-visible:ring-2 ${TONE_RING[status.tone]} ${SAVE_STATUS_TONE_TEXT[status.tone]}`}
      >
        <Icon
          className={`h-3.5 w-3.5 shrink-0 ${status.icon === "spinner" ? "animate-spin" : ""}`}
          aria-hidden="true"
        />
        <span aria-hidden="true" className="whitespace-nowrap">
          {visible}
        </span>
        {/*
          The name, composed in `saveStatusTriggerName` where a test can run it —
          `compact` renders `status.short`, and `idle`'s is a bare em-dash, so this
          control's whole accessible name used to be "—". The visible span is hidden
          from the name only because the helper already includes it verbatim, which
          is what keeps the visible words inside the name (WCAG 2.5.3).
        */}
        <span className="sr-only">{saveStatusTriggerName(status, compact)}</span>
      </button>

      {status.retry !== null ? (
        <button
          type="button"
          onClick={() => onRetry(status.retry as "local" | "remote")}
          className="inline-flex min-h-6 items-center rounded px-1.5 font-semibold underline outline-none hover:bg-editor-subtle focus-visible:ring-2 focus-visible:ring-editor-accent"
        >
          Retry
        </button>
      ) : null}

      {status.needsResolution && onResolve ? (
        <button
          type="button"
          onClick={onResolve}
          className="inline-flex min-h-6 items-center rounded px-1.5 font-semibold text-red-700 underline outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-500"
        >
          Resolve
        </button>
      ) : null}

      {/*
        The conditional live region. Only statuses the policy marked `announce` are
        placed here — `unsaved` moves on every keystroke and would otherwise make the
        editor unusable with a screen reader.
      */}
      <div className="sr-only" role="status" aria-live="polite">
        {status.announce ? status.detail : ""}
      </div>

      {open ? (
        <div
          id={panelId}
          className="absolute bottom-full right-0 z-30 mb-2 w-80 rounded-md border border-editor-border bg-editor-surface p-3 text-xs shadow-lg"
        >
          <p className="font-semibold text-editor-text">{status.label}</p>
          <p className="mt-1 text-editor-muted">{status.detail}</p>

          <dl className="mt-3 space-y-1.5">
            <Line label="On this device" value={breakdown.local} at={breakdown.lastLocalSaveAt} />
            <Line label="In the workspace" value={breakdown.remote} at={breakdown.lastRemoteSaveAt} />
            {breakdown.recovery !== null ? (
              <Line label="Recovery" value={breakdown.recovery} at={null} />
            ) : null}
          </dl>

          {identityNotice !== null ? (
            <p className="mt-3 rounded border border-amber-200 bg-amber-50 p-2 text-amber-800">
              {identityNotice}
            </p>
          ) : null}

          {secondary.length > 0 ? (
            <ul className="mt-3 space-y-1.5 border-t border-editor-border pt-2">
              {secondary.map((limitation) => (
                <li key={limitation.code} className="flex gap-1.5 text-amber-800">
                  <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                  <span>{limitation.message}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {onSaveNow ? (
            <button
              type="button"
              onClick={() => {
                onSaveNow();
                setOpen(false);
              }}
              className="mt-3 w-full rounded border border-editor-border px-2 py-1 font-semibold outline-none hover:bg-editor-subtle focus-visible:ring-2 focus-visible:ring-editor-accent"
            >
              Save to this device now
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One dimension, stated on its own terms, with its own timestamp when it has one. */
function Line({ label, value, at }: { label: string; value: string; at: number | null }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[11px] uppercase tracking-wide text-editor-muted">{label}</dt>
      <dd className="text-editor-text">
        {value}
        {at !== null ? <span className="text-editor-muted"> · {formatAbsolute(at)}</span> : null}
      </dd>
    </div>
  );
}
