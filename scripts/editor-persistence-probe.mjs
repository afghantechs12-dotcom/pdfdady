/* global process, console, fetch, WebSocket, setTimeout, clearTimeout, Buffer */
/**
 * PERMANENT regression probe: document persistence against a REAL browser.
 *
 * WHY THIS EXISTS. The persistence subsystem is ~40 unit-tested modules plus a
 * binding, a hook and three components, and every one of those tests runs in Node
 * against fakes: a fake `IDBFactory`, a fake `navigator.locks`, a fake
 * `BroadcastChannel`, a fake `fetch`. The suite has no DOM at all, so nothing in
 * it can answer the only question that matters to a user — after I edit and my
 * browser reloads, are my changes still there? A green suite is compatible with a
 * store that never opens, a lock that never resolves, an envelope that fails a real
 * structured clone, and a recovery offer no click can reach.
 *
 * So this walks the actual guest path end to end, in Chrome, through real input:
 *
 *   /editor → "Create blank PDF" → draw a rectangle → autosave → RELOAD →
 *   recovery offer → "Restore my changes" → the rectangle is back
 *
 * and reads the bytes out of the real `pdfdadi-drafts` database at each step to
 * check the store's contents, not just the readout above it.
 *
 * THE HAZARD THIS IS BUILT AGAINST is a vacuous pass: a probe that finds nothing,
 * asserts nothing, and prints green. Every claim here is therefore paired with a
 * precondition that must be observed to CHANGE — the database must not exist
 * before the edit, the object count must be 0 before the drag and 0 again after
 * the reload, and the restored geometry must match the drag that was performed.
 * A build where the editor fails to boot cannot satisfy those, and cannot pass.
 *
 * Run the app in PRODUCTION mode — that is what a user runs:
 *
 *   node scripts/next-build.js && npx next start -p 3001
 *   node scripts/editor-persistence-probe.mjs [--url http://localhost:3001] [--shots]
 *
 * It also passes against `next dev`, and running it there is worth doing, because
 * `reactStrictMode` mounts every effect twice and persistence must not appear broken
 * in development. Section 6 is the part that exercises that: React does not
 * double-invoke effects for a HYDRATION mount, so sections 1-5 — which arrive by
 * typing the URL — score the same in dev with the hook's disposal guards reverted as
 * with them in place. Only an in-app click produces the mount StrictMode tears down.
 *
 * WHAT SECTION 6 DOES AND DOES NOT PIN, since a probe is worth no more than the
 * mutations it catches. Each of the three disposal guards in `useDocumentPersistence`
 * was deleted in turn and this probe re-run against the result: all three left it
 * green, so it is not the check on them (`useDocumentPersistence.test.ts` is). What
 * it does catch is the loss of the REBUILD that follows the teardown — deleting both
 * the unmount cleanup's `bindingRef.current = null` and the render guard's disposed
 * test failed three of section 6's checks, in the shape that makes this worth a real
 * browser: the drag still committed an object and the probe still counted it, while
 * the readout read "No document", the recovery offer never appeared, and the draft
 * generation never moved off the one the previous mount had written.
 *
 * `CHROME_PATH` overrides the browser binary.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg("--url", "http://localhost:3001");
const SHOTS = process.argv.includes("--shots");
const SHOT_DIR = "docs/screenshots/persistence";
const CHROME =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Autosave is debounced 700ms with a 4s ceiling; this waits past the ceiling. */
const AUTOSAVE_GRACE_MS = 5200;

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), "pdfdadi-persistence-"));
  const port = 9493;
  /*
   * A previous run that died before `chrome.kill()` leaves a browser holding this
   * port, and the second launch then silently ATTACHES TO THE OLD ONE — same port,
   * a stale target list, and every CDP call hanging forever with a dirty draft
   * store underneath it. Reclaim the port first; the pattern is specific enough
   * that it cannot match a browser the developer is using.
   */
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
    const res = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.result?.exceptionDetails) {
      return { __probeError: res.result.exceptionDetails.text ?? "evaluate threw" };
    }
    return res.result?.result?.value;
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
  const key = async (keyName, code, text) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, text });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code });
    await sleep(260);
  };
  const shot = async (name) => {
    if (!SHOTS) return;
    const res = await send("Page.captureScreenshot", { format: "png" });
    const data = res.result?.data;
    if (!data) return;
    mkdirSync(SHOT_DIR, { recursive: true });
    writeFileSync(join(SHOT_DIR, `${name}.png`), Buffer.from(data, "base64"));
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1600, height: 900, deviceScaleFactor: 1, mobile: false,
  });

  const failures = [];
  const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failures.push(name);
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
   * The save readout, as a user sees it: label, the `title` detail, and tone.
   *
   * Located by the disclosure button in the status bar's trailing slot. The tone is
   * read from the class list rather than from any test hook, because a red readout
   * and a green one differ by exactly that.
   */
  const saveStatus = () =>
    evaluate(`(() => {
      const candidates = [...document.querySelectorAll('button[aria-expanded][aria-controls][title]')];
      const bar = candidates.filter((b) => b.closest('.ml-auto'));
      const el = (bar[0] || candidates[0]);
      if (!el) return null;
      return {
        label: (el.textContent || '').trim(),
        detail: el.getAttribute('title') || '',
        classes: el.className,
      };
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
      // A page's \`objects\` is a RECORD keyed by object id, not an array — counting
      // only arrays here reported an empty scene for a draft that restored perfectly.
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
      const pointers = [];
      const indexes = [];
      keys.forEach((k, i) => {
        const v = values[i];
        if (String(k).startsWith('snapshot:')) {
          snapshots.push({
            key: k,
            hasChecksum: typeof v?.checksum === 'string' && v.checksum.length > 0,
            origin: v?.manifest?.origin ?? null,
            documentKey: v?.manifest?.documentKey ?? null,
            revision: v?.manifest?.revision ?? null,
            generation: v?.manifest?.generation ?? null,
            sceneObjects: countScene(v?.manifest?.scene ?? null),
            sourcePdf: v?.manifest?.sourcePdf ?? null,
            sourceReference: v?.manifest?.sourceReference ?? null,
            bytes: JSON.stringify(v).length,
          });
        } else if (String(k).startsWith('pointer:')) {
          pointers.push({ key: k, active: v?.activeGeneration ?? null, previous: v?.previousGeneration ?? null, revision: v?.revision ?? null });
        } else if (String(k).startsWith('index:')) {
          indexes.push({ key: k, documentKey: v?.documentKey ?? null, origin: v?.origin ?? null, name: v?.documentName ?? null, revision: v?.revision ?? null });
        }
      });
      return { exists: true, keys, snapshots, pointers, indexes };
    })()`);

  /** The recovery dialog, by role — the same thing a screen reader would find. */
  const recoveryDialog = () =>
    evaluate(`(() => {
      const el = document.querySelector('[role="dialog"], [role="alertdialog"]');
      if (!el) return { present: false };
      const heading = el.querySelector('h2');
      const buttons = [...el.querySelectorAll('button')].map((b) => ({
        text: (b.textContent || '').trim(),
        x: Math.round(b.getBoundingClientRect().x + b.getBoundingClientRect().width / 2),
        y: Math.round(b.getBoundingClientRect().y + b.getBoundingClientRect().height / 2),
        hit: (() => {
          const r = b.getBoundingClientRect();
          const h = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return Boolean(h && (b === h || b.contains(h)));
        })(),
      }));
      return {
        present: true,
        role: el.getAttribute('role'),
        modal: el.getAttribute('aria-modal'),
        headline: (heading?.textContent || '').trim(),
        body: (el.querySelector('h2 + p, p')?.textContent || '').trim(),
        buttons,
      };
    })()`);

  /** The drawn object's box, normalised to the page, so a reload can be compared. */
  const objectBox = () =>
    evaluate(`(() => {
      const el = document.querySelector('main svg [data-object-id]');
      if (!el) return null;
      const o = el.getBoundingClientRect();
      const rects = [...document.querySelectorAll('main svg rect')]
        .map((r) => ({ el: r, b: r.getBoundingClientRect() }))
        .filter((x) => x.b.width > 200 && x.b.height > 200)
        .sort((a, b) => b.b.width * b.b.height - a.b.width * a.b.height);
      if (!rects.length) return null;
      const p = rects[0].b;
      return {
        left: +(((o.x - p.x) / p.width)).toFixed(4),
        top: +(((o.y - p.y) / p.height)).toFixed(4),
        w: +((o.width / p.width)).toFixed(4),
        h: +((o.height / p.height)).toFixed(4),
      };
    })()`);

  /* ====================================================================== */
  console.log(`\n=============== GUEST BLANK PAGE → AUTOSAVE → RELOAD → RESTORE ===============`);
  console.log(`url: ${BASE}/editor   chrome: ${CHROME}\n`);

  await send("Page.navigate", { url: `${BASE}/editor` });
  await sleep(4200);

  /* ---- 0. The preconditions that stop this probe passing vacuously -------- */
  const capabilities = await evaluate(`({
    idb: typeof indexedDB !== 'undefined',
    locks: typeof navigator.locks !== 'undefined',
    channel: typeof BroadcastChannel !== 'undefined',
  })`);
  check(
    "the browser has the three APIs the runtime is built on",
    capabilities?.idb === true && capabilities?.locks === true && capabilities?.channel === true,
    JSON.stringify(capabilities),
  );

  /*
   * The database EXISTS from the moment the page boots — the runtime opens it to
   * find out whether this browser will store anything at all, which is how the UI
   * can say "this browser can't save locally" instead of offering a Retry that can
   * never work. So the clean-slate precondition is that it holds no RECORDS.
   */
  const virgin = await readStore();
  check(
    "the draft store holds no records before anything is edited (clean-slate precondition)",
    (virgin?.keys?.length ?? -1) === 0,
    `exists=${virgin?.exists} keys=${JSON.stringify(virgin?.keys)}`,
  );

  const beforeArm = await saveStatus();
  check(
    "the readout is reachable and honestly says nothing is open before the blank click",
    /no document/i.test(beforeArm?.label || "") || /no document is open/i.test(beforeArm?.detail || ""),
    JSON.stringify(beforeArm),
  );
  await shot("01-onboarding");

  /* ---- 1. Create blank PDF, with a real click ----------------------------- */
  const blank = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /create blank pdf/i.test(x.textContent || ''));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  check("the onboarding overlay offers Create blank PDF", Boolean(blank), JSON.stringify(blank));
  if (blank) await mouseClick(blank.x, blank.y);
  await sleep(1400);

  const armed = await saveStatus();
  check(
    "clicking Create blank PDF ARMS persistence for the page already on screen",
    Boolean(armed) && !/no document/i.test(armed.label) && !/no document is open/i.test(armed.detail),
    JSON.stringify(armed),
  );

  const afterArm = await readStore();
  check(
    "an armed but untouched blank page writes no draft (no junk in the recovery list)",
    afterArm?.exists === false || (afterArm?.snapshots?.length ?? 0) === 0,
    `exists=${afterArm?.exists} snapshots=${afterArm?.snapshots?.length ?? 0}`,
  );
  await shot("02-armed");

  /* ---- 2. Draw one rectangle with real input ------------------------------ */
  const page = await pageRect();
  check("the blank page surface is on screen", Boolean(page && page.w > 200), JSON.stringify(page));
  const before = await countObjects();
  check("the page starts with no objects (drag precondition)", before === 0, `count=${before}`);

  await key("r", "KeyR", "r");
  const x0 = page.x + Math.round(page.w * 0.24);
  const y0 = page.y + Math.round(page.h * 0.28);
  const x1 = x0 + 180;
  const y1 = y0 + 120;
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
    await sleep(40);
  }
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: x1, y: y1, button: "left", clickCount: 1, buttons: 0,
  });
  await sleep(700);

  const drawn = await countObjects();
  check("a real drag commits exactly one object", drawn === 1, `count=${drawn}`);
  const drawnBox = await objectBox();
  check("the drawn object has a measurable box", Boolean(drawnBox && drawnBox.w > 0.05), JSON.stringify(drawnBox));
  await shot("03-drawn");

  /* ---- 3. Autosave, and what actually landed in IndexedDB ----------------- */
  await sleep(AUTOSAVE_GRACE_MS);
  const saved = await saveStatus();
  check(
    "the readout reports the change stored on this device",
    /saved on this device|^saved$/i.test(saved?.label || ""),
    JSON.stringify(saved),
  );

  const store = await readStore();
  check(
    "the real pdfdadi-drafts database now holds an index, a pointer and a snapshot",
    (store?.indexes?.length ?? 0) === 1 &&
      (store?.pointers?.length ?? 0) === 1 &&
      (store?.snapshots?.length ?? 0) >= 1,
    `index=${store?.indexes?.length} pointer=${store?.pointers?.length} snapshot=${store?.snapshots?.length}`,
  );
  const snap = (store?.snapshots ?? []).sort((a, b) => (b.generation ?? 0) - (a.generation ?? 0))[0];
  check(
    "the stored snapshot is a guest draft keyed under guest:",
    snap?.origin === "guest" && String(snap?.documentKey || "").startsWith("guest:"),
    `origin=${snap?.origin} key=${snap?.documentKey}`,
  );
  check(
    "the stored snapshot contains the user's object, not an empty scene",
    (snap?.sceneObjects ?? 0) === 1 && (snap?.revision ?? 0) > 0,
    `sceneObjects=${snap?.sceneObjects} revision=${snap?.revision} bytes=${snap?.bytes}`,
  );
  check(
    "the snapshot carries a checksum, and the pointer names a live generation",
    snap?.hasChecksum === true && store?.pointers?.[0]?.active === snap?.generation,
    `checksum=${snap?.hasChecksum} pointer.active=${store?.pointers?.[0]?.active} generation=${snap?.generation}`,
  );
  check(
    "a blank document stores no source PDF rather than fabricating one",
    snap?.sourcePdf === null,
    `sourcePdf=${JSON.stringify(snap?.sourcePdf)} reference=${JSON.stringify(snap?.sourceReference)}`,
  );

  /* ---- 4. The reload — the whole point ----------------------------------- */
  await send("Page.reload", { ignoreCache: false });
  await sleep(4600);

  const afterReload = await countObjects();
  check(
    "the reloaded editor starts blank again (restore precondition)",
    afterReload === 0,
    `count=${afterReload}`,
  );

  const dialog = await recoveryDialog();
  check(
    "a guest tab with no file is OFFERED its abandoned draft after F5",
    dialog?.present === true && /dialog/.test(dialog?.role || ""),
    dialog?.present ? `role=${dialog.role} headline=${JSON.stringify(dialog.headline)}` : "no dialog",
  );
  /*
   * A blank page's draft is COMPLETE — there was never an original PDF for it to be
   * missing. The repository used to report one anyway, which reached the user as
   * "partly recoverable · some content is missing" beside a Delete button, and made
   * the coordinator refuse to call the restored document durable. Both halves are
   * checked: the offer here, and the readout after the restore below.
   */
  const alarmist = `${dialog?.headline ?? ""} ${dialog?.body ?? ""}`;
  check(
    "a complete blank-page draft is NOT offered as damaged",
    dialog?.present === true &&
      !/partly recoverable|content is missing|could not be recovered|appear blank/i.test(alarmist),
    JSON.stringify(alarmist.trim()),
  );

  const restore = (dialog?.buttons ?? []).find((b) => /restore my changes/i.test(b.text));
  check(
    "the offer's primary action is Restore my changes, and it is hit-testable",
    Boolean(restore) && restore.hit === true,
    `buttons=${JSON.stringify((dialog?.buttons ?? []).map((b) => b.text))}`,
  );
  await shot("04-recovery-offer");

  /* ---- 5. Restore ------------------------------------------------------- */
  if (restore) await mouseClick(restore.x, restore.y);
  await sleep(2600);

  const gone = await recoveryDialog();
  check("the offer closes once it is answered", gone?.present === false, JSON.stringify(gone?.headline ?? ""));

  const restored = await countObjects();
  check(
    "THE WORK IS BACK: the object round-tripped through real IndexedDB",
    restored === 1,
    `count=${restored}`,
  );
  const restoredBox = await objectBox();
  const near = (a, b) => a !== undefined && b !== undefined && Math.abs(a - b) < 0.02;
  check(
    "the restored object is the same geometry that was drawn, not a placeholder",
    Boolean(
      restoredBox && drawnBox &&
      near(restoredBox.left, drawnBox.left) && near(restoredBox.top, drawnBox.top) &&
      near(restoredBox.w, drawnBox.w) && near(restoredBox.h, drawnBox.h),
    ),
    `drawn=${JSON.stringify(drawnBox)} restored=${JSON.stringify(restoredBox)}`,
  );

  /*
   * Restoring is itself an edit — it lands the draft's scene in the editor at a new
   * revision — so the readout reads "Unsaved changes" for the length of one debounce
   * before the restored work is written back, and the recovered notice is behind it
   * (a pending edit outranks it, deliberately: the newer fact is the urgent one).
   * Both halves are worth pinning: the user is told what they are looking at came
   * from a draft, AND the restored work becomes durable again.
   */
  const restoredImmediately = await saveStatus();
  await sleep(AUTOSAVE_GRACE_MS);
  const afterRestore = await saveStatus();
  check(
    "the readout tells the user their draft was recovered rather than silently swapping it in",
    /recover/i.test(afterRestore?.label || "") || /recover/i.test(afterRestore?.detail || ""),
    `+0s ${JSON.stringify(restoredImmediately?.label)} -> +${AUTOSAVE_GRACE_MS}ms ${JSON.stringify(afterRestore)}`,
  );

  const settled = await readStore();
  const settledSnap = (settled?.snapshots ?? []).sort((a, b) => (b.generation ?? 0) - (a.generation ?? 0))[0];
  check(
    "the restored work is durable again, so a SECOND reload would find it too",
    (settledSnap?.sceneObjects ?? 0) === 1 &&
      (settled?.pointers?.[0]?.active ?? null) === (settledSnap?.generation ?? null),
    `generation=${settledSnap?.generation} revision=${settledSnap?.revision} objects=${settledSnap?.sceneObjects} pointer=${settled?.pointers?.[0]?.active}`,
  );
  await shot("05-restored");

  /* ---- 6. The mount a direct load never produces -------------------------- */
  /*
   * WHY THIS SECTION EXISTS, and why the 25 checks above could not replace it.
   *
   * Everything so far reached the editor by navigating straight to its URL, so the
   * component tree mounts as part of HYDRATION — and React does NOT double-invoke
   * effects for that mount. Reaching the same page by clicking a link inside the app
   * mounts it as an ordinary client render, which StrictMode tears down and mounts
   * again. Instrumenting the binding in `next dev` showed the difference exactly:
   *
   *   direct load of /editor   → effect cleanups 0, bindings disposed 0
   *   in-app click to /editor  → effect cleanups 1, bindings disposed 1
   *
   * So a whole class of lifecycle bug — a runtime torn down and then used, listeners
   * armed on it, a frozen view no render replaces — is invisible to a probe that only
   * types URLs, in dev AND in production, since the same second mount happens either
   * way whenever a real user arrives by clicking rather than by pasting a link.
   *
   * This walks in through a link and then does the one thing that matters: edits, and
   * checks the bytes land.
   *
   * IT ALSO COVERS A REAL BUG THIS ORDER OF EVENTS FOUND. On this mount the guest is
   * offered the draft the earlier phases left, because arriving with no file makes the
   * abandoned-draft probe open the draft it finds as this tab's identity WITHOUT
   * loading any content — the recovery offer needs an open document to hang off. Every
   * capture is then refused by the interlock, correctly, while the offer is unanswered.
   *
   * Answering it by DECLINING used to leave the tab in that state permanently: the
   * identity stayed, no content was ever marked loaded, and "Create blank PDF" refused
   * to repair it because an identity already existed. The editor stayed fully usable
   * and saved nothing for the rest of the mount. This section only caught it against a
   * production build, and by accident — dev is slow enough that the offer arrived after
   * the blank click, which is the ordering that works. The dismissal is now sequenced
   * deliberately BEFORE the blank click so the covered path is the broken one.
   *
   * The precondition is therefore a NEW documentKey. Normally a blank page's guest
   * fingerprint is its name, so a second blank page in the same tab resolves to the
   * same identity and continues the same draft — the rule that makes reopening a file
   * pick its draft up rather than orphan it. A blank page started after DECLINING is
   * the deliberate exception: it is re-keyed, because writing it under the declined
   * draft's key would advance that draft's pointer past the work the user just chose
   * not to restore. So the last two checks are "a key that did not exist before now
   * holds the object" and "the declined draft is byte-identical to how it was found".
   */
  const storeBefore = await readStore();
  const keysBefore = new Set((storeBefore?.snapshots ?? []).map((x) => x.documentKey));
  /*
   * The draft the offer below will be about, recorded so it can be compared after the
   * edit. There is exactly one at this point: sections 1-5 wrote a single guest draft.
   */
  const declinedKey = (storeBefore?.snapshots ?? [])[0]?.documentKey ?? null;
  const declinedPointerBefore = (storeBefore?.pointers ?? []).find((x) =>
    String(x.key).endsWith(String(declinedKey)),
  ) ?? null;
  const declinedSnapshotsBefore = (storeBefore?.snapshots ?? []).filter(
    (x) => x.documentKey === declinedKey,
  );
  check(
    "the earlier phases left exactly one guest draft to be offered on the next mount",
    declinedKey !== null && declinedPointerBefore !== null && keysBefore.size === 1,
    `key=${declinedKey} pointer=${JSON.stringify(declinedPointerBefore)} keys=${keysBefore.size}`,
  );

  await send("Page.navigate", { url: `${BASE}/` });
  await sleep(3800);
  /*
   * The marker proves the next step is a CLIENT-SIDE navigation. A full document load
   * would wipe it, and this whole section would silently be a third copy of the
   * direct-load path — passing, and testing nothing new.
   */
  await evaluate(`(window.__probeNavMarker = "same-document", true)`);
  await evaluate(`(() => {
    const a = [...document.querySelectorAll('a[href]')]
      .find((x) => new URL(x.href, location.href).pathname === '/editor');
    if (a) a.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await sleep(1100);
  const navLink = await evaluate(`(() => {
    const a = [...document.querySelectorAll('a[href]')]
      .find((x) => new URL(x.href, location.href).pathname === '/editor');
    if (!a) return null;
    const r = a.getBoundingClientRect();
    const cx = Math.round(r.x + r.width / 2);
    const cy = Math.round(r.y + r.height / 2);
    const h = document.elementFromPoint(cx, cy);
    return { x: cx, y: cy, text: (a.textContent || '').trim().slice(0, 40),
             hit: Boolean(h && (a === h || a.contains(h) || h.contains(a))) };
  })()`);
  check(
    "the app links to the editor from its own pages, and the link is clickable",
    Boolean(navLink && navLink.hit === true),
    JSON.stringify(navLink),
  );
  if (navLink) await mouseClick(navLink.x, navLink.y);
  await sleep(4800);

  const navArrival = await evaluate(`({
    path: location.pathname,
    sameDocument: window.__probeNavMarker === "same-document",
  })`);
  check(
    "clicking it arrives at the editor WITHOUT a document load (the StrictMode mount)",
    navArrival?.path === "/editor" && navArrival?.sameDocument === true,
    JSON.stringify(navArrival),
  );

  /*
   * The offer arrives LATE — finding it means an async probe of the draft store — so
   * this waits for it instead of sampling once. A one-shot check right after arrival
   * saw nothing, and then the modal opened over the page and swallowed the drag, which
   * cost this section three silent failures before a diagnostic printed `overlay: 1`.
   *
   * Waiting is also what makes the ORDER deterministic. Whether the offer landed
   * before or after the blank click used to depend on how fast the build was, and only
   * one of those orders exercised the bug described above.
   */
  const waitForOffer = async (windowMs) => {
    for (let waited = 0; waited < windowMs; waited += 400) {
      const offer = await recoveryDialog();
      if (offer?.present) return offer;
      await sleep(400);
    }
    return null;
  };
  const navOffer = await waitForOffer(9000);
  check(
    "arriving with no file OFFERS the draft the earlier phases left behind",
    navOffer?.present === true && /unsaved changes found/i.test(navOffer?.headline || ""),
    JSON.stringify(navOffer?.headline ?? null),
  );

  /*
   * The offer has to be ANSWERED first, and this is the check that says so. If the
   * modal did not gate the page, a user could start a blank document while a draft for
   * the same tab was still being offered, and the restore they clicked afterwards would
   * land in a document that had already moved on.
   */
  const gated = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /create blank pdf/i.test(x.textContent || ''));
    if (!b) return { found: false };
    const r = b.getBoundingClientRect();
    const h = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { found: true, reaches: Boolean(h && (b === h || b.contains(h))) };
  })()`);
  check(
    "the offer is modal: Create blank PDF cannot be clicked out from under it",
    gated?.found === true && gated?.reaches === false,
    JSON.stringify(gated),
  );

  /*
   * DECLINED, not deleted, and not restored. Declining is the answer that used to
   * leave the tab unable to save anything for the rest of the mount, and it is also
   * the one that must leave the draft on disk: "no thanks" is not "destroy it".
   */
  const dismissButton = (navOffer?.buttons ?? []).find((b) => /dismiss/i.test(b.text));
  check("the offer can be declined without deleting the draft", Boolean(dismissButton),
    JSON.stringify((navOffer?.buttons ?? []).map((b) => b.text)));
  if (dismissButton) await mouseClick(dismissButton.x, dismissButton.y);
  await sleep(900);
  const afterDecline = await recoveryDialog();
  check("declining closes the offer", afterDecline?.present === false,
    JSON.stringify(afterDecline?.headline ?? null));

  const navBlank = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /create blank pdf/i.test(x.textContent || ''));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const h = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
             hit: Boolean(h && (b === h || b.contains(h))) };
  })()`);
  check(
    "Create blank PDF is offered and clickable once the offer is answered",
    Boolean(navBlank) && navBlank.hit === true,
    JSON.stringify(navBlank),
  );
  if (navBlank) await mouseClick(navBlank.x, navBlank.y);
  await sleep(1500);

  /*
   * An explicit precondition, because its absence is what made the three checks below
   * fail SILENTLY: a modal over the page swallows the drag, the editor reports "no
   * changes", and nothing autosaves — which reads exactly like a broken runtime.
   */
  const clear = await evaluate(`(() => {
    const overlays = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].length;
    const rects = [...document.querySelectorAll('main svg rect')]
      .map((r) => r.getBoundingClientRect())
      .filter((b) => b.width > 200 && b.height > 200)
      .sort((a, b) => b.width * b.height - a.width * a.height);
    if (!rects.length) return { overlays, reaches: false };
    const b = rects[0];
    const x = Math.round(b.x + b.width * 0.3);
    const y = Math.round(b.y + b.height * 0.5);
    const hit = document.elementFromPoint(x, y);
    return { overlays, reaches: Boolean(hit && hit.closest('main')) };
  })()`);
  check(
    "nothing is covering the page, so the drag below reaches the canvas",
    clear?.overlays === 0 && clear?.reaches === true,
    JSON.stringify(clear),
  );

  const navPage = await pageRect();
  check("a blank page is on screen after the in-app arrival", Boolean(navPage && navPage.w > 200),
    JSON.stringify(navPage));

  if (navPage) {
    await key("r", "KeyR", "r");
    const nx = navPage.x + Math.round(navPage.w * 0.3);
    const ny = navPage.y + Math.round(navPage.h * 0.5);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: nx, y: ny, buttons: 0 });
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: nx, y: ny, button: "left", clickCount: 1, buttons: 1,
    });
    for (let i = 1; i <= 6; i += 1) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved", x: nx + 24 * i, y: ny + 16 * i, button: "left", buttons: 1,
      });
      await sleep(40);
    }
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: nx + 144, y: ny + 96, button: "left", clickCount: 1, buttons: 0,
    });
    await sleep(700);
  }
  const navDrawn = await countObjects();
  check("a real drag still commits an object on the second mount", navDrawn === 1, `count=${navDrawn}`);

  await sleep(AUTOSAVE_GRACE_MS);
  const navStatus = await saveStatus();
  check(
    "the readout is LIVE after a torn-down-and-remounted runtime, not frozen",
    /saved on this device|^saved$/i.test(navStatus?.label || ""),
    JSON.stringify(navStatus),
  );

  const navStore = await readStore();
  const fresh = (navStore?.snapshots ?? []).find((x) => !keysBefore.has(x.documentKey)) ?? null;
  check(
    "A DECLINED OFFER DOES NOT DISABLE AUTOSAVE: the work after it reaches IndexedDB",
    fresh !== null && (fresh.sceneObjects ?? 0) === 1 && fresh.hasChecksum === true,
    `newKey=${fresh?.documentKey} generation=${fresh?.generation} objects=${fresh?.sceneObjects} checksum=${fresh?.hasChecksum}`,
  );
  const freshPointer = (navStore?.pointers ?? []).find((x) =>
    String(x.key).endsWith(String(fresh?.documentKey)),
  ) ?? null;
  check(
    "its pointer names that generation, so a reload would read the new bytes",
    fresh !== null && (freshPointer?.active ?? null) === (fresh.generation ?? null),
    `pointer.active=${freshPointer?.active} generation=${fresh?.generation} previous=${freshPointer?.previous}`,
  );
  /*
   * The other half of the fix, and the half a "did the write land" check cannot see:
   * the declined draft must be exactly as it was found. Re-keying is what buys this —
   * writing the blank page under the declined key would have moved this pointer and
   * left the user's declined work one generation behind the newest.
   */
  const declinedPointerAfter = (navStore?.pointers ?? []).find((x) =>
    String(x.key).endsWith(String(declinedKey)),
  ) ?? null;
  const declinedSnapshotsAfter = (navStore?.snapshots ?? []).filter(
    (x) => x.documentKey === declinedKey,
  );
  check(
    "THE DECLINED DRAFT IS UNTOUCHED: declining is not deleting, and not superseding",
    declinedPointerAfter !== null &&
      declinedPointerAfter.active === declinedPointerBefore?.active &&
      declinedPointerAfter.previous === declinedPointerBefore?.previous &&
      declinedSnapshotsAfter.length === declinedSnapshotsBefore.length &&
      declinedSnapshotsAfter.every((x) => (x.sceneObjects ?? 0) === 1),
    `before=${JSON.stringify(declinedPointerBefore)} after=${JSON.stringify(declinedPointerAfter)} ` +
      `snapshots ${declinedSnapshotsBefore.length}->${declinedSnapshotsAfter.length}`,
  );
  await shot("06-after-in-app-navigation");

  /* ---- 7. Nothing blew up on the way ------------------------------------ */
  const noisy = consoleErrors.filter((e) => !/favicon|Failed to load resource/i.test(e));
  check("no console errors or uncaught exceptions during the run", noisy.length === 0,
    noisy.slice(0, 4).join(" | "));

  console.log(`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} FAILED`}`);
  if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));

  sock.close();
  chrome.kill("SIGKILL");
  spawnSync("pkill", ["-f", `remote-debugging-port=${port}`], { stdio: "ignore" });
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  spawnSync("pkill", ["-f", "remote-debugging-port=9493"], { stdio: "ignore" });
  process.exit(1);
});
