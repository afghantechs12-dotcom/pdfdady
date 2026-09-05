/* global Buffer, console, process, setTimeout, clearTimeout */
/**
 * The ingress boundary: the only place in this deployment where a request is
 * seen before Next has it.
 *
 * ## Where this sits, and why here
 *
 * `next/dist/server/lib/start-server.js` builds the `http.Server` itself
 * (`http.createServer(requestListener)`), and everything that makes the app
 * behave correctly hangs off what it does next: `getRequestHandlers` →
 * `router-server.initialize`, which owns `resolve-routes.js` and therefore the
 * rule that `next.config.mjs`'s `headers()` are applied BEFORE middleware — the
 * ordering `proxy.ts`'s CSP depends on. Reimplementing `startServer` to get in
 * front of it would mean reimplementing that, plus the SIGINT/SIGTERM cleanup
 * with its 130/143 exit codes, the `PORT`/`__NEXT_PRIVATE_ORIGIN` assignments,
 * the memory-restart check and the init-failure `process.exit(1)`. Every one of
 * those is a thing to get subtly wrong on a Next upgrade.
 *
 * So this module does not replace the server. It takes the one that
 * `startServer` is about to create, and swaps the request listener for a wrapped
 * one. `installIngress()` must therefore run BEFORE `startServer` — which is
 * what `ingress/server.mjs` is for.
 *
 * The seam is a patch of `http.createServer`, and it is a seam: if a future Next
 * builds its server some other way, the patch captures nothing. That is why
 * `assertInstalled()` exists and why `src/infrastructure/config/startupGate.ts`
 * refuses to serve in production when this module has not marked itself
 * installed. The failure mode is a process that exits, not a process that serves
 * 120 MB of anonymous request body.
 *
 * ## What the wrapper does
 *
 * Two things, both from the request line and headers only:
 *
 *   1. Refuses a body the path is not allowed to carry (`policy.mjs`), before
 *      Next is invoked at all. Next never sees the request, so there is no
 *      second response to collide with, no body parser to have already started,
 *      and no route to have been resolved.
 *   2. Refuses everything with 503 until the single-instance lease is held. A
 *      second process against the same database is refused before it serves a
 *      single request rather than after.
 *
 * A request that is allowed is passed to Next's own listener unchanged and
 * unread. Nothing here touches `req.body`, attaches a `'data'` listener or
 * pauses the stream, so a legitimate request is byte-identical to one from
 * before this file existed — including the five streaming upload paths, which
 * the policy passes through untouched.
 *
 * `'checkContinue'` is handled too, so a client that asks `Expect: 100-continue`
 * is refused before it sends a byte instead of after. Without a listener Node
 * writes the `100 Continue` itself and then emits `'request'`, which means the
 * refusal arrives one body-transfer later.
 */

import http from "node:http";

import { ingressDecision } from "./policy.mjs";

const STATE_KEY = "__PDFDADI_INGRESS__";

/**
 * One object, shared by the three things that need it: this guard, the startup
 * gate that acquires the lease (compiled into the Next bundle, so a different
 * module instance — hence a global rather than module scope), and
 * `/api/health/ready`.
 *
 * `lease` is "pending" until the gate has had its say. The guard answers 503
 * while it is anything but "held", so the window between binding the port and
 * proving single-instance ownership serves no traffic.
 */
export const ingressState = (globalThis[STATE_KEY] ??= {
  installed: false,
  lease: "pending",
  leaseDetail: "not yet acquired",
  refusals: { body: 0, unready: 0 },
});

/** Header timeout, and the whole-request timeout, owned here rather than defaulted. */
const HEADERS_TIMEOUT_MS = 20_000;
/**
 * Node's own default, set explicitly so it is a decision. It bounds a slow or
 * stalled body — including a class C upload, which is why it is not tightened:
 * 100 MiB over a slow link is a legitimate request that takes minutes.
 */
const REQUEST_TIMEOUT_MS = 300_000;

/**
 * Write a refusal and close the connection.
 *
 * `Connection: close` is what stops the transfer: once the response has finished
 * without the request body being read, Node marks the request dumped and drops
 * further chunks, and closing the socket stops the client sending them at all.
 * Without it a refused 100 MiB body is still read and discarded — bounded in
 * memory, but paid for in bandwidth.
 *
 * The body is deliberately identical in shape for every path and every class, so
 * it cannot be used to tell an existing route from a nonexistent one.
 */
function refuse(res, decision) {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify({ error: decision.message });
  res.writeHead(decision.status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(body);
}

/**
 * One refusal for every non-serving lease status. Deliberately says nothing about
 * which status it is: "starting", "another instance holds the lease" and "our lease
 * was taken" are all operationally different and none of them is an anonymous
 * client's business. The operator reads the difference in the startup log and in
 * `/api/health/ready`'s `instance` field.
 */
const UNREADY = {
  status: 503,
  code: "UNAVAILABLE",
  message: "Server is not accepting requests.",
};

/**
 * The two lease statuses that may serve traffic. `held` is the production answer;
 * `disabled` is a non-production process, where there is nothing to exclude. Every
 * other status — `pending` during startup, `refused` for a second instance, `lost`
 * after a contender took over, `released` while draining — refuses.
 */
const SERVING = new Set(["held", "disabled"]);

/**
 * The decision for one request: `null` to pass it to Next.
 *
 * Exported for the tests, which drive it with plain header objects — the same
 * inputs Node gives the listener, without needing a socket.
 */
export function guardDecision(req) {
  if (!SERVING.has(ingressState.lease)) {
    ingressState.refusals.unready += 1;
    return UNREADY;
  }
  const decision = ingressDecision({ url: req.url ?? "/", headers: req.headers ?? {} });
  if (decision) ingressState.refusals.body += 1;
  return decision;
}

/**
 * Swap `server`'s request listener for the guarded one, and own its timeouts.
 *
 * Uses only `EventEmitter` API on the server: the listener Next installed is
 * removed and re-added inside the wrapper, so on the pass-through path Next's
 * listener is called with exactly the arguments it would have received.
 */
function guardServer(server) {
  const listeners = server.listeners("request");
  if (listeners.length !== 1) {
    throw new Error(
      `[ingress] expected exactly one 'request' listener on the server, found ${listeners.length}`,
    );
  }
  const inner = listeners[0];
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    const decision = guardDecision(req);
    if (decision) return refuse(res, decision);
    return inner.call(server, req, res);
  });

  // Refuse before the client is invited to send the body, not after.
  server.on("checkContinue", (req, res) => {
    const decision = guardDecision(req);
    if (decision) return refuse(res, decision);
    res.writeContinue();
    server.emit("request", req, res);
  });

  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}

/**
 * Patch `http.createServer` so the next server created is guarded, then restore
 * it. Scoped to one creation: nothing else in the process gets a patched `http`,
 * and a second `createServer` call (there is none in this path) is unaffected.
 */
let patching = false;

export function installIngress() {
  // Idempotent in both windows: after a server exists (`installed`), and before one
  // does (`patching`). Without the second flag two calls at boot would each capture
  // the other's patch as "the original", so the first server would be wrapped twice
  // and `http.createServer` would be left permanently patched.
  if (ingressState.installed || patching) return;
  patching = true;
  const original = http.createServer;
  let captured = false;
  http.createServer = function patched(...args) {
    const server = original.apply(this, args);
    if (!captured) {
      captured = true;
      patching = false;
      http.createServer = original;
      guardServer(server);
      ingressState.installed = true;
    }
    return server;
  };
}

/**
 * Fail loudly if the patch never fired — a Next that stopped using
 * `http.createServer` would otherwise leave the process serving unguarded.
 * Called from `ingress/server.mjs` once the server is listening.
 */
export function assertInstalled() {
  if (!ingressState.installed) {
    throw new Error(
      "[ingress] the request guard was never installed: no http.Server was created " +
        "through http.createServer. Refusing to serve unguarded.",
    );
  }
}

/**
 * Stop serving, let go of the lease, and hold the exit until that lands.
 *
 * Registered from `ingress/server.mjs` BEFORE the Next entry is loaded, because
 * Node runs signal listeners in registration order and Next's own handler ends the
 * process. `proc` and `exitGraceMs` are parameters only so the tests can drive this
 * without signalling the test runner.
 */
export const RELEASE_EXIT_GRACE_MS = 1_500;

export function installShutdown(proc = process, exitGraceMs = RELEASE_EXIT_GRACE_MS) {
  let shuttingDown = false;
  let releasing = null;

  function drain(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    const release = ingressState.release;
    if (typeof release !== "function") {
      // No lease was ever started (development, or a boot that failed before it):
      // stop serving anyway, so a signal during startup cannot leave the guard open.
      ingressState.lease = "released";
      ingressState.leaseDetail = `released on ${signal}`;
      return;
    }
    /*
     * The status is NOT set here first, and that ordering is the whole content of
     * this branch: `releaseInstanceLease` decides whether to delete the row by
     * reading `lease === "held"`, and it flips the status to "released" itself,
     * synchronously, before it awaits the delete. Setting it here first made the
     * function believe the lease had never been held, so it skipped the delete and
     * every clean SIGTERM behaved like a crash — the next process then waited out
     * the full TTL. Serving stops either way; only the row's fate differed.
     */
    releasing = Promise.resolve()
      .then(release)
      .then(
        () => console.info(`[ingress] ${signal}: single-instance lease released.`),
        (err) => console.warn(`[ingress] ${signal}: lease release failed: ${err}`),
      );
  }

  /*
   * Hold the exit — during shutdown only, and briefly.
   *
   * Next's own signal handler ends with `process.exit(143)` and knows nothing about
   * the lease. The release is a database round trip, and it loses that race about
   * half the time: the row survives, a clean stop looks exactly like a crash, and
   * the next process waits out the full TTL instead of starting at once. Nothing
   * else fixes it from here — this handler runs first, but it cannot lengthen
   * Next's await, and `process.exit` is specified not to wait for pending work.
   *
   * The cap matters as much as the wait: a database that has stopped answering must
   * not stop the process from stopping, and the TTL is already the backstop for a
   * release that never lands. Patched only while `releasing` is set, so every other
   * exit in the process — the startup gate's `exit(1)` included — is the real one.
   */
  const realExit = proc.exit.bind(proc);
  proc.exit = (code) => {
    if (!releasing) return realExit(code);
    const pending = releasing;
    releasing = null;
    const capped = setTimeout(() => realExit(code), exitGraceMs);
    void pending.finally(() => {
      clearTimeout(capped);
      realExit(code);
    });
    return undefined;
  };

  proc.on("SIGTERM", () => drain("SIGTERM"));
  proc.on("SIGINT", () => drain("SIGINT"));
  return drain;
}
