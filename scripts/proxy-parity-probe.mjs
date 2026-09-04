/* global process, console, setTimeout, clearTimeout, Buffer, URL */
/**
 * LIVE parity check for the five upload paths that were EXCLUDED from the global
 * proxy matcher.
 *
 * WHY A SEPARATE SCRIPT. `scripts/upload-abuse-probe.mjs` is accepted evidence with a
 * fixed 32-check count; extending it would rewrite that. This one answers a different
 * question: not "is the upload boundary enforced" but "did taking these paths out of
 * the matcher cost any global policy". Static parity is argued in
 * `proxyMatcherParity.test.ts` (R9-R11); only a running artifact can show the response
 * a real client gets.
 *
 * WHAT IT MEASURES. `docs/evidence/final-prelaunch/web-security-headers.log` covers
 * `/`, `/tools/merge-pdf` and `/api/health` — not one excluded path. So for each of the
 * five: the security headers `next.config.mjs` applies to `/:path*`, the CSP (present,
 * and without a nonce, because a route handler renders no inline script), the echoed
 * `x-request-id`, and the pre-parse refusal that the exclusion exists to buy. Then the
 * three non-canonical spellings that re-enter the matcher — trailing slash, mixed case,
 * percent-encoding — because "matched again" must still mean "same policy".
 *
 * A MATCHED control path runs beside them. Without it, "all six headers present" could
 * equally mean the proxy is dead everywhere, which would pass this probe and fail the
 * product.
 *
 * Usage:
 *   node scripts/proxy-parity-probe.mjs --direct http://127.0.0.1:3052 \
 *        --front https://172.20.10.2:3051 --origin https://172.20.10.2:3051 \
 *        [--json out.json]
 */
import http from "node:http";
import https from "node:https";
import { writeFileSync } from "node:fs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const DIRECT = arg("direct", "http://127.0.0.1:3052");
const FRONT = arg("front", "");
const ORIGIN = arg("origin", DIRECT);
const JSON_OUT = arg("json", "");
const MiB = 1024 * 1024;

const rows = [];
let failures = 0;
function record(id, label, pass, detail) {
  rows.push({ id, label, pass, detail });
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${id} ${label}`);
  if (detail) console.log(`      ${detail}`);
}

/**
 * One request, body written in chunks so the response can be timed against how much
 * of it had been sent. A refusal that arrives while most of the body is unsent is the
 * external witness for "refused before parsing"; `fetch` cannot see that.
 *
 * Every outcome lands in `finish`, which destroys the socket: a mid-body refusal
 * leaves a request whose declared length will never be satisfied, and waiting for a
 * clean end on that socket hangs.
 */
function send({ origin, path, method = "POST", headers = {}, body = null, chunkSize = 64 * 1024, timeoutMs = 30_000 }) {
  const url = new URL(path, origin);
  const client = url.protocol === "https:" ? https : http;
  const outHeaders = { ...headers };
  if (body) outHeaders["content-length"] = String(body.length);

  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let written = 0;
    let writtenAtResponse = null;
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      req.destroy();
      resolve({
        status: 0,
        headers: {},
        text: "",
        json: null,
        written,
        writtenAtResponse,
        totalBytes: body ? body.length : 0,
        latencyMs: Number(process.hrtime.bigint() - started) / 1e6,
        ...result,
      });
    };
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: outHeaders,
        rejectUnauthorized: false,
        agent: false,
      },
      (res) => {
        if (writtenAtResponse === null) writtenAtResponse = written;
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not JSON — kept as raw text */
          }
          finish({ status: res.statusCode, headers: res.headers, text: text.slice(0, 300), json });
        });
        res.on("error", () => finish({ status: res.statusCode, headers: res.headers }));
      },
    );
    req.on("error", (error) => finish({ error: String(error.message) }));
    timer = setTimeout(() => finish({ error: `timeout after ${timeoutMs}ms` }), timeoutMs);
    if (!body) return req.end();
    let offset = 0;
    const pump = () => {
      if (settled) return;
      if (offset >= body.length) return req.end();
      const chunk = body.subarray(offset, offset + chunkSize);
      offset += chunk.length;
      written += chunk.length;
      if (req.write(chunk)) setTimeout(pump, 2);
      else req.once("drain", () => setTimeout(pump, 2));
    };
    pump();
  });
}

/** The headers `next.config.mjs` applies to `/:path*`, i.e. before middleware. */
const REQUIRED_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cross-origin-opener-policy": "same-origin",
  "content-security-policy": null, // value compared separately: nonce or not
};

function headerReport(res) {
  const missing = [];
  const wrong = [];
  for (const [name, want] of Object.entries(REQUIRED_HEADERS)) {
    const got = res.headers[name];
    if (got === undefined) missing.push(name);
    else if (want !== null && got !== want) wrong.push(`${name}=${got}`);
  }
  return { missing, wrong };
}

const EXCLUDED = [
  { id: "canonical/jobs", path: "/api/jobs" },
  { id: "canonical/tools", path: "/api/tools/merge-pdf" },
  { id: "canonical/upload", path: "/api/workspaces/cku1abc/documents/upload" },
  { id: "canonical/version", path: "/api/workspaces/cku1abc/documents/cku2def/versions/upload" },
  { id: "canonical/attach", path: "/api/workspaces/cku1abc/documents/cku2def/attachments" },
];

/** A tiny non-multipart body: enough to be a real POST, too small to matter. */
const TINY = Buffer.from("x");

async function run() {
  const target = FRONT || DIRECT;
  console.log(`# proxy parity probe — target ${target} (direct ${DIRECT}${FRONT ? `, front ${FRONT}` : ""})`);

  // ── X1: the control. A MATCHED path must show the proxy alive, with a nonce in its
  // CSP. Without this, every "headers present" below could be a dead proxy.
  const control = await send({ origin: target, path: "/api/health", method: "GET" });
  const controlHeaders = headerReport(control);
  const controlCsp = String(control.headers["content-security-policy"] ?? "");
  record(
    "X1",
    "control: a matcher-MATCHED path carries the six headers and a per-request nonce",
    controlHeaders.missing.length === 0 && controlHeaders.wrong.length === 0 && /'nonce-[A-Za-z0-9+/=]+'/.test(controlCsp),
    `status ${control.status}; missing [${controlHeaders.missing}]; wrong [${controlHeaders.wrong}]; nonce ${/'nonce-/.test(controlCsp) ? "present" : "ABSENT"}`,
  );

  // ── X2..X6: every excluded path carries the same six, from next.config.mjs.
  for (const { id, path } of EXCLUDED) {
    const res = await send({
      origin: target,
      path,
      headers: { "content-type": "application/octet-stream", "x-request-id": `parity-${id.replace(/\W/g, "-")}` },
      body: TINY,
    });
    const { missing, wrong } = headerReport(res);
    const csp = String(res.headers["content-security-policy"] ?? "");
    const echoed = res.json?.error?.requestId ?? null;
    record(
      `X2.${id}`,
      "excluded path still carries the six security headers",
      missing.length === 0 && wrong.length === 0,
      `status ${res.status}; missing [${missing}]; wrong [${wrong}]`,
    );
    record(
      `X3.${id}`,
      "its CSP is the build-time one — present, and with no nonce to lose",
      csp.length > 0 && !/'nonce-/.test(csp),
      `csp ${csp.slice(0, 60)}…`,
    );
    // Tracing is a per-handler read of the inbound header, so it survives exclusion.
    // The two public tool routes answer a bare `{error}` and never echo one — recorded,
    // not asserted, because that shape predates this branch.
    record(
      `X4.${id}`,
      "the request id it was given comes back (workspace routes) or is not part of the shape",
      id.startsWith("canonical/jobs") || id.startsWith("canonical/tools") ? true : echoed === `parity-${id.replace(/\W/g, "-")}`,
      `echoed ${echoed ?? "n/a"}; body ${res.text.slice(0, 120)}`,
    );
  }

  // ── X5: the trailing-slash form. Next prepends an internal 308 for it, and
  // `resolve-routes.js` runs redirects BEFORE middleware — so the spelling that would
  // re-enter the matcher never reaches it. Static proof is R10; this is the live one.
  for (const { id, path } of EXCLUDED) {
    const res = await send({ origin: target, path: `${path}/`, method: "POST", body: TINY });
    record(
      `X5.${id}`,
      "trailing slash is redirected before middleware, so it cannot re-enter the matcher",
      res.status === 308 && String(res.headers.location ?? "").endsWith(path),
      `status ${res.status}; location ${res.headers.location ?? "none"}`,
    );
  }

  // ── X6/X7: mixed case and percent-encoding DO re-enter the matcher (the literal
  // segments are case-sensitive in the regex, and the decoded form is tried second).
  // Re-entering costs the pre-parse refusal on that spelling; it must not cost policy.
  const REENTRANT = [
    { id: "case/jobs", path: "/api/JOBS", canonical: "/api/jobs" },
    { id: "case/upload", path: "/api/workspaces/cku1abc/documents/UPLOAD", canonical: "/api/workspaces/cku1abc/documents/upload" },
    { id: "encoded/jobs", path: "/api/%6Aobs", canonical: "/api/jobs" },
    { id: "encoded/upload", path: "/api/workspaces/cku1abc/documents/%75pload", canonical: "/api/workspaces/cku1abc/documents/upload" },
  ];
  for (const { id, path, canonical } of REENTRANT) {
    const res = await send({
      origin: target,
      path,
      headers: { "content-type": "application/octet-stream" },
      body: TINY,
    });
    const { missing, wrong } = headerReport(res);
    const canon = await send({
      origin: target,
      path: canonical,
      headers: { "content-type": "application/octet-stream" },
      body: TINY,
    });
    record(
      `X6.${id}`,
      "a re-entrant spelling keeps every security header",
      missing.length === 0 && wrong.length === 0,
      `status ${res.status}; missing [${missing}]; wrong [${wrong}]`,
    );
    // The status is the policy. Same refusal as the canonical spelling means the handler
    // decided, not the matcher — a 200 here, or a 5xx, would be the real finding.
    record(
      `X7.${id}`,
      "and answers exactly what the canonical spelling answers",
      res.status === canon.status && res.status < 500,
      `${path} → ${res.status}; ${canonical} → ${canon.status}`,
    );
  }

  // ── X8: the property the exclusion was made for. 8 MiB dripped at the canonical
  // spelling, with a valid Origin so the CSRF stage passes and the SESSION stage is the
  // one that refuses: the answer must arrive with most of the body still unsent.
  const big = Buffer.alloc(8 * MiB, 0x41);
  for (const { id, path } of EXCLUDED.filter((e) => e.path.startsWith("/api/workspaces"))) {
    const res = await send({
      origin: target,
      path,
      headers: {
        origin: ORIGIN,
        "content-type": "multipart/form-data; boundary=----parityprobe",
        "x-request-id": `parity-drip-${id.replace(/\W/g, "-")}`,
      },
      body: big,
    });
    const sentAtAnswer = res.writtenAtResponse ?? res.written;
    record(
      `X8.${id}`,
      "refused before the body was read, with the matcher no longer involved",
      res.status === 401 && sentAtAnswer < res.totalBytes / 2,
      `status ${res.status}; ${(sentAtAnswer / MiB).toFixed(2)} of ${(res.totalBytes / MiB).toFixed(0)} MiB sent when the answer arrived; ${res.latencyMs.toFixed(0)}ms`,
    );
  }

  // ── X9: the `/_next/data` prefix, the last reachable re-entry. It is a GET-shaped
  // route Next reserves for data requests; on an API path it is simply not a route.
  // Recorded because a 5xx here would be a new failure mode the exclusion introduced.
  const dataPrefixed = await send({
    origin: target,
    path: "/_next/data/build-id/api/jobs.json",
    method: "GET",
  });
  record(
    "X9",
    "the /_next/data prefix form is a miss, not a crash",
    dataPrefixed.status > 0 && dataPrefixed.status < 500,
    `status ${dataPrefixed.status}`,
  );

  console.log(`\n${rows.length - failures}/${rows.length} checks passed`);
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ target, direct: DIRECT, front: FRONT, rows }, null, 2));
    console.log(`json → ${JSON_OUT}`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

run();
