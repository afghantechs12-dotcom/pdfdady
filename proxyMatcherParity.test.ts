import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
// Next's own build-time matcher compiler and its runtime matcher, so these tests
// assert against the regex the server actually runs rather than a lookalike.
import { getMiddlewareRouteMatcher } from "next/dist/shared/lib/router/utils/middleware-route-matcher.js";
import { tryToParsePath } from "next/dist/lib/try-to-parse-path.js";
import loadCustomRoutes from "next/dist/lib/load-custom-routes.js";
import { defaultConfig } from "next/dist/server/config-shared.js";
import { parseUrl } from "next/dist/shared/lib/router/utils/parse-url.js";
import { config, proxy } from "./proxy";
import nextConfig from "./next.config.mjs";
import { ADMIN_COOKIE } from "@/lib/admin/session";
import {
  CSP_ENFORCED_HEADER,
  CSP_HEADER,
  CSP_REPORT_ONLY_HEADER,
  REPORTING_ENDPOINTS_HEADER,
} from "@/lib/security/csp.mjs";

/**
 * R9-R11 — the five upload paths were taken OUT of the global proxy matcher, and this
 * file is the proof that nothing else went out with them.
 *
 * `proxy.test.ts` already pins the exclusion set, but against
 * `new RegExp("^" + config.matcher[0] + "$")` — a hand-rolled stand-in. Next does not
 * run that regex. It wraps the source with an optional `/_next/data/<build>` prefix, an
 * optional `.json`/`.rsc`/`.segments/….segment.rsc` transport suffix and a trailing
 * `[/#?]?`, compiles it with path-to-regexp, and matches it against BOTH the raw
 * pathname and its percent-decoded form (`resolve-routes.js`, the `'middleware'` route).
 * Those wrappers are exactly where a spelling can slip back in, so R9 compiles the real
 * thing and R10 walks the boundaries the wrappers create.
 *
 * R11 is the parity half: an inventory of everything `proxy.ts` does, with a disposition
 * for each excluded path, and an assertion that the inventory cannot silently go stale.
 */

/** The five, canonically spelled. Ids are shaped like the cuids the app issues. */
const EXCLUDED = [
  "/api/jobs",
  "/api/tools/merge-pdf",
  "/api/workspaces/cku1abc/documents/upload",
  "/api/workspaces/cku1abc/documents/cku2def/versions/upload",
  "/api/workspaces/cku1abc/documents/cku2def/attachments",
] as const;

/** Same five, as the route files that serve them, with the boundary each one runs. */
const EXCLUDED_ROUTES = [
  { path: "/api/jobs", dir: "app/api/jobs", methods: ["POST"], gate: "RateLimiter" },
  { path: "/api/tools/merge-pdf", dir: "app/api/tools/[slug]", methods: ["POST"], gate: "RateLimiter" },
  {
    path: "/api/workspaces/cku1abc/documents/upload",
    dir: "app/api/workspaces/[workspaceId]/documents/upload",
    methods: ["POST"],
    gate: "workspaceUploadGate",
  },
  {
    path: "/api/workspaces/cku1abc/documents/cku2def/versions/upload",
    dir: "app/api/workspaces/[workspaceId]/documents/[documentId]/versions/upload",
    methods: ["POST"],
    gate: "workspaceUploadGate",
  },
  {
    path: "/api/workspaces/cku1abc/documents/cku2def/attachments",
    dir: "app/api/workspaces/[workspaceId]/documents/[documentId]/attachments",
    methods: ["GET", "POST"],
    gate: "workspaceUploadGate",
  },
] as const;

const PROXY_SRC = readFileSync("proxy.ts", "utf8");

/**
 * Loaded dynamically, and with `Error.prepareStackTrace` put back afterwards.
 *
 * `next/dist/build/analysis/get-page-static-info.js` drags in Next's build machinery,
 * which REPLACES `Error.prepareStackTrace` as a side effect of loading — and that hook is
 * where vitest's source-map remapper lives. As a static import it therefore cost this file
 * every accurate stack frame: a failure at line 225 was reported at 141, pointing at a
 * comment, because the position was the one in the transformed module. Found by mutating
 * the matcher and not recognising the frame the red test named. Only this file imports that
 * module, so only this file was affected; five sibling `next/dist/**` imports are harmless
 * and stay static above.
 *
 * The module is not replaceable — `getMiddlewareMatchers` is the actual build-time compiler
 * and using it is the whole point of R9 — so the hook is saved before and restored after.
 */
const prepareStackTrace = Error.prepareStackTrace;
const pageStaticInfo = await import("next/dist/build/analysis/get-page-static-info.js");
Error.prepareStackTrace = prepareStackTrace;

/**
 * Exported at runtime, absent from the shipped `.d.ts` — so the cast is the type, and
 * the import above is what keeps it honest: if the export disappears in a Next upgrade,
 * `MATCHERS` is undefined and every test in this file fails rather than one type error
 * being silenced.
 */
const { getMiddlewareMatchers } = pageStaticInfo as unknown as {
  getMiddlewareMatchers: (
    matcher: string[],
    nextConfig: unknown,
  ) => { regexp: string; originalSource: string }[];
};

/** The compiled matcher, straight out of Next's build pipeline. */
const MATCHERS = getMiddlewareMatchers(config.matcher as string[], defaultConfig);
const COMPILED = MATCHERS[0].regexp;
const matchOne = getMiddlewareRouteMatcher(MATCHERS);
const matches = (pathname: string) =>
  matchOne(pathname, {} as never, {} as never);

/**
 * What the server decides, not what one regex says: `resolve-routes.js` runs the
 * matcher over the raw pathname OR its decoded form and invokes middleware if either
 * hits. A test that checked only the raw form would call an encoded path excluded.
 */
function runtimeMatches(pathname: string): boolean {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    /* undecodable stays raw, exactly as the server treats it */
  }
  return matches(pathname) || matches(decoded);
}

/** Every `app/api/**\/route.ts`, as the URL it serves. */
function apiRoutePaths(): { dir: string; pathname: string }[] {
  const out: { dir: string; pathname: string }[] = [];
  for (const entry of readdirSync("app/api", { recursive: true, withFileTypes: true })) {
    if (entry.name !== "route.ts") continue;
    const dir = `${entry.parentPath}`.replaceAll("\\", "/");
    // One concrete value per dynamic segment: a catch-all gets two, so a route that
    // only exists at depth is still probed at depth.
    const pathname = `/${dir.slice("app/".length)}`
      .replace(/\[\.\.\.[^\]]+\]/g, "seg1/seg2")
      .replace(/\[([^\]]+)\]/g, (_m, name: string) =>
        name === "slug" ? "merge-pdf" : `ck_${name.toLowerCase()}`,
      );
    out.push({ dir, pathname });
  }
  return out;
}

describe("R9 — the matcher Next actually compiles", () => {
  it("is not the source string, so a test that assumes it would be is testing a lookalike", () => {
    // The three wrappers, each a way back into the matcher: a `_next/data/<build>`
    // prefix, a transport suffix, and a tolerated trailing `/`, `#` or `?`. R10 walks
    // what they admit. If Next stops adding them this test fails first, which is the
    // point — it is the anti-vacuity check for the rest of the file.
    expect(COMPILED).not.toBe(`^${config.matcher[0]}$`);
    expect(COMPILED).toContain("_next\\/data\\/[^/]{1,}");
    expect(COMPILED).toContain("(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?");
    expect(COMPILED.endsWith("[\\/#\\?]?$")).toBe(true);
    // And it really is our source in the middle, not a default.
    expect(COMPILED).toContain("workspaces\\/[^/]+\\/documents\\/");
    expect(MATCHERS).toHaveLength(1);
    // No `has`/`missing` conditions: this matcher is path-only. R10 pins what that
    // means for HTTP methods.
    expect(MATCHERS[0]).not.toHaveProperty("has");
    expect(MATCHERS[0]).not.toHaveProperty("missing");
  });

  it("excludes the five canonical upload paths", () => {
    for (const path of EXCLUDED) {
      expect(runtimeMatches(path), `${path} should be excluded`).toBe(false);
    }
  });

  it("matches every other API route on disk — including ones added after this test", () => {
    // The differential check. Derived from the filesystem, so a new API route under a
    // path the exclusion accidentally covers fails here instead of shipping without a
    // policy. 130+ routes today.
    const excludedDirs = new Set<string>(EXCLUDED_ROUTES.map((r) => r.dir));
    const routes = apiRoutePaths();
    expect(routes.length).toBeGreaterThan(100);
    expect([...excludedDirs].every((d) => routes.some((r) => r.dir === d))).toBe(true);
    const wrong = routes.filter(
      (r) => runtimeMatches(r.pathname) === excludedDirs.has(r.dir),
    );
    expect(wrong.map((r) => r.pathname)).toEqual([]);
  });

  it("agrees with the approximation proxy.test.ts uses, so the two cannot drift apart", () => {
    const naive = new RegExp(`^${config.matcher[0]}$`);
    const probes = [
      ...EXCLUDED,
      ...apiRoutePaths().map((r) => r.pathname),
      "/",
      "/pricing",
      "/tools/merge-pdf",
      "/admin",
      "/admin/tools",
      "/workspaces/cku1abc/documents/cku2def",
      "/_next/static/chunks/main-abc123.js",
      "/_next/image",
      "/favicon.ico",
      "/robots.txt",
      "/api/jobs/",
      "/api/JOBS",
      "/api/jobs.rsc",
      "/api/jobs.json",
      "/_next/data/abc/api/jobs",
    ];
    const disagreements = probes.filter((p) => naive.test(p) !== matches(p));
    expect(disagreements).toEqual([]);
  });

  it("is applied to the raw pathname OR its decoded form, which is why R10 tests both", () => {
    // The disposition for a percent-encoded upload path depends entirely on this being
    // an OR rather than a replacement, so it is pinned against Next's own source.
    const src = readFileSync(
      "node_modules/next/dist/server/lib/router-utils/resolve-routes.js",
      "utf8",
    );
    const block = src.slice(src.indexOf("route.name === 'middleware'"));
    expect(block).toContain("decodeURIComponent");
    expect(block.slice(0, 900)).toMatch(
      /match\(parsedUrl\.pathname,[\s\S]{0,120}\|\|[\s\S]{0,80}match\(maybeDecodedPathname/,
    );
  });
});

/**
 * R10 — the boundaries, with the disposition each one gets.
 *
 * Three spellings of an excluded path are matched again: a trailing slash, a
 * percent-encoded segment, and a different case on a literal segment. That is stated
 * here rather than hidden, and each gets its own disposition below. Two of them —
 * encoding and case — are REACHABLE, and what they cost is the pre-parse refusal, not a
 * security property: authentication, CSRF, the rate limit and the size ceiling all run
 * inside the handler (R11), and the response headers come from `next.config.mjs`
 * independently of this matcher. A caller who spells the path unusually gets the body
 * buffered up to `proxyClientMaxBodySize` and then refused exactly as before the
 * exclusion existed — the behaviour every one of these paths had at f6f0fa8's parent.
 * So the exclusion is an improvement on the canonical spelling and a no-op on the rest;
 * it opens nothing.
 */
describe("R10 — boundary spellings of the five excluded paths", () => {
  it("trailing slash: matched, but redirected before middleware ever runs", async () => {
    for (const path of EXCLUDED) {
      expect(runtimeMatches(`${path}/`), `${path}/ is matched`).toBe(true);
    }
    // Which would re-buffer the body — except Next prepends an internal 308 for the
    // trailing-slash form, and `resolve-routes.js` runs redirects BEFORE middleware.
    const routes = await loadCustomRoutes({
      ...defaultConfig,
      ...nextConfig,
    } as Parameters<typeof loadCustomRoutes>[0]);
    const slash = routes.redirects.find((r) => r.source === "/:path+/");
    expect(slash).toMatchObject({
      destination: "/:path+",
      permanent: true,
      internal: true,
      priority: true,
    });
    const slashRe = new RegExp(tryToParsePath(slash!.source).regexStr!);
    for (const path of EXCLUDED) {
      expect(slashRe.test(`${path}/`), `${path}/ is redirected`).toBe(true);
      expect(slashRe.test(path), `${path} is not redirected`).toBe(false);
    }
    // The ordering that makes the redirect win. Both are in one array literal in
    // `calculateRoutes`, so their order in the source IS their order at runtime.
    const src = readFileSync(
      "node_modules/next/dist/server/lib/router-utils/resolve-routes.js",
      "utf8",
    );
    const order = src.slice(src.indexOf("const calculateRoutes = ()"));
    expect(order.indexOf("fsChecker.redirects")).toBeGreaterThan(0);
    expect(order.indexOf("fsChecker.redirects")).toBeLessThan(
      order.indexOf("name: 'middleware'"),
    );
    // Neither of the two config keys that would disable that redirect is set.
    expect(nextConfig).not.toHaveProperty("trailingSlash");
    expect(nextConfig).not.toHaveProperty("skipTrailingSlashRedirect");
  });

  it("query string: never reaches the matcher, so ?slug= cannot re-enter it", () => {
    // Load-bearing, not theoretical: the real call is POST /api/jobs?slug=merge-pdf.
    for (const path of EXCLUDED) {
      const { pathname } = parseUrl(`${path}?slug=merge-pdf&x=1`);
      expect(pathname).toBe(path);
      expect(runtimeMatches(pathname), `${path} with a query stays excluded`).toBe(false);
    }
  });

  it("percent-encoding: matched raw, excluded decoded — so the OR admits it", () => {
    const encoded = [
      ["/api/%6Aobs", "/api/jobs"],
      ["/api/workspaces/cku1abc/documents/%75pload", "/api/workspaces/cku1abc/documents/upload"],
      ["/api/workspaces/cku1abc%2Fdocuments/upload", "/api/workspaces/cku1abc/documents/upload"],
    ] as const;
    for (const [raw, decoded] of encoded) {
      expect(decodeURIComponent(raw)).toBe(decoded);
      expect(matches(decoded), `${decoded} excluded`).toBe(false);
      expect(matches(raw), `${raw} matched raw`).toBe(true);
      // `match(raw) || match(decoded)` — one hit is enough, so middleware runs.
      expect(runtimeMatches(raw)).toBe(true);
    }
  });

  it("nested ids: an id segment cannot swallow a slash, so depth is not confusable", () => {
    for (const [path, matched] of [
      ["/api/workspaces/cku1abc/documents/cku2def/versions/upload", false],
      ["/api/workspaces/cku1abc/documents/cku2def/attachments", false],
      // An extra segment is not an id: these are matched, and must be.
      ["/api/workspaces/cku1abc/extra/documents/upload", true],
      ["/api/workspaces/cku1abc/documents/cku2def/versions/3/upload", true],
      ["/api/workspaces/cku1abc/documents/cku2def/versions/upload/extra", true],
      ["/api/workspaces/cku1abc/documents/cku2def/attachments/att1", true],
      ["/api/workspaces/cku1abc/documents/cku2def/attachments/att1/download", true],
      ["/api/workspaces/cku1abc/documents/upload/cku2def", true],
    ] as const) {
      expect(runtimeMatches(path), `${path} matched=${matched}`).toBe(matched);
    }
  });

  it("similar prefixes: only the exact five are out", () => {
    for (const path of [
      "/api/jobsy",
      "/api/jobs-archive",
      "/api/jobs/cku3ghi",
      "/api/jobs/cku3ghi/download",
      "/api/tools",
      "/api/tools/merge-pdf/anything",
      "/api/workspaces/cku1abc/documents",
      "/api/workspaces/cku1abc/documents/uploads",
      "/api/workspaces/cku1abc/documents/upload-batch",
      "/api/workspaces/cku1abc/documents/cku2def/attachmentsx",
      "/api/workspaces/cku1abc/documents/cku2def/versions",
      "/administrator-notes",
    ]) {
      expect(runtimeMatches(path), `${path} should stay matched`).toBe(true);
    }
  });
});

/** What `proxy()` did to a request, with the per-request nonce redacted. */
async function shapeOf(path: string, method: string) {
  const res = await proxy(new NextRequest(`https://pdfdadi.test${path}`, { method }));
  const overridden = (res.headers.get("x-middleware-override-headers") ?? "")
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  return {
    status: res.status,
    location: res.headers.get("location"),
    overridden,
    responseCsp: (res.headers.get(CSP_HEADER) ?? "").replace(/'nonce-[^']+'/, "'nonce-X'"),
    reporting: res.headers.get(REPORTING_ENDPOINTS_HEADER),
  };
}

describe("R10 — the two dimensions the matcher does not have", () => {
  it("method: exclusion is path-only, and the proxy has nothing method-shaped to lose", async () => {
    // `attachments` is the one excluded path with two verbs (GET lists, POST uploads),
    // so "the matcher cannot distinguish them" has to be safe rather than lucky.
    for (const route of EXCLUDED_ROUTES) {
      const exported = readFileSync(`${route.dir}/route.ts`, "utf8")
        .split("\n")
        .flatMap((l) => l.match(/^export (?:async )?function ([A-Z]+)/)?.slice(1, 2) ?? []);
      expect(exported.sort()).toEqual([...route.methods].sort());
    }
    const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
    for (const path of [...EXCLUDED, "/api/health", "/pricing"]) {
      const shapes = await Promise.all(methods.map((m) => shapeOf(path, m)));
      for (const s of shapes) expect(s).toEqual(shapes[0]);
    }
  });

  it("case: a literal segment is case-sensitive here and case-INSENSITIVE in routing", () => {
    // The regex is compiled without `i`, so only the segments written as `[^/]+` are
    // case-agnostic — the slug is, the words `jobs`, `upload` and `attachments` are not.
    expect(runtimeMatches("/api/tools/MERGE-PDF")).toBe(false);
    for (const path of [
      "/api/JOBS",
      "/api/Jobs",
      "/api/workspaces/cku1abc/documents/UPLOAD",
      "/api/workspaces/cku1abc/documents/cku2def/versions/Upload",
      "/api/workspaces/cku1abc/documents/cku2def/ATTACHMENTS",
    ]) {
      expect(runtimeMatches(path), `${path} is matched`).toBe(true);
    }
    // And those spellings still reach the handler, because Next's route matching is
    // case-insensitive unless told otherwise — which is why this is a re-entrant
    // spelling rather than a 404. Same disposition as percent-encoding: buffered, then
    // refused by the handler's own gate.
    expect(defaultConfig.experimental.caseSensitiveRoutes).toBe(false);
    expect(nextConfig.experimental).not.toHaveProperty("caseSensitiveRoutes");
  });
});

/**
 * `proxy.ts` with comments removed, so the inventory below parses code only.
 *
 * Line comments go FIRST. One of them protects "/admin" with a wildcard, so it contains
 * a slash-star; paired with the next doc comment's terminator that swallowed the admin
 * gate and the entire header block — which is how the first draft of this file compared
 * its inventory against nothing at all and reported no responsibilities. The anchors
 * below are asserted before anything is counted, so a strip that eats code fails as a
 * broken strip rather than as a responsibility that has apparently gone away.
 */
const PROXY_CODE = PROXY_SRC.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const PROXY_CODE_ANCHORS = [
  "export async function proxy(",
  "verifySessionToken(token)",
  "new Headers(req.headers)",
  "return withPolicy(",
  "export const config",
];

/** Every name `proxy.ts` can pass to a header or cookie call, resolved to its value. */
const NAMES: Record<string, string> = {
  CSP_HEADER,
  CSP_ENFORCED_HEADER,
  CSP_REPORT_ONLY_HEADER,
  REPORTING_ENDPOINTS_HEADER,
  ADMIN_COOKIE,
};
const resolved = (re: RegExp) =>
  [...PROXY_CODE.matchAll(re)].map((m) => NAMES[m[1]] ?? `UNRESOLVED:${m[1]}`).sort();

describe("R11 — every proxy responsibility, disposed of for the excluded five", () => {
  it("has exactly these responsibilities — so a new one cannot skip this file", () => {
    for (const anchor of PROXY_CODE_ANCHORS) expect(PROXY_CODE).toContain(anchor);
    // The anti-drift check. Add anything to proxy.ts that touches a header, a cookie or
    // the response shape and this fails until the disposition below is extended. Without
    // it, the parity claim silently ages out on the next edit.
    expect(resolved(/requestHeaders\.delete\((\w+)\)/g)).toEqual(
      [CSP_ENFORCED_HEADER, CSP_REPORT_ONLY_HEADER].sort(),
    );
    expect(resolved(/requestHeaders\.set\((\w+),/g)).toEqual([CSP_HEADER]);
    expect(resolved(/res\.headers\.set\((\w+),/g)).toEqual(
      [CSP_HEADER, REPORTING_ENDPOINTS_HEADER].sort(),
    );
    expect(resolved(/req\.cookies\.get\((\w+)\)/g)).toEqual([ADMIN_COOKIE]);
    // Exhaustiveness — every mutating call in the file, listed with its receiver. Written
    // this way because a `.headers.(set|delete)` pattern silently undercounts to 2: three
    // of the five writes are on `requestHeaders`, a plain `Headers` object with no
    // `.headers` of its own. A miscount here would have read as "fewer responsibilities
    // than we thought", which is the wrong direction for a parity claim to fail in.
    expect(
      [...PROXY_CODE.matchAll(/([\w.]*)\.(set|delete|append)\(/g)]
        .map((m) => `${m[1]}.${m[2]}`)
        .sort(),
    ).toEqual([
      "loginUrl.searchParams.set", // the ?next= hint on the admin redirect, not a header
      "requestHeaders.delete",
      "requestHeaders.delete",
      "requestHeaders.set",
      "res.headers.set",
      "res.headers.set",
    ]);
    expect(PROXY_CODE.match(/\.cookies\.\w+\(/g)).toHaveLength(1);
    expect([...new Set([...PROXY_CODE.matchAll(/NextResponse\.(\w+)\(/g)].map((m) => m[1]))].sort())
      .toEqual(["next", "redirect"]);
    // And nothing that would make the exclusion a policy hole: no CSRF check, no origin
    // check, no tracing header, no rate limiting, no fetch. Each is somebody else's job
    // (the last test in this file names whose), so none of them is lost by exclusion.
    for (const forbidden of [/csrf/i, /\borigin\b/i, /x-request-id/i, /rateLimit/i, /fetch\(/]) {
      expect(PROXY_CODE, `${forbidden} is not a proxy responsibility`).not.toMatch(forbidden);
    }
  });

  it("the admin gate never covered them: unauthenticated, they are not redirected", async () => {
    for (const path of EXCLUDED) {
      expect(path.startsWith("/admin")).toBe(false);
      const shape = await shapeOf(path, "POST");
      expect(shape.status, `${path} is not gated`).toBe(200);
      expect(shape.location).toBeNull();
    }
    // Anti-vacuity: the gate is live in this same process, so "no redirect" above is a
    // statement about those paths and not about a gate that stopped working.
    const gated = await shapeOf("/admin/tools", "GET");
    expect(gated.status).toBe(307);
    expect(gated.location).toContain("/admin/login");
  });

  it("no nonce is lost: all five are route handlers, and a handler renders no script", () => {
    for (const route of EXCLUDED_ROUTES) {
      const entries = readdirSync(route.dir);
      expect(entries, `${route.dir} serves a handler`).toContain("route.ts");
      // A `page.tsx` at the same path would be a document — something that DOES consume
      // a nonce — and Next forbids the collision, but the check is cheap and the claim
      // "nothing here renders HTML" is the whole reason the exclusion costs no policy.
      expect(entries.filter((e) => e.startsWith("page."))).toEqual([]);
    }
  });
});

/**
 * The rest of R11: the four global policies the brief names — CSRF, authentication,
 * security headers, request tracing — located for each excluded path. `proxy.ts` performs
 * exactly one of them (none: the inventory above shows the file has no CSRF check, no
 * origin check, no tracing header and no rate limit), so the only thing an excluded path
 * can lose is a response header and a request-header strip. Both are settled below.
 */
/**
 * Non-test source under `app/`, `lib/` and `src/` that reads a named request header.
 * `grep` exits 1 for "no matches" and 2 for a real failure, and the distinction is the
 * point: an empty result has to mean nothing matched, never that the search broke.
 */
function filesReading(header: string): string[] {
  let out = "";
  try {
    out = execFileSync(
      "grep",
      ["-rilE", `headers\\.get\\(["'\`]${header}`, "app", "lib", "src", "proxy.ts"],
      { encoding: "utf8" },
    );
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 1) throw error;
  }
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => !f.includes(".test."))
    .sort();
}

describe("R11 — the policies that do not come from the matcher", () => {
  it("the six security headers come from next.config.mjs, which covers all five", async () => {
    const routes = await loadCustomRoutes({
      ...defaultConfig,
      ...nextConfig,
    } as Parameters<typeof loadCustomRoutes>[0]);
    // One rule, and its source is a catch-all — so exclusion from the matcher cannot
    // exclude a path from this. `next build` bakes it in; the matcher is not consulted.
    expect(routes.headers).toHaveLength(1);
    expect(routes.headers[0].source).toBe("/:path*");
    const headerRe = new RegExp(tryToParsePath(routes.headers[0].source).regexStr!);
    for (const path of EXCLUDED) {
      expect(headerRe.test(path), `${path} is covered by /:path*`).toBe(true);
    }
    expect(routes.headers[0].headers.map((h) => h.key)).toEqual([
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Referrer-Policy",
      "Permissions-Policy",
      "Cross-Origin-Opener-Policy",
      CSP_HEADER,
    ]);
    // And it runs BEFORE middleware, so this is the floor for every path — matched or
    // not — rather than something the proxy adds on top of nothing.
    const order = readFileSync(
      "node_modules/next/dist/server/lib/router-utils/resolve-routes.js",
      "utf8",
    );
    const calc = order.slice(order.indexOf("const calculateRoutes = ()"));
    expect(calc.indexOf("fsChecker.headers")).toBeGreaterThan(0);
    expect(calc.indexOf("fsChecker.headers")).toBeLessThan(calc.indexOf("name: 'middleware'"));
    // What the excluded five get is this CSP without a per-request nonce. That is the
    // whole delta, and it costs nothing here: a nonce exists to authorize inline script
    // in a rendered document, and all five are route handlers (asserted above).
    const staticCsp = routes.headers[0].headers.find((h) => h.key === CSP_HEADER)!.value;
    expect(staticCsp).not.toContain("'nonce-");
    expect(staticCsp).toContain("default-src 'self'");
    expect(staticCsp).toContain("object-src 'none'");
    // HSTS is the one header not in the list above, because this process is not
    // production. Pinned as source text rather than by re-importing the config under a
    // forged NODE_ENV, which would only re-assert the branch this line already names.
    const cfgSrc = readFileSync("next.config.mjs", "utf8");
    expect(cfgSrc).toMatch(/NODE_ENV === "production"[\s\S]{0,400}Strict-Transport-Security/);
  });

  it("the unstripped inbound CSP request headers are read by nothing", () => {
    // proxy.ts deletes two request headers before handing the request on, so a client
    // cannot forge Next's internal nonce channel. Excluded paths skip that delete — so
    // the question is who would read them. Answer: no application code does.
    const readers = filesReading("content-security-policy");
    expect(readers).toEqual([]);
    // The control that makes the empty list mean something. Same helper, same roots, a
    // header this tree definitely reads: without it, a typo'd pattern or a wrong cwd
    // would report "nobody reads it" about every header in existence.
    expect(filesReading("x-request-id")).toContain(
      "src/application/services/workspaceHttp.ts",
    );
    // Next's own reader is the renderer, and it consumes the nonce for inline script in
    // a document. All five excluded paths are route handlers with no page.* sibling, so
    // there is no document, no inline script and nothing for a forged value to reach.
    // The two names the strip removes, so the search above is over the right strings.
    // Compared lowercased because that is how a header name is compared on the wire, and
    // how `grep -i` above matched them.
    expect(CSP_ENFORCED_HEADER.toLowerCase()).toBe("content-security-policy");
    expect(CSP_REPORT_ONLY_HEADER.toLowerCase()).toBe("content-security-policy-report-only");
  });

  it("CSRF, authentication, rate limiting and tracing each live in the handler", () => {
    for (const route of EXCLUDED_ROUTES) {
      const src = readFileSync(`${route.dir}/route.ts`, "utf8");
      expect(src, `${route.path} runs ${route.gate}`).toContain(route.gate);
    }
    // The three Workspace uploads share one boundary, and it owns all three policies —
    // origin/CSRF, session, limiter — before the body is read. That order is what the
    // upload-abuse closeout accepted; this test only pins WHERE it lives, so that a
    // matcher change cannot be mistaken for having moved it.
    const gate = readFileSync("lib/server/workspaceUploadGate.ts", "utf8");
    expect(gate).toContain("requireSameOrigin(request)");
    expect(gate).toContain("getSessionUser");
    expect(gate).toContain("checkUploadLimit");
    // The two public tool routes are rate limited in-process by client address. Neither
    // ever had a proxy-level limit to lose: the inventory above shows proxy.ts has none.
    for (const dir of ["app/api/jobs", "app/api/tools/[slug]"]) {
      const src = readFileSync(`${dir}/route.ts`, "utf8");
      expect(src, `${dir} rate limits itself`).toMatch(/new RateLimiter\(/);
      expect(src, `${dir} keys the limit`).toMatch(/\.hit\(clientIp\(request\)\)/);
    }
    // Tracing is a READ of an inbound header, done per handler — never a proxy write.
    // So an excluded path carries the same request id it would have carried anyway.
    expect(readFileSync("src/application/services/workspaceHttp.ts", "utf8")).toContain(
      'request.headers.get("x-request-id")',
    );
  });
});
