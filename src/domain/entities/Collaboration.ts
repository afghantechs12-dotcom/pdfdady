/**
 * M7.10 asynchronous collaboration: comment threads, comment messages and
 * document permission grants.
 *
 * Three deliberate boundaries govern this module.
 *
 * **Threads own location; messages own text.** A thread is anchored once and
 * carries resolution state; its messages carry authored bodies and edit history.
 * Splitting them is what lets a thread be resolved without rewriting anyone's
 * words, and lets a message be edited without moving the anchor out from under
 * the other participants.
 *
 * **Bodies are plain text, always.** Nothing here stores, accepts or produces
 * HTML. A comment body is a string that reaches the DOM as a React text node, so
 * `<script>` is five characters of content rather than an element. There is no
 * sanitizer in this path on purpose: a sanitizer is a filter that can be wrong,
 * whereas a text node cannot execute. `assertPlainTextBody` exists to keep that
 * property provable rather than assumed.
 *
 * **Anchors are validated, not trusted.** An anchor is client-supplied, is
 * persisted as JSON, and is later used to scroll a viewer and to label a thread.
 * `validateAnchor` accepts only an allowlisted shape per type, rejects unknown
 * types and unknown fields, and bounds every number and string — an anchor that
 * could name an arbitrary object id of arbitrary length is an anchor that can
 * carry a payload.
 *
 * Authorization is deliberately absent from this file. Eligibility is decided in
 * the service against real DocumentRecords and grants, so no comment row can
 * confirm the existence of a document the actor cannot already see.
 */

export const COLLABORATION_LIMITS = {
  /** Current anchor schema version. An anchor written under another is degraded, not trusted. */
  anchorSchemaVersion: 1,
  /** Longest accepted identifier in any predicate. */
  maxIdLength: 128,
  /** Longest accepted comment body, in code points. */
  maxBodyLength: 5000,
  /** Most messages one thread may hold. Bounds both storage and a single render. */
  maxMessagesPerThread: 500,
  /** Most threads one document may hold. */
  maxThreadsPerDocument: 1000,
  /** Highest addressable page. Bounds a page anchor without bounding real documents. */
  maxPageNumber: 100_000,
  /** Largest serialized anchor, in UTF-8 bytes. */
  maxAnchorBytes: 2048,
  /** Longest accepted editor-object id inside an anchor. */
  maxObjectIdLength: 128,
  /** Highest addressable text offset inside a text-selection anchor. */
  maxTextOffset: 10_000_000,
  /** Longest accepted text-selection span, in characters. */
  maxTextRangeLength: 20_000,
  /** Longest accepted quoted excerpt carried by a text anchor. */
  maxQuoteLength: 300,
  /**
   * Deepest reply nesting. One level: a message may reply to a top-level
   * message, and no further. Threads are already the grouping construct, so
   * unbounded nesting would only add a tree to render and a cycle to guard.
   */
  maxReplyDepth: 1,
  /** Most rows returned in a single listing. */
  maxListLimit: 100,
  /** Default listing size when a caller does not ask for one. */
  defaultListLimit: 25,
  /** Most active grants one document may carry. */
  maxGrantsPerDocument: 200,
  /** Longest permitted grant lifetime, in milliseconds (365 days). */
  maxGrantTtlMs: 365 * 24 * 60 * 60 * 1000,
} as const;

// ---- text safety ------------------------------------------------------------

/**
 * Code points refused in any caller-supplied text.
 *
 * C0/C1 controls corrupt logs and split any header the text reaches. Bidi
 * overrides and isolates let text *render* as something other than what it
 * matches, which is how one comment is made to impersonate another — the
 * classic "resolved by admin" forgery is a right-to-left override, not markup.
 *
 * Written as numeric ranges rather than a regex literal so the intent survives
 * tooling that would rewrite escape sequences into the characters they denote;
 * an invisible control character inside a character class is exactly the kind of
 * thing that silently stops matching. Newline is handled by the callers that
 * allow it, not carved out here.
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

/** Collapses to a single line: used for quotes and other one-line excerpts. */
function normalizeSingleLine(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

/**
 * Normalizes a comment body, preserving paragraphs but bounding them.
 *
 * Note what this does *not* do: it does not strip, escape or transform `<`, `>`
 * or `&`. A body is stored exactly as typed, because it is stored as text and
 * rendered as a text node. Escaping here would double-escape at render and would
 * also imply, falsely, that the stored value is markup.
 */
function normalizeBody(value: string): string {
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
export function isBoundedCollaborationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= COLLABORATION_LIMITS.maxIdLength
  );
}

/**
 * Validates a comment body. Returns null when the body is unusable.
 *
 * The returned string is plain text and is stored verbatim. Markup-looking
 * input is *content*, not a threat, and is preserved: a user quoting
 * `<script>` in a code review is making a legitimate comment, and a product
 * that silently deletes their text is worse than one that shows it. Safety
 * comes from the render path (React text nodes), which cannot execute a string
 * regardless of what it contains.
 */
export function validateCommentBody(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const body = normalizeBody(value);
  if (!body) return null;
  if ([...body].length > COLLABORATION_LIMITS.maxBodyLength) return null;
  // Newlines are legitimate in a body, so only the non-newline controls are refused.
  if (hasForbiddenCodePoint(body.replace(/\n/gu, " "))) return null;
  return body;
}

/**
 * Whether a stored value is safe to hand to a text renderer.
 *
 * Used by tests and by the serializer as a tripwire. It asserts the *storage*
 * property this module promises — a bounded string free of control characters —
 * rather than attempting to detect "dangerous" markup, which is not a property
 * a text node cares about.
 */
export function isPlainTextBody(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    [...value].length <= COLLABORATION_LIMITS.maxBodyLength &&
    !hasForbiddenCodePoint(value.replace(/\n/gu, " "))
  );
}

// ---- anchors ----------------------------------------------------------------

/**
 * Where a thread is attached.
 *
 * `document` — the document as a whole, with no position.
 * `page` — a whole page.
 * `point` — a fractional point on a page (a pin).
 * `rectangle` — a fractional region of a page (a highlight box).
 * `text` — a character range within a page's extracted text.
 * `object` — an editor object, addressed by its id.
 */
export const COMMENT_ANCHOR_TYPES = [
  "document",
  "page",
  "point",
  "rectangle",
  "text",
  "object",
] as const;
export type CommentAnchorType = (typeof COMMENT_ANCHOR_TYPES)[number];

export function isCommentAnchorType(value: unknown): value is CommentAnchorType {
  return typeof value === "string" && (COMMENT_ANCHOR_TYPES as readonly string[]).includes(value);
}

export interface DocumentAnchor {
  type: "document";
}
export interface PageAnchor {
  type: "page";
  pageNumber: number;
}
/** Coordinates are fractions of the page (0..1), never absolute units. */
export interface PointAnchor {
  type: "point";
  pageNumber: number;
  x: number;
  y: number;
}
export interface RectangleAnchor {
  type: "rectangle";
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface TextAnchor {
  type: "text";
  pageNumber: number;
  /** Inclusive start offset into the page's extracted text. */
  start: number;
  /** Exclusive end offset; strictly greater than `start`. */
  end: number;
  /** Optional excerpt, used to detect that the anchor has gone stale. */
  quote?: string;
}
export interface ObjectAnchor {
  type: "object";
  objectId: string;
  /** Optional page hint; an object may be located without one. */
  pageNumber?: number;
}

export type CommentAnchor =
  | DocumentAnchor
  | PageAnchor
  | PointAnchor
  | RectangleAnchor
  | TextAnchor
  | ObjectAnchor;

/** The exact keys each anchor type may carry. Anything else is refused. */
const ANCHOR_ALLOWED_KEYS: Readonly<Record<CommentAnchorType, readonly string[]>> = {
  document: ["type"],
  page: ["type", "pageNumber"],
  point: ["type", "pageNumber", "x", "y"],
  rectangle: ["type", "pageNumber", "x", "y", "width", "height"],
  text: ["type", "pageNumber", "start", "end", "quote"],
  object: ["type", "objectId", "pageNumber"],
};

/** Validates a 1-based page number. */
export function validateAnchorPageNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 1 || value > COLLABORATION_LIMITS.maxPageNumber) return null;
  return value;
}

/** Validates a normalized (0..1) coordinate component. */
function validateFraction(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  return value;
}

/**
 * Validates a client-supplied anchor.
 *
 * Strict on purpose, in four ways that each close a real hole: an unknown
 * `type` is refused rather than defaulted (a defaulted anchor points somewhere
 * nobody chose); unknown keys are refused rather than dropped (an anchor is
 * persisted verbatim, so an ignored key is a storage channel); every number is
 * bounded (an unbounded offset is an unbounded scroll target and an unbounded
 * index); and the serialized size is capped (a "valid" anchor of a megabyte is
 * a denial-of-service with a schema).
 */
export function validateAnchor(
  value: unknown,
): { ok: true; anchor: CommentAnchor } | { ok: false; reason: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "An anchor object is required." };
  }
  const raw = value as Record<string, unknown>;
  if (!isCommentAnchorType(raw.type)) {
    return { ok: false, reason: "The anchor type is not supported." };
  }
  const type = raw.type;

  const allowed = ANCHOR_ALLOWED_KEYS[type];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      return { ok: false, reason: `The anchor carries an unsupported field "${key.slice(0, 64)}".` };
    }
  }

  let anchor: CommentAnchor;
  switch (type) {
    case "document": {
      anchor = { type: "document" };
      break;
    }
    case "page": {
      const pageNumber = validateAnchorPageNumber(raw.pageNumber);
      if (pageNumber === null) return { ok: false, reason: "The anchor page is not valid." };
      anchor = { type: "page", pageNumber };
      break;
    }
    case "point": {
      const pageNumber = validateAnchorPageNumber(raw.pageNumber);
      if (pageNumber === null) return { ok: false, reason: "The anchor page is not valid." };
      const x = validateFraction(raw.x);
      const y = validateFraction(raw.y);
      if (x === null || y === null) {
        return { ok: false, reason: "Anchor coordinates must be page fractions between 0 and 1." };
      }
      anchor = { type: "point", pageNumber, x, y };
      break;
    }
    case "rectangle": {
      const pageNumber = validateAnchorPageNumber(raw.pageNumber);
      if (pageNumber === null) return { ok: false, reason: "The anchor page is not valid." };
      const x = validateFraction(raw.x);
      const y = validateFraction(raw.y);
      const width = validateFraction(raw.width);
      const height = validateFraction(raw.height);
      if (x === null || y === null || width === null || height === null) {
        return { ok: false, reason: "Anchor bounds must be page fractions between 0 and 1." };
      }
      if (width <= 0 || height <= 0) {
        return { ok: false, reason: "An anchor rectangle must have a positive area." };
      }
      // A rectangle that runs off the page addresses nothing renderable, and
      // clamping it silently would move the user's highlight without telling them.
      if (x + width > 1 || y + height > 1) {
        return { ok: false, reason: "An anchor rectangle must lie within the page." };
      }
      anchor = { type: "rectangle", pageNumber, x, y, width, height };
      break;
    }
    case "text": {
      const pageNumber = validateAnchorPageNumber(raw.pageNumber);
      if (pageNumber === null) return { ok: false, reason: "The anchor page is not valid." };
      const { start, end } = raw;
      if (
        typeof start !== "number" ||
        typeof end !== "number" ||
        !Number.isInteger(start) ||
        !Number.isInteger(end)
      ) {
        return { ok: false, reason: "A text anchor requires integer offsets." };
      }
      if (start < 0 || end <= start || end > COLLABORATION_LIMITS.maxTextOffset) {
        return { ok: false, reason: "The text anchor range is not valid." };
      }
      if (end - start > COLLABORATION_LIMITS.maxTextRangeLength) {
        return { ok: false, reason: "The text anchor range is too long." };
      }
      let quote: string | undefined;
      if (raw.quote !== undefined && raw.quote !== null) {
        if (typeof raw.quote !== "string") {
          return { ok: false, reason: "The text anchor quote is not valid." };
        }
        const normalized = normalizeSingleLine(raw.quote);
        if (normalized) {
          if ([...normalized].length > COLLABORATION_LIMITS.maxQuoteLength) {
            return { ok: false, reason: "The text anchor quote is too long." };
          }
          if (hasForbiddenCodePoint(normalized)) {
            return { ok: false, reason: "The text anchor quote is not valid." };
          }
          quote = normalized;
        }
      }
      anchor = quote === undefined
        ? { type: "text", pageNumber, start, end }
        : { type: "text", pageNumber, start, end, quote };
      break;
    }
    case "object": {
      const { objectId } = raw;
      if (
        typeof objectId !== "string" ||
        objectId.trim().length === 0 ||
        objectId.length > COLLABORATION_LIMITS.maxObjectIdLength ||
        hasForbiddenCodePoint(objectId)
      ) {
        return { ok: false, reason: "The anchor object id is not valid." };
      }
      if (raw.pageNumber === undefined || raw.pageNumber === null) {
        anchor = { type: "object", objectId: objectId.trim() };
      } else {
        const pageNumber = validateAnchorPageNumber(raw.pageNumber);
        if (pageNumber === null) return { ok: false, reason: "The anchor page is not valid." };
        anchor = { type: "object", objectId: objectId.trim(), pageNumber };
      }
      break;
    }
  }

  // Size is checked on the serialized form, because that is what is stored and
  // what a reader has to parse.
  const serialized = serializeAnchor(anchor);
  if (Buffer.byteLength(serialized, "utf8") > COLLABORATION_LIMITS.maxAnchorBytes) {
    return { ok: false, reason: "The anchor is too large." };
  }
  return { ok: true, anchor };
}

/**
 * Serializes an anchor deterministically, so an unchanged anchor produces an
 * identical string and a comparison over it is stable.
 */
export function serializeAnchor(anchor: CommentAnchor): string {
  switch (anchor.type) {
    case "document":
      return JSON.stringify({ type: "document" });
    case "page":
      return JSON.stringify({ type: "page", pageNumber: anchor.pageNumber });
    case "point":
      return JSON.stringify({
        type: "point",
        pageNumber: anchor.pageNumber,
        x: anchor.x,
        y: anchor.y,
      });
    case "rectangle":
      return JSON.stringify({
        type: "rectangle",
        pageNumber: anchor.pageNumber,
        x: anchor.x,
        y: anchor.y,
        width: anchor.width,
        height: anchor.height,
      });
    case "text":
      return JSON.stringify(
        anchor.quote === undefined
          ? { type: "text", pageNumber: anchor.pageNumber, start: anchor.start, end: anchor.end }
          : {
              type: "text",
              pageNumber: anchor.pageNumber,
              start: anchor.start,
              end: anchor.end,
              quote: anchor.quote,
            },
      );
    case "object":
      return JSON.stringify(
        anchor.pageNumber === undefined
          ? { type: "object", objectId: anchor.objectId }
          : { type: "object", objectId: anchor.objectId, pageNumber: anchor.pageNumber },
      );
  }
}

/**
 * Reads a stored anchor back, tolerantly.
 *
 * A row written by another build may hold an anchor this build cannot validate.
 * Such a thread degrades to a document-level anchor rather than failing the
 * read: losing a pin's position is recoverable, refusing to show the whole
 * conversation is not. The caller can tell degradation apart from an authored
 * document anchor by comparing the stored `anchorType`.
 */
export function parseAnchor(serialized: unknown): CommentAnchor {
  if (typeof serialized !== "string" || serialized.trim() === "") return { type: "document" };
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    return { type: "document" };
  }
  const result = validateAnchor(raw);
  return result.ok ? result.anchor : { type: "document" };
}

/**
 * The page an anchor names, or null when it names none.
 *
 * The single source of truth for the denormalized `pageNumber` column: callers
 * derive the column from the validated anchor through this function rather than
 * accepting a page from the client, so the column and the anchor cannot
 * disagree about where a thread is.
 */
export function anchorPageNumber(anchor: CommentAnchor): number | null {
  switch (anchor.type) {
    case "document":
      return null;
    case "object":
      return anchor.pageNumber ?? null;
    default:
      return anchor.pageNumber;
  }
}

/** A short, human-readable label for an anchor. Used by the UI and by tests. */export function describeAnchor(anchor: CommentAnchor): string {
  switch (anchor.type) {
    case "document":
      return "Whole document";
    case "page":
      return `Page ${anchor.pageNumber}`;
    case "point":
      return `Page ${anchor.pageNumber} (pin)`;
    case "rectangle":
      return `Page ${anchor.pageNumber} (region)`;
    case "text":
      return `Page ${anchor.pageNumber} (selection)`;
    case "object":
      return anchor.pageNumber === undefined
        ? "Editor object"
        : `Page ${anchor.pageNumber} (object)`;
  }
}

// ---- threads and messages ---------------------------------------------------

/**
 * Thread lifecycle. Two states, not three: "archived" would be a third way to
 * hide a conversation with no rule distinguishing it from resolved, and deleting
 * a thread is expressed by deleting it.
 */
export const COMMENT_THREAD_STATUSES = ["open", "resolved"] as const;
export type CommentThreadStatus = (typeof COMMENT_THREAD_STATUSES)[number];

export function isCommentThreadStatus(value: unknown): value is CommentThreadStatus {
  return (
    typeof value === "string" && (COMMENT_THREAD_STATUSES as readonly string[]).includes(value)
  );
}

export interface CommentThread {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  /**
   * The version the anchor was authored against, when known. A thread whose
   * `versionId` is not the document's current version is *stale*: its
   * coordinates still describe the version it was written on, and the UI says so
   * rather than pretending the pin still lands in the right place.
   */
  versionId: string | null;
  anchorType: CommentAnchorType;
  anchor: CommentAnchor;
  /** Anchor schema the row was written under. */
  anchorSchemaVersion: number;
  /**
   * The anchor's 1-based page, or null when the anchor names no page. Derived
   * from the anchor rather than authored, so it always agrees with it; exposed
   * because "comments on this page" is a query, not a scan.
   */
  pageNumber: number | null;
  status: CommentThreadStatus;
  createdById: string;
  resolvedById: string | null;
  resolvedAt: Date | null;
  /** Optimistic-concurrency counter, incremented on every mutation. */
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CommentMessage {
  id: string;
  organizationId: string;
  workspaceId: string;
  threadId: string;
  documentId: string;
  authorId: string;
  /** Root message when null; otherwise the message this one replies to. */
  parentMessageId: string | null;
  /** Plain text, stored verbatim. Empty only when the message is deleted. */
  body: string;
  revision: number;
  editedAt: Date | null;
  /**
   * Soft deletion. A deleted message keeps its row and its position so replies
   * beneath it do not become orphans, and its body is cleared rather than
   * retained — "deleted" must actually delete the words.
   */
  deletedAt: Date | null;
  deletedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Whether a message still carries readable content. */
export function isDeletedMessage(message: Pick<CommentMessage, "deletedAt">): boolean {
  return message.deletedAt !== null;
}

// ---- permission grants ------------------------------------------------------

/**
 * What a document-scoped grant confers.
 *
 * `viewer` — may read the document and its comments.
 * `commenter` — may additionally create and reply to comments.
 * `editor` — may additionally edit the document.
 *
 * Note what is absent: there is no `owner` grant. Ownership is a Workspace
 * concept, and a document-scoped grant that could confer it would let a share
 * escalate past the Workspace that contains it.
 */
export const DOCUMENT_PERMISSION_ROLES = ["viewer", "commenter", "editor"] as const;
export type DocumentPermissionRole = (typeof DOCUMENT_PERMISSION_ROLES)[number];

export function isDocumentPermissionRole(value: unknown): value is DocumentPermissionRole {
  return (
    typeof value === "string" && (DOCUMENT_PERMISSION_ROLES as readonly string[]).includes(value)
  );
}

/** Ranked so a stronger grant supersedes a weaker one for the same grantee. */
const ROLE_RANK: Readonly<Record<DocumentPermissionRole, number>> = {
  viewer: 1,
  commenter: 2,
  editor: 3,
};

export function documentPermissionRank(role: DocumentPermissionRole): number {
  return ROLE_RANK[role];
}

/** Whether a role permits authoring comments. */
export function roleAllowsComment(role: DocumentPermissionRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK.commenter;
}

/** Whether a role permits editing the document itself. */
export function roleAllowsDocumentEdit(role: DocumentPermissionRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK.editor;
}

export interface DocumentPermissionGrant {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  /** The user this grant is for. */
  granteeUserId: string;
  role: DocumentPermissionRole;
  grantedById: string;
  /** Null means "does not expire on its own". */
  expiresAt: Date | null;
  /** Set once revoked; a revoked grant is retained as an audit fact. */
  revokedAt: Date | null;
  revokedById: string | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Whether a grant confers anything right now.
 *
 * Revocation is checked before expiry and both are checked on every use rather
 * than at issue time: a grant is a standing capability, so the only moment its
 * validity matters is the moment it is exercised.
 */
export function isGrantActive(
  grant: Pick<DocumentPermissionGrant, "expiresAt" | "revokedAt">,
  now: Date = new Date(),
): boolean {
  if (grant.revokedAt !== null) return false;
  if (grant.expiresAt !== null && grant.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}

/**
 * Validates a requested expiry. Returns `undefined` for "no expiry", `null` when
 * the value is unusable — the two must not collapse, or a malformed expiry would
 * silently become a permanent grant.
 */
export function validateGrantExpiry(
  value: unknown,
  now: Date = new Date(),
): Date | null | undefined {
  if (value === null || value === undefined) return undefined;
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || Number.isNaN(date.getTime())) return null;
  if (date.getTime() <= now.getTime()) return null;
  if (date.getTime() - now.getTime() > COLLABORATION_LIMITS.maxGrantTtlMs) return null;
  return date;
}

/**
 * Bounds a caller-supplied listing limit. `undefined` takes the default;
 * anything unusable falls back to a single row rather than to everything, so a
 * malformed limit can never widen a read.
 */
export function collaborationListLimit(limit: number | undefined): number {
  if (limit === undefined) return COLLABORATION_LIMITS.defaultListLimit;
  if (Number.isNaN(limit) || limit <= 0) return 1;
  return Math.min(Math.trunc(limit), COLLABORATION_LIMITS.maxListLimit);
}
