/* global process, console, fetch, setTimeout, Buffer, FormData, Blob */
/**
 * PERMANENT runtime probe: hard usage enforcement, in the REAL application.
 *
 * WHY THIS EXISTS. Enforcement has a large Node suite behind it — the policy is
 * pure and tested, the service is tested against a real Prisma repository, the
 * worker seam is tested, and the submission wiring is asserted on its source. Not
 * one of those runs `next start`. What none of them can see:
 *
 *  - whether the ROUTE actually refuses, with the DI container, session cookie,
 *    rate limiter, CSRF check and multipart parser all in the loop;
 *  - whether a refusal costs a write to storage, a job row, or a worker attempt
 *    in a process where all three are live;
 *  - whether the DEFAULT mode of a deployment that sets no `USAGE_LIMIT_MODE` is
 *    the observe mode production is supposed to be running.
 *
 * Production stays in observe mode. This probe therefore runs its own throwaway
 * deployment with `USAGE_LIMIT_MODE=enforce` to exercise the blocking path, and a
 * second one that sets the variable to NOTHING to prove what unset resolves to.
 * Nothing here touches the developer database: every deployment gets a fresh
 * SQLite file under the OS temp directory, migrated from scratch and deleted at
 * the end.
 *
 * THE HAZARD IT IS BUILT AGAINST is a vacuous pass — an "enforcement works" that
 * would pass just as well against a broken meter:
 *
 *  - The ceiling is READ from `/api/usage` before anything is tested against it
 *    (section 1). A probe that typed `100` would keep passing after someone
 *    changed the free plan, and would be testing its own constant.
 *  - Every "nothing happened" claim is paired with an admitted submission that
 *    made the same numbers MOVE (section 2 → section 4).
 *  - The counters are seeded to the boundary rather than reached by 99 real
 *    submissions, so the numbers under test are exact — and each phase waits for
 *    every in-flight job to settle first, so no straggler refund can shift the
 *    value a claim rests on.
 *  - The compressor is given a 1ms timeout, so a failure is deterministic in an
 *    environment with Ghostscript AND in one without it. Section 8's refund
 *    accounting therefore proves the same thing on any machine.
 *
 * WHAT IT PINS, as the mutations it was run against:
 *
 *  - `shouldBlock` weakened to ignore `enforced`: section 9 fails — the observe
 *    deployment starts refusing.
 *  - `resolveLimitMode` defaulting to enforce: section 9 fails on the mode.
 *  - `wouldExceed` using `>=`: section 3 fails — the final allowance is refused.
 *  - Admission moved after `uploadStream`: section 4 fails on the staged file.
 *  - The race loser's refund dropped: section 5 fails with the counter above the
 *    ceiling.
 *  - `settleProcessingOutcome` claiming per attempt instead of per job: section 8
 *    fails — the operation is refunded more than once.
 *  - The 429 body widened back to `{ meter, limit, used }`: section 4 fails.
 *
 * Run it against a built tree:
 *
 *   node scripts/next-build.js
 *   node scripts/usage-enforcement-probe.mjs [--port 3151]
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PDFDocument, StandardFonts } from "pdf-lib";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const PORT_ENFORCE = Number(arg("--port", "3151"));
const PORT_DEFAULT = PORT_ENFORCE + 1;

/** The pilot tool: the only slug the unified pipeline serves. */
const SLUG = "compress-pdf";
/** Terminal job states — what "no work is in flight" means below. */
const TERMINAL = ["completed", "failed", "cancelled"];
const JOB_TYPES = ["processing", "pdf-tool"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const limits = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: !!ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function environmentLimited(name, reason) {
  limits.push({ name, reason });
  console.log(`  n/a  ${name} — ${reason}`);
}
const section = (n, title) => console.log(`\n── ${n}. ${title}`);

// ---------------------------------------------------------------------------
// HTTP, with an explicit identity per call
// ---------------------------------------------------------------------------
function jar() {
  return new Map();
}
function absorb(store, res) {
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const line of raw) {
    const [pair] = line.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) store.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}
const cookieHeader = (store) => [...store.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

/**
 * A distinct forwarded-for address per request.
 *
 * `/api/jobs` allows 20 requests/minute/IP and this probe makes more than that.
 * One address for everything would turn an enforcement assertion into the RATE
 * limiter's 429 — which carries no `reason`, so the checks below would fail for a
 * reason that has nothing to do with quotas. Presenting each call as its own
 * client keeps the two 429s from being confused for one another.
 */
let callSeq = 0;
function nextIp() {
  callSeq += 1;
  return `10.77.${Math.floor(callSeq / 250)}.${callSeq % 250}`;
}

async function get(base, path, { store } = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: {
      "X-Forwarded-For": nextIp(),
      ...(store && store.size ? { Cookie: cookieHeader(store) } : {}),
    },
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON — `text` is the evidence */
  }
  return { status: res.status, text, json, headers: res.headers };
}

async function postJson(base, path, { body, store, origin } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin ?? base,
      "X-Forwarded-For": nextIp(),
      ...(store && store.size ? { Cookie: cookieHeader(store) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  if (store) absorb(store, res);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, json, headers: res.headers };
}

/**
 * A real multipart submission, exactly as the browser makes it.
 *
 * Content-Type is deliberately not set: `fetch` has to generate the multipart
 * boundary, and stating the header by hand produces a body the route cannot
 * parse — a 400 that would read as a validation bug.
 */
async function submitJob(base, store, pdf, { slug = SLUG, key, origin } = {}) {
  const form = new FormData();
  form.append("file", new Blob([pdf], { type: "application/pdf" }), "fixture.pdf");
  form.append("level", "medium");
  const res = await fetch(`${base}/api/jobs?slug=${slug}`, {
    method: "POST",
    headers: {
      Origin: origin ?? base,
      "X-Forwarded-For": nextIp(),
      "Idempotency-Key": key ?? randomUUID(),
      ...(store.size ? { Cookie: cookieHeader(store) } : {}),
    },
    body: form,
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, json, headers: res.headers };
}

// ---------------------------------------------------------------------------
// Fixture and server lifecycle
// ---------------------------------------------------------------------------
async function makeFixture() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText("usage enforcement probe fixture", { x: 48, y: 780, size: 18, font });
  return Buffer.from(await doc.save());
}

const servers = [];
function killServer(entry) {
  try {
    process.kill(-entry.child.pid, "SIGKILL");
  } catch {
    try {
      entry.child.kill("SIGKILL");
    } catch {
      /* nothing left to kill */
    }
  }
}

function migrate(dbUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["prisma", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: "ignore",
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`prisma migrate deploy exited ${code}`)),
    );
    child.on("error", reject);
  });
}

/** Refuses to run against someone else's server, which is how a stale process ends up answering. */
function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const tester = createServer();
    tester.once("error", (err) =>
      reject(
        new Error(
          `port ${port} is already in use (${err.code}). Stop whatever is listening there — ` +
            `if it is a stray server from an earlier probe run, \`lsof -ti :${port} | xargs kill -9\`.`,
        ),
      ),
    );
    tester.once("listening", () => tester.close(() => resolve()));
    tester.listen(port, "127.0.0.1");
  });
}

async function startServer({ port, dbUrl, storageRoot, mode }) {
  await assertPortFree(port);
  const base = `http://localhost:${port}`;
  // The PUBLIC origin the deployment is configured with, which is deliberately
  // NOT the address this probe connects to. Two production rules force this:
  //
  //  - the startup gate REFUSES to boot when `NEXT_PUBLIC_SITE_URL` is a loopback
  //    host, because signed download URLs are built from it;
  //  - `requireSameOrigin` trusts exactly that configured origin in production and
  //    derives nothing from the request, so state-changing calls must present it
  //    as their `Origin` header.
  //
  // A name that resolves nowhere is correct here: nothing fetches it, and using a
  // real hostname would be the probe talking to something other than the server it
  // started.
  const siteUrl = `http://probe-usage-${port}.test`;
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    DATABASE_URL: dbUrl,
    ADMIN_SECRET: `probe-admin-${randomBytes(8).toString("hex")}`,
    NEXT_PUBLIC_SITE_URL: siteUrl,
    STORAGE_LOCAL_ROOT: storageRoot,
    // The pilot flag is on so submissions take the unified pipeline — the path
    // that returns before the work starts, which is what makes the admission
    // ordering observable from outside.
    PROCESSING_PIPELINE: "on",
    // A 1ms compressor budget. Every job therefore reaches a terminal FAILURE in
    // about two seconds whether or not this machine has Ghostscript, which is what
    // makes section 8's refund accounting environment-independent — and what makes
    // sections 3-7 immune to a success/failure difference they do not test.
    PROCESSING_COMPRESS_TIMEOUT_MS: "1",
    // `undefined` means "leave unset", so the default-mode deployment observes the
    // DEFAULT rather than a value this probe supplied.
    USAGE_LIMIT_MODE: mode,
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];

  // `detached` makes the child a group leader so the kill reaches the next-server
  // it forks. Killing only `npx` leaves that server holding the port, attached to
  // a database that is about to be deleted.
  const child = spawn("npx", ["next", "start", "-p", String(port)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d.toString()));
  child.stderr.on("data", (d) => (log += d.toString()));
  servers.push({ child, port, tail: () => log.slice(-3000) });

  for (let attempt = 0; attempt < 90; attempt += 1) {
    await sleep(500);
    try {
      if ((await fetch(`${base}/api/health`)).ok) return { base, origin: siteUrl };
    } catch {
      /* not listening yet */
    }
  }
  throw new Error(`server on ${port} never became healthy:\n${log.slice(-2000)}`);
}

async function signup(base, store, email, origin) {
  const res = await postJson(base, "/api/auth/signup", {
    store,
    origin,
    body: {
      name: "Usage Probe",
      email,
      password: "probe-password-123456",
      confirmPassword: "probe-password-123456",
    },
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`signup failed: ${res.status} ${res.text.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------------
// Authoritative state, read from the database rather than from the API under test
// ---------------------------------------------------------------------------
const OPS = "server_operations";

async function counterRows(db, meter) {
  return db.usageCounter.findMany({ where: { meter }, orderBy: { periodStart: "asc" } });
}
async function opsAmount(db) {
  const rows = await counterRows(db, OPS);
  return rows.reduce((sum, r) => sum + r.amount, 0);
}

/** Every file the local storage adapter has actually written. */
function storedFiles(dir) {
  let count = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0; // not created yet — which is itself a count of zero
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) count += storedFiles(full);
    else if (statSync(full).isFile()) count += 1;
  }
  return count;
}

async function snapshot(db, storageRoot) {
  return {
    ops: await opsAmount(db),
    jobs: await db.job.count({ where: { type: { in: JOB_TYPES } } }),
    files: await db.storedFile.count(),
    disk: storedFiles(storageRoot),
    attempts: await db.usageEvent.count({ where: { eventName: "tool_processing_completed" } }),
    denials: await db.usageEvent.count({ where: { eventName: "limit_reached" } }),
    settlements: await db.usageSettlement.count(),
  };
}

/**
 * Waits until no job is in flight AND the operations counter has stopped moving.
 *
 * Every numeric claim below rests on knowing the counter exactly, and a worker
 * that settles a failed job refunds one operation asynchronously. Without this,
 * a straggler refund lands in the middle of the next phase and the failure looks
 * like a broken meter.
 */
async function quiesce(db, label) {
  const deadline = Date.now() + 90_000;
  let previous = null;
  let stable = 0;
  while (Date.now() < deadline) {
    const inFlight = await db.job.count({
      where: { type: { in: JOB_TYPES }, status: { notIn: TERMINAL } },
    });
    const amount = await opsAmount(db);
    if (inFlight === 0 && amount === previous) {
      stable += 1;
      if (stable >= 2) return amount;
    } else {
      stable = 0;
    }
    previous = amount;
    await sleep(400);
  }
  throw new Error(`usage never settled while waiting for ${label}`);
}

/**
 * Sets the operations counter to an exact value, in the window the APPLICATION
 * opened.
 *
 * The period is never computed here: the row was created by a real submission, so
 * its window comes from the code under test. A probe that derived its own
 * `periodStart` would silently write into a window nothing reads.
 */
async function seedOps(db, amount) {
  const rows = await counterRows(db, OPS);
  if (rows.length !== 1) {
    throw new Error(`expected exactly one ${OPS} window, found ${rows.length}`);
  }
  await db.usageCounter.update({ where: { id: rows[0].id }, data: { amount } });
  return rows[0];
}

async function jobStatus(base, store, id) {
  return (await get(base, `/api/jobs/${id}`, { store })).json;
}

async function awaitTerminal(base, store, id) {
  const deadline = Date.now() + 90_000;
  let last = null;
  while (Date.now() < deadline) {
    last = await jobStatus(base, store, id);
    if (last && TERMINAL.includes(last.status)) return last;
    await sleep(400);
  }
  throw new Error(`job ${id} never reached a terminal state (last: ${JSON.stringify(last)})`);
}

// ---------------------------------------------------------------------------
async function main() {
  const root = mkdtempSync(join(tmpdir(), "usage-enforcement-probe-"));
  const dbEnforce = `file:${join(root, "enforce.db")}`;
  const dbDefault = `file:${join(root, "default.db")}`;
  const storeEnforce = join(root, "storage-enforce");
  const storeDefault = join(root, "storage-default");

  console.log(`fixtures: ${root}`);
  await migrate(dbEnforce);
  await migrate(dbDefault);

  const db = new PrismaClient({ datasources: { db: { url: dbEnforce } } });
  const dbObserve = new PrismaClient({ datasources: { db: { url: dbDefault } } });
  const pdf = await makeFixture();

  try {
    const { base, origin } = await startServer({
      port: PORT_ENFORCE,
      dbUrl: dbEnforce,
      storageRoot: storeEnforce,
      mode: "enforce",
    });
    const user = jar();
    await signup(base, user, `enforce-${randomBytes(6).toString("hex")}@probe.test`, origin);
    const submit = (opts) => submitJob(base, user, pdf, { origin, ...opts });

    // -----------------------------------------------------------------------
    section(1, "the fixture's own configured ceiling (read, never assumed)");
    const usage0 = await get(base, "/api/usage", { store: user });
    const ops0 = usage0.json?.meters?.find((m) => m.meter === OPS) ?? null;
    const LIMIT = ops0?.limit ?? null;
    check(
      "the deployment reports the plan and mode this probe is about to test",
      usage0.status === 200 && usage0.json?.plan === "free" && usage0.json?.mode === "enforce",
      `status ${usage0.status} plan ${usage0.json?.plan} mode ${usage0.json?.mode}`,
    );
    check(
      "a fresh Free account starts below its configured operations ceiling",
      typeof LIMIT === "number" && LIMIT >= 4 && ops0.used === 0 && ops0.remaining === LIMIT,
      `limit ${LIMIT} used ${ops0?.used} remaining ${ops0?.remaining} window ${ops0?.window}`,
    );
    if (typeof LIMIT !== "number" || LIMIT < 4) {
      throw new Error("cannot test a ceiling the application does not report");
    }

    // -----------------------------------------------------------------------
    section(2, "within the allowance: admitted, and the meter moves");
    const before2 = await snapshot(db, storeEnforce);
    const first = await submit();
    check(
      "a submission inside the allowance is accepted",
      first.status === 202 && typeof first.json?.jobId === "string",
      `status ${first.status} body ${first.text.slice(0, 160)}`,
    );
    const after2 = await snapshot(db, storeEnforce);
    // This is the control for section 4: the same four numbers that must NOT move
    // for a refusal are observed moving for an admission, so "nothing happened"
    // cannot pass by nothing ever happening.
    check(
      "the admitted submission charges one operation, stages the input and queues a job",
      after2.ops === before2.ops + 1 &&
        after2.jobs === before2.jobs + 1 &&
        after2.files === before2.files + 1 &&
        after2.disk === before2.disk + 1,
      `ops ${before2.ops}→${after2.ops} jobs ${before2.jobs}→${after2.jobs} ` +
        `rows ${before2.files}→${after2.files} disk ${before2.disk}→${after2.disk}`,
    );

    // -----------------------------------------------------------------------
    section(3, "the boundary operation is admitted, and it is the last one");
    await quiesce(db, "the first job");
    await seedOps(db, LIMIT - 1);
    const boundary = await submit();
    // Fired immediately, with nothing awaited in between. A refund could only
    // reverse the boundary charge by way of three worker attempts and their 500ms
    // + 1000ms backoff, so this request is ~30x closer than the earliest moment
    // the charge could come back — the refusal below can only be the boundary
    // charge having landed.
    const afterBoundary = await submit();
    check(
      `the operation that brings usage to exactly ${LIMIT} is admitted`,
      boundary.status === 202,
      `status ${boundary.status} body ${boundary.text.slice(0, 160)}`,
    );
    check(
      "the very next operation is refused, so the boundary consumed the final allowance",
      afterBoundary.status === 429 && afterBoundary.json?.reason === "meter_exhausted",
      `status ${afterBoundary.status} reason ${afterBoundary.json?.reason}`,
    );

    // -----------------------------------------------------------------------
    section(4, "over the allowance: refused before anything happens");
    await quiesce(db, "the boundary jobs");
    await seedOps(db, LIMIT);
    const before4 = await snapshot(db, storeEnforce);
    const meId = (await db.user.findFirst())?.id ?? "no-user";
    const refused = await submit();
    const after4 = await snapshot(db, storeEnforce);
    check(
      "the refusal is a 429 carrying a stable machine-readable reason",
      refused.status === 429 && refused.json?.reason === "meter_exhausted",
      `status ${refused.status} body ${refused.text.slice(0, 200)}`,
    );
    check(
      "the refusal explains itself and offers a wait, without a stack trace",
      typeof refused.json?.error === "string" &&
        refused.json.error.length > 10 &&
        !/Error|at \/|node_modules/.test(refused.json.error) &&
        refused.headers.get("retry-after") !== null,
      `retry-after ${refused.headers.get("retry-after")} error ${JSON.stringify(refused.json?.error)}`,
    );
    check(
      "the body carries no meter key, no counter numbers and no owner id",
      // Asserted on the KEY SET, not on the prose: the sentence a user reads
      // legitimately contains the word "limit", while `{ limit: 100, used: 100 }`
      // is the counter showing through a public response. Only the second is a
      // leak, and only a key check tells them apart.
      Object.keys(refused.json ?? {}).sort().join(",") === "error,reason" &&
        !refused.text.includes(OPS) &&
        !refused.text.includes("server_input_bytes") &&
        !refused.text.includes("usage_counter") &&
        !new RegExp(`\\b${LIMIT}\\b`).test(refused.text) &&
        !refused.text.includes(meId),
      `keys ${Object.keys(refused.json ?? {}).join(",")}`,
    );
    check(
      "no job row, no staged input and no stored file exist for the refused request",
      after4.jobs === before4.jobs && after4.files === before4.files && after4.disk === before4.disk,
      `jobs ${before4.jobs}→${after4.jobs} rows ${before4.files}→${after4.files} disk ${before4.disk}→${after4.disk}`,
    );
    check(
      "no worker attempt was made and no allowance was debited",
      after4.attempts === before4.attempts && after4.ops === LIMIT,
      `attempts ${before4.attempts}→${after4.attempts} ops ${after4.ops} (ceiling ${LIMIT})`,
    );
    const denial = await db.usageEvent.findFirst({
      where: { eventName: "limit_reached" },
      orderBy: { occurredAt: "desc" },
    });
    const props = denial?.properties ? JSON.parse(denial.properties) : {};
    check(
      "exactly one denial event was recorded, by the server, marked enforced",
      after4.denials === before4.denials + 1 && props.enforced === true && props.reason === "meter_exhausted",
      `events ${before4.denials}→${after4.denials} properties ${denial?.properties}`,
    );
    check(
      "the denial event carries only allowlisted properties and no owner identity",
      // The closed taxonomy for this event: `limit_reached`'s own five fields plus
      // the common dimensions, which describe WHICH KIND of visitor and never
      // which one. Spelled out rather than imported, so widening the taxonomy has
      // to be looked at by a person instead of being ratified by its own table.
      Object.keys(props).every((k) =>
        [
          "meter",
          "reason",
          "enforced",
          "limit",
          "used",
          "plan",
          "toolSlug",
          "executionMode",
          "ownerType",
          "surface",
          "inputSizeBucket",
          "outputSizeBucket",
        ].includes(k),
      ) && !JSON.stringify(denial).includes(meId),
      `keys ${Object.keys(props).join(",")} ownerType ${denial?.ownerType}`,
    );

    // -----------------------------------------------------------------------
    section(5, "two submissions, one remaining operation");
    await quiesce(db, "section 4");
    await seedOps(db, LIMIT - 1);
    const before5 = await snapshot(db, storeEnforce);
    const race = await Promise.all([
      submit(),
      submit(),
    ]);
    const afterRace = await opsAmount(db);
    const admitted = race.filter((r) => r.status === 202);
    const denied = race.filter((r) => r.status === 429);
    check(
      "exactly one of the two simultaneous submissions is admitted",
      admitted.length === 1 && denied.length === 1,
      `statuses ${race.map((r) => r.status).join(",")}`,
    );
    check(
      "the loser gets the ordinary limit response, not an error",
      denied[0]?.json?.reason === "meter_exhausted",
      `reason ${denied[0]?.json?.reason} body ${denied[0]?.text.slice(0, 160)}`,
    );
    check(
      "the failed admission is refunded, so the ceiling is never exceeded",
      afterRace <= LIMIT && afterRace >= LIMIT - 1,
      `ops ${before5.ops}→${afterRace} (ceiling ${LIMIT})`,
    );
    check(
      "only one job was created by the race",
      (await db.job.count({ where: { type: { in: JOB_TYPES } } })) === before5.jobs + 1,
      `jobs ${before5.jobs}→${await db.job.count({ where: { type: { in: JOB_TYPES } } })}`,
    );

    // -----------------------------------------------------------------------
    section(6, "the usage API agrees with the authoritative counters");
    const settled = await quiesce(db, "the race");
    const usage6 = await get(base, "/api/usage", { store: user });
    const ops6 = usage6.json?.meters?.find((m) => m.meter === OPS);
    check(
      "the projection the browser reads matches the counter rows exactly",
      ops6?.used === settled &&
        ops6?.limit === LIMIT &&
        ops6?.remaining === Math.max(0, LIMIT - settled) &&
        usage6.json?.degraded === false,
      `api used ${ops6?.used} remaining ${ops6?.remaining} vs counters ${settled}`,
    );

    // -----------------------------------------------------------------------
    section(7, "a browser-only tool is unaffected and unmetered");
    await seedOps(db, LIMIT);
    const before7 = await snapshot(db, storeEnforce);
    const localPage = await get(base, "/tools/merge-pdf", { store: user });
    const localViaApi = await submit({ slug: "merge-pdf" });
    const after7 = await snapshot(db, storeEnforce);
    check(
      "the local tool page still serves while the server allowance is exhausted",
      localPage.status === 200 && localPage.text.length > 500,
      `status ${localPage.status} bytes ${localPage.text.length}`,
    );
    check(
      "a local slug cannot be pushed through the job API at all, let alone metered",
      localViaApi.status === 404 && after7.ops === before7.ops && after7.jobs === before7.jobs,
      `status ${localViaApi.status} ops ${before7.ops}→${after7.ops} jobs ${before7.jobs}→${after7.jobs}`,
    );
    environmentLimited(
      "the local merge running in a real browser with no network traffic",
      "covered by scripts/processing-pilot-probe.mjs section 6, which watches Chrome's own network stack",
    );

    // -----------------------------------------------------------------------
    section(8, "a failed job refunds once, and a retry buys nothing");
    const base8 = await quiesce(db, "section 7");
    await seedOps(db, 0);
    const before8 = await snapshot(db, storeEnforce);
    const doomed = await submit();
    const chargedNow = await opsAmount(db);
    const terminal = await awaitTerminal(base, user, doomed.json.jobId);
    await quiesce(db, "the failed job");
    const after8 = await snapshot(db, storeEnforce);
    const attemptEvents = await db.usageEvent.findMany({
      where: { eventName: "tool_processing_completed" },
      orderBy: { occurredAt: "asc" },
    });
    const mine = attemptEvents.slice(before8.attempts);
    const computed = mine.reduce((sum, e) => sum + (e.costUnits ?? 0), 0);
    // Every attempt this deployment ever made, because `compute_units` is a MONTH
    // window: the counter holds the whole run, so the only honest cross-check is
    // against every attempt event, not just this job's three.
    const computedAll = attemptEvents.reduce((sum, e) => sum + (e.costUnits ?? 0), 0);
    const compute = (await counterRows(db, "compute_units")).reduce((s, r) => s + r.amount, 0);
    check(
      "the submission was charged one operation up front",
      doomed.status === 202 && chargedNow === 1,
      `status ${doomed.status} ops ${base8}→${chargedNow} (seeded 0)`,
    );
    check(
      "the job really did run more than once before giving up",
      terminal.status === "failed" && terminal.attempt === terminal.maxAttempts && mine.length === terminal.maxAttempts,
      `status ${terminal.status} attempt ${terminal.attempt}/${terminal.maxAttempts} ` +
        `category ${terminal.errorCategory} attempt-events ${mine.length}`,
    );
    check(
      "those retries cost the customer nothing: one operation charged, one refunded",
      after8.ops === 0 && after8.settlements === before8.settlements + 1,
      `ops 0→1→${after8.ops} settlements ${before8.settlements}→${after8.settlements}`,
    );
    check(
      "the refund went back into the reservation's own window, not a new one",
      (await counterRows(db, OPS)).length === 1,
      `${OPS} windows ${(await counterRows(db, OPS)).length}`,
    );
    check(
      "compute is still recorded per attempt, and is never refunded",
      computed > 0 && compute === computedAll && mine.map((e) => e.attempt).join(",") === "1,2,3",
      `compute_units ${compute} = sum(costUnits) ${computedAll} (this job ${computed}) ` +
        `over attempts ${mine.map((e) => e.attempt).join(",")}`,
    );
    const retry = await postJson(base, `/api/jobs/${doomed.json.jobId}/retry`, { store: user });
    const after8b = await snapshot(db, storeEnforce);
    check(
      "the user's retry is refused on the attempt budget, not by charging again",
      retry.status === 409 &&
        retry.json?.reason === "attempts_exhausted" &&
        after8b.ops === after8.ops &&
        after8b.settlements === after8.settlements,
      `status ${retry.status} reason ${retry.json?.reason} ops ${after8.ops}→${after8b.ops} ` +
        `settlements ${after8.settlements}→${after8b.settlements}`,
    );

    // -----------------------------------------------------------------------
    section(9, "the mode a deployment gets when it configures nothing");
    const { base: observeBase, origin: observeOrigin } = await startServer({
      port: PORT_DEFAULT,
      dbUrl: dbDefault,
      storageRoot: storeDefault,
      mode: undefined,
    });
    const observer = jar();
    await signup(
      observeBase,
      observer,
      `observe-${randomBytes(6).toString("hex")}@probe.test`,
      observeOrigin,
    );
    const usage9 = await get(observeBase, "/api/usage", { store: observer });
    check(
      "a deployment that sets no USAGE_LIMIT_MODE observes rather than enforces",
      usage9.json?.mode === "observe",
      `mode ${usage9.json?.mode} (this is what production runs)`,
    );
    // One real submission to open the window, then push it far past the ceiling.
    const seedSubmit = await submitJob(observeBase, observer, pdf, { origin: observeOrigin });
    await quiesce(dbObserve, "the observe-mode seed job");
    await (async () => {
      const rows = await counterRows(dbObserve, OPS);
      if (rows.length !== 1) throw new Error(`expected one window, found ${rows.length}`);
      await dbObserve.usageCounter.update({
        where: { id: rows[0].id },
        data: { amount: LIMIT + 5 },
      });
    })();
    const before9 = await snapshot(dbObserve, storeDefault);
    const overLimit = await submitJob(observeBase, observer, pdf, { origin: observeOrigin });
    const after9 = await snapshot(dbObserve, storeDefault);
    check(
      "the same request that was refused under enforce is admitted under observe",
      seedSubmit.status === 202 && overLimit.status === 202,
      `seed ${seedSubmit.status} over-limit ${overLimit.status} at used ${LIMIT + 5}/${LIMIT}`,
    );
    check(
      "the work is still counted, so the observation measures real traffic",
      after9.ops === before9.ops + 1 && after9.jobs === before9.jobs + 1,
      `ops ${before9.ops}→${after9.ops} jobs ${before9.jobs}→${after9.jobs}`,
    );
    const observed = await dbObserve.usageEvent.findFirst({
      where: { eventName: "limit_reached" },
      orderBy: { occurredAt: "desc" },
    });
    const observedProps = observed?.properties ? JSON.parse(observed.properties) : {};
    check(
      "the would-have-denied is still recorded, marked NOT enforced",
      after9.denials > before9.denials && observedProps.enforced === false,
      `events ${before9.denials}→${after9.denials} properties ${observed?.properties}`,
    );
  } finally {
    await db.$disconnect().catch(() => {});
    await dbObserve.$disconnect().catch(() => {});
    for (const entry of servers) killServer(entry);
    await sleep(300);
    rmSync(root, { recursive: true, force: true });
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  for (const l of limits) console.log(`  ENVIRONMENT-LIMITED: ${l.name} — ${l.reason}`);
  console.log(
    "Production activation is NOT covered here: this probe supplies " +
      "USAGE_LIMIT_MODE=enforce to a throwaway deployment. Whether production may " +
      "switch is the calibration readiness verdict's decision.",
  );
  if (failed.length) {
    console.log("\nFAILURES:");
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\nPROBE ERROR: ${err instanceof Error ? err.stack : String(err)}`);
  for (const entry of servers) {
    console.error(`\n--- server :${entry.port} log tail ---\n${entry.tail()}`);
    killServer(entry);
  }
  process.exit(2);
});
