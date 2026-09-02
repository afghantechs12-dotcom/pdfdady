/* global process, console, fetch, WebSocket, setTimeout, Buffer */
/**
 * PERMANENT regression probe: Shape and Draw through the ACTUAL toolbar UI.
 *
 * WHY THIS EXISTS. Every unit test around the shape tools passed while the
 * feature was unusable, because the defect was not in any resolver — it was in
 * hit-testing. The cluster menus (`Add Shape ▾`, `Draw ▾`) were `absolute`
 * children of the tool row, and that row is `overflow-x-auto`; CSS computes the
 * other axis of a non-`visible` overflow to `auto`, so the row was a scroll
 * container on BOTH axes and clipped the 320px menu to its own 38px height. The
 * menu still had a real bounding box and was keyboard-reachable — so the DOM
 * looked correct and `.click()` on the element worked — but a real mouse click at
 * the item's own centre landed on the canvas `<svg>`. Keyboard `R`/`D` worked;
 * clicking Rectangle did nothing. That is the entire "Shape does not work" bug.
 *
 * The rule this probe encodes: activation goes through REAL CDP mouse events at
 * real coordinates, never `element.click()` and never the keyboard shortcut. A
 * synthetic `.click()` would have passed on the broken build.
 *
 * It asserts the fifteen user-visible claims of the repair:
 *
 *   Shape:  menu hit-testable · click activates · drag shows a preview with NO
 *           model object · pointer-up commits exactly ONE · geometry matches the
 *           drag (the old 1.2× defect) · Inspector says Shape · handles appear ·
 *           ONE Undo removes it · ONE Redo restores it · a plain click places a
 *           sensible default · Escape cancels · an off-page start creates nothing
 *   Draw:   menu hit-testable · click activates · live preview · exactly one
 *           committed stroke · Inspector says Drawing · Undo/Redo
 *   Both:   the bottom capsule never claims Select while they are active
 *
 * Usage: node scripts/editor-shape-draw-probe.mjs [--url http://localhost:3001]
 *        [--shots]   also writes docs/screenshots/p1-final/*.png
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg("--url", "http://localhost:3001");
const SHOTS = process.argv.includes("--shots");
const SHOT_DIR = "docs/screenshots/p1-final";
// Browser binary. `CHROME_PATH` lets a non-Windows machine (or a Chrome for
// Testing download) point the probe at its own build; the literal default keeps
// the original Windows invocation working untouched.
const CHROME =
  process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), "pdfdadi-shapedraw-"));
  const port = 9487;
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
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      sock.send(JSON.stringify({ id: mid, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return res.result?.result?.value;
  };

  // --- REAL input only -------------------------------------------------------
  /** A real mouse click at viewport coordinates. Never `element.click()`. */
  const mouseClick = async (x, y, holdMs = 90) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
    await sleep(holdMs);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0 });
    await sleep(220);
  };
  const mouseDown = (x, y) =>
    send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
  const mouseMove = (x, y) =>
    send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
  const mouseUp = (x, y) =>
    send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0 });
  const key = async (keyName, code, modifiers = 0, text) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, modifiers, text, windowsVirtualKeyCode: code === "Escape" ? 27 : undefined });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, modifiers });
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
  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${BASE}/editor` });
  await sleep(3600);

  const failures = [];
  const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failures.push(name);
  };

  // Start from a blank document so geometry is predictable.
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /blank/i.test(x.textContent || ''));
    if (b) { b.click(); return 'clicked'; }
    return 'none';
  })()`);
  await sleep(1600);

  // --- Shared reads ----------------------------------------------------------
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
   * The bottom capsule's pointer-mode truthfulness.
   *
   * Scoped to the capsule's OWN toolbar (`aria-label="Page and zoom controls"`):
   * the tool row is also a `role="toolbar"` and also has a "Select tool" button,
   * so an unscoped query answers about the wrong control — and would report the
   * toolbar's honest Select state as if it were the capsule's.
   */
  const capsulePointerState = () =>
    evaluate(`(() => {
      const bar = document.querySelector('[role="toolbar"][aria-label="Page and zoom controls"]');
      if (!bar) return { present: false };
      const find = (re) => [...bar.querySelectorAll('button')]
        .find((b) => re.test((b.getAttribute('aria-label') || '').trim()));
      const sel = find(/^Select tool/); const pan = find(/^Pan tool/);
      const read = (b) => (b ? b.getAttribute('aria-pressed') === 'true' : null);
      return { selectPressed: read(sel), panPressed: read(pan), present: Boolean(sel && pan) };
    })()`);

  /** The TOOL ROW's active-tool report (accent style + aria-pressed). */
  const toolbarActive = () =>
    evaluate(`(() => {
      const row = document.querySelector('[role="toolbar"][aria-label="Tools"]');
      const pressed = row
        ? [...row.querySelectorAll('button[aria-pressed="true"]')]
            .map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim())
        : [];
      // Only MENU triggers count as "expanded" — Inspector sections also carry
      // aria-expanded, and counting those reports an open menu that is not there.
      const expanded = [...document.querySelectorAll('button[aria-haspopup="menu"][aria-expanded="true"]')]
        .map((b) => (b.getAttribute('aria-label') || '').trim());
      // The cluster trigger names the tool it currently holds, e.g.
      // "Add Shape (current: Rectangle)".
      const triggers = row
        ? [...row.querySelectorAll('button[aria-haspopup="menu"]')]
            .map((b) => (b.getAttribute('aria-label') || '').trim())
        : [];
      return { pressed, expanded, triggers };
    })()`);

  const inspectorHeadings = () =>
    evaluate(`(() => [...document.querySelectorAll('aside h1,aside h2,aside h3,aside h4,aside [role="heading"]')]
      .map((h) => (h.textContent || '').trim()).filter(Boolean).slice(0, 12))()`);

  const handleCount = () =>
    evaluate(`document.querySelectorAll('[data-handle], [aria-label*="handle" i]').length`);

  const lastObjectBox = () =>
    evaluate(`(() => {
      const el = [...document.querySelectorAll('main svg [data-object-id]')].pop();
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    })()`);

  /**
   * Opens a toolbar cluster menu with a real click on its trigger, then reports
   * whether the named item is genuinely HIT-TESTABLE — `elementFromPoint` at the
   * item's own centre must resolve to the item (or its descendant), not to the
   * canvas. This is the assertion the original bug failed.
   */
  const openMenuAndProbe = async (triggerRe, itemRe) => {
    const trigger = await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) =>
        ${triggerRe}.test((x.getAttribute('aria-label') || x.textContent || '').trim()));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
               label: (b.getAttribute('aria-label') || b.textContent || '').trim() };
    })()`);
    if (!trigger) return { opened: false };
    await mouseClick(trigger.x, trigger.y);
    await sleep(320);
    const item = await evaluate(`(() => {
      const items = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')];
      // An item's textContent concatenates its label AND its <kbd> shortcut
      // ("RectangleR", "DrawD"), so the NAME is the first span, not textContent.
      const nameOf = (el) => {
        const span = el.querySelector('span');
        return ((span ? span.textContent : el.textContent) || '').trim();
      };
      const el = items.find((x) => ${itemRe}.test(nameOf(x)));
      if (!el) return { found: false, items: items.map(nameOf) };
      const r = el.getBoundingClientRect();
      const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
      const hit = document.elementFromPoint(cx, cy);
      const menu = el.closest('[role="menu"]');
      const mr = menu.getBoundingClientRect();
      return {
        found: true, x: cx, y: cy,
        // The claim: the point at the item's centre belongs to the item.
        hitOk: Boolean(hit && (el === hit || el.contains(hit))),
        hitTag: hit ? (hit.tagName + (hit.getAttribute('role') ? '[' + hit.getAttribute('role') + ']' : '')) : 'none',
        menuBox: { y: Math.round(mr.y), bottom: Math.round(mr.bottom), h: Math.round(mr.height) },
        role: menu.getAttribute('role'),
        label: nameOf(el),
      };
    })()`);
    return { opened: true, trigger, item };
  };

  console.log("\n===================== SHAPE =====================");

  // ---- 1/2. Menu opens by real click and its items are hit-testable ---------
  const shapeMenu = await openMenuAndProbe("/Add Shape|^Shape/", "/^Rectangle$/");
  check("Shape menu opens from a real toolbar click", Boolean(shapeMenu.opened && shapeMenu.item?.found),
    shapeMenu.item?.found ? `items visible` : `items: ${JSON.stringify(shapeMenu.item?.items || [])}`);
  check("Shape menu is role=menu with role=menuitem children", shapeMenu.item?.role === "menu");
  check(
    "Rectangle item is genuinely hit-testable (the clipping bug)",
    shapeMenu.item?.hitOk === true,
    `elementFromPoint => ${shapeMenu.item?.hitTag}; menu y=${shapeMenu.item?.menuBox?.y} bottom=${shapeMenu.item?.menuBox?.bottom} h=${shapeMenu.item?.menuBox?.h}`,
  );
  await shot("shape-menu");

  // ---- 3. A real click on the item activates the tool -----------------------
  if (shapeMenu.item?.found) await mouseClick(shapeMenu.item.x, shapeMenu.item.y);
  await sleep(400);
  const afterActivate = await toolbarActive();
  check(
    "clicking Rectangle activates the Rectangle tool",
    afterActivate.pressed.some((l) => /rectangle/i.test(l)) ||
      afterActivate.triggers.some((l) => /current: Rectangle/i.test(l)),
    `pressed=${JSON.stringify(afterActivate.pressed)} triggers=${JSON.stringify(afterActivate.triggers)}`,
  );
  check("the menu closed after selecting an item", afterActivate.expanded.length === 0,
    `still expanded: ${JSON.stringify(afterActivate.expanded)}`);

  // ---- The false-active-Select defect --------------------------------------
  const capsuleWithRect = await capsulePointerState();
  check(
    "bottom capsule does NOT claim Select while Rectangle is active",
    capsuleWithRect.present ? capsuleWithRect.selectPressed === false : true,
    `Select aria-pressed=${capsuleWithRect.selectPressed}, Pan=${capsuleWithRect.panPressed}`,
  );
  check(
    "bottom capsule does NOT claim Pan while Rectangle is active",
    capsuleWithRect.present ? capsuleWithRect.panPressed === false : true,
  );

  // ---- 4/5/6. Drag: preview mid-gesture, exactly one object on release -----
  const page = await pageRect();
  check("page surface found", Boolean(page), JSON.stringify(page));
  const before = await countObjects();
  const x0 = page.x + Math.round(page.w * 0.22);
  const y0 = page.y + Math.round(page.h * 0.3);
  const x1 = x0 + 160;
  const y1 = y0 + 100;

  await mouseDown(x0, y0);
  for (let i = 1; i <= 8; i++) {
    await mouseMove(x0 + Math.round((i * (x1 - x0)) / 8), y0 + Math.round((i * (y1 - y0)) / 8));
    await sleep(40);
  }
  const midCount = await countObjects();
  const midPreview = await evaluate(
    `document.querySelectorAll('main svg rect[data-shape-draft]').length`,
  );
  await shot("shape-drag-preview");
  check("mid-drag creates NO model object (deferred commit)", midCount === before,
    `before=${before} mid=${midCount}`);
  check("mid-drag shows a live dashed preview", midPreview >= 1, `dashed rects=${midPreview}`);
  await mouseUp(x1, y1);
  await sleep(700);

  const after = await countObjects();
  check("pointer-up commits EXACTLY ONE object", after - before === 1, `before=${before} after=${after}`);
  const previewGone = await evaluate(`document.querySelectorAll('main svg rect[data-shape-draft]').length`);
  check("the draft preview is removed after commit", previewGone === 0, `dashed rects left=${previewGone}`);
  await shot("shape-created");

  // ---- 7. Geometry matches the pointer rectangle (the old +20% defect) -----
  const box = await lastObjectBox();
  const wErr = box ? Math.abs(box.w - (x1 - x0)) : Infinity;
  const hErr = box ? Math.abs(box.h - (y1 - y0)) : Infinity;
  check(
    "committed geometry matches the dragged rectangle (no 1.2x scaling)",
    wErr <= 6 && hErr <= 6,
    `drag=${x1 - x0}x${y1 - y0} committed=${box?.w}x${box?.h} err=${wErr}x${hErr}`,
  );

  // ---- 8/9. Inspector + selection chrome ----------------------------------
  const heads = await inspectorHeadings();
  const handles = await handleCount();
  check("Inspector reports Shape for the new object", heads.some((h) => /shape|rectangle/i.test(h)),
    JSON.stringify(heads));
  check("the new shape is selected with transform handles", handles >= 8, `handles=${handles}`);
  await shot("shape-selected");

  // ---- 10/11. ONE Undo removes it; ONE Redo restores it -------------------
  await key("z", "KeyZ", 2, "z"); // Ctrl+Z
  await sleep(500);
  const undone = await countObjects();
  check("ONE Undo removes the shape (single history entry)", undone === before,
    `after 1x undo=${undone}, expected ${before}`);
  await key("z", "KeyZ", 10, "z"); // Ctrl+Shift+Z
  await sleep(500);
  const redone = await countObjects();
  check("ONE Redo restores the shape", redone === before + 1, `after redo=${redone}`);

  // ---- 12. A plain click places a sensible default shape ------------------
  const shapeMenu2 = await openMenuAndProbe("/Add Shape|^Shape/", "/^Rectangle$/");
  if (shapeMenu2.item?.found) await mouseClick(shapeMenu2.item.x, shapeMenu2.item.y);
  await sleep(350);
  const beforeClick = await countObjects();
  const cx = page.x + Math.round(page.w * 0.62);
  const cy = page.y + Math.round(page.h * 0.68);
  await mouseClick(cx, cy, 70);
  await sleep(700);
  const afterClick = await countObjects();
  const clickBox = await lastObjectBox();
  check("a plain click places exactly one shape", afterClick - beforeClick === 1,
    `before=${beforeClick} after=${afterClick}`);
  check(
    "the click-placed shape has a sensible default size (not 2x2)",
    Boolean(clickBox && clickBox.w >= 40 && clickBox.h >= 40),
    `size=${clickBox?.w}x${clickBox?.h}`,
  );
  check(
    "the click-placed shape is fully inside the page",
    Boolean(
      clickBox &&
        clickBox.x >= page.x - 2 &&
        clickBox.y >= page.y - 2 &&
        clickBox.x + clickBox.w <= page.x + page.w + 2 &&
        clickBox.y + clickBox.h <= page.y + page.h + 2,
    ),
    `box=${JSON.stringify(clickBox)} page=${JSON.stringify(page)}`,
  );
  await shot("shape-click-default");

  // ---- 13. Escape cancels an in-progress gesture --------------------------
  const shapeMenu3 = await openMenuAndProbe("/Add Shape|^Shape/", "/^Rectangle$/");
  if (shapeMenu3.item?.found) await mouseClick(shapeMenu3.item.x, shapeMenu3.item.y);
  await sleep(350);
  const beforeEsc = await countObjects();
  const ex = page.x + Math.round(page.w * 0.3);
  const ey = page.y + Math.round(page.h * 0.72);
  await mouseDown(ex, ey);
  for (let i = 1; i <= 5; i++) {
    await mouseMove(ex + i * 18, ey + i * 10);
    await sleep(40);
  }
  await key("Escape", "Escape");
  const afterEscBeforeUp = await countObjects();
  const draftAfterEsc = await evaluate(`document.querySelectorAll('main svg rect[data-shape-draft]').length`);
  await mouseUp(ex + 90, ey + 50);
  await sleep(600);
  const afterEscRelease = await countObjects();
  check("Escape mid-drag creates nothing", afterEscBeforeUp === beforeEsc,
    `before=${beforeEsc} afterEsc=${afterEscBeforeUp}`);
  check("Escape removes the draft preview", draftAfterEsc === 0, `dashed=${draftAfterEsc}`);
  check("releasing after Escape still commits nothing", afterEscRelease === beforeEsc,
    `after release=${afterEscRelease}`);

  // ---- 14. An off-page start creates nothing -----------------------------
  const shapeMenu4 = await openMenuAndProbe("/Add Shape|^Shape/", "/^Rectangle$/");
  if (shapeMenu4.item?.found) await mouseClick(shapeMenu4.item.x, shapeMenu4.item.y);
  await sleep(350);
  const beforeOff = await countObjects();
  const offX = Math.max(page.x - 40, 200);
  const offY = page.y + Math.round(page.h * 0.4);
  await mouseDown(offX, offY);
  for (let i = 1; i <= 6; i++) {
    await mouseMove(offX + i * 14, offY + i * 8);
    await sleep(35);
  }
  await mouseUp(offX + 84, offY + 48);
  await sleep(600);
  const afterOff = await countObjects();
  check("a gesture starting OFF the page creates nothing", afterOff === beforeOff,
    `before=${beforeOff} after=${afterOff} (started at x=${offX}, page.x=${page.x})`);

  // ---- 15. Geometry holds at a non-100% zoom -----------------------------
  const zoomInfo = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /Zoom level/i.test(x.getAttribute('aria-label') || ''));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), label: (b.getAttribute('aria-label')||'').trim() };
  })()`);
  let zoomChecked = false;
  if (zoomInfo) {
    await mouseClick(zoomInfo.x, zoomInfo.y);
    await sleep(320);
    const preset = await evaluate(`(() => {
      const el = [...document.querySelectorAll('[role="menuitem"]')].find((x) => /^150%/.test((x.textContent||'').trim()));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    })()`);
    if (preset) {
      await mouseClick(preset.x, preset.y);
      await sleep(800);
      const page150 = await pageRect();
      const m5 = await openMenuAndProbe("/Add Shape|^Shape/", "/^Rectangle$/");
      if (m5.item?.found) await mouseClick(m5.item.x, m5.item.y);
      await sleep(350);
      const b150 = await countObjects();
      const zx = page150.x + Math.round(page150.w * 0.2);
      const zy = page150.y + Math.round(page150.h * 0.2);
      await mouseDown(zx, zy);
      for (let i = 1; i <= 6; i++) { await mouseMove(zx + i * 20, zy + i * 12); await sleep(40); }
      await mouseUp(zx + 120, zy + 72);
      await sleep(700);
      const a150 = await countObjects();
      const zbox = await lastObjectBox();
      const zwErr = zbox ? Math.abs(zbox.w - 120) : Infinity;
      const zhErr = zbox ? Math.abs(zbox.h - 72) : Infinity;
      check("at 150% zoom the drag still commits exactly one object", a150 - b150 === 1, `before=${b150} after=${a150}`);
      check("at 150% zoom the committed box matches the pointer box", zwErr <= 8 && zhErr <= 8,
        `drag=120x72 committed=${zbox?.w}x${zbox?.h}`);
      zoomChecked = true;
      // Back to 100% for the Draw section.
      await mouseClick(zoomInfo.x, zoomInfo.y);
      await sleep(300);
      const p100 = await evaluate(`(() => {
        const el = [...document.querySelectorAll('[role="menuitem"]')].find((x) => /^100%/.test((x.textContent||'').trim()));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
      })()`);
      if (p100) { await mouseClick(p100.x, p100.y); await sleep(700); }
    }
  }
  if (!zoomChecked) console.log("NOTE  zoom geometry check skipped — zoom preset menu not reachable");

  console.log("\n===================== DRAW ======================");

  // ---- Draw menu, real click activation ----------------------------------
  const drawMenu = await openMenuAndProbe("/^Draw/", "/^(Pen|Draw|Freehand)$/");
  check("Draw menu opens from a real toolbar click", Boolean(drawMenu.opened && drawMenu.item?.found),
    drawMenu.item?.found ? "items visible" : `items: ${JSON.stringify(drawMenu.item?.items || [])}`);
  check("Draw menu items are genuinely hit-testable", drawMenu.item?.hitOk === true,
    `elementFromPoint => ${drawMenu.item?.hitTag}`);
  await shot("draw-menu");
  if (drawMenu.item?.found) await mouseClick(drawMenu.item.x, drawMenu.item.y);
  await sleep(420);

  const drawActive = await toolbarActive();
  check("clicking the Draw item activates the Draw tool",
    drawActive.pressed.some((l) => /draw|pen|freehand/i.test(l)) ||
      drawActive.triggers.some((l) => /current: (Draw|Pen|Freehand)/i.test(l)),
    `pressed=${JSON.stringify(drawActive.pressed)} triggers=${JSON.stringify(drawActive.triggers)}`);
  const capsuleWithDraw = await capsulePointerState();
  check("bottom capsule does NOT claim Select while Draw is active",
    capsuleWithDraw.present ? capsuleWithDraw.selectPressed === false : true,
    `Select aria-pressed=${capsuleWithDraw.selectPressed}`);
  await shot("draw-active");

  // ---- Stroke: live preview, exactly one commit -------------------------
  const pageD = await pageRect();
  const beforeDraw = await countObjects();
  const sx = pageD.x + Math.round(pageD.w * 0.5);
  const sy = pageD.y + Math.round(pageD.h * 0.55);
  await mouseDown(sx, sy);
  for (let i = 1; i <= 12; i++) {
    await mouseMove(sx + i * 9, sy + Math.round(Math.sin(i / 2) * 22));
    await sleep(35);
  }
  const midStroke = await evaluate(`document.querySelectorAll('main svg polyline, main svg path').length`);
  const midDrawCount = await countObjects();
  await shot("draw-stroke-preview");
  check("mid-stroke shows live path geometry", midStroke >= 1, `polyline/path=${midStroke}`);
  check("mid-stroke creates NO model object yet", midDrawCount === beforeDraw,
    `before=${beforeDraw} mid=${midDrawCount}`);
  await mouseUp(sx + 108, sy);
  await sleep(800);
  const afterDraw = await countObjects();
  check("pointer-up commits EXACTLY ONE drawing", afterDraw - beforeDraw === 1,
    `before=${beforeDraw} after=${afterDraw}`);

  const drawHeads = await inspectorHeadings();
  check("Inspector reports Drawing for the new stroke",
    drawHeads.some((h) => /drawing|stroke|path/i.test(h)), JSON.stringify(drawHeads));
  await shot("draw-selected");

  await key("z", "KeyZ", 2, "z");
  await sleep(500);
  const drawUndone = await countObjects();
  check("ONE Undo removes the drawing", drawUndone === beforeDraw, `after undo=${drawUndone}`);
  await key("z", "KeyZ", 10, "z");
  await sleep(500);
  const drawRedone = await countObjects();
  check("ONE Redo restores the drawing", drawRedone === beforeDraw + 1, `after redo=${drawRedone}`);

  console.log("\n============ PORTAL MENU KEYBOARD / DISMISS ============");

  // Keyboard: the portal must not have cost arrow navigation or focus return.
  const kb = await evaluate(`(() => {
    const t = [...document.querySelectorAll('button')].find((x) =>
      /Add Shape|^Shape/.test((x.getAttribute('aria-label') || x.textContent || '').trim()));
    if (!t) return null;
    t.focus();
    return { focused: document.activeElement === t, expanded: t.getAttribute('aria-expanded'), haspopup: t.getAttribute('aria-haspopup') };
  })()`);
  check("cluster trigger has aria-haspopup=menu", kb?.haspopup === "menu");
  await key("ArrowDown", "ArrowDown");
  await sleep(320);
  const afterArrow = await evaluate(`(() => {
    const a = document.activeElement;
    const menu = a ? a.closest('[role="menu"]') : null;
    return { role: a?.getAttribute('role'), label: (a?.textContent || '').trim(), inMenu: Boolean(menu) };
  })()`);
  check("ArrowDown from the trigger opens the menu and focuses an item",
    afterArrow.inMenu && afterArrow.role === "menuitem", JSON.stringify(afterArrow));
  await key("ArrowDown", "ArrowDown");
  await sleep(200);
  const afterArrow2 = await evaluate(`(() => ({ label: (document.activeElement?.textContent || '').trim() }))()`);
  check("ArrowDown moves between menu items", afterArrow2.label !== afterArrow.label,
    `${afterArrow.label} -> ${afterArrow2.label}`);
  await key("Escape", "Escape");
  await sleep(320);
  const afterEscape = await evaluate(`(() => {
    const open = document.querySelectorAll('[role="menu"]').length;
    const a = document.activeElement;
    return { open, focusLabel: (a?.getAttribute('aria-label') || a?.textContent || '').trim(),
             expanded: [...document.querySelectorAll('button[aria-haspopup="menu"][aria-expanded="true"]')].length };
  })()`);
  check("Escape closes the portalled menu", afterEscape.expanded === 0, JSON.stringify(afterEscape));
  check("Escape returns focus to the trigger", /shape/i.test(afterEscape.focusLabel),
    `focus=${afterEscape.focusLabel}`);

  // Click-outside must dismiss.
  const reopened = await openMenuAndProbe("/Add Shape|^Shape/", "/^Rectangle$/");
  check("menu reopens after Escape", Boolean(reopened.item?.found));
  await mouseClick(page.x + Math.round(page.w * 0.9), page.y + 12);
  await sleep(360);
  const afterOutside = await evaluate(`[...document.querySelectorAll('button[aria-haspopup="menu"][aria-expanded="true"]')].length`);
  check("clicking outside closes the menu", afterOutside === 0, `expanded=${afterOutside}`);

  // A menu near the viewport bottom must stay inside the viewport.
  const clamp = await evaluate(`(() => {
    const t = [...document.querySelectorAll('button')].find((x) =>
      /Add Shape|^Shape/.test((x.getAttribute('aria-label') || x.textContent || '').trim()));
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { triggerBottom: Math.round(r.bottom) };
  })()`);
  const reopen2 = await openMenuAndProbe("/Add Shape|^Shape/", "/^Rectangle$/");
  const menuBox = reopen2.item?.menuBox;
  check(
    "the open menu stays inside the viewport",
    Boolean(menuBox && menuBox.y >= 0 && menuBox.bottom <= 900),
    `menu y=${menuBox?.y} bottom=${menuBox?.bottom} viewport=900, trigger bottom=${clamp?.triggerBottom}`,
  );
  check(
    "the menu is NOT clipped to the toolbar row (the root cause)",
    Boolean(menuBox && menuBox.h > 60),
    `menu height=${menuBox?.h} (was clipped to ~38px)`,
  );
  await key("Escape", "Escape");

  console.log("\n=============== CONSOLE ===============");
  const realErrors = consoleErrors.filter(
    (e) => !/favicon|ERR_INTERNET_DISCONNECTED|net::ERR_FAILED|Download the React DevTools/i.test(e),
  );
  for (const e of realErrors) console.log("  ERR:", e);
  check("no unexplained console errors", realErrors.length === 0, `${realErrors.length} error(s)`);

  console.log(`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} FAILURE(S)`}`);
  if (failures.length) for (const f of failures) console.log("  - " + f);

  sock.close();
  chrome.kill();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
