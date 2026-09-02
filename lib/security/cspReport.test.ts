import { describe, expect, it } from "vitest";
import {
  MAX_REPORTS_PER_REQUEST,
  parseCspReports,
  safePath,
  safeSource,
  sanitizeCspReport,
} from "./cspReport";

/**
 * What a violation report is allowed to leave behind in a log.
 *
 * The interesting assertions here are the negative ones, and they are written as
 * "the whole serialized record does not contain X" rather than "field Y is absent".
 * A field-by-field test passes happily while the secret rides in on a *different*
 * field — which is the realistic failure, since three separate report fields can
 * carry the same document URL.
 */

/** Everything a browser can send, with something sensitive in every field. */
const HOSTILE_LEGACY = {
  "csp-report": {
    "document-uri":
      "https://pdfdadi.com/workspaces/ws_1?token=sk_live_abcdef&next=/secret",
    referrer: "https://mail.example.com/inbox?thread=private-subject-line",
    "violated-directive": "img-src",
    "effective-directive": "img-src",
    "original-policy":
      "default-src 'self'; script-src 'nonce-SUPERSECRETNONCE' 'strict-dynamic'",
    disposition: "report",
    "blocked-uri":
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAquserdocumentbytes",
    "status-code": 200,
    "script-sample": 'self.__next_f.push([1,"{\\"invoice\\":\\"Acme Q3 payroll\\"}"])',
    "source-file": "https://pdfdadi.com/_next/static/chunks/x.js?v=deadbeef",
    "line-number": 42,
    "column-number": 7,
  },
};

const HOSTILE_REPORTING_API = [
  {
    age: 12,
    type: "csp-violation",
    url: "https://pdfdadi.com/editor?doc=doc_42&sig=abc123",
    user_agent: "Mozilla/5.0",
    body: {
      documentURL: "https://pdfdadi.com/editor?doc=doc_42&sig=abc123",
      referrer: "https://pdfdadi.com/workspaces/ws_1?token=sk_live_abcdef",
      blockedURL: "blob:https://pdfdadi.com/8f0e-real-user-file",
      effectiveDirective: "img-src",
      originalPolicy: "script-src 'nonce-SUPERSECRETNONCE'",
      disposition: "report",
      sample: "the user's inline content",
      sourceFile: "https://pdfdadi.com/_next/static/chunks/y.js?v=deadbeef",
      statusCode: 200,
      lineNumber: 1,
      columnNumber: 2,
    },
  },
];

/** The forbidden substrings, as they appear in the fixtures above. */
const MUST_NEVER_APPEAR = [
  "sk_live_abcdef",
  "SUPERSECRETNONCE",
  "iVBORw0KGgo",
  "quserdocumentbytes",
  "Acme Q3 payroll",
  "private-subject-line",
  "the user's inline content",
  "deadbeef",
  "8f0e-real-user-file",
  "?",
  "=",
];

describe("parseCspReports — the redaction contract", () => {
  it("leaks nothing sensitive from a legacy report, on any field", () => {
    const [report] = parseCspReports(JSON.stringify(HOSTILE_LEGACY));
    const serialized = JSON.stringify(report);
    // Anti-vacuity: an empty result would satisfy every negative below.
    expect(report.directive).toBe("img-src");
    for (const secret of MUST_NEVER_APPEAR) {
      expect(serialized, `leaked ${secret}`).not.toContain(secret);
    }
  });

  it("leaks nothing sensitive from a Reporting API batch either", () => {
    const [report] = parseCspReports(JSON.stringify(HOSTILE_REPORTING_API));
    const serialized = JSON.stringify(report);
    expect(report.directive).toBe("img-src");
    for (const secret of MUST_NEVER_APPEAR) {
      expect(serialized, `leaked ${secret}`).not.toContain(secret);
    }
  });

  it("keeps exactly the fields that make a report actionable", () => {
    expect(parseCspReports(JSON.stringify(HOSTILE_LEGACY))).toEqual([
      {
        directive: "img-src",
        // The scheme alone. The rest of that data: URL was the user's document.
        blocked: "data:",
        // Path only — the ?token= and &next= are gone with the query string.
        documentPath: "/workspaces/ws_1",
        sourceFile: "https://pdfdadi.com/_next/static/chunks/x.js",
        line: 42,
        disposition: "report",
      },
    ]);
  });

  it("drops sample, original-policy and referrer as fields, not as values", () => {
    // Proven by key, so a future edit that re-adds one with a "redacted" value
    // still fails: the safe answer is for the key not to exist.
    const [report] = parseCspReports(JSON.stringify(HOSTILE_LEGACY));
    for (const key of [
      "sample",
      "script-sample",
      "scriptSample",
      "originalPolicy",
      "original-policy",
      "referrer",
      "statusCode",
    ]) {
      expect(Object.keys(report)).not.toContain(key);
    }
  });
});

describe("safeSource / safePath", () => {
  it("reduces every content-bearing scheme to the scheme", () => {
    expect(safeSource("data:image/png;base64,AAAA")).toBe("data:");
    expect(safeSource("blob:https://pdfdadi.com/abc")).toBe("blob:");
    expect(safeSource("filesystem:https://x/tmp/f")).toBe("filesystem:");
    expect(safeSource("javascript:alert(document.cookie)")).toBe("javascript:");
    // Case-insensitively — `DATA:` is the same scheme.
    expect(safeSource("DATA:image/png;base64,AAAA")).toBe("data:");
  });

  it("passes CSP's own placeholders through untouched", () => {
    // These are the diagnosis for inline/eval violations, not URLs to sanitize.
    for (const keyword of ["inline", "eval", "wasm-eval", "self"]) {
      expect(safeSource(keyword)).toBe(keyword);
    }
  });

  it("strips query and fragment from real URLs, keeping origin and path", () => {
    expect(safeSource("https://cdn.example.com/a/b.js?sig=secret#frag")).toBe(
      "https://cdn.example.com/a/b.js",
    );
    expect(safeSource("/api/storage/download?sig=hmac&exp=1")).toBe(
      "/api/storage/download",
    );
  });

  it("refuses to echo an unparseable value", () => {
    // A crafted report's payload must not reach the log by being copied verbatim.
    expect(safeSource("not a url at all <script>")).toBe("unknown");
    expect(safeSource("")).toBe("");
  });

  it("returns a path and never an origin for the document URL", () => {
    expect(safePath("https://pdfdadi.com/editor?doc=1#x")).toBe("/editor");
    expect(safePath("/editor?doc=1")).toBe("/editor");
    // Not a URL and not a path: nothing worth recording.
    expect(safePath("garbage")).toBe("");
  });

  it("bounds the length of everything it returns", () => {
    const long = `https://x.example.com/${"a".repeat(5000)}`;
    expect(safeSource(long).length).toBeLessThanOrEqual(256);
    expect(safePath(long).length).toBeLessThanOrEqual(256);
  });
});

describe("parseCspReports — malformed input fails safely", () => {
  it("returns [] for anything that is not a usable report", () => {
    for (const raw of [
      "",
      "not json",
      "null",
      "[]",
      "{}",
      '"a string"',
      "123",
      '{"csp-report":null}',
      '{"csp-report":"a string"}',
      '{"csp-report":[]}',
      // No directive named: nothing to diagnose, so nothing is logged.
      '{"csp-report":{"blocked-uri":"https://evil.test/x"}}',
      // Truncated JSON, which is what a killed request actually looks like.
      '[{"type":"csp-violation","body":{"effectiveDirective":"img-s',
    ]) {
      expect(parseCspReports(raw), `for ${raw}`).toEqual([]);
    }
  });

  it("ignores non-CSP report types that share the endpoint group", () => {
    // Reporting-Endpoints groups are shared: deprecation and intervention reports
    // arrive here too and are not violations.
    const raw = JSON.stringify([
      { type: "deprecation", body: { id: "x", message: "old api" } },
      { type: "csp-violation", body: { effectiveDirective: "font-src" } },
    ]);
    expect(parseCspReports(raw)).toEqual([
      { directive: "font-src", blocked: "", documentPath: "" },
    ]);
  });

  it("caps how many reports one request can produce", () => {
    const many = Array.from({ length: MAX_REPORTS_PER_REQUEST + 25 }, () => ({
      type: "csp-violation",
      body: { effectiveDirective: "img-src" },
    }));
    expect(parseCspReports(JSON.stringify(many))).toHaveLength(
      MAX_REPORTS_PER_REQUEST,
    );
  });

  it("drops a directive that is not a plain token", () => {
    // The directive is the one string that lands in a log unquoted-looking, so it
    // is restricted to an identifier charset rather than escaped.
    expect(
      sanitizeCspReport({ effectiveDirective: "img-src; rm -rf /" }),
    ).toBeNull();
    expect(sanitizeCspReport({ effectiveDirective: "a".repeat(200) })).toBeNull();
    // Validated before it is bounded, so junk cannot simply hide past the cut.
    expect(
      sanitizeCspReport({
        effectiveDirective: `img-src${"a".repeat(57)}; anything at all`,
      }),
    ).toBeNull();
  });

  it("falls back to violated-directive when effective-directive is absent", () => {
    // Safari sends only the deprecated spelling.
    expect(sanitizeCspReport({ "violated-directive": "worker-src" })).toEqual({
      directive: "worker-src",
      blocked: "",
      documentPath: "",
    });
  });

  it("keeps a line number only when it is a real number", () => {
    expect(
      sanitizeCspReport({ effectiveDirective: "img-src", lineNumber: "12" })?.line,
    ).toBe(12);
    for (const bad of [Number.NaN, Infinity, -3, "abc", {}]) {
      const out = sanitizeCspReport({ effectiveDirective: "img-src", lineNumber: bad });
      expect(Object.keys(out!), `for ${String(bad)}`).not.toContain("line");
    }
  });
});
