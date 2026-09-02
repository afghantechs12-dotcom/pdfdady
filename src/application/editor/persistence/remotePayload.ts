import type {
  DraftAssetBlob,
  DraftAssetRef,
  DraftAssetRole,
  DraftSnapshotRecord,
} from "./draftEnvelope";
import { persistenceFailure, type PersistenceFailure } from "./events";

/**
 * What a workspace autosave draft actually contains, and why it is smaller than
 * the local one.
 *
 * THE PROBLEM THIS SOLVES. The autosave route accepts ~1 MiB. A local draft
 * contains everything needed to rebuild the document from nothing: the scene
 * graph, every image and signature the user placed, and the original PDF's bytes.
 * That last item is usually the largest by an order of magnitude, and it is the
 * reason a perfectly ordinary two-page document with one photo cannot be backed
 * up at all.
 *
 * THE OBSERVATION THAT FIXES IT. For a workspace document, the server already has
 * the original file — that is what a workspace document IS. Uploading it again
 * inside every autosave draft buys nothing and costs the entire budget. So it is
 * left out, with a recorded locator, and everything else rides along.
 *
 * WHAT IS NEVER LEFT OUT. Anything the user created in the editor. An image or
 * signature exists only in this browser until it is backed up, so dropping one to
 * make the payload fit produces a save that succeeds, a status that says "Saved",
 * and a document that silently lost content — discovered only when someone
 * recovers it. When the reduced payload still does not fit, this reports the
 * backup as UNAVAILABLE and the caller says so. A skipped cloud save with a
 * cheerful status is the one outcome that is not allowed.
 *
 * WHAT IS NEVER REWRITTEN. The snapshot record and its checksum travel byte for
 * byte. Editing the manifest on the way out — to explain the omission inside the
 * document, say — would break the checksum, and a manifest whose checksum does not
 * match is precisely what the loader refuses. So the reduction is described
 * alongside the record, never inside it, and the remote copy validates through
 * exactly the same path as a local one.
 */

export const REMOTE_DRAFT_FORMAT = "pdfdadi-remote-draft" as const;
export const REMOTE_DRAFT_VERSION = 1;

/**
 * Room reserved for the transport's envelope, so two measurements cannot disagree.
 *
 * The plan measures the snapshot; the transport measures the snapshot wrapped in a
 * small envelope (format, version, revision, expected version, etag, timestamp)
 * and is the authority, because it measures the exact string it POSTs. If the plan
 * used the full limit, a snapshot could pass here and be refused there — the plan
 * having told the user the backup was fine.
 *
 * A kilobyte is roughly seven times the envelope's fixed fields.
 * `remote transport > the envelope allowance covers the real overhead` holds this
 * number to the actual shape rather than to this comment.
 */
export const REMOTE_ENVELOPE_ALLOWANCE = 1024;

/** The budget a snapshot may use, given what the endpoint accepts overall. */
export function remoteSnapshotBudget(maxPayloadBytes: number): number {
  return Math.max(0, maxPayloadBytes - REMOTE_ENVELOPE_ALLOWANCE);
}

/** Why an asset the manifest references is not in the payload. */
export type RemoteOmissionReason = "stored_in_workspace";

export interface OmittedRemoteAsset {
  hash: string;
  role: DraftAssetRole;
  byteLength: number;
  reason: RemoteOmissionReason;
  /**
   * Where the bytes are instead. Not nullable on purpose: an omission with no
   * stated source is a loss wearing an omission's clothes, and the type is what
   * stops one being written.
   */
  availableFrom: string;
}

/** An asset as it travels: always a string, never raw bytes. See `encodeAsset`. */
export interface RemoteAssetPayload {
  hash: string;
  role: DraftAssetRole;
  mimeType: string;
  byteLength: number;
  objectId?: string;
  data: string;
}

export interface RemoteDraftSnapshot {
  format: typeof REMOTE_DRAFT_FORMAT;
  version: typeof REMOTE_DRAFT_VERSION;
  /** The local snapshot record, unmodified, checksum intact. */
  record: DraftSnapshotRecord;
  assets: RemoteAssetPayload[];
  omitted: OmittedRemoteAsset[];
}

export interface RemoteSnapshotInput {
  record: DraftSnapshotRecord;
  /** Every blob the commit wrote locally, in any order, duplicates allowed. */
  assets: readonly DraftAssetBlob[];
  /** The endpoint's ceiling, in bytes. */
  maxBytes: number;
  /** Injected so a test measures the same thing the transport ships. */
  byteLength?: (value: string) => number;
}

export type RemoteSnapshotPlan =
  /** There is no remote for this document, so there is nothing to plan. */
  | { verdict: "not_applicable"; reason: string }
  /** Everything the manifest references is in the payload. */
  | { verdict: "complete"; snapshot: RemoteDraftSnapshot; body: string; bytes: number }
  /** Fits, with bytes the workspace already holds left behind. */
  | {
      verdict: "reduced";
      snapshot: RemoteDraftSnapshot;
      body: string;
      bytes: number;
      omitted: readonly OmittedRemoteAsset[];
    }
  /**
   * No honest remote backup can be made of this revision. The caller must report
   * that — never fall back to a partial payload, and never leave a "Saved" status
   * standing.
   */
  | {
      verdict: "unavailable";
      cause: "too_large" | "unencodable" | "incomplete" | "unserializable";
      failure: PersistenceFailure;
      bytes: number;
      limitBytes: number;
    };

function utf8Length(value: string): number {
  // Matches the transport's own measurement: `Buffer` is absent in the browser
  // and `TextEncoder` is present in both, so both sides count the same bytes.
  return new TextEncoder().encode(value).byteLength;
}

function kb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

export function planRemoteSnapshot(input: RemoteSnapshotInput): RemoteSnapshotPlan {
  const measure = input.byteLength ?? utf8Length;
  const { manifest } = input.record;

  if (manifest.origin !== "workspace") {
    return {
      verdict: "not_applicable",
      reason: "This document is only open in your browser, so there is no workspace to back it up to.",
    };
  }
  /*
   * The locator is what makes the omission safe, so it is checked before anything
   * is omitted. A manifest that says "workspace" but cannot name the workspace
   * document has no proven second copy of the source bytes; guessing one would
   * produce an omission pointing nowhere, which is a loss recorded as a plan.
   */
  if (manifest.workspaceId === null || manifest.documentId === null) {
    return {
      verdict: "not_applicable",
      reason: "This draft does not name a workspace document, so its original file cannot be located.",
    };
  }

  const supplied = new Map<string, DraftAssetBlob>();
  for (const asset of input.assets) {
    // First wins. Duplicates are the same content by construction — the hash IS
    // the content — so there is nothing to choose between them.
    if (!supplied.has(asset.hash)) supplied.set(asset.hash, asset);
  }

  const omitted: OmittedRemoteAsset[] = [];
  if (manifest.sourcePdf !== null) {
    omitted.push({
      hash: manifest.sourcePdf.hash,
      role: manifest.sourcePdf.role,
      byteLength: manifest.sourcePdf.byteLength,
      reason: "stored_in_workspace",
      availableFrom: `workspace:${manifest.workspaceId}/${manifest.documentId}`,
    });
  }

  const assets: RemoteAssetPayload[] = [];
  for (const ref of manifest.assets) {
    const blob = supplied.get(ref.hash);
    if (!blob) {
      /*
       * A referenced asset nobody supplied. Sending the payload anyway would
       * produce a remote draft that restores a document with a missing image,
       * which is the silent-loss outcome — so this is a refusal, not a warning.
       */
      return unavailable(
        "incomplete",
        persistenceFailure(
          "missing_asset",
          `A ${ref.role} in this document could not be read, so no cloud backup was made of this change.`,
        ),
        0,
        input.maxBytes,
      );
    }
    if (typeof blob.data !== "string") {
      /*
       * `corrupt_snapshot`, not `integrity_failed`. The two read alike but differ
       * in the only way that matters here: `integrity_failed` is retryable,
       * because bytes that did not read back once may read back next time, while
       * an asset in the wrong REPRESENTATION is wrong every time it is offered.
       * A Retry button over it would never clear.
       */
      return unavailable(
        "unencodable",
        persistenceFailure(
          "corrupt_snapshot",
          `A ${ref.role} in this document is in a form that cannot be sent to the workspace.`,
        ),
        0,
        input.maxBytes,
      );
    }
    assets.push(payloadFor(ref, blob.data));
  }

  const snapshot: RemoteDraftSnapshot = {
    format: REMOTE_DRAFT_FORMAT,
    version: REMOTE_DRAFT_VERSION,
    record: input.record,
    assets,
    omitted,
  };

  let body: string;
  try {
    body = JSON.stringify(snapshot);
  } catch {
    return unavailable(
      "unserializable",
      persistenceFailure(
        "integrity_failed",
        "This document could not be prepared for cloud saving.",
      ),
      0,
      input.maxBytes,
    );
  }

  /*
   * Measured on the serialised string rather than estimated from the parts, so
   * the number the ceiling is checked against and the number of bytes actually
   * sent are the same number. An estimate that runs a little low is a 413 the
   * client promised would not happen.
   */
  const bytes = measure(body);
  if (bytes > input.maxBytes) {
    return unavailable(
      "too_large",
      persistenceFailure(
        "payload_too_large",
        `This document is too large for cloud autosave (${kb(bytes)}, limit ${kb(input.maxBytes)}).`,
      ),
      bytes,
      input.maxBytes,
    );
  }

  return omitted.length === 0
    ? { verdict: "complete", snapshot, body, bytes }
    : { verdict: "reduced", snapshot, body, bytes, omitted };
}

function payloadFor(ref: DraftAssetRef, data: string): RemoteAssetPayload {
  // `objectId` is copied only when present: writing `objectId: undefined` would
  // serialise the key away anyway, but it would also make the two shapes differ
  // in a comparison, and this object is compared in tests.
  const payload: RemoteAssetPayload = {
    hash: ref.hash,
    role: ref.role,
    mimeType: ref.mimeType,
    byteLength: ref.byteLength,
    data,
  };
  return ref.objectId === undefined ? payload : { ...payload, objectId: ref.objectId };
}

function unavailable(
  cause: "too_large" | "unencodable" | "incomplete" | "unserializable",
  failure: PersistenceFailure,
  bytes: number,
  limitBytes: number,
): RemoteSnapshotPlan {
  return { verdict: "unavailable", cause, failure, bytes, limitBytes };
}
