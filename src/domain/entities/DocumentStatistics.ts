/**
 * M7.11 document statistics and version comparison.
 *
 * Three rules govern this module.
 *
 * **Statistics are version-keyed, and every number is computed.** A statistics
 * row describes one immutable DocumentVersion, never "the document" — a count
 * that floats free of a version is a count nobody can reproduce. Nothing here
 * emits a default or sample figure: `computeStatistics` derives each value from
 * supplied content, and a value that cannot be derived is `null`, which reads as
 * "not measured" rather than as zero. Zero and unknown are different facts, and
 * a UI that shows "0 images" for a document nobody has scanned is lying.
 *
 * **Comparison state transitions are bounded and one-way.** `pending → running →
 * completed | failed | cancelled`, with terminal states that cannot be rewritten.
 * A cancelled operation cannot later report completion, and a stale worker
 * delivering a result for an operation that has moved on is refused rather than
 * allowed to overwrite a newer state.
 *
 * **Unsupported is a real answer.** Visual comparison requires a rasteriser this
 * build does not have (see `COMPARISON_SUPPORT`). It reports `unsupported`
 * explicitly rather than returning an empty diff that reads as "no visual
 * differences" — the two are opposite claims.
 */

export const STATISTICS_LIMITS = {
  /** Current statistics schema version. A row written under another is degraded, not trusted. */
  schemaVersion: 1,
  /** Longest accepted identifier in any predicate. */
  maxIdLength: 128,
  /** Longest accepted checksum. */
  maxChecksumLength: 128,
  /** Upper bound on any single count. Bounds a tampered or corrupt input. */
  maxCount: 1_000_000_000,
  /** Largest file size accepted, in bytes. */
  maxFileSize: 2 * 1024 * 1024 * 1024,
  /** Largest text payload one statistics computation will scan, in characters. */
  maxTextLength: 50_000_000,
  /** Most content segments one computation will accept. */
  maxSegments: 100_000,
  /** Longest accepted failure reason, in code points. */
  maxErrorLength: 500,
  /** Most differences recorded in one comparison result. */
  maxDifferences: 5000,
  /** Most pages a comparison will report individually. */
  maxComparedPages: 10_000,
  /** Longest excerpt retained per textual difference. */
  maxExcerptLength: 300,
  /** Most rows returned in a single listing. */
  maxListLimit: 100,
  /** Default listing size when a caller does not ask for one. */
  defaultListLimit: 25,
  /** Most concurrent non-terminal comparisons one document may have. */
  maxActiveComparisonsPerDocument: 5,
} as const;

// ---- statistics -------------------------------------------------------------

/**
 * Whether a statistics row is current.
 *
 * `ready` — computed and valid for its version.
 * `pending` — requested, not yet computed.
 * `failed` — computation was attempted and could not complete.
 */
export const STATISTICS_STATUSES = ["pending", "ready", "failed"] as const;
export type StatisticsStatus = (typeof STATISTICS_STATUSES)[number];

export function isStatisticsStatus(value: unknown): value is StatisticsStatus {
  return typeof value === "string" && (STATISTICS_STATUSES as readonly string[]).includes(value);
}

/**
 * Measured counts for one version.
 *
 * Every field is nullable, and that is the point: `null` means "not measured",
 * `0` means "measured, and there are none". Collapsing the two would let a
 * document that was never scanned for images report confidently that it has
 * none.
 */
export interface StatisticsCounts {
  pageCount: number | null;
  textCharacterCount: number | null;
  wordCount: number | null;
  imageCount: number | null;
  annotationCount: number | null;
  bookmarkCount: number | null;
  attachmentCount: number | null;
  fileSize: number | null;
}

export interface DocumentStatistics {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  /** The immutable version these numbers describe. Never null. */
  versionId: string;
  /** Statistics schema the row was written under. */
  schemaVersion: number;
  counts: StatisticsCounts;
  /**
   * Checksum of the content the numbers were computed from. A version whose
   * checksum no longer matches has been recomputed against different bytes, so
   * the cached row is stale rather than merely old.
   */
  checksum: string;
  status: StatisticsStatus;
  /** Bounded reason, set only when `status` is "failed". */
  error: string | null;
  calculatedAt: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/** An empty count set — every field unmeasured. */
export function emptyCounts(): StatisticsCounts {
  return {
    pageCount: null,
    textCharacterCount: null,
    wordCount: null,
    imageCount: null,
    annotationCount: null,
    bookmarkCount: null,
    attachmentCount: null,
    fileSize: null,
  };
}

/** Validates a single count. Returns null for anything unusable or unmeasured. */
export function validateCount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value) || value < 0 || value > STATISTICS_LIMITS.maxCount) return null;
  return value;
}

/** Validates a file size, which has its own larger bound. */
export function validateFileSize(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value) || value < 0 || value > STATISTICS_LIMITS.maxFileSize) return null;
  return value;
}

/**
 * One unit of content offered for measurement.
 *
 * Mirrors M7.8's `IndexSourceSegment` deliberately: the same extraction that
 * feeds the search index feeds statistics, so the two cannot disagree about what
 * a document contains. This service does not open PDF bytes itself — extraction
 * belongs to the caller or the job, exactly as it does for indexing.
 */
export interface StatisticsSourceSegment {
  pageNumber?: number | null;
  text?: string | null;
  /** Images observed on this segment, when the extractor counted them. */
  imageCount?: number | null;
  /** Annotations observed on this segment, when the extractor counted them. */
  annotationCount?: number | null;
}

/** What a caller supplies to compute statistics for a version. */
export interface StatisticsSource {
  segments: StatisticsSourceSegment[];
  /** Page count from the version manifest, when it recorded one. */
  manifestPageCount?: number | null;
  /** Source byte size from the version manifest. */
  fileSize?: number | null;
  /** Workspace bookmarks on the document, counted by the caller. */
  bookmarkCount?: number | null;
  /** Attachments on the document, counted by the caller. */
  attachmentCount?: number | null;
}

/**
 * Counts words in extracted text.
 *
 * Splits on Unicode whitespace rather than on `/\s/` alone so that ideographic
 * and non-breaking spaces separate words as a reader would expect. A run of
 * punctuation is not a word; a hyphenated token is one.
 */
/**
 * Counts code points, giving up as soon as the count exceeds `limit`.
 *
 * Returns null when the string is longer than the limit. Iterating rather than
 * spreading means an oversized string is rejected after `limit` steps instead of
 * allocating an array proportional to its whole length.
 */
function countCodePointsUpTo(text: string, limit: number): number | null {
  let count = 0;
  for (const _character of text) {
    count += 1;
    if (count > limit) return null;
  }
  return count;
}

export function countWords(text: string): number {  const trimmed = text.trim();
  if (trimmed === "") return 0;
  let words = 0;
  for (const token of trimmed.split(/\s+/u)) {
    // A token has to contain something a reader would call a character.
    if (/[\p{L}\p{N}]/u.test(token)) words += 1;
  }
  return words;
}

/**
 * Computes statistics from supplied content.
 *
 * Every returned number is derived from the input. Fields the input says nothing
 * about stay `null` rather than defaulting to zero — this function has no
 * fallback figures of any kind, which is what makes its output reproducible from
 * the same version.
 */
export function computeStatistics(
  source: StatisticsSource,
): { ok: true; counts: StatisticsCounts } | { ok: false; reason: string } {
  if (!Array.isArray(source.segments)) {
    return { ok: false, reason: "Content segments are required." };
  }
  if (source.segments.length > STATISTICS_LIMITS.maxSegments) {
    return { ok: false, reason: "Too many content segments to measure." };
  }

  let characters = 0;
  let words = 0;
  let sawText = false;

  let images = 0;
  let sawImages = false;

  let annotations = 0;
  let sawAnnotations = false;

  const pages = new Set<number>();

  for (const segment of source.segments) {
    if (segment === null || typeof segment !== "object") {
      return { ok: false, reason: "A content segment was not readable." };
    }

    if (typeof segment.text === "string" && segment.text !== "") {
      // The bound is enforced before the string is ever materialized into an
      // array. `length` is UTF-16 units and never under-counts code points, so a
      // string within the limit by that measure is certainly within it exactly;
      // only the ambiguous case pays for a real count, and that count stops as
      // soon as it exceeds the cap. Counting first and checking afterwards would
      // let an oversized segment exhaust memory on its way to being rejected,
      // which is what the bound exists to prevent.
      const remaining = STATISTICS_LIMITS.maxTextLength - characters;
      const exact =
        segment.text.length <= remaining
          ? [...segment.text].length
          : countCodePointsUpTo(segment.text, remaining);
      if (exact === null) {
        return { ok: false, reason: "The document text exceeds the measurable limit." };
      }
      characters += exact;
      words += countWords(segment.text);
      sawText = true;
    }

    const segmentImages = validateCount(segment.imageCount);
    if (segment.imageCount !== null && segment.imageCount !== undefined) {
      if (segmentImages === null) return { ok: false, reason: "An image count was not valid." };
      images += segmentImages;
      sawImages = true;
    }

    const segmentAnnotations = validateCount(segment.annotationCount);
    if (segment.annotationCount !== null && segment.annotationCount !== undefined) {
      if (segmentAnnotations === null) {
        return { ok: false, reason: "An annotation count was not valid." };
      }
      annotations += segmentAnnotations;
      sawAnnotations = true;
    }

    if (segment.pageNumber !== null && segment.pageNumber !== undefined) {
      const page = validateCount(segment.pageNumber);
      if (page === null || page < 1) return { ok: false, reason: "A page number was not valid." };
      if (page > STATISTICS_LIMITS.maxComparedPages) {
        return { ok: false, reason: "A page number exceeds the measurable limit." };
      }
      pages.add(page);
    }
  }

  // The manifest's page count wins when it exists: it came from the PDF itself,
  // whereas the observed set only covers pages the extractor produced text for.
  // A scanned page with no extractable text still exists.
  const manifestPages = validateCount(source.manifestPageCount);
  const pageCount =
    manifestPages !== null ? manifestPages : pages.size > 0 ? Math.max(...pages) : null;

  return {
    ok: true,
    counts: {
      pageCount,
      textCharacterCount: sawText ? characters : null,
      wordCount: sawText ? words : null,
      imageCount: sawImages ? images : null,
      annotationCount: sawAnnotations ? annotations : null,
      bookmarkCount: validateCount(source.bookmarkCount),
      attachmentCount: validateCount(source.attachmentCount),
      fileSize: validateFileSize(source.fileSize),
    },
  };
}

/** Serializes counts deterministically, so an unchanged measurement compares equal. */
export function serializeCounts(counts: StatisticsCounts): string {
  return JSON.stringify({
    pageCount: counts.pageCount,
    textCharacterCount: counts.textCharacterCount,
    wordCount: counts.wordCount,
    imageCount: counts.imageCount,
    annotationCount: counts.annotationCount,
    bookmarkCount: counts.bookmarkCount,
    attachmentCount: counts.attachmentCount,
    fileSize: counts.fileSize,
  });
}

/**
 * Reads stored counts back, tolerantly.
 *
 * A row written by another build may hold a field this one no longer knows or a
 * value that no longer validates. Such a field degrades to `null` — "not
 * measured" — rather than failing the read, because losing one count is
 * recoverable while refusing to open the statistics panel is not.
 */
export function parseCounts(serialized: unknown): StatisticsCounts {
  if (typeof serialized !== "string" || serialized.trim() === "") return emptyCounts();
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    return emptyCounts();
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return emptyCounts();
  const record = raw as Record<string, unknown>;
  return {
    pageCount: validateCount(record.pageCount),
    textCharacterCount: validateCount(record.textCharacterCount),
    wordCount: validateCount(record.wordCount),
    imageCount: validateCount(record.imageCount),
    annotationCount: validateCount(record.annotationCount),
    bookmarkCount: validateCount(record.bookmarkCount),
    attachmentCount: validateCount(record.attachmentCount),
    fileSize: validateFileSize(record.fileSize),
  };
}

// ---- comparison -------------------------------------------------------------

export const COMPARISON_TYPES = ["structural", "textual", "visual", "editor"] as const;
export type ComparisonType = (typeof COMPARISON_TYPES)[number];

export function isComparisonType(value: unknown): value is ComparisonType {
  return typeof value === "string" && (COMPARISON_TYPES as readonly string[]).includes(value);
}

/**
 * What this build can actually compare.
 *
 * A single constant rather than a per-call decision, for the same reason
 * `EMBEDDED_WRITE_SUPPORT` is one in M7.9: visual comparison needs a page
 * rasteriser and a perceptual diff, and claiming it without one would return an
 * empty diff that reads as "these pages are identical". `editor` comparison
 * needs both versions to carry serialized editor state, which is a per-version
 * fact checked at request time rather than a build capability.
 *
 * When a rasteriser lands, this constant flips and the service follows — no
 * other code encodes the assumption.
 */
export const COMPARISON_SUPPORT: Readonly<Record<ComparisonType, boolean>> = Object.freeze({
  structural: true,
  textual: true,
  visual: false,
  editor: true,
});

export function isComparisonSupported(type: ComparisonType): boolean {
  return COMPARISON_SUPPORT[type];
}

/** Why a comparison type is unavailable, in words a user can act on. */
export function unsupportedComparisonReason(type: ComparisonType): string | null {
  if (isComparisonSupported(type)) return null;
  if (type === "visual") {
    return "Visual comparison needs page rendering, which this release does not include. Structural and textual comparison are available.";
  }
  return "This comparison type is not available in this release.";
}

export const COMPARISON_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type ComparisonStatus = (typeof COMPARISON_STATUSES)[number];

export function isComparisonStatus(value: unknown): value is ComparisonStatus {
  return typeof value === "string" && (COMPARISON_STATUSES as readonly string[]).includes(value);
}

/** Whether a status admits no further change. */
export function isTerminalComparisonStatus(status: ComparisonStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * The permitted state transitions.
 *
 * `cancelled` is terminal and has no outgoing edges: a cancelled operation that
 * could later report completion would deliver a result the user explicitly
 * declined to wait for. Retrying creates a *new* operation instead, which keeps
 * the cancellation an honest historical fact.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<ComparisonStatus, readonly ComparisonStatus[]>> = {
  pending: ["running", "cancelled", "failed"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransitionComparison(from: ComparisonStatus, to: ComparisonStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Validates a progress percentage. */
export function validateProgress(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 100) return null;
  return Math.round(value);
}

/**
 * The progress a status implies.
 *
 * A completed operation is at 100 and a pending one at 0 regardless of what a
 * worker last reported, so a client never sees "completed, 60%".
 */
export function progressForStatus(status: ComparisonStatus, reported: number): number {
  if (status === "completed") return 100;
  if (status === "pending") return 0;
  const bounded = validateProgress(reported);
  return bounded === null ? 0 : bounded;
}

export interface ComparisonOperation {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  /** The older side. Both versions must belong to `documentId`. */
  leftVersionId: string;
  rightVersionId: string;
  type: ComparisonType;
  status: ComparisonStatus;
  /** 0..100. Always consistent with `status` (see `progressForStatus`). */
  progress: number;
  requestedById: string;
  /** Set when a cancellation was requested, whether or not it has taken effect. */
  cancelRequestedAt: Date | null;
  /** Bounded reason, set only when `status` is "failed". */
  error: string | null;
  /** Set only when `status` is "completed". */
  resultId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

/** One recorded difference between two versions. */
export interface ComparisonDifference {
  kind: "added" | "removed" | "changed";
  /** 1-based page the difference is on, when it has one. */
  pageNumber: number | null;
  /** Bounded excerpt, plain text. Never markup. */
  excerpt: string | null;
}

export interface ComparisonSummary {
  added: number;
  removed: number;
  changed: number;
  /** Pages present in one version and not the other. */
  pagesAdded: number[];
  pagesRemoved: number[];
  /** True when the difference list was capped and does not enumerate everything. */
  truncated: boolean;
}

export interface ComparisonResult {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  comparisonId: string;
  type: ComparisonType;
  summary: ComparisonSummary;
  differences: ComparisonDifference[];
  /**
   * Checksum over both compared versions. A result whose key no longer matches
   * the versions being asked about is a result for something else.
   */
  checksum: string;
  createdAt: Date;
}

/** An empty summary — no differences found, as distinct from none looked for. */
export function emptySummary(): ComparisonSummary {
  return { added: 0, removed: 0, changed: 0, pagesAdded: [], pagesRemoved: [], truncated: false };
}

/** One side of a comparison, as the caller supplies it. */
export interface ComparisonSide {
  versionId: string;
  /** Page number to extracted text. Absent pages were not extracted. */
  pages: Map<number, string>;
  /** Page count from the manifest, when recorded. */
  pageCount: number | null;
}

/**
 * Compares two sides structurally: which pages exist, and which changed.
 *
 * Deliberately does not attempt a word-level diff — that is `compareTextual`.
 * Structural comparison answers "what moved", and conflating the two would make
 * a reformatted paragraph look like a restructured document.
 */
export function compareStructural(
  left: ComparisonSide,
  right: ComparisonSide,
): { summary: ComparisonSummary; differences: ComparisonDifference[] } {
  const leftPages = pageNumbersOf(left);
  const rightPages = pageNumbersOf(right);

  const pagesAdded = [...rightPages].filter((page) => !leftPages.has(page)).sort((a, b) => a - b);
  const pagesRemoved = [...leftPages].filter((page) => !rightPages.has(page)).sort((a, b) => a - b);

  const differences: ComparisonDifference[] = [];
  let changed = 0;
  for (const page of [...leftPages].filter((p) => rightPages.has(p)).sort((a, b) => a - b)) {
    const before = left.pages.get(page) ?? "";
    const after = right.pages.get(page) ?? "";
    if (before !== after) {
      changed += 1;
      if (differences.length < STATISTICS_LIMITS.maxDifferences) {
        differences.push({ kind: "changed", pageNumber: page, excerpt: null });
      }
    }
  }
  for (const page of pagesAdded) {
    if (differences.length < STATISTICS_LIMITS.maxDifferences) {
      differences.push({ kind: "added", pageNumber: page, excerpt: null });
    }
  }
  for (const page of pagesRemoved) {
    if (differences.length < STATISTICS_LIMITS.maxDifferences) {
      differences.push({ kind: "removed", pageNumber: page, excerpt: null });
    }
  }

  const total = changed + pagesAdded.length + pagesRemoved.length;
  return {
    summary: {
      added: pagesAdded.length,
      removed: pagesRemoved.length,
      changed,
      pagesAdded: pagesAdded.slice(0, STATISTICS_LIMITS.maxComparedPages),
      pagesRemoved: pagesRemoved.slice(0, STATISTICS_LIMITS.maxComparedPages),
      truncated: total > differences.length,
    },
    differences,
  };
}

function pageNumbersOf(side: ComparisonSide): Set<number> {
  const pages = new Set<number>(side.pages.keys());
  // A manifest page count covers pages with no extractable text — a scanned page
  // still exists, and omitting it would report a real page as removed.
  if (side.pageCount !== null && side.pageCount > 0) {
    const bound = Math.min(side.pageCount, STATISTICS_LIMITS.maxComparedPages);
    for (let page = 1; page <= bound; page += 1) pages.add(page);
  }
  return pages;
}

/**
 * Compares two sides textually, line by line within each page.
 *
 * A line-level diff rather than a character-level one: a character diff over a
 * whole document is quadratic in the worst case and produces differences no
 * reader can act on. Lines are compared as multisets per page, so moved text on
 * the same page does not read as both an addition and a removal.
 */
export function compareTextual(
  left: ComparisonSide,
  right: ComparisonSide,
): { summary: ComparisonSummary; differences: ComparisonDifference[] } {
  const pages = new Set<number>([...left.pages.keys(), ...right.pages.keys()]);
  const differences: ComparisonDifference[] = [];
  let added = 0;
  let removed = 0;
  let totalDifferences = 0;

  for (const page of [...pages].sort((a, b) => a - b)) {
    const before = countLines(left.pages.get(page) ?? "");
    const after = countLines(right.pages.get(page) ?? "");

    for (const [line, count] of after) {
      const surplus = count - (before.get(line) ?? 0);
      for (let i = 0; i < surplus; i += 1) {
        added += 1;
        totalDifferences += 1;
        if (differences.length < STATISTICS_LIMITS.maxDifferences) {
          differences.push({ kind: "added", pageNumber: page, excerpt: excerpt(line) });
        }
      }
    }
    for (const [line, count] of before) {
      const surplus = count - (after.get(line) ?? 0);
      for (let i = 0; i < surplus; i += 1) {
        removed += 1;
        totalDifferences += 1;
        if (differences.length < STATISTICS_LIMITS.maxDifferences) {
          differences.push({ kind: "removed", pageNumber: page, excerpt: excerpt(line) });
        }
      }
    }
  }

  return {
    summary: {
      added,
      removed,
      changed: 0,
      pagesAdded: [],
      pagesRemoved: [],
      truncated: totalDifferences > differences.length,
    },
    differences,
  };
}

function countLines(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

function excerpt(line: string): string {
  const characters = [...line];
  return characters.length <= STATISTICS_LIMITS.maxExcerptLength
    ? line
    : `${characters.slice(0, STATISTICS_LIMITS.maxExcerptLength).join("")}…`;
}

/** Validates a bounded failure reason. */
export function validateComparisonError(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const reason = value.replace(/\s+/gu, " ").trim();
  if (reason === "") return null;
  const characters = [...reason];
  return characters.length <= STATISTICS_LIMITS.maxErrorLength
    ? reason
    : characters.slice(0, STATISTICS_LIMITS.maxErrorLength).join("");
}

/** Whether a value is usable as an identifier in a repository predicate. */
export function isBoundedStatisticsId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= STATISTICS_LIMITS.maxIdLength
  );
}

/** Bounds a caller-supplied listing limit. */
export function statisticsListLimit(limit: number | undefined): number {
  if (limit === undefined) return STATISTICS_LIMITS.defaultListLimit;
  if (Number.isNaN(limit) || limit <= 0) return 1;
  return Math.min(Math.trunc(limit), STATISTICS_LIMITS.maxListLimit);
}
