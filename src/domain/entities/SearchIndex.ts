/**
 * M7.8 search domain types.
 *
 * A SearchDocument is the index entry for one Document at one Version; the
 * SearchChunks beneath it are the bounded, page-aware units that snippets and
 * highlights are derived from. Chunking rather than one blob per document is
 * what makes a snippet able to say *where* a match is, and what lets a reindex
 * replace content incrementally instead of rewriting everything (ADR-M7-008).
 *
 * Authorization is not represented here on purpose. Eligibility is decided
 * against real DocumentRecords before any chunk is consulted, so no count,
 * snippet, facet or existence signal can be derived from index rows alone.
 */

export const SEARCH_LIMITS = {
  /** Current index schema version. A row written under another is stale, not wrong. */
  schemaVersion: 1,
  /** Longest accepted raw query string, in code points. */
  maxQueryLength: 256,
  /** Most terms one query may carry after tokenization. */
  maxQueryTerms: 16,
  /** Shortest term that participates in matching. */
  minTermLength: 2,
  /** Longest accepted single term. */
  maxTermLength: 64,
  /** Longest text one chunk may hold, in code points. */
  maxChunkTextLength: 2000,
  /** Most chunks one document may be split into. */
  maxChunksPerDocument: 1000,
  /** Most results a single query may return. */
  maxResults: 100,
  /** Default page size when a caller does not ask for one. */
  defaultResultLimit: 20,
  /** Most documents one eligibility sweep will consider. */
  maxCandidateDocuments: 1000,
  /** Longest accepted identifier in any predicate. */
  maxIdLength: 128,
  /** Longest snippet returned for a match, in code points. */
  maxSnippetLength: 240,
  /** Most highlight ranges reported per snippet. */
  maxHighlightsPerSnippet: 8,
  /** Most snippets returned per result. */
  maxSnippetsPerResult: 3,
  /** Longest accepted checksum. */
  maxChecksumLength: 128,
  /** Longest accepted indexing error message retained on a row. */
  maxErrorLength: 500,
} as const;

/** Where a chunk's text came from. Unknown sources are rejected, never stored. */
export const CHUNK_SOURCE_TYPES = [
  "text",
  "metadata",
  "annotation",
  "bookmark",
  "outline",
] as const;
export type ChunkSourceType = (typeof CHUNK_SOURCE_TYPES)[number];

export function isChunkSourceType(value: unknown): value is ChunkSourceType {
  return typeof value === "string" && (CHUNK_SOURCE_TYPES as readonly string[]).includes(value);
}

/**
 * Index state for one document.
 *
 * `stale` is distinct from `failed`: stale means the content moved on and the
 * entry is known to be behind, failed means indexing was attempted and did not
 * work. Collapsing them would hide a broken extractor behind a routine label.
 */
export const SEARCH_INDEX_STATES = ["pending", "indexing", "indexed", "stale", "failed"] as const;
export type SearchIndexState = (typeof SEARCH_INDEX_STATES)[number];

export function isSearchIndexState(value: unknown): value is SearchIndexState {
  return typeof value === "string" && (SEARCH_INDEX_STATES as readonly string[]).includes(value);
}

/**
 * Combining marks, stripped after NFKD has separated them from their base
 * letters so that "résumé" and "resume" match.
 *
 * Built through the `RegExp` constructor from an explicitly-coded backslash
 * rather than written as a regex literal. A literal `\p{Mn}` is correct source,
 * but a literal character *range* of combining marks is not: the marks
 * themselves are invisible, and tooling that rewrites escape sequences into the
 * characters they denote turns such a class into something that silently stops
 * matching. Constructing it leaves nothing invisible in the file.
 */
const COMBINING_MARKS = new RegExp(`${String.fromCharCode(92)}p{Mn}`, "gu");
const SEARCHABLE_CHARACTER = new RegExp(
  `[${String.fromCharCode(92)}p{L}${String.fromCharCode(92)}p{N}]`,
  "u",
);

/** Whether a literal term contains at least one searchable Unicode letter or number. */
export function isSearchableTerm(value: string): boolean {
  const length = [...value].length;
  return (
    length >= SEARCH_LIMITS.minTermLength &&
    length <= SEARCH_LIMITS.maxTermLength &&
    SEARCHABLE_CHARACTER.test(value)
  );
}

/**
 * The normalized form used for matching.
 *
 * NFKC folds compatibility forms, diacritics are stripped so "résumé" matches
 * "resume", whitespace is collapsed, and case folding uses `toLowerCase` rather
 * than `toLocaleLowerCase` so a server's locale can never change what matches.
 */
export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/**
 * Splits a query into bounded terms.
 *
 * Terms are plain substrings, never patterns: the query is not compiled into a
 * regular expression anywhere, so no input can describe catastrophic
 * backtracking. Over-long and over-numerous terms are dropped rather than
 * truncating the query silently — see `parseSearchQuery`, which reports it.
 */
export function tokenizeQuery(value: string): string[] {
  const normalized = normalizeSearchText(value);
  if (!normalized) return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of normalized.split(" ")) {
    const term = raw.trim();
    if (!isSearchableTerm(term)) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= SEARCH_LIMITS.maxQueryTerms) break;
  }
  return terms;
}

export interface ParsedSearchQuery {
  /** The caller's text, bounded and trimmed, for echoing back. */
  raw: string;
  /** Normalized terms used for matching. */
  terms: string[];
  /** True when tokenization dropped terms because the query exceeded its bounds. */
  truncated: boolean;
}

/**
 * Validates and bounds a caller-supplied query. Returns null when nothing
 * usable remains: a query of only stop-length fragments matches nothing, and
 * saying so beats returning every document.
 */
export function parseSearchQuery(value: unknown): ParsedSearchQuery | null {
  if (typeof value !== "string") return null;
  const raw = value.replace(/\s+/gu, " ").trim();
  if (!raw) return null;
  if ([...raw].length > SEARCH_LIMITS.maxQueryLength) return null;
  const terms = tokenizeQuery(raw);
  if (terms.length === 0) return null;
  const allTerms = normalizeSearchText(raw)
    .split(" ")
    .filter(isSearchableTerm);
  return { raw, terms, truncated: allTerms.length > terms.length };
}

/** Whether a value is usable as an identifier in a repository predicate. */
export function isBoundedSearchId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= SEARCH_LIMITS.maxIdLength
  );
}

/** The index entry for one document at one version. */
export interface SearchDocument {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  /** The immutable version this entry describes, or null before one exists. */
  versionId: string | null;
  state: SearchIndexState;
  /** Schema version the entry was written under. */
  schemaVersion: number;
  /** Checksum of the indexed content, for detecting unchanged reindexes. */
  checksum: string;
  /** How many chunks the entry currently holds. */
  chunkCount: number;
  /** Why the last indexing attempt failed, bounded; null when it did not. */
  error: string | null;
  /** When indexing last completed, or null if it never has. */
  indexedAt: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/** One bounded, page-aware unit of indexed content. */
export interface SearchChunk {
  id: string;
  organizationId: string;
  workspaceId: string;
  searchDocumentId: string;
  documentId: string;
  /** Position within the document; stable so snippets can be ordered. */
  ordinal: number;
  sourceType: ChunkSourceType;
  /** 1-based page this text came from, or null for non-paged sources. */
  pageNumber: number | null;
  /** Original text, bounded, used to render a readable snippet. */
  text: string;
  /** Matching form of the same text. */
  normalizedText: string;
  createdAt: Date;
}

/**
 * A highlight is a range over the snippet string, not markup.
 *
 * Returning `<mark>` would put index content into an HTML sink and make every
 * consumer responsible for escaping it. Offsets let the client mark the range
 * with its own elements, so document text can never become document structure.
 */
export interface SnippetHighlight {
  start: number;
  length: number;
}

export interface SearchSnippet {
  /** Plain text excerpt; never HTML. */
  text: string;
  /** Ranges within `text` that matched, ordered and non-overlapping. */
  highlights: SnippetHighlight[];
  pageNumber: number | null;
  sourceType: ChunkSourceType;
}

export interface SearchHit {
  documentId: string;
  versionId: string | null;
  /** Relative rank within this result set; not comparable across queries. */
  score: number;
  snippets: SearchSnippet[];
  /** Pages the match was found on, ascending and de-duplicated. */
  pageNumbers: number[];
  /** True when the entry is behind the document's current content. */
  stale: boolean;
}

/** Resolves a caller-supplied result limit, shared so no path can read wider. */
export function searchResultLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit) || limit <= 0) {
    return SEARCH_LIMITS.defaultResultLimit;
  }
  return Math.min(Math.trunc(limit), SEARCH_LIMITS.maxResults);
}

/** Resolves a caller-supplied chunk listing limit. */
export function chunkListLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit) || limit <= 0) {
    return SEARCH_LIMITS.maxChunksPerDocument;
  }
  return Math.min(Math.trunc(limit), SEARCH_LIMITS.maxChunksPerDocument);
}

/**
 * Splits extracted text into bounded chunks on sentence-ish boundaries.
 *
 * Breaking mid-word would produce snippets that read as corrupt, so the split
 * prefers the last whitespace before the cap and only cuts hard when a single
 * run of non-whitespace is itself longer than a chunk.
 */
export function chunkText(text: string, maxLength = SEARCH_LIMITS.maxChunkTextLength): string[] {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (!collapsed) return [];
  const chunks: string[] = [];
  let remaining = collapsed;
  while (remaining.length > 0 && chunks.length < SEARCH_LIMITS.maxChunksPerDocument) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    const window = remaining.slice(0, maxLength);
    const breakAt = window.lastIndexOf(" ");
    const cut = breakAt > maxLength * 0.5 ? breakAt : maxLength;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

/**
 * Builds a snippet around the first match, with highlight ranges.
 *
 * Matching is substring-based on the normalized text, and the offsets are then
 * mapped back onto the original so the excerpt reads naturally while the ranges
 * still point at what matched. Returns null when no term appears.
 */
export function buildSnippet(
  chunk: Pick<SearchChunk, "text" | "normalizedText" | "pageNumber" | "sourceType">,
  terms: string[],
  maxLength = SEARCH_LIMITS.maxSnippetLength,
): SearchSnippet | null {
  if (terms.length === 0) return null;

  // Offsets are found in the normalized text but applied to the original, so
  // the two must correspond position-for-position. `normalizeSearchText` can
  // change length (NFKD strips marks, whitespace collapses), so the original is
  // only usable when the lengths still line up; otherwise the normalized text
  // is shown, which is readable and always correctly offset.
  const aligned = chunk.text.length === chunk.normalizedText.length;
  const display = aligned ? chunk.text : chunk.normalizedText;
  const haystack = chunk.normalizedText;

  const positions: Array<{ start: number; length: number }> = [];
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(term, from);
      if (at === -1) break;
      positions.push({ start: at, length: term.length });
      from = at + term.length;
      if (positions.length >= SEARCH_LIMITS.maxHighlightsPerSnippet * 4) break;
    }
  }
  if (positions.length === 0) return null;

  positions.sort((a, b) => a.start - b.start);
  const first = positions[0];

  // Centre the window on the first match rather than starting at it: context
  // before a match is what makes a snippet readable.
  const half = Math.floor(maxLength / 2);
  let start = Math.max(0, first.start - half);
  const end = Math.min(display.length, start + maxLength);
  start = Math.max(0, Math.min(start, end - maxLength));

  const excerpt = display.slice(start, end);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < display.length ? "…" : "";
  const offset = prefix.length - start;

  const highlights: SnippetHighlight[] = [];
  for (const position of positions) {
    if (position.start < start || position.start + position.length > end) continue;
    const shifted = { start: position.start + offset, length: position.length };
    // Overlapping ranges would double-mark the same characters; the later one is
    // dropped because the earlier already covers the text.
    const previous = highlights[highlights.length - 1];
    if (previous && shifted.start < previous.start + previous.length) continue;
    highlights.push(shifted);
    if (highlights.length >= SEARCH_LIMITS.maxHighlightsPerSnippet) break;
  }
  if (highlights.length === 0) return null;

  return {
    text: `${prefix}${excerpt}${suffix}`,
    highlights,
    pageNumber: chunk.pageNumber,
    sourceType: chunk.sourceType,
  };
}
