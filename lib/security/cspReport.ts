/**
 * Parsing and sanitization for browser CSP violation reports.
 *
 * Pure and Next-free so the redaction rules can be tested directly. The route
 * (`app/api/csp-report/route.ts`) owns transport concerns — method, size cap, rate
 * limit — and this owns the only question that actually matters: *what is allowed to
 * reach a log line.*
 *
 * ## A violation report is attacker- and user-influenced data
 *
 * It arrives from a browser, describing a page the user was on, and several of its
 * fields quote content verbatim. Three of them are outright dangerous to persist:
 *
 * - **`sample` / `script-sample`** is the first 40 characters of the blocked inline
 *   script or style. On this app that is React Flight data — serialized props, which
 *   is to say document titles, filenames and anything else the page was rendering.
 *   **Dropped entirely.** There is no version of this field that is safe by length.
 * - **`originalPolicy`** is our own header echoed back. Harmless today; the moment
 *   3.2 puts a nonce in `script-src` it is a secret being POSTed to a log.
 *   **Dropped entirely** — and dropped now, not later, because the slice that adds
 *   the nonce will not think to come back here.
 * - **`blockedURL`** may be a `data:` URL. In this app that is the *literal page
 *   raster or uploaded image* (`canvas.toDataURL`, `readImageFileAsDataUrl`), so the
 *   user's document would be base64'd into a log line. Opaque schemes are reduced to
 *   the scheme alone.
 *
 * Everything that survives is reduced to origin + pathname. Query strings are where
 * this codebase keeps things worth not logging — the HMAC on a local signed download
 * URL, `?next=`, `?checkout=` — and the diagnostic value of a violation is the
 * directive and the path, never the parameters.
 */

/** A violation, reduced to what is safe to log and still useful. */
export interface SanitizedCspReport {
  /** The directive that would have blocked, e.g. `script-src-elem`. */
  directive: string;
  /** Blocked source: an origin+path, a bare scheme (`data:`), or a CSP keyword. */
  blocked: string;
  /** Pathname of the document that reported, query and fragment removed. */
  documentPath: string;
  /** Origin+path of the script that triggered it, when the browser said. */
  sourceFile?: string;
  line?: number;
  /** `"report"` for Report-Only, `"enforce"` once enforced. */
  disposition?: string;
}

/** Hard ceiling on reports honoured from one request body. */
export const MAX_REPORTS_PER_REQUEST = 20;

const MAX_DIRECTIVE_LEN = 64;
const MAX_URL_LEN = 256;
const MAX_PATH_LEN = 256;

/**
 * Schemes whose body IS content. Reduced to the scheme so a report can still say
 * "an inline data image was blocked" without carrying the image.
 */
const OPAQUE_SCHEMES = ["data:", "blob:", "filesystem:", "javascript:"];

/**
 * CSP's own non-URL placeholders. `blocked-uri` is these strings for inline and eval
 * violations, and they must pass through untouched — they are the diagnosis.
 */
const CSP_KEYWORDS = new Set([
  "inline",
  "eval",
  "wasm-eval",
  "self",
  "unsafe-eval",
  "unsafe-inline",
  "trusted-types-policy",
  "trusted-types-sink",
]);

/**
 * Extracts every report from a raw request body, whichever of the two wire formats
 * the browser used.
 *
 * Chrome sends the Reporting API shape (`application/reports+json`, a JSON array of
 * `{ type, body }`); Firefox and Safari send the legacy shape
 * (`application/csp-report`, `{ "csp-report": {...} }`). Both are accepted because
 * supporting only one silently loses most of the fleet.
 *
 * Never throws. A body that is not JSON, not an object, or shaped like neither yields
 * `[]` — a diagnostics endpoint has nothing to gain from distinguishing "malformed"
 * from "empty", and an endpoint that answers differently for the two is an oracle.
 */
export function parseCspReports(raw: string): SanitizedCspReport[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const bodies: unknown[] = [];
  if (Array.isArray(parsed)) {
    // Reporting API batch. Ignore other report types (deprecation, intervention)
    // that share the same endpoint group.
    for (const item of parsed.slice(0, MAX_REPORTS_PER_REQUEST)) {
      const entry = item as { type?: unknown; body?: unknown } | null;
      if (!entry || typeof entry !== "object") continue;
      if (entry.type !== undefined && entry.type !== "csp-violation") continue;
      bodies.push(entry.body);
    }
  } else if (parsed && typeof parsed === "object") {
    const legacy = (parsed as { "csp-report"?: unknown })["csp-report"];
    bodies.push(legacy !== undefined ? legacy : parsed);
  }

  const out: SanitizedCspReport[] = [];
  for (const body of bodies.slice(0, MAX_REPORTS_PER_REQUEST)) {
    const report = sanitizeCspReport(body);
    if (report) out.push(report);
  }
  return out;
}

/**
 * Reduces one report body to {@link SanitizedCspReport}, or `null` when it does not
 * even name a directive — with no directive there is nothing to diagnose, and an
 * arbitrary JSON object POSTed to this path should not become a log entry.
 *
 * Both field spellings are read: `effectiveDirective`/`blockedURL`/`documentURL`
 * (Reporting API) and `effective-directive`/`blocked-uri`/`document-uri` (legacy).
 */
export function sanitizeCspReport(input: unknown): SanitizedCspReport | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const body = input as Record<string, unknown>;

  const directive = token(
    pick(body, "effectiveDirective", "effective-directive") ??
      pick(body, "violatedDirective", "violated-directive"),
  );
  if (!directive) return null;

  const report: SanitizedCspReport = {
    directive,
    blocked: safeSource(pick(body, "blockedURL", "blocked-uri")),
    documentPath: safePath(pick(body, "documentURL", "document-uri")),
  };

  const sourceFile = pick(body, "sourceFile", "source-file");
  if (sourceFile) {
    const safe = safeSource(sourceFile);
    if (safe) report.sourceFile = safe;
  }

  const line = pick(body, "lineNumber", "line-number");
  const lineNum = Number(line);
  if (line !== undefined && Number.isFinite(lineNum) && lineNum >= 0) {
    report.line = Math.trunc(lineNum);
  }

  const disposition = token(pick(body, "disposition"));
  if (disposition) report.disposition = disposition;

  // `sample`, `script-sample`, `originalPolicy`, `original-policy`, `referrer` and
  // `statusCode` are read by nothing above. That is the redaction: they are not
  // filtered downstream, they never enter the object.
  return report;
}

/** First present string among the given keys. */
function pick(body: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/**
 * A short identifier-ish token. Anything else is dropped rather than escaped.
 *
 * Validated BEFORE any length bound, never after. Truncating first means the regex
 * checks the truncation rather than the input, so `"img-src" + 57 clean chars +
 * "; anything at all"` would pass — the junk is simply beyond the cut. A directive is
 * a short name or it is not a directive.
 */
function token(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.length > MAX_DIRECTIVE_LEN) return "";
  return /^[a-zA-Z0-9_-]+$/.test(trimmed) ? trimmed : "";
}

/**
 * Reduces a `blocked-uri`/`source-file` to something loggable.
 *
 * Order matters: keywords first (they are not URLs), then opaque schemes (scheme
 * only — the rest is content), then real URLs (origin + pathname, no query, no
 * fragment). An unparseable value becomes `"unknown"` rather than being echoed;
 * echoing it is how a crafted report gets its payload into the log.
 */
export function safeSource(value: string | undefined): string {
  if (!value) return "";
  const raw = value.trim();
  if (CSP_KEYWORDS.has(raw)) return raw;

  const lower = raw.toLowerCase();
  for (const scheme of OPAQUE_SCHEMES) {
    if (lower.startsWith(scheme)) return scheme;
  }

  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`.slice(0, MAX_URL_LEN);
  } catch {
    // Relative paths appear here too ("/api/foo?x=1"); keep the path, drop the rest.
    if (raw.startsWith("/")) return safePath(raw);
    return "unknown";
  }
}

/** Pathname only — no origin, no query, no fragment. */
export function safePath(value: string | undefined): string {
  if (!value) return "";
  const raw = value.trim();
  try {
    return new URL(raw).pathname.slice(0, MAX_PATH_LEN);
  } catch {
    const path = raw.split(/[?#]/, 1)[0];
    return path.startsWith("/") ? path.slice(0, MAX_PATH_LEN) : "";
  }
}
