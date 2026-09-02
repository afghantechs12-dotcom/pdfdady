"use client";

import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import { AlertCircle, FileText, Loader2, RefreshCw, Search, Star, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  canLoadMore,
  emptyFilters,
  hasActiveFilters,
  initialSearchState,
  isActivationKey,
  isEmptyResult,
  isSubmittableQuery,
  nextReindexPhase,
  pageLabel,
  pagesLabel,
  queryHint,
  reindexLabel,
  searchReducer,
  segmentSnippet,
  serializeFilters,
  type ReindexPhase,
  type SearchFilterState,
  type SearchHitView,
  type SearchSnippetView,
} from "./searchLogic";
import { SEARCH_LIMITS } from "@/src/domain/entities/SearchIndex";

export interface SearchPanelProps {
  workspaceId: string;
  organizationId: string;
  /** Document names by id, so a result can be named without a second lookup. */
  documentNames?: Record<string, string>;
  /** Whether the actor may request a reindex; the server re-checks regardless. */
  canReindex?: boolean;
  /** Opens a result. Receives the page the match was found on when there is one. */
  onOpenDocument?: (documentId: string, pageNumber: number | null) => void;
}

/** How long typing settles before a search is issued. */
const DEBOUNCE_MS = 300;

/**
 * Renders one snippet as text and `mark` elements.
 *
 * The snippet arrives as plain text plus offset ranges, and the ranges are
 * validated against the text before anything is rendered. Nothing here touches
 * `dangerouslySetInnerHTML`: every segment becomes a React text node, so a
 * document containing `<script>` displays those characters instead of running.
 */
function Snippet({ snippet }: { snippet: SearchSnippetView }) {
  const segments = useMemo(
    () => segmentSnippet(snippet.text, snippet.highlights),
    [snippet.text, snippet.highlights],
  );
  return (
    <p className="text-sm leading-relaxed text-slate-600">
      {segments.map((segment, index) =>
        segment.kind === "mark" ? (
          <mark key={index} className="rounded bg-amber-100 px-0.5 text-navy">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </p>
  );
}

/**
 * Workspace search.
 *
 * Every request is authorized server-side; this component never assumes a result
 * it has not been given. Typing is debounced and each response carries the id of
 * the request that asked for it, so a slow earlier query cannot overwrite a
 * later one — and the in-flight request is aborted when a new one starts.
 */
export function SearchPanel({
  workspaceId,
  organizationId,
  documentNames = {},
  canReindex = false,
  onOpenDocument,
}: SearchPanelProps) {
  const [state, dispatch] = useReducer(searchReducer, initialSearchState());
  const [term, setTerm] = useState("");
  const [filters, setFilters] = useState<SearchFilterState>(emptyFilters());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [reindexing, setReindexing] = useState<Record<string, ReindexPhase>>({});

  const inputId = useId();
  const hintId = useId();
  const statusId = useId();

  // Monotonic request id and the live controller: the id decides which response
  // may be applied, the controller stops the superseded one from finishing at all.
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const runSearch = useCallback(
    async (query: string, cursor: string | null) => {
      if (!isSubmittableQuery(query)) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      requestIdRef.current += 1;
      const requestId = requestIdRef.current;
      const append = cursor !== null;
      dispatch({ type: "start", query, requestId, append });

      try {
        const response = await fetch(`/api/workspaces/${workspaceId}/search`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            organizationId,
            query,
            limit: SEARCH_LIMITS.defaultResultLimit,
            ...(cursor === null ? {} : { cursor }),
            ...(serializeFilters(filters) === undefined
              ? {}
              : { filters: serializeFilters(filters) }),
          }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body?.error?.message ?? "Search failed.");
        }
        const results = await response.json();
        dispatch({ type: "success", requestId, results, append });
      } catch (error) {
        // An aborted request was replaced on purpose; reporting it as a failure
        // would show an error for something the user did not do wrong.
        if (error instanceof DOMException && error.name === "AbortError") return;
        dispatch({
          type: "failure",
          requestId,
          message: error instanceof Error ? error.message : "Search failed.",
        });
      }
    },
    [workspaceId, organizationId, filters],
  );

  // Debounced search on typing. Filters are a dependency because changing one
  // re-asks the same question of a different set.
  useEffect(() => {
    if (!isSubmittableQuery(term)) {
      if (term.trim() === "") dispatch({ type: "reset" });
      return;
    }
    const timer = setTimeout(() => {
      void runSearch(term, null);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [term, runSearch]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function requestReindex(documentId: string) {
    setReindexing((prev) => ({ ...prev, [documentId]: nextReindexPhase("idle", "request") }));
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/documents/${documentId}/search-index/reindex`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ organizationId }),
        },
      );
      if (!response.ok) throw new Error("Reindex request failed.");
      setReindexing((prev) => ({ ...prev, [documentId]: nextReindexPhase("pending", "accepted") }));
    } catch {
      setReindexing((prev) => ({ ...prev, [documentId]: nextReindexPhase("pending", "rejected") }));
    }
  }

  function activate(hit: SearchHitView) {
    onOpenDocument?.(hit.documentId, hit.pageNumbers[0] ?? null);
  }

  const hint = queryHint(term);
  const showEmpty = isEmptyResult(state);

  return (
    <section aria-labelledby={`${inputId}-title`} className="flex flex-col gap-4">
      <h2 id={`${inputId}-title`} className="text-lg font-semibold text-navy">
        Search documents
      </h2>

      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch(term, null);
        }}
        className="flex flex-col gap-3 sm:flex-row sm:items-start"
      >
        <div className="flex-1">
          <label htmlFor={inputId} className="sr-only">
            Search document contents
          </label>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
            />
            <input
              id={inputId}
              type="search"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              maxLength={SEARCH_LIMITS.maxQueryLength}
              placeholder="Search inside documents…"
              aria-describedby={hint ? hintId : undefined}
              aria-invalid={hint ? true : undefined}
              className="h-11 w-full rounded-button border border-softborder pl-9 pr-3 text-sm text-navy focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            />
          </div>
          {hint ? (
            <p id={hintId} className="mt-1 text-xs text-slate-500">
              {hint}
            </p>
          ) : null}
        </div>

        <div className="flex gap-2">
          <Button type="submit" size="md" disabled={!isSubmittableQuery(term)}>
            Search
          </Button>
          <Button
            type="button"
            variant="outline"
            size="md"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            Filters
          </Button>
        </div>
      </form>

      {/* Collapsed by default on narrow screens so results stay above the fold. */}
      <fieldset
        className={`${filtersOpen ? "grid" : "hidden"} gap-3 rounded-card border border-softborder p-3 sm:grid sm:grid-cols-2 lg:grid-cols-4`}
      >
        <legend className="px-1 text-xs font-medium uppercase tracking-wide text-slate-500">
          Filters
        </legend>

        <label className="flex items-center gap-2 text-sm text-navy">
          <input
            type="checkbox"
            checked={filters.favorite}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, favorite: event.target.checked }))
            }
            className="h-4 w-4 rounded border-softborder text-primary focus-visible:ring-2 focus-visible:ring-primary/40"
          />
          <Star aria-hidden="true" className="h-4 w-4 text-amber-500" />
          Favorites only
        </label>

        <label className="flex flex-col gap-1 text-sm text-navy">
          Lifecycle
          <select
            value={filters.lifecycleState}
            onChange={(event) =>
              setFilters((prev) => ({
                ...prev,
                lifecycleState: event.target.value as SearchFilterState["lifecycleState"],
              }))
            }
            className="h-9 rounded-button border border-softborder px-2 text-sm focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <option value="">Active (default)</option>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="trashed">Trashed</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm text-navy">
          Project
          <input
            type="text"
            value={filters.projectId}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, projectId: event.target.value }))
            }
            maxLength={SEARCH_LIMITS.maxIdLength}
            placeholder="Any project"
            className="h-9 rounded-button border border-softborder px-2 text-sm focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm text-navy">
          Folder
          <input
            type="text"
            value={filters.folderId}
            onChange={(event) => setFilters((prev) => ({ ...prev, folderId: event.target.value }))}
            maxLength={SEARCH_LIMITS.maxIdLength}
            placeholder="Any folder"
            className="h-9 rounded-button border border-softborder px-2 text-sm focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          />
        </label>

        {hasActiveFilters(filters) ? (
          <div className="lg:col-span-4">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              leadingIcon={<X aria-hidden="true" className="h-4 w-4" />}
              onClick={() => setFilters(emptyFilters())}
            >
              Clear filters
            </Button>
          </div>
        ) : null}
      </fieldset>

      {/* Announces result counts and state changes to assistive technology. */}
      <p id={statusId} role="status" aria-live="polite" className="text-sm text-slate-600">
        {state.status === "loading"
          ? "Searching…"
          : state.status === "loaded"
            ? `${state.totalCount} ${state.totalCount === 1 ? "result" : "results"}`
            : ""}
      </p>

      {state.truncated ? (
        <p className="text-xs text-slate-500">
          Only the first {SEARCH_LIMITS.maxQueryTerms} terms of this query were used.
        </p>
      ) : null}

      {state.status === "error" ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-card border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{state.error}</span>
        </div>
      ) : null}

      {state.status === "initial" ? (
        <p className="text-sm text-slate-500">
          Search the text inside this workspace&apos;s documents.
        </p>
      ) : null}

      {state.status === "loading" && state.hits.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
          Searching…
        </p>
      ) : null}

      {showEmpty ? (
        <p className="text-sm text-slate-500">
          No documents match “{state.query}”. Indexing may still be in progress.
        </p>
      ) : null}

      {state.hits.length > 0 ? (
        <ul className="flex flex-col gap-3" aria-label="Search results">
          {state.hits.map((hit) => {
            const phase = reindexing[hit.documentId] ?? "idle";
            const name = documentNames[hit.documentId] ?? hit.documentId;
            return (
              <li
                key={hit.documentId}
                className="rounded-card border border-softborder bg-white p-4 transition hover:border-primary"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  {/* A real button, so Enter, Space and focus behave natively. */}
                  <button
                    type="button"
                    onClick={() => activate(hit)}
                    onKeyDown={(event) => {
                      if (!isActivationKey(event.key)) return;
                      event.preventDefault();
                      activate(hit);
                    }}
                    className="flex items-center gap-2 rounded text-left text-sm font-semibold text-navy hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    <FileText aria-hidden="true" className="h-4 w-4 text-slate-400" />
                    {name}
                  </button>

                  <div className="flex flex-wrap items-center gap-2">
                    {hit.versionId ? (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                        Version {hit.versionId.slice(0, 8)}
                      </span>
                    ) : null}
                    {hit.stale ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                        Index out of date
                      </span>
                    ) : null}
                    {canReindex ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={phase === "pending"}
                        leadingIcon={
                          <RefreshCw
                            aria-hidden="true"
                            className={`h-3.5 w-3.5 ${phase === "pending" ? "animate-spin" : ""}`}
                          />
                        }
                        onClick={() => void requestReindex(hit.documentId)}
                      >
                        {reindexLabel(phase)}
                      </Button>
                    ) : null}
                  </div>
                </div>

                {hit.pageNumbers.length > 0 ? (
                  <p className="mt-1 text-xs text-slate-500">{pagesLabel(hit.pageNumbers)}</p>
                ) : null}

                <div className="mt-2 flex flex-col gap-2">
                  {hit.snippets.map((snippet, index) => (
                    <div key={index}>
                      <p className="text-xs uppercase tracking-wide text-slate-400">
                        {pageLabel(snippet.pageNumber)} · {snippet.sourceType}
                      </p>
                      <Snippet snippet={snippet} />
                    </div>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {canLoadMore(state) ? (
        <div>
          <Button
            type="button"
            variant="outline"
            size="md"
            loading={state.status === "loading"}
            onClick={() => void runSearch(state.query, state.nextCursor)}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </section>
  );
}
