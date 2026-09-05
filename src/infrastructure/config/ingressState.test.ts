import { afterEach, describe, expect, it, vi } from "vitest";

import { assertIngressInstalled, ingressState } from "@/src/infrastructure/config/ingressState";

/**
 * The fail-closed half of the fix: a production process that was started through
 * the wrong entry must not serve.
 *
 * `node .next/standalone/server.js` produces a server with no guard on it. Nothing
 * about that is visible from inside a request — the body has already been cloned by
 * then — so the only place to catch it is startup, and the only signal available is
 * whether `installIngress()` marked itself installed.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  ingressState().installed = false;
});

describe("assertIngressInstalled", () => {
  it("refuses a production process that was not started through ingress/server.mjs", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => assertIngressInstalled()).toThrow(/ingress guard is not installed/);
    // The message has to be actionable: an operator reading it in a container log
    // needs the command, not the diagnosis.
    expect(() => assertIngressInstalled()).toThrow(/node ingress\/server\.mjs/);
  });

  it("accepts a production process that was", () => {
    vi.stubEnv("NODE_ENV", "production");
    ingressState().installed = true;
    expect(() => assertIngressInstalled()).not.toThrow();
  });

  it("says nothing outside production, where `next dev` owns its own server", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(() => assertIngressInstalled()).not.toThrow();
  });
});

describe("the shared state object", () => {
  it("is one object per process, whichever module reaches it first", async () => {
    ingressState().lease = "held";
    // `ingress/guard.mjs` is loaded from disk, this module is compiled into the Next
    // bundle: two module instances, one state, which only works if both agree on the
    // globalThis key.
    const guard = await import("../../../ingress/guard.mjs");
    expect(guard.ingressState).toBe(ingressState());
    expect(guard.ingressState.lease).toBe("held");
  });
});
