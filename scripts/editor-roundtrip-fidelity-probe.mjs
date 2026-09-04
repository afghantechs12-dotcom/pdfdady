/* global process, console, fetch, WebSocket, setTimeout, clearTimeout, Buffer */
/**
 * PHASE 3 runtime probe: DOES A REOPENED DOCUMENT STILL HOLD THE DOCUMENT?
 *
 * WHY THIS EXISTS. A yellow sticky note was authored, saved to a Workspace and
 * reopened. The text `this is note` came back; the yellow container did not, and
 * the exported PDF showed the same loss. Every suite was green, and so was the
 * Phase 2 save-state probe — because both answer "was this revision persisted?"
 * and neither answers "was the DOCUMENT that revision names persisted?".
 *
 * The vitest side of Phase 3 proves the canonical boundaries A–G with real
 * services and a substituted key-value store. It cannot prove the two things
 * that only exist in a browser:
 *
 *  - a REAL IndexedDB draft, written by the real runtime, recovered by a real
 *    reload. "Saved on this device" is a claim about a document, and until a
 *    reload restores that document the claim is untested.
 *  - a REAL Workspace round trip through HTTP, the version manifest, object
 *    storage and back into a mounted editor, followed by a REAL export from the
 *    reopened model.
 *
 * WHAT WOULD MAKE THIS VACUOUS, and how each hazard is guarded:
 *
 *  - **A default that looks like the user's value.** A new note is already pale
 *    yellow (`DEFAULT_ANNOTATION_BACKGROUND`), so a renderer inventing the
 *    default would pass a naive "is it yellow" check. The probe sets an
 *    explicitly DIFFERENT yellow and asserts the recovered value is not the
 *    default — the reopened panel has to be the user's colour or nothing.
 *  - **Nothing was authored.** Every scenario asserts the object count after the
 *    gesture and the note's presence in the canonical scene BEFORE the boundary
 *    it is about to cross.
 *  - **An export that drew nothing.** The exported bytes are captured from the
 *    real download and read as a CONTENT STREAM: the fill colour set, the path
 *    painted, the strings shown. "It did not throw" is not a fidelity assertion.
 *  - **An export that lost the page underneath.** The fixtures carry real source
 *    page text and graphics, and every export assertion includes them, so an
 *    overlay drawn onto a blank page fails.
 *  - **A recovery that recovered nothing.** Scenario C asserts the draft store
 *    was EMPTY before the edit and that the restored panel carries the authored
 *    colour, not a default and not an absence.
 *
 * IT MUTATES DATA. It registers one throwaway account per run and saves into
 * that account's own Workspace, against whatever database the server uses. It
 * clears the local `pdfdadi-drafts` database in its own throwaway Chrome profile.
 *
 * WHAT IT NEVER LOGS. No document bytes, no image data, no signature content.
 * Note text appears in output only as the probe's own fixture literal, and
 * colours only as the numbers the probe itself set.
 *
 * Run with tsx so it can import the repo's own PDF content-stream reader rather
 * than growing a second copy of it:
 *
 *   npx tsx --tsconfig tsconfig.json scripts/editor-roundtrip-fidelity-probe.mjs
 *   [--url http://localhost:3001] [--shots] [--only A,B,C,D]
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import {
  colorMatches,
  readPdfPageContents,
} from "@/src/application/editor/export/testing/pdfContent";
import { DEFAULT_ANNOTATION_BACKGROUND } from "@/src/domain/editor/objects";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = arg("--url", "http://localhost:3001");
const SHOTS = process.argv.includes("--shots");
const ONLY = arg("--only", "A,B,C,D")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const runs = (name) => ONLY.includes(name);
const SHOT_DIR = "docs/screenshots/roundtrip-fidelity";
const CHROME =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9496;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 700ms debounce + 4s ceiling + the write itself, as the sibling probes use. */
const AUTOSAVE_GRACE_MS = 5200;
/** A Workspace save is a byte upload plus a version commit. */
const SAVE_WAIT_MS = 9000;

/**
 * The note's authored panel colour: a saturated yellow that is NOT the model's
 * default pale yellow, so "the container came back" cannot be satisfied by a
 * renderer that invents the default.
 */
const NOTE_FILL_HEX = "#FFD400";
const NOTE_FILL = { r: 1, g: 212 / 255, b: 0 };
/** Scenario D changes exactly this one property, and nothing else. */
const NOTE_FILL_HEX_2 = "#3B82F6";
const NOTE_FILL_2 = { r: 59 / 255, g: 130 / 255, b: 246 / 255 };
const NOTE_TEXT = "this is note";

/**
 * A deterministic source PDF: fixed dates and producer, so two runs of the probe
 * produce identical bytes and therefore the same guest document identity.
 */
async function writeFixturePdf(path, pages) {
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  doc.setProducer("pdfdadi-phase3-probe");
  doc.setTitle("Phase 3 fixture");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const spec of pages) {
    const page = doc.addPage([595, 842]);
    page.drawText(spec.text, { x: 60, y: 700, size: 22, font, color: rgb(0.05, 0.05, 0.05) });
    page.drawRectangle({ x: 60, y: 90, width: 210, height: 90, color: spec.color });
  }
  writeFileSync(path, await doc.save());
  return path;
}

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), "pdfdadi-fidelity-"));
  const fixtureDir = mkdtempSync(join(tmpdir(), "pdfdadi-fixtures-"));
  const FIXTURE_A = await writeFixturePdf(join(fixtureDir, "phase3-a.pdf"), [
    { text: "SOURCE PAGE ONE", color: rgb(0.15, 0.35, 0.85) },
  ]);
  const FIXTURE_C = await writeFixturePdf(join(fixtureDir, "phase3-c.pdf"), [
    { text: "LOCAL RECOVERY SOURCE", color: rgb(0.85, 0.3, 0.1) },
  ]);
  const FIXTURE_B = await writeFixturePdf(join(fixtureDir, "phase3-b.pdf"), [
    { text: "SOURCE PAGE ONE", color: rgb(0.15, 0.35, 0.85) },
    { text: "SOURCE PAGE TWO", color: rgb(0.1, 0.6, 0.3) },
  ]);

  // A previous run that died before `chrome.kill()` still holds this port, and a
  // second launch silently ATTACHES to it — stale targets, hanging CDP calls.
  spawnSync("pkill", ["-f", `remote-debugging-port=${PORT}`], { stdio: "ignore" });
  await sleep(400);
  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      ...(BASE.startsWith("https:") ? ["--ignore-certificate-errors"] : []),
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let targets = null;
  for (let attempt = 0; attempt < 40 && !targets; attempt += 1) {
    await sleep(300);
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    } catch {
      targets = null;
    }
  }
  if (!targets) throw new Error(`Chrome never opened a debug port on ${PORT}`);
  const target = targets.find((t) => t.type === "page");
  const sock = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    sock.addEventListener("open", res, { once: true });
    sock.addEventListener("error", rej, { once: true });
  });

  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  const responses = [];
  sock.addEventListener("message", (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      consoleErrors.push(
        (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300),
      );
    }
    if (msg.method === "Runtime.exceptionThrown") {
      consoleErrors.push(msg.params?.exceptionDetails?.text ?? "exception");
    }
    if (msg.method === "Network.responseReceived") {
      responses.push({ url: msg.params.response.url, status: msg.params.response.status });
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
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
  });

  const failures = [];
  const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failures.push(name);
  };
  const goto = async (path, wait = 4500) => {
    await send("Page.navigate", { url: `${BASE}${path}` });
    await sleep(wait);
  };
  const shot = async (name) => {
    if (!SHOTS) return;
    const res = await send("Page.captureScreenshot", { format: "png" });
    if (!res.result?.data) return;
    mkdirSync(SHOT_DIR, { recursive: true });
    writeFileSync(join(SHOT_DIR, `${name}.png`), Buffer.from(res.result.data, "base64"));
  };

  /* --- real input ---------------------------------------------------------- */

  const mouseClick = async (x, y, holdMs = 90) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1,
    });
    await sleep(holdMs);
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0,
    });
    await sleep(260);
  };
  const key = async (keyName, code, text, modifiers = 0) => {
    // A modified key is not a character: sending `text` with Ctrl held makes
    // Chrome deliver a char event the app's keydown handler never sees as a combo.
    await send("Input.dispatchKeyEvent", {
      type: "keyDown", key: keyName, code, modifiers, ...(modifiers === 0 ? { text } : {}),
    });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, modifiers });
    await sleep(220);
  };
  const typeText = async (text) => {
    await send("Input.insertText", { text });
    await sleep(160);
  };
  const drag = async (x0, y0, x1, y1, steps = 10) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0, y: y0, buttons: 0 });
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: x0, y: y0, button: "left", clickCount: 1, buttons: 1,
    });
    /*
     * The press has to be RENDERED before the first move. The canvas's gesture is
     * React state read back through a ref, and a move that arrives before that
     * commit is dropped by the `g.mode === "none"` early return. A box tool never
     * noticed — it commits from pointer-down and pointer-up alone — but the freehand
     * brush needs two points, so it silently produced nothing at all.
     */
    await sleep(140);
    for (let i = 1; i <= steps; i += 1) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: x0 + Math.round(((x1 - x0) * i) / steps),
        y: y0 + Math.round(((y1 - y0) * i) / steps),
        button: "left",
        buttons: 1,
      });
      await sleep(45);
    }
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: x1, y: y1, button: "left", clickCount: 1, buttons: 0,
    });
    await sleep(520);
  };
  const field = (name, value) =>
    evaluate(`(() => {
      const el = document.querySelector('input[name="${name}"]');
      if (!el) return "missing";
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return "ok";
    })()`);
  const clickLabel = async (text, selector = "button, a") => {
    const box = await evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((n) => new RegExp(${JSON.stringify(text)}, "i").test((n.textContent || "").trim()));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!box || box.__probeError) return false;
    await mouseClick(box.x, box.y);
    return true;
  };
  /** Which Inspector tab is selected — a note's fill control only exists on one of them. */
  const inspectorTabs = () =>
    evaluate(`(() => JSON.stringify([...document.querySelectorAll('[role="tab"]')]
      .map((t) => (t.textContent || "").trim() + ":" + t.getAttribute("aria-selected"))))()`);
  /**
   * Answers whichever modal the product has put over the canvas, if any.
   *
   * MEASURED (screenshots `d-note-selected`, `b-after-export`): a reopened
   * workspace document raises one of two real modals — "This document changed
   * somewhere else" when the tab is a revision behind (the scene attach landed
   * after the page read the revision), and "Unsaved changes found" when this
   * device still holds a draft. Both are `alertdialog`s over the canvas AND over
   * the toolbar: until one is answered every click lands on its backdrop, which is
   * what made a clicked Export button export nothing and a clicked note select
   * nothing. Each is answered the way a user who wants to lose nothing answers it
   * — "Decide later" keeps both copies where they are, "Open the saved version"
   * asks for exactly the copy the Workspace holds, which is the copy these checks
   * are about — and the answer is reported rather than hidden.
   */
  const answerBlockingDialog = async () => {
    const seen = [];
    for (let i = 0; i < 3; i += 1) {
      const found = await evaluate(`(() => {
        const dlg = document.querySelector('[role="alertdialog"]');
        if (!dlg) return null;
        const wanted = [/decide later/i, /open the saved version/i];
        for (const re of wanted) {
          const row = [...dlg.querySelectorAll('li, div')].find(
            (n) => re.test(n.textContent || '') && n.querySelector('button'),
          );
          const btn = [...dlg.querySelectorAll('button')].find((b) => re.test(b.textContent || ''))
            || (row ? row.querySelector('button') : null);
          if (btn) {
            const r = btn.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              return { label: re.source, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
            }
          }
        }
        return { unanswerable: (dlg.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 140) };
      })()`);
      if (!found) return seen.length ? seen.join(" then ") : "absent";
      if (found.unanswerable) return [...seen, `unanswerable: ${found.unanswerable}`].join(" then ");
      await mouseClick(found.x, found.y);
      await sleep(1200);
      seen.push(found.label);
    }
    return [...seen, "still-open"].join(" then ");
  };

  /** A real mouse press at the centre of the first element matching `selector`. */
  const clickSelector = async (selector) => {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!box || box.__probeError) return false;
    await mouseClick(box.x, box.y);
    return true;
  };
  /**
   * Sets a field's value and commits it through the component's own commit path.
   *
   * The focus and the commit are real: a real mouse press focuses the control and a
   * real key press commits it, and both handlers read `event.target.value`. Only the
   * characters themselves are written through the native setter, because
   * select-all-then-retype depends on the platform's own keybinding (Cmd+A on macOS,
   * Ctrl+A elsewhere) and a probe that types into a field it did not clear asserts
   * nothing about the value it meant to set.
   */
  const setFieldAndCommit = async (selector, value, commit) => {
    if (!(await clickSelector(selector))) return "missing";
    const set = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return "missing";
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return "ok";
    })()`);
    if (set !== "ok") return set;
    await commit();
    await sleep(400);
    return "ok";
  };

  /** Opens a real PDF through the editor's own file input. */
  const openPdf = async (filePath) => {
    const doc = await send("DOM.getDocument", { depth: 1 });
    const root = doc.result?.root?.nodeId;
    const q = await send("DOM.querySelector", {
      nodeId: root,
      selector: 'input[type="file"][accept="application/pdf"]',
    });
    if (!q.result?.nodeId) return false;
    await send("DOM.setFileInputFiles", { files: [filePath], nodeId: q.result.nodeId });
    await sleep(6000);
    return true;
  };

  /* --- reads --------------------------------------------------------------- */

  const countObjects = () =>
    evaluate(`document.querySelectorAll('main svg [data-object-id]').length`);
  /** Object ids in DOM order, which the canvas paints bottom-first — the z-stack. */
  const domOrder = () =>
    evaluate(`[...document.querySelectorAll('main svg [data-object-id]')].map((n) => n.getAttribute('data-object-id'))`);
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
  /**
   * The zoom capsule's accessible name, e.g. `Zoom level: 78%, Fit page`.
   *
   * Read from the aria-label rather than the visible span: the trigger shows a
   * compact label at narrow widths, and the label is the value the product itself
   * calls the zoom level. A prefix match, because the fit-mode suffix comes and
   * goes — an exact `[aria-label="Zoom level"]` matches only the OPEN menu, which
   * is how an earlier version of this probe read `null` at every zoom.
   */
  const zoomLevel = () =>
    evaluate(`(() => {
      const el = document.querySelector('button[aria-label^="Zoom level"]');
      return el ? el.getAttribute('aria-label') : null;
    })()`);
  const surfaces = () =>
    evaluate(`(() => {
      const visibleText = (el) => {
        if (!el) return null;
        const spans = [...el.querySelectorAll('span')].filter(
          (s) => !/sr-only/.test(s.className || '') && s.getClientRects().length > 0,
        );
        const node = spans[0] || el;
        return (node.textContent || '').trim();
      };
      const pill = [...document.querySelectorAll('header span[title]')].find((s) =>
        /rounded-full/.test(s.className || ''),
      ) || null;
      const bars = [...document.querySelectorAll('button[aria-expanded][aria-controls][title]')];
      const bar = bars.find((b) => b.closest('.ml-auto')) || bars[0] || null;
      return {
        pill: pill ? { label: visibleText(pill), detail: pill.getAttribute('title') || '' } : null,
        bar: bar ? { label: visibleText(bar), detail: bar.getAttribute('title') || '' } : null,
      };
    })()`);
  const saveBanner = () =>
    evaluate(`(() => {
      const el = [...document.querySelectorAll('[role="alert"], [role="status"]')].find(
        (n) =>
          !/sr-only/.test(n.className || '') &&
          /workspace|save|permission|too large/i.test(n.textContent || ''),
      );
      if (!el) return { present: false };
      return {
        present: true,
        role: el.getAttribute('role'),
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
      };
    })()`);
  /** What one object actually DRAWS on the canvas right now. */
  const domObject = (objectId) =>
    evaluate(`(() => {
      const g = document.querySelector('[data-object-id="' + ${JSON.stringify(objectId)} + '"]');
      if (!g) return null;
      const path = g.querySelector('path');
      const text = g.querySelector('text');
      const b = g.getBoundingClientRect();
      return {
        hasPanel: Boolean(path),
        fill: path ? path.getAttribute('fill') : null,
        stroke: path ? path.getAttribute('stroke') : null,
        strokeWidth: path ? path.getAttribute('stroke-width') : null,
        text: text ? (text.textContent || '').trim() : null,
        box: { x: b.x, y: b.y, w: b.width, h: b.height },
      };
    })()`);

  /* --- the canonical scene, at each real boundary -------------------------- */

  /**
   * The scene inside the newest LOCAL draft snapshot — the real IndexedDB record a
   * reload would recover, read without creating the database if it is absent.
   */
  const draftState = () =>
    evaluate(`(async () => {
      const names = (await indexedDB.databases()).map((d) => d.name);
      if (!names.includes('pdfdadi-drafts')) return { exists: false, snapshots: 0, scene: null };
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('pdfdadi-drafts');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      if (!db.objectStoreNames.contains('entries')) { db.close(); return { exists: true, snapshots: 0, scene: null }; }
      const read = (method) => new Promise((res) => {
        const rq = db.transaction('entries', 'readonly').objectStore('entries')[method]();
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => res(null);
      });
      const keys = await read('getAllKeys');
      const values = await read('getAll');
      db.close();
      const found = [];
      (keys || []).forEach((k, i) => {
        if (!String(k).startsWith('snapshot:')) return;
        const m = values[i]?.manifest;
        if (!m) return;
        found.push({ generation: m.generation ?? 0, revision: m.revision ?? null, origin: m.origin ?? null, documentKey: m.documentKey ?? null, scene: m.scene ?? null });
      });
      found.sort((a, b) => (b.generation ?? 0) - (a.generation ?? 0));
      const newest = found[0] ?? null;
      return { exists: true, snapshots: found.length, generation: newest?.generation ?? null, revision: newest?.revision ?? null, origin: newest?.origin ?? null, scene: newest?.scene ?? null };
    })()`);
  const clearDrafts = () =>
    evaluate(`(async () => {
      await new Promise((res) => {
        const rq = indexedDB.deleteDatabase('pdfdadi-drafts');
        rq.onsuccess = rq.onerror = rq.onblocked = () => res(null);
      });
      return (await indexedDB.databases()).map((d) => d.name).includes('pdfdadi-drafts');
    })()`);

  /** The scene a Workspace VERSION was saved with, through the product's own route. */
  const savedState = (workspaceId, documentId, organizationId, versionNumber = null) =>
    evaluate(`(async () => {
      const res = await fetch('/api/workspaces/' + ${JSON.stringify(workspaceId)} + '/documents/' +
        ${JSON.stringify(documentId)} + '/editor-state?organizationId=' +
        encodeURIComponent(${JSON.stringify(organizationId)}) +
        ${JSON.stringify(versionNumber === null ? "" : `&version=${versionNumber}`)},
        { headers: { Accept: 'application/json' } });
      if (res.status !== 200) return { status: res.status, scene: null };
      return { status: 200, version: res.headers.get('X-Document-Version'), scene: await res.json() };
    })()`);
  const listDocuments = (workspaceId, organizationId) =>
    evaluate(`(async () => {
      const res = await fetch('/api/workspaces/' + ${JSON.stringify(workspaceId)} +
        '/documents?organizationId=' + encodeURIComponent(${JSON.stringify(organizationId)}) + '&limit=50',
        { headers: { Accept: 'application/json' } });
      const body = await res.json().catch(() => null);
      const items = body?.items ?? body?.documents ?? [];
      return { status: res.status, count: items.length, ids: items.map((d) => d.id), revisions: items.map((d) => d.revision ?? null) };
    })()`);
  const listVersions = (workspaceId, documentId, organizationId) =>
    evaluate(`(async () => {
      const res = await fetch('/api/workspaces/' + ${JSON.stringify(workspaceId)} + '/documents/' +
        ${JSON.stringify(documentId)} + '/versions?organizationId=' +
        encodeURIComponent(${JSON.stringify(organizationId)}) + '&limit=10',
        { headers: { Accept: 'application/json' } });
      const body = await res.json().catch(() => null);
      const versions = body?.versions ?? [];
      return { status: res.status, count: versions.length, numbers: versions.map((v) => v.versionNumber) };
    })()`);

  /* --- the exported bytes, captured from the real download ------------------ */

  /**
   * Captures whatever the export hands to the browser as a download.
   *
   * `downloadBytes` builds a Blob and calls `URL.createObjectURL`, so wrapping that
   * one call captures the REAL exported bytes — the production export runs
   * untouched, and nothing about the editor's behaviour changes.
   */
  const installExportCapture = () =>
    evaluate(`(() => {
      if (window.__probeExportInstalled) { window.__probeExportBlob = null; return "already"; }
      window.__probeExportBlob = null;
      const real = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (obj) => {
        if (obj instanceof Blob && obj.type === 'application/pdf') {
          /*
           * The Blob is kept and converted by the READER, not here. A conversion
           * that lives in this hook can only report its failure by rejecting a
           * promise nobody awaits — which is how a rejected read looked exactly
           * like an export that never happened.
           */
          window.__probeExportBlob = obj;
        }
        return real(obj);
      };
      window.__probeExportInstalled = true;
      return "installed";
    })()`);
  /** Clicks Export and returns the exported PDF's pages, read as content streams. */
  const exportAndRead = async () => {
    await evaluate(`(window.__probeExportBlob = null)`);
    /* A modal raised while the page settled swallows the click on Export itself. */
    const blocking = await answerBlockingDialog();
    const clicked = await clickSelector('button[aria-label="Export edited PDF"]');
    if (!clicked) return { clicked: false, pages: null, why: `dialog=${blocking}` };
    for (let i = 0; i < 60; i += 1) {
      await sleep(700);
      const b64 = await evaluate(`(async () => {
        const blob = window.__probeExportBlob;
        if (!blob) return null;
        try {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let out = '';
          for (let i = 0; i < bytes.length; i += 0x2000) {
            out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x2000));
          }
          return btoa(out);
        } catch (e) {
          return 'READ-FAILED: ' + (e && e.message ? e.message : String(e));
        }
      })()`);
      if (typeof b64 === "string" && b64.startsWith("READ-FAILED")) return { clicked: true, pages: null, why: b64 };
      if (typeof b64 === "string" && b64.length > 0) {
        const bytes = Buffer.from(b64, "base64");
        const pdf = bytes.subarray(0, 5).toString("latin1") === "%PDF-";
        return { clicked: true, pdf, byteLength: bytes.length, pages: await readPdfPageContents(new Uint8Array(bytes)) };
      }
    }
    /*
     * Nothing was captured. Which of the three possible reasons it was has to be
     * IN the failure line: the button never ran its handler, the export is still
     * running, or it failed and told the user so.
     */
    const why = await evaluate(`(() => {
      const b = document.querySelector('button[aria-label="Export edited PDF"]');
      const notice = [...document.querySelectorAll('[role="alert"], [role="status"]')]
        .map((n) => (n.textContent || "").replace(/\\s+/g, " ").trim())
        .filter((t) => t.length > 0).join(" | ").slice(0, 200);
      return JSON.stringify({
        installed: Boolean(window.__probeExportInstalled),
        captured: window.__probeExportBlob ? window.__probeExportBlob.size : null,
        dialog: Boolean(document.querySelector('[role="alertdialog"]')),
        disabled: b ? b.disabled : null,
        notice,
      });
    })()`);
    return { clicked: true, pages: null, why };
  };

  /* --- the canonical scene, read as a document (node side) ------------------ */

  const pagesOf = (scene) => scene?.document?.pages ?? [];
  /** Paint order as DATA: the layer arrays, bottom layer first, never re-derived. */
  const paintIds = (page) => (page?.layerStack?.layers ?? []).flatMap((l) => l.objectIds ?? []);
  const objectsOf = (scene) =>
    pagesOf(scene).flatMap((p) => paintIds(p).map((oid) => ({ page: p.id, object: p.objects?.[oid] ?? null, id: oid })));
  const noteOf = (scene) => objectsOf(scene).find((e) => e.object?.kind === "annotation") ?? null;
  const kindsOf = (scene) =>
    pagesOf(scene).map((p) => paintIds(p).map((oid) => p.objects?.[oid]?.kind ?? "<missing>"));
  /** Key order cannot be a difference; every value must be. */
  const canon = (value) =>
    JSON.stringify(value, (_k, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
        : v,
    );
  /**
   * The properties a note IS. Not a checksum of the whole object: a failure has to
   * name the property, and a checksum names nothing.
   */
  const NOTE_FIELDS = [
    "kind", "id", "text", "background", "border", "borderWidth", "cornerRadius",
    "color", "fontSize", "opacity", "transform", "localBounds", "pointerTarget",
  ];
  const notePrint = (note) =>
    note === null ? null : Object.fromEntries(NOTE_FIELDS.map((f) => [f, note[f] ?? null]));
  const diffNote = (before, after) => {
    if (!before || !after) return ["one side has no note at all"];
    return NOTE_FIELDS.filter((f) => canon(before[f] ?? null) !== canon(after[f] ?? null)).map(
      (f) => `${f}: ${canon(before[f] ?? null)} -> ${canon(after[f] ?? null)}`,
    );
  };

  /* --- authoring the note, through the real UI ------------------------------ */

  /**
   * Creates a note, gives it an explicit panel colour and explicit text.
   *
   * The colour is set through the Inspector's own "Note fill" picker and the text
   * through its Annotation textarea, because those are the only surfaces a user has —
   * and because a note authored any other way would not prove that what the UI
   * writes is what the codec stores.
   */
  const authorNote = async (page, hex, text) => {
    await key("n", "KeyN", "n");
    await mouseClick(page.x + Math.round(page.w * 0.16), page.y + Math.round(page.h * 0.24));
    await sleep(600);
    const trigger = 'button[aria-label^="Note fill"]';
    const hasTrigger = (await evaluate(`Boolean(document.querySelector(${JSON.stringify(trigger)}))`)) === true;
    if (!hasTrigger) return { ok: false, why: "the Inspector showed no Note fill control" };
    await clickSelector(trigger);
    await sleep(400);
    const setHex = await setFieldAndCommit('input[aria-label="Hex colour value"]', hex, () =>
      key("Enter", "Enter", "\r"),
    );
    if (setHex !== "ok") return { ok: false, why: `hex field: ${setHex}` };
    await key("Escape", "Escape");
    await sleep(400);
    if (text !== null) {
      const setText = await setFieldAndCommit('textarea[data-editor-text-input="true"]', text, () =>
        key("Tab", "Tab"),
      );
      if (setText !== "ok") return { ok: false, why: `note textarea: ${setText}` };
      /*
       * Focus has to LEAVE the textarea, not just receive a Tab. `useShortcuts`
       * suppresses every binding while `e.target` is a text input, so a caret left
       * in the note's textarea silently swallows the next tool letter and the next
       * Ctrl+= — a CDP Tab does not move focus the way a real one does. The blur is
       * also the textarea's own commit path, so the text is committed by it.
       */
      await evaluate(`(() => { document.activeElement && document.activeElement.blur(); return true; })()`);
    }
    await sleep(500);
    return { ok: true };
  };

  /** Clicks Save to Workspace, and retries once if the save reported a retryable failure. */
  const saveToWorkspace = async () => {
    const clicked = await clickLabel("save to workspace", "button");
    if (!clicked) return { clicked: false, banner: null, retried: false };
    await sleep(SAVE_WAIT_MS);
    let banner = await saveBanner();
    let retried = false;
    if (!/saved to your workspace/i.test(banner?.text || "")) {
      // The known ingestion race: a save issued while the import version is still
      // being written answers 409. The product's own affordance is Retry; using it
      // is what a user would do, and the retry is reported rather than hidden.
      if (await clickLabel("retry", "button")) {
        retried = true;
        await sleep(SAVE_WAIT_MS);
        banner = await saveBanner();
      }
    }
    return { clicked: true, banner, retried };
  };

  /* ======================================================================== */
  console.log(`\nurl: ${BASE}   chrome: ${CHROME}   scenarios: ${ONLY.join(",")}\n`);
  console.log(`=============== ACCOUNT ===============\n`);

  await goto("/register", 3800);
  check("the local draft store starts empty", (await clearDrafts()) === false);
  const stamp = Date.now();
  const email = `phase3.${stamp}@example.test`;
  await field("name", "Phase Three Prober");
  await field("email", email);
  await field("password", "Phase3-Probe-Password!");
  await field("confirmPassword", "Phase3-Probe-Password!");
  await evaluate(`document.querySelector('input[name="acceptedTerms"]')?.click()`);
  await clickLabel("^create account$", "button");
  await sleep(7000);
  check(
    "registering lands the prober in the authenticated app",
    /\/workspaces/.test(String(await evaluate(`location.pathname`))),
    String(await evaluate(`location.pathname`)),
  );
  await goto("/workspaces", 3800);
  const ids = await evaluate(`(() => {
    const a = [...document.querySelectorAll('a[href*="organizationId="]')].find((x) => /\\/workspaces\\//.test(x.getAttribute('href') || ''));
    if (!a) return null;
    const u = new URL(a.href);
    return { workspaceId: u.pathname.split('/')[2], organizationId: u.searchParams.get('organizationId') };
  })()`);
  check("the account has a Workspace to save into", Boolean(ids?.workspaceId && ids?.organizationId), JSON.stringify(ids));
  if (!ids?.workspaceId) throw new Error("no workspace resolved for the probe account");
  const workspaceUrl = (documentId) =>
    `/workspaces/${ids.workspaceId}/documents/${documentId}?organizationId=${encodeURIComponent(ids.organizationId)}`;

  /* ======================================================================== */
  if (runs("C")) {
    console.log(`\n=============== C. "SAVED ON THIS DEVICE" MEANS THE WHOLE DOCUMENT ===============\n`);
    /*
     * The LOCAL half, in a real browser: a real IndexedDB write, a real reload, a
     * real restore. T12 proves the repository's round trip against a substituted
     * key-value store; only this proves the store the product actually writes to.
     */
    await goto("/workspaces", 3500);
    check("C: the draft store is empty before anything is authored", (await clearDrafts()) === false);
    await goto("/editor");
    check("C: the editor opened with no recovery dialog standing over it",
      (await evaluate(`document.querySelector('[role="dialog"], [role="alertdialog"]') === null`)) === true);
    check("C: a deterministic source PDF opens through the editor's own file input",
      (await openPdf(FIXTURE_C)) === true);
    const pageC = await pageRect();
    check("C: the opened page is on screen", Boolean(pageC && pageC.w > 200), JSON.stringify(pageC));
    /*
     * Opening a PDF EXTRACTS its own text into editable objects (`loadPdfIntoEditor`
     * → `extractTextObjects`), so the object count starts at the number of extracted
     * lines, not at zero. Every count below is relative to that baseline; a probe
     * that hard-coded 1 would fail on a fixture with text on it and pass on a
     * fixture with none, which is the wrong way round.
     */
    const baseC = await countObjects();
    check("C: the source page's own text opened as editable objects (the baseline)",
      baseC >= 1, `baseline=${baseC}`);

    const authoredC = await authorNote(pageC, NOTE_FILL_HEX, NOTE_TEXT);
    check("C: a note was authored through the Inspector", authoredC.ok, authoredC.why ?? "");
    check("C: authoring the note added exactly one object", (await countObjects()) === baseC + 1,
      `${baseC} -> ${await countObjects()}`);

    await sleep(AUTOSAVE_GRACE_MS);
    const liveC = await draftState();
    const noteC = noteOf(liveC?.scene ?? null);
    check(
      'C: "Saved on this device" is backed by a snapshot holding the note as an ANNOTATION',
      noteC?.object?.kind === "annotation" && noteC?.object?.text === NOTE_TEXT,
      `snapshots=${liveC?.snapshots} kind=${noteC?.object?.kind ?? "<none>"}`,
    );
    check(
      "C: and that snapshot carries the note's PANEL as document data",
      Boolean(noteC?.object?.background) &&
        colorMatches(noteC.object.background, NOTE_FILL) &&
        noteC.object.borderWidth >= 0 &&
        typeof noteC.object.cornerRadius === "number",
      `background=${canon(noteC?.object?.background ?? null)}`,
    );
    check(
      "C ANTI-VACUITY: the stored colour is the AUTHORED one, not the model default",
      !colorMatches(noteC?.object?.background ?? { r: -1, g: -1, b: -1 }, DEFAULT_ANNOTATION_BACKGROUND),
      `authored=${canon(noteC?.object?.background ?? null)} default=${canon({ r: DEFAULT_ANNOTATION_BACKGROUND.r, g: DEFAULT_ANNOTATION_BACKGROUND.g, b: DEFAULT_ANNOTATION_BACKGROUND.b })}`,
    );
    const beforeReload = notePrint(noteC?.object ?? null);
    await shot("c-authored");

    await goto("/editor", 5000);
    const offered = await evaluate(`(() => {
      const el = document.querySelector('[role="dialog"], [role="alertdialog"]');
      return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) : null;
    })()`);
    check("C: a reload offers the draft back", typeof offered === "string" && offered.length > 0, String(offered));
    check("C: and the offer is taken through the product's own control",
      await clickLabel("restore my changes", "button"));
    await sleep(6000);

    check("C: the restored document has every object back on the canvas",
      (await countObjects()) === baseC + 1, `${baseC + 1} -> ${await countObjects()}`);
    const restoredDom = await domObject(noteC?.id ?? "");
    check(
      "C: the restored note draws its CONTAINER, not bare text",
      restoredDom?.hasPanel === true && /^rgba\(255,212,0/.test(String(restoredDom?.fill)),
      `fill=${restoredDom?.fill} text=${restoredDom?.hasPanel}`,
    );
    check("C: and the note's text is on the canvas too", String(restoredDom?.text || "") === NOTE_TEXT);

    /*
     * The canonical comparison, which is the only one that can fail for the right
     * reason: every property of the note, before the reload and after the restore.
     */
    await sleep(AUTOSAVE_GRACE_MS);
    const afterReload = notePrint(noteOf((await draftState())?.scene ?? null)?.object ?? null);
    const driftC = diffNote(beforeReload, afterReload);
    check("C: the recovered note is the same note, property for property", driftC.length === 0, driftC.join(" | "));
    await shot("c-restored");
  }

  /**
   * A box as a FRACTION of the page it sits on.
   *
   * The standalone editor and the reopened Workspace editor fit the page at their
   * own zoom, so raw client pixels are two different scales of the same geometry.
   * Comparing fractions of the page compares the document's geometry, which is the
   * thing that has to survive; it is also how the probe can tell zoom apart from a
   * moved object at all.
   */
  const norm = (box, page) =>
    box && page && page.w > 0 && page.h > 0
      ? { x: (box.x - page.x) / page.w, y: (box.y - page.y) / page.h, w: box.w / page.w, h: box.h / page.h }
      : null;
  const nearBox = (a, b, tol = 0.012) =>
    Boolean(a && b) &&
    Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol &&
    Math.abs(a.w - b.w) <= tol && Math.abs(a.h - b.h) <= tol;
  const show = (b) => (b ? `{x:${b.x.toFixed(3)} y:${b.y.toFixed(3)} w:${b.w.toFixed(3)} h:${b.h.toFixed(3)}}` : "null");

  /* ======================================================================== */
  let documentId = null;
  if (runs("A")) {
    console.log(`\n=============== A. THE RECORDED REGRESSION, END TO END ===============\n`);
    /*
     * The exact recording: a yellow note authored in the editor, saved to a
     * Workspace, reopened, and exported. The text survived the original defect; the
     * container did not. Every step below is a step of that recording.
     */
    await goto("/workspaces", 3500);
    check("A: the draft store is empty before authoring", (await clearDrafts()) === false);
    await goto("/editor");
    check("A1: a deterministic source PDF opens in the editor", (await openPdf(FIXTURE_A)) === true);
    const pageA = await pageRect();
    /* The extraction baseline — see scenario C. */
    const baseA = await countObjects();
    check("A1: the page is on screen, with its own text as the object baseline",
      Boolean(pageA && pageA.w > 200) && baseA >= 1, `${JSON.stringify(pageA)} baseline=${baseA}`);

    const authoredA = await authorNote(pageA, NOTE_FILL_HEX, NOTE_TEXT);
    check("A2: a note is authored, given a clearly visible yellow panel and text", authoredA.ok, authoredA.why ?? "");
    check("A2: exactly one object was added", (await countObjects()) === baseA + 1,
      `${baseA} -> ${await countObjects()}`);

    /* ---- A3. What the live model holds, before any boundary --------------- */
    await sleep(AUTOSAVE_GRACE_MS);
    const liveScene = (await draftState())?.scene ?? null;
    const liveNote = noteOf(liveScene);
    check(
      "A3: the live canonical model holds the note as an annotation with a panel",
      liveNote?.object?.kind === "annotation" && colorMatches(liveNote.object.background ?? { r: -1, g: 0, b: 0 }, NOTE_FILL),
      `kind=${liveNote?.object?.kind} background=${canon(liveNote?.object?.background ?? null)}`,
    );
    const livePrint = notePrint(liveNote?.object ?? null);

    /*
     * The note is addressed by its CANONICAL id from here on, never by DOM position:
     * the page's extracted text objects are on the canvas too, and reading
     * "whatever is first" is how a probe ends up asserting the source text's box.
     */
    const domLive = await domObject(liveNote?.id ?? "");
    check(
      "A2: the live canvas draws the yellow container AND the text",
      domLive?.hasPanel === true && /^rgba\(255,212,0/.test(String(domLive?.fill)) && String(domLive?.text) === NOTE_TEXT,
      `fill=${domLive?.fill} textPresent=${String(domLive?.text) === NOTE_TEXT}`,
    );
    const liveBox = norm(domLive?.box, pageA);
    await shot("a-authored");

    /* ---- A4. T15: zoom is a view, and must not touch the document -------- */
    const zoomBefore = await zoomLevel();
    await key("=", "Equal", "=", 2);
    await key("=", "Equal", "=", 2);
    await sleep(900);
    const zoomAfter = await zoomLevel();
    check("A4 (T15) PRECONDITION: the zoom really changed", Boolean(zoomBefore && zoomAfter && zoomBefore !== zoomAfter),
      `${zoomBefore} -> ${zoomAfter}`);
    const zoomedPrint = notePrint(noteOf((await draftState())?.scene ?? null)?.object ?? null);
    const zoomDrift = diffNote(livePrint, zoomedPrint);
    check("A4 (T15): zooming changed NO persisted geometry", zoomDrift.length === 0, zoomDrift.join(" | "));

    /* ---- A5. The Workspace save ------------------------------------------ */
    const save1 = await saveToWorkspace();
    /*
     * On the FIRST attempt, and that is part of the claim. A first save is create +
     * scene commit, and the commit used to read the revision before the upload's own
     * ingestion bumped it — so the first save of a document reported a conflict
     * nobody had caused, and only the Retry succeeded. `retried` is asserted false
     * so that regression cannot hide behind the affordance again.
     */
    check("A5: the first Workspace save succeeds, without needing the Retry",
      /saved to your workspace/i.test(save1.banner?.text || "") && save1.retried === false,
      `retried=${save1.retried} ${JSON.stringify(save1.banner)}`);
    const docs = await listDocuments(ids.workspaceId, ids.organizationId);
    check("A5: it created exactly one document", docs?.count === 1, JSON.stringify(docs?.count));
    documentId = docs?.ids?.[0] ?? null;
    /*
     * The ingestion boundary, stated as the probe actually finds it: the first save
     * writes the imported source as version 1 (whose manifest carries no
     * `editorStateKey` by construction) and the edited scene as a version of its
     * own. So the document's CURRENT editable state is readable immediately after
     * the first save — the checkpoint the editor reopens from is never the import
     * version. Both facts are asserted, because "a scene exists" and "the scene is
     * on a later version than the import" are different claims.
     */
    const versionsAfterFirst = await listVersions(ids.workspaceId, documentId, ids.organizationId);
    const sceneAfterFirst = await savedState(ids.workspaceId, documentId, ids.organizationId);
    check(
      "A5: the first save leaves the document with a readable editable scene",
      sceneAfterFirst?.status === 200 &&
        noteOf(sceneAfterFirst?.scene ?? null)?.object?.kind === "annotation",
      `status=${sceneAfterFirst?.status} versions=${JSON.stringify(versionsAfterFirst?.numbers)}`,
    );
    check(
      "A5: on a version LATER than the imported source, which carries no scene",
      Number(sceneAfterFirst?.version ?? 0) > 1 && (versionsAfterFirst?.count ?? 0) >= 2,
      `sceneVersion=${sceneAfterFirst?.version} count=${versionsAfterFirst?.count}`,
    );
    const save2 = await saveToWorkspace();
    check("A5: the second save of the same session succeeds",
      /saved to your workspace/i.test(save2.banner?.text || ""), `retried=${save2.retried} ${JSON.stringify(save2.banner)}`);
    const savedScene = await savedState(ids.workspaceId, documentId, ids.organizationId);
    check("A5: and THAT version carries the editable scene", savedScene?.status === 200, `status=${savedScene?.status}`);
    const savedNote = noteOf(savedScene?.scene ?? null);
    const savedDrift = diffNote(livePrint, notePrint(savedNote?.object ?? null));
    check(
      "A5 (stage E): the scene the Workspace stored is the same note, property for property",
      savedDrift.length === 0,
      savedDrift.join(" | "),
    );

    /* ---- A6. The Phase 2 committed state, unchanged ---------------------- */
    const committed = await surfaces();
    check(
      "A6: the editor reports the work committed AS A VERSION (Phase 2, still true)",
      /as version \d+/i.test(committed?.bar?.detail || "") && committed?.bar?.label === committed?.pill?.label,
      JSON.stringify(committed?.bar),
    );

    /* ---- A7. Navigate away, reopen --------------------------------------- */
    await goto("/workspaces", 4000);
    check("A7: the prober navigated away from the editor",
      (await evaluate(`document.querySelectorAll('main svg [data-object-id]').length`)) === 0);
    await goto(workspaceUrl(documentId), 9000);
    const conflictA = await answerBlockingDialog();
    if (conflictA !== "absent") console.log(`      (reopen raised the conflict dialog: ${conflictA})`);
    await sleep(3000);
    check("A8: the reopened document has every object back", (await countObjects()) === baseA + 1,
      `${baseA + 1} -> ${await countObjects()}`);
    const reopenedIds = await domOrder();
    check(
      "A8: with the SAME object id it was authored with — no regenerated identity",
      Array.isArray(reopenedIds) && reopenedIds.includes(liveNote?.id),
      `${liveNote?.id} -> ${JSON.stringify(reopenedIds)}`,
    );
    const domReopened = await domObject(liveNote?.id ?? "");
    check(
      "A9 (THE REGRESSION): the reopened note still draws its YELLOW CONTAINER",
      domReopened?.hasPanel === true && /^rgba\(255,212,0/.test(String(domReopened?.fill)),
      `fill=${domReopened?.fill}`,
    );
    check("A10: and the note's text is still there", String(domReopened?.text || "") === NOTE_TEXT);
    const pageReopened = await pageRect();
    const reopenedBox = norm(domReopened?.box, pageReopened);
    check(
      "A11: the note is the same size, in the same place on the page, at whatever zoom the reopened editor chose",
      nearBox(liveBox, reopenedBox),
      `${show(liveBox)} -> ${show(reopenedBox)} zoom=${await zoomLevel()}`,
    );
    await shot("a-reopened");

    /* ---- A12. Export from the reopened model ----------------------------- */
    await installExportCapture();
    const exported = await exportAndRead();
    check("A12: the reopened document exports a PDF", exported.clicked && exported.pdf === true && Boolean(exported.pages?.length),
      `bytes=${exported.byteLength ?? 0} pages=${exported.pages?.length ?? 0}`);
    const pdfPage = exported.pages?.[0];
    check(
      "A13 (THE REGRESSION, EXPORTED): the PDF fills the note's panel in the authored yellow",
      Boolean(pdfPage?.fills.some((c) => colorMatches(c, NOTE_FILL))),
      `fills=${JSON.stringify(pdfPage?.fills?.slice(0, 6) ?? [])}`,
    );
    check(
      "A13: and paints it as a path, rather than only setting a colour",
      Boolean(pdfPage?.paints.includes("B") || pdfPage?.paints.includes("f")),
      `paints=${JSON.stringify(pdfPage?.paints?.slice(0, 8) ?? [])}`,
    );
    check(
      "A14: the exported PDF shows the note's text as well as its container",
      Boolean(pdfPage?.texts.some((t) => t.includes(NOTE_TEXT))),
      `texts=${(pdfPage?.texts ?? []).length}`,
    );
    check(
      "A14 (T17): and the ORIGINAL page's own text and graphics are still underneath",
      Boolean(pdfPage?.texts.some((t) => t.includes("SOURCE PAGE ONE"))) &&
        Boolean(pdfPage?.fills.some((c) => colorMatches(c, { r: 0.15, g: 0.35, b: 0.85 }))),
      `sourceText=${Boolean(pdfPage?.texts.some((t) => t.includes("SOURCE PAGE ONE")))}`,
    );
  }

  /* ======================================================================== */
  let documentB = null;
  if (runs("B")) {
    console.log(`\n=============== B. A COMPLEX DOCUMENT, ACROSS THE SAME BOUNDARY ===============\n`);
    /*
     * One note proves the recorded regression. It does not prove that the OTHER
     * object kinds survive, that they come back in the order they were painted in,
     * or that they stay on the page they were drawn on. This scenario authors one of
     * several kinds across two pages and compares the document, not a count.
     */
    await goto("/workspaces", 3500);
    check("B: the draft store is empty before authoring", (await clearDrafts()) === false);
    const docsBeforeB = await listDocuments(ids.workspaceId, ids.organizationId);
    await goto("/editor");
    check("B: a two-page source PDF opens in the editor", (await openPdf(FIXTURE_B)) === true);
    const pageB = await pageRect();
    check("B: page one is on screen", Boolean(pageB && pageB.w > 200), JSON.stringify(pageB));

    const baseB1 = await countObjects();
    const at = (fx, fy) => ({ x: pageB.x + Math.round(pageB.w * fx), y: pageB.y + Math.round(pageB.h * fy) });
    // Authored bottom-first, so creation order IS the expected paint order.
    /*
     * Escape (clearSelection) between gestures, and every gesture in its own
     * region of the page. MEASURED: a newly created object stays SELECTED, its
     * resize handles are live elements, and a drag that starts on one of them is
     * a `resize` gesture — the canvas's own pointer-down never runs. The freehand
     * stroke was starting inside the highlight drawn a moment earlier, so it
     * resized that highlight and committed no drawing at all: the gesture trace
     * read `["move","resize",...]` with no `draw-begin`. A box tool hid this,
     * because it commits from pointer-down and pointer-up alone.
     */
    const clearSel = () => key("Escape", "Escape", "\u001b");
    await key("r", "KeyR", "r");
    await drag(at(0.08, 0.5).x, at(0.08, 0.5).y, at(0.08, 0.5).x + 150, at(0.08, 0.5).y + 100);
    await clearSel();
    await key("o", "KeyO", "o");
    await drag(at(0.45, 0.5).x, at(0.45, 0.5).y, at(0.45, 0.5).x + 130, at(0.45, 0.5).y + 110);
    await clearSel();
    await key("g", "KeyG", "g");
    await drag(at(0.1, 0.72).x, at(0.1, 0.72).y, at(0.1, 0.72).x + 200, at(0.1, 0.72).y + 30);
    await clearSel();
    await key("d", "KeyD", "d");
    await drag(at(0.55, 0.18).x, at(0.55, 0.18).y, at(0.55, 0.18).x + 110, at(0.55, 0.18).y + 55);
    await clearSel();
    await key("t", "KeyT", "t");
    await mouseClick(at(0.12, 0.86).x, at(0.12, 0.86).y);
    await sleep(500);
    await typeText("complex line one\ncomplex line two");
    await key("Enter", "Enter", "\r", 2);
    await sleep(700);
    check("B: five objects were authored on top of the page's own extracted text",
      (await countObjects()) === baseB1 + 5, `${baseB1} -> ${await countObjects()}`);
    const authoredB = await authorNote(pageB, NOTE_FILL_HEX, NOTE_TEXT);
    check("B: and a note with an authored panel on top of them", authoredB.ok, authoredB.why ?? "");
    check("B: page one holds all six authored objects", (await countObjects()) === baseB1 + 6,
      `${baseB1} -> ${await countObjects()}`);

    /* A second page, with an object of its own. */
    await key("PageDown", "PageDown");
    await sleep(1200);
    const page2B = await pageRect();
    const baseB2 = await countObjects();
    check("B: the second page is reachable and carries only its own extracted text",
      Boolean(page2B) && baseB2 >= 1 && baseB2 < baseB1 + 6, `baseline=${baseB2}`);
    await key("r", "KeyR", "r");
    await drag(
      page2B.x + Math.round(page2B.w * 0.3), page2B.y + Math.round(page2B.h * 0.3),
      page2B.x + Math.round(page2B.w * 0.3) + 140, page2B.y + Math.round(page2B.h * 0.3) + 90,
    );
    check("B: page two holds exactly the one object drawn on it", (await countObjects()) === baseB2 + 1,
      `${baseB2} -> ${await countObjects()}`);

    await sleep(AUTOSAVE_GRACE_MS);
    const liveB = (await draftState())?.scene ?? null;
    const liveKindsB = kindsOf(liveB);
    const liveOrderB = pagesOf(liveB).map((p) => paintIds(p));
    check(
      "B: the live model holds two pages, with each page's own objects on it",
      liveKindsB.length === 2 && liveKindsB[0].length === baseB1 + 6 && liveKindsB[1].length === baseB2 + 1,
      JSON.stringify(liveKindsB),
    );
    check(
      "B ANTI-VACUITY: those are genuinely DIFFERENT kinds, not six rectangles",
      new Set(liveKindsB[0] ?? []).size >= 5 && (liveKindsB[0] ?? []).includes("annotation"),
      JSON.stringify(liveKindsB[0]),
    );
    const liveNoteB = noteOf(liveB);
    const noteIdB = liveNoteB?.id ?? null;

    const saveB1 = await saveToWorkspace();
    check("B: the complex document saves to the Workspace", /saved to your workspace/i.test(saveB1.banner?.text || ""),
      JSON.stringify(saveB1.banner));
    const docsAfterB = await listDocuments(ids.workspaceId, ids.organizationId);
    documentB = (docsAfterB?.ids ?? []).find((x) => !(docsBeforeB?.ids ?? []).includes(x)) ?? null;
    check("B: as a new document of its own", Boolean(documentB), `ids=${JSON.stringify(docsAfterB?.ids)}`);
    const saveB2 = await saveToWorkspace();
    check("B: and a second save attaches the editable scene",
      /saved to your workspace/i.test(saveB2.banner?.text || ""), `retried=${saveB2.retried}`);

    const storedB = await savedState(ids.workspaceId, documentB, ids.organizationId);
    check("B (stage E): the Workspace holds a scene for it", storedB?.status === 200, `status=${storedB?.status}`);
    check(
      "B (T6/T7/T8/T3): every kind came back as ITSELF, in the order it was painted in",
      canon(kindsOf(storedB?.scene ?? null)) === canon(liveKindsB),
      `${JSON.stringify(liveKindsB)} -> ${JSON.stringify(kindsOf(storedB?.scene ?? null))}`,
    );
    check(
      "B (T9): with the same object ids in the same z-order, page by page",
      canon(pagesOf(storedB?.scene ?? null).map((p) => paintIds(p))) === canon(liveOrderB),
      "the layer arrays are compared as data, never re-derived from kind",
    );
    check(
      "B (T10): and each page kept its own objects and its own source page index",
      canon(pagesOf(storedB?.scene ?? null).map((p) => p.sourcePageIndex)) ===
        canon(pagesOf(liveB).map((p) => p.sourcePageIndex)),
      canon(pagesOf(storedB?.scene ?? null).map((p) => p.sourcePageIndex)),
    );

    await goto("/workspaces", 4000);
    await goto(workspaceUrl(documentB), 9000);
    const conflictB = await answerBlockingDialog();
    if (conflictB !== "absent") console.log(`      (reopen raised the conflict dialog: ${conflictB})`);
    await sleep(3000);
    /*
     * The document was saved with page TWO active, and the scene names its own
     * active page — so a faithful reopen opens on page two. Asserted rather than
     * navigated around: which page the canvas shows is saved state too, and a probe
     * that pressed PageUp first would never notice it being lost.
     */
    check(
      "B (T10, on screen): the reopened document opens on the page it was saved on, with that page's objects",
      (await countObjects()) === baseB2 + 1 && canon(await domOrder()) === canon(liveOrderB[1]),
      `${JSON.stringify(liveOrderB[1])} -> ${JSON.stringify(await domOrder())}`,
    );
    await key("PageUp", "PageUp");
    await sleep(1600);
    check("B: and page one still holds every object authored on it", (await countObjects()) === baseB1 + 6,
      `${baseB1 + 6} -> ${await countObjects()}`);
    check(
      "B (T9, on screen): the canvas paints them in the persisted order",
      canon(await domOrder()) === canon(liveOrderB[0]),
      `${JSON.stringify(liveOrderB[0])} -> ${JSON.stringify(await domOrder())}`,
    );
    const domNoteB = await domObject(noteIdB ?? "");
    check("B: the note in the complex document still has its container and text",
      domNoteB?.hasPanel === true && /^rgba\(255,212,0/.test(String(domNoteB?.fill)) && String(domNoteB?.text) === NOTE_TEXT,
      `fill=${domNoteB?.fill}`);
    await shot("b-reopened");

    await installExportCapture();
    const exportedB = await exportAndRead();
    await shot("b-after-export");
    check("B: the reopened complex document exports two pages",
      exportedB.pdf === true && exportedB.pages?.length === 2,
      `clicked=${exportedB.clicked} pdf=${exportedB.pdf} bytes=${exportedB.byteLength} pages=${exportedB.pages?.length ?? 0} ${exportedB.why ?? ""}`);
    const [p1, p2] = exportedB.pages ?? [];
    check(
      "B: page one of the export carries its own source text, the note's panel and the note's text",
      Boolean(p1?.texts.some((t) => t.includes("SOURCE PAGE ONE"))) &&
        Boolean(p1?.fills.some((c) => colorMatches(c, NOTE_FILL))) &&
        Boolean(p1?.texts.some((t) => t.includes(NOTE_TEXT))),
      `sourceText=${Boolean(p1?.texts.some((t) => t.includes("SOURCE PAGE ONE")))}`,
    );
    check(
      "B: page two carries ITS source text and NOT page one's note — objects did not migrate",
      Boolean(p2?.texts.some((t) => t.includes("SOURCE PAGE TWO"))) &&
        !p2?.texts.some((t) => t.includes(NOTE_TEXT)) &&
        !p2?.fills.some((c) => colorMatches(c, NOTE_FILL)),
      `texts=${(p2?.texts ?? []).length}`,
    );
  }

  /* ======================================================================== */
  let documentD = null;
  if (runs("D")) {
    console.log(`\n=============== D. A SECOND VERSION MUST NOT LOSE THE FIRST'S DOCUMENT ===============\n`);
    /*
     * Two versions of ONE document, from one session. What must hold: the newer
     * version shows the changed value, the version that held the old value is still
     * readable and still holds it, and nothing else about the note moved. No
     * version-history UI is involved — the older version is read through the same
     * route the editor uses.
     *
     * Self-contained rather than a continuation of B's document, because of a
     * product fact this scenario had to be rewritten around: a further Workspace
     * VERSION can only be committed by "Save to Workspace" in the standalone editor
     * shell (StandaloneEditorShell -> /versions/upload), and only the same tab
     * session writes to the same document. The Workspace document surface autosaves
     * DRAFTS, which by design do not create a document revision, so a second version
     * can never appear from there. Recorded in the report, not worked around.
     */
    await goto("/workspaces", 3500);
    check("D: the draft store is empty before authoring", (await clearDrafts()) === false);
    const docsBeforeD = await listDocuments(ids.workspaceId, ids.organizationId);
    await goto("/editor");
    check("D: a source PDF opens in the editor", (await openPdf(FIXTURE_A)) === true);
    const pageD = await pageRect();
    check("D: page one is on screen", Boolean(pageD && pageD.w > 200), JSON.stringify(pageD));
    const authoredD = await authorNote(pageD, NOTE_FILL_HEX, NOTE_TEXT);
    check("D: a note with an authored yellow panel exists", authoredD.ok, authoredD.why ?? "");
    await sleep(AUTOSAVE_GRACE_MS);
    const noteIdD = noteOf((await draftState())?.scene ?? null)?.id ?? null;
    check("D: the live model holds it", Boolean(noteIdD), `id=${noteIdD}`);

    const saveD1 = await saveToWorkspace();
    check("D: the document saves to the Workspace", /saved to your workspace/i.test(saveD1.banner?.text || ""),
      JSON.stringify(saveD1.banner));
    const docsAfterD = await listDocuments(ids.workspaceId, ids.organizationId);
    documentD = (docsAfterD?.ids ?? []).find((x) => !(docsBeforeD?.ids ?? []).includes(x)) ?? null;
    check("D: as a new document of its own", Boolean(documentD), `ids=${JSON.stringify(docsAfterD?.ids)}`);
    const saveD2 = await saveToWorkspace();
    check("D: and a second save attaches the editable scene",
      /saved to your workspace/i.test(saveD2.banner?.text || ""), `retried=${saveD2.retried}`);

    const versionsBefore = await listVersions(ids.workspaceId, documentD, ids.organizationId);
    const beforeD = await savedState(ids.workspaceId, documentD, ids.organizationId);
    const oldVersion = Number(beforeD?.version ?? 0);
    const printD = notePrint(noteOf(beforeD?.scene ?? null)?.object ?? null);
    check("D PRECONDITION: that version is readable and holds the yellow note",
      oldVersion > 0 &&
        colorMatches(noteOf(beforeD?.scene ?? null)?.object?.background ?? { r: -1, g: 0, b: 0 }, NOTE_FILL),
      `version=${oldVersion}`);

    /*
     * The fill control exists only while the note is SELECTED, and only on the
     * Inspector's Properties tab. Saving does not clear the selection, so the
     * trigger is usually still there — but when it is not, the note is selected the
     * way a user would select it rather than the change being skipped.
     */
    const blockingD = await answerBlockingDialog();
    if (blockingD !== "absent") console.log(`      (a dialog stood over the canvas: ${blockingD})`);
    const boxD = (await domObject(noteIdD ?? ""))?.box ?? null;
    check("D: the note is on screen to be selected", Boolean(boxD), JSON.stringify(boxD));
    const hasFillTrigger = async () =>
      (await evaluate(`Boolean(document.querySelector('button[aria-label^="Note fill"]'))`)) === true;
    let reselected = "not needed";
    if (!(await hasFillTrigger()) && boxD) {
      await key("v", "KeyV", "v");
      await mouseClick(Math.round(boxD.x + boxD.w / 2), Math.round(boxD.y + boxD.h / 2));
      await sleep(700);
      await clickLabel("^properties$", '[role="tab"]');
      await sleep(400);
      reselected = String(await hasFillTrigger());
    }
    const triggerD = await evaluate(`(() => {
      const b = document.querySelector('button[aria-label^="Note fill"]');
      return b ? b.getAttribute("aria-label") : null;
    })()`);
    const openedD = await clickSelector('button[aria-label^="Note fill"]');
    await sleep(500);
    const recoloured = await setFieldAndCommit('input[aria-label="Hex colour value"]', NOTE_FILL_HEX_2, () =>
      key("Enter", "Enter", "\r"),
    );
    await key("Escape", "Escape");
    await sleep(700);
    check("D: the note's fill can be changed", recoloured === "ok",
      `tabs=${await inspectorTabs()} reselected=${reselected} trigger=${triggerD} opened=${openedD} viaPicker=${recoloured}`);
    await shot("d-note-recoloured");
    const domChangedD = await domObject(noteIdD ?? "");
    check("D: the canvas shows the new colour", /^rgba\(59,130,246/.test(String(domChangedD?.fill)),
      `fill=${domChangedD?.fill}`);

    const saveD3 = await saveToWorkspace();
    check("D: the change saves as a further version", /saved to your workspace/i.test(saveD3.banner?.text || ""),
      JSON.stringify(saveD3.banner));
    const versionsAfter = await listVersions(ids.workspaceId, documentD, ids.organizationId);
    check("D: the version count grew rather than a version being rewritten",
      (versionsAfter?.count ?? 0) > (versionsBefore?.count ?? 0),
      `${versionsBefore?.count} -> ${versionsAfter?.count}`);

    await goto("/workspaces", 4000);
    await goto(workspaceUrl(documentD), 9000);
    const conflictD = await answerBlockingDialog();
    if (conflictD !== "absent") console.log(`      (reopen raised the conflict dialog: ${conflictD})`);
    await sleep(3000);
    const latest = await savedState(ids.workspaceId, documentD, ids.organizationId);
    const latestNote = noteOf(latest?.scene ?? null)?.object ?? null;
    check(
      "D: reopening gives the LATEST value of the changed property",
      colorMatches(latestNote?.background ?? { r: -1, g: 0, b: 0 }, NOTE_FILL_2),
      `background=${canon(latestNote?.background ?? null)}`,
    );
    const domLatest = await domObject(noteIdD ?? "");
    check("D: and the canvas draws that value", /^rgba\(59,130,246/.test(String(domLatest?.fill)),
      `fill=${domLatest?.fill}`);
    const driftD = diffNote(printD, notePrint(latestNote)).filter((d) => !d.startsWith("background:"));
    check("D: changing one property changed ONLY that property", driftD.length === 0, driftD.join(" | "));
    const older = await savedState(ids.workspaceId, documentD, ids.organizationId, oldVersion);
    check(
      "D: and the earlier version is still readable, still holding the earlier value",
      older?.status === 200 &&
        colorMatches(noteOf(older?.scene ?? null)?.object?.background ?? { r: -1, g: 0, b: 0 }, NOTE_FILL),
      `status=${older?.status} background=${canon(noteOf(older?.scene ?? null)?.object?.background ?? null)}`,
    );
    await shot("d-second-version");
  }

  /* ---- Nothing blew up on the way ---------------------------------------- */
  /*
   * One class of error is EXPECTED and is reported rather than tolerated silently:
   * a save issued while the import version is still being written answers 409, and
   * the product's own affordance is Retry. It is counted so a change in its
   * frequency is visible, and excluded from the failure condition; everything else
   * fails the run.
   */
  const knownConflicts = consoleErrors.filter((e) => /workspace save failed: conflict/i.test(e));
  const noisy = consoleErrors.filter(
    (e) =>
      !/favicon|Failed to load resource|probe|Download is disabled/i.test(e) &&
      !/workspace save failed: conflict/i.test(e),
  );
  console.log(`known ingestion 409s (documented, retried by the product): ${knownConflicts.length}`);
  check("no console errors or uncaught exceptions during the run", noisy.length === 0, noisy.slice(0, 4).join(" | "));
  const serverErrors = responses.filter((r) => r.status >= 500);
  check("no request the page made answered 5xx", serverErrors.length === 0,
    serverErrors.slice(0, 4).map((r) => `${r.status} ${r.url}`).join(" | "));

  console.log(`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} FAILED`}`);
  if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
  console.log(`account: ${email}   workspace: ${ids.workspaceId}   documents: ${[documentId, documentB, documentD].filter(Boolean).join(", ")}`);

  sock.close();
  chrome.kill("SIGKILL");
  spawnSync("pkill", ["-f", `remote-debugging-port=${PORT}`], { stdio: "ignore" });
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  spawnSync("pkill", ["-f", `remote-debugging-port=${PORT}`], { stdio: "ignore" });
  process.exit(1);
});
