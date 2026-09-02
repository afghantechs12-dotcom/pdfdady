/* global process */
import {
  CSP_HEADER,
  REPORTING_ENDPOINTS_HEADER,
  buildCsp,
  reportingEndpointFor,
  reportingEndpointsHeader,
  storageOriginsFrom,
} from "./lib/security/csp.mjs";

/**
 * Origins the browser is redirected to for job output.
 *
 * `GET /api/jobs/:id/download` answers 302 to a signed storage URL and the client
 * `fetch`es through that redirect, so with R2 configured the account endpoint has to
 * be in `connect-src` or the download reports (and later fails). Derived from the
 * same variables `src/infrastructure/config/env.ts` reads — never a literal, never a
 * wildcard: `assertConcreteOrigin` throws the build if either value is not a concrete
 * https origin. Empty with local-disk storage, where the redirect stays same-origin.
 */
const STORAGE_ORIGINS = storageOriginsFrom({
  accountId: process.env.R2_ACCOUNT_ID,
  publicBaseUrl: process.env.R2_PUBLIC_BASE_URL,
});

/**
 * Where `report-to` sends violations, or `null` on any non-https origin.
 *
 * Same value the proxy computes, from the same variable, so a document and a static
 * asset never advertise different report endpoints. Resolved at BUILD time here — the
 * same limitation `STORAGE_ORIGINS` has and for the same reason — which is harmless
 * because `NEXT_PUBLIC_*` has to be set at build to be inlined into the client bundle
 * at all, so a build that could serve the right site URL already knows it.
 *
 * The static-asset policy needs this as much as a document does: a Web Worker inherits
 * the CSP of its own response, and pdf.js's worker is a `/_next/static/media/*.mjs`
 * file. Leaving these paths on `report-uri` alone would mean worker violations go
 * silent the day browsers drop it, which is the exact failure this endpoint exists to
 * prevent.
 */
const REPORT_ENDPOINT = reportingEndpointFor(process.env.NEXT_PUBLIC_SITE_URL);

/**
 * Security response headers, applied to every route.
 *
 * The non-CSP headers are static and belong here: `headers()` is the platform's own
 * mechanism and costs nothing per request, where an edge function would cost one
 * invocation per asset to set five constants.
 *
 * The Content-Security-Policy here is the **nonce-less** shape, and it is the one
 * `proxy.ts` does not reach: `/_next/static/*` and `/_next/image` are excluded from
 * the proxy's matcher because immutable build output cannot consume a per-request
 * nonce. That still leaves them needing a policy — a Web Worker inherits the CSP of
 * *its own* response, and pdf.js's worker is a `/_next/static/media/*.mjs` file, so
 * dropping this would drop the policy the worker runs under.
 *
 * Where both apply, the proxy's nonce-bearing value wins: `resolve-routes.js`
 * processes `fsChecker.headers` (this function) BEFORE `middleware`, and both assign
 * `resHeaders[key]`, so the later write replaces the earlier one. One CSP header per
 * response, either way — and the header *name* comes from {@link CSP_HEADER} in both
 * places, so an enforced policy can never end up shipping beside a report-only one.
 *
 * `headers()` is evaluated at BUILD time and baked into `routes-manifest.json`, so
 * `STORAGE_ORIGINS` below is resolved from the build environment — a build that has no
 * R2 configuration ships a policy without the storage origin, whatever the runtime
 * environment later says. `proxy.ts` does NOT have this limitation (it compiles to the
 * nodejs runtime and reads `process.env` at boot), so the shortfall is now confined to
 * static assets, which issue no download `fetch`. Recorded in the ledger.
 */
const securityHeaders = [
  // Stop the browser from re-interpreting a response as a type we did not send —
  // the classic path from "user-uploaded file" to "executed script".
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Nothing in PDFDadi is designed to be framed (verified: no <iframe> in the
  // app), so DENY is safe and blocks clickjacking outright.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Deny device APIs the product never asks for, so a future dependency cannot
  // start asking on our behalf.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // Isolate this origin's browsing context group from anything it opens.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // No nonce in this one, on purpose: the paths that get it are static files, and
  // there is no per-request render to stamp a nonce onto. `script-src 'self'` is
  // exactly right for them — every script under /_next/static IS same-origin, so
  // this shape enforces cleanly even though the same shape on a document would
  // report every inline Flight payload.
  {
    key: CSP_HEADER,
    value: buildCsp({
      storageOrigins: STORAGE_ORIGINS,
      dev: process.env.NODE_ENV !== "production",
      reportEndpoint: REPORT_ENDPOINT,
    }),
  },
];

// The group `report-to` names. Emitted only when the policy above actually carries
// that directive: the header alone is dead weight, and the directive alone reports
// into a group nothing defines — which is silent, and looks exactly like peace.
if (REPORT_ENDPOINT) {
  securityHeaders.push({
    key: REPORTING_ENDPOINTS_HEADER,
    value: reportingEndpointsHeader(REPORT_ENDPOINT),
  });
}

// HSTS is production-only. On a plain-http dev origin it is ignored by browsers
// for localhost but pinning it is still the wrong instruction to send, and a
// stray max-age against a shared dev hostname is painful to undo.
if (process.env.NODE_ENV === "production") {
  securityHeaders.push({
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  });
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Static generation spawns one worker per core (12 here), each with its own
  // V8 heap *and* its own libvips thread pool for the blog's opengraph-image
  // SVG rasterization. On a 16 GB machine with only a few GB actually free,
  // those oversubscribe physical memory and the build dies — sometimes as
  // "vips_tracked: out of memory", sometimes as a V8 heap OOM — depending on
  // what else is running rather than on anything in the source. Capping the
  // worker count trades a little build wall-clock for a build that does not
  // depend on the host's free memory. See also scripts/next-build.js, which
  // pins VIPS_CONCURRENCY for the same reason.
  experimental: {
    cpus: 4,
  },
  // Produces a minimal self-contained server bundle for Docker/production.
  output: "standalone",
  // Prisma's generated client + query engine live under node_modules/.prisma
  // and node_modules/@prisma/client. Trace them into the standalone output so
  // the production image can talk to the database.
  outputFileTracingIncludes: {
    "/": ["./node_modules/.prisma/client/**", "./node_modules/@prisma/client/**"],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
