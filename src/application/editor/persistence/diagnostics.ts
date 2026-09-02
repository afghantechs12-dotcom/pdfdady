/**
 * Diagnostics for the persistence path — and the allowlist that keeps them safe.
 *
 * These events exist because "the user says their work vanished" is otherwise
 * unanswerable: the interesting question is almost always *which* revision was
 * durable when, and whether a response was discarded as stale. Counting those is
 * the difference between diagnosing a race and guessing at one.
 *
 * WHY AN ALLOWLIST RATHER THAN A REDACTION PASS. Everything this module can see is
 * document content: the scene graph, the file name, extracted PDF text, image data
 * URLs, signature bitmaps, form values, comments. A deny-list would need to be
 * right about every field that has ever been added to the editor, forever, and a
 * miss ships user document text to a log. So the field names are enumerated here,
 * every other key is dropped, and free-form strings are not accepted at all —
 * only ids, enumerated categories and numbers get through.
 *
 * Note in particular what is NOT loggable: `documentName`. A file name is
 * routinely the most sensitive string in a document workflow, and it earns nothing
 * that `documentId` does not.
 */

export type PersistenceDiagnosticEvent =
  | "local_write_scheduled"
  | "local_write_started"
  | "local_write_succeeded"
  | "local_write_failed"
  | "remote_save_scheduled"
  | "remote_save_started"
  | "remote_save_succeeded"
  | "remote_save_failed"
  | "stale_response_ignored"
  | "conflict_detected"
  | "draft_found"
  | "draft_recovered"
  | "draft_corrupt"
  | "draft_migration_failed"
  | "quota_exceeded"
  | "navigation_blocked_undurable_revision"
  /** A stored draft could not be read at all. Recovery cannot be offered. */
  | "draft_load_failed"
  /** A draft was found but is not ahead of what is already on screen. */
  | "draft_ignored_not_newer"
  /** Deleting a declined draft failed. Harmless, but it explains leftover storage. */
  | "draft_delete_failed"
  /** A sibling tab announced a commit of the same draft. */
  | "peer_commit_observed"
  /**
   * A sibling tab's snapshot is NEWER than the one this tab was about to write.
   *
   * Its own event because it is the one cross-tab case a compare-and-swap cannot
   * catch, and therefore the one worth counting: the pointer is exactly where the
   * peer left it, so the swap would succeed and replace their work.
   */
  | "cross_tab_conflict"
  /** The write ran without mutual exclusion, guarded only by the pointer swap. */
  | "draft_lock_unavailable"
  /** Another tab held the lock, so this attempt never ran. */
  | "draft_lock_contended"
  /** No honest cloud payload could be built for this revision. */
  | "remote_payload_rejected"
  /** The cloud payload fits once bytes the workspace already holds are left out. */
  | "remote_payload_reduced"
  /** What reconnecting decided to do, before anything was sent. */
  | "reconnect_planned"
  /**
   * The diagnostics buffer hit its cap and stopped recording.
   *
   * Its own event, not a `reason` on somebody else's. It was previously emitted as
   * `stale_response_ignored`, which meant anyone counting stale responses — the one
   * metric that proves a request race is really happening — counted diagnostics
   * overflow as evidence of one.
   */
  | "diagnostics_truncated";

export const PERSISTENCE_DIAGNOSTIC_EVENTS: readonly PersistenceDiagnosticEvent[] = [
  "local_write_scheduled",
  "local_write_started",
  "local_write_succeeded",
  "local_write_failed",
  "remote_save_scheduled",
  "remote_save_started",
  "remote_save_succeeded",
  "remote_save_failed",
  "stale_response_ignored",
  "conflict_detected",
  "draft_found",
  "draft_recovered",
  "draft_corrupt",
  "draft_migration_failed",
  "quota_exceeded",
  "navigation_blocked_undurable_revision",
  "draft_load_failed",
  "draft_ignored_not_newer",
  "draft_delete_failed",
  "peer_commit_observed",
  "cross_tab_conflict",
  "draft_lock_unavailable",
  "draft_lock_contended",
  "remote_payload_rejected",
  "remote_payload_reduced",
  "reconnect_planned",
  "diagnostics_truncated",
];

/**
 * The only field names a diagnostic may carry.
 *
 * Opaque identifiers, revision numbers, durations, and closed enumerations. Every
 * one of them is meaningless without the database it points at, which is exactly
 * the property that makes it safe to write to a log.
 */
export const DIAGNOSTIC_FIELDS = [
  "documentId",
  "documentSessionId",
  "documentKey",
  "draftId",
  "requestId",
  "channel",
  "revision",
  "currentRevision",
  "durableRevision",
  "acknowledgedRevision",
  "generation",
  "previousGeneration",
  "durationMs",
  "category",
  "operation",
  "retryCount",
  "staleCount",
  "serverVersion",
  "expectedServerVersion",
  "actualServerVersion",
  "byteLength",
  "assetCount",
  "assetsWritten",
  "missingAssetCount",
  "pageCount",
  "objectCount",
  "schemaVersion",
  "migratedFrom",
  "fellBackToPreviousSnapshot",
  "online",
  "reason",
  /** How many diagnostics the cap discarded. */
  "droppedCount",
  /** How many assets a reduced cloud payload left behind. */
  "omittedCount",
] as const;

export type DiagnosticField = (typeof DIAGNOSTIC_FIELDS)[number];

/** Fields whose values may be strings. Everything else must be a number or boolean. */
const STRING_FIELDS = new Set<DiagnosticField>([
  "documentId",
  "documentSessionId",
  "documentKey",
  "draftId",
  "requestId",
  "channel",
  "category",
  "operation",
  "reason",
]);

/**
 * The longest string any field may carry.
 *
 * Ids in this app are well under this. A value that overruns it is not an id, so
 * truncating is the conservative response — a 4KB "reason" is document content
 * that has been mislabelled.
 */
const MAX_STRING_LENGTH = 120;

export type DiagnosticFields = Partial<Record<DiagnosticField, string | number | boolean | null>>;

export interface PersistenceDiagnostic {
  event: PersistenceDiagnosticEvent;
  at: number;
  fields: DiagnosticFields;
}

export type DiagnosticsSink = (diagnostic: PersistenceDiagnostic) => void;

/**
 * Drops every field that is not on the allowlist, and every value of the wrong
 * shape.
 *
 * Exported because it is the security boundary and therefore needs a test of its
 * own: a sanitizer that silently stopped sanitizing would leave every call site
 * looking unchanged.
 */
export function sanitizeDiagnosticFields(input: Record<string, unknown>): DiagnosticFields {
  const allowed = new Set<string>(DIAGNOSTIC_FIELDS);
  const out: DiagnosticFields = {};
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) continue;
    const field = key as DiagnosticField;
    if (value === null) {
      out[field] = null;
      continue;
    }
    if (typeof value === "number") {
      out[field] = Number.isFinite(value) ? value : null;
      continue;
    }
    if (typeof value === "boolean") {
      out[field] = value;
      continue;
    }
    if (typeof value === "string" && STRING_FIELDS.has(field)) {
      out[field] = value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
      continue;
    }
    // Objects, arrays, functions, and strings in numeric fields are dropped. A
    // scene graph passed here by mistake produces nothing rather than everything.
  }
  return out;
}

export interface DiagnosticsOptions {
  /** Where sanitized diagnostics go. */
  sink?: DiagnosticsSink;
  /** False suppresses everything. Defaults to non-production. */
  enabled?: boolean;
  now?: () => number;
  /**
   * Cap on events emitted per session.
   *
   * A pathological retry loop would otherwise fill the console and, with a remote
   * sink, generate traffic of its own — which is a poor way to report that
   * something is already failing.
   */
  maxEvents?: number;
}

export interface Diagnostics {
  emit(event: PersistenceDiagnosticEvent, fields?: Record<string, unknown>): void;
  /** Everything emitted, for tests and for a support "copy diagnostics" action. */
  history(): readonly PersistenceDiagnostic[];
  readonly enabled: boolean;
}

const DEFAULT_MAX_EVENTS = 500;

export function createDiagnostics(options: DiagnosticsOptions = {}): Diagnostics {
  const now = options.now ?? (() => Date.now());
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const enabled = options.enabled ?? true;
  const log: PersistenceDiagnostic[] = [];
  let dropped = 0;

  return {
    enabled,
    emit(event, fields = {}) {
      if (!enabled) return;
      if (log.length >= maxEvents) {
        dropped += 1;
        return;
      }
      const diagnostic: PersistenceDiagnostic = {
        event,
        at: now(),
        fields: sanitizeDiagnosticFields(fields),
      };
      log.push(diagnostic);
      options.sink?.(diagnostic);
    },
    history() {
      if (dropped > 0) {
        return [
          ...log,
          {
            event: "diagnostics_truncated" as const,
            at: now(),
            fields: { droppedCount: dropped },
          },
        ];
      }
      return log;
    },
  };
}

/**
 * A sink that writes to the console, grouped under one prefix.
 *
 * `console.debug` rather than `log` or `warn`: these are traces, and a browser's
 * default level hides them until someone goes looking. A failing save is reported
 * to the user through the status component, not through the console.
 */
export function consoleDiagnosticsSink(prefix = "[pdfdadi:persistence]"): DiagnosticsSink {
  return (diagnostic) => {
    console.debug(prefix, diagnostic.event, diagnostic.fields);
  };
}
