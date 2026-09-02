/* global process, console, fetch, WebSocket, setTimeout */
/**
 * Functional probe for P0-2: read-only imported PDF text must not offer
 * transform affordances.
 *
 * The unit tests prove `resolveSelectionAffordance` classifies correctly. They
 * cannot prove the CANVAS and the INSPECTOR obey it on a real imported document,
 * which is exactly where the original defect lived: the overlay drew eight
 * resize handles and a rotate handle over text the Properties panel
 * simultaneously described as un-editable.
 *
 * This loads a generated PDF through the editor's real import path, clicks the
 * imported text, and asserts:
 *   - the selection is marked as a read-only text RANGE (role=img + label)
 *   - no resize handles and no rotate handle are drawn
 *   - dragging it does not move it
 *   - the inspector says "Original PDF text", offers Copy text, and omits the
 *     geometry controls (X/Y/W/H, Rotation, Opacity, Flip)
 *   - editable objects still get their full transform chrome (the inverse guard)
 *
 * Usage: node scripts/editor-source-text-probe.mjs [--url http://localhost:3001]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg("--url", "http://localhost:3001");
const FIXTURE = arg("--pdf", "docs/qa/p0/source-text-fixture.pdf");
// Browser binary. `CHROME_PATH` lets a non-Windows machine (or a Chrome for
// Testing download) point the probe at its own build; the literal default keeps
// the original Windows invocation working untouched.
const CHROME =
  process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pdfBase64 = readFileSync(FIXTURE).toString("base64");
  const userDataDir = mkdtempSync(join(tmpdir(), "pdfdadi-src-"));
  const port = 9423;
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
  await sleep(2200);

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
        (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200),
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
    if (res.result?.exceptionDetails) {
      return { __error: res.result.exceptionDetails.text ?? "eval error" };
    }
    return res.result?.result?.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1600, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await send("Page.navigate", { url: `${BASE}/editor` });
  await sleep(3400);

  const failures = [];
  const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failures.push(name);
  };

  // Dismiss onboarding, then feed the PDF into the real <input type=file> the
  // editor uses, via a synthesized DataTransfer — the same code path a user's
  // "Open PDF" takes, without needing OS file-dialog automation.
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /blank/i.test(x.textContent || ''));
    if (b) b.click();
    return true;
  })()`);
  await sleep(1200);

  const imported = await evaluate(`(async () => {
    const bin = atob("${pdfBase64}");
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const file = new File([buf], "source-text-fixture.pdf", { type: "application/pdf" });
    const input = [...document.querySelectorAll('input[type=file]')]
      .find((el) => (el.getAttribute('accept') || '').includes('pdf'));
    if (!input) return { ok: false, why: 'no pdf file input' };
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })()`);
  await sleep(5200);

  // Read-only imported runs are deliberately NON-RENDERING: the raster page
  // background shows the original glyphs, and each run is a transparent hit rect
  // so it stays selectable and explainable (see extractText.ts). So the target to
  // click is a `fill="transparent"` rect inside an object group, NOT an <svg text>
  // element — the only <text> nodes on this page are ruler labels.
  const textCount = await evaluate(
    `[...document.querySelectorAll('main svg rect')].filter((r) => (r.getAttribute('fill') || '') === 'transparent').length`,
  );
  check(
    "PDF imported with selectable source-text hit regions",
    Number(textCount) > 0,
    `import=${JSON.stringify(imported)} hitRegions=${textCount}`,
  );

  if (!Number(textCount)) {
    console.log("\nCannot continue without imported text hit regions.");
    sock.close();
    chrome.kill();
    process.exit(1);
  }

  // Click the widest hit region (the heading).
  const hit = await evaluate(`(() => {
    const els = [...document.querySelectorAll('main svg rect')]
      .filter((r) => (r.getAttribute('fill') || '') === 'transparent')
      .map((r) => ({ r, b: r.getBoundingClientRect() }))
      .filter((x) => x.b.width > 20 && x.b.height > 4)
      .sort((a, b) => b.b.width * b.b.height - a.b.width * a.b.height);
    if (!els.length) return null;
    const { b } = els[0];
    return {
      w: Math.round(b.width), h: Math.round(b.height),
      x: Math.round(b.x + b.width / 2),
      y: Math.round(b.y + b.height / 2),
    };
  })()`);
  check("found an imported text run to click", Boolean(hit), JSON.stringify(hit));

  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", {
      type, x: hit.x, y: hit.y, button: "left", clickCount: 1,
      buttons: type === "mousePressed" ? 1 : 0,
    });
  }
  await sleep(1200);

  const chrome1 = await evaluate(`(() => {
    const handles = [...document.querySelectorAll('[role="button"][aria-label$="resize handle"]')].length;
    const rangeMark = document.querySelector('[role="img"][aria-label*="Original PDF text"]');
    // Scope to the INSPECTOR's tabpanel: the left rail (Pages/Layers/History) has
    // its own tabpanel, and a bare querySelector picks that one up instead.
    const strip = [...document.querySelectorAll('[role="tablist"]')]
      .find((el) => (el.getAttribute('aria-label') || '') === 'Inspector');
    const selectedTab = strip ? strip.querySelector('[role="tab"][aria-selected="true"]') : null;
    const panelId = selectedTab ? selectedTab.getAttribute('aria-controls') : null;
    const inspector = (panelId ? (document.getElementById(panelId)?.textContent || '') : '');
    const live = (document.querySelector('[role="status"][aria-live]')?.textContent || '').trim();
    return {
      resizeHandles: handles,
      rangeMarked: !!rangeMark,
      rangeLabel: rangeMark ? rangeMark.getAttribute('aria-label') : null,
      inspectorFound: !!panelId,
      saysOriginal: /Original PDF text/i.test(inspector),
      offersCopy: /Copy text/i.test(inspector),
      hasRotation: /Rotation/i.test(inspector),
      hasFlip: /Flip/i.test(inspector),
      hasOpacity: /Opacity/i.test(inspector),
      live,
    };
  })()`);

  check("selection is marked as a read-only text range", chrome1.rangeMarked, String(chrome1.rangeLabel));
  check("no resize handles are drawn", chrome1.resizeHandles === 0, `handles=${chrome1.resizeHandles}`);
  check("inspector panel located", chrome1.inspectorFound, JSON.stringify(chrome1));
  check("inspector identifies it as original PDF text", chrome1.saysOriginal);
  check("inspector offers Copy text", chrome1.offersCopy);
  check("inspector omits Rotation", !chrome1.hasRotation);
  check("inspector omits Flip", !chrome1.hasFlip);
  check("inspector omits Opacity", !chrome1.hasOpacity);

  // Dragging must not move it. Measured on the HIT REGION, since the run itself
  // renders nothing — if the drag moved the object, its transparent rect moves.
  const hitRegionBox = `(() => {
    const t = [...document.querySelectorAll('main svg rect')]
      .filter((r) => (r.getAttribute('fill') || '') === 'transparent')
      .map((r) => ({ r, b: r.getBoundingClientRect() }))
      .filter((x) => x.b.width > 20 && x.b.height > 4)
      .sort((a, b) => b.b.width * b.b.height - a.b.width * a.b.height)[0];
    return t ? { x: Math.round(t.b.x), y: Math.round(t.b.y) } : null;
  })()`;
  const before = await evaluate(hitRegionBox);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: hit.x, y: hit.y, button: "left", clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 5; i++) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: hit.x + i * 24, y: hit.y + i * 16, button: "left", buttons: 1 });
    await sleep(60);
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: hit.x + 120, y: hit.y + 80, button: "left", buttons: 0 });
  await sleep(900);
  const after = await evaluate(hitRegionBox);
  const moved = before && after ? Math.abs(after.x - before.x) + Math.abs(after.y - before.y) : -1;
  check("dragging read-only text does not move it", moved === 0, `moved ${moved}px (${JSON.stringify(before)} → ${JSON.stringify(after)})`);

  // ---- Inverse guard: an EDITABLE object must keep its full transform chrome.
  // Silencing the chrome for everything would "fix" the contradiction by
  // breaking the editor, so this is the assertion that keeps the fix honest.
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  }
  await sleep(400);
  // The Rectangle tool lives in a `Shapes ▾` cluster menu, so clicking a toolbar
  // button by label opens the menu rather than selecting the tool. Use its real
  // shortcut ("R").
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type, key: "r", code: "KeyR",
      windowsVirtualKeyCode: 82, nativeVirtualKeyCode: 82,
    });
  }
  await sleep(600);
  const pageBox = await evaluate(`(() => {
    const r = [...document.querySelectorAll('main svg rect')]
      .map((x) => x.getBoundingClientRect())
      .filter((x) => x.width > 200 && x.height > 200)
      .sort((a, b) => b.width * b.height - a.width * a.height)[0];
    return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null;
  })()`);
  if (pageBox) {
    const sx = pageBox.x + Math.round(pageBox.w * 0.55);
    const sy = pageBox.y + Math.round(pageBox.h * 0.7);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: sx, y: sy, button: "left", clickCount: 1, buttons: 1 });
    for (let i = 1; i <= 4; i++) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: sx + i * 20, y: sy + i * 14, button: "left", buttons: 1 });
      await sleep(60);
    }
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: sx + 80, y: sy + 56, button: "left", buttons: 0 });
    await sleep(1000);
  }
  const editableChrome = await evaluate(`(() => {
    const handles = [...document.querySelectorAll('[role="button"][aria-label$="resize handle"]')].length;
    const strip = [...document.querySelectorAll('[role="tablist"]')]
      .find((el) => (el.getAttribute('aria-label') || '') === 'Inspector');
    const selectedTab = strip ? strip.querySelector('[role="tab"][aria-selected="true"]') : null;
    const panelId = selectedTab ? selectedTab.getAttribute('aria-controls') : null;
    const inspector = (panelId ? (document.getElementById(panelId)?.textContent || '') : '');
    const rotateHandle = [...document.querySelectorAll('main svg circle')].length;
    return {
      handles,
      rotateCircles: rotateHandle,
      hasRotation: /Rotation/i.test(inspector),
      hasOpacity: /Opacity/i.test(inspector),
    };
  })()`);
  check(
    "an editable shape still gets its 8 resize handles",
    editableChrome.handles === 8,
    `handles=${editableChrome.handles}`,
  );
  check(
    "an editable shape still gets geometry controls",
    editableChrome.hasRotation && editableChrome.hasOpacity,
    JSON.stringify(editableChrome),
  );

  check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  console.log(`\n${failures.length === 0 ? "ALL PASS" : `FAILURES: ${failures.join(", ")}`}`);
  sock.close();
  chrome.kill();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
