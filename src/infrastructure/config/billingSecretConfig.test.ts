import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { _resetConfigForTests, getConfig } from "./env";

/**
 * The configuration audit for the Stripe variables, as tests rather than as a note
 * in a doc.
 *
 * Two of these fail silently and expensively:
 *
 *  1. **Server-only.** Next.js inlines any `NEXT_PUBLIC_`-prefixed variable into
 *     the client bundle. A published `STRIPE_SECRET_KEY` can move money and read
 *     every customer; a published `STRIPE_WEBHOOK_SECRET` lets anyone forge a
 *     "subscription active" event and grant themselves Pro. A rename is all it
 *     takes, so the prefix is asserted against rather than remembered.
 *  2. **All-or-nothing.** A secret key with no webhook secret takes money it can
 *     never confirm; a secret key with no price has nothing to sell. Both are
 *     "not configured", and a truthiness bug here is a checkout that half works.
 */

const SECRETS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] as const;
/** The variables this deployment actually reads — and therefore must document. */
const NAMES = [...SECRETS, "STRIPE_PRICE_PRO"] as const;
/**
 * Cleared before every case, never set: `STRIPE_PRICE_BUSINESS` was removed with
 * the deferral of Business billing. It is listed here so a leftover value in a
 * developer's shell cannot influence what `getConfig()` builds — and it is
 * deliberately NOT in `NAMES`, because a variable the schema no longer has must
 * not be documented as if an operator could set it.
 */
const CLEARED = [...NAMES, "STRIPE_PRICE_BUSINESS"] as const;

function read(...segments: string[]): string {
  return readFileSync(path.join(process.cwd(), ...segments), "utf8");
}

/** Every non-test source file under the app's own directories naming `needle`. */
function sourceFilesContaining(needle: string): string[] {
  const roots = ["app", "components", "hooks", "lib", "src", "data"];
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(rel);
      } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && !entry.name.includes(".test.")) {
        if (readFileSync(path.join(process.cwd(), rel), "utf8").includes(needle)) found.push(rel);
      }
    }
  };
  for (const root of roots) walk(root);
  return found.sort();
}

const originalEnv = { ...process.env };

afterEach(() => {
  for (const name of CLEARED) delete process.env[name];
  for (const [key, value] of Object.entries(originalEnv)) {
    if (NAMES.includes(key as (typeof NAMES)[number]) && value !== undefined) process.env[key] = value;
  }
  _resetConfigForTests();
});

function configWith(env: Partial<Record<(typeof NAMES)[number], string>>) {
  for (const name of CLEARED) delete process.env[name];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  _resetConfigForTests();
  return getConfig().billing;
}

describe("billing config is server-only", () => {
  it("has no NEXT_PUBLIC_ variant anywhere in the source", () => {
    for (const name of NAMES) {
      expect(sourceFilesContaining(`NEXT_PUBLIC_${name}`)).toEqual([]);
    }
    expect(sourceFilesContaining("NEXT_PUBLIC_STRIPE")).toEqual([]);
  });

  it("reads each secret in exactly one place", () => {
    // One reader means one thing to audit. A second one is how a secret ends up in
    // a client component by way of a "convenient" helper.
    for (const name of SECRETS) {
      expect(sourceFilesContaining(name)).toEqual(["src/infrastructure/config/env.ts"]);
    }
  });

  it("keeps the config module out of client components", () => {
    expect(read("src/infrastructure/config/env.ts").startsWith('"use client"')).toBe(false);
    for (const file of sourceFilesContaining("STRIPE_PRICE_PRO")) {
      expect(read(file).startsWith('"use client"'), file).toBe(false);
    }
  });

  it("never puts a secret value in the checked-in docs", () => {
    // Live-key shapes, not the variable names. A committed sk_live_ is a rotation
    // and an incident, so this asserts on the value shape rather than trusting a
    // reviewer to spot one.
    for (const doc of [".env.example", "SERVER_SETUP.md", "docs/PDFDADI_FEATURE_LEDGER.md"]) {
      const text = read(doc);
      expect(text, doc).not.toMatch(/sk_(live|test)_[A-Za-z0-9]{8,}/);
      expect(text, doc).not.toMatch(/whsec_[A-Za-z0-9]{16,}/);
      expect(text, doc).not.toMatch(/\bprice_[A-Za-z0-9]{14,}/);
    }
  });
});

describe("billing config is documented", () => {
  it("names every variable in the environment example", () => {
    const example = read(".env.example");
    for (const name of NAMES) expect(example, name).toContain(name);
    // And says why the prefix must not be added, since that is the failure that
    // cannot be undone by editing a config.
    expect(example).toContain("NEXT_PUBLIC_");
  });

  it("names every variable in the deployment guide, with the webhook endpoint", () => {
    const guide = read("SERVER_SETUP.md");
    for (const name of NAMES) expect(guide, name).toContain(name);
    expect(guide).toContain("/api/billing/webhook");
    // The consequence of skipping the webhook: checkout completes and nobody is
    // upgraded. An operator has to be able to read that here.
    expect(guide).toMatch(/customer\.subscription\.(created|updated|deleted)/);
  });
});

describe("billing enablement", () => {
  it("is disabled when nothing is set", () => {
    const billing = configWith({});
    expect(billing).toMatchObject({
      enabled: false, provider: "stripe", secretKey: null, webhookSecret: null,
    });
    expect(billing.prices).toEqual({ pro: null });
  });

  it("is disabled with a key but no webhook secret", () => {
    // Taking money it could never confirm.
    expect(configWith({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_PRO: "price_x" }).enabled).toBe(false);
  });

  it("is disabled with a key and webhook secret but no price", () => {
    // Nothing to sell — and the alternative is inventing a price.
    expect(configWith({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" }).enabled).toBe(false);
  });

  it("is enabled with a key, a webhook secret and one price", () => {
    const billing = configWith({
      STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_PRICE_PRO: "price_pro",
    });
    expect(billing.enabled).toBe(true);
    expect(billing.prices).toEqual({ pro: "price_pro" });
  });

  it("treats whitespace as unset", () => {
    const billing = configWith({
      STRIPE_SECRET_KEY: "  ", STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_PRICE_PRO: " price_pro ",
    });
    expect(billing.enabled).toBe(false);
    expect(billing.secretKey).toBeNull();
    // …and trims a value that IS set, so a copy-paste newline does not become part
    // of a price id and silently unmap every subscription.
    expect(billing.prices.pro).toBe("price_pro");
  });

  it("does not refuse to boot when billing is absent", () => {
    // The whole point of optional: a deployment with no Stripe account must still
    // start, and every other config value must still resolve.
    const config = (() => { configWith({}); return getConfig(); })();
    expect(config.billing.enabled).toBe(false);
    expect(config.siteUrl).toBeTruthy();
  });
});
