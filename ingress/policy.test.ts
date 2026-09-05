import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CLASS_A_MAX_BYTES,
  CLASS_B_MAX_BYTES,
  STREAMING_ROUTE_PATTERNS,
  classifyPath,
  ingressDecision,
  maxBytesForClass,
  pathnameOf,
} from "./policy.mjs";

/**
 * The ingress policy, decided from the request line alone.
 *
 * These are the parts of E2–E12 that do not need a running server: which class a
 * path is in, what the decision is for a given set of headers, and — the row that
 * matters most for keeping this correct over time — that the class C exclusions
 * here are the same five paths `proxy.ts` excludes from its matcher.
 */

const len = (n: number) => ({ "content-length": String(n) });
const CHUNKED = { "transfer-encoding": "chunked" };

/** A concrete example of each of the five streaming paths. */
const STREAMING_EXAMPLES = [
  "/api/jobs",
  "/api/tools/compress-pdf",
  "/api/workspaces/ws_1/documents/upload",
  "/api/workspaces/ws_1/documents/doc_1/versions/upload",
  "/api/workspaces/ws_1/documents/doc_1/attachments",
];

/**
 * `proxy.ts`'s matcher as a usable regex.
 *
 * Next converts the matcher string into a path regex; this one is already written
 * as one, so it can be applied directly. Read from the source rather than copied,
 * because a copy is what drift looks like.
 */
function matcherRegex(): RegExp {
  const source = readFileSync(path.join(process.cwd(), "proxy.ts"), "utf8");
  const line = source.match(/matcher:\s*\[\s*"((?:[^"\\]|\\.)*)"/);
  if (!line) throw new Error("could not find the matcher literal in proxy.ts");
  return new RegExp(`^${JSON.parse(`"${line[1]}"`)}$`);
}

describe("class boundaries", () => {
  it("puts pages, static assets and unrouted paths in class A", () => {
    for (const p of ["/", "/tools", "/admin", "/does-not-exist", "/_next/static/chunk.js"]) {
      expect(classifyPath(p), p).toBe("A");
    }
  });

  it("puts every other /api path in class B", () => {
    for (const p of ["/api", "/api/csp-report", "/api/analytics/events", "/api/workspaces/ws_1"]) {
      expect(classifyPath(p), p).toBe("B");
    }
  });

  it("puts exactly the five streaming paths in class C", () => {
    for (const p of STREAMING_EXAMPLES) expect(classifyPath(p), p).toBe("C");
    // Near-misses: a longer path under the same prefix is NOT class C.
    for (const p of [
      "/api/jobs/j_1",
      "/api/tools/compress-pdf/extra",
      "/api/workspaces/ws_1/documents/upload/extra",
      "/api/workspaces/ws_1/documents/doc_1/attachments/att_1",
    ]) {
      expect(classifyPath(p), p).toBe("B");
    }
  });

  it("agrees with proxy.ts about which paths the matcher excludes", () => {
    const matcher = matcherRegex();
    // The five are excluded there — which is why Next never clones them — and
    // class C here. If an exclusion is added, removed or re-anchored in one file
    // and not the other, a streaming upload silently starts answering 413 at
    // 2 MiB, or a cloned path stops being bounded.
    for (const p of STREAMING_EXAMPLES) {
      expect(matcher.test(p), `${p} should be excluded from the matcher`).toBe(false);
      expect(classifyPath(p), p).toBe("C");
    }
    // And a class B API path is matched there and bounded here.
    for (const p of ["/api/csp-report", "/api/workspaces/ws_1/documents"]) {
      expect(matcher.test(p), `${p} should be matched by the matcher`).toBe(true);
      expect(classifyPath(p), p).toBe("B");
    }
  });

  it("has the same number of exclusions as proxy.ts has anchored api carve-outs", () => {
    expect(STREAMING_ROUTE_PATTERNS).toHaveLength(5);
  });

  it("does not depend on the matcher: a dotted path is still bounded", () => {
    // `.*\.[^/]*$` excludes anything with a dot in the last segment from the
    // matcher, so Next does not clone `/api/anything.json` — but the guard is not
    // downstream of the matcher, and the ceiling still applies.
    expect(matcherRegex().test("/api/anything.json")).toBe(false);
    expect(classifyPath("/api/anything.json")).toBe("B");
    expect(
      ingressDecision({ url: "/api/anything.json", headers: len(CLASS_B_MAX_BYTES + 1) })?.status,
    ).toBe(413);
  });
});

describe("the decision", () => {
  it("passes a request with no body", () => {
    expect(ingressDecision({ url: "/", headers: {} })).toBeNull();
    expect(ingressDecision({ url: "/", headers: len(0) })).toBeNull();
  });

  it("refuses any body on a class A path", () => {
    expect(CLASS_A_MAX_BYTES).toBe(0);
    for (const p of ["/", "/does-not-exist", "/admin/nope"]) {
      expect(ingressDecision({ url: p, headers: len(1) })?.status, p).toBe(413);
    }
  });

  it("accepts a class B body at the ceiling and refuses one byte more", () => {
    expect(ingressDecision({ url: "/api/csp-report", headers: len(CLASS_B_MAX_BYTES) })).toBeNull();
    expect(
      ingressDecision({ url: "/api/csp-report", headers: len(CLASS_B_MAX_BYTES - 1) }),
    ).toBeNull();
    expect(
      ingressDecision({ url: "/api/csp-report", headers: len(CLASS_B_MAX_BYTES + 1) })?.status,
    ).toBe(413);
  });

  it("passes class C bodies of any declared size, ceiling and all", () => {
    for (const p of STREAMING_EXAMPLES) {
      expect(ingressDecision({ url: p, headers: len(200 * 1024 * 1024) }), p).toBeNull();
      expect(ingressDecision({ url: p, headers: CHUNKED }), p).toBeNull();
    }
    expect(maxBytesForClass("C")).toBeNull();
  });

  it("refuses a chunked body on class A and B with 411, unread", () => {
    expect(ingressDecision({ url: "/", headers: CHUNKED })?.status).toBe(411);
    expect(ingressDecision({ url: "/api/csp-report", headers: CHUNKED })?.status).toBe(411);
  });

  it("refuses a malformed Content-Length with 400", () => {
    for (const bad of ["abc", "-1", "1.5", "1e6", " "]) {
      expect(
        ingressDecision({ url: "/api/csp-report", headers: { "content-length": bad } })?.status,
        bad,
      ).toBe(400);
    }
  });

  it("is method-agnostic: a GET with a body is still bounded", () => {
    // Node parses a body on any method, so a policy keyed on the method would
    // leave `GET /` with a 100 MiB body on the retained path.
    expect(ingressDecision({ url: "/", headers: len(100 * 1024 * 1024) })?.status).toBe(413);
  });

  it("ignores every other header, including the ones a client might forge", () => {
    const hostile = {
      ...len(CLASS_B_MAX_BYTES + 1),
      "x-pdfdadi-proxy-secret": "not-the-secret",
      "x-forwarded-for": "10.0.0.1",
      "x-real-ip": "10.0.0.1",
      "content-security-policy": "script-src 'nonce-attacker'",
      "x-middleware-subrequest": "1",
      expect: "100-continue",
    };
    expect(ingressDecision({ url: "/api/csp-report", headers: hostile })?.status).toBe(413);
    expect(ingressDecision({ url: "/", headers: hostile })?.status).toBe(413);
  });

  it("answers identically for a page, a real route and a path with no route", () => {
    // E11: the refusal must not tell a body-bearing probe which paths exist.
    const shapes = ["/", "/api/csp-report", "/does-not-exist", "/admin/secret-thing"].map((p) => {
      const d = ingressDecision({ url: p, headers: len(300 * 1024 * 1024) });
      return { status: d?.status, message: d?.message, code: d?.code };
    });
    for (const shape of shapes) expect(shape).toEqual(shapes[0]);
    expect(shapes[0].status).toBe(413);
  });

  it("strips the query string and treats absolute-form URLs as class A", () => {
    expect(pathnameOf("/api/csp-report?x=1")).toBe("/api/csp-report");
    expect(classifyPath(pathnameOf("http://host/api/jobs"))).toBe("A");
    expect(ingressDecision({ url: "http://host/api/jobs", headers: len(1) })?.status).toBe(413);
  });
});
