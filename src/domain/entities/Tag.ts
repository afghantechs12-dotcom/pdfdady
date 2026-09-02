/**
 * M7.7 tag domain types.
 *
 * A Tag is Workspace-scoped: two Workspaces may each hold a tag displayed as
 * "Contract" without collision, while within one Workspace the normalized name
 * is unique. Normalization is deterministic and locale-independent
 * (ADR-M7-012) rather than delegated to database collation, so the SQLite and
 * PostgreSQL adapters agree on what counts as a duplicate.
 *
 * A DocumentTag is the many-to-many assignment. It carries its own
 * `workspaceId` even though both sides already have one: that column is what
 * lets every repository predicate be Workspace-scoped without a join, and what
 * makes a cross-Workspace assignment unrepresentable rather than merely
 * unlikely.
 */

export const TAG_LIMITS = {
  /** Longest accepted display name, in code points. */
  maxNameLength: 120,
  /** Longest accepted presentation colour token. */
  maxColorLength: 32,
  /** Longest accepted identifier. Bounds every id that reaches a predicate. */
  maxIdLength: 128,
  /** Most tags returned in a single listing. */
  maxListLimit: 100,
  /** Default listing size when a caller does not ask for one. */
  defaultListLimit: 50,
  /** Most documents one bulk assignment or removal may touch. */
  maxBulkDocuments: 100,
  /** Most tags one bulk assignment or removal may apply. */
  maxBulkTags: 25,
  /** Most tags a single document may carry. */
  maxTagsPerDocument: 50,
} as const;

/**
 * Code points refused in a display name.
 *
 * C0/C1 controls would corrupt logs and any header a name reaches. Bidi
 * overrides and isolates let a name *render* as something other than what it
 * matches, which is how one tag is made to impersonate another (ADR-M7-012).
 *
 * Written as numeric ranges rather than a regex literal so the intent survives
 * any tooling that would rewrite escape sequences into the characters they
 * denote — an invisible control character inside a character class is exactly
 * the kind of thing that silently stops matching.
 */
const FORBIDDEN_CODE_POINT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], // C0 controls, including NUL
  [0x7f, 0x9f], // DEL and C1 controls
  [0x200e, 0x200f], // LRM / RLM
  [0x202a, 0x202e], // bidi embedding and override
  [0x2066, 0x2069], // bidi isolates
];

function hasForbiddenCodePoint(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined) continue;
    for (const [low, high] of FORBIDDEN_CODE_POINT_RANGES) {
      if (code >= low && code <= high) return true;
    }
  }
  return false;
}

/** Path separators are refused because names reach export paths. */
const PATH_SEPARATORS = /[/\\]/u;

/**
 * The normalized form used for uniqueness and matching.
 *
 * NFKC folds compatibility forms so a ligature and its expansion are one tag;
 * whitespace is collapsed so " A  B " and "a b" are one tag; case folding uses
 * `toLowerCase` rather than `toLocaleLowerCase`, so a server's locale can never
 * change which names collide.
 */
export function normalizeTagName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

export interface TagNameParts {
  /** Display form, preserved after validation. */
  name: string;
  /** Matching form, unique within a Workspace. */
  normalizedName: string;
}

/**
 * Validates a caller-supplied display name. Returns null rather than throwing,
 * so the service rejects with its own error type and wording.
 */
export function validateTagName(value: unknown): TagNameParts | null {
  if (typeof value !== "string") return null;
  const name = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!name) return null;
  // Code points, not UTF-16 units: a name of 120 emoji is 120 characters.
  if ([...name].length > TAG_LIMITS.maxNameLength) return null;
  if (hasForbiddenCodePoint(name) || PATH_SEPARATORS.test(name)) return null;
  // A dot-only name is refused: it is indistinguishable from a path segment.
  if (/^\.+$/u.test(name)) return null;
  const normalizedName = normalizeTagName(name);
  if (!normalizedName) return null;
  return { name, normalizedName };
}

/**
 * Presentation colour, restricted to a hex triplet.
 *
 * An arbitrary CSS colour string reaches a style attribute, which is an
 * injection surface, and no requirement needs more than a swatch. Absence and
 * rejection are separated so "no colour" is not confused with "bad colour".
 */
export function validateTagColor(
  value: unknown,
): { ok: true; color: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, color: null };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, color: null };
  if (trimmed.length > TAG_LIMITS.maxColorLength) return { ok: false };
  return /^#[0-9a-f]{6}$/i.test(trimmed)
    ? { ok: true, color: trimmed.toLowerCase() }
    : { ok: false };
}

/** Whether a value is usable as an identifier in a repository predicate. */
export function isBoundedId(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= TAG_LIMITS.maxIdLength
  );
}

export interface Tag {
  id: string;
  organizationId: string;
  workspaceId: string;
  /** Display form as the author typed it. */
  name: string;
  /** Locale-independent normalized form; unique within the Workspace. */
  normalizedName: string;
  /** Bounded presentation metadata, or null when unset. */
  color: string | null;
  createdById: string;
  /** Optimistic-concurrency counter, incremented on every mutation. */
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentTag {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  tagId: string;
  /** Who made the assignment; recorded rather than inferred from the tag author. */
  assignedById: string;
  createdAt: Date;
}

/**
 * Resolves a caller-supplied listing limit. Shared by both adapters so a listing
 * cannot be wider in one than the other. `Infinity` means "no bound of my own",
 * which the domain cap answers; anything unusable falls back to a single row
 * rather than to everything, so a bad limit can never widen a read.
 */
export function tagListLimit(limit: number): number {
  if (Number.isNaN(limit) || limit <= 0) return 1;
  return Math.min(Math.trunc(limit), TAG_LIMITS.maxListLimit);
}
