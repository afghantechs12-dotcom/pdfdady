/**
 * Resolution rules for serving a document's PDF bytes.
 *
 * The route that streams document content is the single place in the product
 * where a client can cause object-storage bytes to be read by name. The rules
 * that decide *which* bytes, and whether there are any, are extracted here so
 * they can be tested without a container, a request or a byte store — and so
 * the security-relevant decisions are stated once rather than reimplemented per
 * caller.
 *
 * Three rules, in order:
 *
 * 1. The client never names a storage key. It names a document, and optionally
 *    a version *number*. The key is read from the version manifest the service
 *    returned for that document, so a forged key cannot reach the store.
 * 2. A version that does not belong to the requested document is not served,
 *    even if the caller may read both. Trusting a client-supplied
 *    version/document pairing is how one document's bytes end up served under
 *    another document's identity.
 * 3. A document whose current version carries no usable source artifact returns
 *    an honest bounded error. It does not fall back to an autosave draft (which
 *    is mutable per-device recovery state, not a durable version) and it does
 *    not synthesize an empty PDF.
 * 4. WHICH artifact of that version is an allow-listed choice between two named
 *    roles ({@link ContentArtifact}), never a key and never a free-form string.
 */

import type { DocumentVersion } from "@/src/domain/entities/DocumentVersion";

/** Why content could not be served, when it could not. */
export type ContentUnavailableReason =
  | "no-version"
  | "version-mismatch"
  | "no-source-artifact"
  | "manifest-degraded";

/**
 * Which artifact of a version the caller wants.
 *
 * `auto` is what every human-facing consumer wants: the version's PUBLISHED
 * bytes — the materialized output when the version has one, otherwise its source.
 * `source` is what the EDITOR wants when it reopens a document: the bytes the
 * editable scene is drawn ON TOP OF. The two differ for a version saved from an
 * editing session, and serving the wrong one is not a cosmetic mistake — restoring
 * a scene over the flattened output draws every object twice.
 */
export type ContentArtifact = "auto" | "source";

/** The outcome of resolving which bytes to serve. */
export type ContentResolution =
  | {
      ok: true;
      /** Internal object-storage key. Never sent to the client. */
      sourceKey: string;
      /**
       * Byte length from the manifest, or null when the chosen artifact has no
       * recorded length (the manifest records a size for the source only). A null
       * means the caller must ask the store, not that the object is empty.
       */
      byteSize: number | null;
      checksum: string;
      versionNumber: number;
      versionId: string;
      /** Which artifact was chosen, for the caller's own diagnostics. */
      artifact: "source" | "output";
    }
  | { ok: false; reason: ContentUnavailableReason; message: string; status: number };

/** Messages are non-disclosing: they describe the document's state, not storage. */
const UNAVAILABLE: Record<ContentUnavailableReason, { message: string; status: number }> = {
  "no-version": {
    message: "This document has no saved version yet, so there is nothing to open.",
    status: 409,
  },
  "version-mismatch": {
    message: "Version not found for this document.",
    status: 404,
  },
  "no-source-artifact": {
    message: "The saved version of this document has no stored file.",
    status: 409,
  },
  "manifest-degraded": {
    message: "The saved version of this document could not be read reliably.",
    status: 409,
  },
};

function unavailable(reason: ContentUnavailableReason): ContentResolution {
  return { ok: false, reason, ...UNAVAILABLE[reason] };
}

/**
 * Decides which stored bytes answer a content request.
 *
 * `version` is whatever the version service returned — the latest version, or
 * the one matching a requested number. `documentId` is the document the caller
 * addressed, and is re-checked against the version's own `documentId` rather
 * than assumed: the service scopes reads to the Workspace, but the
 * version/document pairing is the client's claim until it is verified here.
 */
export function resolveDocumentContent(input: {
  documentId: string;
  version: DocumentVersion | null;
  /** Defaults to `auto` so every existing caller keeps serving published bytes. */
  artifact?: ContentArtifact;
}): ContentResolution {
  const { documentId, version } = input;
  const wanted = input.artifact ?? "auto";

  if (!version) return unavailable("no-version");

  // Rule 2. A version from another document is reported as not found for this
  // one, which is both true and non-disclosing.
  if (version.documentId !== documentId) return unavailable("version-mismatch");

  // A manifest that could not be read within bounds may carry a truncated or
  // absent key. Serving from it would mean serving bytes we cannot vouch for.
  if (version.manifestDegraded) return unavailable("manifest-degraded");

  const sourceKey = version.manifest.sourceKey;
  if (typeof sourceKey !== "string" || sourceKey.trim() === "") {
    return unavailable("no-source-artifact");
  }
  if (!Number.isFinite(version.manifest.sourceByteSize) || version.manifest.sourceByteSize <= 0) {
    return unavailable("no-source-artifact");
  }

  /*
   * A materialized output takes precedence for `auto`, and is invisible to
   * versions that have none (every version written before editing sessions
   * carried a scene has `outputKey: null`, so those resolve exactly as before).
   *
   * The output has no recorded byte length — the manifest records one for the
   * source only — so `byteSize` is null and the caller asks the store. Reporting
   * the SOURCE's length for the output would be worse than reporting none: a
   * Content-Length that disagrees with the body truncates the download.
   */
  const outputKey = version.manifest.outputKey;
  if (wanted === "auto" && typeof outputKey === "string" && outputKey.trim() !== "") {
    return {
      ok: true,
      sourceKey: outputKey,
      byteSize: null,
      checksum: version.manifest.outputChecksum ?? "",
      versionNumber: version.versionNumber,
      versionId: version.id,
      artifact: "output",
    };
  }

  return {
    ok: true,
    sourceKey,
    byteSize: version.manifest.sourceByteSize,
    checksum: version.manifest.sourceChecksum,
    versionNumber: version.versionNumber,
    versionId: version.id,
    artifact: "source",
  };
}

/** Bounds on the query parameters the content route accepts. */
export const CONTENT_REQUEST_LIMITS = {
  maxIdLength: 200,
  maxVersionNumber: 1_000_000_000,
} as const;

/** A parsed, bounded content request. */
export type ContentRequest =
  | {
      ok: true;
      organizationId: string;
      versionNumber: number | null;
      disposition: "inline" | "attachment";
      artifact: ContentArtifact;
    }
  | { ok: false; message: string };

/**
 * Parses and bounds the content route's query parameters.
 *
 * `version` is optional; when absent the current version is served. An
 * unparseable or out-of-range value is rejected rather than coerced, because
 * silently serving "the latest" for a request that asked for a specific version
 * would hand back bytes the caller did not ask for.
 */
export function parseContentRequest(params: URLSearchParams): ContentRequest {
  const organizationId = params.get("organizationId");
  if (!organizationId || organizationId.length > CONTENT_REQUEST_LIMITS.maxIdLength) {
    return { ok: false, message: "organizationId is required." };
  }

  let versionNumber: number | null = null;
  const rawVersion = params.get("version");
  if (rawVersion !== null && rawVersion !== "") {
    if (!/^[0-9]{1,10}$/.test(rawVersion)) {
      return { ok: false, message: "version must be a positive integer." };
    }
    const parsed = Number(rawVersion);
    if (parsed <= 0 || parsed > CONTENT_REQUEST_LIMITS.maxVersionNumber) {
      return { ok: false, message: "version is out of range." };
    }
    versionNumber = parsed;
  }

  // Inline is the default because the editor embeds this response. Download is
  // opt-in, and is the only mode that names the file.
  const disposition = params.get("download") === "1" ? "attachment" : "inline";

  /*
   * `artifact` is an allow-list of two literals, not a pass-through. It selects
   * between artifacts of a version the caller is already authorized to read, and
   * an unrecognised value is rejected rather than defaulted — a caller asking for
   * something this route does not understand should be told, not quietly handed
   * the published bytes it did not ask for.
   */
  const rawArtifact = params.get("artifact");
  let artifact: ContentArtifact = "auto";
  if (rawArtifact !== null && rawArtifact !== "") {
    if (rawArtifact !== "auto" && rawArtifact !== "source") {
      return { ok: false, message: "artifact must be `auto` or `source`." };
    }
    artifact = rawArtifact;
  }

  return { ok: true, organizationId, versionNumber, disposition, artifact };
}

/**
 * Builds a Content-Disposition value that cannot break out of the header.
 *
 * The document name is user-supplied. Quoted-string form carries an ASCII
 * fallback with every character that could terminate the quoted string or
 * inject a new header removed; RFC 5987 `filename*` carries the real name for
 * clients that support it.
 */
export function contentDisposition(
  mode: "inline" | "attachment",
  documentName: string,
): string {
  if (mode === "inline") return "inline";

  const withExtension = /\.pdf$/i.test(documentName) ? documentName : `${documentName}.pdf`;
  return attachmentDisposition(withExtension);
}

/**
 * `attachment` for a filename that already carries its own extension.
 *
 * The same two-form header as above, factored out because job outputs are not
 * all PDFs (a `.docx`, a `.zip`, a `.jpg`) and must not have `.pdf` appended.
 * Header safety lives HERE rather than in the filename policy: the policy's job
 * is to produce a name a person can read, and a name with an em-dash or a CJK
 * character is a perfectly good filename that simply cannot travel raw in an
 * HTTP header.
 */
export function attachmentDisposition(fileName: string): string {
  const ascii =
    fileName
      // Anything outside printable ASCII, plus the quoting and header-injection
      // characters, becomes an underscore.
      .replace(/[^\x20-\x7E]/g, "_")
      .replace(/["\\;\r\n]/g, "_")
      .slice(0, 150)
      .trim() || "document";

  const encoded = encodeURIComponent(fileName.slice(0, 150));
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * How a client should treat a document that has no servable bytes yet.
 *
 * The distinction matters to the editor: "still being prepared" is worth waiting
 * for, "could not be prepared" is not, and showing the same spinner for both is
 * what turns a failed upload into an endless wait. This is a *processing state*,
 * never a storage detail — it says what is happening to the document, not where
 * its bytes would live.
 */
export type ContentPreparation = "processing" | "failed" | "none";

/**
 * Maps an ingestion status to the preparation state the client acts on.
 *
 * `pending`/`processing` are the waitable states. A `failed` ingestion is
 * terminal until someone retries it, and `complete` with no servable version is
 * reported as `none` rather than `processing` — claiming a document is still
 * being prepared when nothing is preparing it would produce a spinner that never
 * resolves.
 */
export function preparationFromIngestion(
  status: "pending" | "processing" | "complete" | "failed" | null,
): ContentPreparation {
  if (status === "pending" || status === "processing") return "processing";
  if (status === "failed") return "failed";
  return "none";
}

/**
 * The response headers for served document bytes.
 *
 * `private, no-store` because the bytes are tenant data behind authorization: a
 * shared cache holding them is a cross-tenant disclosure, and a browser cache
 * holding them survives a sign-out. `nosniff` keeps the declared PDF type from
 * being re-interpreted.
 *
 * The source *checksum* is deliberately not echoed. Uploaded objects are
 * content-addressed — the storage key is derived from that very checksum
 * (`ca/<aa>/<bb>/<sha256>`) — so returning it would hand the client the object's
 * storage location under another name. The version number is safe and is what a
 * client actually needs: it identifies which checkpoint it is looking at.
 */
export function contentHeaders(input: {
  /** Omitted when the length is unknown; a wrong Content-Length truncates the body. */
  byteSize: number | null;
  disposition: string;
  versionNumber: number;
  /**
   * The DOCUMENT RECORD's revision — the editor's compare-and-swap token, and a
   * different counter from `versionNumber`.
   *
   * Both are here because the editor needs both and they are not interchangeable:
   * the version number names the checkpoint on screen, while the revision is what
   * a later write is fenced against. A rename advances the revision and creates no
   * version, so an editor that used the version number as its token conflicted
   * with the document it had itself just published. Omitted when unknown rather
   * than guessed; a client with no token reads one before writing.
   */
  documentRevision?: number | null;
}): Record<string, string> {
  return {
    "Content-Type": "application/pdf",
    ...(input.byteSize !== null && input.byteSize > 0
      ? { "Content-Length": String(input.byteSize) }
      : {}),
    "Content-Disposition": input.disposition,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store, max-age=0",
    "X-Document-Version": String(input.versionNumber),
    ...(input.documentRevision != null
      ? { "X-Document-Revision": String(input.documentRevision) }
      : {}),
  };
}
