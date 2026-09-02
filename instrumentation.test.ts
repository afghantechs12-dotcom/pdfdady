import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "./instrumentation";
import { _resetConfigForTests } from "@/src/infrastructure/config/env";

/**
 * The startup hook is pure wiring, and wiring is exactly where a green policy
 * suite stops protecting anything: `productionProblems` can be perfect while the
 * hook that runs it does nothing. These tests exercise `register()` itself.
 */
const env = process.env as unknown as Record<string, string | undefined>;
const KEYS = [
  "NODE_ENV",
  "NEXT_RUNTIME",
  "NEXT_PHASE",
  "ADMIN_SECRET",
  "DATABASE_URL",
  "NEXT_PUBLIC_SITE_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_PRO",
] as const;
const ORIG: Record<string, string | undefined> = {};

const SECRET = "0123456789abcdef0123456789abcdef";

beforeEach(() => {
  for (const k of KEYS) {
    ORIG[k] = env[k];
    delete env[k];
  }
  _resetConfigForTests();
  // register() short-circuits on any runtime but nodejs; every test below wants
  // the Node path, so opt in explicitly rather than relying on the ambient value.
  env.NEXT_RUNTIME = "nodejs";
});

afterEach(() => {
  for (const k of KEYS) {
    if (ORIG[k] === undefined) delete env[k];
    else env[k] = ORIG[k];
  }
  _resetConfigForTests();
  vi.restoreAllMocks();
});

function setValidProductionEnv(): void {
  env.NODE_ENV = "production";
  // Absolute SQLite file: what `provider = "sqlite"` can open, and what the
  // production gate now requires. See env.test.ts for why it was a Postgres URL.
  env.DATABASE_URL = "file:/srv/pdfdadi/data/pdfdadi.db";
  env.ADMIN_SECRET = SECRET;
  env.NEXT_PUBLIC_SITE_URL = "https://pdfdadi.com";
}

/** Mocks the three sinks register() writes to, plus process.exit. */
function captureConsole() {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  // Must be mocked: the real one would kill the vitest worker.
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as unknown as typeof process.exit);
  const text = () =>
    [info, warn, error]
      .flatMap((spy) => spy.mock.calls.flat())
      .map(String)
      .join("\n");
  return { info, warn, error, exit, text };
}

describe("instrumentation register()", () => {
  it("logs a startup summary and does not exit on a valid production config", async () => {
    setValidProductionEnv();
    const c = captureConsole();
    await register();
    expect(c.exit).not.toHaveBeenCalled();
    expect(c.error).not.toHaveBeenCalled();
    expect(c.info).toHaveBeenCalledOnce();
    expect(c.text()).toMatch(/configuration OK/);
  });

  it("exits non-zero on a misconfigured production deployment", async () => {
    // Production with nothing else set: the gate has three complaints.
    env.NODE_ENV = "production";
    const c = captureConsole();
    // process.exit is mocked, so control falls through to the rethrow — which is
    // itself the safety net if exit were ever unavailable.
    await expect(register()).rejects.toThrow(/Refusing to start/);
    expect(c.exit).toHaveBeenCalledWith(1);
    expect(c.text()).toMatch(/refused to start/);
    // The operator gets the whole list at boot, not one problem per restart.
    expect(c.text()).toMatch(/DATABASE_URL/);
    expect(c.text()).toMatch(/ADMIN_SECRET/);
    expect(c.text()).toMatch(/NEXT_PUBLIC_SITE_URL/);
  });

  it("does nothing outside the Node runtime", async () => {
    env.NEXT_RUNTIME = "edge";
    env.NODE_ENV = "production"; // would otherwise fail the gate
    const c = captureConsole();
    await register();
    expect(c.exit).not.toHaveBeenCalled();
    expect(c.info).not.toHaveBeenCalled();
    expect(c.error).not.toHaveBeenCalled();
  });

  it("never prints a secret value in the startup summary", async () => {
    setValidProductionEnv();
    env.STRIPE_SECRET_KEY = "sk_live_leakme";
    env.STRIPE_WEBHOOK_SECRET = "whsec_leakme";
    env.STRIPE_PRICE_PRO = "price_leakme";
    const c = captureConsole();
    await register();
    const text = c.text();
    for (const secret of [SECRET, "sk_live_leakme", "whsec_leakme", "/srv/pdfdadi"]) {
      expect(text).not.toContain(secret);
    }
    // It still reports the derived state, which is what an operator needs.
    expect(text).toMatch(/billing=enabled/);
    // The ENGINE, derived from the scheme the gate accepted — never the URL.
    expect(text).toMatch(/db=sqlite/);
  });

  it("warns but starts when billing is only half configured", async () => {
    setValidProductionEnv();
    env.STRIPE_SECRET_KEY = "sk_live_x"; // no webhook secret, no price
    const c = captureConsole();
    await register();
    expect(c.exit).not.toHaveBeenCalled();
    expect(c.warn).toHaveBeenCalledOnce();
    expect(c.text()).toMatch(/Billing is DISABLED/);
    expect(c.text()).toMatch(/configuration OK/);
  });

  it("stays quiet about billing when none of it is configured", async () => {
    setValidProductionEnv();
    const c = captureConsole();
    await register();
    expect(c.warn).not.toHaveBeenCalled();
    expect(c.text()).toMatch(/billing=disabled/);
  });

  it("stays quiet about billing when all of it is configured", async () => {
    // The other half of the warning's contract, and the half that decides whether
    // operators keep reading startup output at all: a correct deployment must not
    // be warned at it. A warning that fires on every good deploy is one everybody
    // learns to skip, including on the deploy where it was true.
    setValidProductionEnv();
    env.STRIPE_SECRET_KEY = "sk_test_x";
    env.STRIPE_WEBHOOK_SECRET = "whsec_x";
    env.STRIPE_PRICE_PRO = "price_x";
    const c = captureConsole();
    await register();
    expect(c.warn).not.toHaveBeenCalled();
    expect(c.text()).toMatch(/billing=enabled/);
  });
});
