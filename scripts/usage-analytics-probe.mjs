/* global process, console, fetch, WebSocket, setTimeout, clearTimeout */
/**
 * Slice 4 smoke probe: the two READ surfaces, against a real browser.
 *
 * WHY A BROWSER. Everything this slice added is tested in Node against fakes, and
 * vitest runs with `environment: "node"` — so no test in the suite has ever
 * rendered `UsageCard` or `AnalyticsDashboard`. A fully green suite is compatible
 * with a card that throws on mount, a fetch the CSP blocks, an admin page that
 * renders behind an unauthenticated 401, and a funnel that never receives an
 * event because the client hook does not fire in a production bundle.
 *
 * WHAT IT WALKS:
 *   1. /api/usage and /api/admin/analytics unauthenticated  → the guard is real
 *   2. admin login → /admin/analytics → the ZERO-DATA state renders
 *   3. a real Merge run in the browser on a SYNTHETIC PDF     → events are emitted
 *   4. refresh the dashboard → funnel + usage figures MOVED
 *   5. sign in as a user → the usage card matches /api/usage, with no identifiers
 *
 * THE HAZARD IT IS BUILT AGAINST is a vacuous pass. The zero state and the
 * populated state are both asserted, and step 4 requires the numbers to CHANGE:
 * a build where the analytics hook never fires cannot satisfy both. The document
 * is generated in-page from a data URI (see makeSyntheticPdf) — no real private
 * document content is ever loaded.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (f, d) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : d;
};
const BASE = arg("--url", "http://localhost:3011");
const ADMIN_PW = arg("--admin-pw", "");
/**
 * `--retry-walk`: run section 6c, which needs a deployment whose processing
 * binary is ABSENT.
 *
 * Opt-in rather than automatic, because a retry cannot be forced on a healthy
 * host — Ghostscript accepts almost anything, so a synthetic "bad" document
 * compresses fine. The way to get a *retryable* failure through the real worker
 * is a deployment without the binary at all: `dependency_unavailable` is
 * retryable, so the attempt budget is spent and the job then fails terminally.
 * Start the server with the pipeline on and the binary off the PATH, e.g.
 *
 *   PROCESSING_PIPELINE=on PATH=/usr/bin:/bin PORT=3011 npm run start
 *
 * A flag rather than a silent skip: this section either runs and asserts, or is
 * absent from the report. It never passes by not being exercised.
 */
const RETRY_WALK = process.argv.includes("--retry-walk");
const CHROME =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), "pdfdadi-slice4-"));
  const port = 9497;
  spawnSync("pkill", ["-f", `remote-debugging-port=${port}`], { stdio: "ignore" });
  await sleep(400);
  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      "--window-size=1440,1000",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  // Poll for readiness rather than sleeping a guessed interval: a fixed wait is
  // either slower than it needs to be or, on a loaded machine, short enough to
  // fail with ECONNREFUSED and look like a missing browser.
  let targets = null;
  for (let attempt = 0; attempt < 40 && !targets; attempt += 1) {
    await sleep(300);
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    } catch {
      targets = null;
    }
  }
  if (!targets) throw new Error(`Chrome never opened a debug port on ${port}`);
  const target = targets.find((t) => t.type === "page");
  if (!target) throw new Error("Chrome exposed no page target");
  const sock = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    sock.addEventListener("open", res, { once: true });
    sock.addEventListener("error", rej, { once: true });
  });

  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  sock.addEventListener("message", (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      consoleErrors.push(
        (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 240),
      );
    }
    if (msg.method === "Runtime.exceptionThrown") {
      consoleErrors.push(msg.params?.exceptionDetails?.text ?? "exception");
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      const timer = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), 40_000);
      pending.set(mid, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      sock.send(JSON.stringify({ id: mid, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.result?.exceptionDetails) return { __err: res.result.exceptionDetails.text };
    return res.result?.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");

  const goto = async (path) => {
    await send("Page.navigate", { url: `${BASE}${path}` });
    await sleep(2600);
  };
  /** Visible text of the whole page, collapsed. */
  const text = () => evaluate("document.body.innerText.replace(/\\s+/g,' ')");

  /** Clicks an element by its visible label, with a real mouse event. */
  /**
   * Clicks the first enabled element whose text matches, by real mouse input.
   *
   * The scroll and the coordinate read are two separate evaluates on purpose.
   * Reading the rect in the same turn as `scrollIntoView` returns the PRE-scroll
   * position, and a tool page's action button sits well below a 1000px viewport —
   * so the click landed on empty space, the tool never ran, and the only symptom
   * was a funnel that stopped at `file_selected` with nothing anywhere saying a
   * click had missed. If the element still cannot be brought into view, its own
   * handler is invoked rather than clicking blind coordinates, and that is
   * reported as `via: "dom"` so a pass never hides which path was taken.
   */
  const clickByLabel = async (labelRe, selector = "button, a") => {
    const found = await evaluate(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const b = els.find((el) => ${labelRe}.test(el.textContent || "") && !el.disabled);
      if (!b) return { ok: false, labels: els.filter((e) => !e.disabled).map((e) => (e.textContent || "").trim().slice(0, 28)).filter(Boolean) };
      b.setAttribute("data-probe-target", "1");
      b.scrollIntoView({ block: "center", behavior: "instant" });
      return { ok: true, label: (b.textContent || "").trim().slice(0, 40) };
    })()`);
    if (!found?.ok) return found;
    await sleep(350);
    const spot = await evaluate(`(() => {
      const b = document.querySelector("[data-probe-target]");
      if (!b) return { via: null, why: "element re-rendered away before the click" };
      b.removeAttribute("data-probe-target");
      const r = b.getBoundingClientRect();
      if (r.width <= 0 || r.top < 0 || r.bottom > window.innerHeight) {
        b.click();
        return { via: "dom", top: Math.round(r.top), bottom: Math.round(r.bottom) };
      }
      return { via: "mouse", x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (spot?.via === "mouse") {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: spot.x, y: spot.y, buttons: 0 });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: spot.x, y: spot.y, button: "left", clickCount: 1, buttons: 1 });
      await sleep(90);
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: spot.x, y: spot.y, button: "left", clickCount: 1, buttons: 0 });
    }
    return { ...found, ...spot, ok: Boolean(spot?.via) };
  };

  /**
   * Drives one LOCAL tool end to end: open, select, process, download.
   *
   * `corrupt: true` selects a file whose MIME type says PDF and whose bytes are
   * not one. That is the safe synthetic failure — the tool's real parse path
   * rejects it, so `job_failed` is emitted by the same code a real corrupt upload
   * would take. Nothing real is ever loaded: every byte is built in-page.
   */
  const runLocalTool = async ({ slug, actionRe, files = 1, corrupt = false }) => {
    await goto(`/tools/${slug}`);
    const dropped = await evaluate(`(async () => {
      function pdf(label) {
        const body = [
          "%PDF-1.4",
          "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
          "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
          "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
          "4 0 obj<</Length 60>>stream",
          "BT /F1 18 Tf 20 100 Td (" + label + ") Tj ET",
          "endstream endobj",
          "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
          "trailer<</Root 1 0 R>>",
          "%%EOF",
        ].join("\\n");
        return new File([body], "synthetic-" + label + ".pdf", { type: "application/pdf" });
      }
      function notAPdf() {
        return new File(["this is not a pdf, not even slightly"], "synthetic-broken.pdf", { type: "application/pdf" });
      }
      const input = document.querySelector('input[type=file]');
      if (!input) return { ok: false, why: "no file input" };
      const dt = new DataTransfer();
      for (let i = 0; i < ${files}; i += 1) {
        dt.items.add(${corrupt} ? notAPdf() : pdf(String.fromCharCode(65 + i)));
      }
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, count: input.files.length };
    })()`);
    await sleep(1800);
    // The `count` read back off the input is unreliable — the change handler
    // resets it so re-picking the same file re-fires — so the selection is
    // confirmed by what the tool now shows the user, which is the thing that has
    // to be true for the action button to be enabled at all.
    const selected = /synthetic-/.test((await text()) ?? "");
    const action = await clickByLabel(actionRe, "button");
    await sleep(5000);
    const after = await text();
    // Alerts as their own field: a tool page can carry TWO of them — the preview
    // saying it couldn't RENDER a file, and the processor saying it couldn't READ
    // one. Matching page copy would let the viewer's message stand in for a run
    // that never happened, which is exactly how the failure walk passed vacuously.
    const alerts = await evaluate(
      `[...document.querySelectorAll('[role="alert"]')].map((e) => (e.textContent || "").trim().slice(0, 200))`,
    );
    let downloaded = null;
    if (!corrupt) {
      downloaded = await clickByLabel("/download/i");
      // The beacon is fire-and-forget; give it room to leave the tab.
      await sleep(4000);
    } else {
      await sleep(4000);
    }
    return { dropped, selected, action, alerts, after, downloaded };
  };

  /* ------------------------------------------------------------------ 1. guard */
  console.log("\n1. UNAUTHENTICATED");
  // Same-origin, or the request never reaches the route: a fetch issued from
  // about:blank has an opaque origin and fails before the guard runs, which
  // would leave every assertion below judging an empty string.
  await goto("/");
  const anonAnalytics = await evaluate(`(async () => {
    const r = await fetch(${JSON.stringify(BASE)} + "/api/admin/analytics");
    return { status: r.status, body: (await r.text()).slice(0, 120) };
  })()`);
  check("GET /api/admin/analytics is 401 with no admin cookie", anonAnalytics?.status === 401,
    `status ${anonAnalytics?.status}`);
  // `body.length > 0` is the anti-vacuity clause: without it this passes just as
  // happily when the fetch never happened at all.
  check("401 body carries no report data",
    (anonAnalytics?.body?.length ?? 0) > 0 &&
      !/processing|funnel|topTools/.test(anonAnalytics.body),
    anonAnalytics?.body);

  await goto("/admin/analytics");
  const gatedText = await text();
  check("visiting /admin/analytics unauthenticated lands on login, not the dashboard",
    !/Processing analytics/.test(gatedText ?? ""), (gatedText ?? "").slice(0, 90));

  /* -------------------------------------------------------- 2. admin zero state */
  console.log("\n2. ADMIN — ZERO DATA");
  if (!ADMIN_PW) {
    check("admin password supplied via --admin-pw", false, "skipped admin UI checks");
  } else {
    const login = await evaluate(`(async () => {
      const r = await fetch(${JSON.stringify(BASE)} + "/api/admin/login", {
        method: "POST", headers: {"content-type":"application/json"},
        body: JSON.stringify({ password: ${JSON.stringify(ADMIN_PW)} }),
      });
      return { status: r.status, body: (await r.text()).slice(0,120) };
    })()`);
    check("admin login succeeds", login?.status === 200, `status ${login?.status} ${login?.body ?? ""}`);

    const zeroReport = await evaluate(`(async () => {
      const r = await fetch(${JSON.stringify(BASE)} + "/api/admin/analytics");
      return { status: r.status, json: await r.json() };
    })()`);
    check("GET /api/admin/analytics is 200 with an admin cookie", zeroReport?.status === 200,
      `status ${zeroReport?.status}`);
    const z = zeroReport?.json ?? {};
    check("zero state: runs 0, successRate null, funnel present and empty",
      z.processing?.runs === 0 && z.processing?.successRate === null &&
      Array.isArray(z.funnel?.steps) && z.funnel.steps.length === 5 &&
      z.funnel.steps.every((s) => s.count === 0),
      `runs=${z.processing?.runs} rate=${JSON.stringify(z.processing?.successRate)} steps=${z.funnel?.steps?.length}`);
    check("zero state is not degraded (the query ran, it just found nothing)", z.degraded === false,
      `degraded=${z.degraded}`);
    const zeroBody = JSON.stringify(z);
    check("report body contains no subjectHash / ownerId / properties",
      !/subjectHash|ownerId|"properties"/.test(zeroBody));
    check("window is bounded server-side", !!z.window?.from && !!z.window?.to,
      `${z.window?.days} day(s), clamped=${z.window?.clamped}`);

    const clamped = await evaluate(`(async () => {
      const r = await fetch(${JSON.stringify(BASE)} + "/api/admin/analytics?from=1970-01-01T00:00:00.000Z");
      return (await r.json()).window;
    })()`);
    check("an unbounded range is clamped and reports that it was",
      clamped?.clamped === true && clamped?.days <= 92, `days=${clamped?.days} clamped=${clamped?.clamped}`);

    await goto("/admin/analytics");
    const zeroUi = await text();
    check("dashboard renders its zero state without an error", /Processing analytics/.test(zeroUi ?? ""));
    check("zero state says 'No activity in this window'", /No activity in this window/.test(zeroUi ?? ""),
      (zeroUi ?? "").slice(0, 0));
    check("no 'Analytics unavailable' error card", !/Analytics unavailable/.test(zeroUi ?? ""));
  }

  /* ---------------------------------------------------- 3. a real Merge, in-page */
  console.log("\n3. MERGE RUN — SYNTHETIC DOCUMENT");
  await goto("/tools/merge-pdf");
  const toolText = await text();
  check("merge tool page loads", /merge/i.test(toolText ?? ""));

  // Two one-page PDFs built byte by byte in the page. Nothing real is loaded.
  const dropped = await evaluate(`(async () => {
    function makeSyntheticPdf(label) {
      const body = [
        "%PDF-1.4",
        "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
        "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
        "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
        "4 0 obj<</Length 60>>stream",
        "BT /F1 18 Tf 20 100 Td (" + label + ") Tj ET",
        "endstream endobj",
        "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
        "trailer<</Root 1 0 R>>",
        "%%EOF",
      ].join("\\n");
      return new File([body], "synthetic-" + label + ".pdf", { type: "application/pdf" });
    }
    const input = document.querySelector('input[type=file]');
    if (!input) return { ok: false, why: "no file input" };
    const dt = new DataTransfer();
    dt.items.add(makeSyntheticPdf("A"));
    dt.items.add(makeSyntheticPdf("B"));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, count: input.files.length };
  })()`);
  check("file input accepted the synthetic assignment", dropped?.ok === true,
    JSON.stringify(dropped));
  await sleep(1800);
  // The count read back is unreliable — the change handler may reset the input so
  // re-picking the same file re-fires — so the selection is confirmed by what the
  // tool now shows the user, which is the thing that has to be true.
  const selectionVisible = await text();
  check("both synthetic documents are listed in the tool UI",
    /synthetic-A/.test(selectionVisible ?? "") && /synthetic-B/.test(selectionVisible ?? ""),
    (selectionVisible ?? "").slice(0, 120));

  // Click whatever the tool's primary action is, by its visible label.
  const clicked = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')];
    const b = buttons.find((el) => /merge/i.test(el.textContent || "") && !el.disabled);
    if (!b) return { ok: false, labels: buttons.filter(e=>!e.disabled).map(e=>(e.textContent||"").trim().slice(0,30)) };
    const r = b.getBoundingClientRect();
    return { ok: true, label: (b.textContent||"").trim().slice(0,40), x: r.x + r.width/2, y: r.y + r.height/2 };
  })()`);
  if (clicked?.ok) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: clicked.x, y: clicked.y, buttons: 0 });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: clicked.x, y: clicked.y, button: "left", clickCount: 1, buttons: 1 });
    await sleep(90);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: clicked.x, y: clicked.y, button: "left", clickCount: 1, buttons: 0 });
  }
  check("primary merge action clicked with a real mouse event", clicked?.ok === true,
    clicked?.ok ? clicked.label : JSON.stringify(clicked?.labels ?? []));
  await sleep(5000);

  const merged = await text();
  check("merge produced a result the user can act on",
    /download/i.test(merged ?? "") && !/something went wrong|failed/i.test(merged ?? ""),
    (merged ?? "").slice(0, 140));

  // Click the download too: without it the last funnel step stays a structural
  // zero, and "download never fires" would be indistinguishable from "nobody
  // downloaded".
  const dl = await evaluate(`(() => {
    const els = [...document.querySelectorAll('button, a')];
    const b = els.find((el) => /download/i.test(el.textContent || "") && !el.disabled);
    if (!b) return { ok: false };
    const r = b.getBoundingClientRect();
    return { ok: true, label: (b.textContent||"").trim().slice(0,40), x: r.x + r.width/2, y: r.y + r.height/2 };
  })()`);
  if (dl?.ok) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: dl.x, y: dl.y, buttons: 0 });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: dl.x, y: dl.y, button: "left", clickCount: 1, buttons: 1 });
    await sleep(90);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: dl.x, y: dl.y, button: "left", clickCount: 1, buttons: 0 });
  }
  check("download action clicked", dl?.ok === true, dl?.label ?? "no download control found");
  // The analytics hook batches; give the beacon time to flush.
  await sleep(7000);

  /* -------------------------------------------- 4. the dashboard sees the change */
  console.log("\n4. ADMIN — AFTER THE RUN");
  const after = await evaluate(`(async () => {
    const r = await fetch(${JSON.stringify(BASE)} + "/api/admin/analytics");
    return r.status === 200 ? await r.json() : { status: r.status };
  })()`);
  const funnelCounts = (after?.funnel?.steps ?? []).map((s) => s.count);
  const anyEvent = funnelCounts.some((c) => c > 0) || (after?.execution ?? []).length > 0;
  check("the run produced analytics activity the dashboard can see", anyEvent,
    `funnel=${JSON.stringify(funnelCounts)} execution=${JSON.stringify(after?.execution)}`);
  check("every local funnel step fired, including download",
    funnelCounts.length === 5 && funnelCounts.every((c) => c > 0),
    JSON.stringify(funnelCounts));
  check("funnel steps are in the canonical local order",
    JSON.stringify((after?.funnel?.steps ?? []).map((s) => s.step)) ===
      JSON.stringify(["tool_view","file_selected","tool_start","job_succeeded","download"]),
    JSON.stringify((after?.funnel?.steps ?? []).map((s) => s.step)));
  check("no funnel step exceeds the one before it", (after?.funnel?.steps ?? []).every(
    (s, i, a) => i === 0 || s.count <= a[i-1].count));
  check("every conversion ratio is within 0–1", (after?.funnel?.steps ?? []).every(
    (s) => s.conversionFromStart >= 0 && s.conversionFromStart <= 1 &&
           s.conversionFromPrevious >= 0 && s.conversionFromPrevious <= 1));
  check("populated report still carries no identity", !/subjectHash|ownerId|"properties"/.test(JSON.stringify(after ?? {})));
  // The brief's rule: local analytics is observational, never authoritative quota
  // usage. So a run that the ledger records as `local` must leave the SERVER
  // allowance untouched. Both halves are asserted — a build where the merge
  // silently metered itself fails here, and so does one where no local event was
  // recorded at all (which would otherwise satisfy "used is still 0" for free).
  const usageAfterLocal = await evaluate(`(async () => {
    const r = await fetch(${JSON.stringify(BASE)} + "/api/usage");
    return await r.json();
  })()`);
  const opsAfter = (usageAfterLocal?.meters ?? []).find((m) => m.meter === "server_operations");
  check("the local run WAS recorded as local activity",
    (after?.execution ?? []).some((e) => e.label === "local" && e.count > 0),
    `execution=${JSON.stringify(after?.execution)}`);
  check("...and it consumed no server allowance (local is observational only)",
    opsAfter?.used === 0, `server_operations.used=${opsAfter?.used}`);

  if (ADMIN_PW) {
    await goto("/admin/analytics");
    const populated = await text();
    check("dashboard renders the populated state", /Processing analytics/.test(populated ?? ""));
    // The honest copy CONTAINS "not distinct visitors" — it disclaims the unit
    // rather than avoiding the word, so assert the disclaimer, not its absence.
    check("dashboard labels the funnel unit honestly (events, not visitors)",
      /event occurrences/.test(populated ?? "") && /not distinct visitors/.test(populated ?? ""),
      /event occurrences/.test(populated ?? "") ? "" : "unit not stated on the funnel card");
    check("dashboard shows no raw hash-looking identifier",
      !/[0-9a-f]{32,}/.test(populated ?? ""));
  }

  /* ------------------------- 4b. two MORE local tools, and a local FAILURE */
  console.log("\n4b. LOCAL COVERAGE — BEYOND MERGE");
  // Merge was the tool that was instrumented by hand. If coverage really moved to
  // the shared seams, tools that were never touched individually must produce the
  // same funnel — and only a browser can show that.
  const meta = await runLocalTool({ slug: "remove-pdf-metadata", actionRe: "/remove metadata/i" });
  check("remove-pdf-metadata accepted a synthetic document",
    meta.dropped?.ok === true && meta.selected === true, JSON.stringify(meta.dropped));
  check("remove-pdf-metadata's action button was actually clicked", meta.action?.ok === true,
    JSON.stringify(meta.action));
  check("remove-pdf-metadata ran and offered a download",
    /download/i.test(meta.after ?? "") && !/something went wrong/i.test(meta.after ?? ""),
    (meta.after ?? "").slice(0, 140));
  check("remove-pdf-metadata download clicked", meta.downloaded?.ok === true,
    meta.downloaded?.label ?? JSON.stringify(meta.downloaded?.labels ?? []));

  const nums = await runLocalTool({ slug: "add-page-numbers", actionRe: "/add page numbers/i" });
  check("add-page-numbers accepted a synthetic document",
    nums.dropped?.ok === true && nums.selected === true, JSON.stringify(nums.dropped));
  check("add-page-numbers's action button was actually clicked", nums.action?.ok === true,
    JSON.stringify(nums.action));
  check("add-page-numbers ran and offered a download",
    /download/i.test(nums.after ?? "") && !/something went wrong/i.test(nums.after ?? ""),
    (nums.after ?? "").slice(0, 140));
  check("add-page-numbers download clicked", nums.downloaded?.ok === true,
    nums.downloaded?.label ?? JSON.stringify(nums.downloaded?.labels ?? []));

  // The failure half. A file whose type says PDF and whose bytes are not one goes
  // down the same parse path a real corrupt upload takes.
  const broken = await runLocalTool({
    slug: "remove-pdf-metadata", actionRe: "/remove metadata/i", corrupt: true,
  });
  check("the corrupt run was started, so the failure below is a run's failure",
    broken.action?.ok === true, JSON.stringify(broken.action));
  const runAlert = (broken.alerts ?? []).find((a) => /couldn't read|could not read/i.test(a));
  // "read", not "render": the preview's own alert says it could not RENDER the
  // file and is present whether or not anything ran. Only the processor reports
  // that it could not READ one.
  check("a corrupt document produces a visible failure from the RUN, not a silent no-op",
    Boolean(runAlert), JSON.stringify(broken.alerts ?? []));
  check("the failure message names no internals — no stack, no path, no library",
    !/at Object\.|node_modules|\/var\/|pdf-lib|TypeError|undefined is not/.test(
      `${runAlert ?? ""} ${broken.after ?? ""}`,
    ),
    (broken.after ?? "").match(/at Object\.|node_modules|pdf-lib|TypeError/)?.[0] ?? "");
  check("the failure does not offer a download of nothing",
    !/download/i.test(broken.after ?? ""), (broken.after ?? "").slice(0, 120));

  /* --------------------------- 4c. the dashboard sees three tools and a category */
  console.log("\n4c. ADMIN — LOCAL COVERAGE");
  const local = await evaluate(`(async () => {
    const r = await fetch(${JSON.stringify(BASE)} + "/api/admin/analytics");
    return r.status === 200 ? await r.json() : { status: r.status };
  })()`);
  const localFunnels = (local?.funnels ?? []).filter((f) => f.executionMode === "local");
  check("the dashboard compares at least three LOCAL tools, not just Merge",
    localFunnels.length >= 3, `local funnels: ${localFunnels.map((f) => f.toolSlug).join(", ")}`);
  check("each of those tools reached a download, so every step is real",
    localFunnels.filter((f) => (f.steps ?? []).every((st) => st.count > 0)).length >= 3,
    JSON.stringify(localFunnels.map((f) => [f.toolSlug, (f.steps ?? []).map((st) => st.count)])));
  const localCategory = (local?.errorCategories ?? []).some(
    (c) => /corrupt_document|invalid_input|internal_error|processor_failed/.test(c.label) && c.count > 0,
  );
  check("the in-browser failure was filed under a normalized category",
    localCategory, JSON.stringify(local?.errorCategories ?? []));
  check("no raw error text or filename reached the report",
    !/synthetic-broken|not a pdf|couldn't read|node_modules|Traceback/i.test(JSON.stringify(local ?? {})));
  check("the report still carries no identity after the failure walk",
    !/subjectHash|ownerId|"properties"/.test(JSON.stringify(local ?? {})));

  /* ------------------------------------------------------- 5. the user's own card */
  console.log("\n5. USER USAGE VIEW");
  // Signup runs IN the page: the auth routes require a same-origin request, and
  // going through the browser is what the card needs anyway — a session cookie in
  // curl proves nothing about what React renders.
  const email = `slice4-smoke-${(after?.window?.to ?? "x").replace(/[^0-9]/g, "").slice(-10)}@example.test`;
  const signup = await evaluate(`(async () => {
    const r = await fetch("/api/auth/signup", {
      method: "POST", headers: {"content-type":"application/json"},
      body: JSON.stringify({
        name: "Slice4 Smoke", email: ${JSON.stringify("EMAIL")}.replace("EMAIL", ${JSON.stringify(email)}),
        password: "Slice4-Smoke-Pw-2026", confirmPassword: "Slice4-Smoke-Pw-2026",
      }),
    });
    return { status: r.status, body: (await r.text()).slice(0, 200) };
  })()`);
  check("a synthetic account signs in through the real form path",
    signup?.status === 201 || signup?.status === 200 || signup?.status === 409,
    `status ${signup?.status} ${signup?.body ?? ""}`);

  const apiUsage = await evaluate(`(async () => {
    const r = await fetch("/api/usage");
    return { status: r.status, json: await r.json(), cc: r.headers.get("cache-control") };
  })()`);
  check("GET /api/usage answers for the signed-in visitor", apiUsage?.status === 200,
    `plan=${apiUsage?.json?.plan}`);
  check("the session is recognised (plan is no longer guest)", apiUsage?.json?.plan !== "guest",
    `plan=${apiUsage?.json?.plan}`);
  check("/api/usage is private, no-store", apiUsage?.cc === "private, no-store", String(apiUsage?.cc));
  check("/api/usage exposes no owner id or counter key",
    !/ownerId|subjectHash|periodStart/.test(JSON.stringify(apiUsage?.json ?? {})));

  // The card lives on a workspace dashboard, so a workspace has to exist.
  const ws = await evaluate(`(async () => {
    const list = await (await fetch("/api/workspaces")).json();
    let items = list?.workspaces ?? list?.items ?? list?.data ?? [];
    if (!Array.isArray(items) || items.length === 0) {
      const orgs = await (await fetch("/api/organizations")).json().catch(() => null);
      const orgId = (orgs?.organizations ?? orgs?.items ?? [])[0]?.id ?? null;
      if (orgId) {
        await fetch("/api/workspaces/provision-default", {
          method: "POST", headers: {"content-type":"application/json"},
          body: JSON.stringify({ organizationId: orgId }),
        });
      }
      const again = await (await fetch("/api/workspaces")).json();
      items = again?.workspaces ?? again?.items ?? again?.data ?? [];
    }
    return { count: items.length, id: items[0]?.id ?? null };
  })()`);
  check("the signed-in account has a workspace to render the card in", !!ws?.id,
    JSON.stringify(ws));

  const ops = (apiUsage?.json?.meters ?? []).find((m) => m.meter === "server_operations");
  if (ws?.id) {
    await goto(`/workspaces/${ws.id}`);
    await sleep(2200);
    // Read only the CARD's own subtree. Matching "Free" or "0 of 100" against the
    // whole page would also be satisfied by a "Get Started Free" nav button or any
    // unrelated figure, so the check would pass on a card that rendered nothing.
    const cardText = await evaluate(`(() => {
      const sections = [...document.querySelectorAll('section')];
      const card = sections.find((el) => /^\\s*Usage\\b/.test(el.innerText || ""));
      return card ? card.innerText.replace(/\\s+/g, ' ') : null;
    })()`);
    check("the usage card is present as its own section on the dashboard",
      typeof cardText === "string" && cardText.length > 0,
      cardText === null ? "no section whose heading is 'Usage'" : "");
    check("the usage card is in its ready state, not its error state",
      !/Usage is unavailable|No allowance to show/.test(cardText ?? ""),
      (cardText ?? "").slice(0, 160));
    // The numbers the card SHOWS must be the numbers the endpoint REPORTS.
    check("card shows the plan from /api/usage",
      cardText?.includes(apiUsage?.json?.planLabel ?? "\u0000"),
      `planLabel=${apiUsage?.json?.planLabel}`);
    check("card shows the heavy-operations figure from /api/usage",
      !!ops && new RegExp(`${ops.used}\\s*(of|/)\\s*${ops.limit}`).test(cardText ?? ""),
      `expected "${ops?.used} of ${ops?.limit}"`);
    check("card states the limit mode rather than implying enforcement",
      /Monitoring/.test(cardText ?? "") === (apiUsage?.json?.mode !== "enforce"),
      `mode=${apiUsage?.json?.mode}`);
    check("card shows no owner id, counter key, or hash",
      !/[0-9a-f]{32,}/.test(cardText ?? "") &&
        !/server_operations|server_input_bytes|ownerId|periodStart/.test(cardText ?? ""),
      (cardText ?? "").match(/[0-9a-f]{32,}|server_operations|ownerId/)?.[0] ?? "");
    // Fail-soft: the tools must keep working even when the usage read is broken.
    const toolStillWorks = await evaluate(`(async () => {
      const r = await fetch("/tools/merge-pdf");
      return r.status;
    })()`);
    check("a tool page still loads regardless of the usage surface", toolStillWorks === 200,
      `status ${toolStillWorks}`);
  }

  /* ------------------- 6. REMOTE: authoritative usage moves, and moves ONCE */
  console.log("\n6. REMOTE — AUTHORITATIVE METERING");
  // Everything above is observational. This is the half that can charge someone,
  // so the assertion is not "a number went up" but "it went up by exactly one per
  // customer operation" — a property of the deployed route, the deployed worker
  // and the deployed database together, which no unit test can reach.
  const meterOf = (body, key) =>
    (body?.meters ?? []).find((m) => m.meter === key)?.used ?? null;
  const readUsage = () => evaluate(`(async () => {
    const r = await fetch("/api/usage", { cache: "no-store" });
    return r.status === 200 ? await r.json() : { status: r.status };
  })()`);

  const base = await readUsage();
  const opsBase = meterOf(base, "server_operations");
  check("a signed-in visitor's operation count is readable before any remote run",
    typeof opsBase === "number", JSON.stringify(base?.meters ?? base));
  // The customer-facing snapshot publishes what the customer OWES. Attempt
  // compute is deliberately not in it: a retry doubles the compute recorded and
  // must not be visible to the user as more quota consumed. That separation is
  // asserted on the admin side, where the attempt ledger actually lives.
  check("the usage snapshot publishes operations, not per-attempt compute",
    (base?.meters ?? []).some((m) => m.meter === "server_operations") &&
      !(base?.meters ?? []).some((m) => m.meter === "compute_units"),
    (base?.meters ?? []).map((m) => m.meter).join(", "));

  /** A one-page PDF Ghostscript will accept, built in the page. */
  const REMOTE_PDF = `(() => {
    const body = "%PDF-1.4\\n"
      + "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\\n"
      + "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\\n"
      + "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R"
      + "/Resources<</Font<</F1 5 0 R>>>>>>endobj\\n"
      + "4 0 obj<</Length 44>>stream\\nBT /F1 18 Tf 20 100 Td (remote) Tj ET\\nendstream endobj\\n"
      + "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\\n"
      + "trailer<</Root 1 0 R>>\\n%%EOF\\n";
    return new File([body], "synthetic-remote.pdf", { type: "application/pdf" });
  })()`;

  // ---- 6a. the compress-pdf pipeline, submitted ASYNC so the reservation is
  // observable while the work is still queued. A read taken only after the job
  // finished could not tell a route that reserved-then-kept from one that never
  // reserved and charged at the end — and only the first is idempotent under retry.
  const submitted = await evaluate(`(async () => {
    const fd = new FormData();
    fd.append("file", ${REMOTE_PDF});
    const r = await fetch("/api/jobs?slug=compress-pdf", { method: "POST", body: fd });
    let json = null;
    try { json = await r.json(); } catch { json = null; }
    return { status: r.status, jobId: json?.jobId ?? null,
             body: JSON.stringify(json ?? {}).slice(0, 200) };
  })()`);
  check("the compress-pdf pipeline accepted a submission from the browser",
    submitted?.status === 202 || submitted?.status === 200,
    `status ${submitted?.status} ${submitted?.body ?? ""}`);
  check("submission returned a job id to poll", !!submitted?.jobId, submitted?.body ?? "");

  const admitted = await readUsage();
  check("admission counted exactly one customer operation",
    meterOf(admitted, "server_operations") === opsBase + 1,
    `before=${opsBase} after-admission=${meterOf(admitted, "server_operations")}`);
  check("admission counted the input bytes it actually validated",
    (meterOf(admitted, "server_input_bytes") ?? 0) > (meterOf(base, "server_input_bytes") ?? 0),
    `before=${meterOf(base, "server_input_bytes")} after=${meterOf(admitted, "server_input_bytes")}`);

  let job = null;
  for (let i = 0; i < 40 && submitted?.jobId; i += 1) {
    await sleep(1500);
    job = await evaluate(`(async () => {
      const r = await fetch("/api/jobs/${submitted.jobId}", { cache: "no-store" });
      return r.status === 200 ? await r.json() : { status: r.status };
    })()`);
    if (/completed|failed|cancelled/i.test(String(job?.status ?? ""))) break;
  }
  const jobStatus = String(job?.status ?? "unknown");
  check("the job reached a terminal state rather than hanging", /completed|failed|cancelled/i.test(jobStatus),
    `${jobStatus} stage=${job?.stage}`);
  check("the job's owner can read it, and its error field carries no internals",
    !/at Object\.|node_modules|\/var\/|Traceback/.test(String(job?.error ?? "")),
    String(job?.error ?? ""));

  // Settlement. A success KEEPS the one operation; a terminal failure REFUNDS it.
  // Both are correct, so the assertion is that the counter AGREES with the outcome
  // — which is checkable on any host, rather than only on one with every binary.
  const settled = await readUsage();
  const opsSettled = meterOf(settled, "server_operations");
  check("settlement agrees with the outcome: a success keeps the one charge, a failure refunds it",
    /completed/i.test(jobStatus) ? opsSettled === opsBase + 1 : opsSettled === opsBase,
    `status=${jobStatus} before=${opsBase} after=${opsSettled}`);
  // The other half of the two-ledger invariant — that compute is recorded per
  // attempt and is not the operation count — is asserted in section 7 against the
  // admin tool table, which is where the attempt ledger is published.

  // ---- 6b. a LEGACY server tool, on the path the pilot did not migrate.
  // `repair-pdf` goes through the synchronous route and the legacy processor, so
  // this is the seam-sharing claim under test: one metering call, two pipelines.
  const legacyBase = opsSettled;
  const legacy = await evaluate(`(async () => {
    const fd = new FormData();
    fd.append("file", ${REMOTE_PDF});
    const r = await fetch("/api/tools/repair-pdf", { method: "POST", body: fd });
    const type = r.headers.get("content-type") ?? "";
    // Success streams the repaired PDF back; a failure answers JSON.
    const body = type.includes("application/json") ? (await r.text()).slice(0, 200) : "";
    return { status: r.status, type, body, bytes: Number(r.headers.get("content-length") ?? 0) };
  })()`);
  // 503 is a first-class outcome, not a broken probe: on a host without the
  // processing binaries the route refuses up front, which is the correct answer
  // and still has to leave the ledger untouched (asserted below).
  check("a legacy server tool ran through its own synchronous route",
    [200, 422, 500, 503].includes(legacy?.status),
    `status ${legacy?.status} ${legacy?.body ?? ""}`);
  check("a legacy failure response leaks no internals",
    !/at Object\.|node_modules|\/var\/|gs:|qpdf|Traceback/.test(legacy?.body ?? ""),
    (legacy?.body ?? "").slice(0, 140));

  const afterLegacy = await readUsage();
  const opsLegacy = meterOf(afterLegacy, "server_operations");
  check("the legacy tool was metered on the same shared seam, exactly once",
    legacy?.status === 200 ? opsLegacy === legacyBase + 1 : opsLegacy === legacyBase,
    `status=${legacy?.status} before=${legacyBase} after=${opsLegacy}`);
  check("no remote run charged more than one operation for one submission",
    opsLegacy - opsBase <= 2, `total moved ${opsLegacy - opsBase} across two submissions`);
  check("the usage response still names no owner and no counter key",
    !/ownerId|subjectHash|periodStart/.test(JSON.stringify(afterLegacy ?? {})));

  /* ------------------------------ 6c. RETRY — one operation, many attempts */
  if (RETRY_WALK) {
    console.log("\n6c. RETRY — ATTEMPTS ARE NOT CHARGES");
    const retryBase = meterOf(await readUsage(), "server_operations");
    const retried = await evaluate(`(async () => {
      const fd = new FormData();
      fd.append("file", ${REMOTE_PDF});
      const r = await fetch("/api/jobs?slug=compress-pdf", { method: "POST", body: fd });
      let json = null; try { json = await r.json(); } catch { json = null; }
      return { status: r.status, jobId: json?.jobId ?? null };
    })()`);
    check("a submission was admitted on the pipeline under test", Boolean(retried?.jobId),
      `status ${retried?.status}`);

    // The peak matters as much as the end state: a build that charged per attempt
    // and refunded once would settle back to a plausible-looking number, so the
    // mid-flight reading is what separates "one charge, retried" from "three
    // charges, one refund".
    let attemptsSeen = 0;
    let opsPeak = retryBase;
    let last = null;
    for (let i = 0; i < 60 && retried?.jobId; i += 1) {
      await sleep(1000);
      last = await evaluate(`(async () => {
        const r = await fetch("/api/jobs/${retried.jobId}", { cache: "no-store" });
        return r.status === 200 ? await r.json() : { status: r.status };
      })()`);
      attemptsSeen = Math.max(attemptsSeen, Number(last?.attempt ?? 0));
      opsPeak = Math.max(opsPeak, meterOf(await readUsage(), "server_operations") ?? retryBase);
      if (/completed|failed|cancelled/i.test(String(last?.status ?? ""))) break;
    }

    check("the failure was retried, so there is more than one attempt to reason about",
      attemptsSeen > 1, `attempts=${attemptsSeen} status=${last?.status} category=${last?.errorCategory}`);
    check("the retried failure is classified as one worth retrying",
      last?.errorCategory === "dependency_unavailable" || last?.retryable === false,
      `category=${last?.errorCategory}`);
    check("the customer was charged for the operation, never for each attempt",
      opsPeak <= retryBase + 1, `base=${retryBase} peak=${opsPeak} attempts=${attemptsSeen}`);
    const opsEnd = meterOf(await readUsage(), "server_operations");
    check("the terminal failure gave the single charge back, exactly once",
      opsEnd === retryBase, `base=${retryBase} end=${opsEnd}`);
    check("the user is told what happened without being shown the internals",
      !/gs\b|ghostscript|which|ENOENT|node_modules|apt-get/i.test(String(last?.error ?? "")),
      String(last?.error ?? "").slice(0, 120));

    if (ADMIN_PW) {
      const ledger = await evaluate(`(async () => {
        const r = await fetch(${JSON.stringify(BASE)} + "/api/admin/analytics");
        return r.status === 200 ? await r.json() : { status: r.status };
      })()`);
      const compress = (ledger?.topTools ?? []).find((t) => t.toolSlug === "compress-pdf");
      // The other half of the invariant: the attempt ledger MAY count every
      // attempt, and should — that is how the retry is visible to us at all.
      check("the attempt ledger records the retries the customer was not charged for",
        (compress?.total ?? 0) >= attemptsSeen, JSON.stringify(compress ?? {}));
      check("the failure category reached the dashboard's own breakdown",
        (ledger?.errorCategories ?? []).some((c) => c.label === "dependency_unavailable" && c.count > 0),
        JSON.stringify(ledger?.errorCategories ?? []));
    }
  }

  /* ---------------------------------- 7. admin shows local AND remote activity */
  console.log("\n7. ADMIN — BOTH EXECUTION MODES");
  const both = await evaluate(`(async () => {
    const r = await fetch(${JSON.stringify(BASE)} + "/api/admin/analytics");
    return r.status === 200 ? await r.json() : { status: r.status };
  })()`);
  const modes = Object.fromEntries((both?.execution ?? []).map((e) => [e.label, e.count]));
  check("the dashboard shows local activity", (modes.local ?? 0) > 0, JSON.stringify(modes));
  check("the dashboard shows remote activity", (modes.remote_job ?? 0) > 0, JSON.stringify(modes));
  // Not the funnels: those are built from client funnel events, and these two
  // remote runs were submitted through the API rather than by driving the tool
  // page, so a remote funnel row would be absent for an honest reason. The tool
  // table is the remote-side surface — it is built from server ATTEMPTS.
  check("the tool table names the remote tools that just ran",
    (both?.topTools ?? []).some((t) => t.toolSlug === "compress-pdf" || t.toolSlug === "repair-pdf"),
    (both?.topTools ?? []).map((t) => `${t.toolSlug}:${t.total}`).join(", "));
  // Compute is a SECOND ledger, not a rename of the first: a row whose cost is
  // its own number proves the two are recorded separately, where a build that
  // charged per attempt would report cost and operations as the same figure.
  check("a remote row carries a compute cost that is not its operation count",
    (both?.topTools ?? []).some(
      (t) =>
        (t.toolSlug === "compress-pdf" || t.toolSlug === "repair-pdf") &&
        t.costUnits > 0 &&
        t.costUnits !== t.total,
    ), (both?.topTools ?? []).map((t) => `${t.toolSlug}:cost=${t.costUnits}/ops=${t.total}`).join(", "));
  check("the calibration verdict refuses to claim readiness on this much data",
    both?.calibration?.readiness?.ready_for_enforcement === false,
    JSON.stringify(both?.calibration?.readiness ?? {}));
  check("calibration recommends no ceiling it cannot support",
    (both?.calibration?.recommendations ?? []).every(
      (r) => r.status !== "available" || typeof r.suggestedPerDay === "number",
    ), JSON.stringify(both?.calibration?.recommendations ?? []));
  check("observe mode is reported, not implied",
    both?.calibration?.observation?.limitMode === "observe",
    String(both?.calibration?.observation?.limitMode));
  check("the composed admin payload still exposes no identity",
    !/subjectHash|ownerId|"properties"|storageKey/.test(JSON.stringify(both ?? {})));

  /* ------------------------------------------------------------------- verdict */
  const realErrors = consoleErrors.filter(
    (e) => !/favicon|404|Failed to load resource/i.test(e),
  );
  check("no uncaught console error during the walk", realErrors.length === 0,
    realErrors.slice(0, 3).join(" | "));

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
  }
  sock.close();
  chrome.kill();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(2);
});
