/**
 * In-document text search (Stage A3).
 *
 * WHY THIS EXISTS AT ALL. The reference design shows a prominent "Search in
 * document" field, and the editor had no such feature. The application does have
 * a `SearchPanel`/`WorkspaceSearch`, but those query
 * `/api/workspaces/{id}/search` — they find OTHER DOCUMENTS in the workspace.
 * Wiring a Ctrl+F to that would produce results that are not in the open file,
 * which is worse than having no search: the user would conclude the text is
 * absent from a document they are looking at.
 *
 * So this searches the editor's own object model, and nothing else. It is not a
 * second search engine competing with workspace search; the two answer different
 * questions ("where in THIS document" vs "which document").
 *
 * WHAT IT CAN SEE. Imported PDF text becomes real `TextObject`s at load
 * (`lib/editor/extractText.ts` → `extractTextObjects`), each carrying a
 * `sourceText` marker. So search covers BOTH editor-authored text and imported
 * PDF text, which is what makes it a genuine document search rather than a
 * search of the user's own additions.
 *
 * It cannot see: text baked into a scanned raster image (no OCR in this
 * codebase), or glyphs the PDF text extractor could not decode. `searchScope`
 * reports what was actually searched so the UI can say so instead of implying
 * total coverage — an empty result set is ambiguous otherwise.
 *
 * PURE AND DOM-FREE by design: matching, ordering and navigation are decisions
 * worth asserting directly, without mounting an editor.
 */

import type { EditorDocument, EditorPage } from "@/src/domain/editor/document";
import type { EditorObject, TextObject } from "@/src/domain/editor/objects";
import { textContentToPlainText } from "@/src/domain/editor/textContent";
import { isReadonlySourceText } from "@/src/domain/editor/importedTextRendering";
import { paintOrder } from "@/src/domain/editor/layers";

/** One hit: enough to select it, scroll to it, and describe it. */
export interface SearchMatch {
  /** Page index (0-based) the hit is on. */
  pageIndex: number;
  /** 1-based page number, for display. */
  pageNumber: number;
  /** The text object containing the hit. */
  objectId: string;
  /** Character offset of the hit within that object's plain text. */
  start: number;
  /** Character offset just past the hit. */
  end: number;
  /** The matched text as it appears in the document (original casing). */
  text: string;
  /** A short surrounding snippet for the results list. */
  snippet: string;
  /** Offset of the hit inside `snippet`, for highlighting it. */
  snippetStart: number;
  /**
   * True when the hit is in imported PDF text the user cannot edit. The UI uses
   * this to avoid offering "replace" on something that cannot be replaced.
   */
  readonlySource: boolean;
}

export interface SearchOptions {
  /** Case-sensitive matching. Default false. */
  caseSensitive?: boolean;
  /** Match only on whole words. Default false. */
  wholeWord?: boolean;
  /** Hard cap on returned matches. Default 500. */
  limit?: number;
}

/** What the search was actually able to look at, so the UI can be honest. */
export interface SearchScope {
  /** Text objects searched. */
  textObjects: number;
  /** Of those, how many are imported (readonly) PDF text. */
  importedTextObjects: number;
  /**
   * Objects that may contain text a human can see but this search cannot read:
   * images (possibly scanned text — there is no OCR here) and drawings.
   */
  unsearchableObjects: number;
  /** True when the result list was truncated by `limit`. */
  truncated: boolean;
}

export interface SearchResult {
  matches: SearchMatch[];
  scope: SearchScope;
}

const DEFAULT_LIMIT = 500;
const SNIPPET_RADIUS = 32;

/** The plain-text projection this module searches for a given object. */
function plainTextOf(obj: TextObject): string {
  // `content` is the v4 source of truth; `text` is the legacy projection kept in
  // sync by the factories. Prefer `content` so a rich-text edit is searchable
  // even if a legacy path failed to refresh `text`.
  const fromContent = obj.content ? textContentToPlainText(obj.content) : "";
  return fromContent !== "" ? fromContent : (obj.text ?? "");
}

function isTextObject(obj: EditorObject): obj is TextObject {
  return obj.kind === "text";
}

/**
 * Escapes a user query for literal use in a RegExp.
 *
 * The query box is a plain-text field, not a regex field. Without this, typing
 * `(` throws a SyntaxError and typing `.*` silently matches everything — both
 * read as "search is broken".
 */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds the matcher.
 *
 * `wholeWord` uses lookaround on word characters rather than `\b`, because `\b`
 * around a query that begins or ends with punctuation ("(draft)") never matches —
 * the boundary is already there and `\b` demands a transition.
 */
function buildMatcher(query: string, opts: SearchOptions): RegExp {
  const escaped = escapeRegExp(query);
  const body = opts.wholeWord ? `(?<![\\w])${escaped}(?![\\w])` : escaped;
  return new RegExp(body, opts.caseSensitive ? "g" : "gi");
}

/** Objects whose visible text this search cannot read (no OCR in this codebase). */
function isUnsearchable(obj: EditorObject): boolean {
  return obj.kind === "image" || obj.kind === "drawing" || obj.kind === "signature";
}

/**
 * Searches every page of the document, in reading order.
 *
 * Ordering is page-by-page, then PAINT order within a page, then offset within
 * an object. Paint order (rather than the `objects` map's insertion order) is
 * what makes "next match" feel like moving down the page instead of jumping
 * around by internal id, and it is stable across edits that do not restack.
 */
export function searchDocument(
  doc: EditorDocument,
  rawQuery: string,
  options: SearchOptions = {},
): SearchResult {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const scope: SearchScope = {
    textObjects: 0,
    importedTextObjects: 0,
    unsearchableObjects: 0,
    truncated: false,
  };
  const query = rawQuery.trim();
  const matches: SearchMatch[] = [];

  // An empty query is not "no results" — it is "no search". Scope is still
  // reported so the UI can describe the document before anything is typed.
  doc.pages.forEach((page) => {
    for (const obj of orderedObjects(page)) {
      if (isUnsearchable(obj)) scope.unsearchableObjects += 1;
      if (!isTextObject(obj)) continue;
      scope.textObjects += 1;
      if (isReadonlySourceText(obj)) scope.importedTextObjects += 1;
    }
  });
  if (query === "") return { matches, scope };

  const matcher = buildMatcher(query, options);

  outer: for (let pageIndex = 0; pageIndex < doc.pages.length; pageIndex += 1) {
    const page = doc.pages[pageIndex];
    for (const obj of orderedObjects(page)) {
      if (!isTextObject(obj)) continue;
      const haystack = plainTextOf(obj);
      if (haystack === "") continue;

      matcher.lastIndex = 0;
      let hit: RegExpExecArray | null;
      while ((hit = matcher.exec(haystack)) !== null) {
        // A zero-length match cannot happen with an escaped non-empty query, but
        // guard anyway: `exec` with a zero-width match and the `g` flag loops
        // forever, which would hang the editor on a keystroke.
        if (hit[0] === "") {
          matcher.lastIndex += 1;
          continue;
        }
        if (matches.length >= limit) {
          scope.truncated = true;
          break outer;
        }
        const start = hit.index;
        const end = start + hit[0].length;
        const snippetStart = Math.max(0, start - SNIPPET_RADIUS);
        const snippetEnd = Math.min(haystack.length, end + SNIPPET_RADIUS);
        matches.push({
          pageIndex,
          pageNumber: pageIndex + 1,
          objectId: obj.id,
          start,
          end,
          text: hit[0],
          snippet:
            (snippetStart > 0 ? "…" : "") +
            haystack.slice(snippetStart, snippetEnd).replace(/\s+/g, " ") +
            (snippetEnd < haystack.length ? "…" : ""),
          // The leading ellipsis shifts the highlight by one character.
          snippetStart: start - snippetStart + (snippetStart > 0 ? 1 : 0),
          readonlySource: isReadonlySourceText(obj),
        });
      }
    }
  }

  return { matches, scope };
}

/**
 * Objects of a page in paint order.
 *
 * Falls back to the `objects` map when the layer stack does not enumerate an
 * object (a defensive case: a document whose stack and map disagree would
 * otherwise make text silently unsearchable, which looks identical to "the text
 * is not there").
 */
function orderedObjects(page: EditorPage): EditorObject[] {
  const ordered: EditorObject[] = [];
  const seen = new Set<string>();
  let ids: string[];
  try {
    // `paintOrder` yields `{ objectId, layerId }` entries, not bare ids.
    ids = paintOrder(page.layerStack).map((entry) => entry.objectId);
  } catch {
    // A malformed layer stack must not make text unsearchable; the map-based
    // sweep below still reaches every object.
    ids = [];
  }
  for (const id of ids) {
    const obj = page.objects[id];
    if (obj) {
      ordered.push(obj);
      seen.add(id);
    }
  }
  for (const [id, obj] of Object.entries(page.objects)) {
    if (!seen.has(id)) ordered.push(obj);
  }
  return ordered;
}

/**
 * Advances the active match index, wrapping at both ends.
 *
 * Wrapping is deliberate (and is why this is a function rather than `i + 1`):
 * Ctrl+G at the last hit should return to the first, and shift-Enter at the first
 * should go to the last. Returns 0 for an empty match list so callers never hold
 * a -1 index that would render as "match 0 of 0".
 */
export function stepMatch(current: number, total: number, delta: number): number {
  if (total <= 0) return 0;
  return ((current + delta) % total + total) % total;
}

/**
 * A human summary of what was searched, or null when there is nothing worth
 * saying.
 *
 * This exists so the UI does not imply total coverage. An image-only (scanned)
 * PDF yields zero text objects, and "No results" alone would be a misleading
 * answer to "is this word in my document" — the honest answer is that there is
 * no searchable text at all.
 */
export function describeScope(scope: SearchScope): string | null {
  if (scope.textObjects === 0) {
    return scope.unsearchableObjects > 0
      ? "This document has no searchable text. It may be a scan — text inside images cannot be searched."
      : null;
  }
  if (scope.unsearchableObjects > 0) {
    return "Text inside images cannot be searched.";
  }
  return null;
}
