/* global process, console, setTimeout, clearTimeout, setInterval, clearInterval, Buffer, URL */
/**
 * LIVE acceptance for the upload boundary, against a real production artifact.
 *
 * WHAT ONLY A RUNNING SERVER CAN ANSWER. The unit suite proves the handler does
 * not attach a reader to the request stream. It cannot prove what the RUNTIME
 * does with the socket: whether an oversized body is refused before it is
 * transferred, whether `Expect: 100-continue` is answered by Node before the
 * handler ever runs, what the process's RSS does under concurrent 8 MiB
 * uploads, or whether the answer changes when the request arrives directly on
 * the app port instead of through the TLS front.
 *
 * HOW CONSUMPTION IS MEASURED FROM OUTSIDE. Every request records how many body
 * bytes had been written to the socket at the instant the response headers
 * arrived. A server that refuses before reading answers while most of the body
 * is still unsent; a server that parses first cannot answer until all of it has
 * been read. That figure, and the latency beside it, is the external witness.
 *
 * IT MUTATES DATA. It registers one throwaway account per run and uploads inside
 * that account's own Workspace, against whatever database the server uses. Row
 * counts are taken before and after so anonymous traffic can be shown to have
 * created nothing.
 *
 * Usage:
 *   node scripts/upload-abuse-probe.mjs --direct http://127.0.0.1:3052 \
 *        --front https://172.20.10.2:3051 --origin https://172.20.10.2:3051 \
 *        --db prisma/dev.db --storage .storage [--json out.json]
 */
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const DIRECT = arg("direct", "http://127.0.0.1:3052");
const FRONT = arg("front", "");
const ORIGIN = arg("origin", DIRECT);
const DB = arg("db", "prisma/dev.db");
const STORAGE = arg("storage", ".storage");
const SERVER_PID = arg("pid", "");
const MiB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rows = [];
function record(row) {
  rows.push(row);
  const bits = [
    `${row.pass ? "PASS" : "FAIL"}  ${row.id} ${row.label}`,
    row.detail && `      ${row.detail}`,
  ].filter(Boolean);
  console.log(bits.join("\n"));
}

/** RSS of the server process in MiB, or null when no pid was given. */
function rss() {
  if (!SERVER_PID) return null;
  try {
    const out = execFileSync("ps", ["-o", "rss=", "-p", SERVER_PID], { encoding: "utf8" });
    return Math.round((Number(out.trim()) / 1024) * 10) / 10;
  } catch {
    return null;
  }
}

const TABLES = [
  "document_records",
  "document_versions",
  "attachment_records",
  "audit_logs",
  "stored_files",
  "document_ingestions",
  "workspace_save_intents",
];
/** Row counts for the tables an upload would touch, plus stored file count. */
/**
 * One sqlite read, retried around the server's own writes. The ingestion worker
 * holds the write lock in bursts, and "database is locked" is contention, not a
 * result — a measurement that gives up on it would report a false zero.
 */
function query(sql) {
  let last;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return execFileSync("sqlite3", ["-cmd", ".timeout 8000", DB, sql], { encoding: "utf8" });
    } catch (error) {
      last = error;
      execFileSync("sleep", ["0.4"]);
    }
  }
  throw last;
}

function sideEffects() {
  const sql = TABLES.map((t) => `SELECT '${t}', COUNT(*) FROM ${t};`).join("");
  const out = query(sql);
  const counts = Object.fromEntries(
    out.trim().split("\n").filter(Boolean).map((l) => {
      const [table, n] = l.split("|");
      return [table, Number(n)];
    }),
  );
  counts.storageFiles = Number(
    execFileSync("bash", ["-c", `find ${STORAGE} -type f | wc -l`], { encoding: "utf8" }).trim(),
  );
  return counts;
}

/**
 * One request, with the body written chunk by chunk so the moment the response
 * arrives can be compared against how much of it had been sent.
 *
 * `declaredLength` is written verbatim, including values that contradict the
 * bytes that follow — that is the point of not using fetch here.
 */
function send({
  origin,
  path,
  method = "POST",
  headers = {},
  body = null,
  chunkSize = 64 * 1024,
  chunkDelayMs = 0,
  declaredLength,
  chunked = false,
  expectContinue = false,
  timeoutMs = 30_000,
}) {
  const url = new URL(path, origin);
  const client = url.protocol === "https:" ? https : http;
  const outHeaders = { ...headers };
  if (body && !chunked) {
    outHeaders["content-length"] = declaredLength ?? String(body.length);
  }
  if (declaredLength !== undefined && chunked) outHeaders["content-length"] = declaredLength;
  if (expectContinue) outHeaders.expect = "100-continue";

  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let written = 0;
    let writtenAtResponse = null;
    let continueAt = null;
    let settled = false;
    let timer = null;

    /**
     * ONE exit, and it destroys the request.
     *
     * A refusal that arrives mid-body leaves a request whose declared length was
     * never satisfied: the server has answered and stopped reading, and neither
     * side will send another byte. Waiting for a clean `end` on that socket is
     * how the first version of this script hung. Every outcome — response,
     * abort, socket error, timeout — lands here, reports how much had been
     * written, and closes the connection.
     */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      req.destroy();
      resolve({
        headers: {},
        text: "",
        json: null,
        written,
        writtenAtResponse,
        totalBytes: body ? body.length : 0,
        continueMs: continueAt === null ? null : Number(continueAt - started) / 1e6,
        setCookie: null,
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
        const deliver = () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not JSON — recorded as raw */
          }
          finish({
            status: res.statusCode,
            headers: res.headers,
            text: text.slice(0, 400),
            json,
            setCookie: res.headers["set-cookie"] ?? null,
          });
        };
        res.on("data", (c) => chunks.push(c));
        res.on("end", deliver);
        // The status line and headers are the measurement; a body cut short by
        // the server closing an unfinished upload still carries it.
        res.on("aborted", deliver);
        res.on("error", deliver);
      },
    );
    req.on("continue", () => {
      continueAt = process.hrtime.bigint();
      void writeBody();
    });
    // A refusal that closes the socket while we are still writing is the
    // measurement, not a failure: report what had been sent.
    req.on("error", (error) => finish({ status: 0, socketError: error.code ?? String(error) }));
    timer = setTimeout(() => finish({ status: 0, timedOut: true }), timeoutMs);

    async function writeBody() {
      if (!body) {
        req.end();
        return;
      }
      for (let offset = 0; offset < body.length; offset += chunkSize) {
        if (writtenAtResponse !== null) break; // already answered; stop sending
        const slice = body.subarray(offset, Math.min(offset + chunkSize, body.length));
        const ok = req.write(slice);
        written += slice.length;
        if (!ok) await new Promise((r) => req.once("drain", r));
        if (chunkDelayMs) await sleep(chunkDelayMs);
      }
      req.end();
    }
    if (!expectContinue) void writeBody();
  });
}

/** A multipart body. `rawQuote` builds the one undici cannot parse. */
function multipart({ fields = {}, filename = "probe.pdf", bytes, rawQuote = false }) {
  const boundary = `----probe${randomUUID().replace(/-/g, "")}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  const name = rawQuote ? 'a";b.pdf' : filename;
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
        `Content-Type: application/pdf\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** A minimal well-formed PDF, padded to `size`. */
function pdf(size) {
  const head = Buffer.from("%PDF-1.4\n%%EOF\n");
  return size <= head.length ? head : Buffer.concat([head, Buffer.alloc(size - head.length, 0x20)]);
}

/** sha256 of exactly the bytes we sent, for the byte-exactness lookup. */
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

/** One stored_files row by checksum: proves the server kept the same bytes. */
function storedBySha(hex) {
  const out = query(`SELECT size, mimeType FROM stored_files WHERE sha256='${hex}' LIMIT 1;`).trim();
  if (!out) return null;
  const [size, mimeType] = out.split("|");
  return { size: Number(size), mimeType };
}

/** A JSON POST, for the account/workspace setup the authenticated cases need. */
async function postJson(path, payload, cookie) {
  return send({
    origin: DIRECT,
    path,
    body: Buffer.from(JSON.stringify(payload)),
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
  });
}

let ORG = "org-probe";

const routesFor = (ws, doc) => [
  { name: "attachments", path: `/api/workspaces/${ws}/documents/${doc}/attachments`, fields: () => ({ organizationId: ORG, name: `probe-${randomUUID().slice(0, 8)}.pdf` }) },
  { name: "documents/upload", path: `/api/workspaces/${ws}/documents/upload`, fields: () => ({ organizationId: ORG }) },
  { name: "versions/upload", path: `/api/workspaces/${ws}/documents/${doc}/versions/upload`, fields: () => ({ organizationId: ORG }), needsRevision: true },
];

/** Registers a throwaway account, finds its Workspace, seeds one document. */
async function setUpAccount() {
  const email = `probe-${randomUUID().slice(0, 12)}@example.test`;
  const signup = await postJson("/api/auth/signup", {
    name: "Upload Probe",
    email,
    password: "Probe-Passw0rd!2026",
    confirmPassword: "Probe-Passw0rd!2026",
  });
  const raw = signup.setCookie?.find((c) => c.startsWith("pdfdadi_session")) ?? signup.setCookie?.[0];
  const cookie = raw ? raw.split(";")[0] : null;
  if (signup.status !== 201 || !cookie) {
    throw new Error(`signup failed: ${signup.status} ${signup.text}`);
  }

  const list = await send({ origin: DIRECT, method: "GET", path: "/api/workspaces?limit=1", headers: { origin: ORIGIN, cookie } });
  const workspace = list.json?.items?.[0] ?? list.json?.workspaces?.[0];
  if (!workspace?.id) throw new Error(`no workspace: ${list.status} ${list.text}`);
  ORG = workspace.organizationId ?? ORG;

  const seedBytes = pdf(4096);
  const seed = multipart({ fields: { organizationId: ORG }, filename: "seed.pdf", bytes: seedBytes });
  const created = await send({
    origin: DIRECT,
    path: `/api/workspaces/${workspace.id}/documents/upload`,
    body: seed.body,
    headers: { origin: ORIGIN, "content-type": seed.contentType, cookie },
  });
  const documentId = created.json?.document?.id;
  if (!documentId) throw new Error(`seed upload failed: ${created.status} ${created.text}`);
  return { cookie, workspaceId: workspace.id, documentId, email };
}

/** The document's current revision, so a version save is not refused as stale. */
async function currentRevision(cookie, workspaceId, documentId) {
  const r = await send({
    origin: DIRECT,
    method: "GET",
    path: `/api/workspaces/${workspaceId}/documents/${documentId}`,
    headers: { origin: ORIGIN, cookie },
  });
  return r.json?.document?.revision ?? 0;
}

/** The three private upload routes, with ids that need not exist: an anonymous
 *  caller must be refused before the path is ever resolved. */
const anonRoutes = (ws = "ws_probe", doc = "doc_probe") => [
  { name: "attachments", path: `/api/workspaces/${ws}/documents/${doc}/attachments` },
  { name: "documents/upload", path: `/api/workspaces/${ws}/documents/upload` },
  { name: "versions/upload", path: `/api/workspaces/${ws}/documents/${doc}/versions/upload` },
];

/**
 * A DRIPPED body: 64 KiB every 40 ms.
 *
 * Loopback accepts 8 MiB into the socket in about four milliseconds, so on a
 * fast link "bytes written when the headers arrived" saturates at 100% no matter
 * what the server does — the first run of this script measured exactly that and
 * proved nothing. Dripping the body makes the transfer take seconds, so a server
 * that refuses before reading answers with almost all of it still unsent, and one
 * that parses first cannot answer until the last chunk. Same bytes, same headers;
 * only the pace differs.
 */
const DRIP = { chunkSize: 64 * 1024, chunkDelayMs: 40 };

/** Status, latency, and how much of the body was still unsent when it arrived. */
const unsent = (r) =>
  `${r.status} in ${r.latencyMs.toFixed(0)}ms, sent ${(r.writtenAtResponse / MiB).toFixed(2)}` +
  `/${(r.totalBytes / MiB).toFixed(2)} MiB`;

/** Deltas between two sideEffects() snapshots, empty when nothing changed. */
function delta(before, after) {
  const out = {};
  for (const k of Object.keys(after)) if (after[k] !== before[k]) out[k] = after[k] - before[k];
  return out;
}

async function main() {
  const targets = [{ label: "direct", origin: DIRECT }];
  if (FRONT) targets.push({ label: "TLS front", origin: FRONT });

  const runStart = sideEffects();
  console.log(`\nartifact under test: ${DIRECT}${FRONT ? ` (also via ${FRONT})` : ""}`);
  console.log(`origin header:      ${ORIGIN}`);
  console.log(`rows at run start:  ${JSON.stringify(runStart)}`);
  console.log(`server RSS at start: ${rss() ?? "n/a"} MiB\n`);

  const account = await setUpAccount();
  console.log(`throwaway account ready: workspace ${account.workspaceId}, document ${account.documentId}\n`);
  const authed = routesFor(account.workspaceId, account.documentId);
  const cookie = account.cookie;

  const big = multipart({ fields: { organizationId: ORG }, bytes: pdf(8 * MiB) });

  // ── L0 · THE CONTROL: the same 8 MiB, the same drip, signed in ─────────
  // A route that parses cannot answer until the last chunk has arrived. This is
  // the number every "refused unread" figure below is measured against; without
  // it, a small `writtenAtResponse` could just mean a fast link.
  {
    const r = await send({
      origin: DIRECT, path: authed[1].path, body: big.body, ...DRIP,
      headers: { origin: ORIGIN, "content-type": big.contentType, cookie },
    });
    record({
      id: "L0", label: "control: a signed-in 8 MiB upload IS parsed, so it answers only after the last chunk",
      pass: (r.status === 201 || r.status === 200) && r.writtenAtResponse === r.totalBytes,
      detail: `${unsent(r)} — the whole body had to arrive first, at 64 KiB every 40ms`,
      measured: { status: r.status, writtenAtResponse: r.writtenAtResponse, totalBytes: r.totalBytes, latencyMs: r.latencyMs },
    });
  }

  // Everything from here to the L13 check is ANONYMOUS. The row counts either
  // side of it are the evidence that none of it created anything.
  const anonBefore = sideEffects();

  // ── L1 · an anonymous 8 MiB well-formed upload, both entry points ───────
  for (const t of targets) {
    for (const route of anonRoutes(account.workspaceId, account.documentId)) {
      const r = await send({
        origin: t.origin, path: route.path, body: big.body, ...DRIP,
        headers: { origin: ORIGIN, "content-type": big.contentType },
      });
      record({
        id: "L1", label: `anonymous 8 MiB -> 401 with the body still arriving (${route.name}, ${t.label})`,
        pass: r.status === 401 && r.json?.error?.code === "UNAUTHORIZED"
          && r.writtenAtResponse <= MiB,
        detail: `${unsent(r)} · ${JSON.stringify(r.json?.error?.message)} · cache-control ${r.headers["cache-control"]}`,
        measured: { status: r.status, writtenAtResponse: r.writtenAtResponse, totalBytes: r.totalBytes, latencyMs: r.latencyMs, body: r.json },
      });
    }
  }

  // ── L2 · a declared length over the ceiling ────────────────────────────
  for (const route of anonRoutes(account.workspaceId, account.documentId)) {
    const r = await send({
      path: route.path, origin: DIRECT, body: pdf(1024), declaredLength: String(200 * MiB),
      headers: { origin: ORIGIN, "content-type": big.contentType },
    });
    record({
      id: "L2", label: `declared 200 MiB -> 413 before the body (${route.name})`,
      pass: r.status === 413 && r.json?.error?.code === "PAYLOAD_TOO_LARGE",
      detail: `${r.status} in ${r.latencyMs.toFixed(0)}ms · ${JSON.stringify(r.json?.error?.message)} · cache-control ${r.headers["cache-control"]}`,
      measured: { status: r.status, latencyMs: r.latencyMs, body: r.json, cacheControl: r.headers["cache-control"] },
    });
  }

  // ── L5 · a foreign origin ──────────────────────────────────────────────
  for (const route of anonRoutes(account.workspaceId, account.documentId)) {
    const r = await send({
      path: route.path, origin: DIRECT, body: big.body, ...DRIP,
      headers: { origin: "https://evil.example", "content-type": big.contentType },
    });
    record({
      id: "L5", label: `foreign origin -> 403 with the body still arriving (${route.name})`,
      pass: r.status === 403 && r.writtenAtResponse <= MiB,
      detail: `${unsent(r)} · ${JSON.stringify(r.json?.error?.code)} · cache-control ${r.headers["cache-control"]}`,
      measured: { status: r.status, writtenAtResponse: r.writtenAtResponse, totalBytes: r.totalBytes, body: r.json, cacheControl: r.headers["cache-control"] },
    });
  }

  // ── L6 · the wrong media type ──────────────────────────────────────────
  for (const route of anonRoutes(account.workspaceId, account.documentId)) {
    const r = await send({
      path: route.path, origin: DIRECT, body: Buffer.from(JSON.stringify({ file: "nope" })),
      headers: { origin: ORIGIN, "content-type": "application/json" },
    });
    record({
      id: "L6", label: `application/json -> 415 (${route.name})`,
      pass: r.status === 415 && r.json?.error?.message === "Expected a multipart/form-data upload.",
      detail: `${r.status} · ${JSON.stringify(r.json?.error?.message)} · cache-control ${r.headers["cache-control"]}`,
      measured: { status: r.status, body: r.json, cacheControl: r.headers["cache-control"] },
    });
  }

  // ── L11 · eight parallel anonymous 8 MiB uploads, with RSS around it ────
  {
    const rssBefore = rss();
    const path = anonRoutes(account.workspaceId, account.documentId)[1].path;
    let peak = rssBefore;
    const sampler = setInterval(() => {
      const now = rss();
      if (now !== null && (peak === null || now > peak)) peak = now;
    }, 60);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        send({
          origin: DIRECT, path, body: big.body, ...DRIP,
          headers: { origin: ORIGIN, "content-type": big.contentType },
        })),
    );
    clearInterval(sampler);
    await sleep(400);
    const rssAfter = rss();
    const all401 = results.every((r) => r.status === 401);
    const unread = results.every((r) => r.writtenAtResponse <= MiB);
    record({
      id: "L11", label: "8 concurrent anonymous 8 MiB (64 MiB offered) -> all 401, RSS bounded",
      pass: all401 && unread && (rssBefore === null || peak - rssBefore < 64),
      detail: `statuses ${[...new Set(results.map((r) => r.status))].join(",")} · `
        + `sent ${(results.reduce((s, r) => s + r.writtenAtResponse, 0) / MiB).toFixed(1)} of `
        + `${(results.reduce((s, r) => s + r.totalBytes, 0) / MiB).toFixed(1)} MiB · `
        + `RSS ${rssBefore ?? "n/a"} -> peak ${peak ?? "n/a"} -> ${rssAfter ?? "n/a"} MiB`,
      measured: { statuses: results.map((r) => r.status), writtenAtResponse: results.map((r) => r.writtenAtResponse), rssBefore, peak, rssAfter },
    });
  }

  // ── L12 · Expect: 100-continue ─────────────────────────────────────────
  {
    const r = await send({
      origin: DIRECT, path: anonRoutes(account.workspaceId, account.documentId)[1].path,
      body: pdf(1024), declaredLength: String(200 * MiB), expectContinue: true,
      headers: { origin: ORIGIN, "content-type": big.contentType },
    });
    record({
      id: "L12", label: "Expect: 100-continue on an over-ceiling declared length",
      // Honest either way: what matters is the 413, not who sent the interim
      // 100. Node's HTTP server answers `Expect` itself, before a handler runs,
      // so the application cannot refuse at that point — recorded, not claimed.
      pass: r.status === 413 && r.json?.error?.code === "PAYLOAD_TOO_LARGE",
      detail: `100 Continue ${r.continueMs === null ? "NOT sent" : `after ${r.continueMs.toFixed(0)}ms (by the runtime, not the route)`}`
        + ` · final ${r.status} in ${r.latencyMs.toFixed(0)}ms · ${JSON.stringify(r.json?.error?.code)}`,
      measured: { status: r.status, continueMs: r.continueMs, body: r.json },
    });
  }

  // ── L13 · none of the anonymous traffic above touched a row ─────────────
  {
    const anonAfter = sideEffects();
    const d = delta(anonBefore, anonAfter);
    record({
      id: "L13", label: "no storage, database, ingestion, version or audit row from any anonymous request",
      pass: Object.keys(d).length === 0,
      detail: Object.keys(d).length === 0
        ? `all ${Object.keys(anonAfter).length} counters unchanged: ${JSON.stringify(anonAfter)}`
        : `CHANGED: ${JSON.stringify(d)}`,
      measured: { before: anonBefore, after: anonAfter, delta: d },
    });
  }

  // ── L3 · chunked, no declared length at all, over the ceiling ──────────
  {
    const oversize = multipart({ fields: { organizationId: ORG }, filename: "over.pdf", bytes: pdf(26 * MiB) });
    const rssBefore = rss();
    let peak = rssBefore;
    const sampler = setInterval(() => {
      const now = rss();
      if (now !== null && (peak === null || now > peak)) peak = now;
    }, 60);
    const r = await send({
      origin: DIRECT, path: authed[0].path, body: oversize.body, chunked: true,
      chunkSize: 512 * 1024, chunkDelayMs: 30,
      headers: { origin: ORIGIN, "content-type": oversize.contentType, "transfer-encoding": "chunked", cookie },
    });
    clearInterval(sampler);
    record({
      id: "L3", label: "authenticated, chunked 26 MiB, NO Content-Length -> 413 from the stream, RSS bounded",
      pass: r.status === 413 && r.json?.error?.code === "PAYLOAD_TOO_LARGE"
        && r.writtenAtResponse < r.totalBytes
        && (rssBefore === null || peak - rssBefore < 64),
      detail: `${unsent(r)} · ${JSON.stringify(r.json?.error?.message)} · RSS ${rssBefore ?? "n/a"} -> peak ${peak ?? "n/a"} MiB`,
      measured: { status: r.status, writtenAtResponse: r.writtenAtResponse, totalBytes: r.totalBytes, body: r.json, rssBefore, peak },
    });
  }

  // ── L4 · a Content-Length that understates the bytes that follow ───────
  {
    const oversize = multipart({ fields: { organizationId: ORG }, filename: "lie.pdf", bytes: pdf(26 * MiB) });
    const r = await send({
      origin: DIRECT, path: authed[0].path, body: oversize.body, declaredLength: "1024",
      chunkSize: 512 * 1024, chunkDelayMs: 30,
      headers: { origin: ORIGIN, "content-type": oversize.contentType, cookie },
    });
    record({
      id: "L4", label: "authenticated, declares 1 KiB and sends 26 MiB -> never served",
      pass: r.status !== 200 && r.status !== 201,
      detail: `${r.status} in ${r.latencyMs.toFixed(0)}ms · ${JSON.stringify(r.json?.error?.code ?? r.text.slice(0, 80))}`
        + ` · the framing layer reads only the declared 1024 bytes, so understating buys a truncated body, not a bigger parse`,
      measured: { status: r.status, body: r.json, text: r.text.slice(0, 200), socketError: r.socketError ?? false },
    });
  }

  // ── L7 · the same unreadable body, all three routes, one answer ────────
  {
    const answers = [];
    for (const route of authed) {
      const revision = route.needsRevision
        ? await currentRevision(cookie, account.workspaceId, account.documentId)
        : null;
      const hostile = multipart({
        fields: { ...route.fields(), ...(revision === null ? {} : { expectedRevision: String(revision) }) },
        bytes: pdf(2048), rawQuote: true,
      });
      const r = await send({
        origin: DIRECT, path: route.path, body: hostile.body,
        headers: { origin: ORIGIN, "content-type": hostile.contentType, cookie },
      });
      answers.push(`${r.status} ${r.json?.error?.code} ${r.json?.error?.message}`);
      record({
        id: "L7", label: `a raw quote in the filename -> 400 MALFORMED_MULTIPART (${route.name})`,
        pass: r.status === 400 && r.json?.error?.code === "MALFORMED_MULTIPART",
        detail: `${r.status} · ${JSON.stringify({ code: r.json?.error?.code, message: r.json?.error?.message })}`
          + ` · cache-control ${r.headers["cache-control"]}`,
        measured: { status: r.status, body: r.json, cacheControl: r.headers["cache-control"] },
      });
    }
    const distinct = [...new Set(answers)];
    record({
      id: "L7b", label: "all three routes answer the same bytes identically (the old 422-vs-400 split)",
      pass: distinct.length === 1,
      detail: distinct.join("  |  "),
      measured: { answers },
    });
  }

  // ── L10 · an ordinary authenticated upload still completes, byte-exact ──
  for (const [i, route] of authed.entries()) {
    const bytes = Buffer.concat([pdf(64 * 1024), Buffer.from(`probe-${i}-${randomUUID()}`)]);
    const hex = sha(bytes);
    const revision = route.needsRevision
      ? await currentRevision(cookie, account.workspaceId, account.documentId)
      : null;
    const body = multipart({
      fields: { ...route.fields(), ...(revision === null ? {} : { expectedRevision: String(revision) }) },
      filename: `ordinary-${i}.pdf`, bytes,
    });
    const r = await send({
      origin: DIRECT, path: route.path, body: body.body,
      headers: { origin: ORIGIN, "content-type": body.contentType, cookie },
    });
    const stored = storedBySha(hex);
    record({
      id: "L10", label: `a signed-in ${(bytes.length / 1024).toFixed(0)} KiB upload succeeds and the stored bytes match (${route.name})`,
      pass: (r.status === 201 || r.status === 200) && stored !== null && stored.size === bytes.length,
      detail: `${r.status} in ${r.latencyMs.toFixed(0)}ms · sha256 ${hex.slice(0, 12)}… `
        + (stored ? `found in stored_files, size ${stored.size} = sent ${bytes.length}` : "NOT FOUND in stored_files")
        + ` · cache-control ${r.headers["cache-control"] ?? "(absent)"}`,
      measured: { status: r.status, sha256: hex, stored, sentBytes: bytes.length, cacheControl: r.headers["cache-control"] ?? null },
    });
  }

  // ── L8 · the anonymous global bucket, exhausted ────────────────────────
  // Sequential tiny multipart requests, each reaching the limiter (multipart
  // content type, under the ceiling) and no further: every one is a 401 until
  // the ceiling, then a 429. The count it takes IS the configured ceiling minus
  // what the run already spent, so it is reported rather than asserted.
  let retryAfter;
  {
    const tiny = multipart({ fields: { organizationId: ORG }, bytes: pdf(512) });
    const path = anonRoutes(account.workspaceId, account.documentId)[1].path;
    let attempts = 0;
    let limited = null;
    while (attempts < 500) {
      attempts += 1;
      const r = await send({
        origin: DIRECT, path, body: tiny.body,
        headers: { origin: ORIGIN, "content-type": tiny.contentType },
      });
      if (r.status === 429) { limited = r; break; }
      if (r.status !== 401) { limited = r; break; }
    }
    retryAfter = limited?.headers["retry-after"] ?? null;
    record({
      id: "L8", label: "anonymous flood -> 429 with a truthful Retry-After",
      pass: limited?.status === 429 && Number(retryAfter) >= 1 && Number(retryAfter) <= 61
        && limited.json?.error?.code === "RATE_LIMITED"
        && limited.headers["cache-control"] === "no-store",
      detail: `429 on attempt ${attempts} · Retry-After ${retryAfter} (window 60s, +1ms honesty margin => 61 is the ceiling)`
        + ` · ${JSON.stringify(limited?.json?.error?.message)} · cache-control ${limited?.headers["cache-control"]}`,
      measured: { attempts, status: limited?.status, retryAfter, body: limited?.json, cacheControl: limited?.headers["cache-control"] },
    });

    // Still refused while the window stands, and still without reading a body.
    const during = await send({
      origin: DIRECT, path, body: big.body, ...DRIP,
      headers: { origin: ORIGIN, "content-type": big.contentType },
    });
    record({
      id: "L8b", label: "an 8 MiB body offered while rate limited is refused unread",
      pass: during.status === 429 && during.writtenAtResponse <= MiB,
      detail: unsent(during),
      measured: { status: during.status, writtenAtResponse: during.writtenAtResponse, totalBytes: during.totalBytes },
    });

    // A signed-in user keeps their own budget: the anonymous flood above cannot
    // spend it.
    const authedDuring = await send({
      origin: DIRECT, path, body: tiny.body,
      headers: { origin: ORIGIN, "content-type": tiny.contentType, cookie },
    });
    record({
      id: "L8c", label: "a signed-in caller is unaffected by the anonymous flood (separate bucket)",
      pass: authedDuring.status !== 429,
      detail: `${authedDuring.status} · ${JSON.stringify(authedDuring.json?.error?.code ?? "accepted")}`,
      measured: { status: authedDuring.status, body: authedDuring.json },
    });
  }

  // ── L9 · recovery once the window passes ───────────────────────────────
  {
    const wait = Math.min(Number(retryAfter) || 61, 61);
    console.log(`      (waiting ${wait}s — exactly the Retry-After the server named)`);
    await sleep(wait * 1000);
    const tiny = multipart({ fields: { organizationId: ORG }, bytes: pdf(512) });
    const r = await send({
      origin: DIRECT, path: anonRoutes(account.workspaceId, account.documentId)[1].path,
      body: tiny.body, headers: { origin: ORIGIN, "content-type": tiny.contentType },
    });
    record({
      id: "L9", label: "obeying Retry-After to the second is enough: the next attempt is not 429",
      pass: r.status === 401,
      detail: `${r.status} after ${wait}s · ${JSON.stringify(r.json?.error?.code)}`,
      measured: { status: r.status, waitedSeconds: wait, body: r.json },
    });
  }

  const runEnd = sideEffects();
  const failures = rows.filter((r) => !r.pass);
  console.log(`\nrows at run end: ${JSON.stringify(runEnd)}`);
  console.log(`whole-run delta: ${JSON.stringify(delta(runStart, runEnd))} (the throwaway account's own uploads)`);
  console.log(`server RSS at end: ${rss() ?? "n/a"} MiB`);
  console.log(`\n${rows.length - failures.length}/${rows.length} checks passed`);
  if (failures.length) console.log(`FAILED: ${failures.map((f) => `${f.id} ${f.label}`).join("; ")}`);

  const out = arg("json", "");
  if (out) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(out, JSON.stringify({
      direct: DIRECT, front: FRONT || null, origin: ORIGIN,
      account: { workspaceId: account.workspaceId, documentId: account.documentId },
      rowsBefore: runStart, rowsAfter: runEnd, checks: rows,
    }, null, 2));
    console.log(`wrote ${out}`);
  }
  process.exitCode = failures.length ? 1 : 0;
}

await main();
