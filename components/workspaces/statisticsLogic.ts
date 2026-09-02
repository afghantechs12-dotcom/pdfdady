import {
  COMPARISON_TYPES,
  STATISTICS_LIMITS,
  isComparisonSupported,
  unsupportedComparisonReason,
  type ComparisonStatus,
  type ComparisonType,
  type StatisticsStatus,
} from "@/src/domain/entities/DocumentStatistics";

/**
 * Presentation logic for the M7.11 statistics and comparison panel.
 *
 * Separated from the React component so the rules can be tested without a DOM:
 * how an unmeasured count reads, when a comparison may be cancelled or retried,
 * what the progress region announces, and which comparison types this build can
 * honestly offer.
 *
 * Two rules run through all of it. A count that was not measured reads as "Not
 * measured", never as "0" — the domain keeps those apart and the UI must not
 * collapse them. And a comparison is only ever described as completed when a
 * real result exists; a status alone is not enough, because a client that
 * rendered "completed" from the status could show an empty diff as "no
 * differences found".
 */

// ---- statistics presentation ------------------------------------------------

export interface StatisticsCountsView {
  pageCount: number | null;
  textCharacterCount: number | null;
  wordCount: number | null;
  imageCount: number | null;
  annotationCount: number | null;
  bookmarkCount: number | null;
  attachmentCount: number | null;
  fileSize: number | null;
}

export interface StatisticsRowView {
  key: string;
  label: string;
  /** Display text. "Not measured" when the value is null. */
  value: string;
  /** True when nothing was measured, so the row can be styled as absent. */
  unmeasured: boolean;
}

/** The label shown wherever a count was never measured. */
export const NOT_MEASURED_LABEL = "Not measured";

/**
 * Formats one count.
 *
 * Null becomes "Not measured" rather than "0": a document nobody scanned for
 * images must not report confidently that it has none.
 */
export function formatCount(value: number | null): string {
  if (value === null) return NOT_MEASURED_LABEL;
  return value.toLocaleString("en-US");
}

/** Formats a byte size in units a reader can act on. Null stays unmeasured. */
export function formatFileSize(bytes: number | null): string {
  if (bytes === null) return NOT_MEASURED_LABEL;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** The statistics rows a panel renders, in display order. */
export function statisticsRows(counts: StatisticsCountsView): StatisticsRowView[] {
  return [
    { key: "pageCount", label: "Pages", value: formatCount(counts.pageCount), unmeasured: counts.pageCount === null },
    {
      key: "wordCount",
      label: "Words",
      value: formatCount(counts.wordCount),
      unmeasured: counts.wordCount === null,
    },
    {
      key: "textCharacterCount",
      label: "Characters",
      value: formatCount(counts.textCharacterCount),
      unmeasured: counts.textCharacterCount === null,
    },
    {
      key: "imageCount",
      label: "Images",
      value: formatCount(counts.imageCount),
      unmeasured: counts.imageCount === null,
    },
    {
      key: "annotationCount",
      label: "Annotations",
      value: formatCount(counts.annotationCount),
      unmeasured: counts.annotationCount === null,
    },
    {
      key: "bookmarkCount",
      label: "Bookmarks",
      value: formatCount(counts.bookmarkCount),
      unmeasured: counts.bookmarkCount === null,
    },
    {
      key: "attachmentCount",
      label: "Attachments",
      value: formatCount(counts.attachmentCount),
      unmeasured: counts.attachmentCount === null,
    },
    {
      key: "fileSize",
      label: "File size",
      value: formatFileSize(counts.fileSize),
      unmeasured: counts.fileSize === null,
    },
  ];
}

/** The status line for a statistics row. */
export function statisticsStatusLabel(status: StatisticsStatus, calculatedAt: string | null): string {
  if (status === "failed") return "Could not be calculated";
  if (status === "pending") return "Calculation pending";
  if (calculatedAt === null) return "Calculated";
  return `Calculated ${formatTimestamp(calculatedAt)}`;
}

/** Whether the panel should offer a recalculate action. */
export function canRecalculate(busy: boolean, canWrite: boolean): boolean {
  return !busy && canWrite;
}

// ---- comparison presentation ------------------------------------------------

export interface ComparisonView {
  id: string;
  type: ComparisonType;
  status: ComparisonStatus;
  progress: number;
  cancelRequested: boolean;
  hasResult: boolean;
  error: string | null;
}

/** Human status text for a comparison. */
export function comparisonStatusLabel(view: ComparisonView): string {
  switch (view.status) {
    case "pending":
      return view.cancelRequested ? "Cancelling…" : "Waiting to start";
    case "running":
      return view.cancelRequested ? "Cancelling…" : `Comparing… ${view.progress}%`;
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

/**
 * Whether the completed result may be shown.
 *
 * Both conditions, deliberately: a status of "completed" with no result row is
 * a state a redelivered or interrupted worker can produce, and rendering it as a
 * finished comparison would show an empty diff as "no differences found".
 */
export function canShowResult(view: ComparisonView): boolean {
  return view.status === "completed" && view.hasResult;
}

/** Whether a comparison is still active and so may be cancelled. */
export function canCancel(view: ComparisonView): boolean {
  if (view.status !== "pending" && view.status !== "running") return false;
  // A second press would be a no-op; the request is already recorded.
  return !view.cancelRequested;
}

/** Whether a finished comparison may be retried. */
export function canRetry(view: ComparisonView): boolean {
  return view.status === "failed" || view.status === "cancelled";
}

/** Whether a progress bar should be shown at all. */
export function showsProgress(view: ComparisonView): boolean {
  return view.status === "pending" || view.status === "running";
}

/**
 * The accessible announcement for a comparison's state.
 *
 * Assembled here rather than in the component so the live region says the same
 * thing the visible status says — a mismatch between them is a bug a screen
 * reader user experiences and a sighted user never sees.
 */
export function comparisonAnnouncement(view: ComparisonView): string {
  const type = comparisonTypeLabel(view.type);
  if (view.status === "completed") {
    return view.hasResult
      ? `${type} comparison completed.`
      : `${type} comparison finished, but no result is available.`;
  }
  if (view.status === "failed") {
    return `${type} comparison failed. ${view.error ?? ""}`.trim();
  }
  if (view.status === "cancelled") return `${type} comparison cancelled.`;
  if (view.status === "running") return `${type} comparison in progress, ${view.progress}%.`;
  return `${type} comparison waiting to start.`;
}

export function comparisonTypeLabel(type: ComparisonType): string {
  switch (type) {
    case "structural":
      return "Structural";
    case "textual":
      return "Textual";
    case "visual":
      return "Visual";
    case "editor":
      return "Editor";
  }
}

export interface ComparisonTypeOption {
  value: ComparisonType;
  label: string;
  /** False when this build cannot run it. The option stays visible, disabled. */
  supported: boolean;
  /** Why it is unavailable, when it is. */
  reason: string | null;
}

/**
 * The comparison types offered, including the ones this build cannot run.
 *
 * Unsupported types are shown disabled with a reason rather than hidden: a
 * missing option reads as a product that never had the feature, while a disabled
 * one with an explanation tells the user what is actually true.
 */
export function comparisonTypeOptions(): ComparisonTypeOption[] {
  return COMPARISON_TYPES.map((type) => ({
    value: type,
    label: comparisonTypeLabel(type),
    supported: isComparisonSupported(type),
    reason: unsupportedComparisonReason(type),
  }));
}

export interface ComparisonDraft {
  leftVersionId: string;
  rightVersionId: string;
  type: ComparisonType;
}

export function emptyComparisonDraft(): ComparisonDraft {
  return { leftVersionId: "", rightVersionId: "", type: "textual" };
}

/**
 * Validates the comparison composer against the same rules the service applies.
 *
 * Shared rules rather than a parallel client list: a client that accepted what
 * the server refuses produces a button that always fails, and one that refused
 * what the server accepts silently removes a capability.
 */
export function validateComparisonDraft(
  draft: ComparisonDraft,
): { ok: true } | { ok: false; reason: string } {
  if (draft.leftVersionId === "" || draft.rightVersionId === "") {
    return { ok: false, reason: "Select two versions to compare." };
  }
  if (draft.leftVersionId === draft.rightVersionId) {
    return { ok: false, reason: "Select two different versions to compare." };
  }
  if (!isComparisonSupported(draft.type)) {
    return {
      ok: false,
      reason: unsupportedComparisonReason(draft.type) ?? "That comparison type is not available.",
    };
  }
  return { ok: true };
}

export function canSubmitComparison(draft: ComparisonDraft, busy: boolean): boolean {
  if (busy) return false;
  return validateComparisonDraft(draft).ok;
}

/** Whether the active-comparison limit has been reached. */
export function atActiveComparisonLimit(views: readonly ComparisonView[]): boolean {
  const active = views.filter((v) => v.status === "pending" || v.status === "running").length;
  return active >= STATISTICS_LIMITS.maxActiveComparisonsPerDocument;
}

/** A short summary of what a completed comparison found. */
export function summarizeDifferences(summary: {
  added: number;
  removed: number;
  changed: number;
  truncated: boolean;
}): string {
  const total = summary.added + summary.removed + summary.changed;
  if (total === 0) return "No differences found.";
  const parts: string[] = [];
  if (summary.added > 0) parts.push(`${summary.added} added`);
  if (summary.removed > 0) parts.push(`${summary.removed} removed`);
  if (summary.changed > 0) parts.push(`${summary.changed} changed`);
  // An honest note when the list was capped: a truncated list presented as
  // complete would read as "these are all the differences".
  const suffix = summary.truncated ? " (showing the first differences only)" : "";
  return `${parts.join(", ")}${suffix}`;
}

/** Maps a failed request to a message a user can act on. Never a stack trace. */
export function describeStatisticsError(status: number, message?: string): string {
  if (status === 401) return "Sign in to continue.";
  if (status === 403) return "You do not have permission to do that.";
  if (status === 404) return "That document is no longer available.";
  if (status === 409) return "That comparison has already finished.";
  if (status === 422) return message ?? "That input was not accepted.";
  if (status >= 500) return "Something went wrong on our side. Try again in a moment.";
  return message ?? "That action could not be completed.";
}

/** Comparisons newest first, so the most recent work is at the top. */
export function sortComparisonsForDisplay<T extends { createdAt: string; id: string }>(
  comparisons: readonly T[],
): T[] {
  return comparisons
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
