import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { config, proxy } from "./proxy";
import { ADMIN_COOKIE, createSessionToken } from "@/lib/admin/session";
import {
  CSP_ENFORCED_HEADER,
  CSP_HEADER,
  CSP_REPORT_ONLY_HEADER,
  CSP_REPORT_GROUP,
  CSP_REPORT_PATH,
  NEXT_CSP_NONCE_SOURCE_REGEX,
  REPORTING_ENDPOINTS_HEADER,
} from "@/lib/security/csp.mjs";
import { parseCspReports } from "@/lib/security/cspReport";

/**
 * The nonce WIRING, not the policy.
 *
 * `lib/security/csp.test.ts` proves `buildCsp` emits the right string; that test would
 * stay green if `proxy.ts` never called it, called it once at module scope, or set the
 * policy on the response and forgot the request. This repo has shipped exactly that
 * failure before — 26 green policy tests over a consumer that called itself in an
 * infinite loop — so these tests call the real exported `proxy()` and read what it
 * actually put on the wire.
 *
 * `NextResponse.next({ request: { headers } })` cannot mutate the incoming request in
 * place; it encodes the override as response headers that the Next server unpacks
 * (`x-middleware-override-headers` lists the names, `x-middleware-request-<name>`
 * carries each value). {@link requestCsp} reads it back through that list rather than
 * a hardcoded name, so the assertion follows the mechanism rather than a spelling.
 */

const env = process.env as unknown as Record<string, string | undefined>;
const ORIG_SECRET = env.ADMIN_SECRET;

/** The CSP the browser gets. */
function responseCsp(res: Response): string | null {
  return res.headers.get(CSP_HEADER);
}

/** The CSP Next's renderer gets — decoded the way the Next server decodes it. */
function requestCsp(res: Response): string | undefined {
  const overridden = (res.headers.get("x-middleware-override-headers") ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const name = overridden.find((n) => n === CSP_HEADER.toLowerCase());
  if (!name) return undefined;
  return res.headers.get(`x-middleware-request-${name}`) ?? undefined;
}

/** The nonce inside a policy, extracted with Next's own regex, not a looser one. */
function nonceOf(policy: string | null | undefined): string | undefined {
  if (!policy) return undefined;
  const scriptSrc = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("script-src "));
  if (!scriptSrc) return undefined;
  for (const source of scriptSrc.split(/\s+/).slice(1)) {
    const match = source.match(NEXT_CSP_NONCE_SOURCE_REGEX);
    if (match) return match[1];
  }
  return undefined;
}

/** NextRequest's init is stricter than the DOM `RequestInit` (no `signal: null`). */
type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

function request(path: string, init: NextRequestInit = {}): NextRequest {
  return new NextRequest(`https://pdfdadi.test${path}`, init);
}

async function run(path: string, init: NextRequestInit = {}) {
  const res = await proxy(request(path, init));
  return { res, response: responseCsp(res), request: requestCsp(res) };
}

/** Next compiles the matcher to a regex; this is the same negative lookahead. */
const MATCHER = new RegExp(`^${config.matcher[0]}$`);

describe("proxy — a fresh nonce on every request", () => {
  it("mints one, and Next's own parser can read it back", async () => {
    const { response } = await run("/");
    const nonce = nonceOf(response);
    expect(nonce, `no nonce in ${response}`).toBeTruthy();
    // Not a hand-copied charset: the literal regex Next matches each script-src
    // source against. A nonce it rejects yields a page of unnonced scripts, which
    // under enforcement is a blank screen.
    expect(`'nonce-${nonce}'`).toMatch(NEXT_CSP_NONCE_SOURCE_REGEX);
    // 16 bytes base64 — a shorter nonce is guessable, and a 128-bit floor is the
    // thing a "make the tests pass" edit would quietly drop.
    expect(atob(nonce!).length).toBe(16);
  });

  it("gives two requests two different nonces", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const { response } = await run("/");
      seen.add(nonceOf(response)!);
    }
    // A reused nonce is a published constant, which is a policy an injected script
    // can satisfy. One repeat in 25 is enough to fail.
    expect(seen.size).toBe(25);
    expect([...seen].every(Boolean)).toBe(true);
  });

  it("puts the SAME nonce on the request Next renders and the response the browser reads", async () => {
    const { response, request: req } = await run("/pricing");
    expect(req, "no CSP was set on the request headers").toBeTruthy();
    // Not just "both have a nonce" — the same one. Two independently minted nonces
    // is a page whose scripts are all stamped with a value the browser rejects.
    expect(nonceOf(req)).toBe(nonceOf(response));
    expect(req).toBe(response);
  });

  it("strips a client-supplied CSP request header instead of trusting it", async () => {
    // The one input to this mechanism a caller controls. Letting it through means the
    // caller picks the nonce Next then stamps on every script it renders.
    const attacker = "script-src 'nonce-YXR0YWNrZXJzLW93bi1ub25jZQ=='";
    for (const name of [CSP_ENFORCED_HEADER, CSP_REPORT_ONLY_HEADER]) {
      const { request: req } = await run("/", { headers: { [name]: attacker } });
      expect(req).not.toContain("YXR0YWNrZXJzLW93bi1ub25jZQ==");
      expect(nonceOf(req)).toBeTruthy();
    }
  });

  it("emits exactly one CSP header name, never an enforced and a report-only pair", async () => {
    const { res } = await run("/");
    const names = [...res.headers.keys()].filter((k) =>
      k.startsWith("content-security-policy"),
    );
    expect(names).toEqual([CSP_HEADER.toLowerCase()]);
    // The one that is NOT live must be absent, or the browser evaluates two policies
    // and the report stream doubles.
    const dormant =
      CSP_HEADER === CSP_ENFORCED_HEADER ? CSP_REPORT_ONLY_HEADER : CSP_ENFORCED_HEADER;
    expect(res.headers.get(dormant)).toBeNull();
  });
});

describe("proxy — the policy it ships is the strict one", () => {
  /**
   * `IS_DEV` is read at MODULE scope in proxy.ts, and vitest runs with
   * `NODE_ENV=test` — so the proxy imported at the top of this file always carries
   * the Turbopack dev allowances (`'unsafe-eval'`, `'unsafe-inline'`, `ws:`). Asserting
   * against that instance would assert the dev policy while claiming to assert the
   * shipped one. Stub the env, drop the module cache, re-import: the assertions below
   * then run against the same branch production takes.
   */
  async function productionProxy() {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const mod = await import("./proxy");
    const res = await mod.proxy(request("/editor"));
    return { res, response: responseCsp(res), request: requestCsp(res) };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("never allows inline script, a wildcard, or eval", async () => {
    const { response } = await productionProxy();
    const scriptSrc = response!
      .split(";")
      .map((p) => p.trim())
      .find((p) => p.startsWith("script-src "))!;
    // A nonce makes browsers ignore 'unsafe-inline', so adding it looks harmless and
    // silently un-protects every browser that does not support nonces.
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(response).not.toContain("unsafe-eval");
    expect(response).not.toContain("wasm-unsafe-eval");
    expect(response).not.toContain("*");
    expect(scriptSrc).toContain("'strict-dynamic'");
  });

  it("keeps every restrictive directive the report-only walk validated", async () => {
    const { response } = await productionProxy();
    for (const directive of [
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "frame-src 'none'",
      "form-action 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "worker-src 'self'",
      `report-uri ${CSP_REPORT_PATH}`,
    ]) {
      expect(response, `lost ${directive}`).toContain(directive);
    }
  });

  it("does not exempt the authenticated pages from the policy", async () => {
    // The tempting shortcut when the app shell breaks under enforcement is to skip
    // the pages that broke. Then the pages holding user documents are the unprotected
    // ones.
    for (const path of [
      "/workspaces",
      "/workspaces/cku1abc/documents/cku2def",
      "/editor",
      "/admin/login",
    ]) {
      const { response, request: req } = await run(path);
      expect(nonceOf(response), `${path} has no nonce`).toBeTruthy();
      expect(nonceOf(req), `${path} request has no nonce`).toBe(nonceOf(response));
    }
  });
});

describe("proxy — the report-to group is defined wherever it is named", () => {
  /** Re-imports the proxy with a site origin of the given scheme baked in at boot. */
  async function proxyWithSiteUrl(siteUrl: string) {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", siteUrl);
    vi.resetModules();
    const mod = await import("./proxy");
    return (path: string, init: NextRequestInit = {}) =>
      mod.proxy(new NextRequest(`https://pdfdadi.test${path}`, init));
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("names no group and defines none on an http site origin", async () => {
    // `report-to`'s presence suppresses `report-uri` per spec and the Reporting API
    // needs a secure context, so on http adding it mutes the only mechanism that
    // works. Dev, every probe in this repo, and a plain-http staging box are all here.
    const run = await proxyWithSiteUrl("http://localhost:3000");
    const res = await run("/editor");
    expect(res.headers.get(REPORTING_ENDPOINTS_HEADER)).toBeNull();
    expect(res.headers.get(CSP_HEADER)).not.toContain("report-to");
    expect(res.headers.get(CSP_HEADER)).toContain(`report-uri ${CSP_REPORT_PATH}`);
  });

  it("names the group AND defines it on an https site origin", async () => {
    // The pair. A policy naming a group no `Reporting-Endpoints` header defines
    // reports nowhere, silently, and that is indistinguishable from no violations —
    // so the wiring test has to see both headers on the same response, not the
    // directive alone.
    const run = await proxyWithSiteUrl("https://pdfdadi.example");
    const res = await run("/editor");
    expect(res.headers.get(CSP_HEADER)).toContain(`report-to ${CSP_REPORT_GROUP}`);
    expect(res.headers.get(REPORTING_ENDPOINTS_HEADER)).toBe(
      `${CSP_REPORT_GROUP}="https://pdfdadi.example${CSP_REPORT_PATH}"`,
    );
    // Kept beside it: Chrome suppresses this one, Firefox and Safari have nothing else.
    expect(res.headers.get(CSP_HEADER)).toContain(`report-uri ${CSP_REPORT_PATH}`);
  });

  it("ignores a spoofed Host and Forwarded-Proto when naming the endpoint", async () => {
    // The endpoint is absolute, so its host had to come from somewhere. Taken from the
    // request it would be caller-chosen, and a caller who can choose it can redirect
    // this origin's entire violation stream — page paths, blocked sources — to their
    // own server. It comes from configuration instead, and this is what pins that.
    const run = await proxyWithSiteUrl("https://pdfdadi.example");
    const res = await run("/editor", {
      headers: {
        host: "evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      },
    });
    expect(res.headers.get(REPORTING_ENDPOINTS_HEADER)).toContain("pdfdadi.example");
    expect(res.headers.get(REPORTING_ENDPOINTS_HEADER)).not.toContain("evil.example");
  });

  it("reads the site origin at RUNTIME, not as a build-time literal", async () => {
    // The bug this pins was found in a built artifact, not in a test: Next substitutes
    // `process.env.NEXT_PUBLIC_*` for its build-time value, so the compiled middleware
    // carried `http://localhost:3000` and no lookup — a server started with the real
    // https origin advertised no report endpoint at all, and no behavioural test above
    // could see it, because they all run this file from source. The two spellings are
    // indistinguishable in the source, which is why this is asserted on the text.
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./proxy.ts", import.meta.url), "utf8");
    // Comments stripped first: the doc block above the constant has to be able to name
    // the spelling it forbids, and a check that cannot tell code from prose would make
    // explaining the rule impossible.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const reads = [...code.matchAll(/process\.env\.(NEXT_PUBLIC_\w+)/g)].map((m) => m[1]);
    expect(reads, "a NEXT_PUBLIC_ read here is frozen at build time").toEqual([]);
    expect(code).toContain("RUNTIME_ENV.NEXT_PUBLIC_SITE_URL");
    // The SPREAD is the part that works. `const RUNTIME_ENV = process.env` reads as a
    // runtime lookup and is not one: the minifier inlines the single-use alias back into
    // `process.env.NEXT_PUBLIC_SITE_URL` and the substitution lands anyway. That spelling
    // passed every test above, passed the assertion on the line above this one, and
    // shipped a frozen literal — caught only by running one build under two origins.
    expect(
      code,
      "aliasing process.env is inlined back to a member expression and re-substituted",
    ).toContain("RUNTIME_ENV: Record<string, string | undefined> = { ...process.env }");
  });

  it("carries the pair on the admin redirect too, not just the rendered path", async () => {
    // Same invariant as the CSP on a 307: every response this proxy returns is
    // completely configured, rather than every response that happened to need it.
    env.ADMIN_SECRET = "test-secret-at-least-8-chars";
    try {
      const run = await proxyWithSiteUrl("https://pdfdadi.example");
      const res = await run("/admin");
      expect(res.status).toBe(307);
      expect(res.headers.get(CSP_HEADER)).toContain(`report-to ${CSP_REPORT_GROUP}`);
      expect(res.headers.get(REPORTING_ENDPOINTS_HEADER)).toBe(
        `${CSP_REPORT_GROUP}="https://pdfdadi.example${CSP_REPORT_PATH}"`,
      );
    } finally {
      if (ORIG_SECRET === undefined) delete env.ADMIN_SECRET;
      else env.ADMIN_SECRET = ORIG_SECRET;
    }
  });
});

describe("proxy — matcher scope", () => {
  it("skips the paths that cannot consume a nonce", () => {
    // Immutable build output and the image optimizer's binary responses. Their HTML
    // was written before the request existed, so there is nothing to stamp — and
    // /_next/static is the highest-volume path on the site.
    for (const path of [
      "/_next/static/chunks/main-abc123.js",
      "/_next/static/css/abc.css",
      "/_next/static/media/pdf.worker.min.abc.mjs",
      "/_next/image",
      "/favicon.ico",
      "/robots.txt",
      "/sitemap.xml",
      "/icon.png",
    ]) {
      expect(MATCHER.test(path), `${path} should be excluded`).toBe(false);
    }
  });

  it("still covers every route that renders scripts, including the API", () => {
    for (const path of [
      "/",
      "/pricing",
      "/about",
      "/blog",
      "/blog/how-to-merge-pdf-files-online",
      "/tools/merge-pdf",
      "/editor",
      "/login",
      "/signup",
      "/workspaces",
      "/workspaces/cku1abc",
      "/workspaces/cku1abc/documents/cku2def",
      "/admin",
      "/admin/tools",
      "/api/health",
      CSP_REPORT_PATH,
    ]) {
      expect(MATCHER.test(path), `${path} should be matched`).toBe(true);
    }
  });

  it("leaves the report sink reachable, unredirected, under whichever policy is live", async () => {
    // Report delivery is exempt from CSP by specification, but the endpoint still has
    // to be a plain 200-path through this proxy — a redirect or a block here turns
    // enforcement into a silent rollout.
    expect(MATCHER.test(CSP_REPORT_PATH)).toBe(true);
    const { res, response } = await run(CSP_REPORT_PATH, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(response).toContain(`report-uri ${CSP_REPORT_PATH}`);
  });
});

describe("proxy — the admin gate still works", () => {
  beforeEach(() => {
    env.ADMIN_SECRET = "test-secret-at-least-8-chars";
  });
  afterEach(() => {
    if (ORIG_SECRET === undefined) delete env.ADMIN_SECRET;
    else env.ADMIN_SECRET = ORIG_SECRET;
  });

  it("redirects an unauthenticated /admin to the login page", async () => {
    const { res } = await run("/admin");
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/admin/login");
    // No `next` for the bare /admin — it is where login already lands.
    expect(location.searchParams.get("next")).toBeNull();
  });

  it("preserves the requested path so login returns there", async () => {
    const { res } = await run("/admin/tools/categories");
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/admin/login");
    expect(location.searchParams.get("next")).toBe("/admin/tools/categories");
  });

  it("carries the CSP on the redirect too", async () => {
    // A 307 runs no scripts, so this buys nothing today. It makes the invariant
    // "every response this proxy returns has exactly one CSP" checkable, rather than
    // "every response except the ones that happened not to need it".
    const { res, response } = await run("/admin");
    expect(res.status).toBe(307);
    expect(nonceOf(response)).toBeTruthy();
  });

  it("lets the login and first-run setup surfaces through unauthenticated", async () => {
    // Setup must be reachable with no session or the first admin password can never
    // be set; login must be reachable or the redirect above is a loop.
    for (const path of ["/admin/login", "/admin/setup", "/api/admin/login", "/api/admin/setup"]) {
      const { res } = await run(path);
      expect(res.status, `${path} was gated`).toBe(200);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("admits a valid session and gates a forged one", async () => {
    const token = await createSessionToken();
    const ok = await run("/admin/tools", {
      headers: { cookie: `${ADMIN_COOKIE}=${token}` },
    });
    expect(ok.res.status).toBe(200);
    expect(nonceOf(ok.response)).toBeTruthy();

    const tampered = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
    const bad = await run("/admin/tools", {
      headers: { cookie: `${ADMIN_COOKIE}=${tampered}` },
    });
    expect(bad.res.status).toBe(307);
  });

  it("gates every admin surface the widened matcher now reaches", async () => {
    // The old matcher was `/admin/:path*`, so `startsWith("/admin")` was implied.
    // Now the matcher covers the whole site and that test is the thing doing the
    // work — this is what fails if someone "simplifies" it away.
    for (const path of ["/admin", "/admin/seo", "/admin/analytics", "/admin/site"]) {
      const { res } = await run(path);
      expect(res.status, `${path} is unguarded`).toBe(307);
    }
    // ...and the widened matcher must not start gating the public site. This caught a
    // real defect: a bare `startsWith("/admin")` — correct under the old
    // `/admin/:path*` matcher, where nothing else could reach it — redirects
    // `/administrator-notes` and any other public slug beginning with those letters
    // to the admin login.
    for (const path of ["/", "/pricing", "/administrator-notes", "/adminish", "/api/health"]) {
      const { res } = await run(path);
      expect(res.status, `${path} got gated`).toBe(200);
    }
  });
});

describe("the nonce never reaches a log line", () => {
  it("is dropped from a violation report that quotes the whole policy back", async () => {
    // A report body echoes `original-policy` verbatim and `script-sample` quotes the
    // blocked script. Under enforcement both can carry the nonce, and this endpoint
    // logs what the sanitizer returns.
    const { response } = await run("/");
    const nonce = nonceOf(response)!;
    expect(nonce).toBeTruthy();
    const body = JSON.stringify({
      "csp-report": {
        "effective-directive": "script-src-elem",
        "blocked-uri": "inline",
        "document-uri": "https://pdfdadi.test/editor?doc=payroll",
        "original-policy": response,
        "script-sample": `window.__next_f.push([1,"${nonce}"])`,
        referrer: `https://pdfdadi.test/?n=${nonce}`,
      },
    });
    const reports = parseCspReports(body);
    // Fixture-inertness guard: if the parser rejected this body outright, the scan
    // below would pass over an empty array and prove nothing.
    expect(reports).toHaveLength(1);
    expect(reports[0].directive).toBe("script-src-elem");
    expect(reports[0].blocked).toBe("inline");
    // The whole serialized output, so a nonce surviving in any field is caught —
    // including a field added later that nobody thought to check.
    expect(JSON.stringify(reports)).not.toContain(nonce);
    expect(JSON.stringify(reports)).not.toContain("strict-dynamic");
    expect(JSON.stringify(reports)).not.toContain("nonce-");
  });
});
