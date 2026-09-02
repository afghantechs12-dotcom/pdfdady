import { describe, expect, it } from "vitest";
import {
  canLoadMore,
  dedupeHits,
  emptyFilters,
  hasActiveFilters,
  initialSearchState,
  isActivationKey,
  isEmptyResult,
  isStale,
  isSubmittableQuery,
  nextReindexPhase,
  pageLabel,
  pagesLabel,
  queryHint,
  reindexLabel,
  searchReducer,
  segmentSnippet,
  serializeFilters,
  type SearchHitView,
  type SearchResultsView,
  type SearchState,
} from "./searchLogic";
import { SEARCH_LIMITS } from "@/src/domain/entities/SearchIndex";

function hit(overrides: Partial<SearchHitView> = {}): SearchHitView {
  return {
    documentId: "doc-1",
    versionId: "ver-1",
    score: 0.8,
    snippets: [
      { text: "a quarterly contract", highlights: [{ start: 12, length: 8 }], pageNumber: 1, sourceType: "text" },
    ],
    pageNumbers: [1],
    stale: false,
    ...overrides,
  };
}

function results(overrides: Partial<SearchResultsView> = {}): SearchResultsView {
  return {
    query: "contract",
    truncated: false,
    hits: [hit()],
    totalCount: 1,
    nextCursor: null,
    ...overrides,
  };
}

describe("segmentSnippet — valid ranges", () => {
  it("splits text into plain and marked segments", () => {
    const segments = segmentSnippet("a quarterly contract", [{ start: 12, length: 8 }]);
    expect(segments).toEqual([
      { kind: "text", text: "a quarterly " },
      { kind: "mark", text: "contract" },
    ]);
  });

  it("keeps trailing text after the last highlight", () => {
    const segments = segmentSnippet("the contract ends", [{ start: 4, length: 8 }]);
    expect(segments).toEqual([
      { kind: "text", text: "the " },
      { kind: "mark", text: "contract" },
      { kind: "text", text: " ends" },
    ]);
  });

  it("marks a highlight that starts at the beginning", () => {
    expect(segmentSnippet("contract text", [{ start: 0, length: 8 }])).toEqual([
      { kind: "mark", text: "contract" },
      { kind: "text", text: " text" },
    ]);
  });

  it("handles several disjoint highlights in order", () => {
    const segments = segmentSnippet("contract and contract", [
      { start: 13, length: 8 },
      { start: 0, length: 8 },
    ]);
    expect(segments.filter((s) => s.kind === "mark").map((s) => s.text)).toEqual([
      "contract",
      "contract",
    ]);
  });

  it("returns the whole text when there are no highlights", () => {
    expect(segmentSnippet("plain text", [])).toEqual([{ kind: "text", text: "plain text" }]);
    expect(segmentSnippet("plain text", undefined)).toEqual([{ kind: "text", text: "plain text" }]);
  });

  it("returns nothing for empty text", () => {
    expect(segmentSnippet("", [{ start: 0, length: 1 }])).toEqual([]);
  });

  it("reassembles to exactly the original text", () => {
    const text = "the quarterly contract for 2026";
    const segments = segmentSnippet(text, [
      { start: 4, length: 9 },
      { start: 27, length: 4 },
    ]);
    expect(segments.map((s) => s.text).join("")).toBe(text);
  });
});

describe("segmentSnippet — invalid ranges are ignored, never clamped", () => {
  it("ignores a negative start", () => {
    expect(segmentSnippet("contract", [{ start: -1, length: 4 }])).toEqual([
      { kind: "text", text: "contract" },
    ]);
  });

  it("ignores a zero length", () => {
    expect(segmentSnippet("contract", [{ start: 2, length: 0 }])).toEqual([
      { kind: "text", text: "contract" },
    ]);
  });

  it("ignores a negative length", () => {
    expect(segmentSnippet("contract", [{ start: 2, length: -5 }])).toEqual([
      { kind: "text", text: "contract" },
    ]);
  });

  it("ignores a range running past the end of the text", () => {
    expect(segmentSnippet("contract", [{ start: 4, length: 99 }])).toEqual([
      { kind: "text", text: "contract" },
    ]);
  });

  it("ignores a start beyond the end of the text", () => {
    expect(segmentSnippet("contract", [{ start: 500, length: 2 }])).toEqual([
      { kind: "text", text: "contract" },
    ]);
  });

  it("ignores non-integer offsets", () => {
    expect(segmentSnippet("contract", [{ start: 1.5, length: 2 }])).toEqual([
      { kind: "text", text: "contract" },
    ]);
    expect(segmentSnippet("contract", [{ start: Number.NaN, length: 2 }])).toEqual([
      { kind: "text", text: "contract" },
    ]);
    expect(segmentSnippet("contract", [{ start: 0, length: Number.POSITIVE_INFINITY }])).toEqual([
      { kind: "text", text: "contract" },
    ]);
  });

  it("keeps the valid ranges when only some are invalid", () => {
    const segments = segmentSnippet("the contract", [
      { start: -3, length: 2 },
      { start: 4, length: 8 },
    ]);
    expect(segments).toEqual([
      { kind: "text", text: "the " },
      { kind: "mark", text: "contract" },
    ]);
  });

  it("tolerates malformed range objects", () => {
    const ranges = [null, undefined, {}, { start: 4 }] as unknown as Array<{
      start: number;
      length: number;
    }>;
    expect(segmentSnippet("the contract", ranges)).toEqual([
      { kind: "text", text: "the contract" },
    ]);
  });
});

describe("segmentSnippet — overlaps and bounds", () => {
  it("resolves overlapping ranges deterministically by keeping the earlier one", () => {
    const segments = segmentSnippet("abcdefghij", [
      { start: 2, length: 5 },
      { start: 4, length: 5 },
    ]);
    expect(segments).toEqual([
      { kind: "text", text: "ab" },
      { kind: "mark", text: "cdefg" },
      { kind: "text", text: "hij" },
    ]);
    // Same input in the other order produces the same output.
    expect(
      segmentSnippet("abcdefghij", [
        { start: 4, length: 5 },
        { start: 2, length: 5 },
      ]),
    ).toEqual(segments);
  });

  it("drops a range fully contained in an earlier one", () => {
    const segments = segmentSnippet("abcdefghij", [
      { start: 0, length: 6 },
      { start: 2, length: 2 },
    ]);
    expect(segments.filter((s) => s.kind === "mark")).toHaveLength(1);
  });

  it("bounds how many highlights it will mark", () => {
    const text = "x".repeat(100);
    const highlights = Array.from(
      { length: SEARCH_LIMITS.maxHighlightsPerSnippet + 6 },
      (_, i) => ({ start: i * 2, length: 1 }),
    );
    const marks = segmentSnippet(text, highlights).filter((s) => s.kind === "mark");
    expect(marks).toHaveLength(SEARCH_LIMITS.maxHighlightsPerSnippet);
  });
});

describe("segmentSnippet — markup stays text", () => {
  it("keeps script content as ordinary text segments", () => {
    const text = "<script>alert(1)</script> contract";
    const segments = segmentSnippet(text, [{ start: 26, length: 8 }]);

    // Nothing is escaped or parsed here: the caller renders these as React text
    // nodes, so the angle brackets are characters, not structure.
    expect(segments[0]).toEqual({ kind: "text", text: "<script>alert(1)</script> " });
    expect(segments.map((s) => s.text).join("")).toBe(text);
  });

  it("keeps an img onerror payload as text even inside a highlight", () => {
    const text = `<img src=x onerror=alert(1)>`;
    const segments = segmentSnippet(text, [{ start: 0, length: text.length }]);
    expect(segments).toEqual([{ kind: "mark", text }]);
  });
});

describe("query validation", () => {
  it("accepts a real term and rejects unusable ones", () => {
    expect(isSubmittableQuery("contract")).toBe(true);
    expect(isSubmittableQuery("2026")).toBe(true);
    expect(isSubmittableQuery("!!! ??")).toBe(false);
    expect(isSubmittableQuery("a")).toBe(false);
    expect(isSubmittableQuery("   ")).toBe(false);
  });

  it("keeps a regex-looking query submittable as a literal", () => {
    expect(isSubmittableQuery(".*contract.*")).toBe(true);
  });

  it("hints only once something unusable has been typed", () => {
    expect(queryHint("")).toBeNull();
    expect(queryHint("contract")).toBeNull();
    expect(queryHint("!!")).toContain("at least");
    expect(queryHint("x".repeat(SEARCH_LIMITS.maxQueryLength + 1))).toContain("at most");
  });
});

describe("filter serialization", () => {
  it("omits every filter that is not set", () => {
    expect(serializeFilters(emptyFilters())).toBeUndefined();
  });

  it("sends only the filters that are set", () => {
    expect(
      serializeFilters({ ...emptyFilters(), favorite: true, lifecycleState: "archived" }),
    ).toEqual({ favorite: true, lifecycleState: "archived" });
  });

  it("omits blank project and folder ids rather than sending empty strings", () => {
    expect(serializeFilters({ ...emptyFilters(), projectId: "   ", folderId: "" })).toBeUndefined();
  });

  it("trims ids that are set", () => {
    expect(serializeFilters({ ...emptyFilters(), projectId: "  proj-1  " })).toEqual({
      projectId: "proj-1",
    });
  });

  it("reports whether any filter is narrowing the search", () => {
    expect(hasActiveFilters(emptyFilters())).toBe(false);
    expect(hasActiveFilters({ ...emptyFilters(), favorite: true })).toBe(true);
    expect(hasActiveFilters({ ...emptyFilters(), folderId: "f-1" })).toBe(true);
    expect(hasActiveFilters({ ...emptyFilters(), projectId: "  " })).toBe(false);
  });
});

describe("searchReducer — state transitions", () => {
  it("moves to loading on start", () => {
    const state = searchReducer(initialSearchState(), {
      type: "start",
      query: "contract",
      requestId: 1,
      append: false,
    });
    expect(state.status).toBe("loading");
    expect(state.query).toBe("contract");
    expect(state.error).toBeNull();
  });

  it("moves to loaded on success", () => {
    let state = searchReducer(initialSearchState(), {
      type: "start",
      query: "contract",
      requestId: 1,
      append: false,
    });
    state = searchReducer(state, { type: "success", requestId: 1, results: results(), append: false });
    expect(state.status).toBe("loaded");
    expect(state.hits).toHaveLength(1);
    expect(state.totalCount).toBe(1);
  });

  it("moves to error on failure and keeps the message", () => {
    let state = searchReducer(initialSearchState(), {
      type: "start",
      query: "contract",
      requestId: 1,
      append: false,
    });
    state = searchReducer(state, { type: "failure", requestId: 1, message: "Search failed." });
    expect(state.status).toBe("error");
    expect(state.error).toBe("Search failed.");
  });

  it("clears the previous error when a new search starts", () => {
    let state: SearchState = { ...initialSearchState(), status: "error", error: "boom", requestId: 1 };
    state = searchReducer(state, { type: "start", query: "contract", requestId: 2, append: false });
    expect(state.error).toBeNull();
  });

  it("detects the empty state only after a load", () => {
    const loading = searchReducer(initialSearchState(), {
      type: "start",
      query: "contract",
      requestId: 1,
      append: false,
    });
    expect(isEmptyResult(loading)).toBe(false);

    const loaded = searchReducer(loading, {
      type: "success",
      requestId: 1,
      results: results({ hits: [], totalCount: 0 }),
      append: false,
    });
    expect(isEmptyResult(loaded)).toBe(true);
  });

  it("resets to the initial state", () => {
    let state = searchReducer(initialSearchState(), {
      type: "start",
      query: "contract",
      requestId: 3,
      append: false,
    });
    state = searchReducer(state, { type: "reset" });
    expect(state.status).toBe("initial");
    expect(state.hits).toEqual([]);
    expect(state.query).toBe("");
  });
});

describe("searchReducer — stale responses cannot overwrite newer results", () => {
  it("ignores a success from a superseded request", () => {
    let state = searchReducer(initialSearchState(), {
      type: "start",
      query: "old",
      requestId: 1,
      append: false,
    });
    state = searchReducer(state, { type: "start", query: "new", requestId: 2, append: false });
    state = searchReducer(state, {
      type: "success",
      requestId: 2,
      results: results({ hits: [hit({ documentId: "doc-new" })] }),
      append: false,
    });

    // The first request finally lands — long after the user moved on.
    const after = searchReducer(state, {
      type: "success",
      requestId: 1,
      results: results({ hits: [hit({ documentId: "doc-old" })] }),
      append: false,
    });

    expect(after.hits.map((h) => h.documentId)).toEqual(["doc-new"]);
  });

  it("ignores a failure from a superseded request", () => {
    let state = searchReducer(initialSearchState(), {
      type: "start",
      query: "old",
      requestId: 1,
      append: false,
    });
    state = searchReducer(state, { type: "start", query: "new", requestId: 2, append: false });
    state = searchReducer(state, { type: "success", requestId: 2, results: results(), append: false });

    const after = searchReducer(state, { type: "failure", requestId: 1, message: "stale boom" });

    expect(after.status).toBe("loaded");
    expect(after.error).toBeNull();
  });
});

describe("searchReducer — pagination", () => {
  it("appends the next page to the existing results", () => {
    let state = searchReducer(initialSearchState(), {
      type: "start",
      query: "contract",
      requestId: 1,
      append: false,
    });
    state = searchReducer(state, {
      type: "success",
      requestId: 1,
      results: results({ hits: [hit({ documentId: "doc-1" })], nextCursor: "c1" }),
      append: false,
    });
    state = searchReducer(state, { type: "start", query: "contract", requestId: 2, append: true });
    state = searchReducer(state, {
      type: "success",
      requestId: 2,
      results: results({ hits: [hit({ documentId: "doc-2" })], nextCursor: null }),
      append: true,
    });

    expect(state.hits.map((h) => h.documentId)).toEqual(["doc-1", "doc-2"]);
  });

  it("keeps the visible results while the next page loads", () => {
    let state = searchReducer(initialSearchState(), {
      type: "start",
      query: "contract",
      requestId: 1,
      append: false,
    });
    state = searchReducer(state, {
      type: "success",
      requestId: 1,
      results: results({ nextCursor: "c1" }),
      append: false,
    });
    state = searchReducer(state, { type: "start", query: "contract", requestId: 2, append: true });

    expect(state.hits).toHaveLength(1);
  });

  it("does not append the same document twice", () => {
    let state = searchReducer(initialSearchState(), {
      type: "start",
      query: "contract",
      requestId: 1,
      append: false,
    });
    state = searchReducer(state, {
      type: "success",
      requestId: 1,
      results: results({ hits: [hit({ documentId: "doc-1" })], nextCursor: "c1" }),
      append: false,
    });
    state = searchReducer(state, { type: "start", query: "contract", requestId: 2, append: true });
    state = searchReducer(state, {
      type: "success",
      requestId: 2,
      results: results({ hits: [hit({ documentId: "doc-1" }), hit({ documentId: "doc-2" })] }),
      append: true,
    });

    expect(state.hits.map((h) => h.documentId)).toEqual(["doc-1", "doc-2"]);
  });

  it("clears the old cursor and results when a new query starts", () => {
    let state = searchReducer(initialSearchState(), {
      type: "start",
      query: "contract",
      requestId: 1,
      append: false,
    });
    state = searchReducer(state, {
      type: "success",
      requestId: 1,
      results: results({ nextCursor: "c1" }),
      append: false,
    });
    state = searchReducer(state, { type: "start", query: "invoice", requestId: 2, append: false });

    expect(state.nextCursor).toBeNull();
    expect(state.hits).toEqual([]);
  });

  it("offers load-more only when a cursor is available", () => {
    let state = searchReducer(initialSearchState(), {
      type: "start",
      query: "contract",
      requestId: 1,
      append: false,
    });
    state = searchReducer(state, {
      type: "success",
      requestId: 1,
      results: results({ nextCursor: "c1" }),
      append: false,
    });
    expect(canLoadMore(state)).toBe(true);

    state = searchReducer(state, {
      type: "success",
      requestId: 1,
      results: results({ nextCursor: null }),
      append: false,
    });
    expect(canLoadMore(state)).toBe(false);
  });

  it("dedupes hits directly", () => {
    const deduped = dedupeHits([
      hit({ documentId: "doc-1", score: 0.9 }),
      hit({ documentId: "doc-1", score: 0.4 }),
      hit({ documentId: "doc-2" }),
    ]);
    expect(deduped.map((h) => h.documentId)).toEqual(["doc-1", "doc-2"]);
    // The first appearance wins, so an established ordering does not shuffle.
    expect(deduped[0].score).toBe(0.9);
  });
});

describe("staleness and reindex", () => {
  it("reads the stale flag off a hit", () => {
    expect(isStale(hit({ stale: true }))).toBe(true);
    expect(isStale(hit({ stale: false }))).toBe(false);
  });

  it("moves through request, accepted and rejected phases", () => {
    expect(nextReindexPhase("idle", "request")).toBe("pending");
    expect(nextReindexPhase("pending", "accepted")).toBe("queued");
    expect(nextReindexPhase("pending", "rejected")).toBe("failed");
  });

  it("labels a settled reindex as queued, never as completed", () => {
    expect(reindexLabel("idle")).toBe("Reindex");
    expect(reindexLabel("pending")).toContain("Requesting");
    // The server answers 202: it accepted the request, it did not finish the work.
    expect(reindexLabel("queued")).toBe("Reindex queued");
    expect(reindexLabel("queued")).not.toMatch(/complete|done|indexed$/iu);
    expect(reindexLabel("failed")).toContain("failed");
  });
});

describe("labels", () => {
  it("labels a page number", () => {
    expect(pageLabel(3)).toBe("Page 3");
  });

  it("falls back for a missing or invalid page number", () => {
    expect(pageLabel(null)).toBe("Document");
    expect(pageLabel(0)).toBe("Document");
    expect(pageLabel(-2)).toBe("Document");
    expect(pageLabel(1.5)).toBe("Document");
  });

  it("summarizes several pages and bounds the list", () => {
    expect(pagesLabel([])).toBe("");
    expect(pagesLabel([4])).toBe("Page 4");
    expect(pagesLabel([1, 2])).toBe("Pages 1, 2");
    expect(pagesLabel([1, 2, 3, 4, 5])).toBe("Pages 1, 2, 3 +2");
  });

  it("drops invalid page numbers from the summary", () => {
    expect(pagesLabel([0, -1, 2])).toBe("Page 2");
  });
});

describe("keyboard activation", () => {
  it("activates on Enter and Space", () => {
    expect(isActivationKey("Enter")).toBe(true);
    expect(isActivationKey(" ")).toBe(true);
    expect(isActivationKey("Spacebar")).toBe(true);
  });

  it("does not activate on other keys", () => {
    expect(isActivationKey("Tab")).toBe(false);
    expect(isActivationKey("a")).toBe(false);
    expect(isActivationKey("Escape")).toBe(false);
  });
});
