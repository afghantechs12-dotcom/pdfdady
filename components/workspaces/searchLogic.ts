/**
 * Pure logic for the Workspace search UI.
 *
 * Extracted from the component so every reducer, validator and segmenter is
 * unit-testable in Node without a DOM. The domain's bounds are imported rather
 * than restated: a second copy of the rules here would eventually disagree with
 * the server, and the looser of the two would decide what the user may ask for.
 *
 * The highlight segmenter is the security-relevant piece. Snippets arrive as
 * plain text plus offset ranges, never as markup, so the client marks the ranges
 * with its own elements. Document text therefore cannot become document
 * structure, and no path here reaches an HTML sink.
 */

import {
  SEARCH_LIMITS,
  parseSearchQuery,
  type ChunkSourceType,
  type SnippetHighlight,
} from "@/src/domain/entities/SearchIndex";

export interface SearchSnippetView {
  text: string;
  highlights: SnippetHighlight[];
  pageNumber: number | null;
  sourceType: ChunkSourceType;
}

export interface SearchHitView {
  documentId: string;
  versionId: string | null;
  score: number;
  snippets: SearchSnippetView[];
  pageNumbers: number[];
  stale: boolean;
}

export interface SearchResultsView {
  query: string;
  truncated: boolean;
  hits: SearchHitView[];
  totalCount: number;
  nextCursor: string | null;
}

export interface SearchFilterState {
  favorite: boolean;
  lifecycleState: "" | "active" | "archived" | "trashed";
  projectId: string;
  folderId: string;
}

export function emptyFilters(): SearchFilterState {
  return { favorite: false, lifecycleState: "", projectId: "", folderId: "" };
}

/** Whether any filter is narrowing the search — drives the "clear" affordance. */
export function hasActiveFilters(filters: SearchFilterState): boolean {
  return (
    filters.favorite ||
    filters.lifecycleState !== "" ||
    filters.projectId.trim() !== "" ||
    filters.folderId.trim() !== ""
  );
}

/**
 * Serializes filters for the request body.
 *
 * Omitted rather than sent-as-empty: the API rejects unknown and malformed
 * fields, and an empty string is not the same request as "no filter" — it would
 * ask the server to match documents whose project id is literally "".
 */
export function serializeFilters(
  filters: SearchFilterState,
): Record<string, string | boolean> | undefined {
  const payload: Record<string, string | boolean> = {};
  if (filters.favorite) payload.favorite = true;
  if (filters.lifecycleState !== "") payload.lifecycleState = filters.lifecycleState;
  const projectId = filters.projectId.trim();
  const folderId = filters.folderId.trim();
  if (projectId) payload.projectId = projectId;
  if (folderId) payload.folderId = folderId;
  return Object.keys(payload).length === 0 ? undefined : payload;
}

/** Whether a query is worth sending, judged by the server's own parser. */
export function isSubmittableQuery(value: string): boolean {
  return parseSearchQuery(value) !== null;
}

/** The reason a query cannot be submitted, or null when it can. */
export function queryHint(value: string): string | null {
  if (value.trim() === "") return null;
  if (parseSearchQuery(value) !== null) return null;
  if ([...value.trim()].length > SEARCH_LIMITS.maxQueryLength) {
    return `Use at most ${SEARCH_LIMITS.maxQueryLength} characters.`;
  }
  return `Enter a term of at least ${SEARCH_LIMITS.minTermLength} letters or numbers.`;
}

export type SegmentKind = "text" | "mark";

export interface SnippetSegment {
  kind: SegmentKind;
  text: string;
}

/**
 * Splits snippet text into plain and highlighted segments.
 *
 * Every range is validated against the string it claims to index, and an
 * unusable range is dropped rather than clamped: a range that does not fit the
 * text is not a near-miss to be repaired but a signal that the offsets and the
 * text disagree, and silently shifting it would mark the wrong characters.
 *
 * Returns segments, never markup — the caller renders `mark` segments with real
 * elements, so no snippet can inject structure.
 */
export function segmentSnippet(
  text: string,
  highlights: readonly SnippetHighlight[] | undefined,
): SnippetSegment[] {
  if (typeof text !== "string" || text.length === 0) return [];
  if (!Array.isArray(highlights) || highlights.length === 0) {
    return [{ kind: "text", text }];
  }

  const valid = highlights
    .filter((range): range is SnippetHighlight => {
      if (!range || typeof range !== "object") return false;
      const { start, length } = range;
      return (
        Number.isInteger(start) &&
        Number.isInteger(length) &&
        start >= 0 &&
        length > 0 &&
        start + length <= text.length
      );
    })
    .slice()
    .sort((a, b) => a.start - b.start || a.length - b.length);

  const segments: SnippetSegment[] = [];
  let cursor = 0;
  let marked = 0;
  for (const range of valid) {
    // Overlaps are resolved by keeping the earlier range: double-marking the
    // same characters would nest elements and change what the text reads as.
    if (range.start < cursor) continue;
    if (marked >= SEARCH_LIMITS.maxHighlightsPerSnippet) break;
    if (range.start > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, range.start) });
    }
    segments.push({ kind: "mark", text: text.slice(range.start, range.start + range.length) });
    cursor = range.start + range.length;
    marked += 1;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}

export interface SearchState {
  status: "initial" | "loading" | "loaded" | "error";
  query: string;
  hits: SearchHitView[];
  totalCount: number;
  nextCursor: string | null;
  truncated: boolean;
  error: string | null;
  /** Monotonic id of the request whose result may still be applied. */
  requestId: number;
}

export function initialSearchState(): SearchState {
  return {
    status: "initial",
    query: "",
    hits: [],
    totalCount: 0,
    nextCursor: null,
    truncated: false,
    error: null,
    requestId: 0,
  };
}

export type SearchAction =
  | { type: "start"; query: string; requestId: number; append: boolean }
  | { type: "success"; requestId: number; results: SearchResultsView; append: boolean }
  | { type: "failure"; requestId: number; message: string }
  | { type: "reset" };

/**
 * The search reducer.
 *
 * Results carry the id of the request that asked for them and are discarded if a
 * newer request has since started. Without that, a slow first query landing
 * after a fast second one would overwrite correct results with stale ones — the
 * classic race that makes a search box show answers to a question the user has
 * already moved on from.
 */
export function searchReducer(state: SearchState, action: SearchAction): SearchState {
  switch (action.type) {
    case "start":
      return {
        ...state,
        status: "loading",
        query: action.query,
        error: null,
        requestId: action.requestId,
        // A new query abandons the old page; loading more keeps what is shown.
        ...(action.append ? {} : { hits: [], totalCount: 0, nextCursor: null }),
      };
    case "success": {
      if (action.requestId !== state.requestId) return state;
      const hits = action.append
        ? dedupeHits([...state.hits, ...action.results.hits])
        : dedupeHits(action.results.hits);
      return {
        ...state,
        status: "loaded",
        hits,
        totalCount: action.results.totalCount,
        nextCursor: action.results.nextCursor,
        truncated: action.results.truncated,
        error: null,
      };
    }
    case "failure":
      if (action.requestId !== state.requestId) return state;
      return { ...state, status: "error", error: action.message };
    case "reset":
      return { ...initialSearchState(), requestId: state.requestId };
    default:
      return state;
  }
}

/**
 * Keeps the first appearance of each document.
 *
 * A page boundary can re-deliver a document whose rank shifted between requests;
 * appending it twice would show the same file as two results.
 */
export function dedupeHits(hits: SearchHitView[]): SearchHitView[] {
  const seen = new Set<string>();
  const unique: SearchHitView[] = [];
  for (const hit of hits) {
    if (seen.has(hit.documentId)) continue;
    seen.add(hit.documentId);
    unique.push(hit);
  }
  return unique;
}

/** Whether the "no results" message should be shown. */
export function isEmptyResult(state: SearchState): boolean {
  return state.status === "loaded" && state.hits.length === 0;
}

/** Whether a "load more" control should be offered. */
export function canLoadMore(state: SearchState): boolean {
  return state.status === "loaded" && state.nextCursor !== null;
}

/** Whether a hit's index entry is behind the document it describes. */
export function isStale(hit: SearchHitView): boolean {
  return hit.stale === true;
}

export type ReindexPhase = "idle" | "pending" | "queued" | "failed";

/**
 * Reindex is a request, not a completion.
 *
 * The server queues the work and answers 202; claiming "reindexed" here would
 * assert something no response has established, so the settled state is
 * "queued".
 */
export function nextReindexPhase(current: ReindexPhase, event: "request" | "accepted" | "rejected"): ReindexPhase {
  if (event === "request") return "pending";
  if (event === "accepted") return "queued";
  return "failed";
}

export function reindexLabel(phase: ReindexPhase): string {
  switch (phase) {
    case "pending":
      return "Requesting reindex…";
    case "queued":
      return "Reindex queued";
    case "failed":
      return "Reindex failed";
    default:
      return "Reindex";
  }
}

/** Human label for the page a match was found on. */
export function pageLabel(pageNumber: number | null): string {
  if (pageNumber === null || !Number.isInteger(pageNumber) || pageNumber < 1) {
    return "Document";
  }
  return `Page ${pageNumber}`;
}

/** Summarizes which pages a hit matched on, bounded so the label stays readable. */
export function pagesLabel(pageNumbers: number[]): string {
  const valid = pageNumbers.filter((page) => Number.isInteger(page) && page >= 1);
  if (valid.length === 0) return "";
  if (valid.length === 1) return `Page ${valid[0]}`;
  const shown = valid.slice(0, 3).join(", ");
  return valid.length > 3 ? `Pages ${shown} +${valid.length - 3}` : `Pages ${shown}`;
}

/**
 * Whether a keyboard event should activate a result.
 *
 * Enter and Space both activate, matching what a button does — a result row is
 * operable without a pointer or it is not operable for everyone.
 */
export function isActivationKey(key: string): boolean {
  return key === "Enter" || key === " " || key === "Spacebar";
}
