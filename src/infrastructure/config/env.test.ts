import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getConfig, _resetConfigForTests } from "./env";
import { ConfigurationError } from "@/src/domain/errors";
import { INSECURE_DEV_SECRET } from "@/lib/admin/session";

// `process.env` types some well-known keys as readonly; cast to writable.
const env = process.env as unknown as Record<string, string | undefined>;
const KEYS = [
  "NODE_ENV",
  "NEXT_PHASE",
  "ADMIN_SECRET",
  "PDFDADI_ALLOW_INSECURE_DEV_SECRET",
  "NEXT_PUBLIC_SITE_URL",
  "DATABASE_URL",
  "LOG_LEVEL",
  "TOOLS_MAX_CONCURRENCY",
  "TOOLS_RATE_LIMIT_PER_MIN",
  "TOOLS_MAX_BODY_BYTES",
  "STORAGE_SIGNING_SECRET",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_PRO",
  "REDIS_URL",
] as const;
const ORIG: Record<string, string | undefined> = {};

beforeEach(() => {
  // Remember AND clear. Without the clear, a variable inherited from the
  // developer's shell (or a real .env) would decide whether the production gate
  // fires, so the suite would pass or fail depending on whose machine ran it.
  for (const k of KEYS) {
    ORIG[k] = env[k];
    delete env[k];
  }
  _resetConfigForTests();
});

afterEach(() => {
  for (const k of KEYS) {
    if (ORIG[k] === undefined) delete env[k];
    else env[k] = ORIG[k];
  }
  _resetConfigForTests();
});

/**
 * A minimal production environment that the gate accepts. Individual tests break
 * exactly one thing from here, so each assertion is about the variable it names
 * and nothing else.
 */
const GOOD_SECRET = "0123456789abcdef0123456789abcdef";

function setValidProductionEnv(): void {
  env.NODE_ENV = "production";
  env.DATABASE_URL = "postgresql://u:p@db.internal:5432/pdfdadi";
  env.ADMIN_SECRET = GOOD_SECRET;
  env.NEXT_PUBLIC_SITE_URL = "https://pdfdadi.com";
}

/** The gate's message, or "" when the gate let the config through. */
function gateError(): string {
  try {
    getConfig();
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe("env config", () => {
  it("uses dev defaults when DATABASE_URL is unset in non-production", () => {
    delete env.NODE_ENV;
    delete env.DATABASE_URL;
    const cfg = getConfig();
    expect(cfg.isProduction).toBe(false);
    expect(cfg.isDev).toBe(true);
    expect(cfg.databaseUrl).toBe("file:./prisma/dev.db");
    expect(cfg.toolsMaxConcurrency).toBe(4);
    expect(cfg.toolsRateLimitPerMin).toBe(20);
    expect(cfg.logLevel).toBe("info");
  });

  it("requires DATABASE_URL in production", () => {
    env.NODE_ENV = "production";
    delete env.DATABASE_URL;
    expect(() => getConfig()).toThrow(ConfigurationError);
  });

  it("accepts a DATABASE_URL in production (e.g. PostgreSQL)", () => {
    setValidProductionEnv();
    env.DATABASE_URL = "postgresql://user:pass@host:5432/db";
    const cfg = getConfig();
    expect(cfg.isProduction).toBe(true);
    expect(cfg.databaseUrl).toBe("postgresql://user:pass@host:5432/db");
  });

  it("coerces numeric env vars", () => {
    delete env.NODE_ENV;
    delete env.DATABASE_URL;
    env.TOOLS_MAX_CONCURRENCY = "8";
    env.TOOLS_RATE_LIMIT_PER_MIN = "50";
    const cfg = getConfig();
    expect(cfg.toolsMaxConcurrency).toBe(8);
    expect(cfg.toolsRateLimitPerMin).toBe(50);
  });

  it("rejects an invalid LOG_LEVEL", () => {
    delete env.NODE_ENV;
    env.LOG_LEVEL = "verbose";
    expect(() => getConfig()).toThrow(ConfigurationError);
  });
});

describe("production configuration gate", () => {
  it("accepts a fully configured production deployment", () => {
    setValidProductionEnv();
    const cfg = getConfig();
    expect(cfg.isProduction).toBe(true);
    expect(cfg.siteUrl).toBe("https://pdfdadi.com");
  });

  it("refuses production without ADMIN_SECRET", () => {
    setValidProductionEnv();
    delete env.ADMIN_SECRET;
    expect(gateError()).toMatch(/ADMIN_SECRET is not set/);
  });

  it("refuses the public dev fallback as ADMIN_SECRET in production", () => {
    setValidProductionEnv();
    env.ADMIN_SECRET = INSECURE_DEV_SECRET;
    expect(gateError()).toMatch(/public development fallback/);
  });

  it("refuses an ADMIN_SECRET below the production length floor", () => {
    setValidProductionEnv();
    env.ADMIN_SECRET = "shortpw12"; // passes session.ts's floor of 8, not the gate's
    expect(gateError()).toMatch(/ADMIN_SECRET is shorter than/);
  });

  it("refuses the insecure-dev-secret escape hatch in production", () => {
    setValidProductionEnv();
    env.PDFDADI_ALLOW_INSECURE_DEV_SECRET = "1";
    expect(gateError()).toMatch(/PDFDADI_ALLOW_INSECURE_DEV_SECRET/);
  });

  it("refuses a short STORAGE_SIGNING_SECRET but allows it unset", () => {
    setValidProductionEnv();
    env.STORAGE_SIGNING_SECRET = "tooshort";
    expect(gateError()).toMatch(/STORAGE_SIGNING_SECRET/);

    _resetConfigForTests();
    delete env.STORAGE_SIGNING_SECRET;
    // Unset falls back to ADMIN_SECRET, which the gate has already vetted.
    expect(getConfig().storage.signingSecret).toBe(GOOD_SECRET);
  });

  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://0.0.0.0:3000"])(
    "refuses a loopback NEXT_PUBLIC_SITE_URL in production (%s)",
    (url) => {
      setValidProductionEnv();
      env.NEXT_PUBLIC_SITE_URL = url;
      expect(gateError()).toMatch(/loopback host/);
    },
  );

  it("refuses a NEXT_PUBLIC_SITE_URL that is not an absolute URL", () => {
    setValidProductionEnv();
    env.NEXT_PUBLIC_SITE_URL = "pdfdadi.com";
    expect(gateError()).toMatch(/not a valid absolute URL/);
  });

  it("refuses half-configured object storage, naming the missing variables", () => {
    setValidProductionEnv();
    env.R2_ACCOUNT_ID = "acct";
    env.R2_BUCKET = "bucket";
    const msg = gateError();
    expect(msg).toMatch(/half-configured/);
    expect(msg).toContain("R2_ACCESS_KEY_ID");
    expect(msg).toContain("R2_SECRET_ACCESS_KEY");
  });

  it("accepts fully configured R2, and accepts none at all (local storage)", () => {
    setValidProductionEnv();
    env.R2_ACCOUNT_ID = "acct";
    env.R2_ACCESS_KEY_ID = "akid";
    env.R2_SECRET_ACCESS_KEY = "secret";
    env.R2_BUCKET = "bucket";
    expect(getConfig().storage.provider).toBe("r2");

    _resetConfigForTests();
    for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) {
      delete env[k];
    }
    expect(getConfig().storage.provider).toBe("local");
  });

  it("reports every problem at once rather than one per restart", () => {
    env.NODE_ENV = "production";
    // Nothing else set: DATABASE_URL, ADMIN_SECRET and the site URL are all bad.
    const msg = gateError();
    expect(msg).toMatch(/DATABASE_URL/);
    expect(msg).toMatch(/ADMIN_SECRET/);
    expect(msg).toMatch(/NEXT_PUBLIC_SITE_URL/);
    expect(msg).toMatch(/3 production configuration problems/);
  });

  it("never echoes a secret value into the error message", () => {
    // Every secret below is deliberately invalid, so each one is mentioned by
    // the gate. The gate must name the VARIABLE and never print the VALUE —
    // this text lands in logs and error trackers.
    env.NODE_ENV = "production";
    env.DATABASE_URL = "postgresql://dbuser:sup3rs3cr3t@db.internal:5432/pdfdadi";
    env.ADMIN_SECRET = "leakyadmin1";
    env.STORAGE_SIGNING_SECRET = "leakysign1";
    env.NEXT_PUBLIC_SITE_URL = "http://localhost:3000";
    const msg = gateError();
    expect(msg).not.toBe("");
    for (const secret of ["sup3rs3cr3t", "leakyadmin1", "leakysign1", "dbuser"]) {
      expect(msg).not.toContain(secret);
    }
  });

  it("stays out of the way during `next build`, which also sets NODE_ENV=production", () => {
    // A build has no deployment secrets and must stay hermetic: CI compiles
    // without production credentials. Only a serving process is gated.
    env.NODE_ENV = "production";
    env.NEXT_PHASE = "phase-production-build";
    expect(() => getConfig()).not.toThrow();
  });

  it("does not gate non-production environments", () => {
    delete env.NODE_ENV;
    const cfg = getConfig();
    expect(cfg.isProduction).toBe(false);
    expect(cfg.databaseUrl).toBe("file:./prisma/dev.db");
  });
});

describe("production gate: optional features stay optional", () => {
  it("starts with no billing configuration at all", () => {
    setValidProductionEnv();
    const cfg = getConfig();
    expect(cfg.billing.enabled).toBe(false);
  });

  it.each([
    ["STRIPE_SECRET_KEY"],
    ["STRIPE_WEBHOOK_SECRET"],
    ["STRIPE_PRICE_PRO"],
  ])("starts with only %s set — partial billing must never block boot", (key) => {
    setValidProductionEnv();
    env[key] = "partial-value";
    const cfg = getConfig();
    expect(cfg.billing.enabled).toBe(false);
  });

  it("starts with no REDIS_URL, selecting the in-process queue", () => {
    setValidProductionEnv();
    const cfg = getConfig();
    expect(cfg.queue.provider).toBe("memory");
  });

  it("enables billing only when all three Stripe values are present", () => {
    setValidProductionEnv();
    env.STRIPE_SECRET_KEY = "sk_live_x";
    env.STRIPE_WEBHOOK_SECRET = "whsec_x";
    env.STRIPE_PRICE_PRO = "price_x";
    expect(getConfig().billing.enabled).toBe(true);
  });
});
