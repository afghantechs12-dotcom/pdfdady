/* global process, setTimeout, clearTimeout, Buffer, URL */
/**
 * One HTTP client for every probe that has to measure a refusal.
 *
 * The measurement this exists for: how many body bytes had been written to the
 * socket at the instant the response headers arrived. A server that refuses
 * before reading answers while most of the body is still unsent; a server that
 * buffers first cannot answer until the last byte is in. That figure, and the
 * latency beside it, is the only external witness to where the boundary is.
 *
 * Extracted from `scripts/upload-abuse-probe.mjs` when the ingress probes needed
 * the same client. One copy, so `chunked`, `declaredLength` and the
 * `Expect: 100-continue` handling cannot drift between the two.
 */
import http from "node:http";
import https from "node:https";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function send({
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
