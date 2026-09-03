/* global process, console, fetch, WebSocket, setTimeout, clearTimeout, Buffer */
/**
 * PERMANENT runtime probe: THE WHOLE WORKFLOW, in a REAL browser.
 *
 * Phase 5's brief is one sentence — a user should be able to start with a PDF
 * anywhere in PDFDadi, do useful work, move the result into the next step, and
 * always know where the document lives. Every unit test in this repository runs in
 * `environment: "node"`, so not one of them has ever produced a result, pressed
 * `Open in Editor`, watched a handoff cross a navigation, published a version from
 * the Workspace chrome, or looked at an activity feed. The recorded defects were
 * all of that kind: a merge result that offered only Download, an `Opened` column
 * that read `—` for every row, an activity feed that said "uploaded an item", and a
 * Workspace editor that autosaved drafts it could never publish.
 *
 * The journeys below are the ones the brief names:
 *
 *   A  merge (browser tool)  → Open in Editor
 *   B  merge (browser tool)  → Save to Workspace, twice
 *   C  compress (cloud job)  → Save to Workspace, bytes never in the browser
 *   D  Workspace document    → edit → Publish version
 *   E  publish → immediate further edit, with NO false conflict
 *   F  Opened and Recent actually reflect an open
 *   G  Activity names the document and the version
 *   H  a signed-OUT user's handoff still works, and offers sign-in, not an upload
 *   I  an output the editor cannot open offers neither action, server included
 *   J  a member of several Workspaces CHOOSES where the result goes
 *   K  the same save intention twice is one document, across a navigation
 *   L  the bytes in the Workspace are the bytes the tool produced
 *   M  two real sessions race, and the stale one gets a real conflict dialog
 *   I' the same non-PDF question again, in the browser, on a REAL job result
 *   N  a save INTENTION is the identity: a retry, a deliberate re-save of
 *      identical bytes, and a save after a trash — the three the previous
 *      closeout got wrong by treating the content checksum as the identity
 *
 * WHAT WOULD MAKE THIS VACUOUS, and how each is guarded:
 *
 *  - **Nothing ran.** Every journey asserts its own precondition first: two files
 *    attached, a result panel on screen, an object count that changed, a document
 *    id that came back from the server. A run that produced nothing fails at the
 *    precondition rather than passing on an absence.
 *  - **"The button is not there" as a pass.** Absence is only ever asserted next to
 *    a presence: journey I asserts Download IS offered in the same read that finds
 *    no `Open in Editor`, so a blank page passes neither.
 *  - **An assertion nothing writes.** Journeys F and G read through the product's
 *    own API and pages, for the document this run created, by name and id.
 *  - **A conflict that never had the chance to happen.** Journey E edits AFTER a
 *    real publish and waits out the full autosave ceiling, so the write it is
 *    watching for is one that genuinely went to the server.
 *
 * IT MUTATES DATA. One throwaway account per run, its own Workspace, its own
 * documents, against whatever database the target server uses. It never touches
 * another account's rows, and journey H deliberately runs signed out.
 *
 * RUN IT AGAINST A PRODUCTION BUILD, OVER HTTPS. Three constraints decide the
 * recipe, and `npx next start` on a loopback origin satisfies none of them:
 * `next.config.ts` sets `output: "standalone"`, so that artifact is the runtime
 * production actually uses; the startup gate refuses to boot with a loopback
 * `NEXT_PUBLIC_SITE_URL`; and the session and anonymous-owner cookies are
 * `Secure`, so on plain `http://` Chrome drops them, every ownership check
 * resolves a different actor, and journeys B through F fail with 404s that read
 * exactly like product defects.
 *
 *   node scripts/next-build.js
 *   cp -R .next/static .next/standalone/.next/static        # the Dockerfile's own step
 *   [ -d public ] && cp -R public .next/standalone/public
 *   cd .next/standalone && NODE_ENV=production PORT=3002 HOSTNAME=127.0.0.1 \
 *     NEXT_PUBLIC_SITE_URL=https://<lan-ip>:3001 PROCESSING_PIPELINE=on \
 *     DATABASE_URL="file:$TMPDIR/wf-probe.db" node server.js &
 *   node scripts/tls-front.mjs --listen 3001 --target 3002   # prints the origin
 *   node scripts/workflow-completeness-probe.mjs --url https://<lan-ip>:3001
 *
 * A THROWAWAY database (`npx prisma migrate deploy` against it first), never the
 * developer one: this probe runs real tool jobs, and those land in the usage
 * ledger. `--url` MUST equal `NEXT_PUBLIC_SITE_URL` exactly, or the save-to-
 * Workspace request becomes cross-origin and the CSRF gate refuses it — which
 * would read as defect C returning.
 *
 * A failure prints its own classification: PRODUCT (the app is wrong), PROBE (this
 * script is wrong) or ENVIRONMENTAL (a binary or service this machine lacks).
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg("--url", "http://localhost:3001");
const CHROME =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEBUG_PORT = Number(arg("--port", "9436"));
/** The autosave debounce is 700ms with a 4s ceiling; this clears both. */
const AUTOSAVE_GRACE_MS = 5200;
// The terminator in front of an https target is self-signed, so node's own fetch
// rejects it and the health precheck fails against a server that is serving
// perfectly. Set here rather than left to the recipe: a step that only matters on
// one transport is a step people omit. This process only.
if (BASE.startsWith("https:")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(label, pass, detail = "", kind = "PRODUCT") {
  results.push({ label, pass: !!pass, detail: String(detail).slice(0, 400), kind });
  console.log(`${pass ? "PASS" : `FAIL[${kind}]`}  ${label}${detail ? `  — ${detail}` : ""}`);
}
function section(letter, title) {
  console.log(`\n=============== ${letter}. ${title} ===============`);
}

/** A real multi-page PDF with real text, so a merge and a compress both have work. */
async function makePdf(path, label, pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i += 1) {
    const page = doc.addPage([612, 792]);
    for (let row = 0; row < 34; row += 1) {
      page.drawText(`${label} page ${i + 1} line ${row + 1} — workflow completeness probe`, {
        x: 42,
        y: 738 - row * 20,
        size: 11,
        font,
        color: rgb(0.1, 0.1, 0.25),
      });
    }
    for (let b = 0; b < 48; b += 1) {
      page.drawRectangle({
        x: 42 + (b % 12) * 45,
        y: 44 + Math.floor(b / 12) * 12,
        width: 40,
        height: 8,
        color: rgb((b % 7) / 7, (b % 5) / 5, (b % 3) / 3),
      });
    }
  }
  writeFileSync(path, await doc.save());
  return path;
}

/**
 * A SECOND real browser, for the one journey that needs two of them.
 *
 * Journey M has to hold the same document open in two sessions at the same
 * revision, and two tabs of one profile cannot do that: they share the cookie jar
 * AND the IndexedDB store the persistence coordinator keeps its locally-durable
 * revision in, so the second tab would read the first one's state and the conflict
 * under test would never be reached. A separate profile is the isolation.
 *
 * Only the gestures journey M performs are wrapped. This is deliberately not a
 * second copy of the main helper set — everything the other journeys need stays in
 * `main`, where it is used.
 */
async function browserSession(port, base) {
  spawnSync("pkill", ["-f", `remote-debugging-port=${port}`], { stdio: "ignore" });
  await sleep(400);
  const userDataDir = mkdtempSync(join(tmpdir(), "wf-chrome-b-"));
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
      "--window-size=1500,1150",
      ...(base.startsWith("https:") ? ["--ignore-certificate-errors"] : []),
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let targets = null;
  for (let attempt = 0; attempt < 40 && !targets; attempt += 1) {
    await sleep(300);
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    } catch {
      targets = null;
    }
  }
  const page = (targets ?? []).find((t) => t.type === "page");
  if (!page) {
    chrome.kill();
    throw new Error(`the second browser never opened a debug port on ${port}`);
  }
  const sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    sock.addEventListener("open", resolve, { once: true });
    sock.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  sock.addEventListener("message", (event) => {
    const msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      const timer = setTimeout(() => reject(new Error(`CDP(B) ${method} timed out`)), 60_000);
      pending.set(mid, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      sock.send(JSON.stringify({ id: mid, method, params }));
    });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("DOM.enable");
  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.result?.exceptionDetails) return { __probeError: res.result.exceptionDetails.text };
    return res.result?.result?.value;
  };
  const goto = async (path, wait = 2800) => {
    await send("Page.navigate", { url: path.startsWith("http") ? path : `${base}${path}` });
    await sleep(wait);
  };
  const mouseClick = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0,
    });
    await sleep(300);
  };
  const clickLabel = async (label, selector = "button, a") => {
    const box = await evaluate(`(() => {
      const re = new RegExp(${JSON.stringify(label)}, "i");
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(
        (n) => re.test((n.textContent || "").trim()) || re.test(n.getAttribute("aria-label") || ""),
      );
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!box || box.__probeError) return false;
    await mouseClick(box.x, box.y);
    return true;
  };
  return {
    evaluate,
    goto,
    clickLabel,
    url: () => evaluate("location.href"),
    text: () => evaluate("document.body.innerText"),
    setField: (name, value) =>
      evaluate(`(() => {
        const el = document.querySelector('input[name="${name}"]');
        if (!el) return "missing";
        const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return "ok";
      })()`),
    key: async (keyName, code, text) => {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, text });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code });
      await sleep(240);
    },
    drag: async (x0, y0, x1, y1) => {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0, y: y0, buttons: 0 });
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed", x: x0, y: y0, button: "left", clickCount: 1, buttons: 1,
      });
      for (let i = 1; i <= 6; i += 1) {
        await send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: x0 + Math.round(((x1 - x0) * i) / 6),
          y: y0 + Math.round(((y1 - y0) * i) / 6),
          button: "left",
          buttons: 1,
        });
        await sleep(35);
      }
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased", x: x1, y: y1, button: "left", clickCount: 1, buttons: 0,
      });
      await sleep(550);
    },
    pageRect: () =>
      evaluate(`(() => {
        const rects = [...document.querySelectorAll('main svg rect')]
          .map((r) => r.getBoundingClientRect())
          .filter((b) => b.width > 200 && b.height > 200)
          .sort((a, b) => b.width * b.height - a.width * a.height);
        if (!rects.length) return null;
        const b = rects[0];
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
      })()`),
    countObjects: () => evaluate(`document.querySelectorAll('main svg [data-object-id]').length`),
    pageCount: () =>
      evaluate(`(() => {
        const labelled = [...document.querySelectorAll('[aria-label]')]
          .map((n) => /Page\\s+\\d+\\s+of\\s+(\\d+)/.exec(n.getAttribute('aria-label') || ''))
          .find(Boolean);
        if (labelled) return Number(labelled[1]);
        const m = /(\\d+)\\s*\\/\\s*(\\d+)/.exec(document.body.innerText || '');
        return m ? Number(m[2]) : null;
      })()`),
    close: () => {
      try {
        sock.close();
      } catch {
        /* already gone */
      }
      chrome.kill();
    },
  };
}

async function main() {
  const health = await fetch(BASE)
    .then((r) => r.status)
    .catch(() => 0);
  if (health === 0) throw new Error(`No server answering on ${BASE}`);
  check("0: a server is answering on the verification origin", health < 500, `GET / → ${health}`);

  const fixtures = mkdtempSync(join(tmpdir(), "wf-probe-"));
  const pdfA = await makePdf(join(fixtures, "quarterly-report.pdf"), "Alpha", 2);
  const pdfB = await makePdf(join(fixtures, "appendix.pdf"), "Beta", 1);

  const userDataDir = mkdtempSync(join(tmpdir(), "wf-chrome-"));
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
      "--window-size=1500,1150",
      ...(BASE.startsWith("https:") ? ["--ignore-certificate-errors"] : []),
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
  const sock = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    sock.addEventListener("open", resolve, { once: true });
    sock.addEventListener("error", reject, { once: true });
  });

  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  const documentStatuses = [];
  /**
   * Every request the page made, with its method, url and the SIZE of its body.
   *
   * The size is the whole point of journeys A, C and H: "the bytes never left the
   * browser" is not a claim about intent, it is a claim about what crossed the
   * network, and a request log with body sizes is the only place that is visible.
   */
  const requests = [];
  sock.addEventListener("message", (event) => {
    const msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      consoleErrors.push(
        (msg.params.args || [])
          .map((a) => a.value ?? a.description ?? "")
          .join(" ")
          .slice(0, 300),
      );
    }
    if (msg.method === "Runtime.exceptionThrown") {
      consoleErrors.push(msg.params?.exceptionDetails?.text ?? "exception");
    }
    if (msg.method === "Network.requestWillBeSent") {
      const req = msg.params.request;
      requests.push({
        at: Date.now(),
        method: req.method,
        url: req.url,
        // `null` means "a body was sent that CDP did not inline", i.e. a big one.
        // Null is treated as large everywhere below: for a privacy assertion the
        // conservative reading of an unknown size is the only honest one.
        bodyBytes: req.postData ? req.postData.length : null,
        hasPostData: req.hasPostData === true || !!req.postData,
      });
    }
    if (msg.method === "Network.responseReceived" && msg.params?.type === "Document") {
      documentStatuses.push({ url: msg.params.response.url, status: msg.params.response.status });
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      const timer = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), 60_000);
      pending.set(mid, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      sock.send(JSON.stringify({ id: mid, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.result?.exceptionDetails) return { __probeError: res.result.exceptionDetails.text };
    return res.result?.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("DOM.enable");

  const goto = async (path, wait = 2800) => {
    await send("Page.navigate", { url: path.startsWith("http") ? path : `${BASE}${path}` });
    await sleep(wait);
  };
  const url = () => evaluate("location.href");
  const text = () => evaluate("document.body.innerText");
  const statusFor = (path) =>
    documentStatuses.filter((row) => row.url.includes(path)).at(-1)?.status ?? null;
  /** Button and link labels only — page prose is not evidence that an action exists. */
  const controls = () =>
    evaluate(
      `[...document.querySelectorAll('button, a')].map((n) => (n.innerText || '').trim()).filter(Boolean)`,
    );
  const mouseClick = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0,
    });
    await sleep(260);
  };
  /**
   * Clicks a control by its text OR its accessible name, with a real mouse press
   * at its centre. Both, because several controls in this product carry their
   * label in a `hidden sm:inline` span and their only always-present name in
   * `aria-label` — matching on text alone would miss them at some widths.
   *
   * A zero-sized box is treated as "not found": clicking the middle of nothing is
   * how a probe reports a pass for a control that never rendered.
   */
  const clickLabel = async (label, selector = "button, a") => {
    const box = await evaluate(`(() => {
      const re = new RegExp(${JSON.stringify(label)}, "i");
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(
        (n) => re.test((n.textContent || "").trim()) || re.test(n.getAttribute("aria-label") || ""),
      );
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!box || box.__probeError) return false;
    await mouseClick(box.x, box.y);
    return true;
  };
  /**
   * A real key press. `code` as well as `key`, because the editor's tool
   * shortcuts are read from `event.code` — a `keyDown` with only `key` set
   * selects nothing, and the drag that follows then draws nothing.
   */
  const key = async (keyName, code, text) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, text });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code });
    await sleep(240);
  };
  const drag = async (x0, y0, x1, y1) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0, y: y0, buttons: 0 });
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: x0, y: y0, button: "left", clickCount: 1, buttons: 1,
    });
    for (let i = 1; i <= 6; i += 1) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: x0 + Math.round(((x1 - x0) * i) / 6),
        y: y0 + Math.round(((y1 - y0) * i) / 6),
        button: "left",
        buttons: 1,
      });
      await sleep(35);
    }
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: x1, y: y1, button: "left", clickCount: 1, buttons: 0,
    });
    await sleep(550);
  };
  const attachFiles = async (paths) => {
    const doc = await send("DOM.getDocument", { depth: 1 });
    const q = await send("DOM.querySelector", {
      nodeId: doc.result.root.nodeId,
      selector: 'input[type="file"]',
    });
    if (!q.result?.nodeId) return false;
    await send("DOM.setFileInputFiles", { nodeId: q.result.nodeId, files: paths });
    await sleep(1800);
    return true;
  };
  /** The page canvas: the largest-by-AREA rect inside the editor's svg. */
  const pageRect = () =>
    evaluate(`(() => {
      const rects = [...document.querySelectorAll('main svg rect')]
        .map((r) => r.getBoundingClientRect())
        .filter((b) => b.width > 200 && b.height > 200)
        .sort((a, b) => b.width * b.height - a.width * a.height);
      if (!rects.length) return null;
      const b = rects[0];
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    })()`);
  const countObjects = () =>
    evaluate(`document.querySelectorAll('main svg [data-object-id]').length`);
  /**
   * How many pages the editor believes it opened.
   *
   * The page field's accessible name first ("Page 1 of 3"), because it is present
   * whether the control is collapsed or expanded and whether the number lives in
   * an input value (which `innerText` cannot see). The visible "1 / 3" is the
   * fallback for the collapsed form.
   */
  const pageCount = () =>
    evaluate(`(() => {
      const labelled = [...document.querySelectorAll('[aria-label]')]
        .map((n) => /Page\\s+\\d+\\s+of\\s+(\\d+)/.exec(n.getAttribute('aria-label') || ''))
        .find(Boolean);
      if (labelled) return Number(labelled[1]);
      const m = /(\\d+)\\s*\\/\\s*(\\d+)/.exec(document.body.innerText || '');
      return m ? Number(m[2]) : null;
    })()`);
  /**
   * The canonical save readout, wherever it is rendered.
   *
   * Both the app bar's pill and the status bar carry the sentence in a `title`, and
   * the live regions carry the announcement — so all three are collected and joined.
   * Reading only one surface would make the assertion depend on which chrome the
   * page happens to be showing, which is a probe bug disguised as a product bug.
   */
  const saveStatus = () =>
    evaluate(`(() => {
      const titled = [...document.querySelectorAll('[title]')].map((n) => n.getAttribute('title') || '');
      const live = [...document.querySelectorAll('[role="status"], [role="alert"]')].map((n) =>
        (n.textContent || '').replace(/\\s+/g, ' ').trim(),
      );
      return [...titled, ...live].filter(Boolean).join(' || ');
    })()`);
  /** An authenticated API read, through the page so the session cookie applies. */
  const api = (path) =>
    evaluate(
      `fetch(${JSON.stringify(path)}, { headers: { Accept: "application/json" } })
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
        .catch((e) => ({ status: 0, body: String(e) }))`,
    );
  /**
   * The "did the document leave this browser?" evidence, in two parts.
   *
   * `escapes` is every request since a mark that carried a body to somewhere other
   * than the analytics beacon. The beacon is allow-listed rather than ignored: it
   * is a POST, it does fire on a local tool run, and it carries an event name and a
   * file COUNT — never a byte of the document — so counting it as an upload would
   * make the invariant unassertable while hiding nothing.
   *
   * `bigBodies` closes the hole that allow-list would otherwise open: anything with
   * a body over a few KB, INCLUDING the beacon's own URL, is reported. A document
   * cannot be smuggled through an allow-listed endpoint without showing up here.
   */
  const ANALYTICS_PATH = "/api/analytics/events";
  const SMALL_BODY_BYTES = 4096;
  const bodied = (mark) =>
    requests.filter((r) => r.at >= mark && r.hasPostData && !r.url.includes("/_next/"));
  const escapes = (mark) => bodied(mark).filter((r) => !r.url.includes(ANALYTICS_PATH));
  const bigBodies = (mark) =>
    bodied(mark).filter((r) => r.bodyBytes === null || r.bodyBytes > SMALL_BODY_BYTES);
  const describe = (rows) =>
    rows.map((r) => `${r.method} ${r.url} (${r.bodyBytes ?? "large"}b)`).join(", ").slice(0, 300);

  /* ================= account + Workspace, through the real forms ============ */
  section("SETUP", "a real account and a real Workspace");
  const stamp = Date.now();
  const email = `wf.${stamp}@example.test`;
  const PASSWORD = "Phase5-Workflow-Probe!";
  const setField = (name, value) =>
    evaluate(`(() => {
      const el = document.querySelector('input[name="${name}"]');
      if (!el) return "missing";
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return "ok";
    })()`);

  await goto("/register", 3200);
  await setField("name", "Workflow Prober");
  await setField("email", email);
  await setField("password", PASSWORD);
  await setField("confirmPassword", PASSWORD);
  await evaluate(`document.querySelector('input[name="acceptedTerms"]')?.click()`);
  await clickLabel("^Create account$");
  await sleep(6500);
  check(
    "setup: registering lands the prober in the authenticated app",
    /\/workspaces/.test((await url()) ?? ""),
    await url(),
  );

  /*
   * The Workspace registration PROVISIONED, not a new one.
   *
   * This cost a full run to learn: `resolveSaveTarget` prefers the organization's
   * DEFAULT Workspace, which is the one `provisionPersonalAccount` creates at
   * registration. A probe that creates a second Workspace and then watches it sees
   * every save land somewhere else and reports journeys D through G as broken
   * products. Reading the destination instead of choosing one keeps the probe and
   * the product pointed at the same place by construction — and journey B asserts
   * the two agree, so a future divergence fails loudly instead of silently.
   */
  await goto("/workspaces", 3800);
  const provisioned = await evaluate(`(() => {
    const a = [...document.querySelectorAll('a[href*="/workspaces/"]')].find((n) =>
      /\\/workspaces\\/[^/?#]+/.test(n.getAttribute("href") || ""),
    );
    if (!a) return null;
    const u = new URL(a.href);
    return {
      workspaceId: (/\\/workspaces\\/([^/?#]+)/.exec(u.pathname) || [])[1] || null,
      organizationId: u.searchParams.get("organizationId"),
    };
  })()`);
  const workspaceId = provisioned?.workspaceId ?? null;
  const organizationId = provisioned?.organizationId ?? null;
  check(
    "setup: registration provisioned a Workspace to receive results",
    !!workspaceId && !!organizationId,
    `workspace ${workspaceId} org ${organizationId}`,
  );
  if (!workspaceId || !organizationId) throw new Error("setup failed: no Workspace to work in");
  const wsQuery = `organizationId=${encodeURIComponent(organizationId)}`;

  /* ================= A. merge → Open in Editor ============================== */
  section("A", "a browser result opens in the editor, and the bytes never leave");
  await goto("/tools/merge-pdf", 3000);
  check("A: the merge tool page renders", /Merge/i.test((await text()) ?? ""));
  check("A: two PDFs can be attached", await attachFiles([pdfA, pdfB]));
  const mergeMark = Date.now();
  check("A: the merge control is reachable", await clickLabel("^Merge PDFs$", "button"));
  await sleep(4500);

  const resultText = (await text()) ?? "";
  check(
    "A: the merge produced a result panel — the precondition for everything below",
    /Your file is ready/i.test(resultText),
    resultText.slice(0, 140).replace(/\n/g, " | "),
  );

  /*
   * Defect B, at the only place it is visible: the produced NAME. The recording
   * showed `probe-document-merged (1)-merged.pdf`; the policy answer for these two
   * inputs is one base, one suffix, one extension.
   */
  const producedName = /([\w .()-]+\.pdf)/i.exec(resultText)?.[1]?.trim() ?? "";
  check(
    "A/B: the produced name is the naming policy's, with no stacked suffix",
    producedName === "quarterly-report-and-appendix-merged.pdf",
    producedName || "no filename on screen",
  );
  check(
    "A/B: no `.pdf.pdf`, and no download-folder collision marker in the name",
    !/\.pdf\.pdf/i.test(producedName) && !/\(\d+\)/.test(producedName),
    producedName,
  );

  /* Defect A: the dead end. Three actions, not "Download and Start over". */
  const resultControls = (await controls()) ?? [];
  check(
    "A: the result offers Download AND Open in Editor AND Save to Workspace",
    resultControls.some((l) => /^Download$/i.test(l)) &&
      resultControls.some((l) => /Open in Editor/i.test(l)) &&
      resultControls.some((l) => /Save to Workspace/i.test(l)),
    resultControls.join(" / ").slice(0, 260),
  );

  /*
   * The privacy invariant, measured rather than asserted: between pressing Merge
   * and standing on a finished result, nothing with a body went to a server. A
   * merge runs in the browser, so a request carrying the file here would mean the
   * page uploaded a document the user never agreed to upload.
   */
  check(
    "A: producing the result uploaded nothing — the merge ran in this browser",
    escapes(mergeMark).length === 0,
    describe(escapes(mergeMark)),
  );
  check(
    "A: and no request body was large enough to be the document",
    bigBodies(mergeMark).length === 0,
    describe(bigBodies(mergeMark)),
  );

  const openMark = Date.now();
  check("A: Open in Editor is pressable", await clickLabel("Open in Editor", "button"));
  await sleep(7000);
  const editorUrl = (await url()) ?? "";
  /*
   * The NAVIGATION is the evidence, not the address bar: the shell consumes the
   * handoff on mount and `history.replaceState`s the parameter away deliberately,
   * so that a reload cannot report a missing handoff and a bookmarked URL cannot
   * point at one that is already spent. Asserting the live URL therefore fails
   * against correct behaviour — the request log is where the handoff id is still
   * visible, and the length bound is what proves an id crossed rather than a
   * base64 document.
   */
  const HANDOFF_NAV = /\/editor\?(?:[^#]*&)?handoff=[\w-]{6,}/;
  // The client-side navigation appends `&_rsc=…` of its own, so the id is not the
  // last parameter — a `$`-anchored match fails against a correct handoff.
  const handoffNavigations = requests.filter(
    (r) => r.at >= openMark && HANDOFF_NAV.test(r.url) && r.url.length < 300,
  );
  check(
    "A: Open in Editor navigates to the editor carrying a handoff id, not the bytes",
    handoffNavigations.length > 0,
    handoffNavigations.map((r) => r.url).join(", ").slice(0, 200) ||
      `no handoff navigation recorded; editor requests were [${requests
        .filter((r) => r.at >= openMark && r.url.includes("/editor"))
        .map((r) => r.url)
        .join(" , ")
        .slice(0, 220)}]`,
  );
  check(
    "A: the spent handoff id is not left in the address bar",
    /\/editor$/.test(editorUrl.replace(/[?#].*$/, "")) && !/handoff=/.test(editorUrl),
    editorUrl.slice(0, 200),
  );
  check(
    "A: the editor opened the MERGED document — 3 pages, from a 2-page and a 1-page input",
    (await pageCount()) === 3,
    `page count ${await pageCount()}`,
  );
  check(
    "A: the handoff crossed the navigation through this browser, not through a server",
    escapes(openMark).length === 0 && bigBodies(openMark).length === 0,
    describe([...escapes(openMark), ...bigBodies(openMark)]),
  );

  /* ================= B. merge → Save to Workspace, twice =================== */
  section("B", "a browser result becomes ONE Workspace document, and stays one");
  await goto("/tools/merge-pdf", 3000);
  await attachFiles([pdfA, pdfB]);
  await clickLabel("^Merge PDFs$", "button");
  await sleep(4500);
  check(
    "B: a second merge run produced a result panel",
    /Your file is ready/i.test((await text()) ?? ""),
  );

  const before = await api(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/documents?${wsQuery}`,
  );
  const countOf = (payload) =>
    Array.isArray(payload?.body?.documents)
      ? payload.body.documents.length
      : Array.isArray(payload?.body?.items)
        ? payload.body.items.length
        : null;
  const beforeCount = countOf(before);
  check(
    "B: the Workspace document list is readable, so a duplicate would be visible",
    beforeCount !== null,
    `status ${before?.status} count ${beforeCount}`,
  );

  check("B: Save to Workspace is pressable", await clickLabel("Save to Workspace", "button"));
  await sleep(6500);
  const savedReadout = (await text()) ?? "";
  check(
    "B: the save reports success in the canonical words",
    /Saved to your Workspace/i.test(savedReadout),
    savedReadout.slice(0, 200).replace(/\n/g, " | "),
  );
  const savedHref = await evaluate(
    `(() => { const a = [...document.querySelectorAll('a')].find((n) => /Open document/i.test(n.textContent || "")); return a ? a.getAttribute("href") : null; })()`,
  );
  const savedDocumentId = /\/documents\/([^/?#]+)/.exec(savedHref ?? "")?.[1] ?? null;
  check(
    "B: the save answered with a canonical document id, linked as `Open document`",
    !!savedDocumentId,
    savedHref ?? "no Open document link",
  );
  /*
   * The probe and the product are pointed at the same Workspace. The server picks
   * the destination (`resolveSaveTarget`), so this is the only place the two can
   * disagree — and if they ever do, the counts, the Recent list and the publish
   * journey all read an empty Workspace and blame the product for it.
   */
  const savedWorkspaceId = /\/workspaces\/([^/?#]+)/.exec(savedHref ?? "")?.[1] ?? null;
  check(
    "B: the server saved into the Workspace this run is watching",
    savedWorkspaceId === workspaceId,
    `saved into ${savedWorkspaceId}, watching ${workspaceId}`,
    "PROBE",
  );

  /*
   * The double-press. The recorded defect C was two `Untitled PDF.pdf` documents;
   * the guard is that the Save button is REPLACED by the link, so there is nothing
   * left to press twice — and pressing Save again, if it were there, must not
   * produce a second document.
   */
  const saveStillOffered = ((await controls()) ?? []).some((l) => /Save to Workspace/i.test(l));
  check(
    "B/C: after a successful save the Save control is gone, replaced by `Open document`",
    !saveStillOffered,
    saveStillOffered ? "Save to Workspace is still pressable" : "replaced",
  );
  await clickLabel("Save to Workspace", "button");
  await sleep(3000);

  const after = await api(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/documents?${wsQuery}`,
  );
  const afterCount = countOf(after);
  check(
    "B/C: exactly ONE document was created — no duplicate `Untitled PDF.pdf`",
    beforeCount !== null && afterCount === beforeCount + 1,
    `before ${beforeCount} after ${afterCount}`,
  );
  const savedNames = (after?.body?.documents ?? after?.body?.items ?? []).map((d) => d?.name);
  check(
    "B: the stored document carries the produced name, not `Untitled PDF.pdf`",
    savedNames.includes("quarterly-report-and-appendix-merged.pdf"),
    savedNames.join(" | ").slice(0, 260),
  );

  /* ================= C. a cloud result → Workspace, without the bytes ====== */
  section("C", "a server job's output is copied server-to-server, never through the page");
  await goto("/tools/compress-pdf", 3200);
  check("C: the compress tool page renders", /Compress/i.test((await text()) ?? ""));
  check("C: a PDF can be attached", await attachFiles([pdfA]));
  check("C: the compress control is reachable", await clickLabel("^Compress PDF$", "button"));

  /*
   * A real job takes real time, and how long depends on the machine. Polling for
   * the terminal state — rather than sleeping a guessed interval — is what keeps a
   * slow worker from being reported as a broken product.
   */
  let jobText = "";
  for (let waited = 0; waited < 120_000; waited += 2500) {
    await sleep(2500);
    jobText = (await text()) ?? "";
    if (/Your file is ready|can't be processed|didn't work|expired|Cancelled/i.test(jobText)) break;
  }
  const cloudReady = /Your file is ready/i.test(jobText);
  check(
    "C: the compress job completed — the precondition for the save below",
    cloudReady,
    cloudReady ? "" : jobText.slice(0, 220).replace(/\n/g, " | "),
    // Ghostscript is the one binary this machine has; a miss here is far more
    // likely to be a worker or flag problem than a missing dependency, so it stays
    // PRODUCT and says what was on screen.
    "PRODUCT",
  );

  let cloudDocumentId = null;
  if (cloudReady) {
    const cloudControls = (await controls()) ?? [];
    check(
      "C: a cloud result offers the same three actions as a local one",
      cloudControls.some((l) => /^Download$/i.test(l)) &&
        cloudControls.some((l) => /Open in Editor/i.test(l)) &&
        cloudControls.some((l) => /Save to Workspace/i.test(l)),
      cloudControls.join(" / ").slice(0, 260),
    );

    const cloudMark = Date.now();
    check("C: Save to Workspace is pressable", await clickLabel("Save to Workspace", "button"));
    await sleep(7000);
    check(
      "C: the cloud result reports the same success copy as a local one",
      /Saved to your Workspace/i.test((await text()) ?? ""),
      ((await text()) ?? "").slice(0, 200).replace(/\n/g, " | "),
    );
    const cloudHref = await evaluate(
      `(() => { const a = [...document.querySelectorAll('a')].find((n) => /Open document/i.test(n.textContent || "")); return a ? a.getAttribute("href") : null; })()`,
    );
    cloudDocumentId = /\/documents\/([^/?#]+)/.exec(cloudHref ?? "")?.[1] ?? null;
    check("C: the save answered with a canonical document id", !!cloudDocumentId, cloudHref ?? "");

    /*
     * The whole point of the server-to-server route, measured. The save request
     * carries two ids and nothing else, and the browser never pulled the result
     * down to push it back up.
     */
    const saveRequests = bodied(cloudMark).filter((r) => r.url.includes("/save-to-workspace"));
    check(
      "C: the save request carried two ids, not the file",
      saveRequests.length === 1 &&
        saveRequests[0].bodyBytes !== null &&
        saveRequests[0].bodyBytes <= 400,
      saveRequests.map((r) => `${r.bodyBytes ?? "large"}b`).join(",") || "no save request seen",
    );
    check(
      "C: nothing large left the page, and the result was never streamed into it",
      bigBodies(cloudMark).length === 0 &&
        !requests.some((r) => r.at >= cloudMark && r.url.includes("inline=1")),
      describe(bigBodies(cloudMark)),
    );
  }

  /* ================= D. Workspace document → edit → Publish version ======== */
  section("D", "the Workspace editor can publish a version of the document it holds");
  const documentPath = `/workspaces/${encodeURIComponent(workspaceId)}/documents/${encodeURIComponent(
    savedDocumentId ?? "",
  )}?${wsQuery}`;
  const versionsPath = `/api/workspaces/${encodeURIComponent(
    workspaceId,
  )}/documents/${encodeURIComponent(savedDocumentId ?? "")}/versions?${wsQuery}`;

  if (!savedDocumentId) {
    check("D: skipped — journey B produced no document to publish from", false, "", "PROBE");
  } else {
    await goto(documentPath, 9000);
    check(
      "D: the workbench opened the document, at 200",
      statusFor(`/documents/${savedDocumentId}`) === 200 && (await pageCount()) === 3,
      `status ${statusFor(`/documents/${savedDocumentId}`)} pages ${await pageCount()}`,
    );

    /*
     * The document-count baseline for the two "publishing creates no document"
     * assertions, taken HERE — after journey C legitimately added its own
     * document. Reusing journey B's count made journey D fail on C's save, which
     * is a probe reading a real event as a duplicate.
     */
    const documentsPath = `/api/workspaces/${encodeURIComponent(workspaceId)}/documents?${wsQuery}`;
    const publishBaseline = countOf(await api(documentsPath));
    const versionsBefore = await api(versionsPath);
    const numbersOf = (payload) =>
      (payload?.body?.versions ?? []).map((v) => v?.versionNumber).filter((n) => typeof n === "number");
    const beforeVersions = numbersOf(versionsBefore);
    check(
      "D: the document starts with the ONE version its upload cut",
      beforeVersions.length === 1 && beforeVersions[0] === 1,
      `status ${versionsBefore?.status} versions [${beforeVersions.join(",")}]`,
    );

    /* A real edit, through the real gesture: pick the rectangle tool, then drag. */
    const objectsBefore = await countObjects();
    const canvas = await pageRect();
    check("D: the page canvas is on screen to draw on", !!canvas && !canvas.__probeError, JSON.stringify(canvas));
    if (canvas) {
      await key("r", "KeyR", "r");
      await drag(
        canvas.x + Math.round(canvas.w * 0.22),
        canvas.y + Math.round(canvas.h * 0.22),
        canvas.x + Math.round(canvas.w * 0.55),
        canvas.y + Math.round(canvas.h * 0.42),
      );
    }
    const objectsAfter = await countObjects();
    check(
      "D: the edit landed — an object exists that did not before",
      typeof objectsAfter === "number" && objectsAfter > (objectsBefore ?? 0),
      `${objectsBefore} → ${objectsAfter}`,
    );

    /* Defect F: the button the workbench never had. */
    const workbenchControls = (await controls()) ?? [];
    check(
      "D: the Workspace editor offers `Publish version`",
      workbenchControls.some((l) => /Publish version/i.test(l)),
      workbenchControls.join(" / ").slice(0, 260),
    );
    check("D: `Publish version` is pressable", await clickLabel("Publish version", "button"));
    await sleep(9000);

    const publishedStatus = (await saveStatus()) ?? "";
    check(
      "D: the canonical readout names the version it published",
      /saved to your workspace as version 2\b/i.test(publishedStatus),
      publishedStatus.slice(0, 260),
    );
    const versionsAfter = await api(versionsPath);
    const afterVersions = numbersOf(versionsAfter);
    check(
      "D: the server holds a SECOND version of the SAME document",
      afterVersions.length === 2 && afterVersions.includes(2),
      `versions [${afterVersions.join(",")}]`,
    );
    const v2 = (versionsAfter?.body?.versions ?? []).find((v) => v?.versionNumber === 2) ?? null;
    check(
      "D: the published version carries the editor scene AND the output AND the source",
      v2?.hasEditorState === true && v2?.hasOutput === true && !!v2?.sourceChecksum,
      JSON.stringify({
        scene: v2?.hasEditorState,
        output: v2?.hasOutput,
        source: !!v2?.sourceChecksum,
        pages: v2?.pageCount,
      }),
    );
    const documentsNow = await api(documentsPath);
    check(
      "D: publishing created NO second Workspace document",
      publishBaseline !== null && countOf(documentsNow) === publishBaseline,
      `${publishBaseline} → ${countOf(documentsNow)}`,
    );

    /* ============== E. the own-write conflict regression ================== */
    section("E", "publishing your own version does not become a conflict on the next edit");
    const canvas2 = await pageRect();
    if (canvas2) {
      await key("r", "KeyR", "r");
      await drag(
        canvas2.x + Math.round(canvas2.w * 0.22),
        canvas2.y + Math.round(canvas2.h * 0.6),
        canvas2.x + Math.round(canvas2.w * 0.55),
        canvas2.y + Math.round(canvas2.h * 0.8),
      );
    }
    const objectsE = await countObjects();
    check(
      "E: a further edit exists AFTER the publish — the write this journey watches",
      typeof objectsE === "number" && objectsE > (objectsAfter ?? 0),
      `${objectsAfter} → ${objectsE}`,
    );
    // The full debounce and ceiling, so the autosave genuinely reached the server
    // with the revision the publish left behind.
    await sleep(AUTOSAVE_GRACE_MS);
    const afterEdit = (await saveStatus()) ?? "";
    const bodyAfterEdit = (await text()) ?? "";
    check(
      "E: the edit was accepted, not refused — the write happened",
      /as a draft|as version/i.test(afterEdit),
      afterEdit.slice(0, 260),
    );
    check(
      "E: NO conflict was raised by the version this same session published",
      !/This document changed somewhere else/i.test(bodyAfterEdit) &&
        !/Conflict detected/i.test(afterEdit) &&
        !/\bconflict\b/i.test(bodyAfterEdit),
      [afterEdit, bodyAfterEdit].join(" ~ ").slice(0, 300),
    );
    const versionsAfterEdit = await api(versionsPath);
    check(
      "E: the autosaved draft did NOT become a third version",
      numbersOf(versionsAfterEdit).length === 2,
      `versions [${numbersOf(versionsAfterEdit).join(",")}]`,
    );

    /* A second publish, to prove version 3 lands on the same document. */
    check("E: `Publish version` is pressable again", await clickLabel("Publish version", "button"));
    await sleep(9000);
    const versionsThird = await api(versionsPath);
    check(
      "E: a repeat publish adds version 3 to the SAME document",
      numbersOf(versionsThird).length === 3 && numbersOf(versionsThird).includes(3),
      `versions [${numbersOf(versionsThird).join(",")}]`,
    );
    const documentsAfterThird = await api(documentsPath);
    check(
      "E: three versions, still one document",
      publishBaseline !== null && countOf(documentsAfterThird) === publishBaseline,
      `${publishBaseline} → ${countOf(documentsAfterThird)}`,
    );
  }

  /* ================= F. Opened and Recent mean something =================== */
  section("F", "an intentional open is recorded, and nothing else pretends to be one");
  const recent = await api(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/documents?view=recent&${wsQuery}`,
  );
  const recentIds = (recent?.body?.items ?? recent?.body?.documents ?? []).map((d) => d?.id);
  check(
    "F: the document opened in the workbench appears in Recent",
    savedDocumentId !== null && recentIds.includes(savedDocumentId),
    `recent [${recentIds.join(",")}] looking for ${savedDocumentId}`,
  );
  /*
   * The other half, and the one that makes the first half mean anything: a
   * document this run SAVED but never OPENED is absent. Saving from a tool result
   * is not an open, and neither is the metadata read the dashboard did when it
   * listed it.
   */
  check(
    "F: a document that was saved but never opened is NOT in Recent",
    cloudDocumentId === null || !recentIds.includes(cloudDocumentId),
    cloudDocumentId === null
      ? "no cloud document this run — journey C did not complete"
      : `recent [${recentIds.join(",")}] must not contain ${cloudDocumentId}`,
    cloudDocumentId === null ? "ENVIRONMENTAL" : "PRODUCT",
  );

  await goto(`/workspaces/${encodeURIComponent(workspaceId)}?${wsQuery}`, 6000);
  const openedCells = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('tbody tr')];
    return rows.map((tr) => [...tr.querySelectorAll('td')].map((td) => (td.textContent || '').trim()));
  })()`);
  const rowFor = (name) => (openedCells ?? []).find((cells) => cells.some((c) => c === name)) ?? null;
  const publishedRow = rowFor("quarterly-report-and-appendix-merged.pdf");
  check(
    "F: the file manager's `Opened` cell is a real time for the opened document, not `—`",
    !!publishedRow && publishedRow[4] !== "—" && publishedRow[4] !== "",
    publishedRow ? publishedRow.join(" | ") : "no row for the published document",
  );
  const neverOpened = (openedCells ?? []).filter(
    (cells) => cells[1] !== "quarterly-report-and-appendix-merged.pdf" && cells[4] === "—",
  );
  check(
    "F: `—` still means never opened — the column reports, it does not decorate",
    !publishedRow || publishedRow[4] !== "—",
    `${neverOpened.length} row(s) still read —, which is correct for documents nobody opened`,
  );

  const versionsAfterOpen = await api(versionsPath);
  check(
    "F: opening a document created NO version",
    ((versionsAfterOpen?.body?.versions ?? []).length || 0) === 3,
    `versions ${(versionsAfterOpen?.body?.versions ?? []).length}`,
  );

  /* ================= G. Activity says what happened ======================== */
  section("G", "the activity feed names the document, the version and the tool");
  const dashboard = (await text()) ?? "";
  const activityBlock = await evaluate(`(() => {
    const card = [...document.querySelectorAll('section')].find((s) =>
      /Activity/.test(((s.querySelector('h2, h3, p, span') || {}).textContent) || ''),
    );
    const lists = [...document.querySelectorAll('ul')].filter((u) => /published|saved|uploaded|created|renamed|moved/i.test(u.textContent || ''));
    const node = card || lists[0] || null;
    return node ? (node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 1200) : null;
  })()`);
  check(
    "G: an activity feed rendered with entries in it",
    typeof activityBlock === "string" && activityBlock.length > 0,
    (activityBlock ?? "").slice(0, 200),
  );
  const activityText = `${activityBlock ?? ""} ${dashboard}`;
  check(
    "G: a published version is named, with its number and its document",
    /published version 3 of quarterly-report-and-appendix-merged\.pdf/i.test(activityText),
    (activityBlock ?? "").slice(0, 320),
  );
  check(
    "G: NOTHING reads `uploaded an item` — the recorded defect's exact words",
    !/uploaded an item/i.test(activityText) && !/\ban item\b/i.test(activityText),
    (activityBlock ?? "").slice(0, 320),
  );
  check(
    "G: a tool-sourced save says which tool it came from",
    cloudDocumentId === null || /from Compress PDF to this Workspace/i.test(activityText),
    cloudDocumentId === null
      ? "journey C did not complete, so no tool-sourced entry exists to name"
      : (activityBlock ?? "").slice(0, 320),
    cloudDocumentId === null ? "ENVIRONMENTAL" : "PRODUCT",
  );
  check(
    "G: no document CONTENT reached the activity feed",
    !/Alpha page|Beta page|workflow completeness probe/i.test(activityText),
    (activityBlock ?? "").slice(0, 200),
  );


  /*
   * ============ the page hook, installed HERE and deliberately not earlier ====
   *
   * Journeys A–I above must run against an unpatched page. Every privacy and
   * transport assertion up to this point is a claim about what the PRODUCT did,
   * and a probe that had been rewriting responses all along would be measuring
   * itself. So the hook lands now, for the four journeys that need it, and
   * `__probeHooked` stops a re-navigation from stacking a second copy.
   *
   * It does exactly two things.
   *
   * Passively, it records the SHA-256 of the `file` part of every upload the page
   * makes. That is the only place the bytes the browser PRODUCED can be compared
   * with the bytes the Workspace STORED (journey L): once the request is gone the
   * result blob is gone with it, and reading the part back with `arrayBuffer()`
   * does not consume it.
   *
   * And, only while `sessionStorage.__probeMime` is armed, it rewrites the
   * reported `outputMimeType` of a COMPLETED job as it arrives — which is how
   * journey I′ reaches the non-PDF result this machine's missing binaries cannot
   * produce. That is a same-origin API response edited in the browser, exactly
   * what an intercepting proxy does: no product code, no product flag, no
   * test-mode route, no new system package. It is disarmed again at the end of I′.
   */
  const PAGE_HOOK = `
(() => {
  if (window.__probeHooked) return;
  window.__probeHooked = true;
  window.__probeUploads = [];
  window.__probeRewrites = 0;
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const armed = () => {
    try { return sessionStorage.getItem("__probeMime") !== null; } catch { return false; }
  };
  /** Retypes a COMPLETED job frame in place; null when there is nothing to retype. */
  const retype = (payload) => {
    if (!payload || typeof payload !== "object") return null;
    const job = payload.job && typeof payload.job === "object" ? payload.job : payload;
    if (job.status !== "completed" || job.resultAvailable !== true) return null;
    if (job.outputMimeType === "image/jpeg") return null;
    job.outputMimeType = "image/jpeg";
    job.outputFileName =
      String(job.outputFileName || "result.pdf").replace(/\\.[a-z0-9]+$/i, "") + ".jpg";
    window.__probeRewrites += 1;
    return payload;
  };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(typeof input === "string" ? input : (input && input.url) || "");
    if (init && init.body instanceof FormData && url.indexOf("/documents/upload") >= 0) {
      const part = init.body.get("file");
      if (part && typeof part.arrayBuffer === "function") {
        const bytes = await part.arrayBuffer();
        window.__probeUploads.push({
          url,
          name: part.name || null,
          size: bytes.byteLength,
          sha: hex(await crypto.subtle.digest("SHA-256", bytes)),
        });
      }
    }
    const res = await nativeFetch(input, init);
    if (armed() && /\\/api\\/jobs\\/[^/?#]+(\\?|$)/.test(url)) {
      const retyped = retype(await res.clone().json().catch(() => null));
      if (retyped) {
        const headers = new Headers(res.headers);
        headers.delete("content-length");
        return new Response(JSON.stringify(retyped), {
          status: res.status,
          statusText: res.statusText,
          headers,
        });
      }
    }
    return res;
  };
  /*
   * The job's terminal frame arrives over SSE, and \`useProcessingJob\` assigns
   * \`es.onmessage\` as an instance property — so the interception has to be an
   * accessor on the PROTOTYPE, wrapping whatever handler the hook's caller sets.
   */
  const slot = Object.getOwnPropertyDescriptor(EventSource.prototype, "onmessage");
  if (slot && slot.set) {
    Object.defineProperty(EventSource.prototype, "onmessage", {
      configurable: true,
      enumerable: true,
      get() { return slot.get.call(this); },
      set(handler) {
        if (typeof handler !== "function") { slot.set.call(this, handler); return; }
        const source = this;
        slot.set.call(this, (event) => {
          if (!armed()) return handler.call(source, event);
          let frame = null;
          try { frame = JSON.parse(event.data); } catch { return handler.call(source, event); }
          if (!retype(frame)) return handler.call(source, event);
          return handler.call(
            source,
            new MessageEvent("message", {
              data: JSON.stringify(frame),
              origin: event.origin,
              lastEventId: event.lastEventId,
            }),
          );
        });
      },
    });
  }
})();
`;
  await send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HOOK });
  const listOf = (payload) =>
    Array.isArray(payload?.body?.documents)
      ? payload.body.documents
      : Array.isArray(payload?.body?.items)
        ? payload.body.items
        : [];
  const versionNumbersOf = (payload) =>
    (payload?.body?.versions ?? []).map((v) => v?.versionNumber).filter((n) => typeof n === "number");

  /* ================= J. more than one destination: the user chooses ========= */
  section("J", "a member of several Workspaces chooses where the result goes");

  /*
   * A second Workspace, created through the product's own route, so the actor
   * really is a member of two and the destination question is real rather than
   * simulated. Everything after this point is the choice the recorded defect
   * removed: before Phase 5's closeout, a save went wherever `resolveSaveTarget`
   * decided and the user found out afterwards.
   */
  const secondName = `Probe Destination ${stamp}`;
  const createdWorkspace = await evaluate(
    `fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId: ${JSON.stringify(organizationId)},
        name: ${JSON.stringify(secondName)},
      }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
      .catch((e) => ({ status: 0, body: String(e) }))`,
  );
  const secondWorkspaceId = createdWorkspace?.body?.workspace?.id ?? null;
  check(
    "J: a second Workspace exists, so the destination question is a real one",
    createdWorkspace?.status === 201 && typeof secondWorkspaceId === "string",
    `POST /api/workspaces → ${createdWorkspace?.status} ${secondWorkspaceId ?? ""}`,
  );

  const saveTarget = await api("/api/workflow/save-target");
  const offered = Array.isArray(saveTarget?.body?.destinations) ? saveTarget.body.destinations : [];
  const offeredIds = offered.map((d) => d?.workspaceId);
  check(
    "J: the server offers BOTH authorized Workspaces, and states the actor's auth",
    saveTarget?.status === 200 &&
      saveTarget.body?.authenticated === true &&
      offeredIds.includes(workspaceId) &&
      offeredIds.includes(secondWorkspaceId),
    `authenticated=${saveTarget?.body?.authenticated} destinations=[${offeredIds.join(",")}]`,
  );
  check(
    "J: a default is NAMED, not applied — identifying one is not choosing it",
    saveTarget?.body?.defaultWorkspaceId === workspaceId,
    `defaultWorkspaceId=${saveTarget?.body?.defaultWorkspaceId} provisioned=${workspaceId}`,
  );
  check(
    "J: each destination is an id and a display name, with no internals attached",
    offered.length > 1 &&
      offered.every(
        (d) =>
          typeof d?.workspaceId === "string" &&
          typeof d?.organizationId === "string" &&
          typeof d?.workspaceName === "string" &&
          d.workspaceName.length > 0 &&
          Object.keys(d).length === 3,
      ),
    JSON.stringify(offered).slice(0, 260),
  );

  const defaultBefore = countOf(
    await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/documents?${wsQuery}`),
  );

  /*
   * A merge in the REVERSED order, so its bytes are necessarily not journey B's.
   * Journey K then asserts "the same bytes in a different Workspace is a
   * legitimate second document", which is only a real assertion if the bytes were
   * new to that Workspace.
   */
  await goto("/tools/merge-pdf", 3400);
  check("J: two files attach to the merge tool", await attachFiles([pdfB, pdfA]));
  check("J: the merge control is reachable", await clickLabel("^Merge PDFs$", "button"));
  await sleep(5200);
  const jControls = (await controls()) ?? [];
  check(
    "J: the merge produced a result that offers Save to Workspace",
    jControls.some((c) => /Save to Workspace/i.test(c)),
    jControls.join(" / ").slice(0, 240),
  );

  /**
   * The destination control, as a screen reader would resolve it: the native
   * element, the label that POINTS AT it by id, its options and its current value.
   * A `<div role="listbox">` with a floating caption would fail the first two.
   */
  const chooserOf = () =>
    evaluate(`(() => {
      const select = document.querySelector("main select") || document.querySelector("select");
      if (!select) return null;
      const label = select.id ? document.querySelector('label[for="' + select.id + '"]') : null;
      const save = [...document.querySelectorAll("button")].find((b) =>
        /Save to Workspace/i.test(b.textContent || ""),
      );
      return {
        tag: select.tagName,
        labelled: label ? (label.textContent || "").trim() : null,
        value: select.value,
        options: [...select.options].map((o) => ({
          value: o.value,
          label: (o.textContent || "").trim(),
        })),
        saveDisabled: save ? save.disabled : null,
      };
    })()`);
  const chooser = await chooserOf();
  check(
    "J: a labelled native selector renders, one option per authorized destination",
    chooser?.tag === "SELECT" &&
      typeof chooser?.labelled === "string" &&
      /Workspace/i.test(chooser.labelled) &&
      chooser.options.length === offered.length + 1,
    JSON.stringify(chooser).slice(0, 300),
  );
  check(
    "J: nothing is pre-chosen, and Save cannot be pressed until it is",
    chooser?.value === "" && chooser?.options?.[0]?.value === "" && chooser?.saveDisabled === true,
    JSON.stringify(chooser ?? {}).slice(0, 300),
  );
  check(
    "J: the default is MARKED in the list, so the choice is informed and not blind",
    (chooser?.options ?? []).filter((o) => /\(default\)$/.test(o.label)).length === 1 &&
      (chooser?.options ?? []).find((o) => /\(default\)$/.test(o.label))?.value === workspaceId,
    JSON.stringify(chooser?.options ?? []).slice(0, 300),
  );

  // The NON-default one, on purpose: if the save lands in the default anyway, the
  // selector is decoration and this journey is the only place that would notice.
  const chosenWorkspaceId = offeredIds.find((wsid) => wsid && wsid !== workspaceId) ?? null;
  const picked = await evaluate(`(() => {
    const select = document.querySelector("main select") || document.querySelector("select");
    if (!select) return "missing";
    select.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(select, ${JSON.stringify(chosenWorkspaceId)});
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return document.activeElement === select ? "focused" : "changed";
  })()`);
  await sleep(500);
  const afterPick = await chooserOf();
  check(
    "J: the selector takes keyboard focus, and choosing is what enables Save",
    picked === "focused" &&
      afterPick?.value === chosenWorkspaceId &&
      afterPick?.saveDisabled === false,
    `focus=${picked} value=${afterPick?.value} saveDisabled=${afterPick?.saveDisabled}`,
  );

  check("J: Save to Workspace is pressable once a destination is chosen", await clickLabel("^Save to Workspace$", "button"));
  await sleep(9000);
  const jSaved = await evaluate(`(() => {
    const link = [...document.querySelectorAll('a[href*="/documents/"]')].find((n) =>
      /Open document/i.test(n.textContent || ""),
    );
    return {
      href: link ? link.getAttribute("href") : null,
      body: (document.body.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 400),
    };
  })()`);
  const jHref = jSaved?.href ?? "";
  const jHostWorkspaceId = /\/workspaces\/([^/?#]+)\/documents\//.exec(jHref)?.[1] ?? null;
  const jDocumentId = /\/documents\/([^/?#]+)/.exec(jHref)?.[1] ?? null;
  check(
    "J: the result saved, and the confirmation links to the document it created",
    /Saved to your Workspace/i.test(jSaved?.body ?? "") && !!jDocumentId,
    jHref || (jSaved?.body ?? "").slice(0, 200),
  );
  check(
    "J: it landed in the Workspace the user CHOSE, not in the default one",
    jHostWorkspaceId === chosenWorkspaceId && chosenWorkspaceId !== workspaceId,
    `chose ${chosenWorkspaceId}, document is in ${jHostWorkspaceId} (default ${workspaceId})`,
  );
  check(
    "J: the default Workspace gained nothing — no save-there-then-move-it",
    defaultBefore !== null &&
      countOf(await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/documents?${wsQuery}`)) ===
        defaultBefore,
    `default workspace document count started at ${defaultBefore}`,
  );
  /*
   * Captured by the hook while the request was in flight. Read into Node NOW: the
   * page's copy dies at the next navigation, and journey L has nothing to compare
   * against without it.
   */
  const uploadsSeen = (await evaluate(`window.__probeUploads || []`)) ?? [];
  const producedUpload = Array.isArray(uploadsSeen)
    ? (uploadsSeen.filter((u) => typeof u?.sha === "string").at(-1) ?? null)
    : null;
  check(
    "J: the bytes this browser uploaded were captured, so fidelity is checkable",
    !!producedUpload && producedUpload.size > 1_000,
    producedUpload
      ? `${producedUpload.name} ${producedUpload.size}b sha ${producedUpload.sha.slice(0, 16)}…`
      : "nothing recorded",
    "PROBE",
  );

  /* ================= K. one save intention, one document ==================== */
  section("K", "a lost response and a retry produce the SAME document, not a second");
  const jVersionsPath = `/api/workspaces/${encodeURIComponent(
    chosenWorkspaceId ?? "",
  )}/documents/${encodeURIComponent(jDocumentId ?? "")}/versions?${wsQuery}`;
  const jContentPath = `/api/workspaces/${encodeURIComponent(
    chosenWorkspaceId ?? "",
  )}/documents/${encodeURIComponent(jDocumentId ?? "")}/content?${wsQuery}&artifact=source`;
  const jDocumentsPath = `/api/workspaces/${encodeURIComponent(
    chosenWorkspaceId ?? "",
  )}/documents?${wsQuery}`;

  if (!jDocumentId || !chosenWorkspaceId) {
    check("K: skipped — journey J produced no saved document to retry against", false, "", "PROBE");
    check("L: skipped — journey J produced no saved document to read back", false, "", "PROBE");
  } else {
    // First-save ingestion is asynchronous — the bounded debt Phase 5 recorded, not
    // a defect — so version 1 is polled for rather than assumed.
    let firstVersions = [];
    for (let attempt = 0; attempt < 14; attempt += 1) {
      firstVersions = versionNumbersOf(await api(jVersionsPath));
      if (firstVersions.length >= 1) break;
      await sleep(1500);
    }
    check(
      "K: the saved document holds exactly ONE initial version",
      firstVersions.length === 1 && firstVersions[0] === 1,
      `versions [${firstVersions.join(",")}]`,
    );
    const jDocumentName = listOf(await api(jDocumentsPath))[0]?.name ?? null;

    /*
     * The retry, from a page that has never held the result.
     *
     * This is what makes it a real retry rather than a second click: a fresh
     * navigation is a fresh JS context, so there is no React state, no `saveState`,
     * no result blob and no client guard left anywhere. The bytes come back out of
     * the Workspace through the content route and go straight back in — which is
     * exactly the shape of "the commit succeeded and the response was lost".
     */
    await goto(`/workspaces/${encodeURIComponent(chosenWorkspaceId)}?${wsQuery}`, 4200);
    const grabbed = await evaluate(`(async () => {
      const res = await fetch(${JSON.stringify(jContentPath)});
      if (!res.ok) return { status: res.status };
      const buf = await res.arrayBuffer();
      const view = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
      const digest = await crypto.subtle.digest("SHA-256", buf);
      window.__probeStored = {
        base64: btoa(binary),
        size: view.length,
        sha: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""),
      };
      return { status: res.status, size: view.length, sha: window.__probeStored.sha };
    })()`);
    check(
      "K: the stored document reads back through the content route",
      grabbed?.status === 200 && grabbed.size > 1_000,
      `status ${grabbed?.status} size ${grabbed?.size}`,
    );
    const storedBase64 = await evaluate(`window.__probeStored ? window.__probeStored.base64 : null`);

    const reupload = (wsid, fileName) =>
      evaluate(`(async () => {
        const stored = window.__probeStored;
        if (!stored) return { status: 0, body: "no stored bytes in this page" };
        const raw = atob(stored.base64);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
        const form = new FormData();
        form.append("file", new Blob([bytes], { type: "application/pdf" }), ${JSON.stringify(fileName)});
        form.append("name", ${JSON.stringify(fileName)});
        form.append("organizationId", ${JSON.stringify(organizationId)});
        const res = await fetch(
          "/api/workspaces/" + encodeURIComponent(${JSON.stringify(wsid)}) + "/documents/upload",
          { method: "POST", body: form },
        );
        return { status: res.status, body: await res.json().catch(() => null) };
      })()`);

    // A DIFFERENT filename on purpose: if the name were the identity, this would
    // create a second document and the retry story would be a coincidence.
    const retryOnce = await reupload(chosenWorkspaceId, `retry-${stamp}.pdf`);
    check(
      "K: same bytes, same destination, a DIFFERENT name → the same document id",
      retryOnce?.status === 200 &&
        retryOnce.body?.deduplicated === true &&
        retryOnce.body?.document?.id === jDocumentId,
      `→ ${retryOnce?.status} deduplicated=${retryOnce?.body?.deduplicated} id=${retryOnce?.body?.document?.id} (saved ${jDocumentId})`,
    );
    const retryTwice = await reupload(chosenWorkspaceId, `retry-again-${stamp}.pdf`);
    check(
      "K: and again — the identity is the CONTENT, not the name and not the request",
      retryTwice?.status === 200 && retryTwice.body?.document?.id === jDocumentId,
      `→ ${retryTwice?.status} id=${retryTwice?.body?.document?.id}`,
    );
    check(
      "K: two retries added no second document to the chosen Workspace",
      countOf(await api(jDocumentsPath)) === 1,
      `${countOf(await api(jDocumentsPath))} document(s) present`,
    );
    check(
      "K: and cut no second initial version",
      versionNumbersOf(await api(jVersionsPath)).length === 1,
      `versions [${versionNumbersOf(await api(jVersionsPath)).join(",")}]`,
    );

    // Legitimate duplication is NOT collapsed: the same source in a different
    // Workspace is a different document, and a global content ban would break it.
    const elsewhere = await reupload(workspaceId, `also-here-${stamp}.pdf`);
    check(
      "K: the SAME bytes in another Workspace are a NEW document — dedup is not a global ban",
      elsewhere?.status === 201 &&
        typeof elsewhere.body?.document?.id === "string" &&
        elsewhere.body.document.id !== jDocumentId,
      `→ ${elsewhere?.status} id=${elsewhere?.body?.document?.id}`,
    );

    /*
     * A Workspace id the selector never offered, sent WITH a real file part —
     * because membership is checked after the multipart parse, and a bodiless probe
     * would be refused by the parser and prove nothing about authorization.
     */
    const fabricated = await reupload("ws_probe_not_a_real_workspace", `nowhere-${stamp}.pdf`);
    check(
      "K: a fabricated destination is refused even though the actor is signed in",
      fabricated?.status === 404 || fabricated?.status === 403,
      `→ ${fabricated?.status} ${JSON.stringify(fabricated?.body ?? "").slice(0, 160)}`,
    );
    check(
      "K: and the refusal created nothing anywhere",
      countOf(await api(jDocumentsPath)) === 1,
      `${countOf(await api(jDocumentsPath))} document(s) in the chosen Workspace`,
    );

    /*
     * ONE meaningful activity event for the whole intention. Counted as list items
     * inside the feed rather than as substring occurrences: a feed that renders the
     * name twice in one entry would make a substring count lie in both directions.
     */
    await goto(`/workspaces/${encodeURIComponent(chosenWorkspaceId)}?${wsQuery}`, 6500);
    const jActivity =
      jDocumentName === null
        ? null
        : await evaluate(`(() => {
            const list = [...document.querySelectorAll('ul')].find((u) =>
              /published|saved|uploaded|created/i.test(u.textContent || ''),
            );
            if (!list) return null;
            return [...list.children]
              .map((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim())
              .filter((t) => t.indexOf(${JSON.stringify(jDocumentName ?? "")}) >= 0);
          })()`);
    check(
      "K: the save and its two retries produced ONE activity entry, not three",
      Array.isArray(jActivity) && jActivity.length === 1,
      Array.isArray(jActivity)
        ? `${jActivity.length} entr(ies): ${jActivity.join(" || ").slice(0, 220)}`
        : `activity feed not found for ${jDocumentName}`,
      Array.isArray(jActivity) ? "PRODUCT" : "PROBE",
    );

    /* ================= L. the stored bytes ARE the produced bytes =========== */
    section("L", "what the Workspace holds is what the tool made — parsed, not counted");
    check(
      "L: the stored object is byte-identical to what this browser uploaded",
      !!producedUpload &&
        typeof grabbed?.sha === "string" &&
        grabbed.sha === producedUpload.sha &&
        grabbed.size === producedUpload.size,
      `stored ${String(grabbed?.sha).slice(0, 16)}… ${grabbed?.size}b vs uploaded ${String(
        producedUpload?.sha,
      ).slice(0, 16)}… ${producedUpload?.size}b`,
    );
    let storedShape = null;
    if (typeof storedBase64 === "string") {
      try {
        const reparsed = await PDFDocument.load(Buffer.from(storedBase64, "base64"));
        storedShape = {
          pages: reparsed.getPageCount(),
          widths: [...new Set(reparsed.getPages().map((p) => Math.round(p.getWidth())))],
        };
      } catch (error) {
        storedShape = { error: String(error).slice(0, 160) };
      }
    }
    check(
      "L: and it REPARSES as the merge itself — three pages of the two inputs",
      storedShape?.pages === 3 && JSON.stringify(storedShape?.widths) === "[612]",
      JSON.stringify(storedShape),
    );
    const shaOf = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
    const shaA = shaOf(pdfA);
    const shaB = shaOf(pdfB);
    check(
      "L: it is NEITHER input — no first-selected file, no stale handoff buffer",
      typeof grabbed?.sha === "string" && grabbed.sha !== shaA && grabbed.sha !== shaB,
      `stored ${String(grabbed?.sha).slice(0, 12)}… inputs ${shaA.slice(0, 12)}… / ${shaB.slice(0, 12)}…`,
    );
    check(
      "L: and the document carries the name the tool produced, not a placeholder",
      typeof jDocumentName === "string" && /\.pdf$/i.test(jDocumentName) && !/untitled/i.test(jDocumentName),
      String(jDocumentName),
    );
  }

  /* ================= M. two sessions, one document, a REAL conflict ========= */
  section("M", "a genuinely stale second session is refused, and told the truth");
  /*
   * Journey E proves the conflict that must NOT happen. This is the one that MUST:
   * two sessions holding the same document at the same revision, one of them
   * publishing, and the other discovering it the only honest way — by being
   * refused. Nothing in product code knows this journey exists; the compare-and-
   * swap it trips is the same one every real second tab trips.
   */
  if (!savedDocumentId) {
    check("M: skipped — journey B produced no document to contend over", false, "", "PROBE");
  } else {
    let second = null;
    try {
      second = await browserSession(DEBUG_PORT + 1, BASE);
    } catch (error) {
      check(
        "M: a second isolated browser session could be started",
        false,
        String(error).slice(0, 220),
        "ENVIRONMENTAL",
      );
    }
    if (second) {
      await second.goto("/login", 3800);
      await second.setField("email", email);
      await second.setField("password", PASSWORD);
      await second.clickLabel("^Sign in$", "button");
      await sleep(7000);
      check(
        "M: the second session signed in as the same user, on its own cookie jar",
        /\/workspaces/.test((await second.url()) ?? ""),
        (await second.url()) ?? "",
      );

      // B opens FIRST, at whatever revision the server currently holds. Everything
      // after this makes B stale WITHOUT telling B.
      await second.goto(documentPath, 12000);
      const secondPages = await second.pageCount();
      check(
        "M: the second session holds the document open at the current revision",
        secondPages === 3,
        `pages ${secondPages}`,
      );

      /*
       * A: a real edit and a real publish, which is what moves the revision.
       *
       * Unlike journeys D and E, this gesture lands on a COLD editor — the
       * navigation above reloaded it — and with a SECOND browser now rendering the
       * same document on the same machine, the first paint can take considerably
       * longer than any fixed wait. So the page is polled for rather than assumed,
       * and the drag gets a second region if the first produced nothing. The rect
       * is reported either way, because "no canvas" and "the drag did not register"
       * are different failures and a bare count cannot tell them apart.
       */
      await goto(documentPath, 9000);
      const liveRect = async () => {
        const rect = await pageRect();
        return rect && !rect.__probeError ? rect : null;
      };
      const waitForCanvas = async () => {
        let rect = null;
        for (let waited = 0; waited < 30_000 && !rect; waited += 1500) {
          rect = await liveRect();
          if (!rect) await sleep(1500);
        }
        return rect;
      };
      let canvasA = await waitForCanvas();

      /*
       * Journey E left an autosaved draft on this device, so this reload correctly
       * offers to recover it. That prompt is real product behaviour and a modal over
       * the canvas — the probe has to ANSWER it, not treat it as a defect. It is
       * answered the way this journey needs: A takes the SAVED version, so both
       * sessions genuinely start from the same revision and the conflict below is
       * about A's new publish rather than about a draft A was already carrying.
       */
      const recoveryText = await evaluate(`(() => {
        const box = document.querySelector('[role="alertdialog"], [role="dialog"]');
        const body = box ? (box.textContent || '').replace(/\\s+/g, ' ').trim() : '';
        return /Unsaved changes found/i.test(body) ? body.slice(0, 140) : null;
      })()`);
      let recoveryAnswered = true;
      if (recoveryText) {
        recoveryAnswered =
          (await clickLabel("Open the saved version", "button")) ||
          (await clickLabel("Restore my changes", "button"));
        await sleep(3500);
        canvasA = await waitForCanvas();
      }
      check(
        "M: any draft-recovery prompt is answered first — a modal is not a missing canvas",
        recoveryAnswered === true,
        recoveryText ? `answered: ${recoveryText}` : "no draft prompt on this load",
        "PROBE",
      );
      /*
       * What is actually under the point the drag starts from, and what the toolbar
       * says is active. A drag that lands on an overlay and a shape tool that never
       * armed are different failures, and the object count alone reads the same for
       * both — so the failure detail carries the answer instead of needing a rerun.
       */
      const gestureState = (rect, fx, fy) =>
        evaluate(`(() => {
          const at = document.elementFromPoint(${rect.x} + Math.round(${rect.w} * ${fx}), ${rect.y} + Math.round(${rect.h} * ${fy}));
          return {
            atPoint: at ? at.tagName + '.' + String(at.getAttribute('class') || '').split(' ')[0] : null,
            armed: [...document.querySelectorAll('[aria-label]')]
              .map((n) => n.getAttribute('aria-label'))
              .filter((l) => /active|current:/i.test(l || '')).slice(0, 4),
            overlays: [...document.querySelectorAll('[role="alert"],[role="alertdialog"],[role="dialog"]')]
              .map((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60)),
          };
        })()`);

      const objectsBeforeA = await countObjects();
      let objectsAfterA = objectsBeforeA;
      let gesture = null;
      /*
       * Two ways to arm the rectangle: the keyboard shortcut journeys D and E use,
       * and the toolbar button. The shortcut is the real gesture and is tried first;
       * the button is the fallback for a page that has been navigated through six
       * other journeys and may not have the key handler focused.
       */
      for (const [fx, fy, tx, ty, arm] of [
        [0.3, 0.3, 0.62, 0.5, "key"],
        [0.24, 0.62, 0.58, 0.82, "toolbar"],
      ]) {
        if (!canvasA) break;
        gesture = await gestureState(canvasA, fx, fy);
        if (arm === "key") await key("r", "KeyR", "r");
        else await clickLabel("Add Shape", "button");
        await drag(
          canvasA.x + Math.round(canvasA.w * fx),
          canvasA.y + Math.round(canvasA.h * fy),
          canvasA.x + Math.round(canvasA.w * tx),
          canvasA.y + Math.round(canvasA.h * ty),
        );
        await sleep(1400);
        objectsAfterA = await countObjects();
        if (typeof objectsAfterA === "number" && objectsAfterA > (objectsBeforeA ?? 0)) break;
        canvasA = await liveRect();
      }
      check(
        "M: the first session made an edit worth publishing",
        typeof objectsAfterA === "number" && objectsAfterA > (objectsBeforeA ?? 0),
        `${objectsBeforeA} → ${objectsAfterA} on canvas ${JSON.stringify(canvasA)} ${JSON.stringify(gesture)}`,
      );
      check("M: the first session can publish", await clickLabel("Publish version", "button"));
      await sleep(9500);
      const versionsAfterA = versionNumbersOf(await api(versionsPath));
      check(
        "M: the first session's publish landed as version 4 of the same document",
        versionsAfterA.includes(4) && versionsAfterA.length === 4,
        `versions [${versionsAfterA.join(",")}]`,
      );
      check(
        "M: and the FIRST session saw no conflict — it adopted its own write",
        !/This document changed somewhere else/i.test((await text()) ?? ""),
        ((await text()) ?? "").slice(0, 200).replace(/\n/g, " | "),
      );

      // B is now stale, and does not know it. Its next write is the real race.
      const docsBeforeRace = countOf(
        await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/documents?${wsQuery}`),
      );
      const canvasB = await second.pageRect();
      const objectsBeforeB = await second.countObjects();
      if (canvasB) {
        await second.key("r", "KeyR", "r");
        await second.drag(
          canvasB.x + Math.round(canvasB.w * 0.28),
          canvasB.y + Math.round(canvasB.h * 0.62),
          canvasB.x + Math.round(canvasB.w * 0.6),
          canvasB.y + Math.round(canvasB.h * 0.82),
        );
      }
      const objectsAfterB = await second.countObjects();
      check(
        "M: the stale session made an edit of its own",
        typeof objectsAfterB === "number" && objectsAfterB > (objectsBeforeB ?? 0),
        `${objectsBeforeB} → ${objectsAfterB}`,
      );
      await sleep(AUTOSAVE_GRACE_MS + 3500);
      let staleBody = (await second.text()) ?? "";
      if (!/This document changed somewhere else/i.test(staleBody)) {
        // The autosave is the usual trigger, but it is debounced; the explicit
        // publish is the SAME compare-and-swap against the SAME stale revision, so
        // reaching for it changes nothing about what is being proved.
        await second.clickLabel("Publish version", "button");
        await sleep(9500);
        staleBody = (await second.text()) ?? "";
      }
      check(
        "M: the stale session is told the document changed somewhere else",
        /This document changed somewhere else/i.test(staleBody),
        staleBody.slice(0, 260).replace(/\n/g, " | "),
      );

      const dialog = await second.evaluate(`(() => {
        const node = document.querySelector('[role="alertdialog"]');
        if (!node) return null;
        return {
          modal: node.getAttribute("aria-modal"),
          headline: (node.querySelector("h2")?.textContent || "").trim(),
          text: (node.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 1400),
          revisions: [...node.querySelectorAll("dd")].map((n) =>
            (n.textContent || "").replace(/\\s+/g, " ").trim(),
          ),
          actions: [...node.querySelectorAll("li")].map((li) => ({
            label: (li.querySelector("p")?.textContent || "").trim(),
            button: (li.querySelector("button")?.textContent || "").trim(),
          })),
        };
      })()`);
      check(
        "M: the existing Phase 2 Conflict dialog is what appeared, as a modal alert",
        dialog?.modal === "true" && dialog?.headline === "This document changed somewhere else",
        JSON.stringify({ modal: dialog?.modal, headline: dialog?.headline }),
      );
      check(
        "M: it states plainly that nothing was overwritten",
        /Nothing has been overwritten\./.test(dialog?.text ?? ""),
        (dialog?.text ?? "").slice(0, 260),
      );
      const revisionsShown = (dialog?.revisions ?? [])
        .map((t) => Number(/Revision\s+(\d+)/.exec(t)?.[1]))
        .filter((n) => Number.isFinite(n));
      check(
        "M: it shows the two revisions, and they DIFFER — that is the whole conflict",
        revisionsShown.length === 2 && revisionsShown[0] !== revisionsShown[1],
        JSON.stringify(dialog?.revisions ?? []),
      );

      const actionLabels = (dialog?.actions ?? []).map((a) => a.label);
      const PHASE2_ACTIONS = [
        "Review the workspace version",
        "Download my version",
        "Keep both",
        "Replace the workspace version",
        "Decide later",
      ];
      check(
        "M: the resolution set is the Phase 2 contract, unchanged and complete",
        actionLabels.length === PHASE2_ACTIONS.length &&
          PHASE2_ACTIONS.every((label) => actionLabels.includes(label)),
        JSON.stringify(actionLabels),
      );
      check(
        "M: only the overwriting choice is gated, and it is gated behind a word",
        (dialog?.actions ?? []).filter((a) => a.button === "Continue").length === 1 &&
          (dialog?.actions ?? []).find((a) => a.label === "Replace the workspace version")?.button ===
            "Continue",
        JSON.stringify(dialog?.actions ?? []),
      );

      /*
       * The overwrite is REACHABLE — the stale session is not trapped — but it is
       * not reachable by accident, and backing out of it must leave the first
       * session's version exactly where it was.
       */
      await second.clickLabel("^Continue$", "button");
      await sleep(800);
      const confirming = (await second.text()) ?? "";
      check(
        "M: it asks once more, in words, before replacing anyone's work",
        /Replace the workspace version with yours\?/i.test(confirming) &&
          /Go back/i.test(confirming) &&
          /Replace it/i.test(confirming),
        confirming.slice(0, 240).replace(/\n/g, " | "),
      );
      await second.clickLabel("^Go back$", "button");
      await sleep(1000);
      const backedOut = (await second.text()) ?? "";
      check(
        "M: backing out returns to the choices, with nothing replaced",
        /This document changed somewhere else/i.test(backedOut) &&
          !/Replace the workspace version with yours\?/i.test(backedOut),
        backedOut.slice(0, 200).replace(/\n/g, " | "),
      );
      const versionsAfterRace = versionNumbersOf(await api(versionsPath));
      check(
        "M: the server still holds the FIRST session's version — no silent overwrite",
        JSON.stringify(versionsAfterRace) === JSON.stringify(versionsAfterA) &&
          Math.max(...versionsAfterRace, 0) === 4,
        `before [${versionsAfterA.join(",")}] after [${versionsAfterRace.join(",")}]`,
      );
      check(
        "M: and the stale session's refused write became no document of its own",
        countOf(await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/documents?${wsQuery}`)) ===
          docsBeforeRace,
        `${docsBeforeRace} document(s) before the race`,
      );
      second.close();
      await sleep(600);
    }
  }

  /* ========= I′. an output the editor cannot open, deterministically ======== */
  section("I'", "a non-PDF cloud result, with no test behaviour anywhere in the product");
  /*
   * Journey I could only ever say "not reachable here": every tool whose output is
   * not a PDF is server-run and its binary is missing on this machine. So the
   * result is manufactured the least invasive way the spec allows — the SAME
   * response, retyped in the browser on its way in. The product is unmodified, the
   * route is unmodified, no flag exists, nothing is installed; what is being tested
   * is precisely what the product does when a completed job reports a non-PDF
   * output, which is the branch that was previously unreachable.
   */
  const handoffKeys = () =>
    evaluate(`new Promise((resolve) => {
      let request;
      try { request = indexedDB.open("pdfdadi-handoff"); } catch { resolve(null); return; }
      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("entries")) { db.close(); resolve([]); return; }
        const all = db.transaction("entries", "readonly").objectStore("entries").getAllKeys();
        all.onerror = () => { db.close(); resolve(null); };
        all.onsuccess = () => {
          const keys = (all.result || []).map(String).filter((k) => k.indexOf("handoff:") === 0);
          db.close();
          resolve(keys);
        };
      };
    })`);

  await goto("/tools/compress-pdf", 3600);
  const handoffBefore = await handoffKeys();
  await evaluate(`sessionStorage.setItem("__probeMime", "1")`);
  check("I': a PDF can be attached to the cloud tool", await attachFiles([pdfA]));
  check("I': the compress control is reachable", await clickLabel("^Compress PDF$", "button"));
  let retypedText = "";
  for (let waited = 0; waited < 120_000; waited += 2500) {
    await sleep(2500);
    retypedText = (await text()) ?? "";
    if (/Your file is ready|can't be processed|didn't work|expired|Cancelled/i.test(retypedText)) break;
  }
  const rewrites = await evaluate(`window.__probeRewrites || 0`);
  /*
   * Did the interception actually land? Everything below asserts an ABSENCE on a
   * result the hook was supposed to retype, so on a page it did not retype those
   * absences are not the product's answer to a non-PDF output — they are three
   * assertions about a state that never existed.
   *
   * It does not land in the default configuration, and that is this probe's own
   * limitation rather than a defect: the hook patches `window.fetch` for
   * `/api/jobs/:id`, which only the PIPELINE reader calls
   * (`hooks/useProcessingJob.ts:129`). With `PROCESSING_PIPELINE` unset — the
   * shipped default — a server tool runs through `ServerToolRunner`, whose
   * terminal event arrives over `EventSource("/api/jobs/:id/progress")`
   * (`ServerToolRunner.tsx:249`) and whose MIME is read from that frame, which no
   * fetch hook can see. So the rows below carry the PROBE class in that case: the
   * behaviour they guard is proven by this same journey with the pipeline on, and
   * mislabelling it PRODUCT here would put two failures that do not exist into the
   * launch gate.
   */
  const retyped = typeof rewrites === "number" && rewrites > 0;
  const unsupportedKind = retyped ? "PRODUCT" : "PROBE";
  check(
    "I': the completed job really did arrive reporting a non-PDF output",
    retyped && /Your file is ready/i.test(retypedText),
    `rewrites=${rewrites} panel=${retypedText.slice(0, 160).replace(/\n/g, " | ")}`,
    // A miss here is this probe's interception failing, or the job failing — not the
    // product refusing something. It must not be reported as a product defect.
    "PROBE",
  );

  const unsupported = await evaluate(`(() => {
    const labels = [...document.querySelectorAll('button, a')]
      .map((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim())
      .filter(Boolean);
    return {
      labels,
      selects: document.querySelectorAll('select').length,
      chooseCopy: /Save to which Workspace/i.test(document.body.innerText || ''),
      fileName: (/([\\w.-]+\\.jpg)\\b/.exec(document.body.innerText || '') || [])[1] || null,
    };
  })()`);
  const unsupportedLabels = unsupported?.labels ?? [];
  check(
    "I': Download IS offered — the absences below are read next to a presence",
    unsupportedLabels.some((l) => /^Download/i.test(l)),
    unsupportedLabels.join(" / ").slice(0, 260),
  );
  check(
    "I': `Open in Editor` is offered NOWHERE on the page",
    !unsupportedLabels.some((l) => /Open in Editor/i.test(l)),
    unsupportedLabels.join(" / ").slice(0, 260),
    unsupportedKind,
  );
  /*
   * And Save to Workspace follows the INDEPENDENT Workspace rule for this output,
   * which for a non-PDF is "not saveable". Two Workspaces exist and neither is
   * chosen at this moment, so the selector's absence has to be asserted too:
   * without it, a missing Save button could be explained away as an unchosen
   * destination rather than as the capability decision it actually is.
   */
  check(
    "I': neither Save to Workspace nor the destination selector is offered for it",
    !unsupportedLabels.some((l) => /Save to Workspace/i.test(l)) &&
      unsupported?.selects === 0 &&
      unsupported?.chooseCopy === false,
    `selects=${unsupported?.selects} chooseCopy=${unsupported?.chooseCopy} labels=${unsupportedLabels
      .join(" / ")
      .slice(0, 200)}`,
    unsupportedKind,
  );
  const handoffAfter = await handoffKeys();
  check(
    "I': no editor handoff was written behind the scenes for a result it cannot open",
    Array.isArray(handoffBefore) &&
      Array.isArray(handoffAfter) &&
      handoffAfter.length === handoffBefore.length,
    `${Array.isArray(handoffBefore) ? handoffBefore.length : "?"} → ${
      Array.isArray(handoffAfter) ? handoffAfter.length : "?"
    } handoff entries`,
  );
  /*
   * And the hidden button is not the gate. Forcing the editor action by hand — the
   * one thing a determined user can still do — reaches an editor with nothing in
   * it, because the handoff id it would have needed was never minted.
   */
  await goto(`/editor?handoff=handoff-probe-forced-${stamp}`, 8000);
  const forcedOpen = await evaluate(`(() => {
    const alert = [...document.querySelectorAll('[role="alert"]')]
      .map((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim())
      .find((t) => /waiting to be opened|handoff/i.test(t));
    return {
      alert: alert ?? null,
      onboarding: /nothing opened yet/i.test(document.body.innerText || ''),
      objects: document.querySelectorAll('main svg [data-object-id]').length,
    };
  })()`);
  check(
    "I': forcing the editor action by hand opens no document, and says so honestly",
    /no longer waiting to be opened/i.test(forcedOpen?.alert ?? "") &&
      forcedOpen?.onboarding === true &&
      forcedOpen?.objects === 0,
    `alert=${JSON.stringify(forcedOpen?.alert)} onboarding=${forcedOpen?.onboarding} objects=${forcedOpen?.objects}`,
  );
  await evaluate(`sessionStorage.removeItem("__probeMime")`);
  check(
    "I': the interception is disarmed again, so nothing after this is measuring the probe",
    (await evaluate(`sessionStorage.getItem("__probeMime")`)) === null,
    "",
    "PROBE",
  );

  /* ================= H. signed out: sign-in, never a silent upload ========= */
  /* ================= N. the INTENTION is the identity, not the bytes ======= */
  section("N", "a save intention decides whether two saves are one, and content does not");
  /*
   * The three counterexamples the previous closeout got wrong, in the browser.
   *
   * All three are ordinary product requests: one multipart POST to the same upload
   * route the Save button uses, from a real signed-in page, carrying the same
   * `saveIntentKey` field `ResultActions` sends. No test-mode endpoint exists and
   * none is added — the ONLY thing that differs between the three is the key.
   *
   * Fresh bytes, produced here and never saved in this run, so every count below
   * is a fact about journey N rather than about whatever the earlier journeys left
   * behind.
   */
  const pdfN = await makePdf(join(fixtures, `save-intent-${stamp}.pdf`), "Nu", 2);
  const nWorkspaceId = workspaceId ?? "";
  const nDocumentsPath = `/api/workspaces/${encodeURIComponent(nWorkspaceId)}/documents?${wsQuery}`;
  const nBase64 = readFileSync(pdfN).toString("base64");
  /** Re-run after every navigation: a fresh document has no `window` state. */
  const installIntentBytes = () =>
    evaluate(
      `(() => { window.__probeIntentBytes = ${JSON.stringify(
        nBase64,
      )}; return window.__probeIntentBytes.length; })()`,
    );
  await goto(`/workspaces/${encodeURIComponent(nWorkspaceId)}?${wsQuery}`, 3800);
  await installIntentBytes();
  const nBaseline = countOf(await api(nDocumentsPath));
  check(
    "N: the Workspace list is readable, so a second document would be visible",
    typeof nBaseline === "number",
    `count ${nBaseline}`,
  );

  /**
   * One press of Save, as the product sends it. `tweak` appends bytes AFTER the
   * PDF's own EOF — still a PDF by every check the route makes, and a different
   * checksum — which is how "this key now means something else" is expressed
   * without inventing an endpoint.
   */
  const saveWithIntent = (key, fileName, tweak = "") =>
    evaluate(`(async () => {
      const raw = atob(window.__probeIntentBytes);
      const suffix = ${JSON.stringify(tweak)};
      const bytes = new Uint8Array(raw.length + suffix.length);
      for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
      for (let i = 0; i < suffix.length; i += 1) bytes[raw.length + i] = suffix.charCodeAt(i);
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: "application/pdf" }), ${JSON.stringify(fileName)});
      form.append("name", ${JSON.stringify(fileName)});
      form.append("organizationId", ${JSON.stringify(organizationId)});
      form.append("saveIntentKey", ${JSON.stringify(key)});
      const res = await fetch(
        "/api/workspaces/" + encodeURIComponent(${JSON.stringify(nWorkspaceId)}) + "/documents/upload",
        { method: "POST", body: form },
      );
      return { status: res.status, body: await res.json().catch(() => null) };
    })()`);
  const shaOfDocument = (documentId) =>
    evaluate(`(async () => {
      const res = await fetch(
        "/api/workspaces/" + encodeURIComponent(${JSON.stringify(nWorkspaceId)}) +
          "/documents/" + encodeURIComponent(${JSON.stringify(documentId)}) +
          "/content?${wsQuery}&artifact=source",
      );
      if (!res.ok) return "status " + res.status;
      const digest = await crypto.subtle.digest("SHA-256", await res.arrayBuffer());
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    })()`);

  /* --- N1: the response was lost and the user pressed Save again ----------- */
  const nKeyOne = `si-probe-n1-${stamp}`;
  const nFirstName = `intent-original-${stamp}.pdf`;
  const nFirst = await saveWithIntent(nKeyOne, nFirstName);
  const nFirstId = nFirst?.body?.document?.id ?? null;
  check(
    "N1: a new intention saves the result and returns its document",
    nFirst?.status === 201 && typeof nFirstId === "string" && nFirst.body?.deduplicated !== true,
    `→ ${nFirst?.status} id=${nFirstId} deduplicated=${nFirst?.body?.deduplicated}`,
  );
  // A DIFFERENT filename on the retry, because a retry that only works when the
  // name matches is a name-based identity wearing a key's clothes.
  const nRetry = await saveWithIntent(nKeyOne, `intent-retry-${stamp}.pdf`);
  check(
    "N1: the SAME intention retried returns the SAME document, not a second one",
    nRetry?.status === 200 &&
      nRetry.body?.deduplicated === true &&
      nRetry.body?.document?.id === nFirstId,
    `→ ${nRetry?.status} id=${nRetry?.body?.document?.id} deduplicated=${nRetry?.body?.deduplicated}`,
  );
  check(
    "N1: and the retry did not rename the document the first request made",
    nRetry?.body?.document?.name === nFirstName,
    `name ${nRetry?.body?.document?.name} (saved as ${nFirstName})`,
  );
  check(
    "N1: two requests, exactly one new document in the Workspace",
    countOf(await api(nDocumentsPath)) === nBaseline + 1,
    `${countOf(await api(nDocumentsPath))} document(s), baseline ${nBaseline}`,
  );
  // Ingestion is asynchronous, so version 1 is polled for rather than assumed —
  // and what is being watched for is a SECOND one appearing after it.
  const nVersionsPath = `/api/workspaces/${encodeURIComponent(nWorkspaceId)}/documents/${encodeURIComponent(
    nFirstId ?? "",
  )}/versions?${wsQuery}`;
  for (let attempt = 0; attempt < 14 && nFirstId; attempt += 1) {
    if (versionNumbersOf(await api(nVersionsPath)).length >= 1) break;
    await sleep(1500);
  }
  // A settled pause after the first version appears: the assertion below is that a
  // SECOND one never shows up, and reading the moment the first lands would pass
  // before the retry's ingestion could have cut one.
  await sleep(2500);
  const nVersions = nFirstId ? versionNumbersOf(await api(nVersionsPath)) : [];
  check(
    "N1: and exactly ONE initial version, not one per request",
    nVersions.length === 1 && nVersions[0] === 1,
    `versions [${nVersions.join(",")}]`,
  );

  /* --- N2: a deliberate second save of identical bytes --------------------- */
  const nKeyTwo = `si-probe-n2-${stamp}`;
  const nSecondName = `intent-copy-${stamp}.pdf`;
  const nSecond = await saveWithIntent(nKeyTwo, nSecondName);
  const nSecondId = nSecond?.body?.document?.id ?? null;
  check(
    "N2: a NEW intention over IDENTICAL bytes is a new document — the recorded defect",
    nSecond?.status === 201 &&
      typeof nSecondId === "string" &&
      nSecondId !== nFirstId &&
      nSecond.body?.deduplicated !== true,
    `→ ${nSecond?.status} id=${nSecondId} (first ${nFirstId}) deduplicated=${nSecond?.body?.deduplicated}`,
  );
  check(
    "N2: and it is filed under the name the user chose, not the first save's name",
    nSecond?.body?.document?.name === nSecondName,
    `name ${nSecond?.body?.document?.name} (asked for ${nSecondName})`,
  );
  check(
    "N2: both documents are in the Workspace",
    countOf(await api(nDocumentsPath)) === nBaseline + 2,
    `${countOf(await api(nDocumentsPath))} document(s), baseline ${nBaseline}`,
  );
  // Two logical documents, one physical object: both must download, byte-identical.
  const [nShaOne, nShaTwo] = [await shaOfDocument(nFirstId ?? ""), await shaOfDocument(nSecondId ?? "")];
  check(
    "N2: both download the same bytes — one stored object serves two documents",
    typeof nShaOne === "string" && nShaOne.length === 64 && nShaOne === nShaTwo,
    `${nShaOne} vs ${nShaTwo}`,
  );

  /*
   * ONE activity entry for N1's two requests, read BEFORE the trash below adds an
   * event of its own. Counted as feed list items containing the document's name,
   * the way journey K counts them, so a feed that prints the name twice inside one
   * entry cannot inflate the number.
   */
  await goto(`/workspaces/${encodeURIComponent(nWorkspaceId)}?${wsQuery}`, 6500);
  const nActivity = await evaluate(`(() => {
    const list = [...document.querySelectorAll('ul')].find((u) =>
      /published|saved|uploaded|created/i.test(u.textContent || ''),
    );
    if (!list) return null;
    return [...list.children]
      .map((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim())
      .filter((t) => t.indexOf(${JSON.stringify(nFirstName)}) >= 0);
  })()`);
  check(
    "N1: the save and its retry produced ONE activity entry, not two",
    Array.isArray(nActivity) && nActivity.length === 1,
    Array.isArray(nActivity)
      ? `${nActivity.length} entr(ies): ${nActivity.join(" || ").slice(0, 200)}`
      : `activity feed not found for ${nFirstName}`,
    Array.isArray(nActivity) ? "PRODUCT" : "PROBE",
  );
  await installIntentBytes();

  /* --- N3: trash, then save the same bytes again --------------------------- */
  const nTrashStatus = await evaluate(
    `fetch("/api/workspaces/" + encodeURIComponent(${JSON.stringify(nWorkspaceId)}) +
      "/documents/" + encodeURIComponent(${JSON.stringify(nFirstId ?? "")}) + "/lifecycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId: ${JSON.stringify(organizationId)}, state: "trashed" }),
    }).then((r) => r.status).catch(() => 0)`,
  );
  check("N3: the first document can be trashed", nTrashStatus === 200, `lifecycle → ${nTrashStatus}`);
  const nKeyThree = `si-probe-n3-${stamp}`;
  const nAfterTrashName = `intent-after-trash-${stamp}.pdf`;
  const nAfterTrash = await saveWithIntent(nKeyThree, nAfterTrashName);
  const nAfterTrashId = nAfterTrash?.body?.document?.id ?? null;
  check(
    "N3: saving those same bytes again AFTER the trash succeeds — no constraint error",
    nAfterTrash?.status === 201 && typeof nAfterTrashId === "string",
    `→ ${nAfterTrash?.status} ${JSON.stringify(nAfterTrash?.body ?? "").slice(0, 200)}`,
  );
  check(
    "N3: and it is a NEW document, not the trashed one handed back as a success",
    nAfterTrashId !== nFirstId && nAfterTrash?.body?.document?.name === nAfterTrashName,
    `id=${nAfterTrashId} (trashed ${nFirstId}) name=${nAfterTrash?.body?.document?.name}`,
  );
  const nShaThree = await shaOfDocument(nAfterTrashId ?? "");
  check(
    "N3: the new document downloads, and holds the same bytes that were saved",
    nShaThree === nShaOne,
    `${nShaThree} vs ${nShaOne}`,
  );
  const nTrashedRead = await api(
    `/api/workspaces/${encodeURIComponent(nWorkspaceId)}/documents/${encodeURIComponent(
      nFirstId ?? "",
    )}?${wsQuery}`,
  );
  check(
    "N3: the trashed document was NOT silently restored by that save",
    nTrashedRead?.body?.document?.lifecycleState === "trashed",
    `lifecycleState ${nTrashedRead?.body?.document?.lifecycleState} (status ${nTrashedRead?.status})`,
  );

  /* --- N4: the same key, a different meaning ------------------------------- */
  // Not one of the three, but the same identity read from the other side: a key
  // that has already been settled for one result must not be usable for another,
  // and the refusal must be a conflict the client can act on rather than a 500.
  // Counted immediately before, because the list view is `lifecycleState: "active"`
  // and N3 trashed one of the three: what "created nothing" means is that THIS
  // request changed the count by zero, not that some absolute total was reached.
  const nBeforeConflict = countOf(await api(nDocumentsPath));
  const nConflict = await saveWithIntent(nKeyOne, `intent-different-${stamp}.pdf`, "\n%probe-n4\n");
  check(
    "N4: the settled key presented for DIFFERENT bytes is a 409, not a 500 and not a save",
    nConflict?.status === 409,
    `→ ${nConflict?.status} ${JSON.stringify(nConflict?.body ?? "").slice(0, 200)}`,
  );
  check(
    "N4: and the refusal names no document, destination or existing save",
    !JSON.stringify(nConflict?.body ?? "").includes(String(nFirstId)) &&
      !JSON.stringify(nConflict?.body ?? "").includes(nWorkspaceId) &&
      nConflict?.body?.document === undefined,
    JSON.stringify(nConflict?.body ?? "").slice(0, 200),
  );
  const nAfterConflict = countOf(await api(nDocumentsPath));
  check(
    "N4: the refused request created nothing — the Workspace is exactly as it was",
    nAfterConflict === nBeforeConflict && nBeforeConflict === nBaseline + 2,
    `${nAfterConflict} document(s) before ${nBeforeConflict}; baseline ${nBaseline} + 3 saves - 1 trashed`,
  );

  section("H", "a signed-out result offers sign-in and still opens in the editor");
  const logoutStatus = await evaluate(
    `fetch("/api/auth/logout", { method: "POST" }).then((r) => r.status).catch(() => 0)`,
  );
  await goto("/tools/merge-pdf", 3200);
  check("H: the prober is signed out", logoutStatus < 400, `logout → ${logoutStatus}`);
  check("H: two PDFs can be attached while signed out", await attachFiles([pdfA, pdfB]));
  const guestMark = Date.now();
  await clickLabel("^Merge PDFs$", "button");
  await sleep(5000);
  check(
    "H: a signed-out user gets a real result",
    /Your file is ready/i.test((await text()) ?? ""),
    ((await text()) ?? "").slice(0, 160).replace(/\n/g, " | "),
  );
  const guestControls = (await controls()) ?? [];
  check(
    "H: the offer is Download + Open in Editor + Sign in to save to Workspace",
    guestControls.some((l) => /^Download$/i.test(l)) &&
      guestControls.some((l) => /Open in Editor/i.test(l)) &&
      guestControls.some((l) => /Sign in to save to Workspace/i.test(l)),
    guestControls.join(" / ").slice(0, 260),
  );
  check(
    "H: `Save to Workspace` is NOT offered to someone with no Workspace",
    !guestControls.some((l) => /^Save to Workspace$/i.test(l)),
    guestControls.join(" / ").slice(0, 200),
  );
  const signInHrefSeen = await evaluate(
    `(() => { const a = [...document.querySelectorAll('a')].find((n) => /Sign in to save/i.test(n.textContent || "")); return a ? a.getAttribute("href") : null; })()`,
  );
  check(
    "H: the sign-in link comes back to this tool, so the work is not abandoned",
    typeof signInHrefSeen === "string" && /\/login\?next=%2Ftools%2Fmerge-pdf/.test(signInHrefSeen),
    signInHrefSeen ?? "no sign-in link",
  );
  check(
    "H: nothing was uploaded before consent — no result, no file, nothing",
    escapes(guestMark).length === 0 && bigBodies(guestMark).length === 0,
    describe([...escapes(guestMark), ...bigBodies(guestMark)]),
  );
  const guestOpenMark = Date.now();
  await clickLabel("Open in Editor", "button");
  await sleep(7000);
  check(
    "H: a signed-out user's result still opens in the editor, with all 3 pages",
    requests.some((r) => r.at >= guestOpenMark && HANDOFF_NAV.test(r.url)) &&
      (await pageCount()) === 3,
    `${await url()} pages ${await pageCount()}`,
  );
  check(
    "H: and that open uploaded nothing either",
    escapes(guestOpenMark).length === 0 && bigBodies(guestOpenMark).length === 0,
    describe([...escapes(guestOpenMark), ...bigBodies(guestOpenMark)]),
  );

  /* ================= I. an action that cannot work is not offered ========== */
  section("I", "unsupported output, and the server-side half of the same rule");
  /*
   * What this machine can actually run, read from the product's own public page
   * rather than asserted from memory. Printed, because journey I's coverage
   * depends on it: the tools whose output is NOT a PDF (`pdf-to-jpg`,
   * `pdf-to-png`, `pdf-to-word`) and the one whose PDF is opaque
   * (`protect-pdf`) are all server-run, and every one of their binaries is
   * missing here. So no completed non-PDF result can exist on this machine, and
   * the route's 415 `UNSUPPORTED_OUTPUT` branch cannot be reached from a browser.
   * That is recorded below as ENVIRONMENTAL — a gap in this machine, named — not
   * folded into a pass. It stays ENVIRONMENTAL: what journey I' adds is browser
   * evidence for the CLIENT half of the same question, on a real completed job
   * whose reported output type is rewritten in transit. It does not reach this
   * SERVER branch, and does not relabel it.
   */
  await goto("/server-status", 4000);
  const binaries = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('li, tr, div')]
      .map((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim())
      .filter((t) => /binary:/.test(t) && t.length < 220);
    return [...new Set(rows)].slice(0, 12);
  })()`);
  const binaryLines = Array.isArray(binaries) ? binaries : [];
  console.log(`      binaries on this machine: ${binaryLines.join(" || ") || "not listed"}`);
  const missing = binaryLines
    .filter((t) => /Missing/i.test(t))
    .map((t) => /binary: ([\w.+-]+)/.exec(t)?.[1] ?? "?");
  check(
    "I: the server-status page reports each binary's real state",
    binaryLines.length > 0,
    binaryLines.length ? `${missing.length} missing: ${missing.join(",")}` : "no binary rows found",
    "PROBE",
  );
  check(
    "I: the SERVER's own 415 UNSUPPORTED_OUTPUT branch is unreachable on this machine",
    false,
    `every non-PDF-output tool is server-run and its binary is absent (${
      missing.join(",") || "qpdf, pdftoppm, soffice"
    }), so no genuinely non-PDF result can be PRODUCED here. The route branch is covered by saveToWorkspaceRoute.test.ts; the browser behaviour it guards is covered by journey I' above.`,
    "ENVIRONMENTAL",
  );

  /*
   * The reachable half, and the one that matters more: the hidden button is NOT
   * the authorization. The job below is real, completed, and was this prober's
   * own a few seconds ago — until journey H signed out, which replaced the actor
   * with an anonymous identity that does not own it. Every refusal here is the
   * route's, not the UI's.
   */
  const cloudJobId =
    /\/api\/jobs\/([0-9a-zA-Z_-]+)/.exec(
      requests.filter((r) => /\/api\/jobs\/[^/]+/.test(r.url)).at(-1)?.url ?? "",
    )?.[1] ?? null;
  const post = (jobId, body, contentType = "application/json") =>
    evaluate(
      `fetch(${JSON.stringify(`/api/jobs/${jobId}/save-to-workspace`)}, {
        method: "POST",
        headers: { "Content-Type": ${JSON.stringify(contentType)} },
        body: ${JSON.stringify(typeof body === "string" ? body : JSON.stringify(body))},
      }).then((r) => r.status).catch(() => 0)`,
    );
  if (cloudJobId === null || workspaceId === null) {
    check(
      "I: skipped — no completed cloud job was observed to test the refusals against",
      false,
      "",
      "PROBE",
    );
  } else {
    const foreign = await post(cloudJobId, { workspaceId, organizationId });
    check(
      "I: a job id alone does not save anything — a different actor is refused",
      foreign === 404,
      `POST save-to-workspace as a signed-out caller → ${foreign} (expected 404, which also refuses to confirm the job exists)`,
    );
    const wrongType = await post(cloudJobId, "{}", "text/plain");
    check(
      "I: a non-JSON body is refused before anything is read",
      wrongType === 415,
      `→ ${wrongType} (expected 415)`,
    );
    const noDestination = await post(cloudJobId, {});
    check(
      "I: a request that names no destination is refused",
      noDestination === 422,
      `→ ${noDestination} (expected 422)`,
    );
  }

  /* ================= browser health ======================================== */
  section("H+", "nothing broke quietly while all of that happened");
  const serverErrors = documentStatuses.filter((row) => row.status >= 500);
  check(
    "the server returned no 5xx during any journey",
    serverErrors.length === 0,
    serverErrors.map((r) => `${r.status} ${r.url}`).join(", ").slice(0, 300),
  );
  const realErrors = consoleErrors.filter(
    (line) =>
      // Signed-out API probing above is SUPPOSED to fail; the browser logs each
      // non-2xx fetch, and counting those would make journey I fail journey H+.
      !/40[0-9]|41[0-9]|422|Failed to load resource|save-to-workspace/i.test(line),
  );
  check(
    "no uncaught exception or console error surfaced in the page",
    realErrors.length === 0,
    realErrors.join(" | ").slice(0, 300),
  );
  const hydration = consoleErrors.filter((line) => /hydrat|did not match/i.test(line));
  check("no hydration mismatch", hydration.length === 0, hydration.join(" | ").slice(0, 200));

  chrome.kill();
  sock.close();

  /* ================= summary =============================================== */
  const failed = results.filter((r) => !r.pass);
  const product = failed.filter((r) => r.kind === "PRODUCT");
  const probe = failed.filter((r) => r.kind === "PROBE");
  const environmental = failed.filter((r) => r.kind === "ENVIRONMENTAL");
  console.log(
    `\n=============== ${results.length - failed.length}/${results.length} passed ===============`,
  );
  for (const row of failed) console.log(`  ${row.kind}: ${row.label} — ${row.detail}`);
  if (environmental.length && !product.length && !probe.length) {
    console.log(
      `\n${environmental.length} environmental gap(s) only — every product assertion this machine can reach passed.`,
    );
  }
  /*
   * The exit code answers one question: is the PRODUCT wrong. A missing binary is
   * a fact about this laptop and must not be reported as a workflow defect — but
   * it is still printed above, every time, so the gap cannot quietly become a
   * pass.
   */
  process.exit(product.length + probe.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nPROBE ERROR: ${err?.stack || err}`);
  process.exit(1);
});
