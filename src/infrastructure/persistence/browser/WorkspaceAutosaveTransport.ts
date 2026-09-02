import {
  persistenceFailure,
  type PersistenceFailure,
} from "@/src/application/editor/persistence/events";
import type {
  RemoteDocumentTransport,
  RemoteSaveOutcome,
  RemoteSavePayload,
} from "@/src/application/editor/persistence/ports";
import { AUTOSAVE_DRAFT_LIMITS } from "@/src/domain/entities/AutosaveDraft";

/**
 * {@link RemoteDocumentTransport} over the M7.5 autosave routes.
 *
 * THE VERSION MAPPING, which is the whole point of this file. The server's
 * concurrency authority is `DocumentRecord.revision`, and `AutosaveService`
 * conflicts a save when `document.revision > expectedRevision`. The editor's own
 * `revision` is a completely different number — a per-mutation counter that
 * resets with every reload. Sending one where the other belongs would either
 * conflict on every save (editor revision below the document revision) or
 * silently overwrite concurrent work (editor revision above it). So:
 *
 *   expectedServerVersion  ->  expectedRevision  AND  baseVersion
 *   revision (editor)      ->  inside the payload envelope, never a route field
 *
 * The editor revision still travels, because recovery needs to know which
 * mutation the stored snapshot corresponds to — it just travels as data, not as
 * a concurrency token.
 *
 * WHY A NULL EXPECTED VERSION IS FETCHED, NOT DEFAULTED. `expectedRevision: 0`
 * would be read by the server as "I believe this document has never been
 * revised", which for any real document is `revision > 0` and therefore an
 * instant conflict. A conflict the client manufactured out of its own ignorance
 * is worse than a round trip: it would put the document into a state whose only
 * resolutions are "review" and "overwrite". So an unknown version is resolved by
 * reading it first.
 *
 * WHAT THIS TRANSPORT DOES NOT DO. It never decides what wins. A conflict comes
 * back as a conflict, with both version numbers, for the coordinator and
 * ultimately the user to resolve. It also never retries: retry timing, backoff
 * and the offline gate live in the scheduler, which can see the whole queue.
 */

export interface WorkspaceAutosaveTransportOptions {
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * The largest payload the route will accept, in bytes. Defaults to the domain
   * limit so the client and server agree by construction rather than by comment.
   */
  maxPayloadBytes?: number;
  /** Bounds a save. A request left hanging would hold the write slot forever. */
  timeoutMs?: number;
  /** Injected so the size pre-flight is testable in a Node context. */
  byteLength?: (value: string) => number;
}

/**
 * What actually goes into the route's opaque `payload` string.
 *
 * `format` and `version` are here so a future build can recognise — and refuse,
 * loudly — a snapshot written by a newer client, rather than handing an
 * unrecognised object to the deserializer. `clientTimestamp` is display metadata
 * only; see {@link RemoteSavePayload}.
 */
export interface RemoteSnapshotEnvelope {
  format: "pdfdadi-remote-snapshot";
  version: 1;
  revision: number;
  expectedServerVersion: number | null;
  etag: string | null;
  clientTimestamp: number;
  snapshot: unknown;
}

export const REMOTE_SNAPSHOT_FORMAT = "pdfdadi-remote-snapshot";
export const REMOTE_SNAPSHOT_VERSION = 1;

const DEFAULT_TIMEOUT_MS = 20_000;

/** The `{ draft }` shape the autosave routes return, narrowed to what is used. */
interface AutosaveDraftShape {
  status?: unknown;
  failureReason?: unknown;
  checksum?: unknown;
  expectedRevision?: unknown;
  baseVersion?: unknown;
}

function utf8Length(value: string): number {
  // `TextEncoder` is available in every browser this app supports and in Node 18+,
  // and `Buffer` is not available in the browser — so the byte count is measured
  // the one way that is correct in both.
  return new TextEncoder().encode(value).byteLength;
}

/**
 * HTTP status to failure category.
 *
 * 5xx and 429 are retryable; a 4xx that describes the request is not, because the
 * identical request will be refused identically. 409 never reaches here — it is
 * a conflict outcome, not a failure.
 */
function classifyStatus(status: number, message: string): PersistenceFailure {
  if (status === 401 || status === 403) {
    return persistenceFailure("unauthorized", "Your session has expired. Sign in again to resume cloud saving.");
  }
  if (status === 404) {
    return persistenceFailure("rejected", "This document is no longer available in the workspace.");
  }
  if (status === 413) {
    return persistenceFailure("payload_too_large", "This document is too large for cloud autosave.");
  }
  if (status === 422) {
    return persistenceFailure("rejected", message || "The workspace refused the save.");
  }
  if (status === 429) {
    return persistenceFailure("timeout", "The workspace is rate-limiting saves. Retrying shortly.");
  }
  if (status >= 500) {
    return persistenceFailure("network", `The workspace server failed (${status}).`);
  }
  return persistenceFailure("rejected", message || `The workspace refused the save (${status}).`);
}

/**
 * A thrown `fetch` rejection to a category.
 *
 * `AbortError` is this transport's own timeout, so it is a timeout rather than a
 * network fault; anything else that throws out of `fetch` never reached the
 * server, which is exactly `network`.
 */
function classifyThrown(error: unknown): PersistenceFailure {
  const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
  if (name === "AbortError" || name === "TimeoutError") {
    return persistenceFailure("timeout", "The cloud save timed out.");
  }
  return persistenceFailure("network", "No connection to the workspace.");
}

export class WorkspaceAutosaveTransport implements RemoteDocumentTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly maxPayloadBytes: number;
  private readonly timeoutMs: number;
  private readonly byteLength: (value: string) => number;

  constructor(options: WorkspaceAutosaveTransportOptions = {}) {
    this.fetchImpl =
      options.fetchImpl ??
      ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    this.maxPayloadBytes = options.maxPayloadBytes ?? AUTOSAVE_DRAFT_LIMITS.maxPayloadBytes;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.byteLength = options.byteLength ?? utf8Length;
  }

  async save(payload: RemoteSavePayload, signal?: AbortSignal): Promise<RemoteSaveOutcome> {
    /*
     * Resolve the expected version BEFORE serialising anything. If the read
     * fails, nothing has been sent and the coordinator can retry the whole save
     * later — as opposed to sending a version the client guessed.
     */
    let expected = payload.expectedServerVersion;
    if (expected === null) {
      let discovered: { serverVersion: number | null } | null;
      try {
        discovered = await this.readVersion(payload);
      } catch (error) {
        return { kind: "failed", failure: classifyThrown(error) };
      }
      if (!discovered || discovered.serverVersion === null) {
        return {
          kind: "failed",
          failure: persistenceFailure(
            "rejected",
            "The workspace could not confirm this document's current version.",
          ),
        };
      }
      expected = discovered.serverVersion;
    }

    const envelope: RemoteSnapshotEnvelope = {
      format: REMOTE_SNAPSHOT_FORMAT,
      version: REMOTE_SNAPSHOT_VERSION,
      revision: payload.revision,
      expectedServerVersion: expected,
      etag: payload.etag,
      clientTimestamp: payload.clientTimestamp,
      snapshot: payload.snapshot,
    };

    let body: string;
    try {
      body = JSON.stringify(envelope);
    } catch {
      // A cyclic or non-serialisable scene graph. Not a network condition, and
      // not something a retry fixes.
      return {
        kind: "failed",
        failure: persistenceFailure("integrity_failed", "This document could not be serialized for cloud saving."),
      };
    }

    /*
     * The size pre-flight. Sending 30 MB to a 1 MiB endpoint wastes the user's
     * upload, blocks the queue for the duration, and comes back as an opaque 413
     * — so the limit is checked here, where the failure can be described
     * accurately and marked non-retryable. This is a REAL product ceiling, not a
     * defensive check: a document with a few embedded photos exceeds it.
     */
    const bytes = this.byteLength(body);
    if (bytes > this.maxPayloadBytes) {
      return {
        kind: "failed",
        failure: persistenceFailure(
          "payload_too_large",
          `This document is too large for cloud autosave (${Math.round(bytes / 1024)} KB, limit ${Math.round(this.maxPayloadBytes / 1024)} KB).`,
        ),
      };
    }

    const url = `/api/workspaces/${encodeURIComponent(payload.workspaceId)}/documents/${encodeURIComponent(payload.documentId)}/autosave`;
    let response: Response;
    try {
      response = await this.post(
        url,
        {
          organizationId: payload.organizationId,
          deviceId: payload.deviceId,
          // Both route fields carry the SERVER version, for the reason at the top
          // of this file. `baseVersion` is recorded; `expectedRevision` is the one
          // the service compares.
          baseVersion: expected,
          expectedRevision: expected,
          payload: body,
        },
        signal,
      );
    } catch (error) {
      return { kind: "failed", failure: classifyThrown(error) };
    }

    /*
     * 409 is the OTHER conflict shape. `AutosaveService` throws
     * `DomainError("The draft changed concurrently…")` when its own row moved
     * underneath the write, and `mapWorkspaceError` renders that as 409. It means
     * the same thing to the user as a status-conflict draft: two writers, nobody
     * silently loses. Both map here.
     */
    if (response.status === 409) {
      const detail = await this.errorMessage(response);
      const actual = await this.currentVersionQuietly(payload);
      return {
        kind: "conflict",
        actualServerVersion: actual,
        expectedServerVersion: expected,
        detail: detail ?? "Another save for this document completed first.",
      };
    }

    if (!response.ok) {
      const detail = await this.errorMessage(response);
      return { kind: "failed", failure: classifyStatus(response.status, detail ?? "") };
    }

    let draft: AutosaveDraftShape | null;
    try {
      const data: { draft?: AutosaveDraftShape } = await response.json();
      draft = data.draft ?? null;
    } catch {
      // A 200 whose body is not the documented shape. The bytes may well have
      // landed, but this client cannot prove it — and the honest report of "I do
      // not know whether that saved" is a retryable failure, not a `Saved`.
      return {
        kind: "failed",
        failure: persistenceFailure("unknown", "The workspace returned an unreadable response."),
      };
    }

    /*
     * THE 200-CONFLICT. This is the shape that would silently corrupt the status
     * if it were treated as success: the route returns HTTP 200 with a draft
     * whose status is `conflict`, because the draft WAS stored (nothing is lost)
     * but the document has moved on and the save must not be presented as
     * synced. `response.ok` is not sufficient evidence of a save.
     */
    if (draft?.status === "conflict") {
      const actual = await this.currentVersionQuietly(payload);
      return {
        kind: "conflict",
        actualServerVersion: actual,
        expectedServerVersion: expected,
        detail:
          typeof draft.failureReason === "string" && draft.failureReason
            ? draft.failureReason
            : "The workspace copy changed while you were editing.",
      };
    }

    /*
     * `serverVersion` is echoed back as what was written OVER, not incremented:
     * an autosave draft does not create a document revision, so the server's
     * version is unchanged by a successful save. Reporting `expected + 1` here
     * would guarantee a spurious conflict on the very next save.
     */
    return {
      kind: "saved",
      serverVersion: expected,
      etag: typeof draft?.checksum === "string" ? draft.checksum : null,
    };
  }

  async readVersion(input: {
    documentId: string;
    workspaceId: string;
    organizationId: string;
    deviceId: string;
  }): Promise<{ serverVersion: number | null; etag: string | null } | null> {
    const url =
      `/api/workspaces/${encodeURIComponent(input.workspaceId)}/documents/${encodeURIComponent(input.documentId)}` +
      `?organizationId=${encodeURIComponent(input.organizationId)}`;
    const response = await this.withTimeout((signal) =>
      this.fetchImpl(url, {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        // Never a cached copy: a stale version number is the one input that turns
        // conflict detection into silent overwriting.
        cache: "no-store",
        signal,
      }),
    );
    // A document that is gone is reported as "no version", not as an error — the
    // caller's next decision is to stop trying, not to retry.
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`document read failed: ${response.status}`);
    }
    const data: { document?: { revision?: unknown; updatedAt?: unknown } } = await response
      .json()
      .catch(() => ({}));
    const revision = data.document?.revision;
    if (typeof revision !== "number" || !Number.isFinite(revision)) return null;
    return {
      serverVersion: revision,
      // The route exposes no HTTP ETag, so the version is the only validator; a
      // fabricated one would be worse than none.
      etag: null,
    };
  }

  // ---------------------------------------------------------------- internals

  /**
   * The current server version, or `null` if it cannot be read.
   *
   * Used only to ENRICH a conflict that has already been detected. A failure here
   * must not turn a conflict into a network error: the conflict is the fact, and
   * the version numbers are context the resolution UI degrades without.
   */
  private async currentVersionQuietly(input: {
    documentId: string;
    workspaceId: string;
    organizationId: string;
    deviceId: string;
  }): Promise<number | null> {
    try {
      const read = await this.readVersion(input);
      return read?.serverVersion ?? null;
    } catch {
      return null;
    }
  }

  private post(url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return this.withTimeout(
      (timeoutSignal) =>
        this.fetchImpl(url, {
          method: "POST",
          // `requireSameOrigin` on the route rejects a request without a matching
          // Origin, and cookies must ride along for the actor lookup.
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body),
          signal: timeoutSignal,
        }),
      signal,
    );
  }

  /**
   * Runs a request under this transport's time budget, honouring a caller's abort
   * as well.
   *
   * `AbortSignal.any` is not available everywhere this ships, so the two signals
   * are combined by hand rather than assumed.
   */
  private async withTimeout(run: (signal: AbortSignal) => Promise<Response>, caller?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(caller?.reason);
    if (caller) {
      if (caller.aborted) controller.abort(caller.reason);
      else caller.addEventListener("abort", onCallerAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), this.timeoutMs);
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    }
  }

  /** The `{ error: { message } }` body the workspace routes return, if readable. */
  private async errorMessage(response: Response): Promise<string | null> {
    try {
      const data: { error?: { message?: unknown } } = await response.json();
      const message = data.error?.message;
      return typeof message === "string" && message ? message : null;
    } catch {
      return null;
    }
  }
}
