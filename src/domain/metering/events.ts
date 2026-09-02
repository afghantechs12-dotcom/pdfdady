/**
 * The analytics taxonomy — the event names IAnalytics has always named in its
 * doc comment but never defined, plus the one thing a taxonomy needs to be
 * trustworthy: a declared list of which properties each event may carry.
 *
 * ── Why an allowlist, not a denylist ────────────────────────────────────────
 *
 * The recorder's own doc comment states the privacy rule: no filename, no page
 * text, no form values, no owner id. A denylist enforces that rule only against
 * the leaks someone thought to list. An allowlist inverts the burden: a property
 * that is not explicitly declared for an event is *dropped*, so a new field
 * added to a `track()` call — `{ filename }`, `{ email }`, `{ query }` — reaches
 * no store unless someone also declared it here, where the denylist check below
 * will reject the obviously-sensitive names. Two gates, and the default is to
 * drop.
 *
 * ── Why unknown events are dropped, not rejected ────────────────────────────
 *
 * Old browser tabs outlive deploys. A client running last week's bundle will
 * emit last week's event names, and a taxonomy that 400s on an unknown name
 * turns every stale tab into a retrying error source. Unknown names are dropped
 * silently by `isKnownEvent`; the ingest route returns 204 regardless.
 */

/** The funnel spine plus the outcome events. The closed set of names we record. */
export const ANALYTICS_EVENTS = {
  tool_view: "tool_view",
  tool_start: "tool_start",
  file_selected: "file_selected",
  job_submitted: "job_submitted",
  job_succeeded: "job_succeeded",
  job_failed: "job_failed",
  download: "download",
  signup: "signup",
  login: "login",
  upgrade_view: "upgrade_view",
  limit_reached: "limit_reached",
  /** The server-side processing outcome, from ProcessingUsageRecorder. */
  tool_processing_completed: "tool_processing_completed",
} as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];

export const ALL_ANALYTICS_EVENTS: readonly AnalyticsEventName[] = Object.values(
  ANALYTICS_EVENTS,
);

/**
 * The events a BROWSER may send. A strict subset, and the subset is the point.
 *
 * `tool_processing_completed` and `limit_reached` are server-authoritative — they
 * are what the worker and the admission check observed. If a client could post
 * them, anyone could write "your compressor failed 40,000 times" into the ledger
 * the dashboards read, and there would be no way afterwards to tell the injected
 * rows from the measured ones. `signup` and `login` are excluded for the same
 * reason: the auth routes already record them from the side that knows whether
 * they happened.
 *
 * What is left is exactly the funnel spine plus `download` — the steps that only
 * the browser can see, because they happen before or after any request.
 */
export const CLIENT_INGESTIBLE_EVENTS: readonly AnalyticsEventName[] = [
  ANALYTICS_EVENTS.tool_view,
  ANALYTICS_EVENTS.file_selected,
  ANALYTICS_EVENTS.tool_start,
  ANALYTICS_EVENTS.job_submitted,
  ANALYTICS_EVENTS.job_succeeded,
  ANALYTICS_EVENTS.job_failed,
  ANALYTICS_EVENTS.download,
  ANALYTICS_EVENTS.upgrade_view,
];

export function isClientIngestibleEvent(name: string): name is AnalyticsEventName {
  return (CLIENT_INGESTIBLE_EVENTS as readonly string[]).includes(name);
}

/**
 * Longest string a property value may be. Longer values are truncated, not
 * dropped — an over-long `toolSlug` is still worth counting under its prefix.
 *
 * A dimension is a label, and 120 characters is more than any label the taxonomy
 * declares needs. The cap lives here rather than at the ingest route because
 * every producer routes through `sanitizeEventProperties`, so one clamp covers
 * the browser, the worker and the admission check alike.
 */
export const MAX_PROPERTY_VALUE_LENGTH = 120;

/**
 * Properties every event is allowed to carry, on top of its own list.
 *
 * All non-identifying dimensions of context. `plan`/`ownerType` describe *which
 * kind* of visitor without describing *which* visitor — the exact split the
 * recorder's doc comment calls operationally necessary but individually private.
 */
const COMMON_PROPERTIES = [
  "toolSlug",
  "executionMode",
  "plan",
  "ownerType",
  "surface",
  "inputSizeBucket",
  "outputSizeBucket",
] as const;

/** Per-event additional properties. The key set is the closed taxonomy. */
const EVENT_PROPERTIES: Record<AnalyticsEventName, readonly string[]> = {
  tool_view: [],
  tool_start: [],
  file_selected: ["fileCount"],
  job_submitted: ["fileCount"],
  job_succeeded: ["durationMs", "pageCount"],
  job_failed: ["errorCategory"],
  download: ["format"],
  signup: ["method"],
  login: ["method"],
  upgrade_view: ["fromPlan"],
  limit_reached: ["meter", "reason", "enforced", "limit", "used"],
  tool_processing_completed: [
    "jobId",
    "result",
    "attempt",
    "inputBytes",
    "outputBytes",
    "durationMs",
    "errorCategory",
    "pageCount",
  ],
};

/**
 * Property names that must never appear in the taxonomy, checked against the
 * DECLARED keys (not runtime values). Catches a sensitive field at the moment
 * someone adds it to `EVENT_PROPERTIES`, before any data is collected.
 *
 * Substring match, case-insensitive: `userEmail`, `file_name` and `ownerId` all
 * trip it, so the check is not defeated by a prefix.
 */
export const PRIVACY_DENYLIST: readonly string[] = [
  "filename",
  "file_name",
  "name",
  "email",
  "text",
  "content",
  "body",
  "query",
  "search",
  "key",
  "path",
  "url",
  "ip",
  "ownerid",
  "userid",
  "user_id",
  "password",
  "token",
  "cookie",
  "address",
  "phone",
];

function violatesPrivacy(property: string): boolean {
  const p = property.toLowerCase();
  return PRIVACY_DENYLIST.some((banned) => p.includes(banned));
}

export function isKnownEvent(name: string): name is AnalyticsEventName {
  return (ALL_ANALYTICS_EVENTS as readonly string[]).includes(name);
}

/** The full allowed property set for an event: common ∪ event-specific. */
export function allowedPropertiesFor(name: AnalyticsEventName): ReadonlySet<string> {
  return new Set<string>([...COMMON_PROPERTIES, ...EVENT_PROPERTIES[name]]);
}

/**
 * Drops every property not declared for the event, and coerces values to
 * primitives.
 *
 * Two things happen here, both deliberate. Undeclared keys are removed — the
 * allowlist gate. And a declared key whose value is an object or array is
 * dropped too: a nested value is where a `{ file: { name } }` slips a filename
 * past a flat allowlist, and no analytics dimension legitimately needs one.
 */
export function sanitizeEventProperties(
  name: string,
  properties: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> {
  if (!isKnownEvent(name) || !properties) return {};
  const allowed = allowedPropertiesFor(name);
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!allowed.has(key)) continue;
    if (violatesPrivacy(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      // Truncate rather than reject: see MAX_PROPERTY_VALUE_LENGTH. Without this
      // a caller could put a kilobyte of text in a declared dimension and the
      // allowlist would wave it through, because the allowlist checks the key.
      out[key] = value.slice(0, MAX_PROPERTY_VALUE_LENGTH);
    } else if (typeof value === "number") {
      // NaN and Infinity are `typeof "number"` and would reach a numeric column
      // or JSON.stringify, where they become null and look like a missing
      // measurement rather than a bad one.
      if (Number.isFinite(value)) out[key] = value;
    } else if (typeof value === "boolean") {
      out[key] = value;
    }
    // Objects, arrays, functions, symbols: intentionally dropped.
  }
  return out;
}

/**
 * Self-check: no declared property name is on the denylist.
 *
 * Exported so a guard test can assert the taxonomy is clean without re-listing
 * every event. This is the "cannot add a PII field and have tests still pass"
 * invariant.
 */
export function taxonomyPrivacyViolations(): string[] {
  const problems: string[] = [];
  const check = (property: string, where: string) => {
    if (violatesPrivacy(property)) {
      problems.push(`${where}: property "${property}" is on the privacy denylist`);
    }
  };
  for (const property of COMMON_PROPERTIES) check(property, "common");
  for (const name of ALL_ANALYTICS_EVENTS) {
    for (const property of EVENT_PROPERTIES[name]) check(property, name);
  }
  return problems;
}
