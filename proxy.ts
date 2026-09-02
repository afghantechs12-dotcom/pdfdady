import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE, verifySessionToken } from "@/lib/admin/session";
import {
  CSP_ENFORCED_HEADER,
  CSP_HEADER,
  CSP_REPORT_ONLY_HEADER,
  REPORTING_ENDPOINTS_HEADER,
  buildCsp,
  newCspNonce,
  reportingEndpointFor,
  reportingEndpointsHeader,
  storageOriginsFrom,
} from "@/lib/security/csp.mjs";

/**
 * Two jobs, one pass over the request: the admin auth gate, and the per-request
 * Content-Security-Policy nonce.
 *
 * ## The admin gate (unchanged from when this file did only that)
 *
 * Routes under /admin (except /admin/login and /admin/setup) require a valid,
 * HMAC-signed `pdfdadi_admin` session cookie. The cookie is issued by the login API
 * only after a successful password check and cannot be forged without the
 * ADMIN_SECRET. Verification uses Web Crypto — the exact same helper guards the Node
 * API routes (see app/api/admin/_guard.ts, which every admin route calls except
 * login/logout/setup, the three that must work without a session).
 *
 * The matcher below is now the whole site rather than `/admin/:path*`, so the path
 * test is doing work the matcher used to do — and a bare `startsWith("/admin")` is
 * wrong at that width, because it also matches `/administrator-notes` and any future
 * public page whose slug begins with those five letters. Hence the exact `/admin` plus
 * `/admin/` prefix. This is the one place broadening the matcher could change admin
 * behaviour, and it changes it toward over-gating rather than under-gating, which is
 * why a test pins both directions.
 *
 * `/api/admin/*` is deliberately NOT gated here — it never was (it does not start with
 * `/admin`), and `_guard.ts` owns it. The two `/api/admin/...` exclusions kept below
 * are therefore unreachable, and kept only so that anyone who does widen the prefix
 * test has the login/setup carve-outs already in front of them.
 *
 * ## The nonce
 *
 * Next 16 reads the **request** header `content-security-policy` (falling back to
 * `…-report-only`), extracts `'nonce-…'` from `script-src`, and stamps that nonce on
 * every script it generates — the inline Flight payloads, the bootstrap script and
 * the preinit tags. Setting that request header is the entire mechanism; there is no
 * API to hand Next a nonce any other way, and nothing in the app has to read it.
 *
 * So: one nonce per request, minted before any branch, written to the request headers
 * for Next and to the response headers for the browser. The same string in both, and
 * a different string on the next request — a nonce reused across requests is a
 * published constant, which is a policy an injected script can satisfy.
 *
 * Any inbound `content-security-policy[-report-only]` request header is DELETED
 * first. It is the one input to this mechanism that a client can set, and the effect
 * of letting it through would be a caller choosing the nonce that Next then trusts.
 *
 * The response header is set on the redirect path too. A 307 carries no scripts, so
 * this buys nothing today; it means the invariant is "every response this proxy
 * returns carries exactly one CSP", which is checkable, rather than "every response
 * except the ones that happen not to need it".
 *
 * `next.config.mjs` still emits a policy for the paths the matcher excludes — the
 * `/_next/static/*` chunks, whose response CSP is what a Web Worker inherits. Config
 * headers are applied BEFORE middleware in `resolve-routes.js`, so where both run the
 * value written here wins; both names come from one constant, so there is never a
 * report-only copy sitting alongside an enforced one.
 *
 * ## What this file does NOT do
 *
 * It does not read the nonce back out anywhere, and no component receives it. The only
 * consumer is Next's own renderer, via the request header. Nothing writes it to a
 * cookie, to storage, to a query parameter, to config, or to a log line — a nonce that
 * is persisted or logged has stopped being per-request, and `lib/security/cspReport.ts`
 * drops `originalPolicy` from violation reports for the same reason.
 */

/**
 * Resolved once at module load — which is server boot, not build time.
 *
 * Verified in the built artifact: `functions-config-manifest.json` gives `/_middleware`
 * `"runtime": "nodejs"`, and `process.env.R2_ACCOUNT_ID` survives as a live lookup in
 * the compiled chunk rather than being substituted away. So unlike `next.config.mjs`
 * — whose `headers()` runs at build time and bakes its result into
 * `routes-manifest.json` — the policy on a *document* picks up storage configuration
 * from the running process. A Docker image built without R2 and run with it now serves
 * the right `connect-src` on every page; only the static-asset policy still lags until
 * a rebuild, and no download fetch is issued from a static asset.
 */
const STORAGE_ORIGINS = storageOriginsFrom({
  accountId: process.env.R2_ACCOUNT_ID,
  publicBaseUrl: process.env.R2_PUBLIC_BASE_URL,
});
const IS_DEV = process.env.NODE_ENV !== "production";

/**
 * A runtime COPY of the environment, because `NEXT_PUBLIC_*` is build-time by default.
 *
 * Next substitutes `process.env.NEXT_PUBLIC_SITE_URL` with a string literal at build
 * time. Found by reading the compiled artifact: the middleware chunk held the
 * build-time `http://localhost:3000` and no lookup at all, so a server started with the
 * real https origin still advertised no report endpoint — an image built once and run
 * anywhere would have this slice permanently dead in exactly the deployment it is for.
 *
 * Aliasing the object (`const E = process.env; E.NEXT_PUBLIC_SITE_URL`) does NOT help,
 * which is the trap: the minifier inlines the single-use alias back into a member
 * expression and the substitution lands anyway. That spelling was tried, shipped a
 * frozen literal, and was caught only by running one build under two different origins.
 * Spreading produces an object the substitution cannot see through, which is why
 * `src/infrastructure/config/env.ts` also gets a runtime value: it hands `process.env`
 * whole to a parser and never writes the member access.
 *
 * The difference between these spellings is invisible in the source and shows up only in
 * a built artifact, so the check that guards it is in `scripts/csp-probe.mjs`, which
 * reads a real server's headers. A source-level test can pin the forbidden spelling; it
 * cannot prove the surviving one still resolves at runtime.
 *
 * `next.config.mjs` keeps the direct read on purpose: `headers()` runs at build time
 * regardless, so there is no runtime value there to lose.
 */
const RUNTIME_ENV: Record<string, string | undefined> = { ...process.env };

/**
 * The `report-to` endpoint, or null on a non-https site origin — see
 * {@link reportingEndpointFor}, which is where the scheme rule and the reason for it
 * live. Resolved at boot from the configured site URL, deliberately not per request
 * from `Host`: a per-request value would let a caller choose where this origin's
 * violation reports are delivered.
 */
const REPORT_ENDPOINT = reportingEndpointFor(RUNTIME_ENV.NEXT_PUBLIC_SITE_URL);
const REPORTING_ENDPOINTS_VALUE = REPORT_ENDPOINT
  ? reportingEndpointsHeader(REPORT_ENDPOINT)
  : null;

/**
 * The response side of the policy: the CSP, plus the header defining the group its
 * `report-to` names. Both, on every response this proxy returns, or the directive
 * points at nothing and reports vanish silently.
 */
function withPolicy<T extends Response>(res: T, csp: string): T {
  res.headers.set(CSP_HEADER, csp);
  if (REPORTING_ENDPOINTS_VALUE) {
    res.headers.set(REPORTING_ENDPOINTS_HEADER, REPORTING_ENDPOINTS_VALUE);
  }
  return res;
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Before any branch, so every `return` below carries the same one.
  const csp = buildCsp({
    nonce: newCspNonce(),
    storageOrigins: STORAGE_ORIGINS,
    dev: IS_DEV,
    reportEndpoint: REPORT_ENDPOINT,
  });

  // Protect /admin/* except the login page, the first-run setup page, and
  // their APIs. Setup must be reachable without a session so the very first
  // admin password can be configured (see app/admin/setup).
  if (
    (pathname === "/admin" || pathname.startsWith("/admin/")) &&
    pathname !== "/admin/login" &&
    pathname !== "/admin/setup" &&
    !pathname.startsWith("/api/admin/login") &&
    !pathname.startsWith("/api/admin/setup")
  ) {
    const token = req.cookies.get(ADMIN_COOKIE)?.value;
    if (!(await verifySessionToken(token))) {
      const loginUrl = new URL("/admin/login", req.url);
      if (pathname !== "/admin") loginUrl.searchParams.set("next", pathname);
      return withPolicy(NextResponse.redirect(loginUrl), csp);
    }
  }

  const requestHeaders = new Headers(req.headers);
  requestHeaders.delete(CSP_ENFORCED_HEADER);
  requestHeaders.delete(CSP_REPORT_ONLY_HEADER);
  requestHeaders.set(CSP_HEADER, csp);

  return withPolicy(NextResponse.next({ request: { headers: requestHeaders } }), csp);
}

/**
 * Everything a nonce can reach, and nothing that cannot consume one.
 *
 * Excluded, in order: `/_next/static/*` (immutable build output — its HTML was written
 * before this request existed, and it is the highest-volume path on the site, so
 * running an Edge function over it would be the whole cost of this slice for no
 * effect), `/_next/image` (the optimizer's binary responses), and any path whose last
 * segment contains a dot — `favicon.ico`, `robots.txt`, `sitemap.xml`, `*.png`. No
 * page route in this app has a dot in its path (tool and blog slugs are kebab-case,
 * workspace and document ids are cuids), so the extension rule costs no coverage.
 *
 * Everything else is in, including `/api/*`. An API response cannot use a nonce
 * either, but minting one is 16 bytes from `crypto.getRandomValues` and a base64
 * encode; the alternative is two policy shapes on the wire, and "which shape did this
 * response get" is a question worth not having.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|.*\\.[^/]*$).*)"],
};
