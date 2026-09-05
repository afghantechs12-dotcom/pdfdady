/* global process, console, fetch, WebSocket, setTimeout, clearTimeout, Buffer */
/**
 * PERMANENT regression probe: the unified processing pipeline in a REAL browser.
 *
 * WHY THIS EXISTS — and it is not a hypothetical. The pipeline has ~170 Node
 * tests behind it, including a 23-case integration suite that wires the real
 * service, the real queue, the real handler and a real Ghostscript together. Not
 * one of them renders a page. The first run of this probe found two live bugs
 * that the whole green suite was structurally unable to see:
 *
 *  1. `/tools/compress-pdf` was PRERENDERED at build time, so the runner choice
 *     was frozen with the flag as it stood on the build machine, while
 *     `/api/jobs` re-read the flag per request. Turning the pilot on therefore
 *     produced: stale legacy runner submits → route creates a pipeline job →
 *     the legacy SSE client reads the pipeline's terminal frame (a `stage`, no
 *     `result`) as a failure. The user was told "Processing failed. Please try
 *     again." about a job that had completed, with its output sitting in storage.
 *  2. The `finalizing` stage write raced `completeJob`'s `done` write, leaving a
 *     `completed` row whose stage read `finalizing` — a finished job describing
 *     itself as still working.
 *
 * Both are exactly the failures a user would call "it doesn't work", and neither
 * moves a single Node assertion.
 *
 * It also checks the claim the suite structurally cannot make about the LOCAL
 * tools. `localToolRegression.test.ts` proves merge/split/rotate/organize never
 * import the pipeline and never touch the network under Node — a static and a
 * simulated argument. This watches the browser's own network stack while a real
 * merge runs, which is the only place the privacy promise printed on the page is
 * actually kept or broken.
 *
 * WHAT IT PINS, as the mutations it was run against:
 *
 *  - Page prerendered again (drop `connection()`): section 2 fails — the submit
 *    carries no `Idempotency-Key`, because the legacy runner is mounted.
 *  - `PROCESSING_PIPELINE=off`: the same check fails, which is what makes this a
 *    test of the *pilot* rather than of compression in general.
 *  - Stage race reintroduced: section 3's terminal-stage check fails.
 *  - Worker never registered: section 4 fails on the deadline, with the job
 *    visibly parked in a non-terminal stage rather than a silent pass.
 *
 * THE HAZARD IT IS BUILT AGAINST is a vacuous pass, so every claim is paired
 * with a precondition that must be observed to CHANGE: the request log is
 * emptied before each click, the panel must not already read "Your file is
 * ready", the local run must be observed to produce a real result, and the byte
 * count the UI advertises must equal the byte count actually delivered. Text
 * assertions are scoped to BUTTONS, never to page prose — the first version of
 * this probe "passed" a Download check against the privacy note's phrase "made
 * available to download".
 *
 * RUN IT in production mode — that is what a user runs. Three constraints make
 * the recipe what it is, and the older `npx next start -p 3001` with a loopback
 * site URL satisfies none of them:
 *
 *   - `next.config.ts` sets `output: "standalone"`. The artifact is the runtime
 *     production uses, and it resolves route-handler request URLs differently from
 *     `next start`, so it is the only runtime worth probing.
 *   - The production startup gate REFUSES to boot with a loopback
 *     `NEXT_PUBLIC_SITE_URL`, because signed download URLs are built from it. The
 *     configured origin has to be a non-loopback address.
 *   - Session and anonymous-owner cookies are `Secure` in production. On a plain
 *     `http://` origin Chrome drops them, `resolveJobActor()` then resolves a
 *     different actor, and section 5 fails with a 404 that reads exactly like a
 *     product defect. So the browser needs real HTTPS.
 *
 *   node scripts/next-build.js
 *   AUDIT_SITE_URL=https://<lan-ip>:3001 AUDIT_DATABASE_URL="file:$TMPDIR/pilot.db" \
 *     AUDIT_STORAGE_ROOT="$TMPDIR/pilot-storage" PROCESSING_PIPELINE=on \
 *     scripts/restart-origin.sh &
 *   #   The launcher copies `.next/static` first and starts the GUARDED entry from
 *   #   the repository root. A hand-written `cd .next/standalone && node server.js`
 *   #   stood here: that entry exits 1 in production (no guard, no lease), and the
 *   #   environment beside it went stale every time the production gate gained a
 *   #   requirement — twice so far. `deploymentArtifact.test.ts` hands the launcher
 *   #   to the gate itself, so it cannot go stale silently again.
 *   node scripts/tls-front.mjs --listen 3001 --target 3002   # prints the origin
 *   node scripts/processing-pilot-probe.mjs --url https://<lan-ip>:3001
 *
 * A THROWAWAY database (`npx prisma migrate deploy` against it first), not the
 * developer one. This probe runs real tool operations, and those land in the usage
 * ledger; pointed at `prisma/prisma/dev.db` it would count probe traffic as
 * production observation and corrupt the enforcement-readiness calibration.
 *
 * `--url` MUST equal `NEXT_PUBLIC_SITE_URL` exactly, because
 * `/api/jobs/{id}/result` redirects to a signed storage URL built from it. Point
 * one at a different origin and the browser is sent somewhere dead — section 5
 * then fails on an environment mismatch that has nothing to do with the pipeline.
 *
 * `CHROME_PATH` overrides the browser binary. No certificate wrapper is needed:
 * for an `https://` target the probe passes `--ignore-certificate-errors` itself.
 */
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Imported rather than taken as a global: `URL` is ambient in Node, but the shared
// lint config does not declare it for scripts, and a probe that fails lint is a
// gate failure like any other.
import { URL } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg("--url", "http://localhost:3001");
const CHROME =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// The terminator in front of an https target is self-signed, so Node's own fetch
// rejects it — and the first symptom is section 0 reporting "app is serving: FAIL"
// against a server that is serving perfectly, which reads like a product defect.
// Set here rather than left to the recipe, because a recipe step that only matters
// on one transport is a step people omit. Scoped to https, and this process only.
if (BASE.startsWith("https:")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function check(label, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const section = (n, title) => console.log(`\n── ${n}. ${title}`);

/**
 * A fixture with enough real content that compression has something to remove.
 * Generated rather than committed, so the probe cannot quietly start passing
 * against an empty or truncated file someone checked in.
 */
async function makeFixture(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([612, 792]);
    for (let row = 0; row < 40; row++) {
      page.drawText(`Page ${i + 1} line ${row + 1} — quarterly financial summary text`, {
        x: 40, y: 740 - row * 18, size: 11, font, color: rgb(0.1, 0.1, 0.25),
      });
    }
    for (let b = 0; b < 60; b++) {
      page.drawRectangle({
        x: 40 + (b % 12) * 45, y: 40 + Math.floor(b / 12) * 12,
        width: 40, height: 8, color: rgb((b % 7) / 7, (b % 5) / 5, (b % 3) / 3),
      });
    }
  }
  return Buffer.from(await doc.save());
}

/**
 * The app's byte formatting, reimplemented.
 *
 * Deliberate duplication: this probe checks the built application from outside,
 * and a shared helper would let a formatting bug agree with itself in both
 * places. If this drifts from `lib/utils/formatBytes.ts`, the probe fails — which
 * is the correct outcome, because the string a user reads has changed.
 */
function formatBytes(bytes, decimals = 1) {
  if (bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

/** Panel buttons only ever rendered by a terminal job state. */
const TERMINAL_BUTTONS = ["download", "start over", "try again"];

async function main() {
  section(0, "Environment");
  let gsVersion = null;
  try {
    gsVersion = execFileSync("gs", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    /* absent */
  }
  check("Ghostscript is installed", gsVersion !== null, gsVersion ?? "not on PATH");
  let appUp = false;
  try {
    appUp = (await fetch(`${BASE}/tools/compress-pdf`)).ok;
  } catch {
    /* down */
  }
  check(`app is serving at ${BASE}`, appUp);
  if (!appUp || !gsVersion) {
    console.log("\nEnvironment not ready — refusing to report a pass.");
    process.exit(1);
  }

  const dir = mkdtempSync(join(tmpdir(), "pdfdadi-pilot-probe-"));
  // A filename with a space and mixed case, so the sanitizing of the download
  // name is exercised by the same run rather than assumed.
  const inputPath = join(dir, "Quarterly Report.pdf");
  const input = await makeFixture(6);
  writeFileSync(inputPath, input);
  const localA = join(dir, "local-a.pdf");
  const localB = join(dir, "local-b.pdf");
  writeFileSync(localA, await makeFixture(2));
  writeFileSync(localB, await makeFixture(3));

  // ---- browser -----------------------------------------------------------
  const userDataDir = mkdtempSync(join(tmpdir(), "pdfdadi-pilot-chrome-"));
  const port = 9497;
  // A previous run that died before kill() leaves a browser holding this port,
  // and the next launch silently ATTACHES to it — stale targets, hanging CDP
  // calls. Reclaim it first; the pattern is specific enough not to match a
  // browser the developer is using.
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
      // The terminator's certificate is generated per run and trusted by nobody.
      // Added only for an https target, and passed as a flag rather than installed,
      // so no repo file and no keychain learns about it.
      ...(BASE.startsWith("https:") ? ["--ignore-certificate-errors"] : []),
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  await sleep(2300);

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((t) => t.type === "page");
  const sock = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    sock.addEventListener("open", res, { once: true });
    sock.addEventListener("error", rej, { once: true });
  });

  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  /** Every request the page makes, in order, with headers and body size. */
  let requests = [];
  const responses = new Map();
  sock.addEventListener("message", (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === "Network.requestWillBeSent") {
      const r = msg.params.request;
      const headers = {};
      for (const [k, v] of Object.entries(r.headers ?? {})) headers[k.toLowerCase()] = v;
      requests.push({
        url: r.url,
        method: r.method,
        headers,
        bodyBytes: r.postData ? Buffer.byteLength(r.postData) : 0,
        // Kept so a request WITH a body can be judged on what the body is, not
        // only on whether one exists. Truncated: the point is to recognise a
        // document, and 4KB is far more than enough to catch a PDF header or a
        // filename while never holding a whole upload in the probe's memory.
        postData: typeof r.postData === "string" ? r.postData.slice(0, 4096) : "",
        hasBody: Boolean(r.hasPostData || r.postData),
        at: Date.now(),
        requestId: msg.params.requestId,
      });
    }
    if (msg.method === "Network.responseReceived") {
      responses.set(msg.params.requestId, { status: msg.params.response.status, at: Date.now() });
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      consoleErrors.push(
        (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300),
      );
    }
    if (msg.method === "Runtime.exceptionThrown") {
      consoleErrors.push(msg.params?.exceptionDetails?.text ?? "exception");
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      const timer = setTimeout(
        () => reject(new Error(`CDP ${method} did not answer in 30s (stale target?)`)),
        30_000,
      );
      pending.set(mid, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      sock.send(JSON.stringify({ id: mid, method, params }));
    });

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) {
      throw new Error(`page threw: ${r.result.exceptionDetails.text}`);
    }
    return r.result?.result?.value;
  };
  const bodyText = () => evaluate("document.body.innerText");
  /** Button labels only — page prose is not evidence that an action exists. */
  const buttons = () =>
    evaluate(
      `[...document.querySelectorAll('button')].map((b) => b.innerText.trim().toLowerCase())`,
    );
  const clickButton = (text) =>
    evaluate(`(() => {
      const el = [...document.querySelectorAll('button')]
        .find((b) => b.innerText.trim().toLowerCase().includes(${JSON.stringify(text.toLowerCase())}));
      if (!el) return false;
      if (el.disabled) return 'disabled';
      el.click();
      return true;
    })()`);
  const attachFiles = async (paths) => {
    const doc = await send("DOM.getDocument", { depth: 1 });
    const q = await send("DOM.querySelector", {
      nodeId: doc.result.root.nodeId,
      selector: 'input[type="file"]',
    });
    if (!q.result?.nodeId) throw new Error("no file input on the page");
    await send("DOM.setFileInputFiles", { nodeId: q.result.nodeId, files: paths });
  };
  const goto = async (path) => {
    await send("Page.navigate", { url: `${BASE}${path}` });
    await sleep(2600);
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("DOM.enable");

  try {
    // ========================================================================
    section(1, "The pilot page boots and offers the form");
    requests = [];
    await goto("/tools/compress-pdf");
    const initial = await bodyText();
    const initialButtons = await buttons();
    check("the compress page rendered its upload form", /Drop|browse/i.test(initial));
    check("the button the user clicks is present", initialButtons.some((b) => b.includes("compress")));
    // The precondition that makes sections 4 and 5 mean anything: nothing here
    // yet claims a finished job.
    check(
      "no terminal state is claimed before anything ran",
      !initialButtons.some((b) => TERMINAL_BUTTONS.includes(b)) &&
        !/Your file is ready/i.test(initial),
      initialButtons.join(" / "),
    );
    check(
      "the page states the execution mode it actually uses",
      /Temporary server processing/i.test(initial),
    );

    // ========================================================================
    section(2, "Submitting routes through the unified pipeline, not the legacy path");
    await attachFiles([inputPath]);
    await sleep(700);
    requests = [];
    const clicked = await clickButton("compress pdf");
    check("the submit button was clickable", clicked === true, String(clicked));

    let submitReq = null;
    for (let i = 0; i < 100; i++) {
      submitReq = requests.find(
        (r) => r.method === "POST" && /\/api\/(jobs|tools)/.test(r.url),
      );
      if (submitReq && responses.has(submitReq.requestId)) break;
      await sleep(100);
    }
    check("the click produced a submission request", Boolean(submitReq));
    if (submitReq) {
      check(
        "it posts to /api/jobs (the pipeline), not /api/tools (the legacy route)",
        /\/api\/jobs/.test(submitReq.url),
        submitReq.url,
      );
      // The runner identity, observed rather than assumed. Only the pipeline
      // client sends an Idempotency-Key; the legacy runner has no such header.
      // This is the check that catches a page frozen at build time with the old
      // runner — the bug this probe was written to find.
      check(
        "the page mounted the PIPELINE runner (its submit carries an Idempotency-Key)",
        typeof submitReq.headers["idempotency-key"] === "string" &&
          submitReq.headers["idempotency-key"].length > 0,
        `headers: ${Object.keys(submitReq.headers).join(", ")}`,
      );
      const res = responses.get(submitReq.requestId);
      const ms = res ? res.at - submitReq.at : null;
      check(
        "the submission was accepted",
        Boolean(res) && res.status < 400,
        `status ${res?.status}`,
      );
      check(
        "it was accepted with 202 (queued), not 200 (done inline)",
        res?.status === 202,
        `status ${res?.status}`,
      );
      // §12/§28: the request hands work off, it does not perform it. The
      // Ghostscript run on this fixture takes hundreds of ms by itself, so a
      // synchronous route could not answer inside this bound.
      check(
        `the job-creation request returned quickly (${ms}ms < 2500ms)`,
        ms !== null && ms < 2500,
        `${ms}ms`,
      );
      console.log(`       submit round-trip: ${ms}ms`);
    }

    // ========================================================================
    section(3, "Progress is reported as real stages, and settles at a terminal one");
    const seenStages = new Set();
    const startedAt = Date.now();
    let terminalButtons = null;
    let terminalText = null;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const [t, bs] = [await bodyText(), await buttons()];
      for (const label of ["Preparing", "Queued", "Processing", "Finalizing"]) {
        if (new RegExp(`\\b${label}\\b`).test(t)) seenStages.add(label);
      }
      if (bs.some((b) => TERMINAL_BUTTONS.includes(b))) {
        terminalButtons = bs;
        terminalText = t;
        break;
      }
      await sleep(150);
    }
    const settledMs = Date.now() - startedAt;
    check(
      "at least one real stage label was shown to the user",
      seenStages.size > 0,
      [...seenStages].join(", ") || "none observed",
    );
    console.log(`       stages observed in the UI: ${[...seenStages].join(" → ") || "none"}`);

    // The job id comes from the page's own polling, so the checks below read the
    // same job the user is looking at.
    const jobId = requests
      .map((r) => r.url.match(/\/api\/jobs\/([^/?#]+)/)?.[1])
      .filter(Boolean)
      .pop();
    check("the page polled a job id", Boolean(jobId), "no /api/jobs/{id} request seen");

    let status = null;
    if (jobId) {
      console.log(`       job id: ${jobId}   settled in ${settledMs}ms`);
      status = await evaluate(
        `fetch('/api/jobs/${jobId}', { cache: 'no-store', credentials: 'same-origin' })
           .then((r) => r.json())`,
      );
      // Pins the stage race: `completeJob` writes `done`, and an in-flight
      // `finalizing` write that lands afterwards leaves a finished job reporting
      // itself as still working. That is what the very first browser run of this
      // pipeline recorded.
      check(
        "a completed job reports the terminal stage 'done', not a stale one",
        status?.stage === "done",
        `status ${status?.status} / stage ${status?.stage}`,
      );
      check("no numeric progress was invented", !("percent" in (status ?? {})));
    }

    // ========================================================================
    section(4, "The job reaches a terminal, successful state in the UI");
    check("the job settled before the deadline", terminalButtons !== null, "still running after 90s");
    check(
      "the panel reports a finished result",
      Boolean(terminalText) && /Your file is ready/i.test(terminalText),
      (terminalText ?? "").split("\n").slice(0, 4).join(" | "),
    );
    check(
      "a Download BUTTON is offered (not merely the word in the page copy)",
      Boolean(terminalButtons) && terminalButtons.includes("download"),
      (terminalButtons ?? []).join(" / "),
    );
    check(
      "the failure branch is not showing",
      Boolean(terminalButtons) && !terminalButtons.includes("try again"),
      (terminalButtons ?? []).join(" / "),
    );

    // ========================================================================
    section(5, "The result is real PDF bytes, and the size the UI advertises");
    if (jobId) {
      // What the panel actually says, read before anything is fetched. This is
      // the user-facing half of the claim: `/result` serving correct bytes is
      // worth little if the page describes them wrongly, and the first run of
      // this probe found exactly that gap — the pilot passed `outputBytes={null}`
      // into the panel, so a job that compressed 10250 bytes to 8118 rendered a
      // bare "Your file is ready" with no numbers at all, while the legacy
      // runner it replaces shows the comparison. Nothing errored; the display
      // was simply absent.
      const panelText = await evaluate(
        `document.body.innerText.replace(/\\s+/g, ' ')`,
      );

      // Errors are RETURNED, not thrown. `/result` is a 302 to a signed storage
      // URL built from the app's configured site URL, so a server started on a
      // port that does not match `NEXT_PUBLIC_SITE_URL` redirects the browser to
      // a dead origin. That is a misconfigured probe environment, not a product
      // failure, and it should be reported as a legible FAIL with the URL it
      // reached rather than crashing the run halfway through.
      const out = await evaluate(`(async () => {
        try {
          const r = await fetch('/api/jobs/${jobId}/result', { credentials: 'same-origin' });
          if (!r.ok) return { error: 'result ' + r.status, finalUrl: r.url };
          const buf = new Uint8Array(await r.arrayBuffer());
          return {
            bytes: buf.length,
            header: String.fromCharCode(...buf.slice(0, 5)),
            disposition: r.headers.get('content-disposition'),
            finalUrl: r.url,
          };
        } catch (e) {
          return { error: 'fetch failed: ' + ((e && e.message) || e) };
        }
      })()`);
      check("the result route served the output", !out?.error, JSON.stringify(out));
      if (!out?.error) {
        check("the downloaded bytes are a PDF", out.header === "%PDF-", out.header);
        check("the output is non-trivial in size", out.bytes > 500, `${out.bytes} bytes`);
        check(
          "work actually happened (output differs from input)",
          out.bytes !== input.length,
          `in ${input.length} / out ${out.bytes}`,
        );

        // Fidelity between what the API reports and what the user receives.
        check(
          "the byte count the API reports equals the bytes delivered",
          status?.outputBytes === out.bytes,
          `reported ${status?.outputBytes} / delivered ${out.bytes}`,
        );

        // ...and between the API and the rendered page. `formatBytes` is
        // reimplemented here on purpose: this probe validates the built
        // application from the outside, so importing the app's own formatter
        // would let a bug in it agree with itself.
        const expectOut = formatBytes(out.bytes);
        const expectIn = formatBytes(input.length);
        check(
          `the panel displays the delivered output size (${expectOut})`,
          panelText.includes(expectOut),
          panelText.slice(0, 220),
        );
        check(
          `the panel shows the before/after comparison (${expectIn} → ${expectOut})`,
          panelText.includes(`${expectIn} → ${expectOut}`),
          panelText.slice(0, 220),
        );
        check(
          "the panel quantifies the saving it achieved",
          /\(\d+% smaller\)/.test(panelText),
          (panelText.match(/\(\d+% smaller\)/) ?? ["absent"])[0],
        );

        // The submitted name is untrusted input that becomes a storage key, so
        // the assertion is about sanitization, not cosmetics: the derived name
        // must be present and the raw one must not.
        const servedUrl = String(out.finalUrl ?? "");
        check(
          "the stored output name is derived from the submitted name, sanitized",
          /compressed/i.test(servedUrl) && !/Quarterly(%20| )Report\.pdf/i.test(servedUrl),
          servedUrl,
        );

        const pct = Math.round((1 - out.bytes / input.length) * 100);
        console.log(
          `       ${input.length} bytes in → ${out.bytes} bytes out (${pct}% smaller)`,
        );
        console.log(`       panel said: ${(panelText.match(/[\d.]+ [KMG]?B → [\d.]+ [KMG]?B[^)]*\)/) ?? ["(no size line)"])[0]}`);
        console.log(`       served from: ${servedUrl}`);
        // Recorded, not asserted. `Content-Disposition` is set on the 302 from
        // `/result`, and a redirect's headers do not survive being followed — the
        // storage response is the one the browser sees. Both the local HMAC route
        // and an R2 presign serve the object without a disposition, so this reads
        // null for the legacy runner too. Pre-existing and shared, not a pilot
        // regression; see the phase report.
        console.log(
          `       content-disposition after redirect: ${out.disposition} (documented best-effort; see report)`,
        );
      }
    }

    // ========================================================================
    section(6, "A LOCAL tool keeps the document in the browser");
    requests = [];
    await goto("/tools/merge-pdf");
    const mergeInitial = await bodyText();
    const mergeButtons0 = await buttons();
    check("the merge page rendered", /Drop your PDFs|browse/i.test(mergeInitial));
    check(
      "the merge page states local processing",
      /never|browser|device|local/i.test(mergeInitial),
      mergeInitial.split("\n").slice(0, 6).join(" | "),
    );
    check(
      "no terminal state is claimed before anything ran",
      !mergeButtons0.some((b) => TERMINAL_BUTTONS.includes(b)),
      mergeButtons0.join(" / "),
    );

    await attachFiles([localA, localB]);
    await sleep(800);
    requests = [];
    const mergeClicked = await clickButton("merge pdfs");
    check("the merge button was clickable", mergeClicked === true, String(mergeClicked));

    let mergeButtons = null;
    for (let i = 0; i < 120; i++) {
      const bs = await buttons();
      if (bs.some((b) => TERMINAL_BUTTONS.includes(b))) {
        mergeButtons = bs;
        break;
      }
      await sleep(150);
    }
    // The control for everything below. Without an observed result, "no uploads"
    // would only prove the click did nothing.
    check(
      "the local merge really produced a result in the browser",
      mergeButtons !== null,
      "no terminal button appeared within 18s",
    );

    const pipelineCalls = requests.filter((r) => /\/api\/jobs/.test(r.url));
    const toolCalls = requests.filter((r) => /\/api\/tools\//.test(r.url));
    const bodies = requests.filter((r) => r.hasBody);
    check(
      "the merge created no job",
      pipelineCalls.length === 0,
      pipelineCalls.map((r) => r.url).join(", "),
    );
    check(
      "the merge called no server tool route",
      toolCalls.length === 0,
      toolCalls.map((r) => r.url).join(", "),
    );
    // The funnel beacon is now the one request a local merge legitimately makes,
    // and it did not exist when this check was written. "No request carried a
    // body" was a PROXY for "the document did not leave"; a beacon body makes the
    // proxy wrong without making the property untrue, so the property is asserted
    // directly instead — the endpoint, the size, and the content.
    const isBeacon = (r) => /\/api\/analytics\/events$/.test(new URL(r.url).pathname);
    const beacons = bodies.filter(isBeacon);
    const otherBodies = bodies.filter((r) => !isBeacon(r));
    check(
      "nothing but the funnel beacon carried a body while merging (the PDF bytes never left)",
      otherBodies.length === 0,
      otherBodies.map((r) => `${r.method} ${r.url} (${r.bodyBytes}B)`).join(", "),
    );
    check(
      "the beacon body is a handful of declared dimensions, not a document",
      // Two merged PDFs are kilobytes each; a body under 2KB cannot be carrying
      // one even before looking at what is in it.
      beacons.length > 0 && beacons.every((r) => r.bodyBytes > 0 && r.bodyBytes < 2048),
      beacons.map((r) => `${r.bodyBytes}B`).join(", ") || "no beacon observed",
    );
    check(
      "the beacon body names no file and carries no PDF bytes",
      beacons.every((r) => !/%PDF|\.pdf|fileName|local-[ab]/i.test(r.postData ?? "")),
      beacons.map((r) => (r.postData ?? "").slice(0, 160)).join(" ⏎ "),
    );
    const blobResult = await evaluate(
      `[...document.querySelectorAll('a')].some((a) => (a.href || '').startsWith('blob:'))`,
    );
    console.log(
      `       requests during the merge: ${requests.length}` +
        (requests.length ? ` (${[...new Set(requests.map((r) => new URL(r.url).pathname))].join(", ")})` : ""),
    );
    console.log(`       blob: anchor present: ${blobResult}`);

    // ========================================================================
    section(7, "No page errors along the way");
    const real = consoleErrors.filter(
      (e) => !/favicon|Failed to load resource.*404|ERR_BLOCKED/i.test(e),
    );
    check("the browser reported no console errors", real.length === 0, real.slice(0, 3).join(" ⏎ "));
  } finally {
    try {
      chrome.kill();
    } catch {
      /* already gone */
    }
  }

  console.log(`\n${"─".repeat(64)}`);
  console.log(`checks passed: ${passed}   failed: ${failures.length}`);
  if (failures.length) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }
  console.log("PILOT BROWSER VERIFICATION: PASS");
}

main().catch((err) => {
  console.error("\nprobe crashed:", err);
  process.exit(1);
});
