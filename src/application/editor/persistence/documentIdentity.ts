import {
  checksumBytes,
  guestDocumentKey,
  workspaceDocumentKey,
  type DraftIndexRecord,
} from "./draftEnvelope";
import type { IdentityStorage } from "./tabCoordination";

/**
 * Which document a draft belongs to, decided without a network call.
 *
 * The coordinator takes `documentKey` on trust and scopes every draft, every
 * pointer and every peer message by it. That makes this module the single point
 * where autosave silently becomes useless: a key derived from anything that
 * changes per mount produces a draft that is written correctly, verified
 * correctly, and never found again. The tests here exist because that failure is
 * invisible — the status bar says "Saved locally" the whole time.
 *
 * THE TWO ORIGINS ARE NOT SYMMETRIC.
 *
 * A workspace document already has an identity the server assigned, so its key is
 * a pure function of ids that outlive the tab. Nothing is stored and nothing can
 * drift.
 *
 * A guest document has no id at all. Its bytes arrived through a file input, and a
 * refresh destroys the `File` handle while leaving the draft in IndexedDB. Two
 * paths therefore have to exist, and neither one alone is enough:
 *
 *  1. FINGERPRINT. A per-tab map from file fingerprint to minted guest id, kept in
 *     session storage so it survives a reload. Re-opening the same file in the same
 *     tab resumes that file's draft exactly, with no guessing.
 *  2. ENUMERATION. {@link chooseRecoverableGuestDraft} over the draft index, for
 *     the case that actually loses work: the tab was refreshed or reopened and the
 *     user has no file to re-pick, because the file input is empty and the document
 *     they were editing exists only as a draft. Guest drafts carry their source
 *     bytes, so this path can rebuild the whole document.
 *
 * Path 1 is exact and needs the user to act. Path 2 is a guess and needs the user
 * to confirm. The prompt names the document and its age precisely so the guess is
 * always the user's to accept.
 */

/** The subset of {@link OpenDocumentInput} that identity decides. */
export interface DocumentIdentity {
  documentKey: string;
  documentId: string | null;
  workspaceId: string | null;
  organizationId: string | null;
  origin: "guest" | "workspace";
}

/** Session storage, per tab: survives a refresh, dies with the tab. Both are wanted. */
export const GUEST_DOCUMENT_MAP_KEY = "pdfdadi.guest-documents";

/**
 * How much of the file the fingerprint reads from each end.
 *
 * Bounded because this runs synchronously while opening a document. Hashing a
 * 200 MB scan to decide a storage key would be a visible stall for a check whose
 * only job is telling two files apart.
 */
export const GUEST_FINGERPRINT_SAMPLE_BYTES = 4096;

/**
 * How many files one tab remembers.
 *
 * Session storage is small and shared with the rest of the app. Evicting the
 * least recently opened file costs a duplicate draft in the rare case it is opened
 * again; letting the map grow without bound costs every other feature its storage.
 */
export const MAX_REMEMBERED_GUEST_DOCUMENTS = 8;

/**
 * How old a guest draft may be and still be offered by enumeration.
 *
 * Long, because the cost of offering a two-week-old draft is a dialog the user
 * declines, and the cost of not offering it is work that is gone. Bounded at all
 * because a prompt about a document from months ago is noise that trains the user
 * to dismiss the prompt that matters.
 */
export const GUEST_DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const MAP_FORMAT_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Workspace                                                           */
/* ------------------------------------------------------------------ */

/**
 * Identity for a document the server already named.
 *
 * Deliberately excludes the document's title: renaming a document must not orphan
 * its draft, and a title is the one property of a workspace document a user can
 * change at will.
 */
export function describeWorkspaceDocument(input: {
  workspaceId: string;
  documentId: string;
  organizationId?: string | null;
}): DocumentIdentity {
  const workspaceId = input.workspaceId.trim();
  const documentId = input.documentId.trim();
  if (!workspaceId || !documentId) {
    throw new Error("A workspace document needs both a workspace id and a document id.");
  }
  return {
    documentKey: workspaceDocumentKey(workspaceId, documentId),
    documentId,
    workspaceId,
    organizationId: input.organizationId?.trim() || null,
    origin: "workspace",
  };
}

/* ------------------------------------------------------------------ */
/* Guest                                                               */
/* ------------------------------------------------------------------ */

export interface GuestFileFingerprintInput {
  fileName: string;
  /** The original bytes. Null when only the length is known. */
  bytes: Uint8Array | null;
  /** Used when `bytes` is null, so a fingerprint is always producible. */
  byteLength?: number;
}

/**
 * A value that is the same for the same file and different for different files.
 *
 * Includes the file name as well as the content sample, which makes the
 * fingerprint stricter than content alone. That direction is chosen on purpose:
 * a fingerprint that is too strict offers the user two separate drafts to choose
 * between, and one that is too loose silently continues the wrong document's
 * draft. Only the second one loses work.
 */
export function fingerprintGuestFile(input: GuestFileFingerprintInput): string {
  const bytes = input.bytes;
  const byteLength = bytes ? bytes.length : Math.max(0, Math.trunc(input.byteLength ?? 0));
  // NFC so a name typed with a combining accent matches the same name composed.
  const name = input.fileName.trim().normalize("NFC");

  if (!bytes || bytes.length === 0) {
    // No content to sample. Name and length are all there is, and saying so in the
    // fingerprint keeps it from colliding with a sampled one of the same file.
    return `g1:${byteLength}:nosample:${checksumStringSafe(name)}`;
  }

  const sample = Math.min(GUEST_FINGERPRINT_SAMPLE_BYTES, bytes.length);
  const head = checksumBytes(bytes.subarray(0, sample));
  const tail = checksumBytes(bytes.subarray(bytes.length - sample));
  return `g1:${byteLength}:${head}${tail}:${checksumStringSafe(name)}`;
}

function checksumStringSafe(value: string): string {
  // Encoded through the byte checksum so the name and the content are hashed by
  // the same function, and a name with astral characters cannot change length
  // between platforms.
  return checksumBytes(new TextEncoder().encode(value));
}

export interface ResolvedGuestDocument {
  documentKey: string;
  guestDocumentId: string;
  /** True when this tab has seen this exact file before, so its draft continues. */
  reused: boolean;
  /** False when the mapping could not be stored: a refresh will not match by fingerprint. */
  persisted: boolean;
}

/**
 * The stable guest id for a file, minted on first sight and remembered per tab.
 *
 * Every storage failure degrades to an ephemeral id rather than throwing, because
 * an editor that will not open a file is strictly worse than one whose recovery is
 * limited to {@link chooseRecoverableGuestDraft}. `persisted: false` is how that
 * limitation is reported rather than hidden.
 */
export function resolveGuestDocument(
  storage: IdentityStorage | null,
  fingerprint: string,
  newId: () => string,
): ResolvedGuestDocument {
  const entries = readGuestMap(storage);
  const existing = entries.find((entry) => entry.fingerprint === fingerprint);

  if (existing) {
    // Rewritten so this file becomes the most recently used and survives eviction.
    const reordered = [existing, ...entries.filter((entry) => entry !== existing)];
    const persisted = writeGuestMap(storage, reordered);
    return {
      documentKey: guestDocumentKey(existing.guestDocumentId),
      guestDocumentId: existing.guestDocumentId,
      reused: true,
      persisted,
    };
  }

  const guestDocumentId = newId();
  const persisted = writeGuestMap(storage, [
    { fingerprint, guestDocumentId },
    ...entries,
  ]);
  return {
    documentKey: guestDocumentKey(guestDocumentId),
    guestDocumentId,
    reused: false,
    persisted,
  };
}

/**
 * Mints a FRESH id for a fingerprint this tab has already seen, and remembers it.
 *
 * The one caller is a tab that was armed by the abandoned-draft probe and is now
 * being told to start a blank document instead. {@link resolveGuestDocument} would
 * hand back the id of the draft the user just declined, and the next autosave would
 * advance that draft's pointer past the work they declined to restore — which is how
 * "declining is not deleting" stops being true. Re-keying leaves the declined draft
 * exactly as it was found: still on disk, still the newest snapshot under its own
 * key, still reachable by the probe on the next load.
 *
 * The prior entry for this fingerprint is REPLACED rather than kept alongside, so
 * this is idempotent from the user's side: clicking "Create blank PDF" twice
 * continues one new document instead of minting a document per click.
 *
 * Never throws, for the same reason as {@link resolveGuestDocument}: a storage
 * failure degrades to `persisted: false` and an ephemeral id.
 */
export function replaceGuestDocument(
  storage: IdentityStorage | null,
  fingerprint: string,
  newId: () => string,
): ResolvedGuestDocument {
  const entries = readGuestMap(storage).filter((entry) => entry.fingerprint !== fingerprint);
  const guestDocumentId = newId();
  const persisted = writeGuestMap(storage, [{ fingerprint, guestDocumentId }, ...entries]);
  return {
    documentKey: guestDocumentKey(guestDocumentId),
    guestDocumentId,
    // Never `true`: the point of this function is that nothing is being continued.
    reused: false,
    persisted,
  };
}

/** Identity for a guest document, given the id {@link resolveGuestDocument} settled on. */
export function describeGuestDocument(guestDocumentId: string): DocumentIdentity {
  const trimmed = guestDocumentId.trim();
  if (!trimmed) throw new Error("A guest document needs an id.");
  return {
    documentKey: guestDocumentKey(trimmed),
    documentId: null,
    workspaceId: null,
    organizationId: null,
    origin: "guest",
  };
}

/**
 * The identity a draft found by enumeration already has.
 *
 * Reopening by index must reuse the draft's own key, not mint a new one, or the
 * restore would write its first save to a different document and leave the draft
 * it recovered from behind as a second copy.
 */
export function describeRecoveredDraft(record: DraftIndexRecord): DocumentIdentity {
  return {
    documentKey: record.documentKey,
    documentId: record.documentId,
    workspaceId: record.workspaceId,
    organizationId: null,
    origin: record.origin,
  };
}

interface GuestMapEntry {
  fingerprint: string;
  guestDocumentId: string;
}

function readGuestMap(storage: IdentityStorage | null): GuestMapEntry[] {
  if (!storage) return [];
  let raw: string | null;
  try {
    raw = storage.read(GUEST_DOCUMENT_MAP_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt or written by an older shape. Starting empty costs one duplicate
    // draft; throwing would stop the document opening.
    return [];
  }

  const list = (parsed as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(list)) return [];

  const entries: GuestMapEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const record = item as { f?: unknown; id?: unknown };
    if (typeof record.f !== "string" || typeof record.id !== "string") continue;
    const fingerprint = record.f;
    const guestDocumentId = record.id;
    if (!fingerprint || !guestDocumentId || seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    entries.push({ fingerprint, guestDocumentId });
  }
  return entries;
}

function writeGuestMap(storage: IdentityStorage | null, entries: GuestMapEntry[]): boolean {
  if (!storage) return false;
  const bounded = entries.slice(0, MAX_REMEMBERED_GUEST_DOCUMENTS);
  try {
    storage.write(
      GUEST_DOCUMENT_MAP_KEY,
      JSON.stringify({
        v: MAP_FORMAT_VERSION,
        entries: bounded.map((entry) => ({ f: entry.fingerprint, id: entry.guestDocumentId })),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Recovery by enumeration                                             */
/* ------------------------------------------------------------------ */

export interface GuestDraftOfferInput {
  drafts: readonly DraftIndexRecord[];
  now: number;
  maxAgeMs?: number;
  /**
   * Keys already open in this tab. Their drafts are the live document, and
   * offering to "recover" what is already on screen is how a user is talked into
   * replacing newer work with older.
   */
  excludeDocumentKeys?: readonly string[];
}

/**
 * The one guest draft worth offering on an editor that has no document open.
 *
 * Guest-only. A workspace draft belongs to the workspace URL that can save it
 * back; restoring one here would put a document on screen whose only route to the
 * server is a fresh upload, under a name and history that no longer match.
 */
export function chooseRecoverableGuestDraft(input: GuestDraftOfferInput): DraftIndexRecord | null {
  const maxAgeMs = input.maxAgeMs ?? GUEST_DRAFT_MAX_AGE_MS;
  const excluded = new Set(input.excludeDocumentKeys ?? []);

  const candidates = input.drafts.filter((record) => {
    if (record.origin !== "guest") return false;
    if (excluded.has(record.documentKey)) return false;
    // Revision 0 is a draft that was opened and never edited. There is nothing in
    // it the user has not already lost by closing the tab.
    if (!Number.isFinite(record.revision) || record.revision <= 0) return false;
    if (!Number.isFinite(record.updatedAt)) return false;
    /*
     * A future timestamp is a clock that was wrong when the draft was written, or
     * is wrong now. Age clamps at zero rather than rejecting, because refusing to
     * offer is the only branch here that can lose work.
     */
    const age = Math.max(0, input.now - record.updatedAt);
    return age <= maxAgeMs;
  });

  if (candidates.length === 0) return null;

  return candidates.reduce((best, record) => {
    if (record.updatedAt !== best.updatedAt) return record.updatedAt > best.updatedAt ? record : best;
    if (record.revision !== best.revision) return record.revision > best.revision ? record : best;
    // Deterministic last resort, so two drafts stamped identically do not make the
    // offer depend on store iteration order.
    return record.documentKey < best.documentKey ? record : best;
  });
}

/** Session storage as an {@link IdentityStorage}, or null where there is none. */
export function sessionIdentityStorage(scope: unknown): IdentityStorage | null {
  const storage = (scope as { sessionStorage?: Storage | null } | undefined)?.sessionStorage;
  if (!storage) return null;
  return {
    read: (key) => storage.getItem(key),
    write: (key, value) => storage.setItem(key, value),
  };
}

/** Local storage as an {@link IdentityStorage}, for the device id that must outlive the tab. */
export function localIdentityStorage(scope: unknown): IdentityStorage | null {
  const storage = (scope as { localStorage?: Storage | null } | undefined)?.localStorage;
  if (!storage) return null;
  return {
    read: (key) => storage.getItem(key),
    write: (key, value) => storage.setItem(key, value),
  };
}
