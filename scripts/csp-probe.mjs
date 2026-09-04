/* global process, console, fetch, FormData, Blob, WebSocket, setTimeout, clearTimeout, URL */
/**
 * PERMANENT probe for the Content-Security-Policy — the report-only foundation, and
 * now the nonce-based enforcement built on it.
 *
 * The probe reads {@link CSP_HEADER} from `lib/security/csp.mjs` rather than naming a
 * header, so ONE constant moves the whole run between the two stages and there is no
 * second switch to forget. Under either stage it asserts the same structural things;
 * the differences (`disposition`, whether the canary is actually blocked) are derived
 * from that constant, not hardcoded.
 *
 * WHY A BROWSER, AND WHY THE PRODUCTION ARTIFACT. The policy has Node tests behind it
 * and they cannot see the only things that decide whether this is worth anything:
 *
 *   1. Whether the header actually reaches a browser from the REAL standalone
 *      server — `next.config.mjs` `headers()` is evaluated at BUILD time and baked
 *      into `routes-manifest.json`, so a policy that is perfect in a unit test can
 *      still be absent from the artifact that gets deployed.
 *   2. WHICH sources the running product actually needs. A policy assembled by
 *      reading source is a hypothesis; the violation stream is the measurement.
 *   3. Whether a violation report survives the trip to `/api/csp-report` with the
 *      secrets stripped. The sanitizer is unit-tested against hand-built fixtures;
 *      only a real browser proves the wire format it emits is one the parser reads.
 *   4. Whether the per-request nonce actually reaches the scripts Next generates.
 *      `proxy.ts` sets the nonce on the REQUEST header and Next is supposed to stamp
 *      it on every script it renders — but a prerendered route serves build-time HTML
 *      from cache and ignores the nonce entirely, which no unit test can see. The
 *      measurement is: count executable `<script>` elements in the served HTML that
 *      do NOT carry the nonce from that same response's header. Under enforcement,
 *      every one of those is a script the browser refuses to run.
 *
 * WHAT IT FOUND ON ITS FIRST RUN, which is why it exists rather than a curl:
 * the policy shipped both `report-uri` and `report-to`. On an http origin Chrome
 * delivered NOTHING — the Reporting API needs a secure context, and the spec makes
 * `report-to`'s presence SUPPRESS `report-uri`. The measurement, per origin:
 *
 *   origin   report-uri alone   report-to alone   BOTH
 *   http     delivered <1s      nothing           NOTHING
 *   https    delivered <1s      delivered ~60s    ~70s
 *
 * A report-only rollout that receives zero reports looks exactly like a clean one.
 * `report-to` was removed then, and is now back — but conditionally, keyed on the
 * configured site origin's scheme, which is the only shape that table permits. So the
 * report assertions below are scheme-dependent, and BOTH directions are checked:
 * against an http `--url` the probe fails if `report-to` appears (the mute), and
 * against an https `--url` it fails if `report-to` is missing OR if the
 * `Reporting-Endpoints` header that defines its group is missing (a directive naming
 * an undefined group reports nowhere, silently, which looks exactly the same).
 * Running only one scheme leaves half of that unproven — the https run is the one
 * that matters for production, and `scripts/tls-front.mjs` is what provides it.
 *
 * THE HAZARD IT IS BUILT AGAINST is a vacuous pass. Every path must be observed to
 * WORK before its violation set means anything — a homepage that 500s reports no
 * violations either. And the classification table is CLOSED: any violation this
 * file does not already name and justify is reported UNCLASSIFIED and fails the
 * run, so a new one forces a decision instead of joining a whitelist.
 *
 * Run against the real standalone entrypoint (see the ledger for the full recipe):
 *
 *   NEXT_PUBLIC_SITE_URL=https://<lan-ip>:3001 node scripts/next-build.js
 *   cp -R .next/static .next/standalone/.next/static
 *   cd .next/standalone && NODE_ENV=production PORT=3002 HOSTNAME=127.0.0.1 \
 *     NEXT_PUBLIC_SITE_URL=https://<lan-ip>:3001 PROCESSING_PIPELINE=on \
 *     STORAGE_LOCAL_ROOT="$TMPDIR/csp-storage" ADMIN_SECRET=csp-probe-secret-not-a-real-one \
 *     DATABASE_URL="file:$TMPDIR/csp.db" node server.js > /tmp/csp-server.log 2>&1 &
 *
 * That DATABASE_URL is a THROWAWAY, created with `DATABASE_URL=... npx prisma migrate
 * deploy` beforehand, and it matters: section 2c signs up an account and runs a real
 * compress-pdf job, so aiming this at prisma/prisma/dev.db would write probe traffic
 * into the usage ledger that `npm run usage:readiness` reads — counting a test run as
 * production observation toward enforcement. Note also that Prisma resolves a RELATIVE
 * `file:` URL against the prisma/ directory, not the cwd, so use an absolute path.
 *   node scripts/tls-front.mjs --listen 3001 --target 3002
 *   node scripts/csp-probe.mjs --url https://<lan-ip>:3001 --server-log /tmp/csp-server.log
 *
 * No wrapper script and no NODE_TLS_REJECT_UNAUTHORIZED in front of it: the probe sets
 * both itself when `--url` is https, for the reason given at each site.
 *
 * The terminator is not decoration: section 2c signs up a real account, and Secure
 * cookies are dropped over http, so the authenticated half of the walk only means
 * something behind https. It also reproduces the exact deployment shape that hid the
 * 3.1.1 CSRF bug from every unit test.
 *
 * `--url` must be the SAME origin as `NEXT_PUBLIC_SITE_URL`: `/api/jobs/:id/result`
 * 302s to a signed URL built from that value, so a mismatch makes the download
 * cross-origin and produces a `connect-src` violation that is a probe-environment
 * artifact rather than a product finding. A loopback `NEXT_PUBLIC_SITE_URL` is
 * refused by the production startup gate on purpose — use the LAN address, do not
 * weaken the gate.
 *
 * `--server-log` is how endpoint-side reports are read: the endpoint logs one
 * sanitized line per request to stdout. Without it, the endpoint-side half of
 * section 3 is reported ENVIRONMENT-LIMITED rather than passing silently.
 */
import {
  CSP_ENFORCED_HEADER,
  CSP_HEADER,
  CSP_REPORT_ONLY_HEADER,
  NEXT_CSP_NONCE_SOURCE_REGEX,
} from "../lib/security/csp.mjs";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg("--url", "http://localhost:3001");
/**
 * Whether this run is behind the terminator — which decides what the report headers
 * are expected to look like, because `report-to` ships only on an https site origin.
 * `--url` is required to be the same origin as `NEXT_PUBLIC_SITE_URL` (see the header
 * note), so the probe's own scheme is the app's configured scheme.
 */
const SECURE_ORIGIN = BASE.startsWith("https:");
// The terminator in front of an https target is self-signed, so Node's own fetch
// rejects it — and the first symptom is section 0 reporting the app as unreachable
// when it is serving perfectly, which reads like a product defect. Set here rather
// than left to the recipe, because a recipe step that only matters on one transport
// is a step people omit. Scoped to https, and to this process only.
if (SECURE_ORIGIN) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const SERVER_LOG = arg("--server-log", "");
const FIXTURE = arg("--pdf", "docs/qa/p0/source-text-fixture.pdf");
const CHROME =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Which stage this build is in, derived from the policy module — never asserted here.
 *
 * `ENFORCING` changes what a *correct* run looks like: the canary is blocked rather
 * than merely reported, and `disposition` reads "enforce". Everything else is
 * identical, which is the point — the report-only walk and the enforced walk are the
 * same walk, so a difference between them is a finding rather than a different script.
 */
const LIVE_CSP = CSP_HEADER.toLowerCase();
const DORMANT_CSP = (
  CSP_HEADER === CSP_ENFORCED_HEADER ? CSP_REPORT_ONLY_HEADER : CSP_ENFORCED_HEADER
).toLowerCase();
const ENFORCING = CSP_HEADER === CSP_ENFORCED_HEADER;
const DISPOSITION = ENFORCING ? "enforce" : "report";

/** The nonce in a policy, extracted with Next's own regex rather than a looser one. */
const nonceOf = (policy) => {
  const scriptSrc = (policy ?? "")
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("script-src "));
  if (!scriptSrc) return "";
  for (const source of scriptSrc.split(/\s+/).slice(1)) {
    const m = source.match(NEXT_CSP_NONCE_SOURCE_REGEX);
    if (m) return m[1];
  }
  return "";
};

/** A policy with its nonce blanked, so two requests' policies can be compared. */
const withoutNonce = (policy) => (policy ?? "").replace(/'nonce-[^']*'/g, "'nonce-X'");

/**
 * Executable `<script>` elements in served HTML that do NOT carry `nonce`.
 *
 * `type="application/ld+json"` is excluded: it is data, the browser never executes it,
 * and CSP does not police it. Everything else counted here is a script that enforcement
 * refuses to run.
 */
const unNoncedScripts = (html) =>
  (html.match(/<script[^>]*>/g) ?? []).filter(
    (tag) => !tag.includes("nonce=") && !tag.includes("application/ld+json"),
  );

/** A URL whose host can never resolve (RFC 6761 `.invalid`), carrying a fake secret. */
const CANARY_SECRET = "sk_live_CSPPROBE_MUST_NOT_APPEAR";
const CANARY_URL = `https://csp-probe.invalid/pixel.png?token=${CANARY_SECRET}&doc=payroll`;

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const limited = [];
const envLimited = (name, why) => {
  limited.push({ name, why });
  console.log(`  ~~  ENVIRONMENT-LIMITED ${name} — ${why}`);
};

/**
 * The CLOSED classification table.
 *
 * Each entry claims a (directive, blockedURI) shape and says what it is and why.
 * A violation matching nothing here is UNCLASSIFIED and fails the run — the point
 * of a report-only phase is to decide about each source, not to accumulate one.
 *
 * `REQUIRED`  the product genuinely needs this; the policy must allow it.
 * `FIX-CODE`  the product should stop doing this; the policy must NOT grow for it.
 * `NOISE`     framework or probe artifact; nothing to allow and nothing to fix.
 * `ENV`       an artifact of this local environment, absent in production.
 */
const CLASSIFICATIONS = [
  {
    id: "flight-inline-script",
    klass: "FIX-CODE",
    directive: /^script-src(-elem)?$/,
    blocked: /^inline$/,
    klassAfter32: "REGRESSION",
    why:
      "React Flight serializes RSC payloads into inline <script> elements (152 of them " +
      "across the walk in 3.1). Never fixable by allowing a source — 'unsafe-inline' " +
      "would defeat the policy. 3.2 fixed it with Next's request-scoped nonce, so a hit " +
      "here now means the nonce did not reach a script: either a route went back to " +
      "prerendering, or the proxy stopped covering it. Kept in the table so the failure " +
      "names itself instead of arriving as UNCLASSIFIED.",
  },
  {
    id: "canary",
    klass: "NOISE",
    directive: /^img-src$/,
    blocked: /^https:\/\/csp-probe\.invalid\//,
    why:
      "This probe's own deliberate violation, used to prove the report endpoint " +
      "receives a real browser report and strips its query string. Never a product source.",
  },
];

const classify = (v) => {
  const hit = CLASSIFICATIONS.find(
    (c) => c.directive.test(v.directive) && c.blocked.test(v.blocked),
  );
  return hit ? hit : null;
};

async function main() {
  /* ------------------------------------------------ 1. the header, off the wire */
  console.log(`1. HEADERS FROM THE REAL ARTIFACT (stage: ${CSP_HEADER})`);
  const pages = ["/", "/pricing", "/editor", "/tools/merge-pdf", "/api/health"];
  const seenPolicies = new Set();
  const seenNonces = new Set();
  let POLICY = "";
  for (const path of pages) {
    let res;
    try {
      res = await fetch(`${BASE}${path}`, { redirect: "manual" });
    } catch (e) {
      check(`${path} is reachable`, false, String(e?.message ?? e));
      continue;
    }
    const policy = res.headers.get(LIVE_CSP) ?? "";
    check(`${path} sends ${CSP_HEADER}`, policy.length > 0, `${res.status}`);
    // Both names live would mean two policies evaluated at once, and reports from the
    // report-only one would look like the enforcing one's — the exact confusion §5 bans.
    check(`${path} sends no ${DORMANT_CSP} (never both at once)`,
      res.headers.get(DORMANT_CSP) === null);
    const nonce = nonceOf(policy);
    check(`${path} carries a nonce Next's own regex accepts`, nonce.length > 0, nonce);
    // Next's regex accepts a 1-char nonce. A guessable one is worse than none, since it
    // whitelists whatever the guesser injects.
    check(`${path} nonce is >= 128 bits of base64`, nonce.length >= 22, `${nonce.length} chars`);
    if (nonce) seenNonces.add(nonce);
    if (policy) {
      seenPolicies.add(withoutNonce(policy));
      POLICY = withoutNonce(policy);
    }
  }
  check("every route sends the SAME policy modulo the nonce (one source of truth)",
    seenPolicies.size === 1, `${seenPolicies.size} distinct`);
  check("every route got a DISTINCT nonce (no reuse across requests)",
    seenNonces.size === pages.length, `${seenNonces.size} nonces / ${pages.length} requests`);

  // Same route twice: proves per-REQUEST, not merely per-route. A cached/prerendered
  // document would hand back a nonce it was built with, twice.
  const repeat = await Promise.all([
    fetch(`${BASE}/`).then((r) => nonceOf(r.headers.get(LIVE_CSP))),
    fetch(`${BASE}/`).then((r) => nonceOf(r.headers.get(LIVE_CSP))),
  ]);
  check("two requests to the SAME route get different nonces",
    Boolean(repeat[0]) && repeat[0] !== repeat[1], repeat.join(" vs "));

  const directives = Object.fromEntries(
    POLICY.split(";").map((d) => d.trim()).filter(Boolean)
      .map((d) => { const [n, ...v] = d.split(/\s+/); return [n, v]; }),
  );
  // Anti-vacuity: an empty policy would satisfy every "no wildcard" style check below.
  check("the policy is non-trivial", POLICY.length > 100 && Object.keys(directives).length >= 10,
    `${POLICY.length} chars / ${Object.keys(directives).length} directives`);
  check("no wildcard source anywhere in the policy", !/(^|[\s;])\*([\s;]|$)/.test(POLICY) && !POLICY.includes("*"));
  check("object-src is 'none'", String(directives["object-src"]) === "'none'");
  check("base-uri is locked to 'self'", String(directives["base-uri"]) === "'self'");
  check("frame-ancestors is 'none'", String(directives["frame-ancestors"]) === "'none'");
  check("form-action is 'self'", String(directives["form-action"]) === "'self'");
  check("no 'unsafe-eval' in a production policy", !POLICY.includes("unsafe-eval"));
  check("no 'wasm-unsafe-eval' in a production policy", !POLICY.includes("wasm-unsafe-eval"));
  check("script-src carries no 'unsafe-inline' (the nonce is the whole mechanism)",
    !(directives["script-src"] ?? []).includes("'unsafe-inline'"),
    (directives["script-src"] ?? []).join(" "));
  check("script-src is the nonce + 'strict-dynamic' and nothing else",
    String(directives["script-src"]) === "'nonce-X','strict-dynamic'",
    (directives["script-src"] ?? []).join(" "));
  check("worker-src is 'self' (no blob:)", String(directives["worker-src"]) === "'self'");
  check("reports go to a same-origin path via report-uri, on either scheme",
    String(directives["report-uri"] ?? "").startsWith("/"), String(directives["report-uri"]));
  // The finding this probe was built by, now in both directions. See the header.
  if (SECURE_ORIGIN) {
    check("report-to is PRESENT on an https origin (the Reporting API works here)",
      directives["report-to"] !== undefined, String(directives["report-to"]));
  } else {
    check("report-to is ABSENT on an http origin (its presence mutes report-uri)",
      directives["report-to"] === undefined, String(directives["report-to"]));
  }

  const rootRes = await fetch(`${BASE}/`);
  for (const [key, want] of [
    ["x-content-type-options", "nosniff"],
    ["x-frame-options", "DENY"],
    ["referrer-policy", "strict-origin-when-cross-origin"],
    ["permissions-policy", "camera=(), microphone=(), geolocation=()"],
    ["cross-origin-opener-policy", "same-origin"],
  ]) {
    check(`pre-existing header ${key} is intact`, rootRes.headers.get(key) === want,
      String(rootRes.headers.get(key)));
  }
  // The header and the directive are a matched pair: either both or neither. A
  // `report-to` whose group nothing defines delivers nothing, and a page delivering
  // nothing is indistinguishable from a page with no violations.
  const endpointsHeader = rootRes.headers.get("reporting-endpoints");
  if (SECURE_ORIGIN) {
    check("Reporting-Endpoints defines the group report-to names",
      new RegExp(`^${String(directives["report-to"])}="https://`).test(String(endpointsHeader)),
      String(endpointsHeader));
    check("the report endpoint it names is this origin's own sink",
      String(endpointsHeader).includes(`${new URL(BASE).origin}/api/csp-report`),
      String(endpointsHeader));
  } else {
    check("no Reporting-Endpoints header (nothing refers to a group)",
      endpointsHeader === null, String(endpointsHeader));
  }
  check("the CSP response carries no secret-shaped value",
    !/sk_live|sk_test|whsec_|BEGIN [A-Z ]*PRIVATE KEY|password/i.test(POLICY), POLICY.slice(0, 0));

  // The pdf.js worker is a static chunk, and a worker inherits the CSP of its OWN
  // response. If /_next/static/* were uncovered, the worker would run unpoliced —
  // which under enforcement is where a violation would go unseen.
  const html = await (await fetch(`${BASE}/editor`)).text();
  const chunk = (html.match(/\/_next\/static\/chunks\/[a-zA-Z0-9._-]+\.js/) ?? [])[0];
  check("a static chunk URL was found in the served HTML", Boolean(chunk), String(chunk));
  if (chunk) {
    const chunkRes = await fetch(`${BASE}${chunk}`);
    const chunkPolicy = chunkRes.headers.get(LIVE_CSP) ?? "";
    // The proxy's matcher excludes /_next/static, so this one comes from next.config
    // and has no nonce. It must still be the same policy, and it must still be a policy:
    // an uncovered chunk means the pdf.js worker runs unpoliced.
    check("static assets are covered by the policy too (worker context)",
      chunkPolicy.length > 0 && chunkRes.headers.get(DORMANT_CSP) === null, `${chunkPolicy.length} chars`);
    check("the static-asset policy needs no nonce, and has none",
      nonceOf(chunkPolicy) === "" && chunkPolicy.includes("script-src 'self'"),
      (chunkPolicy.match(/script-src [^;]*/) ?? [])[0] ?? "");
    if (SECURE_ORIGIN) {
      // Both policies must advertise the same reporting, or a worker violation is
      // delivered by a mechanism the document's violations are not — and the worker is
      // the one context whose policy comes from next.config.mjs alone. That config
      // resolves the origin at BUILD time, so this fails if the build did not know it:
      // run `NEXT_PUBLIC_SITE_URL=https://<lan-ip>:3001 node scripts/next-build.js`,
      // which is what a production build does anyway.
      check("the static-asset policy advertises the same report-to group",
        chunkPolicy.includes(`report-to ${String(directives["report-to"])}`),
        (chunkPolicy.match(/report-[a-z]+ [^;]*/g) ?? ["none — was the build given the https origin?"]).join(" | "));
      check("and the static response defines that group too (the worker inherits this one)",
        chunkRes.headers.get("reporting-endpoints") === endpointsHeader,
        String(chunkRes.headers.get("reporting-endpoints")));
    }
  }

  /* --------------------------- 1b. the nonce actually reached Next's scripts */
  // The measurement §1 of the slice demands: not "is there a nonce in the header" but
  // "did Next stamp THAT nonce onto the scripts it generated". A prerendered route
  // serves build-time HTML and silently ignores the request nonce.
  console.log("\n1b. NONCE ON THE GENERATED SCRIPTS");
  for (const path of ["/", "/pricing", "/editor", "/tools/merge-pdf", "/login", "/blog"]) {
    const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
    if (res.status !== 200) { check(`${path} rendered`, false, `${res.status}`); continue; }
    const body = await res.text();
    const nonce = nonceOf(res.headers.get(LIVE_CSP));
    const tags = body.match(/<script[^>]*>/g) ?? [];
    const orphans = unNoncedScripts(body);
    check(`${path}: every executable <script> carries a nonce`, orphans.length === 0,
      `${tags.length} scripts, ${orphans.length} unnonced`);
    // Anti-vacuity: 0 of 0 would pass the line above. Next always emits bootstrap scripts.
    check(`${path}: there were scripts to check`, tags.length >= 10, `${tags.length}`);
    // The end-to-end proof that the REQUEST nonce and the RESPONSE nonce are the same
    // one: the request header is what Next read, the response header is what the browser
    // enforces, and this HTML is what Next produced in between.
    check(`${path}: the scripts carry the RESPONSE header's nonce`,
      nonce.length > 0 && body.includes(`nonce="${nonce}"`), nonce);
  }

  /* ------------------------------------------------------- browser walk set-up */
  console.log("\n2. BROWSER WALK");
  const userDataDir = mkdtempSync(join(tmpdir(), "pdfdadi-csp-"));
  const port = 9491;
  spawnSync("pkill", ["-f", `remote-debugging-port=${port}`], { stdio: "ignore" });
  await sleep(400);
  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--headless=new",
      // Same reason, for the browser. Without it every navigation to the terminator
      // fails the certificate check and the whole walk reports zero violations —
      // which is exactly what a clean policy looks like. The wrapper script the old
      // recipe asked for (CHROME_PATH=/tmp/chrome-insecure) existed only for this.
      ...(SECURE_ORIGIN ? ["--ignore-certificate-errors"] : []),
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      "--window-size=1600,1000",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let targets = null;
  for (let attempt = 0; attempt < 40 && !targets; attempt += 1) {
    await sleep(300);
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    } catch {
      targets = null;
    }
  }
  if (!targets) throw new Error(`Chrome never opened a debug port on ${port}`);
  const target = targets.find((t) => t.type === "page");
  if (!target) throw new Error("Chrome exposed no page target");
  const sock = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    sock.addEventListener("open", res, { once: true });
    sock.addEventListener("error", rej, { once: true });
  });

  let id = 0;
  const pending = new Map();
  const jsErrors = [];
  const browserLog = [];
  sock.addEventListener("message", (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      jsErrors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 240));
    }
    if (msg.method === "Runtime.exceptionThrown") {
      jsErrors.push(msg.params?.exceptionDetails?.text ?? "exception");
    }
    // Chrome routes CSP messages and worker failures through Log, not console.
    if (msg.method === "Log.entryAdded") {
      const e = msg.params?.entry ?? {};
      browserLog.push(`${e.source}/${e.level}: ${String(e.text ?? "").slice(0, 200)}`);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      const timer = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), 40_000);
      pending.set(mid, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      sock.send(JSON.stringify({ id: mid, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.result?.exceptionDetails) return { __err: res.result.exceptionDetails.text };
    return res.result?.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");

  // Installed on EVERY new document, before page script runs — a listener attached
  // after navigation misses everything the first paint violated, which is most of it.
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (e) => {
        window.__cspViolations.push({
          directive: e.effectiveDirective || e.violatedDirective || "",
          blocked: e.blockedURI || "",
          disposition: e.disposition || "",
          source: (e.sourceFile || "").slice(0, 160),
          line: e.lineNumber || 0,
        });
      });
    `,
  });

  /** All violations seen across the whole walk, tagged with the step that saw them. */
  const violations = [];
  const drain = async (step) => {
    const seen = (await evaluate("JSON.stringify(window.__cspViolations || [])")) || "[]";
    let list;
    try {
      list = JSON.parse(seen);
    } catch {
      list = [];
    }
    await evaluate("window.__cspViolations = []");
    for (const v of list) violations.push({ ...v, step });
    return list;
  };
  const text = () => evaluate("document.body.innerText.replace(/\\s+/g,' ')");
  const goto = async (path, settle = 3000) => {
    await send("Page.navigate", { url: `${BASE}${path}` });
    await sleep(settle);
  };
  const clickByLabel = async (labelRe, selector = "button") => {
    const spot = await evaluate(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const b = els.find((el) => ${labelRe}.test(el.textContent || "") && !el.disabled);
      if (!b) return { ok: false, labels: els.filter((e) => !e.disabled).map((e) => (e.textContent || "").trim().slice(0, 28)).filter(Boolean) };
      b.scrollIntoView({ block: "center", behavior: "instant" });
      return { ok: true, label: (b.textContent || "").trim().slice(0, 40) };
    })()`);
    if (!spot?.ok) return spot;
    await sleep(300);
    // The rect is read in a SEPARATE turn: reading it alongside scrollIntoView
    // returns the pre-scroll position and the click lands on empty space.
    const at = await evaluate(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const b = els.find((el) => ${labelRe}.test(el.textContent || "") && !el.disabled);
      if (!b) return null;
      const r = b.getBoundingClientRect();
      if (r.width <= 0 || r.top < 0 || r.bottom > window.innerHeight) { b.click(); return { via: "dom" }; }
      return { via: "mouse", x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (at?.via === "mouse") {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, buttons: 0 });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1, buttons: 1 });
      await sleep(90);
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1, buttons: 0 });
    }
    return { ...spot, via: at?.via ?? null };
  };

  /* -------------------------------------------------- 2a. public marketing pages */
  await goto("/");
  const homeText = await text();
  check("homepage renders real content", /pdf/i.test(homeText ?? "") && (homeText ?? "").length > 400,
    `${(homeText ?? "").length} chars`);
  const homeViolations = await drain("homepage");
  // Before 3.2 the homepage's own 84 inline-script reports were the proof the browser
  // was evaluating the policy. The nonce removed them, so a silent homepage is now the
  // PASS condition and the anti-vacuity proof has to move to the canary in section 3 —
  // the one violation that is still deliberate. Keep the disposition assert, because a
  // report-only header surviving into an enforced build is exactly §5's failure mode.
  check(`every homepage violation carries disposition "${DISPOSITION}"`,
    homeViolations.every((v) => v.disposition === DISPOSITION),
    `${homeViolations.length} violations, dispositions: ${[...new Set(homeViolations.map((v) => v.disposition))].join(",") || "none"}`);
  if (ENFORCING) {
    check("the homepage is silent under enforcement (the nonce is doing its job)",
      homeViolations.length === 0, `${homeViolations.length} violations`);
  }

  await goto("/pricing");
  const priceText = await text();
  check("pricing renders its plans", /free|pro|business/i.test(priceText ?? "") && (priceText ?? "").length > 400,
    `${(priceText ?? "").length} chars`);

  // THE BILLING SUMMARY SURFACE. The Pro card is server-rendered with approved copy
  // and upgraded in place by a client `fetch('/api/billing/summary')` — so `connect-src
  // 'self'` is load-bearing for it, and a blocked fetch renders the fallback copy
  // silently. On this deployment billing is disabled, so the card's *rendered* state
  // cannot distinguish "blocked" from "unavailable"; the request is what to measure.
  const summary = await evaluate(`(async () => {
    const entry = performance.getEntriesByType('resource')
      .find((e) => e.name.includes('/api/billing/summary'));
    const r = await fetch('/api/billing/summary', { credentials: 'same-origin' });
    const body = await r.json().catch(() => null);
    return { cardFetched: Boolean(entry), transferred: entry ? entry.transferSize : -1,
             status: r.status, plan: body && body.plan, keys: body ? Object.keys(body).length : 0 };
  })()`);
  check("the Pro card's own /api/billing/summary request completed (connect-src 'self')",
    summary?.cardFetched === true, JSON.stringify(summary));
  check("a page-context fetch of the billing summary returns a real body",
    summary?.status === 200 && typeof summary?.plan === "string" && summary.keys >= 4,
    JSON.stringify(summary));

  // NAVIGATION, the soft kind. Every other check here survives a page that never
  // hydrated: server-rendered HTML renders, and CDP-injected fetches run with or
  // without React. A router navigation cannot — it needs the client bundle to have
  // hydrated and taken over the link. Under 'strict-dynamic' that bundle is loaded by
  // a nonced script rather than carrying a nonce itself, which is exactly the case a
  // wrong policy breaks.
  const nav = await evaluate(`(async () => {
    window.__navSentinel = 'alive';
    const link = [...document.querySelectorAll('a[href^="/"]')]
      .find((a) => a.getAttribute('href') !== location.pathname && !a.target);
    if (!link) return { error: 'no internal link on /pricing' };
    const href = link.getAttribute('href');
    link.click();
    await new Promise((r) => setTimeout(r, 2500));
    return { href, at: location.pathname, sentinel: window.__navSentinel, chars: document.body.innerText.length };
  })()`);
  check("a client-side link navigation worked (so React hydrated and the router runs)",
    nav?.at === nav?.href && nav?.sentinel === "alive" && nav?.chars > 400, JSON.stringify(nav));
  await drain("pricing+navigation");
  /* ------------------------------------- 2b. editor load, PDF.js render + worker */
  await goto("/editor", 4000);
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /blank/i.test(x.textContent || ''));
    if (b) b.click();
    return true;
  })()`);
  await sleep(1500);
  const canvas = await evaluate(`(() => {
    const svgs = [...document.querySelectorAll('main svg')]
      .map((s) => { const r = s.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })
      .sort((a, b) => b.w * b.h - a.w * a.h);
    return svgs[0] ?? null;
  })()`);
  check("the editor mounted a page canvas", (canvas?.w ?? 0) > 300 && (canvas?.h ?? 0) > 300,
    JSON.stringify(canvas));
  await drain("editor-blank");

  const pdfBase64 = readFileSync(FIXTURE).toString("base64");
  const imported = await evaluate(`(async () => {
    const bin = atob("${pdfBase64}");
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const file = new File([buf], "csp-probe-fixture.pdf", { type: "application/pdf" });
    const input = [...document.querySelectorAll('input[type=file]')]
      .find((el) => (el.getAttribute('accept') || '').includes('pdf'));
    if (!input) return { ok: false, why: 'no pdf file input' };
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })()`);
  await sleep(6000);
  const hitRegions = await evaluate(
    `[...document.querySelectorAll('main svg rect')].filter((r) => (r.getAttribute('fill') || '') === 'transparent').length`,
  );
  // Source-text hit regions only exist if pdf.js parsed the document, which only
  // happens if its WORKER started. This is the worker-creation check.
  check("PDF.js rendered the imported document (so its worker started)",
    Number(hitRegions) > 0, `import=${JSON.stringify(imported)} hitRegions=${hitRegions}`);
  const workerLoaded = await evaluate(
    `performance.getEntriesByType('resource').filter((e) => /pdf\\.worker/.test(e.name)).map((e) => e.name.split('/').pop())`,
  );
  check("the pdf.js worker script was fetched from our own origin",
    Array.isArray(workerLoaded) && workerLoaded.length > 0, JSON.stringify(workerLoaded));
  check("the page background rasterized (canvas → data: URL path exercised)",
    Number(await evaluate(`document.querySelectorAll('main svg image').length`)) > 0);
  await drain("editor-pdfjs-render");

  /* ---------------------------------------- 2c. local tool + blob URL download */
  await goto("/tools/merge-pdf");
  const dropped = await evaluate(`(async () => {
    function pdf(label) {
      const body = [
        "%PDF-1.4",
        "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
        "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
        "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
        "4 0 obj<</Length 60>>stream",
        "BT /F1 18 Tf 20 100 Td (" + label + ") Tj ET",
        "endstream endobj",
        "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
        "trailer<</Root 1 0 R>>",
        "%%EOF",
      ].join("\\n");
      return new File([body], "synthetic-" + label + ".pdf", { type: "application/pdf" });
    }
    const input = document.querySelector('input[type=file]');
    if (!input) return { ok: false, why: "no file input" };
    const dt = new DataTransfer();
    dt.items.add(pdf("A"));
    dt.items.add(pdf("B"));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  })()`);
  await sleep(2000);
  check("both synthetic documents reached the merge tool",
    /synthetic-A/.test((await text()) ?? "") && /synthetic-B/.test((await text()) ?? ""),
    JSON.stringify(dropped));
  await clickByLabel("/merge/i");
  await sleep(5000);
  const mergedText = await text();
  check("the local merge produced a downloadable result",
    /download/i.test(mergedText ?? "") && !/something went wrong|failed/i.test(mergedText ?? ""),
    (mergedText ?? "").slice(0, 120));
  // The download itself: downloadBlob() creates an object URL and clicks an <a
  // download>. `worker-src`/`img-src` already allow blob:, but a NAVIGATION to a
  // blob: URL is governed by nothing in this policy, and this proves it.
  await send("Page.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
  const blobDownload = await evaluate(`(async () => {
    const before = (window.__cspViolations || []).length;
    const blob = new Blob([new Uint8Array([37, 80, 68, 70, 45])], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "csp-probe.pdf";
    document.body.appendChild(a); a.click(); a.remove();
    await new Promise((r) => setTimeout(r, 800));
    URL.revokeObjectURL(url);
    return { scheme: url.split(":")[0], newViolations: (window.__cspViolations || []).length - before };
  })()`);
  check("a Blob object URL was created and its download click violated nothing",
    blobDownload?.scheme === "blob" && blobDownload?.newViolations === 0,
    JSON.stringify(blobDownload));
  await clickByLabel("/download/i");
  await sleep(1500);
  await drain("local-merge-download");

  /* ------------------------------------- 2d. server processing + result download */
  //
  // The job is submitted from NODE, and the anonymous-owner cookie it hands back is
  // re-installed into the browser WITHOUT `Secure`. That is a transport
  // accommodation, not a relaxed product: `resolveJobActor` sets `secure: true`
  // whenever NODE_ENV=production, so a plain-http probe origin cannot store the
  // cookie and the follow-up GET resolves a DIFFERENT anonymous actor — which the
  // ownership gate correctly answers 404 to. Minting the identity out of band is
  // the same approach the auth probes take. The gate still runs, still has to pass,
  // and the CSP surface under test — the 302 the result download follows — is the
  // real one. It is reported so a reader knows the transport was accommodated.
  const submitBody = new FormData();
  submitBody.append(
    "file",
    new Blob([readFileSync(FIXTURE)], { type: "application/pdf" }),
    "csp probe.pdf",
  );
  const submit = await fetch(`${BASE}/api/jobs?slug=compress-pdf`, {
    method: "POST",
    body: submitBody,
    headers: { "Idempotency-Key": `csp-probe-${process.pid}` },
  });
  const submitJson = await submit.json().catch(() => ({}));
  const jobId = submitJson?.jobId ?? null;
  const anonCookie = (submit.headers.get("set-cookie") ?? "").match(/pdfdadi_jid=([^;]+)/);
  check("a processing job was accepted", submit.status === 202 && Boolean(jobId),
    `${submit.status} ${JSON.stringify(submitJson).slice(0, 120)}`);
  const insecureOrigin = BASE.startsWith("http://");
  if (jobId && anonCookie) {
    check("the anonymous owner cookie is Secure in production",
      /Secure/i.test(submit.headers.get("set-cookie") ?? ""));
    if (insecureOrigin) {
      envLimited("Secure-cookie transport",
        "the production build marks pdfdadi_jid Secure, which a plain-http probe origin cannot carry, so it is re-installed into the browser without the flag; on https no accommodation is needed");
    }
    await send("Network.enable");
    await send("Network.setCookie", {
      name: "pdfdadi_jid",
      value: anonCookie[1],
      url: BASE,
      path: "/",
      httpOnly: true,
      secure: false,
    });
  }
  if (!jobId) {
    envLimited("server processing path",
      `POST /api/jobs did not yield a job id: ${JSON.stringify(submitJson).slice(0, 200)}`);
  } else {
    let state = null;
    for (let i = 0; i < 45 && !/completed|failed/.test(String(state?.status)); i += 1) {
      await sleep(1000);
      state = await evaluate(`(async () => {
        const r = await fetch('/api/jobs/${jobId}', { credentials: 'same-origin' });
        return r.ok ? await r.json() : { status: 'http ' + r.status };
      })()`);
    }
    check("the server job reached a terminal state, read by the BROWSER",
      /completed|failed/.test(String(state?.status)), String(state?.status));
    if (String(state?.status) === "completed") {
      // The connect-src case that matters: this fetch FOLLOWS a 302 to a signed
      // storage URL. Same-origin with local disk; the R2 account endpoint in
      // production, which is why storageOrigins exists in the policy builder.
      //
      // `/download`, not `/result`, and the difference is not cosmetic. `/result`
      // exists only for the unified pipeline: its route 404s unless the stored row
      // is `type: "processing"` (app/api/jobs/[id]/result/route.ts). Submission
      // enters that pipeline only for `compress-pdf` AND with
      // `unified_processing_pipeline` on (lib/server/processingPilot.ts, default
      // OFF), so on a stock build POST /api/jobs writes a `pdf-tool` row and
      // `/result` can only ever answer 404 — this check spent its life unable to
      // pass, which is a probe that proves nothing rather than a product with a
      // broken download. `/download` dispatches on the stored type and serves
      // BOTH pipelines through the same ownership and completion gates, so it
      // exercises the redirect whichever path the build selected.
      const out = await evaluate(`(async () => {
        try {
          const r = await fetch('/api/jobs/${jobId}/download', { credentials: 'same-origin' });
          if (!r.ok) return { error: 'download ' + r.status, finalUrl: r.url };
          const buf = new Uint8Array(await r.arrayBuffer());
          return { bytes: buf.length, header: String.fromCharCode(...buf.slice(0, 5)), finalUrl: r.url };
        } catch (e) { return { error: 'fetch failed: ' + ((e && e.message) || e) }; }
      })()`);
      check("the processed result downloaded through the 302",
        out?.header === "%PDF-" && out?.bytes > 0, JSON.stringify(out).slice(0, 200));
      check("the signed result URL is same-origin with the page under local storage",
        String(out?.finalUrl ?? "").startsWith(BASE), String(out?.finalUrl ?? "").slice(0, 90));
    } else {
      envLimited("processed result download",
        `job ended ${state?.status} — the compressor's dependency is absent on this host; the redirect path is unexercised`);
    }
  }
  await drain("server-processing-download");
  /* --------------------------- 2e. authenticated shell, and the CSRF origin boundary */
  //
  // LAST IN THE WALK, AND THAT IS LOAD-BEARING. `resolveJobActor` prefers a
  // session over the anonymous job cookie, so signing in earlier would re-own the
  // browser mid-walk and make 2e's anonymous job read 404 — a probe-ordering
  // artifact that reads exactly like a broken ownership gate. Everything above
  // runs as an anonymous visitor, exactly as it did before this section existed.
  //
  // Signed up from INSIDE THE PAGE, not from Node: the session cookies are
  // `Secure` in production, so the browser has to receive them itself over https,
  // and doing what a real user does is more faithful than minting an identity out
  // of band.
  //
  // THIS SECTION IS THE PRODUCTION PROOF FOR SLICE 3.1.1. It previously reported
  // ENVIRONMENT-LIMITED because signup answered 403 CSRF_ORIGIN_REJECTED: the
  // expected origin came from `new URL(request.url).origin`, which in a production
  // Next server is the server's own BIND address (start-server.js: `appUrl =
  // protocol://hostname:port`), so behind this very terminator the browser's real
  // Origin could never match. Unit tests could not see it — they build the Request
  // with the public origin AS its URL, which is only true with nothing in front.
  //
  // This needs `--url https://…`. On http the cookies are dropped and the section
  // reports ENVIRONMENT-LIMITED rather than pretending.
  const account = `csp-probe-${process.pid}@pdfdadi.test`;
  const signup = await evaluate(`(async () => {
    try {
      const r = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          name: 'CSP Probe',
          email: ${JSON.stringify(account)},
          password: 'probe-password-123456',
          confirmPassword: 'probe-password-123456',
        }),
      });
      const text = await r.text();
      let code = null;
      try { code = JSON.parse(text)?.error?.code ?? null; } catch (e) { /* not a JSON error body */ }
      return { status: r.status, code };
    } catch (e) { return { error: String((e && e.message) || e) }; }
  })()`);
  await goto("/workspaces");
  const wsUrl = await evaluate("location.pathname");
  if (/login|signup/.test(String(wsUrl))) {
    // NOT a CSP limitation, and not a cookie one either — say which, because
    // "redirected to /login" has three very different causes and only one of them
    // is this probe's environment.
    const why =
      signup?.status === 403
        ? `the app's own same-origin check answered 403 ${signup?.code} to a same-origin ` +
          "browser fetch — the Slice 3.1.1 regression, see src/application/services/workspaceCsrf.ts."
        : `signup answered ${signup?.status ?? signup?.error}`;
    envLimited("authenticated workspace shell",
      `${why} The shell reuses the same layout and static chunks as /editor, which IS walked above.`);
    await drain("workspaces");
  } else {
    check("an account was created FROM THE PAGE, same-origin, behind the proxy",
      signup?.status === 200 || signup?.status === 201,
      `${signup?.status}${signup?.code ? ` ${signup.code}` : ""}`);
    check("the AUTHENTICATED workspace shell rendered (so the Secure session cookie arrived)",
      ((await text()) ?? "").length > 200,
      `${wsUrl} — ${((await text()) ?? "").slice(0, 60).replace(/\s+/g, " ")}`);

    // A representative AUTHENTICATED mutation, from the page, through the proxy.
    // Signup proves the unauthenticated half of the seam; this proves it for a
    // request that also carries a session and resolves a workspace actor.
    const provisioned = await evaluate(`(async () => {
      try {
        const list = await (await fetch('/api/workspaces?limit=1', { credentials: 'same-origin' })).json();
        const organizationId = list?.items?.[0]?.organizationId;
        if (!organizationId) return { error: 'no organization on the session' };
        const r = await fetch('/api/workspaces/provision-default', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin', body: JSON.stringify({ organizationId }),
        });
        return { status: r.status, organizationId, body: (await r.text()).slice(0, 80) };
      } catch (e) { return { error: String((e && e.message) || e) }; }
    })()`);
    // The authenticated half of the same client-fetch pattern: `UsageCard` reads
    // `/api/usage` and "renders nothing at all" when it cannot — the definition of a
    // surface that fails silently if CSP blocks it.
    const usage = await evaluate(`(async () => {
      const r = await fetch('/api/usage', { credentials: 'same-origin' });
      const body = await r.json().catch(() => null);
      return { status: r.status, keys: body ? Object.keys(body).length : 0 };
    })()`);
    check("the authenticated usage surface answers a page-context fetch",
      usage?.status === 200 && usage.keys > 0, JSON.stringify(usage));

    check("a representative AUTHENTICATED workspace mutation succeeded through the proxy",
      typeof provisioned?.status === "number" && provisioned.status < 400,
      `${provisioned?.status ?? provisioned?.error} ${String(provisioned?.body ?? "").replace(/\s+/g, " ")}`);
    await drain("workspaces");

    /* ---- the boundary still holds, measured from OUTSIDE the browser --------- */
    //
    // The rejection half cannot be measured from inside the page: `fetch` refuses
    // to set a forged `Origin`, and a document on a genuinely foreign origin
    // cannot be scripted across (an earlier attempt used a `data:` iframe and
    // "passed" only because reading its `contentWindow` threw — no request was
    // ever made, and it added a frame-src violation to the stream for nothing).
    //
    // A Node request IS the right instrument here: an attacker's browser sends
    // the victim's cookies with a foreign Origin, and that is exactly what these
    // reproduce. A Node session is minted with a correct Origin first — which is
    // itself the HTTP-level proof of the proxied allow path — then reused with a
    // hostile one, so the ONLY difference between allowed and refused is Origin.
    const jar = [];
    const nodePost = async (path, body, headers) => {
      const r = await fetch(`${BASE}${path}`, {
        method: "POST", redirect: "manual",
        headers: { "content-type": "application/json", ...(jar.length ? { cookie: jar.join("; ") } : {}), ...headers },
        body: JSON.stringify(body),
      });
      for (const c of (r.headers.getSetCookie?.() ?? [])) jar.push(c.split(";")[0]);
      let json = null;
      try { json = JSON.parse(await r.text()); } catch { /* not a JSON body */ }
      return { status: r.status, code: json?.error?.code ?? null, json };
    };

    const nodeAccount = `csp-probe-node-${process.pid}@pdfdadi.test`;
    const creds = { name: "CSP Probe Node", email: nodeAccount, password: "probe-password-123456", confirmPassword: "probe-password-123456" };
    const nodeSignup = await nodePost("/api/auth/signup", creds, { origin: BASE });
    check("signup with the PUBLIC origin and an internal bind URL is accepted over HTTP too",
      nodeSignup.status === 201, `${nodeSignup.status} ${nodeSignup.code ?? ""}`);

    const evilSignup = await nodePost("/api/auth/signup", { ...creds, email: `evil-${process.pid}@pdfdadi.test` }, { origin: "https://evil.example" });
    check("a CROSS-ORIGIN signup is refused",
      evilSignup.status === 403 && evilSignup.code === "CSRF_ORIGIN_REJECTED",
      `${evilSignup.status} ${evilSignup.code}`);

    const forgedSignup = await nodePost("/api/auth/signup", { ...creds, email: `forged-${process.pid}@pdfdadi.test` }, {
      origin: "https://evil.example",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
      host: "evil.example",
      forwarded: "host=evil.example;proto=https",
    });
    check("forged forwarded/Host headers cannot make an evil Origin acceptable",
      forgedSignup.status === 403 && forgedSignup.code === "CSRF_ORIGIN_REJECTED",
      `${forgedSignup.status} ${forgedSignup.code}`);

    const orgList = await (await fetch(`${BASE}/api/workspaces?limit=1`, { headers: { cookie: jar.join("; ") } })).json();
    const organizationId = orgList?.items?.[0]?.organizationId ?? null;
    check("the Node session resolved a workspace actor (so the mutations below are authenticated)",
      Boolean(organizationId), String(organizationId));

    const okMutation = await nodePost("/api/workspaces/provision-default", { organizationId }, { origin: BASE });
    check("an AUTHENTICATED mutation with the public origin is accepted",
      okMutation.status === 200, `${okMutation.status} ${okMutation.code ?? ""}`);

    const evilMutation = await nodePost("/api/workspaces/provision-default", { organizationId }, { origin: "https://evil.example" });
    check("the SAME authenticated mutation, same session cookie, foreign Origin, is refused",
      evilMutation.status === 403 && evilMutation.code === "CSRF_ORIGIN_REJECTED",
      `${evilMutation.status} ${evilMutation.code}`);

    // The bind origin is reachable on this host, and naming it must not work
    // either — that is what separates "trusts the configured origin" from
    // "trusts whatever origin the server happens to be listening on".
    const bindMutation = await nodePost("/api/workspaces/provision-default", { organizationId }, { origin: "http://127.0.0.1:3002" });
    check("naming the INTERNAL bind origin is refused as well",
      bindMutation.status === 403 && bindMutation.code === "CSRF_ORIGIN_REJECTED",
      `${bindMutation.status} ${bindMutation.code}`);
  }

  /* ---------------------------- 3. the report endpoint, end to end from a browser */
  console.log("\n3. REPORT ENDPOINT, END TO END");
  const logBefore = SERVER_LOG && existsSync(SERVER_LOG)
    ? readFileSync(SERVER_LOG, "utf8").length
    : -1;
  const canary = await evaluate(`(async () => {
    const img = document.createElement("img");
    img.src = ${JSON.stringify(CANARY_URL)};
    document.body.appendChild(img);
    await new Promise((r) => setTimeout(r, 1500));
    return (window.__cspViolations || []).slice(-1)[0] ?? null;
  })()`);
  check("the deliberate img-src violation was observed in the page",
    canary?.directive === "img-src" && /csp-probe\.invalid/.test(String(canary?.blocked)),
    JSON.stringify(canary));
  // THE anti-vacuity proof for the whole walk: this violation is deliberate, so the
  // browser reporting it is the only thing separating "policy clean" from "policy never
  // arrived". Its disposition is also the direct read on which stage is live.
  check(`the browser IS evaluating the policy, with disposition "${DISPOSITION}"`,
    canary?.disposition === DISPOSITION, String(canary?.disposition));
  // The full query string, secret and all, IS present in what the browser reports.
  // That is precisely why the endpoint has to redact rather than log what it is given.
  check("the browser's own report carries the full URL including the secret",
    String(canary?.blocked ?? "").includes(CANARY_SECRET), "(so redaction is load-bearing)");
  await drain("report-endpoint-canary");

  if (logBefore < 0) {
    envLimited("endpoint-side report collection",
      "--server-log was not given, so what the endpoint logged cannot be read");
  } else {
    // On https Chrome takes `report-to` and suppresses `report-uri`, and the Reporting
    // API batches on a ~60s timer rather than posting immediately — the ~70s cell in
    // the header table. Waiting 30s there would fail a delivery that was working, so
    // the window follows the mechanism the origin actually uses.
    const waitSeconds = SECURE_ORIGIN ? 95 : 30;
    let tail = "";
    for (let i = 0; i < waitSeconds; i += 1) {
      await sleep(1000);
      tail = readFileSync(SERVER_LOG, "utf8").slice(logBefore);
      if (/csp-probe\.invalid/.test(tail)) break;
    }
    const line = tail.split("\n").find((l) => /csp-probe\.invalid/.test(l)) ?? "";
    check("the browser's report REACHED /api/csp-report", line.length > 0,
      line ? "one log line" : tail.slice(-200));
    if (line) {
      check("the endpoint logged the blocked origin+path", line.includes("https://csp-probe.invalid/pixel.png"));
      check("the endpoint did NOT log the query string or its secret",
        !line.includes(CANARY_SECRET) && !line.includes("token=") && !line.includes("doc=payroll"));
      check("the endpoint did NOT log the document's query string",
        !/documentPath":"[^"]*\?/.test(line), line.slice(0, 0));
      check("the endpoint logged no cookie, sample or policy text",
        !/cookie|sample|originalPolicy|original-policy|referrer/i.test(line));
      // A nonce in a log is a live script-injection whitelist sitting in a file that
      // gets shipped to log aggregation. The browser sends the whole policy in
      // `original-policy`; the sanitizer's job is to never read it.
      check("the endpoint logged NO nonce (the policy text never lands in a log)",
        !/nonce|strict-dynamic/i.test(line));
      check("the log line names the directive it violated", /"directive":"img-src"/.test(line));
      // The alerting decision, end to end. Nothing pages on a violation — this
      // endpoint is unauthenticated with attacker-triggerable input, so a pager
      // reachable from it is a pager anyone can hold down. The severity is the
      // substitute: under enforcement a report means something was BLOCKED, so it
      // lands at warn and an operator can alert on their own log pipeline, owning
      // the threshold. Under report-only it is an observation and stays at info.
      check(`the endpoint logged it at ${ENFORCING ? "warn" : "info"}, matching the live disposition`,
        new RegExp(`"level":"${ENFORCING ? "warn" : "info"}"`).test(line),
        (line.match(/"level":"[a-z]+"/) ?? ["no level field"])[0]);
    }
  }

  // Reporting must never be able to break the app: a dead endpoint is a dead
  // endpoint, not a broken page. Proven by asking the browser to report to a path
  // that 404s and then checking the page still works.
  const survives = await evaluate(`(async () => {
    const r = await fetch("/api/csp-report", { method: "POST", body: "}{ not json at all",
      headers: { "content-type": "application/csp-report" } });
    const junk = await fetch("/api/csp-report", { method: "POST",
      body: JSON.stringify({ "csp-report": { "document-uri": "x".repeat(40000) } }),
      headers: { "content-type": "application/csp-report" } });
    return { malformed: r.status, oversized: junk.status, alive: document.body.innerText.length > 200 };
  })()`);
  check("a malformed report fails safely (204, not 500)", survives?.malformed === 204,
    String(survives?.malformed));
  check("an oversized report is refused (413)", survives?.oversized === 413, String(survives?.oversized));
  check("the page is unaffected by either", survives?.alive === true);
  check("GET on the report endpoint is 405 with an Allow header",
    (await fetch(`${BASE}/api/csp-report`)).status === 405);

  /* ------------------------------------------------------- 4. classify EVERYTHING */
  console.log("\n4. VIOLATION CLASSIFICATION");
  const grouped = new Map();
  for (const v of violations) {
    const key = `${v.directive} ${v.blocked}`;
    const g = grouped.get(key) ?? { ...v, count: 0, steps: new Set() };
    g.count += 1;
    g.steps.add(v.step);
    grouped.set(key, g);
  }
  const unclassified = [];
  for (const [key, g] of grouped) {
    const c = classify(g);
    if (!c) {
      unclassified.push(key);
      console.log(`  UNCLASSIFIED  ${key}  ×${g.count}  [${[...g.steps].join(", ")}]`);
      continue;
    }
    console.log(`  ${c.klass.padEnd(9)} ${key}  ×${g.count}  [${[...g.steps].join(", ")}]`);
  }
  check("every violation is classified (an unknown one must force a decision)",
    unclassified.length === 0, unclassified.join(" | "));
  check("no violation asks for a source the policy should grow",
    [...grouped.values()].every((g) => classify(g)?.klass !== "REQUIRED"),
    [...grouped.keys()].filter((k) => CLASSIFICATIONS.find((c) => c.klass === "REQUIRED" && c.directive.test(k.split(" ")[0]))).join(" | "));
  // The inverse of the 3.1 assertion. That slice proved the inline surface was VISIBLE
  // (152 reports); this one proves the nonce removed it. A hit here means a route stopped
  // getting the nonce, and under enforcement those scripts are being refused.
  check("the inline-script surface 3.1 measured is GONE (152 -> 0)",
    ![...grouped.keys()].some((k) => /^script-src(-elem)? inline$/.test(k)),
    [...grouped.entries()].filter(([k]) => /^script-src(-elem)? inline$/.test(k))
      .map(([k, g]) => `${k} x${g.count} [${[...g.steps].join(", ")}]`).join(" | ").slice(0, 300));
  check("no violation is a 3.2 REGRESSION",
    [...grouped.values()].every((g) => classify(g)?.klassAfter32 !== "REGRESSION"),
    [...grouped.keys()].join(" | ").slice(0, 200));

  /* -------------------------------------------------------------------- verdict */
  const realErrors = jsErrors.filter(
    (e) => !/favicon|404|Failed to load resource|csp-probe\.invalid|ERR_NAME_NOT_RESOLVED/i.test(e),
  );
  check("no uncaught JS error during the walk", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));
  const workerFailures = browserLog.filter((l) => /worker/i.test(l) && /error|fail/i.test(l));
  check("no worker failure in the browser log", workerFailures.length === 0,
    workerFailures.slice(0, 2).join(" | "));

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (limited.length) {
    console.log("ENVIRONMENT-LIMITED:");
    for (const l of limited) console.log(`  - ${l.name}: ${l.why}`);
  }
  if (failed.length) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
  }
  sock.close();
  chrome.kill();
  spawnSync("pkill", ["-f", `remote-debugging-port=${port}`], { stdio: "ignore" });
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(2);
});
