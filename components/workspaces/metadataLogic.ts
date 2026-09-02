/**
 * Pure logic for the M7.9 document properties UI.
 *
 * Extracted from the component so every validator, selector and reducer is
 * testable in Node without a DOM. The domain's own bounds and validators are
 * imported rather than restated: a second copy of the rules here would
 * eventually disagree with the server, and the looser of the two would decide
 * what the user is allowed to type.
 *
 * The organizing distinction, as everywhere in M7.9, is **origin**. A
 * `workspace` record is ours and editable; an `embedded` record mirrors a
 * structure inside the PDF bytes and is read-only in this build. This module
 * exposes that as `isEditableOrigin`, and the component asks it rather than
 * deciding for itself — a panel that offers an edit for an embedded record
 * invites a change no write path can honour.
 */

import {
  METADATA_KEYS,
  METADATA_LIMITS,
  buildOutlineTree,
  canWriteEmbedded,
  isMetadataKey,
  safeDownloadType,
  validateAttachmentName,
  validateMetadataValue,
  validateNote,
  validatePageNumber,
  validateTitle,
  type MetadataFields,
  type MetadataKey,
  type MetadataOrigin,
  type OutlineItem,
} from "@/src/domain/entities/DocumentMetadata";

/** A metadata field as the form holds it: always a string, because inputs are. */
export type MetadataDraft = Record<string, string>;

/** Human labels for the allowlisted metadata keys. */
export const METADATA_FIELD_LABELS: Readonly<Record<MetadataKey, string>> = {
  title: "Title",
  author: "Author",
  subject: "Subject",
  keywords: "Keywords",
  category: "Category",
  company: "Company",
  manager: "Manager",
  comments: "Comments",
  status: "Status",
  documentType: "Document type",
  language: "Language",
  copyright: "Copyright",
};

/** The editable fields, in display order. */
export function metadataFieldOrder(): readonly MetadataKey[] {
  return METADATA_KEYS;
}

/** Seeds the form from the server's field map; absent keys become empty inputs. */
export function draftFromFields(fields: MetadataFields | null): MetadataDraft {
  const draft: MetadataDraft = {};
  for (const key of METADATA_KEYS) draft[key] = fields?.[key] ?? "";
  return draft;
}

export interface MetadataFieldError {
  key: string;
  reason: string;
}

/**
 * Validates the whole draft.
 *
 * Unknown keys are reported rather than dropped, matching the service: silently
 * discarding a field the user typed reads as a save that worked. Cleared fields
 * are omitted from the payload, so "set to empty" and "not set" converge on one
 * representation — the same convergence the domain performs.
 */
export function validateMetadataDraft(
  draft: MetadataDraft,
): { ok: true; fields: MetadataFields } | { ok: false; errors: MetadataFieldError[] } {
  const errors: MetadataFieldError[] = [];
  const fields: MetadataFields = {};

  const entries = Object.entries(draft);
  if (entries.length > METADATA_LIMITS.maxFields) {
    return {
      ok: false,
      errors: [
        {
          key: "*",
          reason: `A document may carry at most ${METADATA_LIMITS.maxFields} metadata fields.`,
        },
      ],
    };
  }

  for (const [key, raw] of entries) {
    if (!isMetadataKey(key)) {
      errors.push({ key, reason: "This property is not supported." });
      continue;
    }
    const value = validateMetadataValue(raw);
    if (value === null) {
      errors.push({
        key,
        reason: `Use at most ${METADATA_LIMITS.maxValueLength} characters, without control characters.`,
      });
      continue;
    }
    if (value === "") continue;
    fields[key] = value;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, fields };
}

/** Whether records of this origin may be edited in this build. */
export function isEditableOrigin(origin: MetadataOrigin, kind: "metadata" | "outline" | "attachments"): boolean {
  if (origin === "workspace") return true;
  return canWriteEmbedded(kind);
}

/** The label a section shows for where a record came from. */
export function originLabel(origin: MetadataOrigin): string {
  return origin === "workspace" ? "Workspace" : "In this PDF";
}

/**
 * The explanation shown beside a read-only embedded record.
 *
 * Says why rather than only that: "read-only" alone reads as a permission
 * problem the user might solve by asking an administrator.
 */
export function readOnlyExplanation(kind: "metadata" | "outline" | "attachments"): string {
  const noun =
    kind === "metadata" ? "These properties are" : kind === "outline" ? "This outline is" : "This attachment is";
  return `${noun} part of the PDF file itself. Editing it would require rewriting the document, which this release does not do.`;
}

// ---- bookmarks -------------------------------------------------------------

export interface BookmarkDraftState {
  pageNumber: string;
  title: string;
  note: string;
}

export function emptyBookmarkDraft(): BookmarkDraftState {
  return { pageNumber: "", title: "", note: "" };
}

export interface ValidBookmarkDraft {
  pageNumber: number;
  title: string;
  note: string | null;
}

/**
 * Validates a bookmark form.
 *
 * The page is parsed from a string because that is what an input yields, and a
 * non-numeric page is rejected rather than coerced — `Number("")` is 0, which
 * would silently become a page the document does not have.
 */
export function validateBookmarkDraft(
  draft: BookmarkDraftState,
): { ok: true; draft: ValidBookmarkDraft } | { ok: false; field: "pageNumber" | "title" | "note"; reason: string } {
  const trimmedPage = draft.pageNumber.trim();
  if (trimmedPage === "" || !/^\d+$/u.test(trimmedPage)) {
    return { ok: false, field: "pageNumber", reason: "Enter a page number of at least 1." };
  }
  const pageNumber = validatePageNumber(Number(trimmedPage));
  if (pageNumber === null) {
    return {
      ok: false,
      field: "pageNumber",
      reason: `Enter a page between 1 and ${METADATA_LIMITS.maxPageNumber}.`,
    };
  }
  const title = validateTitle(draft.title);
  if (title === null) {
    return {
      ok: false,
      field: "title",
      reason: `A title is required and must be at most ${METADATA_LIMITS.maxTitleLength} characters.`,
    };
  }
  const note = validateNote(draft.note);
  if (note === null) {
    return {
      ok: false,
      field: "note",
      reason: `A note must be at most ${METADATA_LIMITS.maxNoteLength} characters.`,
    };
  }
  return { ok: true, draft: { pageNumber, title, note: note ?? null } };
}

export interface BookmarkView {
  id: string;
  pageNumber: number;
  title: string;
  note: string | null;
  orderKey: string;
  revision: number;
}

/**
 * Display order for bookmarks: the stored order key, with the id as a total
 * tie-break. Two bookmarks can share a key after a concurrent append, and a list
 * that reorders between renders makes keyboard navigation jump.
 */
export function sortBookmarks(bookmarks: BookmarkView[]): BookmarkView[] {
  return [...bookmarks].sort(
    (a, b) => a.orderKey.localeCompare(b.orderKey) || a.id.localeCompare(b.id),
  );
}

// ---- outline ---------------------------------------------------------------

export interface OutlineRow {
  item: OutlineItem;
  depth: number;
  hasChildren: boolean;
}

/**
 * Flattens the outline into rows for a `tree`-role listbox.
 *
 * Depth comes from the assembled tree rather than the stored column, because the
 * parent links are the structure and a stored depth can disagree with them after
 * a move. Rendering the stored value would indent a node into a position it does
 * not occupy.
 */
export function outlineRows(items: OutlineItem[]): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const visit = (nodes: ReturnType<typeof buildOutlineTree>, depth: number): void => {
    for (const node of nodes) {
      rows.push({
        item: { ...node, depth },
        depth,
        hasChildren: node.children.length > 0,
      });
      visit(node.children, depth + 1);
    }
  };
  visit(buildOutlineTree(items), 0);
  return rows;
}

/** Whether a new child may be nested under this row without exceeding the cap. */
export function canNestUnder(row: OutlineRow): boolean {
  if (!isEditableOrigin(row.item.origin, "outline")) return false;
  return row.depth + 1 <= METADATA_LIMITS.maxOutlineDepth;
}

/** Indentation for a tree row, in rem, bounded by the domain's depth cap. */
export function outlineIndentRem(depth: number): number {
  const bounded = Math.max(0, Math.min(depth, METADATA_LIMITS.maxOutlineDepth));
  return bounded * 1.25;
}

/**
 * Which outline entry to highlight as "where you are" for a given page (H33).
 *
 * The entry that STARTS the current page, or failing that the nearest preceding
 * one — an outline names section starts, so on page 7 of a section beginning at
 * page 5 the correct answer is that section, not nothing.
 *
 * Returns an index into the array as given, not an id, so a caller can highlight
 * without a second lookup. `-1` means "no entry applies", which is a real answer:
 * a page before the first outline entry is genuinely outside the outline, and
 * highlighting the first entry there would claim the reader is inside a section
 * they have not reached.
 *
 * Document order is assumed rather than re-sorted: the route returns the outline
 * in its stored order, and sorting by page here would reorder a legitimately
 * non-monotonic outline (an appendix cross-reference) into a sequence the document
 * does not have.
 */
export function currentOutlineIndex(
  items: ReadonlyArray<{ pageNumber: number }>,
  currentPage: number | null,
): number {
  if (currentPage === null || !Number.isFinite(currentPage)) return -1;
  let best = -1;
  let bestPage = -Infinity;
  for (let index = 0; index < items.length; index += 1) {
    const page = items[index].pageNumber;
    if (!Number.isFinite(page) || page > currentPage) continue;
    // `>=` so that with several entries on the same page the LAST one wins —
    // that is the section the reader is currently inside.
    if (page >= bestPage) {
      bestPage = page;
      best = index;
    }
  }
  return best;
}

// ---- attachments -----------------------------------------------------------

/**
 * Formats a byte count for display.
 *
 * Binary units, because that is what a file manager shows for the same file, and
 * a single decimal place above the kilobyte — "1.4 MB" is informative where
 * "1.43871 MB" is noise.
 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.trunc(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export interface AttachmentView {
  id: string;
  origin: MetadataOrigin;
  name: string;
  description: string | null;
  mimeType: string;
  byteSize: number;
  /** False for an embedded attachment catalogued but never extracted. */
  downloadable: boolean;
  revision: number;
}

/**
 * Validates an attachment filename in the form.
 *
 * The same validator the server uses, so a name the UI accepts is a name the
 * server accepts: path separators, control characters and embedded content URLs
 * are refused here for the same reason they are refused there.
 */
export function validateAttachmentFilename(
  value: string,
): { ok: true; name: string } | { ok: false; reason: string } {
  const parts = validateAttachmentName(value);
  if (!parts) {
    return {
      ok: false,
      reason: `Enter a filename of at most ${METADATA_LIMITS.maxAttachmentNameLength} characters, without slashes or backslashes.`,
    };
  }
  return { ok: true, name: parts.name };
}

/** Whether a download button should be offered for this attachment at all. */
export function canDownload(attachment: AttachmentView): boolean {
  return attachment.downloadable;
}

/** What the list says about an embedded attachment whose bytes were never extracted. */
export function unavailableReason(attachment: AttachmentView): string | null {
  if (attachment.downloadable) return null;
  return "This attachment is inside the PDF and has not been extracted, so it cannot be downloaded.";
}

/**
 * Whether the browser would be told to treat this type as something other than
 * what it claims. Surfaced in the UI so a user is not surprised that a `.html`
 * attachment downloads as a generic file — that narrowing is deliberate, and
 * explaining it beats looking broken.
 */
export function isDownloadTypeNarrowed(mimeType: string): boolean {
  return safeDownloadType(mimeType) !== mimeType.trim().toLowerCase();
}

/** The type a download will actually be served as. */
export function downloadTypeLabel(mimeType: string): string {
  return safeDownloadType(mimeType);
}

/** Whether another attachment can be added within the per-document limits. */
export function canAddAttachment(count: number, usedBytes: number, limitBytes: number): boolean {
  if (count >= METADATA_LIMITS.maxAttachmentsPerDocument) return false;
  return usedBytes < limitBytes;
}

// ---- request and section state --------------------------------------------

/** What a panel section is currently showing. */
export type SectionPhase = "idle" | "loading" | "ready" | "empty" | "error";

/**
 * Which state a section renders.
 *
 * Empty and error are distinguished from loading because they mean different
 * things to the user: a spinner that never resolves and "no bookmarks yet" are
 * not interchangeable, and neither is a failed request.
 */
export function sectionPhase(input: {
  loading: boolean;
  error: string | null;
  count: number;
  loaded: boolean;
}): SectionPhase {
  if (input.loading) return "loading";
  if (input.error !== null) return "error";
  if (!input.loaded) return "idle";
  return input.count === 0 ? "empty" : "ready";
}

export type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "invalid"; errors: MetadataFieldError[] }
  | { kind: "conflict" }
  | { kind: "failed"; message: string };

/**
 * Whether a failed save was a lost race rather than a rejection.
 *
 * A conflict is recoverable by reloading and re-applying, so it earns its own
 * state and its own message; showing it as a generic failure would tell the user
 * to retry the thing that just lost.
 */
export function isConflictMessage(message: string): boolean {
  return /changed since (they were|it was) loaded/iu.test(message);
}

/** Maps a server error message onto the save state the panel should show. */
export function saveStateFromError(message: string): SaveState {
  if (isConflictMessage(message)) return { kind: "conflict" };
  return { kind: "failed", message };
}

/**
 * Whether a keyboard event should activate a row.
 *
 * Enter and Space both activate, matching native button behaviour — a list row
 * that responds only to Enter is unreachable for users who expect Space.
 */
export function isActivationKey(key: string): boolean {
  return key === "Enter" || key === " " || key === "Spacebar";
}

/** Whether the panel should stack its sections rather than sit them side by side. */
export function isNarrowLayout(width: number): boolean {
  return Number.isFinite(width) && width < 768;
}
