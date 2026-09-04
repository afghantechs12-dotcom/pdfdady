import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetConfigForTests } from "@/src/infrastructure/config/env";

import {
  PROXY_SECRET_HEADER,
  _resetUploadLimitsForTests,
  checkUploadLimit,
  trustedClientAddress,
} from "./uploadRateLimit";

/**
 * The limiter's job is to answer before a body is read, so every test here is a
 * pure decision test — no server, no parse. What it must get right is WHOSE
 * budget is spent: a forgeable key would make the whole control decorative.
 */

const env = process.env as Record<string, string | undefined>;
const KEYS = [
  "UPLOAD_RATE_LIMIT_PER_MIN",
  "UPLOAD_ANON_RATE_LIMIT_PER_MIN",
  "UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN",
  "TRUSTED_PROXY_SECRET",
] as const;
const ORIG: Record<string, string | undefined> = {};

const SECRET = "proxy-secret-0123456789";

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/api/workspaces/w/documents/upload", {
    method: "POST",
    headers,
  });
}

beforeEach(() => {
  for (const k of KEYS) {
    ORIG[k] = env[k];
    delete env[k];
  }
  _resetConfigForTests();
  _resetUploadLimitsForTests();
});

afterEach(() => {
  for (const k of KEYS) {
    if (ORIG[k] === undefined) delete env[k];
    else env[k] = ORIG[k];
  }
  _resetConfigForTests();
  _resetUploadLimitsForTests();
});

describe("checkUploadLimit — whose budget is spent", () => {
  it("charges the session user, not the request headers", () => {
    env.UPLOAD_RATE_LIMIT_PER_MIN = "2";
    const spend = (userId: string) =>
      checkUploadLimit({ request: req({ "x-forwarded-for": "9.9.9.9" }), userId });

    expect(spend("u1").limited).toBe(false);
    expect(spend("u1").limited).toBe(false);
    const third = spend("u1");
    expect(third).toMatchObject({ limited: true, bucket: "user" });
    expect(third.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    // A second user is unaffected: the key is the user, not the address they share.
    expect(spend("u2").limited).toBe(false);
  });

  it("does not let anonymous traffic spend a signed-in user's budget", () => {
    env.UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN = "1";
    expect(checkUploadLimit({ request: req(), userId: null }).limited).toBe(false);
    expect(checkUploadLimit({ request: req(), userId: null }).limited).toBe(true);
    // The flood exhausted the global bucket; the user's own bucket is untouched.
    expect(checkUploadLimit({ request: req(), userId: "u1" }).limited).toBe(false);
  });

  it("collapses untrusted callers into one bucket that header rotation cannot escape", () => {
    env.UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN = "2";
    const rotate = (n: number) =>
      checkUploadLimit({
        request: req({ "x-forwarded-for": `10.0.0.${n}`, "x-real-ip": `10.1.0.${n}` }),
        userId: null,
      });
    expect(rotate(1).limited).toBe(false);
    expect(rotate(2).limited).toBe(false);
    const third = rotate(3);
    expect(third).toMatchObject({ limited: true, bucket: "global" });
  });

  it("ignores X-Forwarded-For entirely without the proxy secret", () => {
    expect(trustedClientAddress(req({ "x-forwarded-for": "1.2.3.4" }))).toBeNull();
    env.TRUSTED_PROXY_SECRET = SECRET;
    _resetConfigForTests();
    // Configured, but this request presents no secret — still untrusted.
    expect(trustedClientAddress(req({ "x-forwarded-for": "1.2.3.4" }))).toBeNull();
    // ...and a wrong secret is no better than none.
    expect(
      trustedClientAddress(
        req({ "x-forwarded-for": "1.2.3.4", [PROXY_SECRET_HEADER]: "wrong-but-long-enough" }),
      ),
    ).toBeNull();
    expect(
      trustedClientAddress(
        req({ "x-forwarded-for": "1.2.3.4, 5.6.7.8", [PROXY_SECRET_HEADER]: SECRET }),
      ),
    ).toBe("1.2.3.4");
  });

  it("refuses one trusted client early without exhausting the global ceiling", () => {
    env.TRUSTED_PROXY_SECRET = SECRET;
    env.UPLOAD_ANON_RATE_LIMIT_PER_MIN = "1";
    env.UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN = "50";
    const from = (ip: string) =>
      checkUploadLimit({
        request: req({ "x-forwarded-for": ip, [PROXY_SECRET_HEADER]: SECRET }),
        userId: null,
      });
    expect(from("1.1.1.1").limited).toBe(false);
    expect(from("1.1.1.1")).toMatchObject({ limited: true, bucket: "client" });
    // A different real client is still served — that is the point of a per-client key.
    expect(from("2.2.2.2").limited).toBe(false);
  });

  // "Refuses earlier, NEVER instead." A trusted proxy makes the per-client key
  // honest, not unlimited: the aggregate ceiling is still charged on every
  // unauthenticated attempt, so a botnet of distinct real addresses cannot
  // multiply the instance's total upload budget by its size. Mutation J — charging
  // the global bucket only when no client bucket applies — passed the suite
  // without this case.
  it("charges the global ceiling even when a trusted per-client bucket applies", () => {
    env.TRUSTED_PROXY_SECRET = SECRET;
    env.UPLOAD_ANON_RATE_LIMIT_PER_MIN = "50";
    env.UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN = "3";
    const from = (ip: string) =>
      checkUploadLimit({
        request: req({ "x-forwarded-for": ip, [PROXY_SECRET_HEADER]: SECRET }),
        userId: null,
      });
    for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) {
      expect(from(ip), ip).toMatchObject({ limited: false });
    }
    // A fourth address, well inside its own per-client budget, is refused by the
    // bucket it cannot rotate away from.
    expect(from("4.4.4.4")).toMatchObject({ limited: true, bucket: "global" });
  });

  it("recovers after the window elapses, and Retry-After is how long that takes", () => {
    env.UPLOAD_RATE_LIMIT_PER_MIN = "1";
    const t0 = 1_000_000;
    expect(checkUploadLimit({ request: req(), userId: "u1", now: t0 }).limited).toBe(false);
    const refused = checkUploadLimit({ request: req(), userId: "u1", now: t0 + 30_000 });
    expect(refused.limited).toBe(true);
    // 31, not 30: the window's closing instant still belongs to the old window,
    // so a client that obeyed 30 exactly would be refused a second time.
    expect(refused.retryAfterSeconds).toBe(31);
    // Waiting exactly that long clears it.
    expect(
      checkUploadLimit({ request: req(), userId: "u1", now: t0 + 30_000 + refused.retryAfterSeconds * 1000 })
        .limited,
    ).toBe(false);
  });

  it("fails CLOSED when the configuration cannot be read", () => {
    env.UPLOAD_RATE_LIMIT_PER_MIN = "-4"; // rejected by the schema -> ConfigurationError
    _resetConfigForTests();
    const decision = checkUploadLimit({ request: req(), userId: "u1" });
    expect(decision).toMatchObject({ limited: true, bucket: "unavailable" });
    expect(decision.retryAfterSeconds).toBe(60);
  });

  it("carries no caller identity in the reported bucket", () => {
    const decision = checkUploadLimit({ request: req(), userId: "user-abc-secret" });
    expect(decision.bucket).toBe("user");
    expect(JSON.stringify(decision)).not.toContain("user-abc-secret");
  });

  it("keys the ceiling on a constant, so no second process could mint a fresh one", () => {
    // The global bucket is the bound key rotation cannot escape, and it is only that
    // while its key is a literal. `global:${process.pid}` would pass every behavioural
    // test in this file — one process cannot watch its own pid change — while handing
    // each additional process a full budget. DEPLOYMENT_TOPOLOGY refuses the second
    // process (deploymentTopology.test.ts); this refuses the key that would make one
    // profitable, because the two defences fail in opposite directions.
    const src = readFileSync(join(process.cwd(), "lib/server/uploadRateLimit.ts"), "utf8");
    expect(src.match(/\.global\.(?:hit|retryAfterSeconds)\("global",/g)).toHaveLength(2);
    expect(src).not.toMatch(/process\.pid|hostname\(|randomUUID|INSTANCE_ID/);
  });
});
