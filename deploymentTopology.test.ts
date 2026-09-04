/**
 * R6/R8 — the instance topology, enforced instead of assumed.
 *
 * The upload abuse boundary shipped with three rate-limit buckets held in one
 * process's memory (`lib/server/uploadRateLimit.ts`), and the audit that accepted
 * it recorded the limitation without closing it: nothing refused a deployment that
 * ran two instances behind one address, where each admits the full budget and the
 * "global" ceiling — the bucket a caller cannot rotate away from — becomes N times
 * the configured number.
 *
 * The repository had already decided the topology twice, in prose:
 * `docs/adr/ADR-M7-009-sqlite-operations.md` ("No multi-instance concurrent
 * writers", "PostgreSQL is required before supporting multi-instance writes") and
 * SERVER_SETUP.md ("one writable deployment per database file"). So this is Path A
 * of the two the reconciliation allowed — declare and enforce single-instance — and
 * these tests are what makes the decision effective rather than written down.
 *
 * R7, the shared rate-limit store, is deliberately NOT here: it is the Path B
 * work, and it is not reachable without PostgreSQL, because a shared limiter with
 * a single-writer database buys nothing.
 *
 * WHAT THIS DOES NOT CLAIM. A boot gate enforces the DECLARATION, not mutual
 * exclusion: two processes started by hand against the same database would each
 * declare `single-instance` and each boot. Real exclusion needs a lock the OS
 * releases on death (flock), which Node has no binding for, and a PID- or
 * heartbeat-file substitute would refuse a legitimate redeploy for as long as its
 * staleness window — an availability failure traded for a misconfiguration this
 * gate already names. The residual condition is stated in
 * docs/FINAL_PRELAUNCH_AUDIT.md rather than papered over.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetConfigForTests, getConfig, productionProblems } from "@/src/infrastructure/config/env";

const ROOT = process.cwd();
const env = process.env as unknown as Record<string, string | undefined>;
// Cleared rather than remembered: a value inherited from the developer's shell
// must not decide whether the gate fires.
const KEYS = ["NODE_ENV", "NEXT_PHASE", "DEPLOYMENT_TOPOLOGY", "ADMIN_SECRET", "DATABASE_URL", "NEXT_PUBLIC_SITE_URL",
  "UPLOAD_RATE_LIMIT_PER_MIN", "UPLOAD_ANON_RATE_LIMIT_PER_MIN", "UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN"];
const ORIG: Record<string, string | undefined> = {};

beforeEach(() => {
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

/** A production deployment that is valid apart from whatever the test changes. */
function validProduction(): void {
  env.NODE_ENV = "production";
  env.DATABASE_URL = "file:/srv/pdfdadi/data/pdfdadi.db";
  env.ADMIN_SECRET = "0123456789abcdef0123456789abcdef";
  env.NEXT_PUBLIC_SITE_URL = "https://pdfdadi.com";
  env.DEPLOYMENT_TOPOLOGY = "single-instance";
}

/** The gate's message, or "" when it let the configuration through. */
function gateError(): string {
  try {
    getConfig();
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe("R6 — production refuses to boot until the instance topology is declared", () => {
  it("guards itself: the configuration these tests call valid really is valid", () => {
    validProduction();
    expect(gateError()).toBe("");
    expect(getConfig().isProduction).toBe(true);
  });

  it("refuses when DEPLOYMENT_TOPOLOGY is absent, and says why in the arithmetic", () => {
    validProduction();
    delete env.DEPLOYMENT_TOPOLOGY;
    const msg = gateError();
    expect(msg).toContain("DEPLOYMENT_TOPOLOGY");
    // The message has to carry the reason, not just the variable: an operator who
    // sets it without knowing what it asserts has declared nothing.
    expect(msg).toContain("counted in process memory");
    expect(msg).toMatch(/UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN=240/);
    expect(msg).toContain("ADR-M7-009");
  });

  it("names the operator's own configured limits, so the multiplied budget is concrete", () => {
    validProduction();
    delete env.DEPLOYMENT_TOPOLOGY;
    env.UPLOAD_RATE_LIMIT_PER_MIN = "60";
    env.UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN = "600";
    const msg = gateError();
    expect(msg).toMatch(/UPLOAD_RATE_LIMIT_PER_MIN=60/);
    expect(msg).toMatch(/UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN=600/);
  });

  it("rejects any other topology at parse time, so no unsupported value can be declared", () => {
    for (const claimed of ["multi-instance", "cluster", "single-instance ", "SINGLE-INSTANCE", "2"]) {
      validProduction();
      env.DEPLOYMENT_TOPOLOGY = claimed;
      _resetConfigForTests();
      // A schema rejection, not a gate problem: the value never becomes config at
      // all, so nothing downstream can read a topology this build cannot serve.
      expect(gateError(), claimed).toMatch(/Invalid environment configuration.*DEPLOYMENT_TOPOLOGY/s);
    }
  });

  it("stays out of development, where one process is the only possibility", () => {
    env.NODE_ENV = "development";
    expect(gateError()).toBe("");
    expect(getConfig().isProduction).toBe(false);
  });

  it("stays out of `next build`, which is not a deployment", () => {
    validProduction();
    delete env.DEPLOYMENT_TOPOLOGY;
    env.NEXT_PHASE = "phase-production-build";
    // A build has no deployment topology to declare. If this fired, CI could not
    // compile without inventing production values.
    expect(gateError()).toBe("");
  });

  it("is reported alongside every other problem, not one restart at a time", () => {
    env.NODE_ENV = "production";
    const msg = gateError();
    expect(msg).toContain("DEPLOYMENT_TOPOLOGY");
    expect(msg).toContain("DATABASE_URL");
    expect(msg).toContain("ADMIN_SECRET");
    expect(msg).toMatch(/4 production configuration problems/);
  });

  it("is a gate problem rather than a warning, when asked directly", () => {
    // `productionProblems` is the single authority on "required"; a topology in the
    // warnings list would serve traffic anyway, which is the opposite of the point.
    const problems = productionProblems({
      NODE_ENV: "production",
      ADMIN_SECRET: "0123456789abcdef0123456789abcdef",
      PDFDADI_ALLOW_INSECURE_DEV_SECRET: "",
      NEXT_PUBLIC_SITE_URL: "https://pdfdadi.com",
      DATABASE_URL: "file:/srv/pdfdadi/data/pdfdadi.db",
      LOG_LEVEL: "info",
      TOOLS_MAX_CONCURRENCY: 4,
      TOOLS_RATE_LIMIT_PER_MIN: 20,
      TOOLS_MAX_BODY_BYTES: 110 * 1024 * 1024,
      UPLOAD_RATE_LIMIT_PER_MIN: 120,
      UPLOAD_ANON_RATE_LIMIT_PER_MIN: 20,
      UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN: 240,
      STORAGE_LOCAL_ROOT: ".storage/local",
    } as Parameters<typeof productionProblems>[0]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("DEPLOYMENT_TOPOLOGY");
  });
});

describe("R8 — the deployment artifacts express the topology the gate requires", () => {
  const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");

  it("declares single-instance in compose, so the file and the gate cannot disagree", () => {
    expect(compose).toContain("DEPLOYMENT_TOPOLOGY=single-instance");
  });

  it("cannot be scaled by the orchestration it ships with", () => {
    // `container_name` is not cosmetic here: Docker refuses `--scale N>1` for a
    // service that fixes it, which is the one place this repo can make a second
    // instance actually fail rather than merely be undocumented.
    expect(compose).toMatch(/^\s*container_name:\s*pdfdadi\s*$/m);
    expect(compose).not.toMatch(/^\s*replicas:/m);
    expect(compose).not.toMatch(/^\s*scale:/m);
    // One service, so there is no sibling that could serve the same routes. Only
    // the `services:` block — `volumes:` and `networks:` indent their keys the same.
    const servicesBlock = compose.split(/^services:$/m)[1].split(/^\S/m)[0];
    const services = [...servicesBlock.matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1]);
    expect(services).toEqual(["pdfdadi"]);
  });

  it("tells the operator the same thing in the file they copy", () => {
    const example = readFileSync(join(ROOT, ".env.example"), "utf8");
    expect(example).toContain("DEPLOYMENT_TOPOLOGY=single-instance");
    expect(example).toMatch(/REQUIRED in production, and "single-instance" is the only accepted value/);
    // The line that used to invite the misconfiguration: REDIS_URL was documented
    // as the way to run "multi-instance deployments". A shared queue is one of the
    // three things that would need, and the only one this build has.
    expect(example).not.toMatch(/Redis for multi-instance deployments/);
  });

  it("keeps the ADR that decided this reachable from the gate's own message", () => {
    const adr = readFileSync(join(ROOT, "docs/adr/ADR-M7-009-sqlite-operations.md"), "utf8");
    expect(adr).toContain("No multi-instance concurrent writers");
    validProduction();
    delete env.DEPLOYMENT_TOPOLOGY;
    expect(gateError()).toContain("docs/adr/ADR-M7-009-sqlite-operations.md");
  });
});
