import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  POST,
  GET,
  PUT,
  PATCH,
  DELETE,
} from "@/app/api/csp-report/route";
import { MAX_REPORTS_PER_REQUEST } from "@/lib/security/cspReport";
import { CSP_ENFORCED_HEADER, CSP_HEADER } from "@/lib/security/csp.mjs";

/**
 * HTTP contract for the report sink.
 *
 * No container mocks are needed and that is the point: this route resolves nothing,
 * reads no session and touches no database, so the whole surface is
 * request-in/response-out plus one log line. The assertions below are chosen to fail
 * if any of that changes — a route that grew a dependency would start needing mocks
 * here, which is the signal.
 */

const ORIGIN = "http://localhost:3000";

/** A distinct IP per test, so the shared module-level limiter cannot bleed across. */
let ip = 0;
function nextIp(): string {
  ip += 1;
  return `10.0.0.${ip % 250}${Math.floor(ip / 250)}`;
}

function post(
  body: unknown,
  { headers = {}, from = nextIp() }: { headers?: Record<string, string>; from?: string } = {},
): Request {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`${ORIGIN}/api/csp-report`, {
    method: "POST",
    headers: { "content-type": "application/csp-report", "x-forwarded-for": from, ...headers },
    body: raw,
  });
}

const VALID = {
  "csp-report": {
    "document-uri": `${ORIGIN}/editor?doc=1`,
    "effective-directive": "img-src",
    "blocked-uri": "data:image/png;base64,AAAA",
    disposition: "report",
  },
};

let logged: string[];

beforeEach(() => {
  logged = [];
  // Both streams: ConsoleLogger routes warn/error to console.error, and an enforced
  // violation now logs at warn. Capturing only console.log would make every
  // assertion below read "nothing was logged" the moment the severity split works.
  const capture = (line: string) => {
    logged.push(line);
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/csp-report", () => {
  it("accepts a well-formed report with 204 and an empty body", async () => {
    const res = await POST(post(VALID));
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("");
  });

  it("logs one sanitized line per request, not one per report", async () => {
    const batch = Array.from({ length: 5 }, () => ({
      type: "csp-violation",
      body: { effectiveDirective: "script-src-elem", blockedURL: "inline", disposition: "report" },
    }));
    await POST(post(batch));
    expect(logged).toHaveLength(1);
    const entry = JSON.parse(logged[0]);
    expect(entry.msg).toBe("csp violation");
    expect(entry.module).toBe("csp-report");
    expect(entry.count).toBe(5);
    expect(entry.reports[0]).toEqual({
      directive: "script-src-elem",
      blocked: "inline",
      documentPath: "",
      disposition: "report",
    });
  });

  it("never writes a query string or a data: payload into the log", async () => {
    await POST(
      post({
        "csp-report": {
          "document-uri": `${ORIGIN}/workspaces/ws_1?token=sk_live_leak`,
          "effective-directive": "img-src",
          "blocked-uri": "data:image/png;base64,SECRETDOCUMENTBYTES",
          "script-sample": "inline sample with user content",
          "original-policy": "script-src 'nonce-SECRETNONCE'",
          disposition: "report",
        },
      }),
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]).not.toContain("sk_live_leak");
    expect(logged[0]).not.toContain("SECRETDOCUMENTBYTES");
    expect(logged[0]).not.toContain("SECRETNONCE");
    expect(logged[0]).not.toContain("user content");
    // Anti-vacuity: the line exists and is about the right violation.
    expect(logged[0]).toContain("img-src");
    expect(logged[0]).toContain("/workspaces/ws_1");
  });

  it("answers 204 and logs nothing for malformed input", async () => {
    for (const body of ["", "not json", "null", "[]", "{}", '{"csp-report":{}}']) {
      const res = await POST(post(body));
      expect(res.status, `for ${body}`).toBe(204);
    }
    expect(logged).toEqual([]);
  });

  it("rejects a body over the cap on declared length", async () => {
    const res = await POST(
      post(VALID, { headers: { "content-length": String(64 * 1024) } }),
    );
    expect(res.status).toBe(413);
    expect(logged).toEqual([]);
  });

  it("rejects a body over the cap even when content-length lies", async () => {
    // The real gate is the bytes read. A chunked POST can omit the header entirely,
    // so a check that trusts it is unenforced on exactly the requests that abuse it.
    const huge = JSON.stringify({
      "csp-report": { "effective-directive": "img-src", "blocked-uri": "x".repeat(40_000) },
    });
    const res = await POST(post(huge, { headers: { "content-length": "10" } }));
    expect(res.status).toBe(413);
    expect(logged).toEqual([]);
  });

  it("rate limits a single IP and keeps a different IP unaffected", async () => {
    const noisy = "203.0.113.9";
    const quiet = "203.0.113.10";
    let limited: Response | null = null;
    for (let i = 0; i < 200 && !limited; i++) {
      const res = await POST(post(VALID, { from: noisy }));
      if (res.status === 429) limited = res;
    }
    expect(limited, "limiter never fired").not.toBeNull();
    expect(limited!.headers.get("retry-after")).toBe("60");
    expect((await POST(post(VALID, { from: quiet }))).status).toBe(204);
  });

  it("caps the reports one request can log", async () => {
    const many = Array.from({ length: MAX_REPORTS_PER_REQUEST + 40 }, () => ({
      type: "csp-violation",
      body: { effectiveDirective: "img-src", disposition: "report" },
    }));
    await POST(post(many));
    expect(JSON.parse(logged[0]).count).toBe(MAX_REPORTS_PER_REQUEST);
  });
});

describe("severity says whether the browser blocked or merely observed", () => {
  const report = (disposition?: string) => ({
    "csp-report": {
      "document-uri": `${ORIGIN}/editor`,
      "effective-directive": "script-src-elem",
      "blocked-uri": "inline",
      ...(disposition ? { disposition } : {}),
    },
  });

  it("warns when the report says the policy enforced", async () => {
    // Under enforcement a violation is evidence of a break — something a real user
    // could not do — not a heads-up. Same line, different level, so an operator can
    // find the breaks without reading every observation.
    await POST(post(report("enforce")));
    expect(logged).toHaveLength(1);
    const entry = JSON.parse(logged[0]);
    expect(entry.level).toBe("warn");
    expect(entry.msg).toBe("csp violation blocked");
    expect(entry.reports[0].directive).toBe("script-src-elem");
  });

  it("stays at info when the report says the policy only observed", async () => {
    await POST(post(report("report")));
    const entry = JSON.parse(logged[0]);
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("csp violation");
  });

  it("lets the SHIPPED policy answer when the browser omitted the disposition", async () => {
    // Firefox's legacy body may carry no `disposition`, and a genuine block arriving
    // without it must not read as harmless. Every report we get is about one of our
    // own policies, so the header name we ship is the honest fallback. Stage-agnostic:
    // this holds before and after a rollback to report-only.
    await POST(post(report()));
    const entry = JSON.parse(logged[0]);
    expect(entry.level).toBe(CSP_HEADER === CSP_ENFORCED_HEADER ? "warn" : "info");
  });

  it("still answers 204 and stays one line per request at either level", async () => {
    // Anti-vacuity for the branch: the level changes, nothing else does.
    const res = await POST(post([
      { type: "csp-violation", body: { effectiveDirective: "img-src", disposition: "enforce" } },
      { type: "csp-violation", body: { effectiveDirective: "font-src", disposition: "enforce" } },
    ]));
    expect(res.status).toBe(204);
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]).count).toBe(2);
  });
});

describe("everything that is not a POST", () => {
  it("answers 405 with Allow: POST", async () => {
    for (const handler of [GET, PUT, PATCH, DELETE]) {
      const res = handler();
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
    expect(logged).toEqual([]);
  });
});

describe("the endpoint has no reach beyond a log line", () => {
  it("imports nothing that could touch a session, the database, or the ledger", async () => {
    // The guarantee is architectural, so it is asserted structurally: a diagnostics
    // sink that acquires one of these imports has acquired the side effects an
    // unauthenticated caller must not be able to trigger, and no behavioural test
    // would notice until it did.
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      new URL("./csp-report/route.ts", import.meta.url),
      "utf8",
    );
    const imports = [...source.matchAll(/^import[\s\S]*?from\s+"([^"]+)"/gm)].map(
      (m) => m[1],
    );
    expect(imports.sort()).toEqual([
      "@/lib/security/csp.mjs",
      "@/lib/security/cspReport",
      "@/lib/server/rateLimit",
      "@/src/infrastructure/logging/ConsoleLogger",
      "next/server",
    ]);
    // This list is also the "nothing pages" guarantee. Alerting anyone would mean an
    // http client, a queue, or a notifier appearing here — and this endpoint is
    // unauthenticated by necessity with attacker-triggerable input, so a pager
    // reachable from it is a pager anyone with curl can hold down. The severity split
    // above is the substitute: an operator can alert on `level=warn` from their own
    // log pipeline, where they own the threshold and the noise.
  });
});
