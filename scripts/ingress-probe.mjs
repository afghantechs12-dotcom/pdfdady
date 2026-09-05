/* global process, console, setInterval, clearInterval, Buffer */
/**
 * LIVE acceptance for the ingress body boundary, against a real production
 * artifact.
 *
 * WHAT ONLY A RUNNING SERVER CAN ANSWER. A unit test can prove the policy
 * classifies a path and refuses a declared length. It cannot prove what the
 * RUNTIME retains: whether an anonymous body offered to a page URL is refused on
 * the request line or buffered up to `proxyClientMaxBodySize` first, whether a
 * chunked body with no declared length is bounded, what RSS does under 28
 * concurrent 100 MiB offers, and whether it comes back down afterwards.
 *
 * HOW IT IS MEASURED FROM OUTSIDE. Two witnesses per request:
 *   - `offered`: body bytes written to the socket when the response headers
 *     arrived. A boundary that refuses before reading answers with almost
 *     nothing sent; one that buffers first cannot answer until the last byte.
 *   - `csp`: whether the response carries a Content-Security-Policy. Every
 *     response Next produces has one (`next.config.mjs` `headers()` for excluded
 *     paths, `proxy.ts` for matched ones, with a per-request nonce). A response
 *     with no CSP at all was written by the ingress guard, before Next was
 *     invoked — which is the claim being tested.
 *
 * RSS comes from `ps` against `--pid`, so the server must be started separately
 * (`scripts/restart-origin.sh`) and its pid passed in.
 *
 * Run it twice: once against the unguarded artifact to reproduce the defect, once
 * against `ingress/server.mjs` to show it closed. The expectations below are the
 * post-fix ones in both runs — a baseline run is meant to fail, and which rows
 * fail is the reproduction.
 *
 * Usage:
 *   node scripts/ingress-probe.mjs --origin http://127.0.0.1:3002 --pid 1234 \
 *        [--label baseline] [--json out.json] [--skip-burst]
 */
import { execFileSync } from "node:child_process";

import { CLASS_B_MAX_BYTES } from "../ingress/policy.mjs";
import { send, sleep } from "./lib/drip.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const ORIGIN = arg("origin", "http://127.0.0.1:3002");
const PID = arg("pid", "");
const LABEL = arg("label", "run");
const JSON_OUT = arg("json", "");
const MiB = 1024 * 1024;

/** 100 MiB, allocated ONCE and shared by every request including the burst. */
const HUGE = Buffer.alloc(100 * MiB, 0x41);
const OVER_CLASS_B = Buffer.alloc(3 * MiB, 0x42);

const rows = [];
function record(row) {
  rows.push(row);
  console.log(`${row.pass ? "PASS" : "FAIL"}  ${row.id} ${row.label}`);
  if (row.detail) console.log(`      ${row.detail}`);
}

function rss() {
  if (!PID) return null;
  try {
    const out = execFileSync("ps", ["-o", "rss=", "-p", PID], { encoding: "utf8" });
    return Math.round((Number(out.trim()) / 1024) * 10) / 10;
  } catch {
    return null;
  }
}

const mib = (bytes) => Math.round((bytes / MiB) * 100) / 100;

/**
 * One case: offer `body` to `path` and check where the answer came from.
 *
 * `maxOfferedMiB` is the retention claim. The socket keeps flowing for one read
 * after the response is written, and the probe writes in 64 KiB chunks, so an
 * immediate refusal still shows a fraction of a MiB offered; anything at or near
 * the full body means the server read it all first.
 */
async function bodyCase({
  id,
  label,
  path,
  method = "POST",
  body = null,
  headers = {},
  declaredLength,
  chunked = false,
  expectContinue = false,
  chunkSize = 64 * 1024,
  chunkDelayMs = 5,
  expectStatus,
  expectNoCsp = true,
  maxOfferedMiB = 1,
  maxLatencyMs = 5_000,
}) {
  const res = await send({
    origin: ORIGIN,
    path,
    method,
    headers,
    body,
    declaredLength,
    chunked,
    expectContinue,
    chunkSize,
    chunkDelayMs,
    timeoutMs: 120_000,
  });
  const offered = res.writtenAtResponse ?? res.written;
  const csp = res.headers?.["content-security-policy"] ?? null;
  const statusOk = Array.isArray(expectStatus)
    ? expectStatus.includes(res.status)
    : res.status === expectStatus;
  const cspOk = expectNoCsp === null ? true : expectNoCsp ? csp === null : typeof csp === "string";
  const offeredOk = offered <= maxOfferedMiB * MiB;
  const latencyOk = res.latencyMs <= maxLatencyMs;
  record({
    id,
    label,
    pass: statusOk && cspOk && offeredOk && latencyOk,
    detail:
      `status ${res.status} (want ${expectStatus})  offered ${mib(offered)}/${mib(res.totalBytes)} MiB ` +
      `(max ${maxOfferedMiB})  ${res.latencyMs.toFixed(0)}ms  csp ${csp ? "present" : "absent"}` +
      `${expectNoCsp === null ? " (either)" : expectNoCsp ? " (want absent)" : " (want present)"}`,
    measured: {
      status: res.status,
      offeredBytes: offered,
      totalBytes: res.totalBytes,
      latencyMs: Math.round(res.latencyMs),
      csp: csp ? (csp.includes("nonce-") ? "nonce" : "static") : null,
      text: res.text?.slice(0, 160) ?? "",
    },
  });
  return res;
}

/**
 * 28 concurrent anonymous 100 MiB offers to a page URL — the exact shape that
 * took RSS from ~301 MiB to 1795 MiB and left it there.
 *
 * Peak is sampled while the requests are in flight; settled is sampled after a
 * pause long enough for a GC to have had the opportunity. The assertion is a
 * justified ceiling and a downward trend, not an exact number: RSS is not a
 * deterministic function of the same workload.
 */
async function burst({ concurrency = 28, path = "/", chunkDelayMs = 0 }) {
  const baseline = rss();
  let peak = baseline ?? 0;
  const sampler = setInterval(() => {
    const now = rss();
    if (now !== null && now > peak) peak = now;
  }, 150);

  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: concurrency }, () =>
      send({
        origin: ORIGIN,
        path,
        method: "POST",
        body: HUGE,
        chunkSize: 256 * 1024,
        chunkDelayMs,
        timeoutMs: 180_000,
      }),
    ),
  );
  clearInterval(sampler);
  const elapsed = Date.now() - started;

  await sleep(8_000);
  const settled = rss();

  const offered = results.reduce((sum, r) => sum + (r.writtenAtResponse ?? r.written), 0);
  const statuses = [...new Set(results.map((r) => r.status))].sort();
  const withCsp = results.filter((r) => r.headers?.["content-security-policy"]).length;

  /*
   * TWO LAWFUL OUTCOMES per request, and the row must not prefer one — the same
   * rule E6 already follows.
   *
   * Refusing on the request line means answering while 100 MiB is still being
   * written, and the refusal carries `connection: close` because that is what
   * stops the transfer. A client mid-write then races: some read the 413 off the
   * socket first, the rest have their write fail (EPIPE / ECONNRESET) before they
   * get that far. Both are the boundary working; neither is Next answering.
   *
   * So instead of demanding one status, this asserts the things that CANNOT be
   * true unless the body was refused unread:
   *   - at least one request observed the refusal (an all-hangup run is not a pass)
   *   - every request that got an answer got a 4xx, never a 2xx/3xx/5xx
   *   - every request that got none died on a closed socket, not on a timeout —
   *     a server that read all 28 bodies and never answered would show `timeout`
   *   - not one response carried a CSP, so Next was never invoked
   * and the memory claims below are unchanged.
   */
  const answered = results.filter((r) => r.status !== 0);
  const hungUp = results.filter((r) => r.status === 0);
  const why = [...new Set(hungUp.map((r) => (r.timedOut ? "timeout" : (r.socketError ?? "unknown"))))];
  const statusesOk =
    answered.length > 0 &&
    answered.every((r) => r.status >= 400 && r.status < 500) &&
    hungUp.every((r) => !r.timedOut) &&
    withCsp === 0;

  // 100 MiB offered × 28. The ceiling: refusing on the request line should cost
  // a socket read each, so growth of even 100 MiB over baseline is generous.
  /*
   * `baseline === null` means `--pid` was not given, so `ps` was never asked and
   * NOTHING was sampled. That is a FAIL, not a pass. These two rows exist to make
   * a memory claim — the one the whole finding is about — and a memory claim that
   * was never measured is exactly the vacuous green this probe was written to
   * catch elsewhere. It read `baseline === null || …` and printed
   * `RSS null → peak 0 → settled null` under a PASS, which is worse than a red row
   * because it looks like evidence.
   */
  const peakOk = baseline !== null && peak - baseline <= 150;
  const settledOk = baseline !== null && settled - baseline <= 100;
  const noRss = baseline === null ? "RSS NOT SAMPLED — rerun with --pid <server pid>.  " : "";
  const offeredOk = offered <= concurrency * 2 * MiB;

  record({
    id: "E7",
    label: `${concurrency} concurrent anonymous ${mib(HUGE.length)} MiB offers to ${path}`,
    pass: peakOk && offeredOk && statusesOk,
    detail:
      noRss +
      `RSS ${baseline} → peak ${peak} → settled ${settled} MiB (peak +${
        baseline === null ? "?" : Math.round(peak - baseline)
      }, want ≤150)  ` +
      `offered ${mib(offered)} MiB of ${mib(concurrency * HUGE.length)} (want ≤${concurrency * 2})  ` +
      `statuses ${statuses.join(",")}  ${answered.length}/${concurrency} read a refusal` +
      `${hungUp.length ? `, ${hungUp.length} lost the socket first (${why.join(",")})` : ""}  ` +
      `csp on ${withCsp}/${concurrency} (want 0)  ${elapsed}ms`,
    measured: {
      baseline,
      peak,
      settled,
      offeredBytes: offered,
      statuses,
      answered: answered.length,
      hungUp: hungUp.length,
      hangupReasons: why,
      withCsp,
      elapsed,
    },
  });
  record({
    id: "E8",
    label: "settled RSS returns toward baseline after the burst",
    pass: settledOk,
    detail: noRss + `settled ${settled} MiB vs baseline ${baseline} MiB (want ≤ baseline+100)`,
    measured: { baseline, settled },
  });
}

async function main() {
  console.log(`\n=== ingress probe (${LABEL}) → ${ORIGIN}  pid ${PID || "n/a"} ===\n`);

  // ---- E3: an existing page path ----------------------------------------
  await bodyCase({
    id: "E3a",
    label: "POST / with a declared 100 MiB body is refused on the request line",
    path: "/",
    body: HUGE,
    expectStatus: 413,
  });
  await bodyCase({
    id: "E3b",
    label: "GET / still renders, with middleware's per-request CSP",
    path: "/",
    method: "GET",
    expectStatus: 200,
    expectNoCsp: false,
    maxOfferedMiB: 0.001,
  });

  // ---- E2: a path with no route at all ---------------------------------
  await bodyCase({
    id: "E2a",
    label: "POST to an unknown path with a declared 100 MiB body is refused",
    path: "/does-not-exist-ingress-probe",
    body: HUGE,
    expectStatus: 413,
  });
  await bodyCase({
    id: "E2b",
    label: "an unknown path refuses identically to an existing one (no disclosure)",
    path: "/admin/does-not-exist-ingress-probe",
    body: HUGE,
    expectStatus: 413,
  });

  // ---- E5: no declared length ------------------------------------------
  await bodyCase({
    id: "E5a",
    label: "chunked 100 MiB to a page path is refused without a length",
    path: "/",
    body: HUGE,
    chunked: true,
    expectStatus: 411,
  });
  await bodyCase({
    id: "E5b",
    label: "chunked 100 MiB to an API path is refused without a length",
    path: "/api/csp-report",
    body: HUGE,
    chunked: true,
    expectStatus: 411,
  });

  // ---- E4: an ordinary API route ---------------------------------------
  await bodyCase({
    id: "E4a",
    label: "POST /api/csp-report with a declared 100 MiB body is refused",
    path: "/api/csp-report",
    body: HUGE,
    headers: { "content-type": "application/csp-report" },
    expectStatus: 413,
  });
  await bodyCase({
    id: "E4b",
    label: "3 MiB — over the class B ceiling, far under proxyClientMaxBodySize",
    path: "/api/csp-report",
    body: OVER_CLASS_B,
    headers: { "content-type": "application/csp-report" },
    expectStatus: 413,
  });
  await bodyCase({
    id: "E4c",
    label: "a legitimate small report still reaches the handler",
    path: "/api/csp-report",
    body: Buffer.from(
      JSON.stringify({ "csp-report": { "document-uri": `${ORIGIN}/`, "violated-directive": "script-src" } }),
    ),
    headers: { "content-type": "application/csp-report" },
    expectStatus: [204, 202, 200],
    expectNoCsp: false,
    maxOfferedMiB: 0.01,
  });
  await bodyCase({
    id: "E4d",
    label: "the route's own 16 KiB limit still answers before the class ceiling",
    path: "/api/analytics/events",
    body: Buffer.alloc(64 * 1024, 0x7b),
    headers: { "content-type": "application/json" },
    expectStatus: 413,
    expectNoCsp: false,
    maxOfferedMiB: 0.2,
  });

  // ---- E6: a dishonest declared length ---------------------------------
  const understated = await bodyCase({
    id: "E6",
    label: "understated Content-Length cannot carry a larger body into Next",
    path: "/api/csp-report",
    body: HUGE,
    declaredLength: "100",
    headers: { "content-type": "application/csp-report" },
    // Two lawful outcomes, and the row must not prefer one: Node's parser hands the
    // handler exactly the declared 100 bytes (truncated JSON → the route's own 400),
    // and the 100 MiB behind them is either dropped with the connection or read as a
    // garbage second request that fails to parse (status 0, a socket error). What is
    // NOT lawful is a 2xx from a handler that believed it had the whole body, or the
    // extra 100 MiB being read — which is what `maxOfferedMiB` pins.
    expectStatus: [0, 400, 413, 204, 202, 200],
    expectNoCsp: null,
    maxOfferedMiB: 2,
  });

  // ---- E12: hostile headers cannot raise the ceiling -------------------
  await bodyCase({
    id: "E12",
    label: "client-supplied proxy-secret / forwarded headers do not raise the ceiling",
    path: "/",
    body: HUGE,
    headers: {
      "x-pdfdadi-proxy-secret": "not-the-secret-but-long-enough",
      "x-forwarded-for": "10.0.0.1",
      "x-real-ip": "10.0.0.1",
      "content-security-policy": "script-src 'nonce-attacker'",
    },
    expectStatus: 413,
  });

  // ---- Expect: 100-continue -------------------------------------------
  await bodyCase({
    id: "E3c",
    label: "Expect: 100-continue is refused before the body is invited",
    path: "/",
    body: HUGE,
    expectContinue: true,
    expectStatus: 413,
    maxOfferedMiB: 0.001,
  });

  // ---- E9 control: the five streaming paths are untouched --------------
  await bodyCase({
    id: "E9a",
    label: "an excluded multipart path still refuses anonymously, before the body",
    path: "/api/tools/compress-pdf",
    body: Buffer.alloc(8 * MiB, 0x43),
    headers: { "content-type": "multipart/form-data; boundary=----probe" },
    // Class C owns its own reader, so reading the body IS the accepted
    // behaviour here: the ceiling is the body size, not an early-refusal claim.
    // What must not change is the status and that 110 MiB is still refused (E9b).
    expectStatus: [400, 401, 403, 429],
    expectNoCsp: false,
    maxOfferedMiB: 8.1,
  });
  await bodyCase({
    id: "E9b",
    label: "an excluded multipart path still enforces its own 110 MiB ceiling",
    path: "/api/jobs",
    body: HUGE,
    declaredLength: String(200 * MiB),
    headers: { "content-type": "multipart/form-data; boundary=----probe" },
    expectStatus: [400, 401, 403, 413, 429],
    expectNoCsp: false,
    maxOfferedMiB: 2,
  });

  // ---- E13: the ceiling, one byte either side --------------------------
  /*
   * Which LAYER answered is the point, and the CSP is what says so: a guard
   * refusal is written before Next exists and carries none, while the route's own
   * 16 KiB limit is a Next response with a per-request nonce. So "one byte below
   * the ceiling still reaches the application" is observable even though this
   * route refuses the body for its own reasons — a 413 with a CSP means the guard
   * let it through, which is exactly the claim.
   */
  await bodyCase({
    id: "E13a",
    label: "one byte below the class B ceiling still reaches the application",
    path: "/api/csp-report",
    body: Buffer.alloc(CLASS_B_MAX_BYTES - 1, 0x44),
    headers: { "content-type": "application/csp-report" },
    expectStatus: 413,
    expectNoCsp: false,
    maxOfferedMiB: mib(CLASS_B_MAX_BYTES) + 0.1,
    maxLatencyMs: 10_000,
  });
  await bodyCase({
    id: "E13b",
    label: "exactly the class B ceiling is still the application's to answer",
    path: "/api/csp-report",
    body: Buffer.alloc(CLASS_B_MAX_BYTES, 0x44),
    headers: { "content-type": "application/csp-report" },
    expectStatus: 413,
    expectNoCsp: false,
    maxOfferedMiB: mib(CLASS_B_MAX_BYTES) + 0.1,
    maxLatencyMs: 10_000,
  });
  await bodyCase({
    id: "E13c",
    label: "one byte over the ceiling is refused by the guard instead",
    path: "/api/csp-report",
    body: Buffer.alloc(CLASS_B_MAX_BYTES + 1, 0x44),
    headers: { "content-type": "application/csp-report" },
    expectStatus: 413,
    expectNoCsp: true,
    maxOfferedMiB: 1,
  });

  // ---- E14: slow, and interrupted --------------------------------------
  await bodyCase({
    id: "E14a",
    label: "a slow legitimate body is not mistaken for an attack",
    path: "/api/csp-report",
    body: Buffer.from(
      JSON.stringify({ "csp-report": { "document-uri": `${ORIGIN}/`, "violated-directive": "img-src" } }),
    ),
    headers: { "content-type": "application/csp-report" },
    // 16 chunks, 300ms apart: ~5s of dribbling, well inside `requestTimeout` and
    // well outside `headersTimeout`, which is what the 20s/300s split is for.
    chunkSize: 8,
    chunkDelayMs: 300,
    expectStatus: [204, 202, 200],
    expectNoCsp: false,
    maxOfferedMiB: 0.01,
    maxLatencyMs: 20_000,
  });
  const interrupted = await send({
    origin: ORIGIN,
    path: "/api/csp-report",
    method: "POST",
    headers: { "content-type": "application/csp-report" },
    body: Buffer.alloc(1024 * 1024, 0x45),
    chunkSize: 4096,
    chunkDelayMs: 40,
    // Abandoned mid-body: the client goes away with the declared length unsatisfied.
    timeoutMs: 400,
  });
  const afterInterrupt = await send({ origin: ORIGIN, path: "/", method: "GET", timeoutMs: 15_000 });
  record({
    id: "E14b",
    label: "an interrupted upload leaves the origin serving",
    pass: interrupted.status === 0 && afterInterrupt.status === 200,
    detail:
      `interrupted after ${mib(interrupted.written)} MiB (status ${interrupted.status || "aborted"}` +
      `${interrupted.timedOut ? ", client timeout" : ""}); the next GET / answered ${afterInterrupt.status}`,
    measured: { interruptedBytes: interrupted.written, next: afterInterrupt.status },
  });

  // ---- E15: malformed is still the application's error ------------------
  await bodyCase({
    id: "E15",
    label: "a malformed sub-ceiling body keeps the application's own error",
    path: "/api/analytics/events",
    body: Buffer.from("{ not json at all"),
    headers: { "content-type": "application/json" },
    // The guard can only ever answer 411 or 413, and only without a CSP. A 4xx
    // WITH a CSP is Next's — so the shape of the malformed-body error is still
    // owned by the route, whatever that shape is. The status is recorded rather
    // than pinned to one value, because pinning it here would duplicate the
    // route's own contract in a second place.
    // The canonical answer here IS 204: `app/api/analytics/events/route.ts` says so
    // in its own header ("It answers 204 to almost everything") and swallows a
    // malformed payload deliberately, so a beacon cannot become a client-visible
    // error. The row therefore checks the thing the guard could change — WHO
    // answered — rather than restating the route's contract: the guard can only
    // ever write 411 or 413, and only without a CSP.
    expectStatus: [204, 202, 200, 400, 422],
    expectNoCsp: false,
    maxOfferedMiB: 0.01,
  });

  // ---- E10: nothing truncated ever reaches a handler -------------------
  const overCeiling = rows.filter(
    (r) => r.id === "E2a" || r.id === "E2b" || r.id === "E3a" || r.id === "E4a" || r.id === "E4b",
  );
  const notRefused = overCeiling.filter((r) => r.measured?.status !== 413);
  record({
    id: "E10",
    label: "no over-ceiling body is answered as if it had been read",
    pass: notRefused.length === 0 && (understated.status === 0 || understated.status >= 400),
    detail:
      `${overCeiling.length - notRefused.length}/${overCeiling.length} over-ceiling cases answered 413` +
      (notRefused.length
        ? ` — ${notRefused.map((r) => `${r.id}:${r.measured?.status}`).join(", ")} answered from Next instead`
        : "") +
      `; understated-length case answered ${understated.status || "socket error"} after ${mib(
        understated.writtenAtResponse ?? 0,
      )} MiB of the 100 MiB offered`,
  });

  // ---- E16: legitimate traffic is unchanged from the baseline ----------
  /*
   * The comparison is against the RECORDED unguarded run, not against a second
   * server started now — the unguarded entry refuses to start in production, which
   * is the point of S8. `probe-baseline-unguarded.json` is that run's own output,
   * so this row is a real before/after on the same cases.
   *
   * What "identical" can mean here: status, which layer answered (the CSP class —
   * `nonce` from middleware, `static` from `next.config.mjs` headers), and the
   * response body. Not the HTML byte-for-byte: every page carries a per-request
   * nonce and a build-dependent class hash, so demanding equality there would fail
   * on a rebuild rather than on a regression. For `/` the check is that it is still
   * an HTML document from middleware.
   */
  const BASE = "docs/evidence/final-prelaunch/ingress/probe-baseline-unguarded.json";
  const { readFileSync, existsSync } = await import("node:fs");
  const controls = ["E3b", "E4c", "E4d", "E9a", "E9b"];
  let e16Detail = `no baseline at ${BASE} to compare against`;
  let e16Pass = false;
  if (existsSync(BASE)) {
    const before = new Map(
      JSON.parse(readFileSync(BASE, "utf8")).rows.map((r) => [r.id, r.measured]),
    );
    const diffs = [];
    for (const id of controls) {
      const a = before.get(id);
      const b = rows.find((r) => r.id === id)?.measured;
      if (!a || !b) {
        diffs.push(`${id}: missing (${a ? "guarded" : "baseline"})`);
        continue;
      }
      if (a.status !== b.status) diffs.push(`${id}: status ${a.status} → ${b.status}`);
      if (a.csp !== b.csp) diffs.push(`${id}: csp ${a.csp} → ${b.csp}`);
      const bodySame =
        id === "E3b"
          ? String(b.text).startsWith("<!DOCTYPE html>")
          : String(a.text) === String(b.text);
      if (!bodySame) diffs.push(`${id}: body ${JSON.stringify(String(b.text).slice(0, 60))}`);
    }
    e16Pass = diffs.length === 0;
    e16Detail =
      `${controls.length - new Set(diffs.map((d) => d.split(":")[0])).size}/${controls.length} controls ` +
      `identical in status, CSP source and body` + (diffs.length ? ` — ${diffs.join("; ")}` : "");
  }
  record({ id: "E16", label: "legitimate requests answer exactly as they did unguarded", pass: e16Pass, detail: e16Detail });

  if (!flag("skip-burst")) await burst({});

  const failed = rows.filter((r) => !r.pass);
  console.log(
    `\n${rows.length - failed.length}/${rows.length} passed` +
      (failed.length ? `  FAILED: ${failed.map((r) => r.id).join(", ")}` : ""),
  );
  if (JSON_OUT) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(JSON_OUT, JSON.stringify({ label: LABEL, origin: ORIGIN, rows }, null, 2));
    console.log(`json → ${JSON_OUT}`);
  }
  process.exit(failed.length ? 1 : 0);
}

await main();
