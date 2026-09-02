"use client";

import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import {
  MAX_DOCUMENT_NAME,
  sanitizeDocumentName,
  shouldCommitRename,
} from "@/components/editor/appBarLogic";
import {
  SAVE_STATUS_ICONS,
  SAVE_STATUS_TONE_TEXT,
} from "@/components/editor/persistence/SaveStatusIndicator";
import type {
  SaveStatusTone,
  SaveStatusView,
} from "@/src/application/editor/persistence/derivedStatus";

/**
 * The app bar's document identity block: the filename, an inline rename, and the
 * save pill.
 *
 * Split out of `StandaloneEditorShell` because it owns real interaction (an
 * inline edit with commit/cancel semantics and focus management) that the shell's
 * markup should not be carrying, and because both editor surfaces want it.
 *
 * The save pill here renders the canonical {@link SaveStatusView} and nothing else.
 * It used to render a second model of its own (`appBarLogic.saveIndicator`, keyed on
 * the last EXPORT), which is how the app bar came to say "Unsaved changes" beside a
 * status bar saying "Saved on this device": two models, two answers, both on screen.
 * There is now one, computed in `deriveSaveStatus`, and this component decides only
 * how much of it fits at this width.
 */

/**
 * The pill's fill. The text colour and the glyph come from the status readout's own
 * maps, so a state cannot be emerald here and amber there.
 */
const TONE_PILL: Record<SaveStatusTone, string> = {
  neutral: "bg-editor-subtle",
  progress: "bg-editor-subtle",
  success: "bg-emerald-50",
  warning: "bg-amber-50",
  danger: "bg-red-50",
};
export interface DocumentIdentityProps {
  /** The current document name (the export filename stem). */
  name: string;
  /**
   * Commits a rename. Receives the already-sanitised name; omit to render the
   * title as static text (no rename affordance at all, rather than one that
   * silently does nothing).
   */
  onRename?: (name: string) => void;
  /**
   * The canonical save status. Null only before the editor has a persistence view
   * at all (server render, or persistence disabled), when the honest thing to show
   * is nothing rather than a guess.
   */
  status: SaveStatusView | null;
  /** Appended after the title when the editor has no document yet. */
  hint?: string;
}

export function DocumentIdentity({ name, onRename, status, hint }: DocumentIdentityProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // A rename elsewhere (or opening a different file) must win over a stale
  // draft, otherwise the field would keep showing a name the document no longer
  // has. Only synced while NOT editing so it cannot yank text out from under a
  // user mid-type.
  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    if (shouldCommitRename(name, draft)) {
      // `shouldCommitRename` already proved this is non-null.
      onRename?.(sanitizeDocumentName(draft) as string);
    }
    setEditing(false);
    // Focus returns to the trigger, not to the void: an inline edit that ends
    // with focus on <body> loses a keyboard user's place entirely.
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const cancel = () => {
    setDraft(name);
    setEditing(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <div className="flex min-w-0 items-center justify-center gap-2">
      {editing && onRename ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          maxLength={MAX_DOCUMENT_NAME}
          aria-label="Document name"
          // `h-8` matches the rename trigger it replaces, so entering and leaving
          // the edit does not change the app bar's height under the pointer.
          className="h-8 min-w-0 max-w-[min(46vw,20rem)] rounded-control border border-editor-accent/40 bg-white px-2 text-[15px] font-semibold text-editor-text shadow-[0_0_0_3px_rgba(124,58,237,0.10)] focus:outline-none"
        />
      ) : (
        <h1 className="flex min-w-0 items-center gap-1.5">
          {onRename ? (
            <button
              ref={triggerRef}
              type="button"
              onClick={() => setEditing(true)}
              // The full name in the tooltip, because the visible one truncates:
              // a truncated title with no way to read it in full is a dead end
              // for exactly the long filenames that need one.
              title={`${name} — click to rename`}
              /*
               * 15px semibold (P1 Phase A2). It was 13px, the same size as the
               * toolbar's tool labels, which left the app bar with no typographic
               * hierarchy at all: the document's NAME is the most important string
               * on screen and read as chrome.
               *
               * `h-8` is the app bar's shared control height (P2). The bar shipped
               * with four different ones — 26px logo, 32px links, 34px buttons,
               * 28px avatar — which is what made a dense application bar read as a
               * marketing navbar.
               */
              className="group flex h-8 min-w-0 items-center gap-1.5 rounded-control px-1.5 text-[15px] font-semibold tracking-[-0.01em] text-editor-text transition-colors hover:bg-editor-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/50"
            >
              <span className="truncate">{name}</span>
              <Pencil
                size={14}
                aria-hidden="true"
                className="shrink-0 text-editor-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
              />
              <span className="sr-only">Rename document</span>
            </button>
          ) : (
            <span
              title={name}
              className="truncate px-1.5 text-[15px] font-semibold tracking-[-0.01em] text-editor-text"
            >
              {name}
            </span>
          )}
          {hint ? <span className="shrink-0 text-[13px] font-normal text-editor-muted">{hint}</span> : null}
        </h1>
      )}

      {/* The save pill.

          VISIBLE AT EVERY WIDTH. This was `hidden … md:inline-flex`, so under
          768px the app bar said nothing about whether the work was safe — and
          "Save failed" disappeared along with the rest. The short form is what
          made hiding it unnecessary: `status.short` below `sm`, the full label
          above it.

          NO LIVE REGION HERE. The status readout in the editor's status bar owns
          the one conditional `role="status"` region for this status (only states
          the policy marks `announce` are placed in it); a second region carrying
          the same words would announce `unsaved` on every keystroke and say
          everything twice. The pill is reachable by title and by SR text. */}
      {status !== null ? (
        <SavePill status={status} />
      ) : null}
    </div>
  );
}

/**
 * The pill. Its own component only so the `status` narrowing above stays one line;
 * it holds no state and decides nothing but the breakpoint.
 */
function SavePill({ status }: { status: SaveStatusView }) {
  const Icon = SAVE_STATUS_ICONS[status.icon];
  return (
    <span
      title={status.detail}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE_PILL[status.tone]} ${SAVE_STATUS_TONE_TEXT[status.tone]}`}
    >
      <Icon
        size={11}
        className={`shrink-0 ${status.icon === "spinner" ? "animate-spin" : ""}`}
        aria-hidden="true"
      />
      {/* One of the two renders at any width, never both and never neither, so
          the pill is never an unexplained coloured blob. */}
      <span className="whitespace-nowrap sm:hidden">{status.short}</span>
      <span className="hidden whitespace-nowrap sm:inline">{status.label}</span>
      <span className="sr-only"> — {status.detail}</span>
    </span>
  );
}
