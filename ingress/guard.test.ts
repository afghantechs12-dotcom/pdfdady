import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertInstalled,
  guardDecision,
  ingressState,
  installIngress,
  installShutdown,
} from "./guard.mjs";

/**
 * The guard itself: the lease gate, and the seam that installs it.
 *
 * The seam is tested against a real `http.Server` rather than a mock, because the
 * thing that could break it is Next building its server differently — and a mock
 * of `http.createServer` would agree with itself no matter what Node does.
 */

const asRequest = (url: string, headers: Record<string, string> = {}) =>
  ({ url, headers }) as unknown as http.IncomingMessage;

afterEach(() => {
  ingressState.lease = "disabled";
  delete ingressState.release;
});

/**
 * A stand-in for `process`, so a test can fire a signal and watch an exit without
 * signalling the test runner or ending it.
 */
function fakeProc() {
  const listeners: Record<string, Array<() => void>> = {};
  const exits: number[] = [];
  return {
    exits,
    exit(code: number) {
      exits.push(code);
    },
    on(signal: string, fn: () => void) {
      (listeners[signal] ??= []).push(fn);
      return this;
    },
    fire(signal: string) {
      for (const fn of listeners[signal] ?? []) fn();
    },
  };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("the lease gate", () => {
  it("serves only while the lease is held, or when there is nothing to exclude", () => {
    for (const lease of ["held", "disabled"]) {
      ingressState.lease = lease;
      expect(guardDecision(asRequest("/")), lease).toBeNull();
    }
    for (const lease of ["pending", "refused", "lost", "released"]) {
      ingressState.lease = lease;
      expect(guardDecision(asRequest("/"))?.status, lease).toBe(503);
    }
  });

  it("refuses every path identically while not serving, disclosing nothing", () => {
    ingressState.lease = "refused";
    const shapes = ["/", "/api/health", "/admin", "/does-not-exist"].map((p) =>
      JSON.stringify(guardDecision(asRequest(p))),
    );
    for (const shape of shapes) expect(shape).toBe(shapes[0]);
    // Not "another instance holds the lease": the reason is for the operator's log.
    expect(shapes[0]).not.toMatch(/lease|instance|holder|standby|database/i);
  });

  it("counts refusals by reason", () => {
    ingressState.lease = "held";
    const before = { ...ingressState.refusals };
    guardDecision(asRequest("/", { "content-length": "999999999" }));
    ingressState.lease = "pending";
    guardDecision(asRequest("/"));
    expect(ingressState.refusals.body).toBe(before.body + 1);
    expect(ingressState.refusals.unready).toBe(before.unready + 1);
  });
});

/** One live server through the real seam, torn down by the caller. */
async function guardedServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  installIngress();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "x-inner": "reached" });
    res.end("inner");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("the installation seam", () => {
  it("wraps the server Next creates, refusing bodies and passing everything else through", async () => {
    ingressState.installed = false;
    const { origin, close } = await guardedServer();
    try {
      expect(ingressState.installed).toBe(true);
      assertInstalled();
      ingressState.lease = "held";

      const passed = await fetch(`${origin}/`);
      expect(passed.status).toBe(200);
      expect(passed.headers.get("x-inner")).toBe("reached");

      const refused = await fetch(`${origin}/`, { method: "POST", body: "x".repeat(64) });
      expect(refused.status).toBe(413);
      // Written by the guard: the inner listener never ran, so its header is absent.
      expect(refused.headers.get("x-inner")).toBeNull();
      expect(await refused.json()).toEqual({ error: "Request body is too large." });

      /*
       * The same, as a GET. Node parses a body on any method, so a seam that
       * consulted `req.method` before the policy would leave `GET /` with a
       * 100 MiB body on the retained path — and `ingressDecision`'s own
       * method-agnostic test cannot see that, because it never runs through the
       * seam. `fetch` refuses to send a GET body, hence the raw request.
       */
      const getWithBody = await new Promise<{ status: number; inner: unknown }>(
        (resolve, reject) => {
          const r = http.request(
            `${origin}/`,
            { method: "GET", headers: { "content-length": "64" } },
            (res) => {
              res.resume();
              resolve({ status: res.statusCode ?? 0, inner: res.headers["x-inner"] ?? null });
            },
          );
          r.on("error", reject);
          r.end("x".repeat(64));
        },
      );
      expect(getWithBody.status).toBe(413);
      expect(getWithBody.inner).toBeNull();

      ingressState.lease = "refused";
      const unready = await fetch(`${origin}/`);
      expect(unready.status).toBe(503);
      expect(unready.headers.get("x-inner")).toBeNull();
    } finally {
      await close();
    }
  });

  it("restores http.createServer, so only the first server is patched", async () => {
    ingressState.installed = false;
    const original = http.createServer;
    installIngress();
    expect(http.createServer).not.toBe(original);
    const { close } = await guardedServer();
    await close();
    expect(http.createServer).toBe(original);
  });

  it("refuses to claim installation when no server was ever created", () => {
    ingressState.installed = false;
    expect(() => assertInstalled()).toThrow(/never installed/);
  });
});

describe("shutdown", () => {
  it("calls the release while the lease still reads held, not after", async () => {
    /*
     * The regression this exists for. `releaseInstanceLease` deletes the row only
     * when it sees `lease === "held"`, so a caller that flips the status to
     * "released" first turns every clean stop into a crash as far as the next
     * process is concerned: the row survives and the standby waits out the full
     * TTL. Live proof is the singleton probe's S7 (435ms vs 12.5s); this is the
     * same fact where a unit test can hold it.
     */
    const proc = fakeProc();
    installShutdown(proc as unknown as NodeJS.Process);
    let seen: string | undefined;
    ingressState.lease = "held";
    ingressState.release = async () => {
      seen = ingressState.lease;
    };

    proc.fire("SIGTERM");
    await tick();
    expect(seen).toBe("held");
  });

  it("holds the exit until the release settles, then exits with the given code", async () => {
    const proc = fakeProc();
    installShutdown(proc as unknown as NodeJS.Process);
    let finish: () => void = () => {};
    ingressState.lease = "held";
    ingressState.release = () => new Promise<void>((resolve) => (finish = resolve));

    proc.fire("SIGTERM");
    // Next's own handler, which ends the process without knowing about the lease.
    proc.exit(143);
    await tick();
    expect(proc.exits, "exited before the release landed").toEqual([]);

    finish();
    await tick();
    expect(proc.exits).toEqual([143]);
  });

  it("exits anyway when the release never settles", async () => {
    // A database that has stopped answering must not stop the process from
    // stopping. The lease TTL is the backstop for the row left behind.
    const proc = fakeProc();
    installShutdown(proc as unknown as NodeJS.Process, 20);
    ingressState.lease = "held";
    ingressState.release = () => new Promise<void>(() => {});

    proc.fire("SIGTERM");
    proc.exit(143);
    await tick(60);
    expect(proc.exits).toEqual([143]);
  });

  it("stops serving even when there is no lease to release", () => {
    // A signal during startup, before `startInstanceLease` ran: nothing to delete,
    // but the guard must still refuse rather than keep the door open.
    const proc = fakeProc();
    installShutdown(proc as unknown as NodeJS.Process);
    ingressState.lease = "held";

    proc.fire("SIGINT");
    expect(ingressState.lease).toBe("released");
  });

  it("leaves every exit outside a shutdown alone", () => {
    // The startup gate's `process.exit(1)` runs through this same patched function.
    const proc = fakeProc();
    installShutdown(proc as unknown as NodeJS.Process);
    proc.exit(1);
    expect(proc.exits).toEqual([1]);
  });
});
