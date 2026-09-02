/**
 * M7.7 strict, versioned SmartCollection query definition.
 *
 * A collection's `query` is a small allowlisted JSON object that the service
 * evaluates against real DocumentRecord and DocumentTag data. The grammar is
 * deliberately not a general expression language: there is no eval, no
 * Function, no user-supplied property path and no raw SQL fragment or arbitrary
 * Prisma `where` object. Every field, operator and value is checked against
 * this file's constants before it may reach a predicate, and the depth and
 * count caps exist so that one malformed query cannot describe an expensive
 * evaluation.
 *
 * The schema version is persisted with the definition so an older row stays
 * readable — and so a future grammar change can be introduced without breaking
 * collections that were validated under the current one.
 */

import type { DocumentRecordLifecycleState } from "./DocumentRecord";

export const SMART_COLLECTION_LIMITS = {
  /** Longest accepted collection name, in code points. */
  maxNameLength: 160,
  /** Current query grammar version. */
  queryVersion: 1,
  /** Longest accepted serialized query definition. */
  maxQueryBytes: 8192,
  /** Deepest allowed condition nesting (a top-level `all` counts as level 1). */
  maxDepth: 4,
  /** Most atomic conditions one query may carry, counted across all groups. */
  maxConditions: 32,
  /** Longest accepted term in a name-matching condition. */
  maxTermLength: 200,
  /** Longest accepted id in any id-valued condition. */
  maxIdLength: 128,
  /** Most tags one tag condition may name. */
  maxTagsPerCondition: 25,
  /** Most results a preview may return. */
  maxResults: 100,
  /** Most collections returned in a single listing. */
  maxListLimit: 100,
  /** Default listing size when a caller does not ask for one. */
  defaultListLimit: 50,
} as const;

/** Fields the query grammar may match on. Unknown fields are rejected. */
export const QUERY_FIELDS = [
  "name", // normalized document name, substring match
  "lifecycleState", // active | archived | trashed
  "favorite", // boolean
  "projectId", // id
  "folderId", // id
  "tags", // tag ids; membership requires all named tags
  "createdAt", // date range
  "updatedAt", // date range
  "createdById", // id
] as const;
export type QueryField = (typeof QUERY_FIELDS)[number];

/** Operators each field may use. Anything else is rejected. */
export const QUERY_OPERATORS = ["eq", "contains", "in", "range"] as const;
export type QueryOperator = (typeof QUERY_OPERATORS)[number];

/** Fields that take a date range. */
const RANGE_FIELDS: ReadonlySet<string> = new Set(["createdAt", "updatedAt"]);
/** Fields that take a bounded set of ids. */
const IN_FIELDS: ReadonlySet<string> = new Set(["tags", "projectId", "folderId"]);
/** Fields matched by a normalized substring. */
const CONTAINS_FIELDS: ReadonlySet<string> = new Set(["name"]);

export type SortField = "name" | "createdAt" | "updatedAt";
export type SortOrder = "asc" | "desc";

export const COLLECTION_SORT_FIELDS: readonly SortField[] = ["name", "createdAt", "updatedAt"];
export const COLLECTION_SORT_ORDERS: readonly SortOrder[] = ["asc", "desc"];

/** One bounded atomic condition. */
export interface CollectionCondition {
  field: QueryField;
  operator: QueryOperator;
  /** String value for eq/contains, boolean for favorite, array for in. */
  value: string | boolean | string[];
  /** Inclusive bounds for a range condition; both are optional but at least one must be present. */
  from?: string;
  to?: string;
}

export interface CollectionGroup {
  /** "all" — every condition must match. "any" — at least one must match. */
  mode: "all" | "any";
  /** Atomic conditions in this group. */
  conditions: CollectionCondition[];
  /** Nested groups, bounded in count and depth by SMART_COLLECTION_LIMITS. */
  groups?: CollectionGroup[];
}

export interface CollectionSort {
  field: SortField;
  order: SortOrder;
}

/** A validated query definition, ready to be persisted as JSON. */
export interface SmartCollectionQuery {
  version: number;
  root: CollectionGroup;
  sort?: CollectionSort;
  /** Cap on results when the collection is previewed or evaluated. */
  limit?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Membership tests written as type predicates rather than bare `includes`
 * calls: the allowlist is what proves the value is a grammar term, so it should
 * also be what narrows the type. A cast would let an unchecked string through
 * the same door later on.
 */
function isQueryField(value: unknown): value is QueryField {
  return typeof value === "string" && (QUERY_FIELDS as readonly string[]).includes(value);
}

function isQueryOperator(value: unknown): value is QueryOperator {
  return typeof value === "string" && (QUERY_OPERATORS as readonly string[]).includes(value);
}

function isSortField(value: unknown): value is SortField {
  return typeof value === "string" && (COLLECTION_SORT_FIELDS as readonly string[]).includes(value);
}

function isSortOrder(value: unknown): value is SortOrder {
  return typeof value === "string" && (COLLECTION_SORT_ORDERS as readonly string[]).includes(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Normalized identifier: trimmed and bounded, so a lookup cannot carry whitespace. */
export function boundedQueryId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > SMART_COLLECTION_LIMITS.maxIdLength) return null;
  return trimmed;
}

function boundedTerm(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > SMART_COLLECTION_LIMITS.maxTermLength) return null;
  return trimmed;
}

function boundedIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length > 40) return null;
  const timestamp = Date.parse(value);
  // A valid timestamp with NaN proves the string was not a date at all; a date
  // before the Unix epoch is rejected because it cannot be represented as a JS
  // Date and so could never match a stored column.
  if (Number.isNaN(timestamp)) return null;
  if (timestamp < 0) return null;
  return value;
}

function boundedTags(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0 || value.length > SMART_COLLECTION_LIMITS.maxTagsPerCondition) return null;
  const ids: string[] = [];
  for (const item of value) {
    const id = boundedQueryId(item);
    if (id === null) return null;
    if (ids.includes(id)) continue; // duplicates collapse rather than inflate the count
    ids.push(id);
  }
  return ids;
}

/**
 * Parses one condition. Returns null when anything is unknown, malformed or
 * out of bounds — never silently drops a condition, because a query that
 * appears to filter on a field it does not actually filter on is a query that
 * returns the wrong membership.
 */
function parseCondition(raw: unknown): CollectionCondition | null {
  if (!isObject(raw)) return null;
  const field = raw.field;
  if (!isQueryField(field)) return null;
  const operator = raw.operator;
  if (!isQueryOperator(operator)) return null;

  // Field/operator matrix: every pair is either allowed here or rejected.
  if (RANGE_FIELDS.has(field)) {
    if (operator !== "range") return null;
    if (hasOwn(raw, "value")) return null;
    const from = raw.from === undefined || raw.from === null ? null : boundedIsoDate(raw.from);
    const to = raw.to === undefined || raw.to === null ? null : boundedIsoDate(raw.to);
    if (from === null && raw.from !== undefined && raw.from !== null) return null;
    if (to === null && raw.to !== undefined && raw.to !== null) return null;
    if (from === null && to === null) return null;
    return { field, operator: "range", value: "", from: from ?? undefined, to: to ?? undefined };
  }
  if (IN_FIELDS.has(field)) {
    if (operator !== "in") return null;
    if (hasOwn(raw, "from") || hasOwn(raw, "to")) return null;
    const value = boundedTags(raw.value);
    if (value === null) return null;
    return { field, operator: "in", value };
  }
  if (CONTAINS_FIELDS.has(field)) {
    if (operator !== "contains") return null;
    if (hasOwn(raw, "from") || hasOwn(raw, "to")) return null;
    const value = boundedTerm(raw.value);
    if (value === null) return null;
    return { field, operator: "contains", value };
  }
  // Remaining fields use eq.
  if (operator !== "eq") return null;
  if (hasOwn(raw, "from") || hasOwn(raw, "to")) return null;
  switch (field) {
    case "favorite": {
      if (typeof raw.value !== "boolean") return null;
      return { field, operator: "eq", value: raw.value };
    }
    case "lifecycleState": {
      if (typeof raw.value !== "string") return null;
      const state = raw.value as DocumentRecordLifecycleState;
      if (state !== "active" && state !== "archived" && state !== "trashed") return null;
      return { field, operator: "eq", value: state };
    }
    case "projectId":
    case "folderId":
    case "createdById": {
      const id = boundedQueryId(raw.value);
      if (id === null) return null;
      return { field, operator: "eq", value: id };
    }
    default:
      return null;
  }
}

/**
 * Parses and bounds a group, enforcing the depth and condition caps. Returns
 * null on any violation; the caps count conditions across nested groups, so a
 * query with many shallow groups cannot smuggle in more atomic conditions than
 * one deep query.
 */
function parseGroup(
  raw: unknown,
  depth: number,
  state: { conditions: number },
): CollectionGroup | null {
  if (depth > SMART_COLLECTION_LIMITS.maxDepth) return null;
  if (!isObject(raw)) return null;
  const mode = raw.mode;
  if (mode !== "all" && mode !== "any") return null;

  const conditions: CollectionCondition[] = [];
  if (raw.conditions !== undefined) {
    if (!Array.isArray(raw.conditions)) return null;
    if (raw.conditions.length === 0) return null;
    for (const item of raw.conditions) {
      const condition = parseCondition(item);
      if (condition === null) return null;
      state.conditions += 1;
      if (state.conditions > SMART_COLLECTION_LIMITS.maxConditions) return null;
      conditions.push(condition);
    }
  }

  const groups: CollectionGroup[] = [];
  if (raw.groups !== undefined) {
    if (!Array.isArray(raw.groups)) return null;
    if (raw.groups.length === 0) return null;
    for (const item of raw.groups) {
      const group = parseGroup(item, depth + 1, state);
      if (group === null) return null;
      groups.push(group);
    }
  }

  if (raw.conditions === undefined && raw.groups === undefined) return null;
  // The parsed forms are returned, never the caller's objects: the persisted
  // definition is then exactly what the evaluator understands, and unknown
  // sibling properties cannot ride along into storage.
  return { mode, conditions, ...(groups.length === 0 ? {} : { groups }) };
}

function parseSort(raw: unknown): CollectionSort | null {
  if (!isObject(raw)) return null;
  const field = raw.field;
  const order = raw.order;
  if (!isSortField(field)) return null;
  if (!isSortOrder(order)) return null;
  return { field, order };
}

/**
 * Validates and bounds a caller-supplied query definition.
 *
 * Returns a canonical `SmartCollectionQuery` — never the caller's object — so
 * the persisted form is exactly the form the evaluator understands, and so a
 * caller object with extra fields cannot smuggle anything into storage.
 */
export function parseSmartCollectionQuery(input: unknown): SmartCollectionQuery | null {
  if (!isObject(input)) return null;
  if (input.version !== SMART_COLLECTION_LIMITS.queryVersion) return null;
  const serialized = JSON.stringify(input);
  if (serialized.length > SMART_COLLECTION_LIMITS.maxQueryBytes) return null;

  const root = parseGroup(input.root, 1, { conditions: 0 });
  if (root === null) return null;

  // Parsed into a narrowed local rather than a nullable one: a `null` here means
  // the caller sent a sort clause the grammar does not accept, which rejects the
  // whole query instead of quietly dropping the ordering they asked for.
  let sort: CollectionSort | undefined;
  if (input.sort !== undefined) {
    const parsedSort = parseSort(input.sort);
    if (parsedSort === null) return null;
    sort = parsedSort;
  }

  let limit: number | undefined;
  if (input.limit !== undefined) {
    if (typeof input.limit !== "number" || !Number.isInteger(input.limit)) return null;
    if (input.limit < 1 || input.limit > SMART_COLLECTION_LIMITS.maxResults) return null;
    limit = input.limit;
  }

  return {
    version: SMART_COLLECTION_LIMITS.queryVersion,
    root,
    ...(sort === undefined ? {} : { sort }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/**
 * Parses a persisted query string. Unknown versions are rejected outright —
 * an unreadable definition must not silently evaluate to "everything".
 * Returns null when the row cannot be parsed within bounds.
 */
export function parseStoredSmartCollectionQuery(stored: string): SmartCollectionQuery | null {
  if (stored.length > SMART_COLLECTION_LIMITS.maxQueryBytes) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!isObject(raw) || typeof raw.version !== "number") return null;
  if (raw.version !== SMART_COLLECTION_LIMITS.queryVersion) return null;
  return parseSmartCollectionQuery(raw);
}

/** The collection-name validator, mirroring tag-name rules. */
export function validateCollectionName(
  value: unknown,
): { name: string; normalizedName: string } | null {
  if (typeof value !== "string") return null;
  const name = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!name) return null;
  if ([...name].length > SMART_COLLECTION_LIMITS.maxNameLength) return null;
  const normalizedName = name.toLowerCase();
  if (!normalizedName) return null;
  return { name, normalizedName };
}

/**
 * A saved SmartCollection.
 *
 * Membership is *not* stored: there are no persisted document rows for a
 * collection. The query is re-evaluated against live DocumentRecord and
 * DocumentTag data on every read, which is what makes membership dynamic —
 * tagging a document changes what the collection contains without any write to
 * the collection itself.
 */
export interface SmartCollection {
  id: string;
  organizationId: string;
  workspaceId: string;
  name: string;
  normalizedName: string;
  /** Grammar version the definition was validated under. */
  queryVersion: number;
  /** Validated, canonical serialized query definition. */
  query: SmartCollectionQuery;
  /**
   * True when the stored definition could not be parsed within bounds. The
   * collection still appears in listings — hiding it would misrepresent the
   * Workspace as not having it — but it evaluates to no documents rather than
   * to everything.
   */
  queryDegraded: boolean;
  createdById: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Resolves a caller-supplied listing limit, shared by both adapters so a
 * listing cannot be wider in one than the other.
 */
export function collectionListLimit(limit: number): number {
  if (Number.isNaN(limit) || limit <= 0) return 1;
  return Math.min(Math.trunc(limit), SMART_COLLECTION_LIMITS.maxListLimit);
}

/** Resolves the result cap for an evaluation, honouring the query's own limit. */
export function collectionResultLimit(requested: number | undefined, query: SmartCollectionQuery): number {
  const ceiling = query.limit ?? SMART_COLLECTION_LIMITS.maxResults;
  if (requested === undefined || Number.isNaN(requested) || requested <= 0) return ceiling;
  return Math.min(Math.trunc(requested), ceiling, SMART_COLLECTION_LIMITS.maxResults);
}

/** The empty definition an unreadable row degrades to: matches nothing. */
export function emptyQuery(): SmartCollectionQuery {
  return {
    version: SMART_COLLECTION_LIMITS.queryVersion,
    root: { mode: "all", conditions: [] },
  };
}
