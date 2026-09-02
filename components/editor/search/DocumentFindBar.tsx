"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CaseSensitive, ChevronDown, ChevronUp, WholeWord, X } from "lucide-react";
import { useEditorContext } from "@/components/editor/EditorContext";
import {
  describeScope,
  searchDocument,
  stepMatch,
  type SearchMatch,
} from "@/components/editor/search/documentSearch";

/**
 * The in-document find bar (Ctrl+F).
 *
 * Searches the OPEN document through `searchDocument` — the editor's own object
 * model, including imported PDF text. It deliberately does NOT call
 * `/api/workspaces/{id}/search`: that endpoint finds OTHER documents, and wiring
 * it to Ctrl+F would answer "is this word in my document?" with results from
 * files the user is not looking at.
 *
 * Selecting a result navigates to its page and selects the text object, reusing
 * the editor's existing selection/page actions rather than inventing a second
 * highlight mechanism the canvas would have to learn.
 */
export interface DocumentFindBarProps {
  open: boolean;
  onClose: () => void;
  /** Jumps the canvas to a 1-based page. */
  onGoToPage: (pageNumber: number) => void;
}

export function DocumentFindBar({ open, onClose, onGoToPage }: DocumentFindBarProps) {
  const { state, actions } = useEditorContext();
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Recomputed from the live document, so an edit that changes text updates the
  // result set instead of leaving stale offsets that would select the wrong run.
  const { matches, scope } = useMemo(
    () => searchDocument(state.document, query, { caseSensitive, wholeWord }),
    [state.document, query, caseSensitive, wholeWord],
  );

  // Clamp rather than reset: shrinking results should keep the user near where
  // they were, not throw them back to the first hit on every keystroke.
  useEffect(() => {
    setActive((i) => (matches.length === 0 ? 0 : Math.min(i, matches.length - 1)));
  }, [matches.length]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [open]);

  const goTo = (index: number) => {
    const match = matches[index];
    if (!match) return;
    setActive(index);
    onGoToPage(match.pageNumber);
    // Selecting the object is how the canvas reveals a hit — the editor already
    // scrolls to and outlines a selection, so search does not need its own
    // highlight layer that could disagree with it.
    actions.select(match.objectId);
  };

  const step = (delta: number) => {
    if (matches.length === 0) return;
    goTo(stepMatch(active, matches.length, delta));
  };

  if (!open) return null;

  const scopeNote = describeScope(scope);
  const hasQuery = query.trim() !== "";

  return (
    <div
      role="search"
      aria-label="Find in document"
      className="absolute right-4 top-3 z-40 w-[min(26rem,calc(100%-2rem))] rounded-appcard border border-editor-border bg-editor-surface/98 p-2 shadow-appmenu backdrop-blur"
    >
      <div className="flex items-center gap-1.5">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              step(e.shiftKey ? -1 : 1);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder="Search in document"
          aria-label="Search in document"
          className="min-w-0 flex-1 rounded-control border border-editor-border bg-white px-2.5 py-1.5 text-[13px] text-editor-text placeholder:text-editor-muted focus:border-editor-accent focus:outline-none focus:ring-2 focus:ring-editor-accent/20"
        />

        {/* Match count. `role="status"` so it is announced without moving focus. */}
        <span
          role="status"
          className="shrink-0 px-1 text-[12px] tabular-nums text-editor-muted"
        >
          {hasQuery ? (matches.length === 0 ? "0" : `${active + 1}/${matches.length}`) : ""}
          {scope.truncated ? "+" : ""}
        </span>

        <ToggleButton
          label="Match case"
          active={caseSensitive}
          onClick={() => setCaseSensitive((v) => !v)}
        >
          <CaseSensitive className="h-4 w-4" aria-hidden="true" />
        </ToggleButton>
        <ToggleButton
          label="Match whole word"
          active={wholeWord}
          onClick={() => setWholeWord((v) => !v)}
        >
          <WholeWord className="h-4 w-4" aria-hidden="true" />
        </ToggleButton>

        <IconButton label="Previous match" onClick={() => step(-1)} disabled={matches.length === 0}>
          <ChevronUp className="h-4 w-4" aria-hidden="true" />
        </IconButton>
        <IconButton label="Next match" onClick={() => step(1)} disabled={matches.length === 0}>
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
        </IconButton>
        <IconButton label="Close find bar" onClick={onClose}>
          <X className="h-4 w-4" aria-hidden="true" />
        </IconButton>
      </div>

      {/*
        Honest empty/scope messaging. "No results" alone is ambiguous on a scanned
        PDF — the truthful answer is that there is no searchable text at all, and
        that text inside images cannot be read (there is no OCR in this codebase).
      */}
      {scopeNote ? (
        <p className="mt-1.5 px-1 text-[11px] leading-relaxed text-editor-muted">{scopeNote}</p>
      ) : null}
      {hasQuery && matches.length === 0 && !scopeNote ? (
        <p className="mt-1.5 px-1 text-[11px] text-editor-muted">
          No matches in this document.
        </p>
      ) : null}
      {scope.truncated ? (
        <p className="mt-1.5 px-1 text-[11px] text-editor-muted">
          Showing the first {matches.length} matches. Narrow the search to see the rest.
        </p>
      ) : null}

      {matches.length > 0 ? (
        <ul className="mt-1.5 max-h-56 overflow-y-auto" aria-label="Search results">
          {matches.map((match, index) => (
            <li key={`${match.objectId}:${match.start}`}>
              <button
                type="button"
                onClick={() => goTo(index)}
                aria-current={index === active}
                className={`flex w-full items-start gap-2 rounded-control px-2 py-1.5 text-left text-[12px] transition-colors ${
                  index === active
                    ? "bg-editor-accentsoft text-editor-text"
                    : "text-editor-muted hover:bg-editor-subtle"
                }`}
              >
                <span className="mt-px shrink-0 tabular-nums text-[11px] text-editor-muted">
                  p{match.pageNumber}
                </span>
                <span className="min-w-0 flex-1">
                  <Snippet match={match} />
                </span>
                {match.readonlySource ? (
                  <span
                    title="Original PDF text — searchable, but not editable"
                    className="mt-px shrink-0 rounded-full bg-editor-subtle px-1.5 text-[10px] font-semibold text-editor-muted"
                  >
                    PDF
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Renders a snippet with the matched span emphasised. */
function Snippet({ match }: { match: SearchMatch }) {
  const before = match.snippet.slice(0, match.snippetStart);
  const hit = match.snippet.slice(match.snippetStart, match.snippetStart + match.text.length);
  const after = match.snippet.slice(match.snippetStart + match.text.length);
  return (
    <span className="block truncate">
      {before}
      <mark className="rounded bg-amber-200/70 px-0.5 text-editor-text">{hit}</mark>
      {after}
    </span>
  );
}

function ToggleButton({
  children,
  label,
  active,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-control transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent ${
        active
          ? "bg-editor-accentsoft text-editor-accent ring-1 ring-inset ring-editor-accent/25"
          : "text-editor-muted hover:bg-editor-subtle hover:text-editor-text"
      }`}
    >
      {children}
    </button>
  );
}

function IconButton({
  children,
  label,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      disabled={disabled}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-editor-muted transition-colors hover:bg-editor-subtle hover:text-editor-text focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent ${
        disabled ? "cursor-not-allowed opacity-30" : ""
      }`}
    >
      {children}
    </button>
  );
}
