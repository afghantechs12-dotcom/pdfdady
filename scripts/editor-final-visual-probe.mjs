/* global process, console, fetch, WebSocket, setTimeout, Buffer */
/**
 * FINAL P1 visual + responsive audit, measured in a real browser.
 *
 * This probe exists because the final P1 pass is a VISUAL review, and the one
 * thing an agent cannot do is look at a screenshot. So every gate here is a
 * MEASUREMENT or a SEMANTIC assertion about the shipped DOM — never an aesthetic
 * judgement dressed up as a number. "The toolbar looks balanced" is not a check.
 * "The toolbar's scrollWidth exceeds its clientWidth, so N px of tools are
 * unreachable without a scroll affordance" is.
 *
 * The defects it was written to catch, all found by measuring the shipped build:
 *
 *   f01 Canvas monotonicity — widening the window must NEVER shrink the canvas.
 *                    `editorPanelLayout.ts` claims a single dock makes this
 *                    "structurally impossible", and for the DOCK COUNT it does.
 *                    But the measured canvas fell 1023px → 704px crossing 1200px,
 *                    because the dock appears at full width with no compensating
 *                    step anywhere else. The invariant is about PIXELS, so this
 *                    probe measures pixels rather than re-asserting the count.
 *   f02 Toolbar reachability — the tool row degrades to a `scrollbar-none`
 *                    horizontal scroller. At 390px it measured 178px of viewport
 *                    over 407px of content: the tools were in the DOM, keyboard
 *                    reachable, and completely invisible with no affordance
 *                    saying so. Silent truncation reads as "there are 8 tools".
 *   f03 Modal layering — the drawer is `aria-modal` with a scrim at z-20, while
 *                    the bottom capsule is z-30 in a non-stacking-context parent.
 *                    So the capsule floats ABOVE the scrim of a modal that has
 *                    trapped focus: it looks live and cannot be used.
 *   f04 No page-level horizontal overflow, at any width.
 *   f05 Inspector never scrolls horizontally, and docks at 320px.
 *   f06 Capsule stays centred on the CANVAS and clear of the status bar
 *                    (Phase I's invariant — re-verified, not redesigned).
 *   f07 Context object toolbar stays inside the viewport at page edges.
 *   f08 Focus is visibly presented on the primary chrome.
 *   f09 Zero unexplained console errors across the whole run.
 *
 * WHAT THIS CANNOT DO: it captures screenshots but cannot visually decode them.
 * Aesthetic quality remains HUMAN VISUAL REVIEW REQUIRED.
 *
 * Usage:
 *   node scripts/editor-final-visual-probe.mjs
 *   node scripts/editor-final-visual-probe.mjs --url http://localhost:3001
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg("--url", "http://localhost:3001");
const SHOTS = arg("--shots", "docs/screenshots/p1-final");
const FIXTURE = resolve(arg("--fixture", "docs/qa/p1/multipage-fixture.pdf"));
// Browser binary. `CHROME_PATH` lets a non-Windows machine (or a Chrome for
// Testing download) point the probe at its own build; the literal default keeps
// the original Windows invocation working untouched.
const CHROME =
  process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The 8 audit widths, with the heights the brief pairs them with. */
const WIDTHS = [
  [1920, 1080],
  [1600, 900],
  [1440, 900],
  [1366, 768],
  [1280, 720],
  [1024, 768],
  [768, 1024],
  [390, 844],
];

/**
 * One measurement of the whole editor shell. Everything the audit asks about
 * that can be read off the DOM, gathered in a single evaluate so the numbers
 * describe the SAME frame rather than a sequence of slightly different ones.
 */
const MEASURE = `(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
             bottom: Math.round(b.bottom), right: Math.round(b.right), cx: Math.round(b.x + b.width/2) }; };

  const main = document.querySelector('main');
  const capsule = document.querySelector('[role="toolbar"][aria-label="Page and zoom controls"]');
  const toolRow = document.querySelector('[role="toolbar"][aria-label="Tools"]');
  // The tool row's SCROLL PARENT is the element that actually clips it.
  const toolScroller = toolRow ? toolRow.parentElement : null;
  const inspector = [...document.querySelectorAll('aside')]
    .find((a) => a.querySelector('[role="tablist"][aria-label="Inspector"]'));
  const rail = [...document.querySelectorAll('aside')]
    .find((a) => a.querySelector('[role="tablist"][aria-label="Sidebar panels"]'));
  const status = [...document.querySelectorAll('div')].find((d) =>
    /border-t/.test(String(d.className)) && /No selection|Text|Shape|objects/.test(d.textContent||''));
  const drawer = document.querySelector('[role="dialog"][aria-modal="true"]');
  const objectBar = [...document.querySelectorAll('[role="toolbar"]')]
    .find((el) => /^Actions for |^Object actions$/.test(el.getAttribute('aria-label')||''));

  // The page surface: the biggest rect inside the canvas svg.
  const svg = [...document.querySelectorAll('main svg')].map((s)=>({el:s,b:s.getBoundingClientRect()}))
    .sort((a,b)=>b.b.width*b.b.height-a.b.width*a.b.height)[0]?.el;
  const page = svg ? [...svg.querySelectorAll('rect')].map((x)=>({el:x,b:x.getBoundingClientRect()}))
    .filter((x)=>x.b.width>50&&x.b.height>50)
    .sort((a,b)=>b.b.width*b.b.height-a.b.width*a.b.height)[0]?.el : null;

  // Any element horizontally scrolling, with the surface named so a failure is
  // actionable rather than "something overflows somewhere".
  const scrollers = [...document.querySelectorAll('*')]
    .filter((el) => el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0)
    .map((el) => ({ tag: el.tagName.toLowerCase(),
                    label: el.getAttribute('aria-label') || '',
                    cls: String(el.className).slice(0, 90),
                    scrollW: el.scrollWidth, clientW: el.clientWidth,
                    hidden: getComputedStyle(el).overflowX }))
    .slice(0, 12);

  // Elements wider than the viewport — the usual cause of a page scrollbar.
  const tooWide = [...document.querySelectorAll('body *')]
    .filter((el) => el.getBoundingClientRect().width > window.innerWidth + 1)
    .map((el) => ({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0,60),
                    w: Math.round(el.getBoundingClientRect().width) }))
    .slice(0, 8);

  const zOf = (el) => { if (!el) return null; const cs = getComputedStyle(el);
    return { z: cs.zIndex, pos: cs.position }; };
  /**
   * The z-index that actually DECIDES the stacking, which is rarely on the
   * element you name.
   *
   * The bottom capsule is a plain role="toolbar" div: position static, z-index
   * auto. Its POSITIONING WRAPPER carries z-30. Reading the capsule itself
   * therefore returned "auto", Number("auto") is NaN, and every comparison
   * against the scrim silently answered false — the layering check could not fail
   * no matter how the layers were ordered. Walk up to the nearest ancestor that
   * has both a non-static position and a numeric z-index, which is the box the
   * browser actually stacks.
   */
  const stackZ = (el) => {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const z = Number(cs.zIndex);
      if (cs.position !== 'static' && Number.isFinite(z)) {
        return { z, pos: cs.position, from: n === el ? 'self' : String(n.className).slice(0, 60) };
      }
    }
    return null;
  };

  return {
    vw: window.innerWidth, vh: window.innerHeight,
    docScrollW: document.documentElement.scrollWidth,
    bodyScrollW: document.body.scrollWidth,
    main: r(main), capsule: r(capsule), inspector: r(inspector), rail: r(rail),
    status: r(status), page: r(page), drawer: r(drawer), objectBar: r(objectBar),
    toolRow: r(toolRow),
    toolScroll: toolScroller
      ? { scrollW: toolScroller.scrollWidth, clientW: toolScroller.clientWidth,
          overflowX: getComputedStyle(toolScroller).overflowX,
          hiddenPx: Math.max(0, toolScroller.scrollWidth - toolScroller.clientWidth) }
      : null,
    toolButtons: toolRow ? toolRow.querySelectorAll('button').length : 0,
    // How many tool buttons are actually VISIBLE inside the scroller's box —
    // "in the DOM" and "on screen" are different claims.
    toolVisible: (() => {
      if (!toolRow || !toolScroller) return null;
      const sb = toolScroller.getBoundingClientRect();
      return [...toolRow.querySelectorAll('button')].filter((b) => {
        const bb = b.getBoundingClientRect();
        return bb.left >= sb.left - 1 && bb.right <= sb.right + 1 && bb.width > 0;
      }).length;
    })(),
    hasMoreMenu: [...document.querySelectorAll('button')]
      .some((b) => /^More tools/.test(b.getAttribute('aria-label')||'')),
    inspectorScrollsX: inspector ? inspector.scrollWidth > inspector.clientWidth + 1 : null,
    inspectorPanelsX: inspector
      ? [...inspector.querySelectorAll('*')].filter((el) => el.scrollWidth > el.clientWidth + 1).length
      : null,
    capsuleZ: zOf(capsule), drawerZ: zOf(drawer),
    capsuleStackZ: capsule ? stackZ(capsule) : null,
    drawerStackZ: drawer ? stackZ(drawer) : null,
    scrimZ: (() => { const s = [...document.querySelectorAll('div[aria-hidden="true"]')]
      .find((d) => /inset-0/.test(String(d.className)) && /bg-navy|bg-black/.test(String(d.className)));
      return zOf(s); })(),
    scrimStackZ: (() => { const s = [...document.querySelectorAll('div[aria-hidden="true"]')]
      .find((d) => /inset-0/.test(String(d.className)) && /bg-navy|bg-black/.test(String(d.className)));
      return s ? stackZ(s) : null; })(),
    scrollers, tooWide,
  };
})()`;

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), "pdfdadi-final-"));
  const port = 9486;
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

  /*
   * Attach to the PAGE target from /json/list, not the browser endpoint from
   * /json/version. The browser-level session has no execution context, so
   * `Runtime.evaluate` there resolves with no `result` at all — which reads as a
   * product that never hydrated rather than as a harness error. That misdiagnosis
   * cost a full probe run, so the target type is asserted here.
   */
  let target = null;
  for (let i = 0; i < 40 && !target; i += 1) {
    await sleep(500);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = targets.find((t) => t.type === "page") ?? null;
    } catch { /* not up yet */ }
  }
  if (!target) {
    console.error("could not reach a Chrome PAGE target");
    chrome.kill();
    process.exit(1);
  }

  const sock = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    sock.addEventListener("open", res, { once: true });
    sock.addEventListener("error", rej, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  sock.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
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
    new Promise((r) => {
      const mid = ++id;
      pending.set(mid, r);
      sock.send(JSON.stringify({ id: mid, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (res.result?.exceptionDetails) return { __error: res.result.exceptionDetails.text ?? "threw" };
    return res.result?.result?.value;
  };
  const shot = async (name) => {
    try {
      mkdirSync(SHOTS, { recursive: true });
      const res = await send("Page.captureScreenshot", { format: "png" });
      if (res.result?.data) {
        writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(res.result.data, "base64"));
      }
    } catch { /* evidence for humans, never a gate */ }
  };
  const resize = (w, h) =>
    send("Emulation.setDeviceMetricsOverride", {
      width: w, height: h, deviceScaleFactor: 1, mobile: w < 500,
    });
  const click = async (x, y, holdMs = 110) => {
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1,
    });
    await sleep(holdMs);
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0,
    });
  };
  const key = async (k, code, vk, modifiers = 0) => {
    for (const type of ["keyDown", "keyUp"]) {
      await send("Input.dispatchKeyEvent", {
        type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers,
      });
    }
  };

  const failures = [];
  const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failures.push(name);
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("DOM.enable");
  await resize(1600, 900);
  await send("Page.navigate", { url: `${BASE}/editor` });

  // Hydration gate: prove React is attached by observing a state change only the
  // product can make, rather than sleeping and hoping. A cold Turbopack compile
  // outlasts any fixed delay, and the markup arrives before the handlers do.
  let ready = false;
  for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
    await sleep(1000);
    const seen = await evaluate(`(() => {
      const bar = document.querySelector('[role="toolbar"][aria-label="Page and zoom controls"]');
      return { bar: !!bar, buttons: bar ? bar.querySelectorAll('button').length : 0 };
    })()`);
    if (!seen?.bar || seen.buttons < 4) continue;
    await evaluate(`(() => {
      const bar = document.querySelector('[role="toolbar"][aria-label="Page and zoom controls"]');
      const b = [...(bar?.querySelectorAll('button')||[])]
        .find((x) => /^Fit page/.test(x.getAttribute('aria-label')||''));
      if (b && !b.disabled) b.click();
    })()`);
    await sleep(400);
    ready = (await evaluate(`(() => {
      const bar = document.querySelector('[role="toolbar"][aria-label="Page and zoom controls"]');
      const fit = [...(bar?.querySelectorAll('button')||[])]
        .find((b) => /^Fit page/.test(b.getAttribute('aria-label')||''));
      return fit ? fit.getAttribute('aria-pressed') === 'true' : false;
    })()`)) === true;
  }
  check("f00 the editor is mounted and hydrated (a click changes real state)", ready);

  // A real multi-page PDF through the editor's own file input — the same path a
  // user takes. Page-navigation and thumbnail measurements are only meaningful
  // on a document that has pages.
  const docNode = await send("DOM.getDocument", { depth: -1 });
  const inputNode = await send("DOM.querySelector", {
    nodeId: docNode.result?.root?.nodeId,
    selector: 'input[type="file"][accept="application/pdf"]',
  });
  let opened = false;
  if (inputNode.result?.nodeId) {
    await send("DOM.setFileInputFiles", { nodeId: inputNode.result.nodeId, files: [FIXTURE] });
    for (let attempt = 0; attempt < 25 && !opened; attempt += 1) {
      await sleep(1000);
      opened = (await evaluate(`(() => {
        const bar = document.querySelector('[role="toolbar"][aria-label="Page and zoom controls"]');
        const inp = bar?.querySelector('input');
        return /of 12\\b|\\/ 12\\b/.test(inp?.getAttribute('aria-label') || '');
      })()`)) === true;
    }
  }
  check("f00b the 12-page fixture opened through the real file input", opened);

  /* ===========================================================================
   * f01 — CANVAS MONOTONICITY.
   *
   * The invariant `editorPanelLayout.ts` exists to protect: widening the window
   * must never shrink the canvas. That module proves it for the DOCK COUNT, but
   * the user experiences PIXELS, so measure pixels. A dock that appears at its
   * full 320px the instant the breakpoint is crossed takes more from the canvas
   * than the extra viewport width gives back.
   *
   * MEASURE USABLE WIDTH, NOT `<main>`'s LAYOUT WIDTH. The docked Inspector is a
   * sibling `<aside>`, so it is already outside `main`; the DRAWER is an overlay,
   * so it sits ON TOP of `main` and `main.w` counts 320px the page cannot use.
   * Comparing the two readings directly reported "1199→1200 lost 319px" — the
   * exact number `components/editor/canvasGeometry.ts` documents as the artefact
   * of comparing a covered canvas with an uncovered one. Subtracting the measured
   * drawer makes both sides of the breakpoint the same quantity, which is what
   * `usableCanvasWidth` computes and what `editor-responsive-probe.mjs` reports
   * monotonic over 19 widths.
   * ========================================================================= */
  const sweep = [];
  for (const [w, h] of [
    [1150, 900], [1180, 900], [1199, 900], [1200, 900], [1240, 900],
    [1280, 720], [1340, 900], [1440, 900], [1600, 900], [1920, 1080],
  ]) {
    await resize(w, h);
    await sleep(650);
    const m = await evaluate(MEASURE);
    const layout = m.main?.w ?? 0;
    const covered = m.drawer?.w ?? 0;
    sweep.push({
      w, layout, covered, canvas: Math.max(0, layout - covered),
      rail: m.rail?.w ?? 0, inspector: m.inspector?.w ?? 0,
    });
  }
  console.log(
    "    canvas sweep (usable px): " +
      sweep.map((s) => `${s.w}:${s.canvas}${s.covered ? `(main ${s.layout}−drawer ${s.covered})` : ""}`).join(" "),
  );
  const regressions = sweep
    .map((s, i) => (i > 0 && s.canvas < sweep[i - 1].canvas ? `${sweep[i - 1].w}→${s.w} lost ${sweep[i - 1].canvas - s.canvas}px` : null))
    .filter(Boolean);
  check(
    "f01 widening the viewport never shrinks the canvas (measured in px, not dock count)",
    regressions.length === 0,
    regressions.join("; "),
  );

  /* ===========================================================================
   * The 8-width responsive sweep: overflow, panel state, toolbar reachability.
   * ========================================================================= */
  const shotNames = {
    1920: "01-editor-1920", 1600: "02-editor-1600", 1440: "03-editor-1440",
    1366: "04-editor-1366", 1280: "05-editor-1280", 1024: "06-editor-1024",
    768: "07-editor-768", 390: "08-editor-390",
  };
  const table = [];
  for (const [w, h] of WIDTHS) {
    await resize(w, h);
    await sleep(700);
    const m = await evaluate(MEASURE);
    table.push({ w, m });
    await shot(shotNames[w]);

    check(
      `f04 ${w}px — no page-level horizontal overflow`,
      m.docScrollW <= m.vw + 1,
      `docScrollW=${m.docScrollW} vw=${m.vw}${m.tooWide?.length ? ` wide=${JSON.stringify(m.tooWide[0])}` : ""}`,
    );

    /* f02 — every tool the row claims to have is REACHABLE. A `scrollbar-none`
       scroller hides content with no affordance: the honest degradations are to
       move the surplus into `More`, or to show that the row scrolls. */
    if (m.toolScroll) {
      check(
        `f02 ${w}px — no tools are silently hidden in a scrollbar-none row`,
        m.toolScroll.hiddenPx === 0 || m.toolScroll.overflowX !== "hidden",
        `hidden=${m.toolScroll.hiddenPx}px visible=${m.toolVisible}/${m.toolButtons} overflowX=${m.toolScroll.overflowX} more=${m.hasMoreMenu}`,
      );
    }

    /* f05 — the Inspector is horizontally stable wherever it is presented. */
    if (m.inspector) {
      check(
        `f05 ${w}px — the docked Inspector is 320px and never scrolls horizontally`,
        m.inspector.w === 320 && m.inspectorScrollsX === false && m.inspectorPanelsX === 0,
        `w=${m.inspector.w} scrollsX=${m.inspectorScrollsX} innerX=${m.inspectorPanelsX}`,
      );
    }

    /* f06 — Phase I's capsule invariants, re-verified rather than redesigned. */
    if (m.capsule && m.main) {
      const offCentre = Math.abs(m.capsule.cx - m.main.cx);
      check(
        `f06 ${w}px — the capsule is centred on the CANVAS (±12px) and clears the status bar`,
        offCentre <= 12 && (!m.status || m.capsule.bottom <= m.status.y + 1),
        `offCentre=${offCentre} capsuleBottom=${m.capsule.bottom} statusTop=${m.status?.y}`,
      );
    }

    console.log(
      `    ${w}x${h}: canvas=${m.main?.w} rail=${m.rail?.w ?? 0} inspector=${m.inspector?.w ?? 0}` +
      ` toolHidden=${m.toolScroll?.hiddenPx ?? 0} tools=${m.toolVisible}/${m.toolButtons}` +
      ` scrollers=${m.scrollers.length}`,
    );
  }

  /* ===========================================================================
   * f03 — MODAL LAYERING. With the Inspector open as a drawer (aria-modal, focus
   * trapped, scrim over the canvas), nothing outside the drawer may float above
   * the scrim. The bottom capsule doing so is a control that looks live and
   * cannot be used.
   * ========================================================================= */
  await resize(1024, 768);
  await sleep(600);
  /**
   * Only OPEN the drawer if it is shut. Under the canvas-monotonicity contract
   * (`components/editor/canvasGeometry.ts`) an Inspector that was visible at a
   * wider viewport is re-presented as an OPEN DRAWER here, so the button whose
   * label matches /Properties|Inspector/ is "Hide inspector" — clicking it CLOSED
   * the drawer, `[role="dialog"]` went missing, and the layering check reported
   * "the drawer did not open" while looking straight at one.
   */
  const openedDrawer = await evaluate(`(() => {
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) return 'already-open';
    const b = [...document.querySelectorAll('button')]
      .find((x) => /^show inspector$/i.test((x.getAttribute('aria-label')||x.getAttribute('title')||'').trim()) && !x.disabled)
      || [...document.querySelectorAll('button')]
        .find((x) => /Properties|Inspector/i.test(x.getAttribute('aria-label')||'') && !x.disabled);
    if (!b) return 'none';
    b.click(); return 'clicked';
  })()`);
  await sleep(700);
  const dm = await evaluate(MEASURE);
  await shot("21-drawer-open-1024");
  if (dm.drawer) {
    /**
     * Compared on the STACKING boxes, not on the named elements: the capsule's
     * own z-index is `auto`, so the old reading produced NaN and the comparison
     * was vacuously true. See `stackZ` in MEASURE.
     */
    const scrimZ = dm.scrimStackZ?.z;
    const capZ = dm.capsuleStackZ?.z;
    check(
      "f03 with the modal Inspector drawer open, the bottom capsule does not float above its scrim",
      Number.isFinite(scrimZ) && Number.isFinite(capZ) && capZ < scrimZ,
      `capsuleZ=${capZ} (from ${dm.capsuleStackZ?.from}) scrimZ=${scrimZ} (from ${dm.scrimStackZ?.from})` +
        ` drawerZ=${dm.drawerStackZ?.z} drawerOpen=${openedDrawer}`,
    );
  } else {
    check("f03 the Inspector drawer opened for layering measurement", false, `open=${openedDrawer}`);
  }
  await key("Escape", "Escape", 27);
  await sleep(400);

  /* ===========================================================================
   * f07 — the contextual object toolbar stays inside the viewport when the
   * selected object sits at a page edge.
   * ========================================================================= */
  await resize(1440, 900);
  await sleep(700);
  const pageRect = async () =>
    evaluate(`(() => {
      const rects = [...document.querySelectorAll('main svg rect')]
        .map((r) => r.getBoundingClientRect())
        .filter((b) => b.width > 200 && b.height > 200)
        .sort((a, b) => b.width * b.height - a.width * a.height);
      if (!rects.length) return null;
      const b = rects[0];
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    })()`);
  const pg = await pageRect();
  if (pg) {
    // A shape at the page's TOP-LEFT corner: the placement's hardest case, where
    // "prefer above" would clip and centring would push left of the viewport.
    await key("r", "KeyR", 82);
    await sleep(400);
    const x0 = pg.x + 6;
    const y0 = pg.y + 6;
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: x0, y: y0, button: "left", buttons: 1, clickCount: 1,
    });
    for (let i = 1; i <= 5; i += 1) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved", x: x0 + i * 16, y: y0 + i * 10, button: "left", buttons: 1,
      });
      await sleep(35);
    }
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: x0 + 80, y: y0 + 50, button: "left", buttons: 0,
    });
    await sleep(900);
    const em = await evaluate(MEASURE);
    await shot("20-context-toolbar-edge");
    if (em.objectBar) {
      check(
        "f07 the context toolbar stays fully inside the viewport at the page's top-left corner",
        em.objectBar.x >= 0 && em.objectBar.y >= 0 &&
          em.objectBar.right <= em.vw + 1 && em.objectBar.bottom <= em.vh + 1,
        `bar=${JSON.stringify(em.objectBar)} vw=${em.vw} vh=${em.vh}`,
      );
      check(
        "f07b the context toolbar does not overlap the docked Inspector",
        !em.inspector || em.objectBar.right <= em.inspector.x + 1,
        `barRight=${em.objectBar.right} inspectorX=${em.inspector?.x}`,
      );
    } else {
      check("f07 a shape was created at the page edge for context-toolbar measurement", false);
    }
  }

  /* ===========================================================================
   * f08 — FOCUS PRESENTATION. Tab through the chrome and require every stop to
   * paint something visible. `outline-none` with no ring replacement is the
   * defect class: focus exists, and the user cannot see it.
   * ========================================================================= */
  await resize(1440, 900);
  await sleep(500);
  await evaluate(`document.body.focus()`);
  const invisible = [];
  for (let i = 0; i < 26; i += 1) {
    await key("Tab", "Tab", 9);
    await sleep(90);
    const f = await evaluate(`(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const b = el.getBoundingClientRect();
      const ring = cs.boxShadow && cs.boxShadow !== 'none';
      const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth || '0') > 0;
      return {
        tag: el.tagName.toLowerCase(),
        label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 42),
        visible: ring || outline,
        onscreen: b.width > 0 && b.height > 0 && b.right > 0 && b.bottom > 0 &&
                  b.left < innerWidth && b.top < innerHeight,
      };
    })()`);
    if (f && f.onscreen && !f.visible) invisible.push(`${f.tag}[${f.label}]`);
  }
  check(
    "f08 every on-screen keyboard stop paints a visible focus indicator",
    invisible.length === 0,
    invisible.slice(0, 6).join(", "),
  );

  /* f09 — console hygiene across the entire run. */
  const unexplained = consoleErrors.filter(
    (e) => !/favicon|Download the React DevTools|ResizeObserver loop/i.test(e),
  );
  check(
    "f09 zero unexplained browser console errors across the whole run",
    unexplained.length === 0,
    unexplained.slice(0, 4).join(" | "),
  );

  console.log("");
  console.log("responsive table (w: canvas / rail / inspector / hiddenToolPx)");
  for (const { w, m } of table) {
    console.log(
      `  ${String(w).padStart(4)}  canvas=${String(m.main?.w ?? 0).padStart(4)}` +
      `  rail=${String(m.rail?.w ?? 0).padStart(3)}` +
      `  inspector=${String(m.inspector?.w ?? 0).padStart(3)}` +
      `  hiddenTools=${String(m.toolScroll?.hiddenPx ?? 0).padStart(3)}px` +
      `  docScrollW=${m.docScrollW}`,
    );
  }

  console.log("");
  if (failures.length === 0) {
    console.log(`ALL CHECKS PASSED (console errors: ${consoleErrors.length})`);
  } else {
    console.log(`${failures.length} FAILED:`);
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log("NOTE: screenshots are evidence for HUMAN VISUAL REVIEW; this probe");
  console.log("      measures geometry and semantics only, never aesthetics.");

  sock.close();
  chrome.kill();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
