/**
 * M7.9 document metadata, bookmarks, outlines and attachments.
 *
 * The organizing distinction is **origin**. A `workspace` record is data this
 * product owns: it lives in our database, it is authored through our API, and it
 * can be edited. An `embedded` record is a projection of a structure that lives
 * inside the PDF bytes — the /Info dictionary, the document outline, embedded
 * file attachments. Those are *inspected*, never edited here.
 *
 * Keeping the two apart is a correctness requirement, not presentation polish.
 * A UI that shows an embedded author beside an editable field invites the user
 * to change it, and an API that accepts the change has to either rewrite the
 * PDF or silently drop it. This module makes the second impossible to express:
 * embedded records carry `origin: "embedded"`, and `EMBEDDED_WRITE_SUPPORT`
 * reports what this build can actually write — currently nothing (ADR-M7-006).
 * When a feasibility-approved native writer exists, that constant changes and
 * the services follow it; until then no code path can claim the capability.
 *
 * Metadata field values are strings. PDF document-information values are text
 * strings, so accepting numbers and booleans would only add a round-trip
 * ambiguity ("was 1 the number or the text?") without representing anything the
 * format can hold.
 *
 * Authorization is not represented here. Eligibility is decided against real
 * DocumentRecords in the service layer, so no metadata, bookmark, outline or
 * attachment row can confirm a document the actor cannot already see.
 */

export const METADATA_LIMITS = {
  /** Current metadata schema version. A row written under another is degraded, not trusted. */
  schemaVersion: 1,
  /** Most metadata fields one document may carry. */
  maxFields: 32,
  /** Longest accepted metadata value, in code points. */
  maxValueLength: 1000,
  /** Longest accepted bookmark or outline title, in code points. */
  maxTitleLength: 300,
  /** Longest accepted bookmark note, in code points. */
  maxNoteLength: 2000,
  /** Longest accepted attachment description, in code points. */
  maxDescriptionLength: 1000,
  /** Longest accepted identifier in any predicate. */
  maxIdLength: 128,
  /** Highest addressable page. Bounds a page anchor without bounding real documents. */
  maxPageNumber: 100_000,
  /** Deepest outline nesting. Depth 0 is a root item. */
  maxOutlineDepth: 8,
  /** Most outline items one document may hold. */
  maxOutlineItems: 2000,
  /** Most bookmarks one document may hold. */
  maxBookmarksPerDocument: 500,
  /** Most attachments one document may hold. */
  maxAttachmentsPerDocument: 100,
  /** Largest single attachment, in bytes. */
  maxAttachmentBytes: 25 * 1024 * 1024,
  /** Largest total attachment payload one document may accumulate, in bytes. */
  maxAttachmentTotalBytes: 250 * 1024 * 1024,
  /** Longest accepted attachment filename, in code points. */
  maxAttachmentNameLength: 255,
  /** Longest accepted checksum. */
  maxChecksumLength: 128,
  /** Longest accepted MIME type. */
  maxMimeTypeLength: 255,
  /** Most rows returned in a single listing. */
  maxListLimit: 200,
  /** Default listing size when a caller does not ask for one. */
  defaultListLimit: 50,
} as const;

/**
 * Where a record came from.
 *
 * `workspace` records are ours and are editable. `embedded` records mirror a
 * structure inside the PDF and are read-only in this build.
 */
export const METADATA_ORIGINS = ["workspace", "embedded"] as const;
export type MetadataOrigin = (typeof METADATA_ORIGINS)[number];

export function isMetadataOrigin(value: unknown): value is MetadataOrigin {
  return typeof value === "string" && (METADATA_ORIGINS as readonly string[]).includes(value);
}

/**
 * Metadata keys this product stores.
 *
 * A strict allowlist rather than a free-form map: arbitrary keys are unbounded
 * in count and shape, they end up in search index content and export headers,
 * and nothing in the requirement needs them. Every key here corresponds to a
 * PDF document-information entry or to a widely-understood office property, so
 * the set is meaningful to a future native writer rather than invented for us.
 */
export const METADATA_KEYS = [
  "title",
  "author",
  "subject",
  "keywords",
  "category",
  "company",
  "manager",
  "comments",
  "status",
  "documentType",
  "language",
  "copyright",
] as const;
export type MetadataKey = (typeof METADATA_KEYS)[number];

export function isMetadataKey(value: unknown): value is MetadataKey {
  return typeof value === "string" && (METADATA_KEYS as readonly string[]).includes(value);
}

/** The stored field map. Absent keys mean "not set"; empty strings are not stored. */
export type MetadataFields = Partial<Record<MetadataKey, string>>;

/**
 * Code points refused in any caller-supplied text.
 *
 * C0/C1 controls corrupt logs and split any header the text reaches. Bidi
 * overrides and isolates let text *render* as something other than what it
 * matches, which is how one bookmark or attachment is made to impersonate
 * another.
 *
 * Written as numeric ranges rather than a regex literal so the intent survives
 * tooling that would rewrite escape sequences into the characters they denote —
 * an invisible control character inside a character class is exactly the kind of
 * thing that silently stops matching.
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

/** Path separators are refused because names reach export paths and headers. */
const PATH_SEPARATORS = /[/\\]/u;
/** An embedded `data:`/`blob:` URL in a name is content, not a name. */
const CONTENT_URL_PATTERN = /^\s*(?:data|blob|javascript|vbscript):/iu;

/**
 * Normalizes caller text: compatibility-folded, whitespace-collapsed, trimmed.
 * Newlines collapse to spaces — a single-line field that accepts a newline is a
 * field that can forge a second line somewhere downstream.
 */
function normalizeSingleLine(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

/**
 * Normalizes multi-line text, preserving paragraph structure but bounding it.
 * Line separators are unified to `\n` so a note reads the same on every platform,
 * and runs of blank lines collapse so a note cannot be padded into a wall.
 */
function normalizeMultiLine(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[^\S\n]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/** Whether a value is usable as an identifier in a repository predicate. */
export function isBoundedMetadataId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= METADATA_LIMITS.maxIdLength
  );
}

/**
 * Validates one metadata value. Returns null when the value is unusable, and
 * the empty string when the caller is clearing the field — those are different
 * outcomes and the caller distinguishes them.
 */
export function validateMetadataValue(value: unknown): string | null {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") return null;
  const normalized = normalizeSingleLine(value);
  if (!normalized) return "";
  if ([...normalized].length > METADATA_LIMITS.maxValueLength) return null;
  if (hasForbiddenCodePoint(normalized)) return null;
  return normalized;
}

export interface MetadataFieldsValidation {
  ok: true;
  /** Fields to persist. A key mapped to the empty string was cleared and is absent. */
  fields: MetadataFields;
  /** Keys the caller supplied that are not on the allowlist, for a precise error. */
  rejected: string[];
}

/**
 * Validates a caller-supplied field map against the allowlist.
 *
 * Unknown keys are reported rather than dropped: silently discarding a field the
 * user typed reads as a save that worked. Cleared fields are removed from the
 * result, so "set to empty" and "not set" converge on one representation.
 */
export function validateMetadataFields(
  input: unknown,
): MetadataFieldsValidation | { ok: false; reason: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "Metadata fields must be supplied as an object." };
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > METADATA_LIMITS.maxFields) {
    return {
      ok: false,
      reason: `A document may carry at most ${METADATA_LIMITS.maxFields} metadata fields.`,
    };
  }
  const fields: MetadataFields = {};
  const rejected: string[] = [];
  for (const [key, raw] of entries) {
    if (!isMetadataKey(key)) {
      // Bounded so an unknown key cannot itself become an unbounded error body.
      rejected.push(key.slice(0, METADATA_LIMITS.maxIdLength));
      continue;
    }
    const value = validateMetadataValue(raw);
    if (value === null) {
      return { ok: false, reason: `The value supplied for "${key}" is not acceptable.` };
    }
    if (value === "") continue;
    fields[key] = value;
  }
  return { ok: true, fields, rejected };
}

/**
 * Serializes fields for storage in a deterministic key order, so an unchanged
 * save produces an identical string and a checksum over it is stable.
 */
export function serializeMetadataFields(fields: MetadataFields): string {
  const ordered: Record<string, string> = {};
  for (const key of METADATA_KEYS) {
    const value = fields[key];
    if (typeof value === "string" && value !== "") ordered[key] = value;
  }
  return JSON.stringify(ordered);
}

/**
 * Reads a stored field map back, tolerantly.
 *
 * A row written by another build may hold a key this build no longer knows, or
 * text that no longer validates. Such a field is dropped rather than allowed to
 * fail the whole read: losing one unknown property is recoverable, refusing to
 * open the properties panel is not.
 */
export function parseMetadataFields(serialized: unknown): MetadataFields {
  if (typeof serialized !== "string" || serialized.trim() === "") return {};
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    return {};
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const fields: MetadataFields = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isMetadataKey(key)) continue;
    const validated = validateMetadataValue(value);
    if (validated === null || validated === "") continue;
    fields[key] = validated;
  }
  return fields;
}

/** Validates a single-line title used by bookmarks and outline items. */
export function validateTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = normalizeSingleLine(value);
  if (!title) return null;
  if ([...title].length > METADATA_LIMITS.maxTitleLength) return null;
  if (hasForbiddenCodePoint(title)) return null;
  return title;
}

/**
 * Validates an optional note. Absence and rejection are separated: `undefined`
 * means "no note", `null` means "unusable", so a bad note is never stored as no
 * note.
 */
export function validateNote(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const note = normalizeMultiLine(value);
  if (!note) return undefined;
  if ([...note].length > METADATA_LIMITS.maxNoteLength) return null;
  // Newlines are legitimate here, so only the non-newline controls are refused.
  if (hasForbiddenCodePoint(note.replace(/\n/gu, " "))) return null;
  return note;
}

/** Validates an optional attachment description. */
export function validateDescription(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const description = normalizeSingleLine(value);
  if (!description) return undefined;
  if ([...description].length > METADATA_LIMITS.maxDescriptionLength) return null;
  if (hasForbiddenCodePoint(description)) return null;
  return description;
}

/** Validates a 1-based page anchor. Returns null when the page is unusable. */
export function validatePageNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value)) return null;
  if (value < 1 || value > METADATA_LIMITS.maxPageNumber) return null;
  return value;
}

/**
 * Validates an optional in-page anchor.
 *
 * Coordinates are fractions of the page rather than absolute units, so an anchor
 * survives a page-size change and cannot address a point outside the page.
 * Absence and rejection are separated for the same reason as notes.
 */
export function validateAnchor(
  value: unknown,
): { ok: true; anchor: { x: number; y: number } | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, anchor: null };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false };
  const { x, y } = value as { x?: unknown; y?: unknown };
  if (typeof x !== "number" || typeof y !== "number") return { ok: false };
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false };
  if (x < 0 || x > 1 || y < 0 || y > 1) return { ok: false };
  return { ok: true, anchor: { x, y } };
}

/** Validates an outline nesting depth. */
export function validateOutlineDepth(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 0 || value > METADATA_LIMITS.maxOutlineDepth) return null;
  return value;
}

/**
 * The matching form of an attachment name, used for per-document uniqueness.
 * Locale-independent (`toLowerCase`, not `toLocaleLowerCase`) so a server's
 * locale cannot change which names collide.
 */
export function normalizeAttachmentName(value: string): string {
  return normalizeSingleLine(value).toLowerCase();
}

export interface AttachmentNameParts {
  name: string;
  normalizedName: string;
}

/**
 * Validates an attachment filename.
 *
 * The name is attacker-controlled and reaches a `Content-Disposition` header and
 * any export path, so path separators, traversal segments, control characters
 * and embedded content URLs are all refused rather than escaped — there is no
 * legitimate attachment named `../etc/passwd`.
 */
export function validateAttachmentName(value: unknown): AttachmentNameParts | null {
  if (typeof value !== "string") return null;
  const name = normalizeSingleLine(value);
  if (!name) return null;
  if ([...name].length > METADATA_LIMITS.maxAttachmentNameLength) return null;
  if (hasForbiddenCodePoint(name)) return null;
  if (PATH_SEPARATORS.test(name)) return null;
  if (CONTENT_URL_PATTERN.test(name)) return null;
  // A dot-only name is indistinguishable from a path segment.
  if (/^\.+$/u.test(name)) return null;
  if (name.startsWith("..")) return null;
  const normalizedName = normalizeAttachmentName(name);
  if (!normalizedName) return null;
  return { name, normalizedName };
}

/** MIME types allowed to keep their declared type on download. */
const SAFE_DOWNLOAD_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "application/json",
  "application/zip",
  "text/plain",
  "text/csv",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

/**
 * Validates a declared MIME type into its stored form. A type outside the
 * allowlist is still *storable* — refusing to attach a `.docx` would be wrong —
 * it simply will not be served under its own type. See `safeDownloadType`.
 */
export function validateMimeType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const mime = value.trim().toLowerCase();
  if (!mime) return null;
  if (mime.length > METADATA_LIMITS.maxMimeTypeLength) return null;
  // One type/subtype pair with optional RFC-compliant token characters only, so
  // no parameter, newline or separator can ride along into a response header.
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(mime)) return null;
  return mime;
}

/**
 * The content type an attachment is actually served with.
 *
 * Anything not on the allowlist is served as `application/octet-stream`: a
 * stored `text/html` attachment served under its own type is a stored-XSS
 * delivery mechanism on our origin. Callers must still send
 * `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`;
 * this function narrows the type, it does not replace those headers.
 */
export function safeDownloadType(mimeType: string): string {
  const mime = mimeType.trim().toLowerCase();
  return SAFE_DOWNLOAD_MIME_TYPES.has(mime) ? mime : "application/octet-stream";
}

/**
 * An ASCII-only fallback filename for the `filename=` parameter of a
 * `Content-Disposition` header. Non-ASCII, quotes and backslashes are replaced
 * rather than escaped; the exact name travels in `filename*` as percent-encoded
 * UTF-8, which is what compliant clients read.
 */
export function asciiFallbackFilename(name: string): string {
  let out = "";
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    out += code >= 0x20 && code <= 0x7e && character !== '"' && character !== "\\" ? character : "_";
  }
  const trimmed = out.trim();
  // A name that survived as nothing but replacement characters or dots carries
  // no information; a generic name is more useful to the person saving it than
  // a row of underscores.
  const informative = /[A-Za-z0-9]/u.test(trimmed);
  return informative ? trimmed : "attachment";
}

/**
 * Bounds a caller-supplied listing limit. `Infinity` means "no bound of my own",
 * which the domain cap answers; anything unusable falls back to a single row
 * rather than to everything, so a bad limit can never widen a read.
 */
export function metadataListLimit(limit: number | undefined): number {
  if (limit === undefined) return METADATA_LIMITS.defaultListLimit;
  if (Number.isNaN(limit) || limit <= 0) return 1;
  return Math.min(Math.trunc(limit), METADATA_LIMITS.maxListLimit);
}

/** What this build can read from, and write to, a PDF's embedded structures. */
export interface EmbeddedWriteSupport {
  metadata: boolean;
  outline: boolean;
  attachments: boolean;
}

/**
 * Embedded-structure write capability for this build.
 *
 * All false, and deliberately a single constant rather than a per-call decision:
 * writing a PDF's /Info dictionary, outline tree or embedded file streams
 * requires a feasibility-approved writer that produces a durable new version,
 * and none exists yet (M7.9 plan, ADR-M7-006). Faking it would either discard
 * the user's edit or corrupt the file. When the writer lands, this constant
 * flips and the services that consult it follow — no other code encodes the
 * assumption.
 */
export const EMBEDDED_WRITE_SUPPORT: EmbeddedWriteSupport = Object.freeze({
  metadata: false,
  outline: false,
  attachments: false,
});

/** Whether embedded structures of this kind may be mutated by this build. */
export function canWriteEmbedded(kind: keyof EmbeddedWriteSupport): boolean {
  return EMBEDDED_WRITE_SUPPORT[kind];
}

/**
 * What an inspection actually established about one document's embedded
 * structures. Reported to clients so a panel can say "this file has no outline"
 * distinctly from "we have not looked yet".
 */
export interface EmbeddedCapabilityReport {
  /** True once an inspection has run for the current version. */
  inspected: boolean;
  /** True when the bytes parsed. False means malformed or encrypted. */
  parsed: boolean;
  /** Whether a signature was found. Presence is not validity — see the note. */
  signaturePresent: boolean;
  /** Counts of what was found, all zero when nothing was. */
  found: { metadataFields: number; outlineItems: number; attachments: number };
  /** Write capability, mirrored from EMBEDDED_WRITE_SUPPORT. */
  writable: EmbeddedWriteSupport;
  /** Human-readable limitations, bounded. Never empty when writable is all false. */
  limitations: string[];
}

/**
 * A report for a document that has not been inspected.
 *
 * `signaturePresent` is reported, and named that, because finding a /Sig entry
 * establishes only that a signature *exists*. Calling it "signed" or "valid"
 * would assert a cryptographic verification this build does not perform.
 */
export function uninspectedCapabilityReport(): EmbeddedCapabilityReport {
  return {
    inspected: false,
    parsed: false,
    signaturePresent: false,
    found: { metadataFields: 0, outlineItems: 0, attachments: 0 },
    writable: { ...EMBEDDED_WRITE_SUPPORT },
    limitations: ["This document's embedded structures have not been inspected yet."],
  };
}

export interface DocumentMetadata {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  /** Workspace-owned fields. Embedded /Info values are reported separately. */
  fields: MetadataFields;
  /** Schema version the row was written under. */
  schemaVersion: number;
  createdById: string;
  updatedById: string;
  /** Optimistic-concurrency counter, incremented on every mutation. */
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceBookmark {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  /** 1-based page this bookmark points at. */
  pageNumber: number;
  title: string;
  note: string | null;
  /** Fractional in-page anchor, or null for a whole-page bookmark. */
  anchor: { x: number; y: number } | null;
  /** Lexicographic ordering key within the document. */
  orderKey: string;
  createdById: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OutlineItem {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  /** Parent item, or null for a root item. */
  parentId: string | null;
  title: string;
  pageNumber: number;
  /** Nesting depth; 0 is a root item. Derived from the parent chain, not trusted. */
  depth: number;
  orderKey: string;
  /** `workspace` items are editable; `embedded` items mirror the PDF's own outline. */
  origin: MetadataOrigin;
  createdById: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/** One node of the assembled outline tree. */
export interface OutlineNode extends OutlineItem {
  children: OutlineNode[];
}

export interface AttachmentRecord {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  /**
   * StoredFile holding the bytes, or null for an embedded attachment that was
   * catalogued but never extracted — such a record is listable and not
   * downloadable, which is the honest state.
   */
  storedFileId: string | null;
  /** `workspace` attachments were uploaded here; `embedded` live inside the PDF. */
  origin: MetadataOrigin;
  name: string;
  normalizedName: string;
  description: string | null;
  /** Declared type. What it is *served* as comes from `safeDownloadType`. */
  mimeType: string;
  byteSize: number;
  /** sha256 over the stored bytes, computed server-side; empty when unknown. */
  checksum: string;
  createdById: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Assembles a flat item list into a tree.
 *
 * Depth is recomputed from the parent chain rather than trusted from the row: a
 * stored depth can disagree with the links after a move, and the links are the
 * structure. An item whose parent is missing from the set is attached at the
 * root rather than dropped — a hidden item is worse than a shallow one — and an
 * item that participates in a cycle is dropped, because there is no position for
 * it and following the chain would not terminate.
 */
export function buildOutlineTree(items: OutlineItem[]): OutlineNode[] {
  const byId = new Map<string, OutlineItem>();
  for (const item of items) byId.set(item.id, item);

  const nodes = new Map<string, OutlineNode>();
  const roots: OutlineNode[] = [];

  /** Resolves an item's depth by walking to a root, refusing to loop. */
  const depthOf = (item: OutlineItem): number | null => {
    let depth = 0;
    let current = item;
    const seen = new Set<string>([item.id]);
    while (current.parentId !== null) {
      const parent = byId.get(current.parentId);
      if (!parent) break; // Orphan: treated as a root at its accumulated depth.
      if (seen.has(parent.id)) return null; // Cycle.
      seen.add(parent.id);
      current = parent;
      depth += 1;
      if (depth > METADATA_LIMITS.maxOutlineDepth) return null;
    }
    return depth;
  };

  const ordered = [...items].sort(
    (a, b) => a.orderKey.localeCompare(b.orderKey) || a.id.localeCompare(b.id),
  );

  for (const item of ordered) {
    const depth = depthOf(item);
    if (depth === null) continue;
    nodes.set(item.id, { ...item, depth, children: [] });
  }

  for (const node of nodes.values()) {
    const parent = node.parentId === null ? undefined : nodes.get(node.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  return roots;
}

/** Flattens a tree back into display order, for a linear listbox or export. */
export function flattenOutlineTree(nodes: OutlineNode[]): OutlineItem[] {
  const flat: OutlineItem[] = [];
  const visit = (list: OutlineNode[]): void => {
    for (const node of list) {
      const { children, ...item } = node;
      flat.push(item);
      visit(children);
    }
  };
  visit(nodes);
  return flat;
}
