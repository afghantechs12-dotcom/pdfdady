/* global process, console, fetch, WebSocket, setTimeout */
/**
 * Functional probe for the P1 Phase G floating object toolbar.
 *
 * `objectToolbarActions.test.ts` proves the RESOLVER is correct. It cannot prove
 * the bar is wired, positioned, or that it appears on the path users take. This
 * probe drives the real editor in a real browser.
 *
 * It also pins down a render-ordering trap. The mount condition must read the
 * `gestureActive` STATE mirror, never `gestureRef.current` — see the setGesture
 * comment in EditorCanvas. A render-time ref read passes every check in this
 * file, but only because pointer-up happens to call `setSnapGuides([])`, whose
 * fresh array forces a render. Turn that into the ordinary
 * `prev.length === 0 ? prev : []` bail-out and the ref version leaves the bar
 * permanently invisible after a click-to-select (6 checks here fail), while the
 * state version is unaffected. Both were run; that is where the mirror came from.
 *
 * Asserted here:
 *   1. Appears     — selecting a shape by CLICK shows the bar.
 *   2. Survives    — it is still there after a drag (pointer-up restores it).
 *   3. Contents    — a shape offers Fill/Stroke/Duplicate/Delete/More.
 *   4. Placement   — it is inside the canvas and does not cover the object.
 *   5. Hidden      — no selection → no bar.
 *   6. Functional  — Duplicate adds an object AND Undo reverses it.
 *   7. A11y        — role=toolbar, an accessible name, and arrow-key roving.
 *
 * Usage: node scripts/editor-object-toolbar-probe.mjs [--url http://localhost:3001]
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg("--url", "http://localhost:3001");
// Browser binary. `CHROME_PATH` lets a non-Windows machine (or a Chrome for
// Testing download) point the probe at its own build; the literal default keeps
// the original Windows invocation working untouched.
const CHROME =
  process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), "pdfdadi-otb-"));
  const port = 9427;
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
    return res.result?.result?.value;
  };
  /**
   * A REALISTIC click. CDP will happily dispatch mousePressed and mouseReleased
   * in the same millisecond, which no human hand does — and a zero-delay click
   * hides render-ordering bugs, because an async re-render scheduled by
   * pointer-down lands after pointer-up has already cleaned up. Hold the button
   * for ~110ms so any state committed on pointer-down has rendered before the
   * release, the way it would for a real user.
   */
  const click = async (x, y, clickCount = 1, holdMs = 110) => {
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", clickCount, buttons: 1,
    });
    await sleep(holdMs);
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", clickCount, buttons: 0,
    });
  };
  const key = async (k, code, vk) => {
    for (const type of ["keyDown", "keyUp"]) {
      await send("Input.dispatchKeyEvent", {
        type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      });
    }
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

  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /blank/i.test(x.textContent || ''));
    if (b) { b.click(); return 'clicked'; }
    return 'none';
  })()`);
  await sleep(1400);

  const pageRect = async () =>
    evaluate(`(() => {
      const rects = [...document.querySelectorAll('main svg rect')]
        .map((r) => r.getBoundingClientRect())
        .filter((b) => b.width > 200 && b.height > 200)
        .sort((a, b) => b.width * b.height - a.width * a.height);
      if (!rects.length) return null;
      const b = rects[0];
      return {
        x: Math.round(b.x), y: Math.round(b.y),
        w: Math.round(b.width), h: Math.round(b.height),
        cx: Math.round(b.x + b.width / 2), cy: Math.round(b.y + b.height / 2),
      };
    })()`);

  /** The floating bar's state: its own role=toolbar that is NOT the main tool row. */
  const bar = async () =>
    evaluate(`(() => {
      const bars = [...document.querySelectorAll('[role="toolbar"]')]
        .filter((el) => /^Actions for |^Object actions$/.test(el.getAttribute('aria-label') || ''));
      if (!bars.length) return { present: false };
      const el = bars[0];
      const r = el.getBoundingClientRect();
      return {
        present: true,
        label: el.getAttribute('aria-label'),
        side: el.getAttribute('data-side'),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        buttons: [...el.querySelectorAll('button')].map((b) => ({
          label: (b.getAttribute('aria-label') || '').trim(),
          disabled: b.disabled,
          tabIndex: b.tabIndex,
          h: Math.round(b.getBoundingClientRect().height),
        })),
        count: bars.length,
      };
    })()`);

  const objectCount = async () =>
    evaluate(`document.querySelectorAll('main svg [data-object-id]').length`);

  // ------------------------------------------------------- no selection → none
  const idle = await bar();
  check("no floating toolbar with an empty selection", idle.present === false, JSON.stringify(idle));

  // ------------------------------------------------------------ draw a rectangle
  // Use the keyboard shortcut: shape tools live in a cluster menu.
  await key("r", "KeyR", 82);
  await sleep(500);
  let page = await pageRect();
  if (!page) {
    check("page surface found", false, "no page rect");
  } else {
    const x0 = page.x + Math.round(page.w * 0.25);
    const y0 = page.y + Math.round(page.h * 0.4);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 6; i++) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved", x: x0 + i * 22, y: y0 + i * 14, button: "left", buttons: 1,
      });
      await sleep(35);
    }
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x0 + 132, y: y0 + 84, button: "left", buttons: 0 });
    await sleep(1000);
  }

  const afterCreate = await bar();
  check(
    "the bar appears for the newly created shape",
    afterCreate.present === true,
    JSON.stringify(afterCreate.rect ?? afterCreate),
  );
  check(
    "exactly one floating bar (not one per selection change)",
    afterCreate.count === 1 || !afterCreate.present,
    `count=${afterCreate.count}`,
  );

  // ------------------------------------------------- click-to-select the shape
  // Deselect, then select the SAME shape by a plain click. This is the path with
  // no state change of its own between pointer-down and pointer-up, so it is the
  // one that depends on the gesture mirror rather than an incidental re-render.
  await key("Escape", "Escape", 27);
  await sleep(600);
  const afterEscape = await bar();
  check("Escape clears the selection and hides the bar", afterEscape.present === false, JSON.stringify(afterEscape));

  const shapeCenter = await evaluate(`(() => {
    const el = [...document.querySelectorAll('main svg [data-object-id]')].pop();
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
             top: Math.round(r.y), bottom: Math.round(r.y + r.height),
             left: Math.round(r.x), right: Math.round(r.x + r.width) };
  })()`);

  if (shapeCenter) {
    await click(shapeCenter.x, shapeCenter.y);
    await sleep(900);
  }
  const afterClick = await bar();
  check(
    "a plain click on the shape shows the bar",
    afterClick.present === true,
    JSON.stringify(afterClick.rect ?? afterClick),
  );

  // -------------------------------------------------------------- bar contents
  const labels = (afterClick.buttons || []).map((b) => b.label);
  check(
    "a shape offers Fill/Stroke/Duplicate/Delete/More",
    JSON.stringify(labels) === JSON.stringify(["Fill", "Stroke", "Duplicate", "Delete", "More"]),
    JSON.stringify(labels),
  );
  check(
    "the bar has an accessible name describing its subject",
    /^Actions for /.test(afterClick.label || ""),
    String(afterClick.label),
  );
  check(
    "exactly one button is in the tab order (roving tabindex)",
    (afterClick.buttons || []).filter((b) => b.tabIndex === 0).length === 1,
    JSON.stringify((afterClick.buttons || []).map((b) => b.tabIndex)),
  );

  // ------------------------------------------------------------------ placement
  if (shapeCenter && afterClick.present) {
    const r = afterClick.rect;
    const p = await pageRect();
    const canvasBox = await evaluate(`(() => {
      const m = document.querySelector('main');
      const b = m.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    })()`);
    check(
      "the bar is fully inside the canvas region",
      r.x >= canvasBox.x - 1 && r.x + r.w <= canvasBox.x + canvasBox.w + 1 &&
        r.y >= canvasBox.y - 1 && r.y + r.h <= canvasBox.y + canvasBox.h + 1,
      `bar=${JSON.stringify(r)} canvas=${JSON.stringify(canvasBox)}`,
    );
    check(
      "the bar does not overlap the object it acts on",
      r.y + r.h <= shapeCenter.top + 1 || r.y >= shapeCenter.bottom - 1,
      `bar=${JSON.stringify(r)} obj top=${shapeCenter.top} bottom=${shapeCenter.bottom}`,
    );
    check(
      "the bar is compact enough not to dominate the page",
      r.h <= 48 && r.w <= Math.max(260, (p?.w ?? 600) * 0.6),
      `${r.w}×${r.h}`,
    );
  }

  // --------------------------------------------------- hidden during a drag
  if (shapeCenter) {
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: shapeCenter.x, y: shapeCenter.y, button: "left", buttons: 1, clickCount: 1,
    });
    for (let i = 1; i <= 4; i++) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved", x: shapeCenter.x + i * 12, y: shapeCenter.y + i * 8, button: "left", buttons: 1,
      });
      await sleep(45);
    }
    const midDrag = await bar();
    check("the bar hides while the object is being dragged", midDrag.present === false, JSON.stringify(midDrag));

    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: shapeCenter.x + 48, y: shapeCenter.y + 32, button: "left", buttons: 0,
    });
    await sleep(900);
    const afterDrag = await bar();
    check(
      "the bar returns after the drag ends",
      afterDrag.present === true,
      JSON.stringify(afterDrag.rect ?? afterDrag),
    );
  }

  // ---------------------------------------------------- Duplicate really works
  const before = await objectCount();
  const clicked = await evaluate(`(() => {
    const bars = [...document.querySelectorAll('[role="toolbar"]')]
      .filter((el) => /^Actions for |^Object actions$/.test(el.getAttribute('aria-label') || ''));
    if (!bars.length) return 'no bar';
    const b = [...bars[0].querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'Duplicate');
    if (!b) return 'no duplicate button';
    b.click();
    return 'clicked';
  })()`);
  await sleep(900);
  const after = await objectCount();
  check(
    "Duplicate on the bar actually adds an object",
    clicked === "clicked" && after === before + 1,
    `${clicked}: ${before} → ${after}`,
  );

  // Undo must reverse it — proof the action went through the command system
  // rather than mutating the document behind history's back.
  await evaluate(`document.querySelector('main')?.focus()`);
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type, key: "z", code: "KeyZ", modifiers: 2,
      windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90,
    });
  }
  await sleep(900);
  const undone = await objectCount();
  check(
    "Undo reverses the bar's Duplicate (it is history-backed)",
    undone === before,
    `${after} → ${undone} (expected ${before})`,
  );

  // ------------------------------------------------------- arrow-key roving
  // Re-select first: the Undo above removed the duplicated object, so the
  // selection referenced a deleted id and the bar correctly disappeared (a bar
  // for an object that no longer exists would be a phantom). Assert that
  // property explicitly, then re-select to test focus movement.
  const afterUndoBar = await bar();
  check(
    "no bar for a selection whose object Undo removed",
    afterUndoBar.present === false,
    JSON.stringify(afterUndoBar),
  );

  const reselect = await evaluate(`(() => {
    const el = [...document.querySelectorAll('main svg [data-object-id]')].pop();
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (reselect) {
    await click(reselect.x, reselect.y);
    await sleep(900);
  }
  check("the bar comes back after re-selecting the surviving shape", (await bar()).present === true);

  const roving = await evaluate(`(() => {
    const bars = [...document.querySelectorAll('[role="toolbar"]')]
      .filter((el) => /^Actions for |^Object actions$/.test(el.getAttribute('aria-label') || ''));
    if (!bars.length) return null;
    const btns = [...bars[0].querySelectorAll('button')].filter((b) => !b.disabled);
    if (!btns.length) return null;
    btns[0].focus();
    const first = document.activeElement === btns[0];
    bars[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    return { first, movedTo: (document.activeElement?.getAttribute('aria-label') || '').trim(),
             expected: (btns[1]?.getAttribute('aria-label') || '').trim() };
  })()`);
  check(
    "ArrowRight moves focus along the bar",
    roving !== null && roving.first && roving.movedTo === roving.expected,
    JSON.stringify(roving),
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
