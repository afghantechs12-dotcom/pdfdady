/**
 * The ingress body policy: which requests may carry how many bytes, decided from
 * the request line and headers alone, before any body byte is read.
 *
 * ## Why this exists
 *
 * `proxy.ts`'s matcher covers the whole site. For every matched request whose
 * method is not GET/HEAD, Next clones the request body so the proxy and the
 * route handler can both read it (`next/dist/server/body-streams.js`
 * `cloneBodyStream`): it attaches a `'data'` listener, pushes every chunk into
 * two `Readable`s, and stops only when the total passes
 * `experimental.proxyClientMaxBodySize` — 120 MB here. That number bounds
 * RETENTION, not socket reads, and nothing in the application runs before it.
 * Measured: 28 concurrent anonymous 100 MiB POSTs took process RSS from ~301 MiB
 * to 1795 MiB and it stayed there. No authentication, no route, no rate limit
 * involved — a page URL or a path with no route at all is enough.
 *
 * The fix cannot live in a route handler, because on those paths no handler
 * runs. It has to be decided before the request reaches Next, which is what
 * `guard.mjs` does with the decision this module makes.
 *
 * ## The three classes
 *
 * A — no request body is expected. Pages, `/_next/*`, static files, and every
 *     path with no route at all. The ceiling is 0: this app has no Server
 *     Actions (nothing in the tree is marked `"use server"`), so nothing
 *     legitimate POSTs a body to a non-API path. A body here is refused before
 *     Next sees the request, which is the whole 120 MB retention window closed
 *     for exactly the paths the measurement used.
 *
 * B — a small structured body. Every `/api/*` route that is not one of the five
 *     in class C. One ceiling for all of them, deliberately coarse: the routes
 *     keep their own, tighter, per-route limits (4 KiB for auth, 16 KiB for
 *     `csp-report` and `analytics/events`, 1 MiB for the billing webhook,
 *     `MAX_AUTOSAVE_BODY_BYTES` for autosave, …) and those stay authoritative
 *     for the client-visible error. This ceiling only has to be above every one
 *     of them and far below 120 MB. Duplicating the per-route numbers here would
 *     be two places to change and one of them would drift.
 *
 * C — a large file upload, streamed. The five multipart paths that `proxy.ts`
 *     excludes from its matcher, and therefore the five that Next never clones.
 *     They already refuse before reading (declared length), count the bytes they
 *     do read (`lib/server/multipart.ts`), and authenticate before parsing
 *     (`lib/server/workspaceUploadGate.ts`). This module passes them through
 *     untouched: a second ceiling here would be a duplicate of the one they
 *     enforce, and the two would disagree the first time one moved.
 *
 * ## Why chunked bodies are refused in A and B
 *
 * A body with no `Content-Length` cannot be measured without reading it, and
 * reading it in front of Next means either buffering it (the thing we are
 * trying not to do) or handing Next a request whose stream has already been
 * consumed. So `Transfer-Encoding: chunked` on a class A or B path is answered
 * 411 without reading a byte. Nothing in this app sends one: `fetch` with a
 * string, `URLSearchParams` or `FormData` body always sets `Content-Length`, and
 * a streaming request body (`duplex: "half"`) appears nowhere outside
 * `lib/server/multipart.ts`, which is class C and still accepts chunked.
 *
 * With chunked refused, `Content-Length` is not a claim the client can escape:
 * Node's HTTP parser delivers exactly the declared number of body bytes to the
 * request and treats anything after them as the next request on the connection.
 * An understated length therefore cannot carry a larger body into Next — it can
 * only make the connection fail its own parse. That is what `E6` measures.
 */

/**
 * The five paths `proxy.ts` excludes from its matcher, in the same order and
 * with the same `$` anchors. Kept as separate sources rather than one blob so
 * `ingress/policy.test.ts` can hold each one against the matcher literal: if an
 * exclusion is added, removed or re-anchored there and not here, a class C
 * upload silently becomes class B and starts answering 413 at 2 MiB.
 */
export const STREAMING_ROUTE_PATTERNS = [
  "^/api/jobs$",
  "^/api/tools/[^/]+$",
  "^/api/workspaces/[^/]+/documents/upload$",
  "^/api/workspaces/[^/]+/documents/[^/]+/versions/upload$",
  "^/api/workspaces/[^/]+/documents/[^/]+/attachments$",
];

const STREAMING_ROUTES = STREAMING_ROUTE_PATTERNS.map((p) => new RegExp(p));

/** Class A: no body at all. See the note above on Server Actions. */
export const CLASS_A_MAX_BYTES = 0;

/**
 * Class B: one ceiling for every other API route, 2 MiB.
 *
 * The largest legitimate body among them is autosave's
 * `MAX_AUTOSAVE_BODY_BYTES` (1 MiB payload + 8 KiB envelope = 1_056_768), so
 * this leaves that route its full range plus headroom, and every other route is
 * an order of magnitude below it. `ingress/policy.test.ts` pins the
 * relationship, so raising a route's own limit past this one fails a test rather
 * than turning into a 413 in production.
 */
export const CLASS_B_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The path as the matcher sees it: no query, and no attempt to normalise.
 *
 * `req.url` is normally origin-form (`/path?query`), but a client may send
 * absolute-form (`POST http://host/path`). That does not start with `/api/`, so
 * it lands in class A and is refused if it carries a body — the strict side of
 * the branch, and the same side the matcher's own negative lookahead takes.
 */
export function pathnameOf(url) {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/** `"A"`, `"B"` or `"C"` for a pathname. */
export function classifyPath(pathname) {
  if (STREAMING_ROUTES.some((re) => re.test(pathname))) return "C";
  if (pathname === "/api" || pathname.startsWith("/api/")) return "B";
  return "A";
}

/** The ceiling for a class, in bytes. `null` for C, which owns its own. */
export function maxBytesForClass(cls) {
  if (cls === "A") return CLASS_A_MAX_BYTES;
  if (cls === "B") return CLASS_B_MAX_BYTES;
  return null;
}

/**
 * Does this request carry a body at all?
 *
 * Method-agnostic on purpose. `GET` with a body is legal to send and Node will
 * parse it, so a policy keyed on the method would leave `GET /` with a 100 MiB
 * body on the retained path. Keyed on the headers instead, the answer is the
 * same for every method.
 */
function hasBody(headers) {
  if (headers["transfer-encoding"] !== undefined) return true;
  const len = headers["content-length"];
  return len !== undefined && len !== "0";
}

/**
 * The whole decision: `null` to hand the request to Next untouched, or the
 * refusal to write instead.
 *
 * `headers` is a Node `IncomingMessage.headers` (lower-cased keys). Nothing here
 * reads the body, and nothing here is async: the decision is made in the
 * `'request'` (or `'checkContinue'`) event, before the parser has had a chance
 * to deliver a second chunk.
 *
 * Refusals carry no route information. The same three shapes answer a page, a
 * real API route and a path with no route at all, so a body-bearing probe cannot
 * use the ingress to tell an existing protected route from a nonexistent one.
 */
export function ingressDecision({ url, headers }) {
  if (!hasBody(headers)) return null;

  const cls = classifyPath(pathnameOf(url));
  if (cls === "C") return null;

  const maxBytes = maxBytesForClass(cls);

  // No length to check, and measuring it would mean reading it. See above.
  if (headers["transfer-encoding"] !== undefined) {
    return {
      status: 411,
      code: "LENGTH_REQUIRED",
      message: "A request body must declare Content-Length.",
      cls,
      maxBytes,
    };
  }

  // Digits only, which is what RFC 9110 allows and what Node's parser accepts.
  // `Number()` alone would take `1e6` (a length Node itself rejects) and `" 5"`,
  // so the guard's idea of the declared length would differ from the parser's on
  // exactly the inputs a client chose deliberately.
  const raw = headers["content-length"];
  const declared = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(declared)) {
    return {
      status: 400,
      code: "INVALID_INPUT",
      message: "Malformed Content-Length.",
      cls,
      maxBytes,
    };
  }
  if (declared > maxBytes) {
    return {
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      message: "Request body is too large.",
      cls,
      maxBytes,
      declared,
    };
  }
  return null;
}
