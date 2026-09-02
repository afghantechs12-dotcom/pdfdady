import { describe, expect, it, vi } from "vitest";
import {
  assertConcreteOrigin,
  buildCsp,
  newCspNonce,
  storageOriginsFrom,
  CSP_ENFORCED_HEADER,
  CSP_HEADER,
  CSP_REPORT_ONLY_HEADER,
  CSP_REPORT_GROUP,
  CSP_REPORT_PATH,
  NEXT_CSP_NONCE_SOURCE_REGEX,
  REPORTING_ENDPOINTS_HEADER,
  reportingEndpointFor,
  reportingEndpointsHeader,
} from "./csp.mjs";

/**
 * The policy, and proof that the app actually sends it.
 *
 * Two halves on purpose. The first tests `buildCsp` as a pure function, which is what
 * makes these assertions readable instead of regex-over-source. The second imports
 * `next.config.mjs` and calls its real `headers()` — because a builder can be perfect
 * and still be wired to nothing, and this repo has been bitten by exactly that (see
 * the toolSession/insertionComplete case). The config import is *inside* the tests
 * rather than at module scope so a config that fails to load takes down those tests
 * only, not the whole file's worth of invariants.
 */

/** Splits a policy string into `directive → sources[]`. */
function parse(policy: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of policy.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    out[tokens[0]] = tokens.slice(1);
  }
  return out;
}

/** The CSP header name that is NOT live, whichever stage we are in. */
const DORMANT_CSP_HEADER =
  CSP_HEADER === CSP_ENFORCED_HEADER ? CSP_REPORT_ONLY_HEADER : CSP_ENFORCED_HEADER;

/** The real header value the app serves, from the real config. */
async function servedHeaders(): Promise<Array<{ key: string; value: string }>> {
  const mod = await import("@/next.config.mjs");
  const rules = await mod.default.headers!();
  return rules.flatMap((rule: { headers: Array<{ key: string; value: string }> }) => rule.headers);
}

const PROD = buildCsp();

describe("buildCsp — restrictive baseline", () => {
  it("pins the four directives that have no legitimate loose value here", () => {
    const d = parse(PROD);
    // No <object>/<embed> anywhere in the product; these are legacy plugin vectors.
    expect(d["object-src"]).toEqual(["'none'"]);
    // Stops an injected <base href> from re-pointing every relative script URL.
    expect(d["base-uri"]).toEqual(["'self'"]);
    // The half X-Frame-Options: DENY cannot express, and its converse.
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["frame-src"]).toEqual(["'none'"]);
    // Every form in the app is onSubmit+fetch; none has an `action` attribute.
    expect(d["form-action"]).toEqual(["'self'"]);
  });

  it("declares every directive the brief requires", () => {
    const d = parse(PROD);
    for (const name of [
      "default-src",
      "script-src",
      "style-src",
      "img-src",
      "font-src",
      "connect-src",
      "worker-src",
      "object-src",
      "base-uri",
      "frame-ancestors",
      "form-action",
    ]) {
      expect(Object.keys(d), `missing ${name}`).toContain(name);
    }
  });

  it("contains no wildcard source in any directive", () => {
    // The whole string, so a `*` smuggled into a scheme-source or host-source
    // (`https://*.foo`, `*`) is caught wherever it lands.
    expect(PROD).not.toContain("*");
  });

  it("contains no eval allowance of any kind in production", () => {
    // pdf.js 6 has no `new Function` compiler, and its PostScript→wasm compiler
    // falls back to an interpreter when the compile is refused. Neither of these
    // may be re-added to silence reports.
    expect(PROD).not.toContain("unsafe-eval");
    expect(PROD).not.toContain("wasm-unsafe-eval");
  });

  it("never allows inline script, even though inline style is unavoidable", () => {
    const d = parse(PROD);
    // 152 inline Flight scripts across the walked pages is why the report-only
    // stage existed. The fix is the per-request nonce, never 'unsafe-inline' —
    // and note that a nonce makes browsers IGNORE 'unsafe-inline', so adding it
    // would look harmless while silently un-protecting the policy.
    expect(d["script-src"]).not.toContain("'unsafe-inline'");
    // Style attributes (`style={{}}` → style="") cannot carry a nonce, and their
    // values are computed at runtime so hashes are not available either.
    expect(d["style-src"]).toContain("'unsafe-inline'");
  });
});

describe("buildCsp — allowances only where the code needs them", () => {
  it("permits data: and blob: for images and nowhere else", () => {
    const d = parse(PROD);
    // data:  — editor images (readImageFileAsDataUrl), page rasters
    //          (canvas.toDataURL), PagesPanel thumbnails.
    // blob:  — SignTool's signature preview (URL.createObjectURL).
    expect(d["img-src"]).toEqual(["'self'", "data:", "blob:"]);
    for (const name of ["script-src", "style-src", "font-src", "connect-src", "default-src"]) {
      expect(d[name], `${name} must not allow data:`).not.toContain("data:");
      expect(d[name], `${name} must not allow blob:`).not.toContain("blob:");
    }
  });

  it("keeps worker-src at 'self' — the pdf.js worker is same-origin, not a blob", () => {
    // PDFWorker only wraps the worker in a blob: URL when workerSrc is CROSS-origin.
    // lib/pdf/render.ts resolves it through the bundler to /_next/static/media/,
    // so `blob:` here would be an allowance nothing uses.
    expect(parse(PROD)["worker-src"]).toEqual(["'self'"]);
  });

  it("routes reports to a same-origin path with report-uri, always", () => {
    const d = parse(PROD);
    expect(d["report-uri"]).toEqual([CSP_REPORT_PATH]);
    expect(CSP_REPORT_PATH.startsWith("/")).toBe(true);
  });

  it("adds no report-to unless a caller supplies an endpoint", () => {
    // The default has to be the safe one, because a caller that forgets the argument
    // gets it. Measured with headless Chrome (see scripts/csp-probe.mjs): on an http
    // origin `report-uri` alone delivers in under a second, `report-to` alone
    // delivers nothing (the Reporting API needs a secure context) — and BOTH
    // delivers nothing, because the spec makes `report-to` suppress `report-uri`.
    expect(parse(PROD)["report-to"]).toBeUndefined();
    expect(parse(buildCsp({ reportEndpoint: null }))["report-to"]).toBeUndefined();
  });
});

describe("report-to — adopted on https, and only there", () => {
  it("names the group, and keeps report-uri beside it", () => {
    // Both, because no browser honours both: Chrome takes `report-to` and suppresses
    // `report-uri` per spec; Firefox and Safari have no CSP Reporting API and take
    // `report-uri`. Dropping either goes silent on part of the fleet.
    const d = parse(buildCsp({ reportEndpoint: "https://pdfdadi.test/api/csp-report" }));
    expect(d["report-to"]).toEqual([CSP_REPORT_GROUP]);
    expect(d["report-uri"]).toEqual([CSP_REPORT_PATH]);
  });

  it("skips report-to on every non-https site origin", () => {
    // The mute button. An http origin — dev, this repo's probes, a plain-http staging
    // box — must come back null, or `report-to`'s presence silences the one mechanism
    // that works there. This is the regression that matters most in this file.
    for (const url of ["http://localhost:3000", "http://staging.internal:3000", "http://127.0.0.1:3001"]) {
      expect(reportingEndpointFor(url), url).toBeNull();
      expect(parse(buildCsp({ reportEndpoint: reportingEndpointFor(url) }))["report-to"]).toBeUndefined();
    }
  });

  it("builds an absolute endpoint from the configured origin, dropping any path", () => {
    // Absolute because the Reporting API requires it, and from the CONFIGURED origin
    // rather than the request's Host — which is client-settable, and would let a
    // caller aim this origin's whole report stream at a host we do not own.
    expect(reportingEndpointFor("https://pdfdadi.com")).toBe(`https://pdfdadi.com${CSP_REPORT_PATH}`);
    expect(reportingEndpointFor("https://pdfdadi.com/app?x=1")).toBe(
      `https://pdfdadi.com${CSP_REPORT_PATH}`,
    );
    expect(reportingEndpointFor("https://pdfdadi.com:8443")).toBe(
      `https://pdfdadi.com:8443${CSP_REPORT_PATH}`,
    );
  });

  it("returns null for a missing or unparseable site origin instead of throwing", () => {
    // A build with no site URL still has to produce a policy.
    for (const value of [undefined, "", "   ", "pdfdadi.com", "not a url"]) {
      expect(reportingEndpointFor(value as string | undefined), String(value)).toBeNull();
    }
  });

  it("throws on an https origin that is not concrete", () => {
    // The one loud case: an http origin is a valid configuration, but a wildcard
    // https origin would send real violation reports somewhere unintended.
    expect(() => reportingEndpointFor("https://*.pdfdadi.com")).toThrow(/wildcard/);
  });

  it("pairs the directive and the header through one group name", () => {
    // A `report-to` naming a group no `Reporting-Endpoints` defines reports nowhere,
    // silently — indistinguishable from having no violations. Both sides here.
    const endpoint = reportingEndpointFor("https://pdfdadi.com")!;
    expect(reportingEndpointsHeader(endpoint)).toBe(`${CSP_REPORT_GROUP}="${endpoint}"`);
    const policy = buildCsp({ reportEndpoint: endpoint });
    expect(parse(policy)["report-to"]).toEqual([CSP_REPORT_GROUP]);
    expect(REPORTING_ENDPOINTS_HEADER).toBe("Reporting-Endpoints");
    // The URL travels in the header and ONLY there — the policy carries the group
    // name. Pinned because `buildCsp` takes the endpoint yet reads it only for
    // truthiness, so a future caller must not be able to think a URL passed here
    // reaches the wire. Where the endpoint comes from is settled in proxy.test.ts.
    expect(policy).not.toContain(endpoint);
    expect(policy).not.toContain("pdfdadi.com");
  });
});

describe("buildCsp — storage origins", () => {
  it("adds a configured storage origin to connect-src only", () => {
    const policy = buildCsp({
      storageOrigins: ["https://acct123.r2.cloudflarestorage.com"],
    });
    const d = parse(policy);
    expect(d["connect-src"]).toEqual([
      "'self'",
      "https://acct123.r2.cloudflarestorage.com",
    ]);
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["script-src"]).toEqual(["'self'"]);
  });

  it("normalizes to an origin, dropping any path the operator pasted in", () => {
    const d = parse(buildCsp({ storageOrigins: ["https://cdn.example.com/bucket/x?q=1"] }));
    expect(d["connect-src"]).toEqual(["'self'", "https://cdn.example.com"]);
  });

  it("refuses a wildcard, a non-absolute value, or plain http off localhost", () => {
    // This is the one input to the policy that is not a literal, so it is the one
    // place a `*` could enter. It must fail the build, not widen the policy.
    expect(() => buildCsp({ storageOrigins: ["https://*.r2.example.com"] })).toThrow(/wildcard/);
    expect(() => buildCsp({ storageOrigins: ["*"] })).toThrow(/wildcard/);
    expect(() => buildCsp({ storageOrigins: ["cdn.example.com"] })).toThrow(/absolute URL/);
    expect(() => buildCsp({ storageOrigins: ["http://cdn.example.com"] })).toThrow(/https/);
    expect(() => buildCsp({ storageOrigins: [""] })).toThrow(/empty/);
    // http on localhost is the local-storage dev case and is allowed.
    expect(assertConcreteOrigin("http://localhost:3001/x")).toBe("http://localhost:3001");
  });

  it("does not repeat an origin that is already present", () => {
    const d = parse(
      buildCsp({ storageOrigins: ["https://a.example.com", "https://a.example.com/y"] }),
    );
    expect(d["connect-src"]).toEqual(["'self'", "https://a.example.com"]);
  });
});

describe("storageOriginsFrom — one derivation, two call sites", () => {
  it("derives the R2 account endpoint and keeps a configured public base URL", () => {
    expect(storageOriginsFrom({ accountId: "acct123" })).toEqual([
      "https://acct123.r2.cloudflarestorage.com",
    ]);
    expect(
      storageOriginsFrom({ accountId: "acct123", publicBaseUrl: "https://cdn.example.com" }),
    ).toEqual(["https://acct123.r2.cloudflarestorage.com", "https://cdn.example.com"]);
  });

  it("yields nothing at all when storage is unconfigured", () => {
    // The local-disk deployment. An empty list must not become `[undefined]` or
    // `[""]` — `assertConcreteOrigin` would throw the build on either, so this is
    // the difference between "no storage configured" and "the build fails".
    expect(storageOriginsFrom()).toEqual([]);
    expect(storageOriginsFrom({})).toEqual([]);
    expect(storageOriginsFrom({ accountId: "", publicBaseUrl: "" })).toEqual([]);
    expect(buildCsp({ storageOrigins: storageOriginsFrom() })).toBe(PROD);
  });
});

describe("buildCsp — the nonce shape", () => {
  const nonce = "dGVzdC1ub25jZS12YWx1ZQ==";
  const withNonce = buildCsp({ nonce });

  it("switches script-src to the enforcement shape when a nonce is supplied", () => {
    const d = parse(withNonce);
    expect(d["script-src"]).toEqual([`'nonce-${nonce}'`, "'strict-dynamic'"]);
    // 'strict-dynamic' makes browsers IGNORE 'self' for scripts, so leaving it in
    // would be misleading rather than harmless.
    expect(d["script-src"]).not.toContain("'self'");
    expect(d["script-src"]).not.toContain("'unsafe-inline'");
  });

  it("emits a script-src nonce Next's own parser can extract", () => {
    // next/dist/server/app-render/get-script-nonce-from-header.js finds the
    // script-src directive and matches each source against this regex. A nonce it
    // rejects yields a page whose inline scripts are unnonced — under enforcement,
    // a blank screen.
    const scriptSrc = parse(withNonce)["script-src"];
    const matched = scriptSrc
      .map((source) => source.match(NEXT_CSP_NONCE_SOURCE_REGEX)?.[1])
      .find(Boolean);
    expect(matched).toBe(nonce);
  });

  it("mints nonces that satisfy that same parser", () => {
    for (let i = 0; i < 20; i++) {
      const value = newCspNonce();
      expect(`'nonce-${value}'`).toMatch(NEXT_CSP_NONCE_SOURCE_REGEX);
    }
    expect(newCspNonce()).not.toBe(newCspNonce());
  });

  it("changes nothing but script-src when a nonce is added", () => {
    const withoutScript = (policy: string) => {
      const d = parse(policy);
      delete d["script-src"];
      return d;
    };
    expect(withoutScript(withNonce)).toEqual(withoutScript(PROD));
  });
});

describe("buildCsp — development is looser, never stricter", () => {
  const DEV = buildCsp({ dev: true });

  it("keeps every production source in the dev policy", () => {
    // The failure this guards: a dev-only branch that *replaces* a source list
    // instead of extending it, so the dev console reports violations production
    // would not — or worse, hides ones production would.
    const prod = parse(PROD);
    const dev = parse(DEV);
    expect(Object.keys(dev).sort()).toEqual(Object.keys(prod).sort());
    for (const [name, sources] of Object.entries(prod)) {
      for (const source of sources) {
        expect(dev[name], `dev ${name} dropped ${source}`).toContain(source);
      }
    }
  });

  it("adds only the Turbopack HMR allowances, and only in dev", () => {
    const dev = parse(DEV);
    expect(dev["script-src"]).toEqual(["'self'", "'unsafe-eval'", "'unsafe-inline'"]);
    expect(dev["connect-src"]).toEqual(["'self'", "ws:", "wss:"]);
    // The same relaxations must be absent from production, or the dev branch is
    // decorative and the eval assertion above is meaningless.
    expect(parse(PROD)["script-src"]).toEqual(["'self'"]);
    expect(parse(PROD)["connect-src"]).toEqual(["'self'"]);
  });
});

describe("next.config.mjs actually serves the policy", () => {
  it("emits the live CSP header for every route", async () => {
    const headers = await servedHeaders();
    const csp = headers.find((h) => h.key === CSP_HEADER);
    expect(csp, `${CSP_HEADER} is not emitted`).toBeDefined();
    const d = parse(csp!.value);
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'self'"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["form-action"]).toEqual(["'self'"]);
    expect(d["worker-src"]).toEqual(["'self'"]);
    expect(d["img-src"]).toEqual(["'self'", "data:", "blob:"]);
    expect(d["report-uri"]).toEqual([CSP_REPORT_PATH]);
    expect(csp!.value).not.toContain("*");
  });

  it("emits exactly ONE CSP header, and never both names at once", async () => {
    // The failure this guards is the two-switch one: `proxy.ts` and this config both
    // emit a policy, and if they disagree on the NAME a response ships an enforced
    // policy alongside a report-only one — the same violation reported twice, from a
    // policy nobody can read off the wire with confidence. One constant decides for
    // both, and this asserts the other name is genuinely gone rather than merely
    // unused. Stage-agnostic on purpose: it holds before and after the flip.
    const keys = (await servedHeaders()).map((h) => h.key);
    expect(keys.filter((k) => k.startsWith("Content-Security-Policy"))).toEqual([CSP_HEADER]);
    expect(keys).not.toContain(DORMANT_CSP_HEADER);
  });

  it("names a header the browser will actually act on", async () => {
    // A typo here is silent: an unknown header name is ignored, so the app looks
    // perfect and is unprotected. These are the only two spellings that exist.
    expect([CSP_ENFORCED_HEADER, CSP_REPORT_ONLY_HEADER]).toContain(CSP_HEADER);
    expect(CSP_ENFORCED_HEADER).toBe("Content-Security-Policy");
    expect(CSP_REPORT_ONLY_HEADER).toBe("Content-Security-Policy-Report-Only");
  });

  it("sends neither report-to nor Reporting-Endpoints on an http site origin", async () => {
    // The test environment's NEXT_PUBLIC_SITE_URL is http, which is the configuration
    // dev and every probe run in. On http `report-to`'s presence would suppress
    // `report-uri` and mute the only mechanism that works, so both must be absent —
    // and absent TOGETHER: the header without the directive is dead weight, the
    // directive without the header reports into a group nothing defines.
    const headers = await servedHeaders();
    expect(headers.map((h) => h.key)).not.toContain(REPORTING_ENDPOINTS_HEADER);
    const csp = headers.find((h) => h.key === CSP_HEADER);
    expect(csp?.value).toContain(`report-uri ${CSP_REPORT_PATH}`);
    expect(csp?.value).not.toContain("report-to");
  });

  it("sends both on an https site origin, pointing at this origin's own sink", async () => {
    // The static-asset policy needs this as much as a document does: a Web Worker
    // inherits the CSP of its own response, and pdf.js's worker is served from
    // /_next/static/media — a path proxy.ts deliberately never sees. Left on
    // `report-uri` alone, worker violations go silent the day browsers drop it.
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://pdfdadi.example");
    vi.resetModules();
    try {
      const headers = await servedHeaders();
      const csp = headers.find((h) => h.key === CSP_HEADER);
      expect(parse(csp!.value)["report-to"]).toEqual([CSP_REPORT_GROUP]);
      // Still there, for the browsers with no Reporting API at all.
      expect(parse(csp!.value)["report-uri"]).toEqual([CSP_REPORT_PATH]);
      const endpoints = headers.find((h) => h.key === REPORTING_ENDPOINTS_HEADER);
      expect(endpoints, "the group is named but never defined").toBeDefined();
      expect(endpoints!.value).toBe(
        `${CSP_REPORT_GROUP}="https://pdfdadi.example${CSP_REPORT_PATH}"`,
      );
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("ships no eval allowance when NODE_ENV is production", async () => {
    // The dev relaxation is gated on NODE_ENV in next.config.mjs. Nothing else
    // checks that gate, and inverting it would put 'unsafe-eval' in production —
    // the exact outcome the pure test above cannot see, because vitest runs with
    // NODE_ENV=test and therefore always takes the dev branch.
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    try {
      const headers = await servedHeaders();
      const csp = headers.find((h) => h.key === CSP_HEADER);
      expect(csp!.value).not.toContain("unsafe-eval");
      expect(csp!.value).not.toContain("ws:");
      expect(parse(csp!.value)["script-src"]).toEqual(["'self'"]);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("still covers the paths proxy.ts deliberately skips", async () => {
    // This config is no longer the app's main CSP source — `proxy.ts` overwrites it on
    // every path it matches. What is left is the reason it must not be deleted:
    // `/_next/static/*` is excluded from the proxy (immutable output cannot consume a
    // per-request nonce), and a Web Worker inherits the CSP of ITS OWN response — so
    // the pdf.js worker at /_next/static/media/*.mjs runs under exactly this policy.
    const rules = await (async () => {
      const mod = await import("@/next.config.mjs");
      return mod.default.headers!();
    })();
    expect(rules.map((r: { source: string }) => r.source)).toEqual(["/:path*"]);
    const csp = (await servedHeaders()).find((h) => h.key === CSP_HEADER)!;
    // Nonce-less on purpose: nothing here renders, so there is nothing to stamp. And
    // `script-src 'self'` is exactly right for a directory of same-origin scripts.
    expect(csp.value).not.toContain("nonce-");
    expect(parse(csp.value)["worker-src"]).toEqual(["'self'"]);
  });

  it("keeps the pre-existing security headers", async () => {
    // Adding CSP must not displace what was already there.
    const keys = (await servedHeaders()).map((h) => h.key);
    for (const key of [
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Referrer-Policy",
      "Permissions-Policy",
      "Cross-Origin-Opener-Policy",
    ]) {
      expect(keys, `lost ${key}`).toContain(key);
    }
  });
});
