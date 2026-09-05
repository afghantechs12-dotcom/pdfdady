/* global process, console, setTimeout, clearTimeout, AbortController, fetch */
/**
 * LIVE acceptance for single-instance enforcement.
 *
 * `DEPLOYMENT_TOPOLOGY=single-instance` only ever proved that an operator had
 * TYPED it. This probe starts two production processes against the same database
 * and asks the deployment itself which of them may serve — the question config
 * validation cannot answer.
 *
 * Run it against both entries. `--entry .next/standalone/server.js` is the
 * unguarded baseline, where both processes are expected to serve and every row
 * about exclusion is expected to fail; `--entry ingress/server.mjs` is the
 * supported entry, where exactly one serves. The expectations are the post-fix
 * ones in both runs.
 *
 * The rows, and what each one can only be answered by running it:
 *   S1  a first instance acquires and serves
 *   S2  a second instance against the same database does NOT serve
 *   S3  exactly one of the two is serving (the pair, asserted together)
 *   S4  the standby's refusal discloses nothing about why
 *   S5  readiness on the holder reports the lease it actually holds
 *   S6  SIGKILL the holder — the standby takes over within the TTL, unattended
 *   S7  SIGTERM the holder — the lease is RELEASED, so a fresh process acquires
 *       in about a heartbeat instead of waiting out the TTL
 *   S8  the unguarded entry refuses to start in production at all
 *
 * Usage:
 *   node scripts/singleton-probe.mjs --entry ingress/server.mjs [--label guarded] [--json out.json]
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

import { sleep } from "./lib/drip.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const ENTRY = arg("entry", "ingress/server.mjs");
const LABEL = arg("label", "run");
const JSON_OUT = arg("json", "");
const DB = arg("db", "file:/tmp/audit-singleton-db.db");
const PORTS = { a: 3011, b: 3012, c: 3013 };

const rows = [];
function record(id, label, pass, detail) {
  rows.push({ id, label, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id} ${label}`);
  if (detail) console.log(`      ${detail}`);
}

/**
 * One production process.
 *
 * `sh -c` with `set -a; . ./.env` reuses the launcher's own way of loading
 * configuration rather than reimplementing dotenv, and `exec` means the shell is
 * replaced — so the pid returned here is the Node process, which is what makes
 * SIGKILL in S6 land on the right thing.
 */
function start(port) {
  const child = spawn(
    "sh",
    [
      "-c",
      `set -a; . ./.env; set +a; export NODE_ENV=production DEPLOYMENT_TOPOLOGY=single-instance ` +
        `PORT=${port} HOSTNAME=127.0.0.1 DATABASE_URL='${DB}' ` +
        `NEXT_PUBLIC_SITE_URL="\${AUDIT_SITE_URL:-https://172.20.10.2:3001}"; exec node ${ENTRY}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const out = [];
  child.stdout.on("data", (d) => out.push(String(d)));
  child.stderr.on("data", (d) => out.push(String(d)));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, port, log: () => out.join(""), exited };
}

/** `{status, body}` or `{status: 0}` when the port is not answering. */
async function probe(port, path = "/api/health") {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 4_000);
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: controller.signal });
    clearTimeout(t);
    return { status: res.status, body: (await res.text()).slice(0, 200) };
  } catch {
    return { status: 0, body: "" };
  }
}

/** Poll until `want(status)` or the deadline. Returns the last observation. */
async function waitFor(port, want, timeoutMs, path = "/api/health") {
  const deadline = Date.now() + timeoutMs;
  let last = { status: 0, body: "" };
  while (Date.now() < deadline) {
    last = await probe(port, path);
    if (want(last.status)) return { ...last, waitedMs: timeoutMs - (deadline - Date.now()) };
    await sleep(400);
  }
  return { ...last, waitedMs: timeoutMs };
}

function stop(instance, signal = "SIGKILL") {
  try {
    instance.child.kill(signal);
  } catch {
    // Already gone.
  }
}

async function main() {
  console.log(`\n=== singleton probe (${LABEL}) → entry ${ENTRY}  db ${DB} ===\n`);
  const started = [];
  try {
    // ---- S1 / S2 / S3: two processes, one database ------------------------
    const a = start(PORTS.a);
    started.push(a);
    const aUp = await waitFor(PORTS.a, (s) => s !== 0, 90_000);
    record(
      "S1",
      "a first production instance acquires the lease and serves",
      aUp.status === 200,
      `:${PORTS.a} GET /api/health → ${aUp.status} after ${aUp.waitedMs}ms`,
    );

    const b = start(PORTS.b);
    started.push(b);
    const bUp = await waitFor(PORTS.b, (s) => s !== 0, 90_000);
    record(
      "S2",
      "a second instance against the same database does not serve",
      bUp.status === 503,
      `:${PORTS.b} GET /api/health → ${bUp.status} (want 503) after ${bUp.waitedMs}ms  ${bUp.body.slice(0, 80)}`,
    );

    const serving = [aUp.status, bUp.status].filter((s) => s === 200).length;
    record(
      "S3",
      "exactly one of the two instances is serving traffic",
      serving === 1,
      `serving=${serving} (a=${aUp.status}, b=${bUp.status})`,
    );

    // ---- S4: the refusal says nothing about why --------------------------
    const bReady = await probe(PORTS.b, "/api/health/ready");
    const bRoot = await probe(PORTS.b, "/");
    const discloses = /lease|instance|holder|standby|database/i.test(bReady.body + bRoot.body);
    record(
      "S4",
      "the standby refuses every path identically and discloses no reason",
      bReady.status === 503 && bRoot.status === 503 && !discloses,
      `ready ${bReady.status}, / ${bRoot.status}, body ${JSON.stringify(bReady.body.slice(0, 60))}`,
    );

    // ---- S5: readiness on the holder ------------------------------------
    const aReady = await probe(PORTS.a, "/api/health/ready");
    let instanceField = null;
    try {
      instanceField = JSON.parse(aReady.body)?.instance ?? null;
    } catch {
      instanceField = null;
    }
    record(
      "S5",
      "readiness on the holder reports the lease as a named check",
      instanceField === true,
      `checks.instance = ${JSON.stringify(instanceField)}  (http ${aReady.status})`,
    );

    // ---- S6: crash recovery, unattended ---------------------------------
    stop(a, "SIGKILL");
    const takeover = await waitFor(PORTS.b, (s) => s === 200, 45_000);
    record(
      "S6",
      "the standby takes over within the TTL after the holder is SIGKILLed",
      takeover.status === 200,
      `:${PORTS.b} → ${takeover.status} after ${takeover.waitedMs}ms (TTL 10s + 2s grace + 3s beat)`,
    );

    // ---- S7: clean release is faster than expiry ------------------------
    stop(b, "SIGTERM");
    await b.exited;
    const c = start(PORTS.c);
    started.push(c);
    const cUp = await waitFor(PORTS.c, (s) => s === 200, 90_000);
    /*
     * The threshold is the row, not decoration. A 200 alone is also what waiting
     * out the expiry produces, so `cUp.status === 200` on its own passed even at
     * baseline, where nothing was ever released — and it kept passing after the
     * guarded run, because a bug in the shutdown hook meant the delete was skipped
     * and c really did wait 12.5 s for the lease to go stale. 8 s separates the two
     * paths with room on both sides: the expiry path cannot beat TTL 10 s + 2 s
     * grace, and the release path costs a boot (~0.5 s) plus one acquisition.
     */
    const RELEASE_BUDGET_MS = 8_000;
    record(
      "S7",
      "after a clean SIGTERM release, a fresh instance acquires without waiting out the TTL",
      cUp.status === 200 && cUp.waitedMs < RELEASE_BUDGET_MS,
      `:${PORTS.c} → ${cUp.status} after ${cUp.waitedMs}ms from spawn, boot included ` +
        `(want <${RELEASE_BUDGET_MS}ms; the expiry path costs ≥12000ms)`,
    );
    stop(c, "SIGTERM");

    // ---- S8: the unguarded entry is not startable ------------------------
    const unguarded = spawn(
      "sh",
      [
        "-c",
        // The same environment `start()` uses, NEXT_PUBLIC_SITE_URL included. Without
        // it the config gate refuses first and the row would read "exit 1" for a
        // reason that has nothing to do with the guard — which is what the baseline
        // run showed. The row asserts BOTH the exit code and the guard's own message,
        // so it stays honest either way; this makes the failure attributable.
        `set -a; . ./.env; set +a; export NODE_ENV=production DEPLOYMENT_TOPOLOGY=single-instance ` +
          `PORT=${PORTS.a} HOSTNAME=127.0.0.1 DATABASE_URL='${DB}' ` +
          `NEXT_PUBLIC_SITE_URL="\${AUDIT_SITE_URL:-https://172.20.10.2:3001}"; exec node .next/standalone/server.js`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const rawOut = [];
    unguarded.stdout.on("data", (d) => rawOut.push(String(d)));
    unguarded.stderr.on("data", (d) => rawOut.push(String(d)));
    const rawCode = await Promise.race([
      new Promise((r) => unguarded.on("exit", (code) => r(code))),
      sleep(30_000).then(() => "still-running"),
    ]);
    if (rawCode === "still-running") unguarded.kill("SIGKILL");
    const text = rawOut.join("");
    record(
      "S8",
      "the generated server.js refuses to start in production without the guard",
      rawCode === 1 && /ingress guard is not installed/.test(text),
      `exit ${rawCode}; mentions the guard: ${/ingress guard is not installed/.test(text)}; ` +
        `last line ${JSON.stringify(text.trim().split("\n").slice(-1)[0]?.slice(0, 120) ?? "")}`,
    );
  } finally {
    for (const i of started) stop(i, "SIGKILL");
    await sleep(500);
  }

  const failed = rows.filter((r) => !r.pass);
  console.log(
    `\n${rows.length - failed.length}/${rows.length} passed` +
      (failed.length ? `  FAILED: ${failed.map((r) => r.id).join(", ")}` : ""),
  );
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ label: LABEL, entry: ENTRY, rows }, null, 2));
    console.log(`json → ${JSON_OUT}`);
  }
  process.exit(failed.length ? 1 : 0);
}

await main();
