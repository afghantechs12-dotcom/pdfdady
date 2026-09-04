/* global process, console, fetch, WebSocket, setTimeout, clearTimeout, Buffer */
/**
 * PERMANENT runtime probe: DOES THE EDITOR TELL THE TRUTH ABOUT THE USER'S WORK?
 *
 * WHY THIS EXISTS. Two defects were recorded in a shipped build, and a fully green
 * suite was compatible with both:
 *
 *  - DEFECT A — characters typed into a text box while the editor reported "No
 *    changes yet". The value lived in React state until blur, so
 *    `CommandHistory.revision` had not moved and every watermark comparison said
 *    the document was untouched.
 *  - DEFECT B — "Unsaved changes" in the app bar beside "Saved on this device" in
 *    the status bar: two independent models of the same fact, both on screen.
 *
 * Neither is reachable from Vitest. `environment: "node"` means no test in this
 * repository has ever focused a textarea, typed a character without blurring it,
 * watched an IndexedDB write land, or had two surfaces of the same status painted
 * at once. So the invariants are asserted HERE, in a real browser, with real input.
 *
 * WHAT WOULD MAKE THIS VACUOUS. Four hazards, each guarded:
 *
 *  - **Nothing was typed.** The uncommitted-input checks are bracketed by a
 *    PRECONDITION that the readout claimed the work safe immediately before the
 *    keystroke, and by an assertion that the object count did NOT change — so the
 *    dirtiness can only have come from the characters.
 *  - **Agreement between two surfaces that render nothing.** `agree()` fails when
 *    either surface is missing or empty, and every milestone prints both strings.
 *  - **A race that never raced.** The delayed-write scenario asserts that a
 *    "saving" state was actually observed during the window; a run where no write
 *    was ever in flight fails.
 *  - **A failure that never failed.** The forced-failure scenario asserts the error
 *    banner appeared AND the document count is unchanged AND the retry then
 *    succeeded — a run where the interception missed the request fails at the first.
 *
 * HOW THE TWO ADVERSARIAL SCENARIOS ARE PRODUCED. Both by TEST-ONLY interception
 * injected into the page, never by a production delay:
 *
 *  - the delayed local write wraps `IDBDatabase.prototype.transaction` so the app
 *    learns of a completed write LATER than it completed. The bytes are written
 *    normally; only the app's knowledge is postponed, which is exactly the shape of
 *    a slow disk.
 *  - the forced Workspace failure wraps `window.fetch` for the version-upload URL
 *    only, so nothing else on the page is affected.
 *
 * IT MUTATES DATA. Scenarios B–D register one throwaway account per run and save
 * into that account's own Workspace, against whatever database the running server
 * uses. It never touches another account's rows. It also clears the local
 * `pdfdadi-drafts` database in its own throwaway Chrome profile.
 *
 * Usage: node scripts/editor-save-state-probe.mjs [--url http://localhost:3001] [--shots]
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = arg("--url", "http://localhost:3001");
const SHOTS = process.argv.includes("--shots");
const SHOT_DIR = "docs/screenshots/save-state";
const CHROME =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9494;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 700ms debounce + 4s ceiling + the write itself. The same margin the sibling probe uses. */
const AUTOSAVE_GRACE_MS = 5200;
/** How late the app is told a local write completed, in the race scenario. */
/*
 * How late a completed local write is allowed to report itself (scenario C).
 *
 * 4000 was too long, and produced a VACUOUS green: one save performs several
 * readwrite transactions, so a per-transaction 4s postponement multiplied past
 * the whole sampling window — the first write never landed inside it, the race
 * the scenario exists to create never happened, and every sample read
 * "Saving locally…". 1200 is long enough that the second edit is made while the
 * first write is still in flight, and short enough that the first write's late
 * completion is observed while the newer revision exists. The scenario now
 * asserts that observation instead of assuming it.
 */
const WRITE_DELAY_MS = 1200;

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), "pdfdadi-savestate-"));
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
  /** Every response the page received, so a 500 cannot hide behind a green check. */
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
      const timer = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), 45_000);
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
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1600, height: 900, deviceScaleFactor: 1, mobile: false,
  });

  const failures = [];
  const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failures.push(name);
  };
  const goto = async (path, wait = 4200) => {
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

  /* --- real input only, never element.click() ------------------------------ */
  const mouseClick = async (x, y, holdMs = 90) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1,
    });
    await sleep(holdMs);
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0,
    });
    await sleep(240);
  };
  const key = async (keyName, code, text, modifiers = 0) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, text, modifiers });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, modifiers });
    await sleep(220);
  };
  /** Real text input into whatever holds focus. */
  const typeText = async (text) => {
    await send("Input.insertText", { text });
    await sleep(160);
  };
  /** A real press-move-release drag, which is how every shape tool commits. */
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
    await sleep(500);
  };
  /** Sets a React-controlled form field the way a keystroke does. */
  const field = (name, value) =>
    evaluate(`(() => {
      const el = document.querySelector('input[name="${name}"]');
      if (!el) return "missing";
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return "ok";
    })()`);
  /** Clicks a control by its visible text, with a real mouse press at its centre. */
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

  /* --- reads --------------------------------------------------------------- */

  const countObjects = () => evaluate(`document.querySelectorAll('main svg [data-object-id]').length`);
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
   * BOTH surfaces that render the save state, read in ONE evaluation.
   *
   * This is the on-screen form of the agreement invariant: the app bar's pill and
   * the status bar's readout are two renderings of the same `SaveStatusView`, so
   * their visible label and their `title` must be identical strings at every
   * moment. Reading them a second apart would let a transition explain away a
   * genuine disagreement, which is exactly how the recorded defect survived.
   *
   * Only the VISIBLE span of the pill is read — it carries a `sm:hidden` short form
   * and an `sr-only` detail alongside the label, and concatenating all three would
   * make any comparison meaningless.
   */
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

  /**
   * Does this wording claim the work is stored? The negative list comes first,
   * because the honest hierarchy copy ("Saved on this device — no cloud backup",
   * "Cloud save failed — your changes are safe on this device") contains the word
   * "saved" while making a WEAKER claim, and a naive /saved/ match would read those
   * as success. Mirrors `claimsStored` in `saveStateAgreement.test.ts`.
   */
  const claimsStored = (text) => {
    const s = String(text || "");
    if (/not saved|no cloud backup|not backed up|failed|pending|couldn't|can't|saving/i.test(s)) {
      return false;
    }
    return /\bsaved\b|backed up/i.test(s);
  };

  /** Both surfaces, asserted to agree, and returned for the caller's own checks. */
  const readAgreed = async (where) => {
    const s = await surfaces();
    const ok =
      Boolean(s?.pill?.label) &&
      Boolean(s?.bar?.label) &&
      s.pill.label === s.bar.label &&
      s.pill.detail === s.bar.detail;
    check(
      `${where}: the app bar pill and the status bar say the SAME thing`,
      ok,
      `pill=${JSON.stringify(s?.pill)} bar=${JSON.stringify(s?.bar)}`,
    );
    return s;
  };

  /**
   * Whether `beforeunload` is armed, observed by dispatching a real cancelable
   * event and reading `defaultPrevented` — the same thing the browser does before
   * showing the leave-site prompt. The runtime's handler also flushes on this
   * event, which is what it would do on a genuine unload; nothing here is faked.
   */
  const unloadArmed = () =>
    evaluate(`(() => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented === true;
    })()`);

  /** Is an inline text editor open, and what does it hold? */
  const textBox = () =>
    evaluate(`(() => {
      const t = document.querySelector('main textarea');
      return t ? { open: true, value: t.value, focused: document.activeElement === t } : { open: false };
    })()`);

  /** Every record in the real draft database, without creating it if absent. */
  const readStore = () =>
    evaluate(`(async () => {
      const names = (await indexedDB.databases()).map((d) => d.name);
      if (!names.includes('pdfdadi-drafts')) return { exists: false, keys: [] };
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('pdfdadi-drafts');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      if (!db.objectStoreNames.contains('entries')) { db.close(); return { exists: true, keys: [] }; }
      const read = (method) => new Promise((res) => {
        const rq = db.transaction('entries', 'readonly').objectStore('entries')[method]();
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => res(null);
      });
      const keys = await read('getAllKeys');
      const values = await read('getAll');
      db.close();
      // A page's \`objects\` is a RECORD keyed by object id, not an array.
      const countScene = (node) => {
        if (Array.isArray(node)) return node.reduce((n, x) => n + countScene(x), 0);
        if (node && typeof node === 'object') {
          let n = 0;
          for (const [k, v] of Object.entries(node)) {
            if (k === 'objects' && v && typeof v === 'object') {
              n += Array.isArray(v) ? v.length : Object.keys(v).length;
              continue;
            }
            n += countScene(v);
          }
          return n;
        }
        return 0;
      };
      const snapshots = [];
      keys.forEach((k, i) => {
        if (!String(k).startsWith('snapshot:')) return;
        const v = values[i];
        snapshots.push({
          origin: v?.manifest?.origin ?? null,
          documentKey: v?.manifest?.documentKey ?? null,
          revision: v?.manifest?.revision ?? null,
          generation: v?.manifest?.generation ?? null,
          sceneObjects: countScene(v?.manifest?.scene ?? null),
        });
      });
      return { exists: true, keys, snapshots };
    })()`);
  /** The newest stored snapshot, which is what a reload would restore. */
  const newestSnapshot = async () =>
    (((await readStore())?.snapshots) ?? []).sort((a, b) => (b.generation ?? 0) - (a.generation ?? 0))[0] ?? null;

  /* --- test-only interception (never a production delay) -------------------- */

  /**
   * Postpones the app's KNOWLEDGE of a completed local write by
   * `window.__probeWriteDelay` ms. The transaction itself runs and commits at full
   * speed — only the `oncomplete` the store awaits is fired late, which is the
   * shape of a slow device and the only way to have a write for revision N land
   * while revision N+1 already exists.
   */
  const installWriteDelay = () =>
    evaluate(`(() => {
      if (window.__probeWriteDelayInstalled) return "already";
      window.__probeWriteDelay = 0;
      const real = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = real.apply(this, args);
        if (args[1] !== 'readwrite') return tx;
        return new Proxy(tx, {
          get(t, prop) {
            const v = t[prop];
            return typeof v === 'function' ? v.bind(t) : v;
          },
          set(t, prop, value) {
            if (prop === 'oncomplete' && typeof value === 'function') {
              t.oncomplete = (ev) => {
                const d = window.__probeWriteDelay || 0;
                if (d > 0) setTimeout(() => value.call(t, ev), d);
                else value.call(t, ev);
              };
              return true;
            }
            t[prop] = value;
            return true;
          },
        });
      };
      window.__probeWriteDelayInstalled = true;
      return "installed";
    })()`);
  const setWriteDelay = (ms) => evaluate(`(window.__probeWriteDelay = ${ms})`);

  /**
   * Fails the Workspace VERSION upload and nothing else. Scoped to one URL fragment
   * so navigation, the draft channel and every other request behave normally.
   */
  const installVersionUploadFailure = () =>
    evaluate(`(() => {
      window.__probeFailVersionUpload = true;
      window.__probeFailedCalls = 0;
      if (window.__probeFetchInstalled) return "already";
      const real = window.fetch;
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (window.__probeFailVersionUpload && /\\/versions\\/upload$/.test(String(url).split('?')[0])) {
          window.__probeFailedCalls += 1;
          return Promise.resolve(
            new Response(JSON.stringify({ error: { code: "INTERNAL", message: "probe" } }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        return real.call(this, input, init);
      };
      window.__probeFetchInstalled = true;
      return "installed";
    })()`);
  const clearVersionUploadFailure = () =>
    evaluate(`(() => { window.__probeFailVersionUpload = false; return window.__probeFailedCalls; })()`);

  /** The Workspace's documents, read through the product's own API with the session cookie. */
  const listDocuments = (workspaceId, organizationId) =>
    evaluate(`(async () => {
      const res = await fetch('/api/workspaces/' + ${JSON.stringify(workspaceId)} +
        '/documents?organizationId=' + encodeURIComponent(${JSON.stringify(organizationId)}) + '&limit=50',
        { headers: { Accept: 'application/json' } });
      const body = await res.json().catch(() => null);
      const items = body?.items ?? body?.documents ?? [];
      return {
        status: res.status,
        count: items.length,
        names: items.map((d) => d.name),
        ids: items.map((d) => d.id),
        revisions: items.map((d) => d.revision ?? null),
      };
    })()`);

  /** The newest version of a document, read through the product's own version API. */
  const latestVersion = (workspaceId, documentId, organizationId) =>
    evaluate(`(async () => {
      const res = await fetch('/api/workspaces/' + ${JSON.stringify(workspaceId)} + '/documents/' +
        ${JSON.stringify(documentId)} + '/versions?organizationId=' +
        encodeURIComponent(${JSON.stringify(organizationId)}) + '&limit=5',
        { headers: { Accept: 'application/json' } });
      const body = await res.json().catch(() => null);
      const versions = body?.versions ?? [];
      return { status: res.status, count: versions.length, versionNumber: versions[0]?.versionNumber ?? null };
    })()`);

  /**
   * The banner the standalone shell shows for an explicit Workspace save.
   *
   * `sr-only` regions are excluded on purpose: the status readout owns a live region
   * with `role="status"`, and matching it here would report a save banner that is not
   * on screen.
   */
  const saveBanner = () =>
    evaluate(`(() => {
      const el = [...document.querySelectorAll('[role="alert"], [role="status"]')].find(
        (n) =>
          !/sr-only/.test(n.className || '') &&
          /workspace|save|permission|too large/i.test(n.textContent || ''),
      );
      if (!el) return { present: false };
      const link = el.querySelector('a[href]');
      return {
        present: true,
        role: el.getAttribute('role'),
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
        href: link ? link.getAttribute('href') : null,
      };
    })()`);

  /* ======================================================================== */
  console.log(`\n=============== A. STANDALONE /editor (GUEST) ===============`);
  console.log(`url: ${BASE}/editor   chrome: ${CHROME}\n`);

  await goto("/editor");
  await installWriteDelay();

  const capabilities = await evaluate(`({
    idb: typeof indexedDB !== 'undefined',
    locks: typeof navigator.locks !== 'undefined',
    channel: typeof BroadcastChannel !== 'undefined',
  })`);
  check(
    "A0: the browser has the APIs the persistence runtime is built on",
    capabilities?.idb === true && capabilities?.locks === true && capabilities?.channel === true,
    JSON.stringify(capabilities),
  );
  const virgin = await readStore();
  check(
    "A0: the draft store holds no records before anything is edited (clean-slate precondition)",
    (virgin?.keys?.length ?? -1) === 0,
    `exists=${virgin?.exists} keys=${virgin?.keys?.length}`,
  );

  /* ---- A1. T1: an untouched editor claims nothing -------------------------- */
  const opened = await readAgreed("A1 (before any document)");
  check(
    "A1: with no document open, both surfaces say so and neither claims anything is saved",
    /no document/i.test(opened?.bar?.label || "") && !claimsStored(opened?.bar?.label),
    JSON.stringify(opened?.bar),
  );
  check("A1: no unload prompt is armed with nothing to lose", (await unloadArmed()) === false);

  const blankClicked = await clickLabel("create blank pdf", "button");
  check("A1: the onboarding overlay offers Create blank PDF", blankClicked);
  await sleep(1500);
  const armed = await readAgreed("A1 (blank page armed)");
  check(
    "A1 (T1): a blank page that has not been touched reads as unchanged, NOT as saved",
    /no changes|nothing to save|unchanged/i.test(armed?.bar?.label || "") &&
      !claimsStored(armed?.bar?.label),
    JSON.stringify(armed?.bar),
  );
  check("A1: still no unload prompt on an untouched blank page", (await unloadArmed()) === false);
  await shot("a1-armed");

  /* ---- A2. T3: a completed gesture is dirty immediately -------------------- */
  const page = await pageRect();
  check("A2: the blank page surface is on screen", Boolean(page && page.w > 200), JSON.stringify(page));
  check("A2: the page starts with no objects (gesture precondition)", (await countObjects()) === 0);

  await key("r", "KeyR", "r");
  const rx = page.x + Math.round(page.w * 0.18);
  const ry = page.y + Math.round(page.h * 0.18);
  await drag(rx, ry, rx + 170, ry + 110);
  check("A2: one real drag commits exactly one object", (await countObjects()) === 1);

  const afterDrag = await readAgreed("A2 (immediately after the drag)");
  check(
    "A2 (T3): a finished gesture reads as unsaved BEFORE any write, on both surfaces",
    /unsaved|not saved/i.test(afterDrag?.bar?.label || "") && !claimsStored(afterDrag?.bar?.label),
    JSON.stringify(afterDrag?.bar),
  );
  check(
    "A2 (T9): work that exists nowhere durable arms the unload prompt",
    (await unloadArmed()) === true,
  );

  /* ---- A3. T4/T10: what "Saved on this device" actually means -------------- */
  await sleep(AUTOSAVE_GRACE_MS);
  const savedLocal = await readAgreed("A3 (after the local write)");
  check(
    "A3 (T4): both surfaces now report the work stored on this device",
    claimsStored(savedLocal?.bar?.label) && /device/i.test(savedLocal?.bar?.label || ""),
    JSON.stringify(savedLocal?.bar),
  );
  const snap1 = await newestSnapshot();
  check(
    "A3 (T10): that claim is backed by a snapshot in the real database holding the user's object",
    snap1 !== null && snap1.sceneObjects === 1 && (snap1.revision ?? 0) > 0 && snap1.origin === "guest",
    JSON.stringify(snap1),
  );
  check(
    "A3 (T9): a durable document does NOT arm the unload prompt (no false positive)",
    (await unloadArmed()) === false,
  );
  await shot("a3-saved-locally");

  /* ---- A4. T2 / DEFECT A: typed characters, no blur, no Enter ------------- */
  /*
   * The recorded defect, reproduced exactly: open a text box, type, and look at the
   * readout WITHOUT clicking away, pressing Enter, switching tool or waiting for a
   * debounce. Two things make this non-vacuous — the state immediately before the
   * keystroke is asserted to claim the work SAFE, and the object count is asserted
   * unchanged across the keystroke, so nothing but the characters can explain the
   * change of status.
   */
  await key("t", "KeyT", "t");
  const tx0 = page.x + Math.round(page.w * 0.2);
  const ty0 = page.y + Math.round(page.h * 0.6);
  await mouseClick(tx0, ty0);
  await sleep(500);
  const opened4 = await textBox();
  check(
    "A4: the text tool opens a focused inline editor",
    opened4?.open === true && opened4?.focused === true,
    JSON.stringify(opened4),
  );
  const beforeType = await readAgreed("A4 (editor open, nothing typed)");
  check(
    "A4 PRECONDITION: opening an empty text box changes nothing, so the readout still claims the work safe",
    claimsStored(beforeType?.bar?.label),
    JSON.stringify(beforeType?.bar),
  );
  const objectsBeforeType = await countObjects();

  await typeText("Hello");
  const typed = await readAgreed("A4 (five characters typed, no blur)");
  check(
    "A4 (T2 / DEFECT A): typed characters make the document unsaved with NO blur, Enter, tool switch or wait",
    !claimsStored(typed?.bar?.label) && /unsaved|not saved/i.test(typed?.bar?.label || ""),
    JSON.stringify(typed?.bar),
  );
  check(
    "A4: and that came from the characters alone — the object count did not move",
    (await countObjects()) === objectsBeforeType,
    `${objectsBeforeType} -> ${await countObjects()}`,
  );
  check(
    "A4 (T9): uncommitted characters arm the unload prompt, because nothing durable holds them",
    (await unloadArmed()) === true,
  );
  const stillOpen = await textBox();
  check(
    "A4: the characters are still in an OPEN editor — nothing committed them to reach this state",
    stillOpen?.open === true && stillOpen?.value === "Hello",
    JSON.stringify(stillOpen),
  );
  await shot("a4-typed-not-committed");

  /* Escape is a real cancel: the characters are abandoned, so the document is
     exactly as durable as it was before the box was opened. */
  await key("Escape", "Escape");
  await sleep(600);
  const cancelled = await readAgreed("A4 (typing abandoned)");
  check(
    "A4: abandoning the characters returns the readout to the durable state (no cry-wolf)",
    claimsStored(cancelled?.bar?.label) && (await countObjects()) === objectsBeforeType,
    JSON.stringify(cancelled?.bar),
  );

  /* Now commit for real, so the rest of the run has two objects to save. */
  await key("t", "KeyT", "t");
  await mouseClick(tx0, ty0);
  await sleep(500);
  await typeText("Hello");
  await key("Enter", "Enter", "\r", 2); // Ctrl+Enter — commit without leaving the canvas
  await sleep(700);
  check("A4: Ctrl+Enter commits the text as one object", (await countObjects()) === 2);
  await sleep(AUTOSAVE_GRACE_MS);
  const savedText = await readAgreed("A4 (committed text stored)");
  const snap2 = await newestSnapshot();
  check(
    "A4: the committed text reaches the same durable store as the shape",
    claimsStored(savedText?.bar?.label) && snap2?.sceneObjects === 2,
    `label=${savedText?.bar?.label} snapshot=${JSON.stringify(snap2)}`,
  );

  /* ======================================================================== */
  console.log(`\n=============== C. DELAYED-WRITE RACE (test-only interception) ===============\n`);
  /*
   * T5/T6 in a real browser. The write for revision N is told to complete LATE, and
   * revision N+1 is created while it is in flight. When that older completion
   * finally lands, the document is one revision ahead of what is stored — and no
   * surface may claim the work is saved. The sampling window is chosen so the write
   * for N+1 cannot possibly have been observed inside it.
   */
  await setWriteDelay(WRITE_DELAY_MS);
  const cx = page.x + Math.round(page.w * 0.5);
  const cy = page.y + Math.round(page.h * 0.2);
  await key("r", "KeyR", "r");
  await drag(cx, cy, cx + 140, cy + 90); // edit #1 — the write that will complete late
  await sleep(1000);
  // A second `r`: inserting a shape reverts the active tool to select
  // (`insertionComplete` in EditorCanvas), so without this the drag below would be
  // a marquee selection and there would be only ONE edit — which is exactly how
  // this scenario passed while proving nothing.
  await key("r", "KeyR", "r");
  await drag(cx, cy + 160, cx + 140, cy + 250); // edit #2 — created while #1 is in flight
  const raceCount = await countObjects();
  check("C: both edits landed (race precondition)", raceCount === 4, `count=${raceCount}`);

  /*
   * Each sample reads the claim AND what a reload would actually restore, in that
   * order. That pairing is the point: a label is only honest relative to the store
   * behind it, so "claims stored" is checked against the stored object count rather
   * than against another projection of the same state.
   */
  const samples = [];
  for (let i = 0; i < 24; i += 1) {
    const s = await surfaces();
    const stored = await newestSnapshot();
    samples.push({
      label: s?.bar?.label ?? null,
      agreed: Boolean(s?.pill?.label) && s?.pill?.label === s?.bar?.label,
      stored: stored?.sceneObjects ?? null,
      generation: stored?.generation ?? null,
    });
    await sleep(200);
  }
  const dishonest = samples.filter((s) => claimsStored(s.label) && s.stored !== raceCount);
  check(
    "C (T6): no moment claimed the work was stored while the store was still behind the canvas",
    dishonest.length === 0,
    `samples=${samples.length} dishonest=${dishonest.length} ${JSON.stringify(dishonest.slice(0, 3))}`,
  );
  // The race itself, observed rather than assumed: the store holding 3 of the 4
  // objects means edit #1's write completed while edit #2 already existed.
  const behind = samples.filter((s) => s.stored !== null && s.stored < raceCount);
  check(
    "C ANTI-VACUITY: the older write really did land while a newer revision existed",
    behind.some((s) => s.stored === raceCount - 1) && samples.some((s) => /saving/i.test(s.label || "")),
    `storedCounts=${[...new Set(samples.map((s) => s.stored))].join(",")} labels=${[...new Set(samples.map((s) => s.label))].join(" | ")}`,
  );
  check(
    "C: the two surfaces agreed in every one of the sampled moments, transitions included",
    samples.every((s) => s.agreed),
    `disagreements=${samples.filter((s) => !s.agreed).length}`,
  );
  await shot("c-race");

  await setWriteDelay(0);
  await sleep(AUTOSAVE_GRACE_MS + 3000);
  const settled = await readAgreed("C (delay removed)");
  const snap4 = await newestSnapshot();
  check(
    "C: once the writes catch up, the claim returns AND the store holds all four objects",
    claimsStored(settled?.bar?.label) && snap4?.sceneObjects === 4,
    `label=${settled?.bar?.label} snapshot=${JSON.stringify(snap4)}`,
  );

  /* ======================================================================== */
  console.log(`\n=============== B. FIRST WORKSPACE SAVE, AND THE SECOND ===============\n`);
  /*
   * T11. "Save to Workspace" twice in one editing session must update ONE document,
   * not create two. The account is registered here rather than seeded so the run
   * goes through the product's real signup, and the local draft store is emptied
   * first: a leftover guest draft would open the recovery prompt over the editor and
   * every later click would land on a dialog.
   */
  await goto("/register", 3500);
  const cleared = await evaluate(`(async () => {
    await new Promise((res) => {
      const rq = indexedDB.deleteDatabase('pdfdadi-drafts');
      rq.onsuccess = rq.onerror = rq.onblocked = () => res(null);
    });
    return (await indexedDB.databases()).map((d) => d.name).includes('pdfdadi-drafts');
  })()`);
  check("B: the local draft store was emptied before the signed-in run", cleared === false, String(cleared));

  const stamp = Date.now();
  const email = `phase2.${stamp}@example.test`;
  await field("name", "Phase Two Prober");
  await field("email", email);
  await field("password", "Phase2-Probe-Password!");
  await field("confirmPassword", "Phase2-Probe-Password!");
  await evaluate(`document.querySelector('input[name="acceptedTerms"]')?.click()`);
  await clickLabel("^create account$", "button");
  await sleep(7000);
  const landed = await evaluate(`location.pathname`);
  check("B: registering lands the prober in the authenticated app", /\/workspaces/.test(String(landed)), String(landed));

  await goto("/workspaces", 3500);
  const ids = await evaluate(`(() => {
    const a = [...document.querySelectorAll('a[href*="organizationId="]')].find((x) => /\\/workspaces\\//.test(x.getAttribute('href') || ''));
    if (!a) return null;
    const u = new URL(a.href);
    return { workspaceId: u.pathname.split('/')[2], organizationId: u.searchParams.get('organizationId') };
  })()`);
  check("B: the new account has a Workspace to save into", Boolean(ids?.workspaceId && ids?.organizationId), JSON.stringify(ids));
  if (!ids?.workspaceId) throw new Error("no workspace resolved for the probe account");
  const before = await listDocuments(ids.workspaceId, ids.organizationId);
  check(
    "B PRECONDITION: the Workspace starts with no documents, so a created one cannot be pre-existing",
    before?.status === 200 && before?.count === 0,
    JSON.stringify(before),
  );

  await goto("/editor");
  check(
    "B: no recovery dialog stands over the editor (the store was emptied)",
    (await evaluate(`document.querySelector('[role="dialog"], [role="alertdialog"]') === null`)) === true,
  );
  await clickLabel("create blank pdf", "button");
  await sleep(1500);
  const page2 = await pageRect();
  await key("r", "KeyR", "r");
  await drag(
    page2.x + Math.round(page2.w * 0.2),
    page2.y + Math.round(page2.h * 0.2),
    page2.x + Math.round(page2.w * 0.2) + 160,
    page2.y + Math.round(page2.h * 0.2) + 100,
  );
  check("B: the signed-in session has one object to save", (await countObjects()) === 1);
  await sleep(AUTOSAVE_GRACE_MS);
  const localOnly = await readAgreed("B (saved locally, not yet in the Workspace)");
  check(
    "B (T10): before any Workspace save, the readout claims the DEVICE only — the hierarchy is explicit",
    /device/i.test(localOnly?.bar?.label || ""),
    JSON.stringify(localOnly?.bar),
  );

  const savedClick = await clickLabel("save to workspace", "button");
  check("B: the signed-in app bar offers Save to Workspace", savedClick);
  await sleep(9000);
  const banner1 = await saveBanner();
  check(
    "B: the first Workspace save reports success in a live region",
    banner1?.present === true && banner1?.role === "status" && /saved to your workspace/i.test(banner1?.text || ""),
    JSON.stringify(banner1),
  );
  const after1 = await listDocuments(ids.workspaceId, ids.organizationId);
  check(
    "B (T11): the first save created EXACTLY ONE document",
    after1?.count === 1,
    JSON.stringify(after1),
  );
  await shot("b-first-save");

  /* The second save of the SAME editing session. */
  await key("r", "KeyR", "r");
  await drag(
    page2.x + Math.round(page2.w * 0.5),
    page2.y + Math.round(page2.h * 0.45),
    page2.x + Math.round(page2.w * 0.5) + 150,
    page2.y + Math.round(page2.h * 0.45) + 90,
  );
  check("B: a second edit exists to save", (await countObjects()) === 2);
  await clickLabel("save to workspace", "button");
  await sleep(9000);
  const banner2 = await saveBanner();
  const after2 = await listDocuments(ids.workspaceId, ids.organizationId);
  check(
    "B (T11): the second save also succeeds",
    banner2?.present === true && /saved to your workspace/i.test(banner2?.text || ""),
    JSON.stringify(banner2),
  );
  check(
    "B (T11): AND it updated the SAME document — no second Untitled PDF.pdf",
    after2?.count === 1 && after2?.ids?.[0] === after1?.ids?.[0],
    `count=${after2?.count} ids=${JSON.stringify(after2?.ids)} names=${JSON.stringify(after2?.names)}`,
  );
  check(
    "B (T12): the document's revision advanced, so the second save is a new version of it",
    (after2?.revisions?.[0] ?? 0) > (after1?.revisions?.[0] ?? 0),
    `${after1?.revisions?.[0]} -> ${after2?.revisions?.[0]}`,
  );

  /* ======================================================================== */
  console.log(`\n=============== B2. THE COMMIT ACKNOWLEDGEMENT, AS THE UI CONSUMED IT ===============\n`);
  /*
   * Phase 2 closeout. Everything above proves the SERVER did the work: one document,
   * an advancing revision, a 2xx. None of it proves the editor believes it, and that
   * was the whole defect — `noteVersionCommitted` had no production caller, so the
   * canonical projection could never say a revision was committed no matter how many
   * versions the server wrote.
   *
   * So these checks read the VISIBLE readout and compare the number in it against the
   * number the version API reports. A UI that ignored the acknowledgement, or one that
   * invented a client-side counter, fails here while every HTTP assertion above still
   * passes.
   *
   * Sequenced after the SECOND save on purpose: the first standalone save goes through
   * `documents/upload`, whose response cannot name a version (ingestion writes version
   * 1 asynchronously), so the honest acknowledgement there carries no number.
   */
  const documentId = after2?.ids?.[0];
  const committedVersion = await latestVersion(ids.workspaceId, documentId, ids.organizationId);
  check(
    "B2 PRECONDITION: the server has an authoritative version number to be quoted",
    typeof committedVersion?.versionNumber === "number" && committedVersion.versionNumber >= 1,
    JSON.stringify(committedVersion),
  );

  // A: current revision == committed revision.
  const committedRead = await readAgreed("B2 (committed to the Workspace)");
  check(
    "B2 (A): the readout quotes the SERVER's version number — the acknowledgement was consumed",
    new RegExp(`version ${committedVersion?.versionNumber}\\b`).test(committedRead?.bar?.detail || ""),
    `expected version ${committedVersion?.versionNumber} in ${JSON.stringify(committedRead?.bar)}`,
  );
  check(
    "B2 (A): and it claims the WORKSPACE, not just the device",
    claimsStored(committedRead?.bar?.label) && /workspace/i.test(committedRead?.bar?.detail || "") &&
      !/device/i.test(committedRead?.bar?.label || ""),
    JSON.stringify(committedRead?.bar),
  );
  await shot("b2-committed");

  // B: one edit past the commit, read IMMEDIATELY — before any local write or
  // autosave could change the answer for an unrelated reason.
  await key("r", "KeyR", "r");
  await drag(
    page2.x + Math.round(page2.w * 0.6),
    page2.y + Math.round(page2.h * 0.2),
    page2.x + Math.round(page2.w * 0.6) + 120,
    page2.y + Math.round(page2.h * 0.2) + 80,
  );
  const dirtied = await readAgreed("B2 (one edit past the commit)");
  check(
    "B2 (B): a single edit LEAVES the committed state — no version is quoted for work the Workspace never received",
    !/as version \d+/i.test(dirtied?.bar?.detail || ""),
    JSON.stringify(dirtied?.bar),
  );
  check(
    "B2 (B): and the readout does not claim an unqualified save to the Workspace",
    !/saved to your workspace/i.test(dirtied?.bar?.detail || ""),
    JSON.stringify(dirtied?.bar),
  );

  /*
   * C: the in-flight state is visible while the request is open.
   *
   * Recorded by a MutationObserver armed BEFORE the click rather than by polling from
   * here. Polling missed it: the export blocks the main thread and the upload of a
   * one-page PDF against localhost can finish inside a single sample interval, so a
   * poll that came back empty proved nothing about the DOM. The observer sees every
   * committed change, however briefly it stood.
   */
  await evaluate(`(() => {
    const seen = () => [...document.querySelectorAll('button')].some((b) => /saving/i.test(b.textContent || ''));
    window.__probeSawSaving = seen();
    window.__probeSavingObs?.disconnect();
    window.__probeSavingObs = new MutationObserver(() => { if (seen()) window.__probeSawSaving = true; });
    window.__probeSavingObs.observe(document.body, { subtree: true, childList: true, characterData: true });
    return window.__probeSawSaving;
  })()`);
  await clickLabel("save to workspace", "button");
  await sleep(9000);
  const sawSaving = await evaluate(
    `(() => { window.__probeSavingObs?.disconnect(); return window.__probeSawSaving === true; })()`,
  );
  check("B2 (C): the commit announces itself as in flight while the request is open", sawSaving === true);

  // Back to A, with the NEXT version number — and the number is the server's choice,
  // never assumed to be the previous one plus one.
  const committedAgain = await latestVersion(ids.workspaceId, documentId, ids.organizationId);
  check(
    "B2: the second commit published a newer version on the server",
    (committedAgain?.versionNumber ?? 0) > (committedVersion?.versionNumber ?? 0),
    `${committedVersion?.versionNumber} -> ${committedAgain?.versionNumber}`,
  );
  const recommitted = await readAgreed("B2 (committed again)");
  check(
    "B2 (A again): the readout returns to the committed state quoting the NEW version",
    new RegExp(`version ${committedAgain?.versionNumber}\\b`).test(recommitted?.bar?.detail || ""),
    `expected version ${committedAgain?.versionNumber} in ${JSON.stringify(recommitted?.bar)}`,
  );
  const stillOne = await listDocuments(ids.workspaceId, ids.organizationId);
  check(
    "B2: three commits, still ONE document",
    stillOne?.count === 1 && stillOne?.ids?.[0] === documentId,
    JSON.stringify(stillOne),
  );
  const committedObjects = await countObjects();

  /* ======================================================================== */
  console.log(`\n=============== D. A FORCED WORKSPACE FAILURE, AND THE RETRY ===============\n`);
  /*
   * T7/T8. The version upload is failed by test-only interception — no production
   * delay, no server change. What must hold: the failure is REPORTED, the work is
   * still in the editor, nothing claims it reached the Workspace, and the retry
   * updates the SAME document rather than leaving a duplicate behind.
   */
  await installVersionUploadFailure();
  await key("r", "KeyR", "r");
  await drag(
    page2.x + Math.round(page2.w * 0.25),
    page2.y + Math.round(page2.h * 0.7),
    page2.x + Math.round(page2.w * 0.25) + 150,
    page2.y + Math.round(page2.h * 0.7) + 90,
  );
  const objectsBeforeFailure = await countObjects();
  // Relative to what the run has drawn so far rather than a fixed 3: scenario B2 adds
  // an object of its own, and a hard-coded count would make this check about the
  // probe's own history instead of about the failure it is here to force.
  check(
    "D: a further edit exists to save",
    objectsBeforeFailure === committedObjects + 1,
    `${committedObjects} -> ${objectsBeforeFailure}`,
  );

  await clickLabel("save to workspace", "button");
  await sleep(9000);
  const failedBanner = await saveBanner();
  check(
    "D (T7): the failure is reported as an alert, in words that do not claim a save",
    failedBanner?.present === true &&
      failedBanner?.role === "alert" &&
      !/saved to your workspace/i.test(failedBanner?.text || "") &&
      /still here|try again|export/i.test(failedBanner?.text || ""),
    JSON.stringify(failedBanner),
  );
  check(
    "D (T7): the work is still in the editor — nothing was reset, reloaded or discarded",
    (await countObjects()) === objectsBeforeFailure,
    `${objectsBeforeFailure} -> ${await countObjects()}`,
  );
  const duringFailure = await readAgreed("D (Workspace save failed)");
  check(
    "D: the local readout still tells the local truth, and claims nothing about the Workspace",
    !/workspace|cloud/i.test(duringFailure?.bar?.label || "") || !claimsStored(duringFailure?.bar?.label),
    JSON.stringify(duringFailure?.bar),
  );
  const afterFailure = await listDocuments(ids.workspaceId, ids.organizationId);
  check(
    "D (T8): a failed save created no document",
    afterFailure?.count === 1 && afterFailure?.ids?.[0] === after1?.ids?.[0],
    JSON.stringify(afterFailure),
  );
  await shot("d-failed");

  const intercepted = await clearVersionUploadFailure();
  check(
    "D ANTI-VACUITY: the interception really did fail a real request",
    Number(intercepted) >= 1,
    `intercepted=${intercepted}`,
  );
  const retried = await clickLabel("retry", "button");
  check("D: the failure banner offers a Retry", retried);
  await sleep(9000);
  const retryBanner = await saveBanner();
  check(
    "D (T8): the retry succeeds",
    retryBanner?.present === true && /saved to your workspace/i.test(retryBanner?.text || ""),
    JSON.stringify(retryBanner),
  );
  const afterRetry = await listDocuments(ids.workspaceId, ids.organizationId);
  check(
    "D (T8): and it updated the SAME document — a failure plus a retry leaves no duplicate",
    afterRetry?.count === 1 && afterRetry?.ids?.[0] === after1?.ids?.[0],
    `count=${afterRetry?.count} ids=${JSON.stringify(afterRetry?.ids)}`,
  );
  check(
    "D: the retry produced a further version of that document",
    (afterRetry?.revisions?.[0] ?? 0) > (after2?.revisions?.[0] ?? 0),
    `${after2?.revisions?.[0]} -> ${afterRetry?.revisions?.[0]}`,
  );
  await shot("d-retried");

  /* ---- B2 (reload): the claim must not survive a reload that cannot verify it ---- */
  /*
   * Last, because a reload drops the shell's held document id: `/editor` is a
   * guest-origin surface that reopens from the local draft and holds no server session
   * for the Workspace document, so there is nothing to reconstruct a commit watermark
   * FROM. The half of the requirement that survives the architecture is the honest
   * one — a reloaded editor may not claim a version it cannot verify.
   */
  await goto("/editor", 4000);
  await sleep(AUTOSAVE_GRACE_MS);
  const reloaded = await surfaces();
  check(
    "B2: a reloaded editor makes NO version claim it cannot verify",
    !/as version \d+/i.test(reloaded?.bar?.detail || "") &&
      !/as version \d+/i.test(reloaded?.pill?.detail || ""),
    JSON.stringify(reloaded),
  );
  check(
    "B2: and it still tells the local truth rather than going silent",
    Boolean(reloaded?.bar?.label) && reloaded?.bar?.label === reloaded?.pill?.label,
    JSON.stringify(reloaded),
  );

  /* ---- Nothing blew up on the way ---------------------------------------- */
  /*
   * Scenario D's forced failure makes the shell log ONE deliberate diagnostic
   * ("Save to Workspace failed", with the failure category and no document
   * content). Allowing exactly as many of those as the interception actually
   * failed keeps the check honest in both directions: the intended diagnostic is
   * not counted as noise, and a second unexplained save failure still is.
   */
  const deliberate = [];
  const noisy = [];
  for (const entry of consoleErrors) {
    if (/favicon|Failed to load resource|probe|500 \(Internal Server Error\)/i.test(entry)) continue;
    if (/Save to Workspace failed/i.test(entry) && deliberate.length < Number(intercepted)) {
      deliberate.push(entry);
      continue;
    }
    noisy.push(entry);
  }
  check("no console errors or uncaught exceptions during the run", noisy.length === 0, noisy.slice(0, 4).join(" | "));
  const serverErrors = responses.filter((r) => r.status >= 500);
  check(
    "no request the page made answered 5xx (the forced failure never reached the network)",
    serverErrors.length === 0,
    serverErrors.slice(0, 4).map((r) => `${r.status} ${r.url}`).join(" | "),
  );

  console.log(`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} FAILED`}`);
  if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
  console.log(`account: ${email}   workspace: ${ids.workspaceId}`);

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
