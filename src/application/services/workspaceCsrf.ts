import { getConfig } from "@/src/infrastructure/config/env";

function csrfError(request: Request, code: string, message: string): Response {
  const requestId = request.headers.get("x-request-id")?.slice(0, 128) ?? "csrf-check";
  return Response.json({ error: { code, message, requestId } }, { status: 403 });
}

/**
 * The origins a state-changing request is allowed to claim to have come from.
 *
 * PRODUCTION: exactly the configured public origin (`NEXT_PUBLIC_SITE_URL`),
 * which the startup gate already validates as an absolute, non-loopback http(s)
 * URL. Nothing is derived from the request, because nothing in the request is
 * trustworthy for this decision:
 *
 *   - `request.url` is the SERVER'S OWN BIND ADDRESS in a production Next
 *     server — `next/dist/server/lib/start-server.js` sets
 *     ``appUrl = `${protocol}://${hostname}:${port}` `` — so behind a reverse
 *     proxy it is the INTERNAL origin, not the public one. Comparing the
 *     browser's real `Origin` against it rejected every legitimate same-origin
 *     mutation: production signup answered 403 `CSRF_ORIGIN_REJECTED` while a
 *     dev server answered 201 to the byte-identical request, because in dev you
 *     browse the bind address directly and the two match by coincidence.
 *   - `Host`, `X-Forwarded-Host` and `X-Forwarded-Proto` are client-supplied
 *     unless a trusted-proxy model validates them, and this repo has none.
 *     Deriving the expected origin from them would let a request name its own
 *     expected origin and turn the check into a no-op — `Origin:
 *     https://evil.example` plus `X-Forwarded-Host: evil.example` would pass.
 *     They are therefore never read here: not sanitized, not preferred when
 *     present, not read at all.
 *
 * DEVELOPMENT (and test): the request origin is accepted as well, so `next dev`
 * keeps working on whatever host and port you happen to browse without anyone
 * having to configure a site URL first. Only production is gated on that value,
 * so only production can rely on it.
 *
 * Fails CLOSED: if the config cannot be read the set is empty and every
 * state-changing request is refused, rather than falling back to the request.
 */
function trustedOrigins(request: Request): Set<string> {
  const origins = new Set<string>();
  // Assigned before the parse below so an unreadable site URL cannot make a
  // production deployment take the development branch.
  let isProduction = true;
  try {
    const config = getConfig();
    isProduction = config.isProduction;
    origins.add(new URL(config.siteUrl).origin);
  } catch {
    // Production refuses to boot on invalid config (`instrumentation.ts` calls
    // `getConfig()` at process start), so in practice this is a dev-only path.
  }
  if (!isProduction) {
    try {
      origins.add(new URL(request.url).origin);
    } catch {
      /* a request URL we cannot parse contributes no trusted origin */
    }
  }
  return origins;
}

/**
 * Enforces same-origin evidence for state-changing requests.
 *
 * This is the ONE origin-validation boundary in the app: every mutating auth,
 * billing and workspace route calls it, so the rule is fixed here rather than
 * per route. Kept free of Next.js server adapters so it stays directly testable
 * in Vitest — the only import is the config module, which is plain zod.
 */
export function requireSameOrigin(request: Request): Response | null {
  const expected = trustedOrigins(request);
  const rejected = () =>
    csrfError(request, "CSRF_ORIGIN_REJECTED", "Request origin is not allowed.");

  const origin = request.headers.get("origin");
  if (origin) {
    // Exact comparison against an already-serialized origin. Browsers serialize
    // `Origin` canonically — lowercase scheme and host, default port omitted, no
    // path, no credentials — and `URL.origin` produces that same serialization,
    // so anything not matching byte for byte was not produced by a browser
    // navigating our own site. Never a substring, prefix or suffix test:
    // `startsWith` would accept `https://pdfdadi.example.evil.com` and
    // `endsWith` would accept `https://evilpdfdadi.example`.
    return expected.has(origin) ? null : rejected();
  }

  const referer = request.headers.get("referer");
  if (referer) {
    // `Referer` carries a full URL, so its origin has to be extracted before
    // comparison — comparing whole URLs would reject every real request.
    try {
      return expected.has(new URL(referer).origin) ? null : rejected();
    } catch {
      return rejected();
    }
  }

  return csrfError(request, "CSRF_ORIGIN_REQUIRED", "A same-origin request is required.");
}
