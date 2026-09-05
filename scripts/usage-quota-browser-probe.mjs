/* global process, console, fetch, WebSocket, setTimeout, clearTimeout, Buffer */
/**
 * PERMANENT runtime probe: the QUOTA DENIAL UX, in a REAL browser.
 *
 * WHY THIS EXISTS. `scripts/usage-enforcement-probe.mjs` proves the SERVER refuses
 * — 429, closed reason vocabulary, no counter movement, nothing staged. It cannot
 * prove that a refused person is ever told anything, because it never renders a
 * page. And vitest runs `environment: "node"`, so `QuotaNotice` has never been
 * mounted by any test in the suite. A fully green suite is compatible with all of:
 *
 *  - `QuotaNotice` throwing on mount, so the refusal shows as a blank space;
 *  - its `/api/usage` fetch blocked by CSP, so the panel renders with no plan and
 *    no reset — the two facts it exists to supply;
 *  - the panel AND the generic red `ErrorBanner` both rendering, telling the user
 *    twice, once without the plan;
 *  - `ProUpgradeAction` throwing on a deployment that cannot sell Pro, which is
 *    every self-hosted deployment;
 *  - a local, in-browser tool showing a quota panel it has no business showing, or
 *    quietly consuming a server operation it never used.
 *
 * PRODUCTION STAYS IN OBSERVE MODE. This probe runs its own throwaway deployment
 * with `USAGE_LIMIT_MODE=enforce` to exercise the blocking path, against a fresh
 * SQLite file under the OS temp directory. Nothing here touches the developer
 * database, `.env`, or the default mode. Section 7 then restarts the SAME
 * exhausted fixture with the variable UNSET and requires the work to go through,
 * which is the claim production actually depends on.
 *
 * THE HAZARD IT IS BUILT AGAINST is a vacuous pass — "the quota panel appeared"
 * proves nothing if the panel appears for every failure, or if the allowance was
 * never really spent:
 *
 *  - The ceiling is READ from `/api/usage` (section 1). Nothing here types a
 *    number; a probe that hardcoded 100 would keep passing after the free plan
 *    changed, and would be testing its own constant.
 *  - Before any denial is asserted, section 3 requires the PREVIOUS submission to
 *    have been ADMITTED (a 202 off the wire) and the counter to have reached the
 *    boundary exactly (`remaining: 0` from the server's own projection).
 *  - Section 4 requires a real 429 observed on the wire, not merely a panel: a
 *    panel that renders on any failure would satisfy the DOM check alone.
 *  - Section 6 requires the local tool to have really produced output — a download
 *    control it can actually click — before "no quota panel" means anything.
 *  - Section 7 requires the same submission that was refused in section 4 to
 *    SUCCEED once the mode is default, so a build that can never refuse and a
 *    build that always refuses both fail.
 *
 * WHAT IT PINS, as the mutations it was built against:
 *
 *  - `QuotaNotice` rendered for any error rather than a known denial: section 6
 *    fails — the local tool's page shows a quota panel.
 *  - `readDenialReason` widened to trust any 429: section 4 still passes, but the
 *    unit suite's `quotaDenialUx.test.ts` covers that arm; this probe's job is the
 *    render, and section 7 fails if the panel survives observe mode.
 *  - The panel and the banner both rendered: section 4's single-alert check fails.
 *  - The 429 body widened back to `{ meter, limit, used }`, or the panel printing
 *    a meter key: section 4's leak check fails against the panel's own subtree.
 *  - `ProUpgradeAction` made unconditional: section 4 fails on a dead upgrade
 *    control in a deployment with no billing provider.
 *  - A local tool routed through `/api/jobs`: section 6 fails on a new job row.
 *  - `resolveLimitMode` defaulting to enforce: section 7 fails.
 *
 * RUN IT. The probe starts everything it needs — server, TLS terminator, browser:
 *
 *   node scripts/next-build.js
 *   node scripts/usage-quota-browser-probe.mjs [--port 3171] [--host <lan-ip>]
 *
 * REAL HTTPS IS LOAD-BEARING, not decoration. The anonymous owner cookie
 * (`pdfdadi_jid`) is `Secure` under `NODE_ENV=production`, so on a plain `http://`
 * origin Chrome drops it, every request resolves a DIFFERENT anonymous owner, and
 * the counter can never accumulate — the quota would never exhaust and the probe
 * would report a UX bug that is really a cookie. And the production startup gate
 * refuses a loopback `NEXT_PUBLIC_SITE_URL`, so `https://localhost` is not on the
 * table either. Hence: the standalone artifact on loopback http, a self-signed
 * terminator on a LAN address in front of it (`scripts/tls-front.mjs`), and Chrome
 * told to accept that certificate. The gate is not weakened for any of it.
 *
 * `CHROME_PATH` overrides the browser binary.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { PrismaClient } from "@prisma/client";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

/** The https port the browser talks to. The app itself is served one port above it. */
const LISTEN = Number(arg("--port", "3171"));
const TARGET = LISTEN + 1;
const DEBUG_PORT = 9521;
const CHROME =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OPS = "server_operations";
const PIPELINE_SLUG = "compress-pdf";
const LOCAL_SLUG = "merge-pdf";
/** Mirrors TERMINAL_STATUSES in src/domain/jobs/jobStateMachine.ts. */
const TERMINAL = ["completed", "failed", "cancelled", "expired"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const notes = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: !!ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function note(text) {
  notes.push(text);
  console.log(`  ··   ${text}`);
}
const section = (n, title) => console.log(`\n── ${n}. ${title}`);

/** The non-loopback address the gate will accept as a public origin. */
function lanAddress() {
  const explicit = arg("--host", null);
  if (explicit) return explicit;
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  throw new Error("no non-loopback IPv4 interface; pass --host <address>");
}

async function makeFixture(pages = 3) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i += 1) {
    const page = doc.addPage([612, 792]);
    for (let row = 0; row < 36; row += 1) {
      page.drawText(`Page ${i + 1} line ${row + 1} — synthetic probe document`, {
        x: 40,
        y: 740 - row * 19,
        size: 11,
        font,
        color: rgb(0.1, 0.1, 0.25),
      });
    }
  }
  return Buffer.from(await doc.save());
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

const running = [];

/**
 * Starts the standalone artifact behind the already-running terminator.
 *
 * Restartable on the same port on purpose: sections 5 and 7 need a DIFFERENT
 * configuration against the SAME database and the SAME browser cookie jar. Moving
 * ports instead would mint a new anonymous owner, and the exhausted fixture the
 * later sections depend on would silently not apply to them.
 */
async function startServer({ dbUrl, storageRoot, siteUrl, mode, pipeline }) {
  const dir = process.cwd();
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(TARGET),
    HOSTNAME: "127.0.0.1",
    DATABASE_URL: dbUrl,
    ADMIN_SECRET: "probe-admin-secret-not-a-real-one",
    NEXT_PUBLIC_SITE_URL: siteUrl,
    STORAGE_LOCAL_ROOT: storageRoot,
    // The admin store, beside the storage root and outside the repository. Required
    // for the same reason as the two above: unset it resolves against the working
    // directory, and `ingress/server.mjs` chdirs into `.next/standalone`, which the
    // production gate refuses — the server would exit 1 and every check below would
    // read as a product failure.
    ADMIN_STORE_DIR: `${storageRoot}-admin`,
    PROCESSING_PIPELINE: pipeline,
    // `undefined` means "leave unset", so section 7 observes the DEFAULT rather
    // than a value this probe supplied.
    USAGE_LIMIT_MODE: mode,
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];

  // `ingress/server.mjs` from the repository root, not `server.js` from inside
  // `.next/standalone`: the guarded entry is the only production topology, and the
  // generated entry now exits 1 under NODE_ENV=production without it. The Next
  // entry it loads chdirs into its own directory, so paths are unchanged.
  const child = spawn("node", ["ingress/server.mjs"], {
    cwd: dir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d.toString()));
  child.stderr.on("data", (d) => (log += d.toString()));
  const handle = { child, tail: () => log.slice(-2500) };
  running.push(handle);

  // Health-polled over plain loopback http, deliberately: a TLS handshake failure
  // during startup would otherwise be indistinguishable from a server that never
  // booted, and the gate's refusal message would never be read.
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await sleep(500);
    try {
      if ((await fetch(`http://127.0.0.1:${TARGET}/api/health`)).ok) return handle;
    } catch {
      /* not listening yet */
    }
  }
  throw new Error(`server never became healthy on ${TARGET}:\n${log.slice(-2000)}`);
}

function stopServer(handle) {
  try {
    process.kill(-handle.child.pid, "SIGKILL");
  } catch {
    try {
      handle.child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

async function main() {
  const host = lanAddress();
  const siteUrl = `https://${host}:${LISTEN}`;
  const root = mkdtempSync(join(tmpdir(), "usage-quota-browser-"));
  const dbUrl = `file:${join(root, "quota.db")}`;
  const storageRoot = join(root, "storage");
  const fixturePath = join(root, "probe-document.pdf");
  writeFileSync(fixturePath, await makeFixture());

  section(0, "Isolated fixtures, an HTTPS origin, and one enforce deployment");
  console.log(`  fixtures: ${root}`);
  console.log(`  origin:   ${siteUrl} → http://127.0.0.1:${TARGET}`);
  await migrate(dbUrl);

  // The standalone artifact does not carry these; the Dockerfile copies them in.
  // Without them the page ships no client JS, React never hydrates, and QuotaNotice
  // — a client component — could not render even if it were perfect.
  const sa = join(process.cwd(), ".next", "standalone");
  if (!existsSync(join(sa, "server.js"))) {
    throw new Error("no standalone artifact — run `node scripts/next-build.js` first");
  }
  cpSync(join(process.cwd(), ".next", "static"), join(sa, ".next", "static"), { recursive: true });
  // `public/` is optional — this repo serves no static assets from one — so it is
  // copied only if it exists rather than assumed, the way the Dockerfile does.
  if (existsSync(join(process.cwd(), "public"))) {
    cpSync(join(process.cwd(), "public"), join(sa, "public"), { recursive: true });
  }

  const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

  // ---- terminator ---------------------------------------------------------
  const tls = spawn(
    "node",
    ["scripts/tls-front.mjs", "--listen", String(LISTEN), "--target", String(TARGET), "--host", host],
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  let tlsLog = "";
  tls.stdout.on("data", (d) => (tlsLog += d.toString()));
  tls.stderr.on("data", (d) => (tlsLog += d.toString()));
  await sleep(1200);
  check("an HTTPS terminator is listening on a non-loopback origin", /https:\/\//.test(tlsLog),
    tlsLog.split("\n")[0] ?? "no output");

  let server = await startServer({
    dbUrl, storageRoot, siteUrl, mode: "enforce", pipeline: "on",
  });
  check("the enforce deployment booted with the production gate unweakened", true,
    `site url ${siteUrl}`);

  // ---- browser ------------------------------------------------------------
  const userDataDir = mkdtempSync(join(tmpdir(), "quota-chrome-"));
  spawnSync("pkill", ["-f", `remote-debugging-port=${DEBUG_PORT}`], { stdio: "ignore" });
  await sleep(400);
  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${userDataDir}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      "--window-size=1440,1100",
      // The terminator's certificate is generated per run and trusted by nobody.
      // Passed as a flag rather than installed, so no repo file and no keychain
      // learns about it.
      "--ignore-certificate-errors",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let targets = null;
  for (let attempt = 0; attempt < 40 && !targets; attempt += 1) {
    await sleep(300);
    try {
      targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    } catch {
      targets = null;
    }
  }
  if (!targets) throw new Error(`Chrome never opened a debug port on ${DEBUG_PORT}`);
  const target = targets.find((t) => t.type === "page");
  if (!target) throw new Error("Chrome exposed no page target");
  const sock = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    sock.addEventListener("open", res, { once: true });
    sock.addEventListener("error", rej, { once: true });
  });

  let id = 0;
  const pending = new Map();
  /** Every /api/jobs submit response seen on the wire, in order. */
  let submits = [];
  /** requestId → request headers, for the submits only. */
  const submitRequests = new Map();
  const consoleErrors = [];
  sock.addEventListener("message", (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    // The submit, not the polls: `/api/jobs?slug=` is the authoritative admission
    // decision, and `/api/jobs/<id>` is the status read. The request half is kept
    // as well as the response half, because the request HEADERS are the only place
    // the two runners are distinguishable — see section 5.
    if (msg.method === "Network.requestWillBeSent") {
      const url = msg.params?.request?.url ?? "";
      if (/\/api\/jobs\?slug=/.test(url) && msg.params.request.method === "POST") {
        submitRequests.set(msg.params.requestId, msg.params.request.headers ?? {});
      }
    }
    if (msg.method === "Network.responseReceived") {
      const url = msg.params?.response?.url ?? "";
      if (/\/api\/jobs\?slug=/.test(url)) {
        const headers = submitRequests.get(msg.params.requestId) ?? {};
        const key = Object.entries(headers).find(([h]) => h.toLowerCase() === "idempotency-key");
        submits.push({ status: msg.params.response.status, url, idempotencyKey: key?.[1] ?? null });
      }
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      consoleErrors.push(
        (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200),
      );
    }
    if (msg.method === "Runtime.exceptionThrown") {
      consoleErrors.push(msg.params?.exceptionDetails?.text ?? "exception");
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      const timer = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), 45_000);
      pending.set(mid, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      sock.send(JSON.stringify({ id: mid, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (res.result?.exceptionDetails) return { __err: res.result.exceptionDetails.text };
    return res.result?.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("DOM.enable");

  const goto = async (path) => {
    await send("Page.navigate", { url: `${siteUrl}${path}` });
    await sleep(3000);
  };
  const attachFile = async (paths) => {
    const doc = await send("DOM.getDocument", { depth: 1 });
    const q = await send("DOM.querySelector", {
      nodeId: doc.result.root.nodeId,
      selector: 'input[type="file"]',
    });
    if (!q.result?.nodeId) throw new Error("no file input on the page");
    await send("DOM.setFileInputFiles", { nodeId: q.result.nodeId, files: paths });
  };
  const clickButton = (label) =>
    evaluate(`(() => {
      const el = [...document.querySelectorAll('button')]
        .find((b) => b.innerText.trim().toLowerCase().includes(${JSON.stringify(label.toLowerCase())}));
      if (!el) return { ok: false, labels: [...document.querySelectorAll('button')].map((b) => b.innerText.trim().slice(0, 30)).filter(Boolean) };
      if (el.disabled) return { ok: false, disabled: true };
      el.click();
      return { ok: true, label: el.innerText.trim().slice(0, 40) };
    })()`);
  /**
   * Every alert panel on the page, with its own text and its own styling.
   *
   * Read as separate records rather than as page text, because "the page mentions
   * a usage limit" is satisfied by the privacy note, by a toast, and by the tool's
   * own prose. The panel's subtree is the only place a leak claim can be made.
   */
  const alerts = () =>
    evaluate(`[...document.querySelectorAll('[role="alert"]')].map((el) => ({
      text: (el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 400),
      amber: /amber/.test(el.className || ""),
      red: /red/.test(el.className || ""),
      buttons: [...el.querySelectorAll('button, a')].map((b) => (b.innerText || "").trim().slice(0, 40)).filter(Boolean),
    }))`);
  /** The server's own usage projection, read same-origin from the page. */
  const usage = () =>
    evaluate(`(async () => {
      const r = await fetch("/api/usage", { cache: "no-store" });
      return { status: r.status, body: r.ok ? await r.json() : null };
    })()`);
  const opsMeter = (body) => (body?.meters ?? []).find((m) => m.meter === OPS);

  /** Runs one server tool from its page and returns what the browser ended up showing. */
  const runServerTool = async (slug) => {
    submits = [];
    await goto(`/tools/${slug}`);
    await attachFile([fixturePath]);
    await sleep(2200);
    const clicked = await clickButton("compress pdf");
    // Long enough for the submit to answer and for the panel to mount; a refusal
    // is immediate, an admission then streams progress.
    await sleep(6000);
    return { clicked, submits: [...submits], alerts: await alerts() };
  };

  /**
   * Tool jobs only.
   *
   * The `file-retention` sweep is a recurring SYSTEM job that sits at `queued`
   * between runs, by design, forever. Counting it would make "nothing is in
   * flight" unreachable and "no new job was created" a coin flip on when the
   * sweep last re-enqueued itself. A non-null `toolSlug` is exactly "someone ran
   * a tool", which is the only kind of job that can hold a metering reservation.
   */
  const TOOL_JOB = { toolSlug: { not: null } };
  const toolJobCount = () => db.job.count({ where: TOOL_JOB });

  /** Waits until nothing is in flight, so a straggling refund cannot move a number a claim rests on. */
  const quiesce = async () => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const open = await db.job.count({ where: { ...TOOL_JOB, status: { notIn: TERMINAL } } });
      if (open === 0) return;
      await sleep(500);
    }
    const stuck = await db.job.findMany({
      where: { ...TOOL_JOB, status: { notIn: TERMINAL } },
      select: { id: true, status: true, toolSlug: true, error: true },
    });
    throw new Error(`jobs never settled: ${JSON.stringify(stuck)}\n${server.tail()}`);
  };
  const counterRow = async () => {
    const rows = await db.usageCounter.findMany({ where: { meter: OPS } });
    if (rows.length > 1) throw new Error(`expected one ${OPS} window, found ${rows.length}`);
    return rows[0] ?? null;
  };
  const seedOps = async (amount) => {
    const row = await counterRow();
    if (!row) throw new Error("no counter row to seed — no real submission has been charged yet");
    await db.usageCounter.update({ where: { id: row.id }, data: { amount } });
    return amount;
  };

  try {
    /* ================================================== 1. the real ceiling */
    section(1, "The deployment is enforcing, and the ceiling is read, never assumed");
    await goto("/");
    const first = await usage();
    check("GET /api/usage answers from the page's own origin", first?.status === 200,
      `status ${first?.status}`);
    check("this deployment reports mode enforce", first?.body?.mode === "enforce",
      `mode ${first?.body?.mode}`);
    const meter0 = opsMeter(first?.body);
    const LIMIT = meter0?.limit;
    check("the server operations ceiling is a real number read off /api/usage",
      Number.isFinite(LIMIT) && LIMIT > 0, `limit ${LIMIT}`);
    check("the fixture starts unspent", meter0?.used === 0, `used ${meter0?.used}`);
    note(`ceiling ${LIMIT} operations per ${meter0?.window}, plan ${first?.body?.planLabel}`);
    if (!Number.isFinite(LIMIT) || LIMIT <= 0) {
      throw new Error("cannot continue without a ceiling read from the server");
    }

    /* ============================================ 2. an admitted submission */
    section(2, "A real submission is admitted, and the meter moves");
    const run2 = await runServerTool(PIPELINE_SLUG);
    check("the action button was clickable", run2.clicked?.ok === true,
      JSON.stringify(run2.clicked).slice(0, 160));
    check("the submit was ADMITTED on the wire", run2.submits.some((s) => s.status === 202),
      `statuses ${run2.submits.map((s) => s.status).join(",") || "none"}`);
    check("no quota panel is shown for an admitted submission",
      !run2.alerts?.some((a) => /allowance for now|usage limit/i.test(a.text)),
      (run2.alerts ?? []).map((a) => a.text.slice(0, 60)).join(" | ") || "no alerts");
    const usage2 = await usage();
    check("the meter moved: the browser's operation was charged",
      (opsMeter(usage2?.body)?.used ?? 0) >= 1, `used ${opsMeter(usage2?.body)?.used}`);
    const job = await db.job.findFirst({ where: TOOL_JOB, orderBy: { createdAt: "desc" } });
    check("a real job row exists, owned by the browser's anonymous identity",
      Boolean(job?.ownerId) && job?.ownerType === "anon",
      `${job?.ownerType} ${job?.ownerId?.slice(0, 8)}… slug ${job?.toolSlug}`);
    await quiesce();
    const settled = await counterRow();
    note(`after settlement the counter reads ${settled?.amount} (a failed job refunds, a completed one does not)`);

    /* ================================================= 3. reach the boundary */
    section(3, "The remaining allowance is spent by a REAL run, to the exact boundary");
    await seedOps(LIMIT - 1);
    const run3 = await runServerTool(PIPELINE_SLUG);
    check("the LAST allowance is admitted, not refused",
      run3.submits.some((s) => s.status === 202) && !run3.submits.some((s) => s.status === 429),
      `statuses ${run3.submits.map((s) => s.status).join(",") || "none"}`);
    const usage3 = await usage();
    const m3 = opsMeter(usage3?.body);
    check("the server's own projection now reports the boundary reached",
      m3?.used === LIMIT && m3?.remaining === 0, `used ${m3?.used}/${m3?.limit} remaining ${m3?.remaining}`);
    check("no quota panel yet — the boundary is reached, not exceeded",
      !run3.alerts?.some((a) => /allowance for now/i.test(a.text)),
      (run3.alerts ?? []).map((a) => a.text.slice(0, 50)).join(" | ") || "no alerts");
    await quiesce();
    // Re-established after settlement rather than relied on: on a host where the
    // job FAILS the operation is refunded, and section 4 would then be testing an
    // allowance that still had room in it.
    await seedOps(LIMIT);
    const atLimit = await usage();
    check("the fixture is exhausted going into the denial",
      opsMeter(atLimit?.body)?.remaining === 0,
      `used ${opsMeter(atLimit?.body)?.used}/${LIMIT}`);

    /* ================================================ 4. the denial, in the UI */
    section(4, "The next submission is refused, and the user is told what and why");
    const jobsBefore = await toolJobCount();
    const run4 = await runServerTool(PIPELINE_SLUG);
    check("the submit was REFUSED with 429 on the wire",
      run4.submits.some((s) => s.status === 429),
      `statuses ${run4.submits.map((s) => s.status).join(",") || "none"}`);
    check("and it was the PIPELINE runner that was refused (its submit carries an Idempotency-Key)",
      run4.submits.every((s) => typeof s.idempotencyKey === "string" && s.idempotencyKey.length > 0),
      `keys ${JSON.stringify(run4.submits.map((s) => s.idempotencyKey))}`);
    const quota = (run4.alerts ?? []).filter((a) => /allowance for now/i.test(a.text));
    check("the quota panel actually rendered", quota.length === 1,
      `${quota.length} matching alert(s) of ${(run4.alerts ?? []).length}`);
    const panel = quota[0];
    check("it says what ran out, in the domain's own words",
      /reached your usage limit/i.test(panel?.text ?? ""), (panel?.text ?? "").slice(0, 120));
    check("it names the plan, read from the server's usage projection",
      new RegExp(first?.body?.planLabel ?? "Free", "i").test(panel?.text ?? ""),
      `plan label ${first?.body?.planLabel}`);
    check("it says when the allowance returns", /reset/i.test(panel?.text ?? ""),
      (panel?.text ?? "").slice(-90));
    check("no meter key, counter or owner reaches the panel",
      !/server_operations|server_input_bytes|ownerId|counter|periodStart/i.test(panel?.text ?? ""),
      (panel?.text ?? "").slice(0, 100));
    check("the raw numbers stay behind /api/usage",
      !new RegExp(`\\b${LIMIT}\\b`).test(panel?.text ?? ""), `must not print ${LIMIT}`);
    check("no second, generic error banner tells the user again",
      (run4.alerts ?? []).filter((a) => a.red).length === 0,
      (run4.alerts ?? []).map((a) => `${a.red ? "red" : "amber"}:${a.text.slice(0, 40)}`).join(" | "));
    // This deployment has no billing provider configured, which is every
    // self-hosted deployment. The control must be ABSENT rather than dead.
    check("the upgrade control degrades to nothing where Pro cannot be sold",
      (panel?.buttons ?? []).every((b) => !/upgrade|pro\b/i.test(b)),
      `buttons in panel: ${JSON.stringify(panel?.buttons ?? [])}`);
    check("the refusal threw no client-side exception",
      !consoleErrors.some((e) => /QuotaNotice|ProUpgradeAction|usage/i.test(e)),
      consoleErrors.slice(-2).join(" | ") || "none");
    const after4 = await counterRow();
    check("a refusal costs nothing: the counter did not move past the ceiling",
      after4?.amount === LIMIT, `counter ${after4?.amount}, ceiling ${LIMIT}`);
    check("a refusal creates no job", (await toolJobCount()) === jobsBefore,
      `tool jobs ${await toolJobCount()} (was ${jobsBefore})`);

    /* ============================================ 5. the legacy remote runner */
    section(5, "The legacy remote runner reaches the SAME shared denial UX");
    stopServer(server);
    await sleep(1500);
    server = await startServer({
      dbUrl, storageRoot, siteUrl, mode: "enforce", pipeline: "off",
    });
    await seedOps(LIMIT);
    const run5 = await runServerTool(PIPELINE_SLUG);
    // The runner identity, OBSERVED rather than assumed from the env var. Only the
    // pipeline client sends an Idempotency-Key; the legacy runner has no such
    // header. Without this the section would restart the server, get the same 429
    // from the same runner, and report that two paths agree.
    check("the LEGACY runner is what is mounted now (its submit carries no Idempotency-Key)",
      run5.submits.length > 0 && run5.submits.every((s) => !s.idempotencyKey),
      `keys ${JSON.stringify(run5.submits.map((s) => s.idempotencyKey))}`);
    check("it is refused with the same 429", run5.submits.some((s) => s.status === 429),
      `statuses ${run5.submits.map((s) => s.status).join(",")}`);
    const quota5 = (run5.alerts ?? []).filter((a) => /allowance for now/i.test(a.text));
    check("it shows the SAME panel, not a bespoke one", quota5.length === 1,
      `${quota5.length} matching alert(s)`);
    check("with the same plan and reset information",
      /reset/i.test(quota5[0]?.text ?? "") &&
        new RegExp(first?.body?.planLabel ?? "Free", "i").test(quota5[0]?.text ?? ""),
      (quota5[0]?.text ?? "").slice(0, 120));
    check("and no generic banner beside it",
      (run5.alerts ?? []).filter((a) => a.red).length === 0,
      (run5.alerts ?? []).map((a) => a.text.slice(0, 40)).join(" | "));

    /* ================================================ 6. the local exemption */
    section(6, "A browser-only tool still works while the server allowance is spent");
    const jobsBefore6 = await toolJobCount();
    const counterBefore6 = (await counterRow())?.amount;
    await goto(`/tools/${LOCAL_SLUG}`);
    submits = [];
    await attachFile([fixturePath, fixturePath]);
    await sleep(2500);
    const clicked6 = await clickButton("merge pdfs");
    await sleep(8000);
    const text6 = await evaluate("document.body.innerText.replace(/\\s+/g,' ')");
    const alerts6 = await alerts();
    const download6 = await evaluate(
      `[...document.querySelectorAll('button, a')].map((b) => (b.innerText || "").trim()).filter((t) => /download/i.test(t))`,
    );
    check("the local tool accepted the files and ran", clicked6?.ok === true,
      JSON.stringify(clicked6).slice(0, 140));
    // The anti-vacuity clause for everything below: "no quota panel" on a page
    // where nothing happened is not an exemption, it is an idle page.
    check("it really produced a result the user can take",
      (download6 ?? []).length > 0, `download controls: ${JSON.stringify(download6)}`);
    const took = await clickButton("download");
    check("and the download control works", took?.ok === true, JSON.stringify(took).slice(0, 100));
    check("no quota panel anywhere on a local tool",
      !(alerts6 ?? []).some((a) => /allowance for now|usage limit/i.test(a.text)) &&
        !/allowance for now/i.test(text6 ?? ""),
      (alerts6 ?? []).map((a) => a.text.slice(0, 50)).join(" | ") || "no alerts");
    check("it submitted nothing to the job API", submits.length === 0,
      `submits ${JSON.stringify(submits)}`);
    // `Number.isFinite` guards the vacuous form of this: with no counter row at
    // all, "unchanged" would be `undefined === undefined` and would pass on a
    // deployment that never metered anything.
    check("it consumed no server operation",
      Number.isFinite(counterBefore6) && (await counterRow())?.amount === counterBefore6,
      `counter ${(await counterRow())?.amount} (was ${counterBefore6})`);
    check("and created no job row", (await toolJobCount()) === jobsBefore6,
      `tool jobs ${await toolJobCount()} (was ${jobsBefore6})`);

    /* =============================================== 7. observe is not blocking */
    section(7, "The default configuration does not block, on the SAME exhausted fixture");
    stopServer(server);
    await sleep(1500);
    server = await startServer({
      dbUrl, storageRoot, siteUrl, mode: undefined, pipeline: "on",
    });
    await seedOps(LIMIT);
    await goto("/");
    const usage7 = await usage();
    check("with USAGE_LIMIT_MODE unset the deployment reports observe",
      usage7?.body?.mode === "observe", `mode ${usage7?.body?.mode}`);
    check("the fixture is still over its ceiling", opsMeter(usage7?.body)?.remaining === 0,
      `used ${opsMeter(usage7?.body)?.used}/${LIMIT}`);
    const run7 = await runServerTool(PIPELINE_SLUG);
    check("the very submission that was refused is now ADMITTED",
      run7.submits.some((s) => s.status === 202) && !run7.submits.some((s) => s.status === 429),
      `statuses ${run7.submits.map((s) => s.status).join(",") || "none"}`);
    check("no hard-denial state is rendered in observe mode",
      !(run7.alerts ?? []).some((a) => /allowance for now/i.test(a.text)),
      (run7.alerts ?? []).map((a) => a.text.slice(0, 50)).join(" | ") || "no alerts");
    check("and the overage was RECORDED rather than refused",
      ((await counterRow())?.amount ?? 0) > LIMIT,
      `counter ${(await counterRow())?.amount}, ceiling ${LIMIT}`);
  } finally {
    try {
      sock.close();
    } catch {
      /* already closed */
    }
    chrome.kill("SIGKILL");
    for (const handle of running) stopServer(handle);
    try {
      process.kill(-tls.pid, "SIGKILL");
    } catch {
      tls.kill("SIGKILL");
    }
    await db.$disconnect();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  for (const n of notes) console.log(`  note: ${n}`);
  if (failed.length) {
    console.log("\nFAILED:");
    for (const f of failed) console.log(`  · ${f.name} — ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  for (const handle of running) stopServer(handle);
  process.exit(1);
});
