import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * The alert table in `docs/ops/MONITORING.md`, pinned against the code it watches.
 *
 * WHY THIS IS A TEST AND NOT A REVIEW NOTE. An alert keyed to a log message is a
 * string match against another file's string literal, with nothing between them.
 * Rename `logger.error("Worker loop crashed")` and the provider-side rule still
 * exists, still evaluates, and still reports healthy — forever, because "no
 * matches" and "nothing wrong" look identical from the outside. That is the worst
 * shape a monitoring failure can take: it is silent, and it is discovered during
 * the incident the alert existed for. Every other guard in this suite protects the
 * app from a bad deploy; this one protects the operator from a green dashboard.
 *
 * The level matters as much as the text. The document tells an operator to page on
 * `error` and ticket on `warn`, and `ConsoleLogger` sends warn/error to stderr and
 * info/debug to stdout — so a message demoted from error to info both changes who
 * gets woken and moves the line to a different stream, which some shippers collect
 * separately or not at all.
 *
 * The second direction is checked too: every backticked span in the document's
 * alert tables must be either a message this file knows about or a listed
 * non-message. Adding a row to the document without teaching this test about it
 * fails here, which is the point — the document is the only place the alert set is
 * written down, and a row nobody pinned is a row that can rot.
 *
 * WHAT IT DOES NOT PROVE: that any alert is configured anywhere. Nothing is —
 * `MONITORING: NOT EXERCISED`. It proves the signals the document names are still
 * the signals the application emits.
 */

const root = process.cwd();
const doc = readFileSync(path.join(root, "docs/ops/MONITORING.md"), "utf8");

/** Messages the document alerts on, with the level it tells the operator to expect. */
const ALERTS: ReadonlyArray<readonly [level: "error" | "warn" | "info", msg: string]> = [
  ["error", "Queue handoff failed and rollback failed; job is stranded"],
  ["error", "Upload stored but ingestion job could not be queued"],
  ["error", "Version created but document pointer update failed"],
  ["error", "Worker loop crashed"],
  ["error", "Redis worker loop crashed"],
  ["error", "Unhandled rejection in worker"],
  ["error", "Billing webhook processing failed"],
  ["error", "Billing webhook claim could not be released; its retry will be skipped"],
  ["error", "Billing webhook metadata names a different organization than its customer"],
  ["warn", "Shutdown grace expired with work in flight"],
  ["warn", "Expiry sweep failed"],
  ["warn", "Version retention sweep failed"],
  ["warn", "DB health check failed"],
  ["warn", "Analytics read degraded"],
  ["warn", "Billing summary degraded"],
  ["warn", "Entitlement lookup failed; defaulting to the free plan"],
  ["warn", "Job attempt failed"],
  ["warn", "Processing attempt failed"],
  ["warn", "Tool job failed"],
  ["warn", "Rejected billing webhook with an invalid signature"],
  ["warn", "csp violation blocked"],
  ["info", "Recovered stuck jobs"],
];

/**
 * Backticked spans in the alert tables that are not log messages: variable names,
 * endpoint paths, JSON fields of a line rather than its `msg`, and one console
 * prefix and one message prefix that are asserted separately below.
 */
const NOT_A_MESSAGE = new Set([
  "msg", "error", "warn", "info",
  "GET /api/health", "GET /api/health/ready",
  "dataDir", "toolchain", "database", "instance",
  "examined", "requeued", "failed", "requeued > 0",
  "WORKER_SHUTDOWN_GRACE_MS", "TRUSTED_PROXY_SECRET",
  "X-Forwarded-For", "x-pdfdadi-proxy-secret",
  "DATABASE_URL", "STORAGE_LOCAL_ROOT", "ADMIN_STORE_DIR",
  "journal_mode", "delete", "cp", "scripts/migration-restore-drill.mjs",
  "[rate-limit]",
  "Retention:", // a family of messages, matched as a prefix
]);

/** Plain-text lifecycle lines, pinned by the `it.each` below rather than by level. */
const LIFECYCLE = [
  "[startup] PDFDadi refused to start",
  "[startup] PDFDadi configuration OK",
  "[instance] single-instance lease acquired",
  "single-instance lease released",
  "lease release failed",
  "[ingress] the request guard was never installed",
  "expected exactly one 'request' listener",
  "[rate-limit] Requests are arriving with X-Forwarded-For",
];
for (const line of LIFECYCLE) NOT_A_MESSAGE.add(line);

/** Every `logger.<level>("literal"` in the application, as message → levels. */
function emittedMessages(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const dir of ["app", "src", "lib", "instrumentation.ts"]) {
    const base = path.join(root, dir);
    if (!existsSync(base)) continue;
    const files = base.endsWith(".ts")
      ? [base]
      : readdirSync(base, { recursive: true, encoding: "utf8" })
          .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
          .map((f) => path.join(base, f));
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const [, level, msg] of text.matchAll(
        /\.(debug|info|warn|error)\(\s*"((?:[^"\\]|\\.)*)"/g,
      )) {
        const key = msg.replace(/\\"/g, '"');
        if (!found.has(key)) found.set(key, new Set());
        found.get(key)!.add(level);
      }
    }
  }
  return found;
}

const emitted = emittedMessages();

describe("docs/ops/MONITORING.md alert signals", () => {
  it.each(ALERTS)("%s: %s is still emitted at that level", (level, msg) => {
    expect(emitted.get(msg), `no logger call emits "${msg}"`).toBeDefined();
    expect([...emitted.get(msg)!]).toContain(level);
  });

  it("names every message it alerts on", () => {
    for (const [, msg] of ALERTS) expect(doc).toContain(`\`${msg}\``);
  });

  it("alerts on nothing this test does not pin", () => {
    const tables = doc
      .split("## 2. Alerts worth waking someone for")[1]
      .split("## 3.")[0]
      .split("\n")
      .filter((line) => line.startsWith("|"));
    const known = new Set(ALERTS.map(([, msg]) => msg));
    const unpinned = [...tables.join("\n").matchAll(/`([^`]+)`/g)]
      .map(([, span]) => span)
      .filter((span) => !known.has(span) && !NOT_A_MESSAGE.has(span));
    expect(unpinned, "add these to ALERTS or to NOT_A_MESSAGE").toEqual([]);
  });

  /**
   * The lifecycle lines are `console.*` with a bracket prefix, not logger calls:
   * they run before and around the DI container that owns the logger. The document
   * tells the operator to match them as plain substrings, so that is what is pinned
   * — the file each lives in, and the text.
   */
  it.each([
    ["src/infrastructure/config/startupGate.ts", "[startup] PDFDadi refused to start"],
    ["src/infrastructure/config/startupGate.ts", "[startup] PDFDadi configuration OK"],
    ["src/infrastructure/config/instanceLease.ts", "[instance] single-instance lease acquired"],
    ["ingress/guard.mjs", "single-instance lease released"],
    ["ingress/guard.mjs", "lease release failed"],
    ["ingress/guard.mjs", "[ingress] the request guard was never installed"],
    ["ingress/guard.mjs", "expected exactly one 'request' listener"],
    ["lib/server/rateLimit.ts", "[rate-limit] Requests are arriving with X-Forwarded-For"],
  ])("%s still writes %s", (file, line) => {
    expect(readFileSync(path.join(root, file), "utf8")).toContain(line);
    expect(doc).toContain(`\`${line}\``);
  });

  it("keeps the message-prefix family the document matches on", () => {
    expect([...emitted.keys()].filter((m) => m.startsWith("Retention: ")).length)
      .toBeGreaterThan(0);
  });

  it("keeps the health endpoints it tells the operator to probe, and no metrics endpoint", () => {
    // The dangerous direction is a probe that starts 404ing: a monitor pointed at a
    // removed path reports the same "not 200" as an outage, or worse, is quietly
    // reconfigured away. `/api/metrics` absent is why the document sends the
    // operator to the proxy for request rate, latency and error rate.
    for (const route of ["health", "health/ready", "health/dependencies"]) {
      expect(existsSync(path.join(root, "app/api", route, "route.ts")), route).toBe(true);
    }
    expect(existsSync(path.join(root, "app/api/metrics"))).toBe(false);
  });
});
