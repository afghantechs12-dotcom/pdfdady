/* global URL, btoa */
/**
 * The one place PDFDadi's Content-Security-Policy is defined.
 *
 * `.mjs` on purpose: `next.config.mjs` emits the header and cannot import TypeScript,
 * so a `.ts` module here would mean two copies of the policy — which is how the
 * enforced one and the tested one start to disagree. `allowJs` lets the `.test.ts`
 * and any TS consumer import this file directly, so there is exactly one source.
 *
 * ## Every allowance below is derived from the built artifact, not guessed
 *
 * Read from `.next/server/app/index.html` and `.next/static` of a real production
 * build:
 *
 * - **`script-src 'self'`** — every executable script is `/_next/static/chunks/*.js`.
 *   Nothing loads from a CDN. The 3 `<script type="application/ld+json">` blocks are
 *   data, not script, and CSP does not police them.
 * - **`style-src 'self' 'unsafe-inline'`** — stylesheets are external
 *   (`/_next/static/chunks/*.css`, no `<style>` tag in the output), but the pages
 *   carry inline `style=""` attributes (33 on the homepage alone, 72 `style={{}}` in
 *   the source). A nonce cannot cover a style *attribute*; only `'unsafe-inline'` or
 *   a hash per literal value can, and the values are computed at runtime. This one
 *   is permanent, not interim.
 * - **`img-src 'self' data: blob:`** — `data:` because the editor's images ARE data
 *   URLs (`readImageFileAsDataUrl`, `rasterizePageBackground`'s `canvas.toDataURL`,
 *   the page thumbnails in `PagesPanel`). `blob:` because `SignTool` previews the
 *   uploaded signature through `URL.createObjectURL`.
 * - **`font-src 'self'`** — `next/font` self-hosts Inter at
 *   `/_next/static/media/*.woff2`. There is no `fonts.gstatic.com` request to allow.
 * - **`worker-src 'self'`** — pdf.js's worker is bundled to
 *   `/_next/static/media/pdf.worker.min.*.mjs`. `PDFWorker.#initialize` only wraps
 *   the worker in a `blob:` URL when `workerSrc` is *cross-origin*; ours is not, so
 *   `blob:` here would be an allowance nothing uses.
 * - **`connect-src 'self'` + configured storage** — all `fetch` targets are `/api/*`,
 *   except that `GET /api/jobs/:id/download` answers **302 to a signed storage URL**
 *   and `fetch` follows it. With local-disk storage that redirect stays same-origin;
 *   with R2 it lands on the account endpoint, which is why `storageOrigins` exists.
 *   (The other download path, `useProcessingJob`'s `window.location.assign`, is a
 *   navigation and no fetch directive applies to it.)
 *
 * ## And what is deliberately absent
 *
 * - **No `'unsafe-eval'`.** pdf.js 6 has no `new Function` compiler left — the one
 *   match in `pdf.worker.mjs` is the class `FunctionBasedShading`.
 * - **No `'wasm-unsafe-eval'`.** pdf.js 6 compiles Type-4 (PostScript) functions to
 *   WebAssembly, but `buildPostScriptWasmFunction` is wrapped in `try {}` and falls
 *   through to `buildPostScriptJsFunction`. A blocked compile costs interpreter speed
 *   on the minority of PDFs that use Type-4 functions; it does not cost correctness.
 *   Buying that back with `'wasm-unsafe-eval'` would hand an injected script a
 *   general-purpose code path, which is a bad trade.
 * - **No `*`, anywhere.** Enforced by test, and by `assertConcreteOrigin` for the one
 *   input that comes from configuration.
 *
 * ## The nonce architecture that enforces it (3.2)
 *
 * The production HTML contained **152 inline `<script>`** elements across the walked
 * pages — React Flight payloads. They are the whole reason 3.1 shipped Report-Only:
 * `script-src 'self'` reports every one of them, and enforcing that would have blanked
 * the app. Next 16's supported fix, now wired, is a request-scoped nonce:
 * `app-render.js` reads the **request** header `content-security-policy` (falling back
 * to `…-report-only`), pulls `'nonce-…'` out of `script-src` via
 * `getScriptNonceFromHeader`, and stamps it on every script it generates. `proxy.ts`
 * mints one nonce per request with {@link newCspNonce}, sets the policy on the request
 * headers so Next can read it, and sets the identical policy on the response.
 *
 * Measured against the real standalone artifact before any of this was written, by
 * handing the server a nonce on the request header and counting the served HTML:
 *
 *   route      inline <script> without a nonce   nonced <script>
 *   /editor    0                                 24     (dynamic — nonce applied)
 *   /          84                                0      (prerendered — nonce IGNORED)
 *   /pricing   24                                0      (prerendered — nonce IGNORED)
 *
 * **A prerendered route cannot carry a per-request nonce.** Its HTML was written at
 * build time, when no request and no nonce existed, and `base-server.js` serves it
 * from the response cache without re-rendering — nothing in that path consults the
 * nonce (it appears nowhere in `base-server.js`). So the nonce reaching the scripts
 * requires the route to render per request, which is why the root layout is
 * `force-dynamic`. Next 16 offers no config to inject a nonce into a prerender, and
 * the alternative — reusing one baked nonce so the HTML can stay static — would make
 * the nonce a public constant and the policy decorative.
 *
 * `'strict-dynamic'` comes with the nonce because Next's chunk loader injects
 * `<script>` elements at runtime; a bare nonce would block every one of them. Note
 * that `'strict-dynamic'` makes browsers **ignore** `'self'` for scripts, which is
 * why the two shapes are genuinely different and both are tested.
 */

/** Same-origin path the browser POSTs violation reports to. */
export const CSP_REPORT_PATH = "/api/csp-report";

/**
 * The Reporting API group name, and the header that gives that group a URL.
 *
 * One constant for each, shared by both call sites, because `report-to <group>` in
 * the policy and `Reporting-Endpoints: <group>="…"` on the response are a matched
 * pair. A policy naming a group no header defines reports nowhere — silently, and
 * indistinguishably from having no violations at all.
 */
export const CSP_REPORT_GROUP = "csp-endpoint";
export const REPORTING_ENDPOINTS_HEADER = "Reporting-Endpoints";

/**
 * The absolute report URL to advertise, or `null` when `report-to` must not ship.
 *
 * Derived from the CONFIGURED site origin, never from the request's `Host`. A
 * violation report describes a page a real user was on, and the Reporting API wants
 * an absolute URL — so building this from a client-settable header would let a caller
 * point the entire report stream at a host we do not own. `report-uri` never had this
 * question to answer, because a same-origin path cannot name another host.
 *
 * `null` for anything that is not https, and a silent skip rather than a throw: an
 * http origin is the correct, intended configuration for dev, for this repo's probes,
 * and for a plain-http staging box, and on those `report-to` is worse than absent (see
 * the directive comment in {@link buildCsp}). An https origin that is NOT concrete —
 * a wildcard, a typo — does throw, via {@link assertConcreteOrigin}, because that is
 * the one case where reports would genuinely be sent somewhere unintended.
 *
 * @param {string | undefined} siteUrl Usually `process.env.NEXT_PUBLIC_SITE_URL`.
 * @param {string} [reportPath]
 * @returns {string | null}
 */
export function reportingEndpointFor(siteUrl, reportPath = CSP_REPORT_PATH) {
  const raw = typeof siteUrl === "string" ? siteUrl.trim() : "";
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  return `${assertConcreteOrigin(url.origin)}${reportPath}`;
}

/** The `Reporting-Endpoints` value pairing {@link CSP_REPORT_GROUP} with `endpoint`. */
export function reportingEndpointsHeader(endpoint) {
  return `${CSP_REPORT_GROUP}="${endpoint}"`;
}

/**
 * The two header names, and which one is live.
 *
 * ONE constant decides, because two call sites emit this policy and they must agree:
 * `proxy.ts` for every document, `next.config.mjs` for the static assets the proxy
 * deliberately does not run for. Two independently-flipped switches is how a response
 * ends up carrying an enforced policy *and* a report-only one — which is not belt and
 * braces, it is the same violation reported twice from a policy nobody can read off
 * the wire with confidence.
 *
 * Rolling back is this one line plus a rebuild — deliberately not an environment
 * variable, because a runtime switch on the policy is a runtime switch on the
 * protection: anyone who can set env on the box could quietly disable it, and the
 * value that shipped would no longer be readable from the source.
 *
 * The flip to enforcement was earned, not assumed. Stage A ran the whole production
 * browser walk with the nonce wiring live and this constant still report-only: 109/109
 * checks, 0 unnonced scripts across 6 routes (97/35/23/35/24/37 scripts), and the
 * inline-script surface 3.1 measured at 152 reports down to 0. The only violation left
 * was the probe's own deliberate canary. Enforcing before that number was 0 would have
 * been enforcing a blank screen.
 */
export const CSP_REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only";
export const CSP_ENFORCED_HEADER = "Content-Security-Policy";
/** Stage B: enforcing. Flip back to `CSP_REPORT_ONLY_HEADER` to roll back. */
export const CSP_HEADER = CSP_ENFORCED_HEADER;

/**
 * Next's own nonce parser, copied from
 * `next/dist/server/app-render/get-script-nonce-from-header.js`. Kept here so a nonce
 * this module mints can be proven acceptable to the framework that has to read it —
 * a nonce Next silently rejects yields a page whose scripts are all unnonced, which
 * under enforcement is a blank screen.
 */
export const NEXT_CSP_NONCE_SOURCE_REGEX = /^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/;

/**
 * Rejects anything that is not a concrete `https:` (or `http:` for localhost) origin.
 *
 * The single input to this policy that is not a literal — the storage origin — comes
 * from deployment configuration, so it is the single place a `*` could get in. A
 * typo'd or wildcard value must fail loudly at build time rather than widen the
 * policy quietly. Returns the normalized origin (scheme + host + port), dropping any
 * path/query the operator included.
 */
export function assertConcreteOrigin(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) throw new Error("CSP origin is empty.");
  if (raw.includes("*")) {
    throw new Error(`CSP origin must not contain a wildcard: ${raw}`);
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`CSP origin is not an absolute URL: ${raw}`);
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    throw new Error(`CSP origin must be https (or http on localhost): ${raw}`);
  }
  return url.origin;
}

/**
 * Derives the `connect-src` storage origins from deployment configuration.
 *
 * Two call sites need this list and it has to be the same list in both, or the policy
 * on a document and the policy on a static asset disagree about where a download may
 * be fetched from. Pure, taking the two values rather than reading `process.env`
 * itself: that keeps the literal `process.env.X` references at the call sites, which
 * is what Next inlines into the Edge proxy bundle at build time.
 *
 * Values are not validated here — `assertConcreteOrigin` does that inside
 * {@link buildCsp}, so a wildcard or a plain-http origin fails the build wherever it
 * entered from.
 *
 * @param {{ accountId?: string, publicBaseUrl?: string }} [config]
 * @returns {string[]}
 */
export function storageOriginsFrom(config = {}) {
  const { accountId, publicBaseUrl } = config;
  return [
    accountId ? `https://${accountId}.r2.cloudflarestorage.com` : null,
    publicBaseUrl || null,
  ].filter((value) => typeof value === "string" && value.length > 0);
}

/**
 * Builds the policy.
 *
 * @param {object} [options]
 * @param {string} [options.nonce] Request-scoped nonce. Its presence switches
 *   `script-src` from the discovery shape (`'self'`) to the enforcement shape
 *   (`'nonce-…' 'strict-dynamic'`).
 * @param {readonly string[]} [options.storageOrigins] Extra `connect-src` origins for
 *   object storage, when the deployment redirects downloads off-origin.
 * @param {boolean} [options.dev] Add the allowances the Next dev server needs. Never
 *   subtracts anything, so the dev policy can only ever be looser than production's.
 * @param {string} [options.reportPath] Override the report sink (tests).
 * @param {string | null} [options.reportEndpoint] Absolute URL from
 *   {@link reportingEndpointFor}. Non-null adds `report-to`; the caller must then also
 *   send the {@link REPORTING_ENDPOINTS_HEADER} that defines the group.
 * @returns {string} The `Content-Security-Policy[-Report-Only]` header value.
 */
export function buildCsp(options = {}) {
  const {
    nonce,
    storageOrigins = [],
    dev = false,
    reportPath = CSP_REPORT_PATH,
    reportEndpoint = null,
  } = options;

  const connect = ["'self'", ...storageOrigins.map(assertConcreteOrigin)];

  // Turbopack's HMR client opens a websocket and evaluates hot modules. Report-Only
  // makes these harmless, but a dev console full of framework noise is a console
  // nobody reads — which is how a real violation goes unnoticed. Additive only:
  // production never sees these, and `dev` never removes a source.
  const script = nonce
    ? [`'nonce-${nonce}'`, "'strict-dynamic'"]
    : ["'self'"];
  if (dev) {
    script.push("'unsafe-eval'", "'unsafe-inline'");
    connect.push("ws:", "wss:");
  }

  const directives = [
    // Same-origin floor for anything not named below (media, manifest, prefetch).
    // Every asset this app loads is its own, so 'self' is the honest default; 'none'
    // would only mean re-listing 'self' under three more names.
    ["default-src", ["'self'"]],
    // Neutralizes an injected <base href> — the cheapest way to turn every relative
    // script URL on the page into an attacker's.
    ["base-uri", ["'self'"]],
    // No <object>/<embed>/<applet> in the product, and these are legacy plugin
    // vectors with a long history. 'none' outright.
    ["object-src", ["'none'"]],
    // The pair X-Frame-Options: DENY cannot express on its own, plus the reverse:
    // frame-src stops an injected script from framing a phishing page inside ours.
    ["frame-ancestors", ["'none'"]],
    ["frame-src", ["'none'"]],
    // Every form in the app submits through onSubmit + fetch; none has an `action`.
    // Stripe is reached with location.assign, which is a navigation, not a submit.
    ["form-action", ["'self'"]],
    ["script-src", script],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'"]],
    ["connect-src", dedupe(connect)],
    ["worker-src", ["'self'"]],
    // Both report mechanisms, with the configured scheme deciding whether the
    // modern one ships at all.
    //
    // Measured with headless Chrome against a server emitting each variant
    // (scripts/csp-probe.mjs documents the run):
    //
    //   origin   report-uri alone   report-to alone   BOTH
    //   http     delivered <1s      nothing           NOTHING
    //   https    delivered <1s      delivered ~60s    ~70s
    //
    // The bottom-left cell is why `report-to` cannot ship unconditionally: the
    // Reporting API needs a secure context, and the spec makes `report-to`'s presence
    // *suppress* `report-uri` — so on an http origin (dev, this repo's probes, a
    // plain-http staging box) adding it is a mute button rather than a fallback.
    // `reportEndpoint` is null unless the configured site origin is https, and this
    // directive disappears with it. That is the whole of the conditionality.
    //
    // On https both ship, because no browser honours both: Chrome takes `report-to`
    // and suppresses `report-uri` by spec, while Firefox and Safari have no CSP
    // Reporting API and take `report-uri`. Dropping either would go silent on part of
    // the fleet — which is also why `lib/security/cspReport.ts` already parses both
    // wire formats. The price is Chrome's ~60s batching instead of sub-second
    // delivery; the purchase is a mechanism that outlives `report-uri`'s removal and
    // can still deliver a report queued past the unload of the page that broke.
    ["report-uri", [reportPath]],
    ...(reportEndpoint ? [["report-to", [CSP_REPORT_GROUP]]] : []),
  ];

  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}

/**
 * Mints a nonce Next's `getScriptNonceFromHeader` will accept.
 *
 * 16 random bytes (128 bits) from the platform CSRNG, base64. Called once per request
 * by `proxy.ts` and nowhere else. It lives beside the policy so the charset contract
 * is pinned by the same test file that pins the policy — the two have to agree, and
 * nothing else checks that they do.
 */
export function newCspNonce() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function dedupe(values) {
  return [...new Set(values)];
}
