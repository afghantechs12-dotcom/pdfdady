/**
 * Pure logic for the tag and smart-collection UI.
 *
 * Extracted from the components so every reducer, selector and validator is
 * unit-testable in Node without a DOM or React. The domain's own bounds and
 * normalization are imported rather than restated: a second copy of the rules
 * here would eventually disagree with the server, and the looser of the two
 * would decide what the user is allowed to type.
 */

import { TAG_LIMITS, normalizeTagName, validateTagColor } from "@/src/domain/entities/Tag";
import {
  SMART_COLLECTION_LIMITS,
  parseSmartCollectionQuery,
  type CollectionCondition,
  type SmartCollectionQuery,
} from "@/src/domain/entities/SmartCollection";

export interface TagChipItem {
  id: string;
  name: string;
  color: string | null;
}

/** How a tag catalog entry appears in the management list. */
export interface TagCatalogItem extends TagChipItem {
  normalizedName: string;
  revision: number;
}

/**
 * A draft condition as the builder holds it — every value is a string because
 * that is what an input yields. It is converted to the domain shape only when
 * the query is assembled, and rejected there if it does not fit.
 */
export interface DraftCondition {
  field: string;
  operator: string;
  value: string;
  from: string;
  to: string;
  tagIds: string[];
}

export function emptyDraftCondition(): DraftCondition {
  return { field: "name", operator: "contains", value: "", from: "", to: "", tagIds: [] };
}

/** Which operator a field takes. The builder shows only the one that applies. */
export function operatorForField(field: string): string {
  if (field === "createdAt" || field === "updatedAt") return "range";
  if (field === "tags" || field === "projectId" || field === "folderId") return "in";
  if (field === "name") return "contains";
  return "eq";
}

/**
 * Turns one draft row into the domain condition shape. Returns null when the
 * row is incomplete, which the builder renders as "not ready" rather than as an
 * error — an empty row the user has not filled in yet is not a mistake.
 */
export function toCondition(draft: DraftCondition): CollectionCondition | null {
  const operator = operatorForField(draft.field);
  switch (operator) {
    case "range": {
      const from = draft.from.trim();
      const to = draft.to.trim();
      if (!from && !to) return null;
      return {
        field: draft.field as CollectionCondition["field"],
        operator: "range",
        value: "",
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      };
    }
    case "in": {
      const ids = draft.field === "tags" ? draft.tagIds : [draft.value.trim()].filter(Boolean);
      if (ids.length === 0) return null;
      return { field: draft.field as CollectionCondition["field"], operator: "in", value: ids };
    }
    case "contains": {
      const value = draft.value.trim();
      if (!value) return null;
      return { field: draft.field as CollectionCondition["field"], operator: "contains", value };
    }
    default: {
      if (draft.field === "favorite") {
        return {
          field: "favorite",
          operator: "eq",
          value: draft.value === "true",
        };
      }
      const value = draft.value.trim();
      if (!value) return null;
      return { field: draft.field as CollectionCondition["field"], operator: "eq", value };
    }
  }
}

/**
 * Assembles a draft query and validates it through the *same* grammar the
 * server uses, so the builder cannot present a query as valid that the API will
 * then reject.
 */
export function buildQuery(
  mode: "all" | "any",
  drafts: DraftCondition[],
  sort?: { field: string; order: string },
): SmartCollectionQuery | null {
  const conditions = drafts.map(toCondition).filter((c): c is CollectionCondition => c !== null);
  if (conditions.length === 0) return null;
  return parseSmartCollectionQuery({
    version: SMART_COLLECTION_LIMITS.queryVersion,
    root: { mode, conditions },
    ...(sort ? { sort } : {}),
  });
}

export type ValidationResult = { ok: true } | { ok: false; message: string };

/** Validates a tag name against the domain bounds and the Workspace's existing names. */
export function validateTagDraft(name: string, existing: TagCatalogItem[], selfId?: string): ValidationResult {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, message: "Enter a tag name." };
  if ([...trimmed].length > TAG_LIMITS.maxNameLength) {
    return { ok: false, message: `Use at most ${TAG_LIMITS.maxNameLength} characters.` };
  }
  const normalized = normalizeTagName(trimmed);
  if (!normalized) return { ok: false, message: "Enter a tag name." };
  // Compared on the normalized form, matching the server's uniqueness rule, so
  // the user learns about a collision before the request rather than after it.
  const clash = existing.some((tag) => tag.id !== selfId && tag.normalizedName === normalized);
  if (clash) return { ok: false, message: "A tag with this name already exists." };
  return { ok: true };
}

/** Validates a colour swatch, mirroring the domain's hex-triplet rule. */
export function validateColorDraft(color: string): ValidationResult {
  const result = validateTagColor(color);
  return result.ok ? { ok: true } : { ok: false, message: "Use a colour like #3366cc." };
}

/** Validates a collection draft, reporting the first reason it cannot be saved. */
export function validateCollectionDraft(
  name: string,
  mode: "all" | "any",
  drafts: DraftCondition[],
): ValidationResult {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, message: "Enter a collection name." };
  if ([...trimmed].length > SMART_COLLECTION_LIMITS.maxNameLength) {
    return { ok: false, message: `Use at most ${SMART_COLLECTION_LIMITS.maxNameLength} characters.` };
  }
  if (drafts.length > SMART_COLLECTION_LIMITS.maxConditions) {
    return {
      ok: false,
      message: `Use at most ${SMART_COLLECTION_LIMITS.maxConditions} conditions.`,
    };
  }
  const query = buildQuery(mode, drafts);
  if (query === null) {
    return { ok: false, message: "Add at least one complete condition." };
  }
  return { ok: true };
}

/** Whether one more tag can be added to a document. */
export function canAddTag(currentCount: number): boolean {
  return currentCount < TAG_LIMITS.maxTagsPerDocument;
}

/** Whether a bulk selection is within the batch bounds the server enforces. */
export function validateBulkSelection(documentIds: string[], tagIds: string[]): ValidationResult {
  if (tagIds.length === 0) return { ok: false, message: "Choose at least one tag." };
  if (documentIds.length === 0) return { ok: false, message: "Select at least one document." };
  if (tagIds.length > TAG_LIMITS.maxBulkTags) {
    return { ok: false, message: `Apply at most ${TAG_LIMITS.maxBulkTags} tags at a time.` };
  }
  if (documentIds.length > TAG_LIMITS.maxBulkDocuments) {
    return {
      ok: false,
      message: `Select at most ${TAG_LIMITS.maxBulkDocuments} documents at a time.`,
    };
  }
  return { ok: true };
}

/**
 * Filters the tag catalog by a typed term, matched on the normalized form so
 * the picker finds "Legal Review" when the user types "legal  REVIEW".
 */
export function filterTags(tags: TagCatalogItem[], term: string): TagCatalogItem[] {
  const normalized = normalizeTagName(term);
  if (!normalized) return tags;
  return tags.filter((tag) => tag.normalizedName.includes(normalized));
}

/** Toggles one id in a selection, returning a new array rather than mutating. */
export function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((existing) => existing !== id) : [...ids, id];
}

/** A readable contrast colour for text drawn on a tag swatch. */
export function readableTextColor(background: string | null): string {
  if (!background || !/^#[0-9a-f]{6}$/i.test(background)) return "#0f172a";
  const r = parseInt(background.slice(1, 3), 16);
  const g = parseInt(background.slice(3, 5), 16);
  const b = parseInt(background.slice(5, 7), 16);
  // Rec. 601 luma: dark text on light swatches, light text on dark ones.
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.6 ? "#0f172a" : "#ffffff";
}

/**
 * Summarizes a bulk result for the status line. Failures are named rather than
 * folded into a count, because "3 documents could not be tagged" without saying
 * which is a message the user cannot act on.
 */
export function summarizeBulkResult(result: {
  succeeded: string[];
  failed: Array<{ documentId: string; error: string }>;
}): string {
  const applied = `${result.succeeded.length} document${result.succeeded.length === 1 ? "" : "s"} updated`;
  if (result.failed.length === 0) return `${applied}.`;
  const names = result.failed
    .slice(0, 3)
    .map((entry) => entry.documentId)
    .join(", ");
  const more = result.failed.length > 3 ? ` and ${result.failed.length - 3} more` : "";
  return `${applied}. ${result.failed.length} failed: ${names}${more}.`;
}
