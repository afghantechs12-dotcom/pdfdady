/* global process, console, fetch, WebSocket, setTimeout */
/**
 * Functional probe for the P0 interaction-correctness pass.
 *
 * Unit tests prove the pure resolvers are correct; they cannot prove the
 * features are WIRED. This drives the real editor in a real browser and asserts
 * the four user-visible P0 claims:
 *
 *   1. Add Text  — one click creates a text object AND opens its editor with a
 *                  caret, at a page-relative width (not the old 200pt box).
 *   2. Add Image — an inserted image is scaled to a fraction of the page instead
 *                  of being placed at its natural pixel size (the "covers the
 *                  whole document" defect).
 *   3. Draw      — the live preview stroke uses the SELECTED brush colour/width
 *                  rather than the old hardcoded black 2px, and the committed
 *                  stroke carries those settings.
 *   4. Inspector — exactly ONE docked right panel, with a flat tab strip whose
 *                  Properties/Outline/Comments/Versions tabs switch bodies.
 *
 * Usage: node scripts/editor-p0-probe.mjs [--url http://localhost:3001]
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
  // A dead dev server answers `curl` with 000 and makes every measurement below
  // read zero or undefined — which passes trivially. Refuse to report green
  // against a server that is not actually serving the editor.
  const status = await fetch(`${BASE}/editor`).then((r) => r.status).catch(() => 0);
  console.log(`server ${BASE}/editor -> ${status}`);
  if (status !== 200) {
    console.error("DEAD SERVER — refusing to measure (all-zero results pass vacuously)");
    process.exit(1);
  }

  const userDataDir = mkdtempSync(join(tmpdir(), "pdfdadi-p0-"));
  const port = 9421;
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
  const click = async (x, y, clickCount = 1) => {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        clickCount,
        buttons: type === "mousePressed" ? 1 : 0,
      });
    }
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1600,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: `${BASE}/editor` });
  await sleep(3400);

  const failures = [];
  const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failures.push(name);
  };

  // Dismiss onboarding so the canvas and tool row are live.
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /blank/i.test(x.textContent || ''));
    if (b) { b.click(); return 'clicked'; }
    return 'none';
  })()`);
  await sleep(1400);

  /** Finds the page rect (largest big SVG rect — not the ruler strips). */
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

  const selectTool = async (pattern) =>
    evaluate(`(() => {
      const b = [...document.querySelectorAll('[role="toolbar"] button')].find((x) =>
        ${pattern}.test((x.getAttribute('aria-label') || x.title || x.textContent || '').trim()));
      if (b) { b.click(); return (b.getAttribute('aria-label') || b.textContent || '').trim(); }
      return null;
    })()`);

  /** Switches the left rail to one of Pages / Layers / History. */
  const railTab = async (name) =>
    evaluate(`(() => {
      const t = [...document.querySelectorAll('[role="tab"]')]
        .find((x) => (x.textContent || '').trim() === ${JSON.stringify(name)});
      if (t) { t.click(); return 'clicked'; }
      return 'missing';
    })()`);

  /**
   * An OBJECT MODEL read, not a DOM read: the Layers panel renders one row per
   * `page.objects` entry, so its row count IS the document's object count. This
   * matters because the canvas renders an empty text object as a 4x18px `<text>`
   * holding a single space — visible to `querySelectorAll`, invisible to a human,
   * and indistinguishable from "no object" unless you ask the model.
   *
   * Layer disclosures start COLLAPSED (`expanded = new Set()`), so every layer has
   * to be opened before the object rows exist in the DOM at all. Forgetting that
   * reads 0 objects for every document and passes everything vacuously.
   */
  const documentObjects = async () => {
    await railTab("Layers");
    await sleep(450);
    await evaluate(
      `[...document.querySelectorAll('button[aria-label="Expand layer"]')].forEach((b) => b.click())`,
    );
    await sleep(350);
    return evaluate(`(() => {
      const rows = [...document.querySelectorAll('button[title="Click to select, double-click to rename"]')];
      return { count: rows.length, names: rows.map((r) => (r.textContent || '').trim()) };
    })()`);
  };

  /** The undo button's label — the top of the real command stack. */
  const undoLabel = async () =>
    evaluate(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find((x) => /^Undo/.test(x.getAttribute('aria-label') || x.title || ''));
      if (!b) return null;
      return { label: (b.getAttribute('aria-label') || b.title || '').trim(), disabled: b.disabled === true };
    })()`);

  /** The text the largest-by-area page SVG actually renders, per text object. */
  const renderedText = async () =>
    evaluate(`(() => {
      const svgs = [...document.querySelectorAll('main svg')]
        .map((s) => { const r = s.getBoundingClientRect(); return { s, a: r.width * r.height }; })
        .sort((x, y) => y.a - x.a);
      if (!svgs.length) return [];
      return [...svgs[0].s.querySelectorAll('text')].map((t) => t.textContent);
    })()`);

  // ---------------------------------------------------------------- Inspector
  const inspector = await evaluate(`(() => {
    const strips = [...document.querySelectorAll('[role="tablist"]')]
      .map((el) => (el.getAttribute('aria-label') || '').trim());
    const asides = [...document.querySelectorAll('aside')]
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), label: (el.textContent || '').slice(0, 24) };
      })
      .filter((a) => a.w >= 240);
    const strip = [...document.querySelectorAll('[role="tablist"]')]
      .find((el) => (el.getAttribute('aria-label') || '') === 'Inspector');
    const tabs = strip
      ? [...strip.querySelectorAll('[role="tab"]')].map((t) => ({
          label: (t.textContent || '').trim(),
          selected: t.getAttribute('aria-selected') === 'true',
        }))
      : [];
    return { strips, dockedWide: asides.length, tabs };
  })()`);
  check(
    "exactly one wide docked right panel",
    inspector.dockedWide === 1,
    `wide asides=${inspector.dockedWide}`,
  );
  check(
    "standalone editor offers Properties only (no empty document tabs)",
    inspector.tabs.length === 1 && inspector.tabs[0]?.label === "Properties",
    JSON.stringify(inspector.tabs.map((t) => t.label)),
  );
  check(
    "Properties is the default tab",
    inspector.tabs[0]?.label === "Properties" && inspector.tabs[0]?.selected === true,
    JSON.stringify(inspector.tabs[0] ?? null),
  );

  // Standalone /editor has no workspace document, so document tabs must NOT be
  // offered there. If they are, they would each only explain their emptiness.
  check(
    "no nested second document strip",
    !inspector.strips.includes("Document inspector"),
    JSON.stringify(inspector.strips),
  );

  // ----------------------------------------------------------------- Add Text
  //
  // TEXT COMMIT SEMANTICS (guard for a measured PRODUCT defect).
  //
  // The text tool used to `addText` on pointer-up, so an EMPTY text object entered
  // the document before a character was typed — and Escape, which only closed the
  // editor, left it there. Measured against the object model before the fix:
  //
  //   click        layers=1  history="Added object"       text=""
  //   type         layers=1  editorValue="Escape keeps me?"  text=""
  //   Escape       layers=1  history="Added object"       text=""
  //
  // The user lost the words and kept an invisible, selectable, Layers-listed
  // artifact — and because create and edit were TWO history entries, one Ctrl+Z
  // emptied the text and left the object behind. The old version of this probe
  // asserted only `textPresent` on `main svg text`, which the empty object
  // satisfied, so it passed on the bug.
  //
  // The fix makes a tool-drawn box a DRAFT: nothing enters the document until it
  // is committed with content. That is the same contract the shape tools ship
  // ("Escape cancels, off-page creates nothing"), so these checks are worded
  // against the object model, never the rendered `<text>`.
  const baselineObjects = await documentObjects();
  const textTool = await selectTool("/^(text|add text|text tool)$/i");
  await sleep(400);
  let page = await pageRect();
  if (page) {
    await click(page.cx, page.cy);
    await sleep(1100);
  }
  const textState = await evaluate(`(() => {
    const ta = document.querySelector('main textarea');
    return {
      editorOpen: !!ta,
      focused: !!ta && document.activeElement === ta,
      value: ta ? ta.value : null,
    };
  })()`);
  check("text tool selected", Boolean(textTool), String(textTool));
  check(
    "one click opens the inline text editor with focus",
    textState.editorOpen && textState.focused,
    JSON.stringify(textState),
  );
  const afterOpen = await documentObjects();
  check(
    "opening the editor commits NOTHING to the document (deferred commit)",
    afterOpen.count === baselineObjects.count,
    `objects ${baselineObjects.count} → ${afterOpen.count}`,
  );

  // --- Escape must be a TRUE cancel -----------------------------------------
  // Re-focus the textarea: reading the Layers panel above clicked the rail, which
  // blurs and therefore closes the editor. Re-open it on a fresh spot.
  await selectTool("/^(text|add text|text tool)$/i");
  await sleep(350);
  page = await pageRect();
  await click(page.x + Math.round(page.w * 0.3), page.y + Math.round(page.h * 0.25));
  await sleep(1000);
  await send("Input.insertText", { text: "Escape must discard me" });
  await sleep(400);
  const typedValue = await evaluate(`(() => { const ta = document.querySelector('main textarea'); return ta ? ta.value : null; })()`);
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type, key: "Escape", code: "Escape",
      windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    });
  }
  await sleep(800);
  const afterEscape = await documentObjects();
  const escapeUndo = await undoLabel();
  check(
    "the text really was typed into the editor before Escape",
    typedValue === "Escape must discard me",
    JSON.stringify(typedValue),
  );
  check(
    "Escape leaves NO object behind — not even an empty one",
    afterEscape.count === baselineObjects.count,
    `objects ${baselineObjects.count} → ${afterEscape.count} names=${JSON.stringify(afterEscape.names)}`,
  );
  check(
    "Escape pushes NO history entry",
    escapeUndo !== null && escapeUndo.disabled === true,
    JSON.stringify(escapeUndo),
  );

  // --- Blur must commit, as ONE undoable authoring gesture -------------------
  await selectTool("/^(text|add text|text tool)$/i");
  await sleep(350);
  page = await pageRect();
  await click(page.x + Math.round(page.w * 0.3), page.y + Math.round(page.h * 0.55));
  await sleep(1000);
  await send("Input.insertText", { text: "Blur commits me" });
  await sleep(400);
  // Blur with a real pointer gesture on the page, not `el.blur()`.
  await click(page.x + Math.round(page.w * 0.8), page.y + Math.round(page.h * 0.9));
  await sleep(1000);
  const afterBlur = await documentObjects();
  const blurUndo = await undoLabel();
  const blurRendered = await renderedText();
  check(
    "blur commits the typed text as one object",
    afterBlur.count === baselineObjects.count + 1 && blurRendered.includes("Blur commits me"),
    `objects ${baselineObjects.count} → ${afterBlur.count}, rendered=${JSON.stringify(blurRendered)}`,
  );
  check(
    "authoring text is ONE history entry, not create-then-edit",
    blurUndo !== null && blurUndo.disabled === false && /Add/i.test(blurUndo.label),
    JSON.stringify(blurUndo),
  );
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type, key: "z", code: "KeyZ",
      windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2,
    });
  }
  await sleep(900);
  const afterUndo = await documentObjects();
  check(
    "ONE undo removes the whole text object, it does not just empty it",
    afterUndo.count === baselineObjects.count,
    `objects ${afterBlur.count} → ${afterUndo.count} names=${JSON.stringify(afterUndo.names)}`,
  );

  // --------------------------------------------------------------------- Draw
  // The Draw TOOL lives inside a `Draw ▾` cluster menu, so clicking the toolbar
  // button by label opens the menu instead of selecting the tool. Use the real
  // keyboard shortcut ("D"), which is how a user reaches it anyway.
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type, key: "d", code: "KeyD",
      windowsVirtualKeyCode: 68, nativeVirtualKeyCode: 68,
    });
  }
  await sleep(700);
  const drawTool = await evaluate(`(() => {
    const pressed = [...document.querySelectorAll('[role="toolbar"] button')]
      .find((b) => b.getAttribute('aria-pressed') === 'true' && /draw/i.test((b.getAttribute('aria-label') || b.title || b.textContent || '')));
    const live = (document.querySelector('[role="status"][aria-live]')?.textContent || '').trim();
    return { pressed: pressed ? (pressed.getAttribute('aria-label') || pressed.textContent || '').trim() : null, live };
  })()`);
  const drawControls = await evaluate(`(() => {
    const labels = [...document.querySelectorAll('button, select, input')]
      .map((el) => (el.getAttribute('aria-label') || el.title || '').trim())
      .filter(Boolean);
    return { brushish: labels.filter((l) => /^(pen|marker|highlighter|pencil)$/i.test(l) || /brush|stroke width|opacity/i.test(l)) };
  })()`);
  check("draw tool active via shortcut", drawControls.brushish.length > 0, JSON.stringify(drawTool));
  check(
    "draw exposes brush controls",
    drawControls.brushish.length > 0,
    JSON.stringify(drawControls.brushish.slice(0, 8)),
  );

  // Baseline stroked-path count BEFORE the gesture. The default brush is the pen,
  // which renders as `<path fill="none" stroke=…>`, so counting filled paths (an
  // earlier version of this probe) would always report zero.
  const strokedPaths = async () =>
    evaluate(`[...document.querySelectorAll('main svg path')]
      .filter((p) => (p.getAttribute('stroke') || 'none') !== 'none' && (p.getAttribute('d') || '').length > 8).length`);
  const pathsBefore = await strokedPaths();

  // Drag a stroke and capture the LIVE preview's stroke attributes mid-gesture.
  page = await pageRect();
  let preview = null;
  if (page) {
    const x0 = page.x + Math.round(page.w * 0.3);
    const y0 = page.y + Math.round(page.h * 0.55);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", clickCount: 1, buttons: 1 });
    for (let i = 1; i <= 6; i++) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved", x: x0 + i * 18, y: y0 + (i % 2 ? 12 : -12), button: "left", buttons: 1,
      });
      await sleep(70);
    }
    preview = await evaluate(`(() => {
      const pl = [...document.querySelectorAll('main svg polyline')].pop();
      if (!pl) return null;
      return {
        stroke: pl.getAttribute('stroke'),
        width: pl.getAttribute('stroke-width'),
        opacity: pl.getAttribute('stroke-opacity'),
      };
    })()`);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x0 + 108, y: y0, button: "left", buttons: 0 });
  }
  await sleep(900);
  const pathsAfter = await strokedPaths();
  check(
    "live preview is not the old hardcoded black 2px stroke",
    preview !== null && !(preview.stroke === "#0f172a" && String(preview.width) === "2"),
    JSON.stringify(preview),
  );
  check(
    "stroke committed to the document",
    pathsAfter > pathsBefore,
    `stroked paths ${pathsBefore} → ${pathsAfter}`,
  );

  // -------------------------------------------------------------------- Errors
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
