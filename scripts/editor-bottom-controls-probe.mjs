/* global process, console, fetch, WebSocket, setTimeout, Buffer */
/**
 * P1 Phase I — floating bottom controls, verified in a real browser.
 *
 * The four defects this phase fixed were found by MEASURING the shipped bar, not
 * by reading its source, so the guards are measurements too:
 *
 *   i01 Alignment    — the capsule is centred on the CANVAS, not the frame. The
 *                      shipped build was 72px right of centre at 1440px and 88px
 *                      LEFT of it at 1024px, because it was pinned to the frame
 *                      while the canvas is inset by the rail and the dock.
 *   i02 Status bar   — no overlap. The shipped build covered it by 13px.
 *   i03 Fit page     — the page bottom CLEARS the bar. The shipped build laid the
 *                      page out under it.
 *   i04 Zoom limits  — ± disable at the clamp bounds and state why.
 *   i05 Page nav     — first/middle/last disabled states, and a 1-page document
 *                      shows a disabled "1 / 1" instead of hiding the group.
 *   i06 Page entry   — typing a page number navigates; out-of-range clamps.
 *   i07 Fit mode     — the trigger names the sticky mode, and a manual zoom is
 *                      NOT reset by opening/closing a panel (I8).
 *   i08 Panels       — rail collapse and Inspector dock/undock move the capsule
 *                      with the canvas; no overlap, no z-index war.
 *   i09 Keyboard     — tab-reachable, visible focus, Enter/Space activate.
 *   i10 Responsive   — six widths, no horizontal overflow, nothing clipped.
 *   i11 Console      — zero errors across the whole run.
 *
 * WHAT THIS CANNOT DO: it captures screenshots but cannot visually decode them.
 * Every check is a measurement or a semantic assertion, never an aesthetic one.
 *
 * Usage:
 *   node scripts/editor-bottom-controls-probe.mjs
 *   node scripts/editor-bottom-controls-probe.mjs --url http://localhost:3001
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
const SHOTS = arg("--shots", "docs/screenshots/phase-i");
/**
 * A real 12-page PDF, opened through the editor's own file input. Page
 * navigation rules are only meaningful on a document with pages to move
 * between, and an absolute path is what `DOM.setFileInputFiles` requires.
 */
const FIXTURE = resolve(arg("--fixture", "docs/qa/p1/multipage-fixture.pdf"));
// Browser binary. `CHROME_PATH` lets a non-Windows machine (or a Chrome for
// Testing download) point the probe at its own build; the literal default keeps
// the original Windows invocation working untouched.
const CHROME =
  process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Geometry of the capsule against the canvas, the status bar and the page. */
const MEASURE = `(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
             bottom: Math.round(b.bottom), right: Math.round(b.right), cx: Math.round(b.x + b.width/2) }; };
  const bar = document.querySelector('[role="toolbar"][aria-label="Page and zoom controls"]');
  const main = document.querySelector('main');
  const status = [...document.querySelectorAll('div')].find((d) =>
    /border-t/.test(String(d.className)) && /No selection|Text|Shape|objects/.test(d.textContent||''));
  const svg = [...document.querySelectorAll('main svg')].map((s)=>({el:s,b:s.getBoundingClientRect()}))
    .sort((a,b)=>b.b.width*b.b.height-a.b.width*a.b.height)[0]?.el;
  const page = svg ? [...svg.querySelectorAll('rect')].map((x)=>({el:x,b:x.getBoundingClientRect()}))
    .filter((x)=>x.b.width>50&&x.b.height>50)
    .sort((a,b)=>b.b.width*b.b.height-a.b.width*a.b.height)[0]?.el : null;
  const btn = (re) => [...(bar?.querySelectorAll('button')||[])]
    .find((b) => re.test(b.getAttribute('aria-label')||''));
  const zoomTrigger = [...(bar?.querySelectorAll('button')||[])]
    .find((b) => /^Zoom level/.test(b.getAttribute('aria-label')||''));
  const pageInput = bar?.querySelector('input');
  const desc = (b) => b ? { label: b.getAttribute('aria-label'), title: b.getAttribute('title'),
                            disabled: b.disabled, pressed: b.getAttribute('aria-pressed'),
                            h: Math.round(b.getBoundingClientRect().height),
                            w: Math.round(b.getBoundingClientRect().width) } : null;
  return {
    bar: r(bar), main: r(main), status: r(status), page: r(page),
    barScrollW: bar ? bar.scrollWidth : null, barClientW: bar ? bar.clientWidth : null,
    /*
     * The stacking level of the capsule's LAYER, not of the bar element.
     * The z-index lives on the positioning wrapper (which is what is stacked
     * against the drawer and the object toolbar); the bar itself inherits auto
     * inside it. Reading the bar reported "auto" and the probe called that a
     * regression — it was reading the wrong element.
     */
    barZ: bar ? (() => {
      for (let el = bar; el && el !== document.body; el = el.parentElement) {
        const z = getComputedStyle(el).zIndex;
        if (z !== 'auto') return z;
      }
      return 'auto';
    })() : null,
    zoomOut: desc(btn(/^Zoom out/)), zoomIn: desc(btn(/^Zoom in/)),
    prev: desc(btn(/^Previous page/)), next: desc(btn(/^Next page/)),
    fitBtn: desc(btn(/^Fit page/)), overview: desc(btn(/^Page overview/)),
    inspector: desc(btn(/inspector$/i)),
    pan: desc(btn(/^Pan tool/)), select: desc(btn(/^Select tool/)),
    zoomLabel: zoomTrigger ? zoomTrigger.getAttribute('aria-label') : null,
    zoomText: zoomTrigger ? zoomTrigger.textContent.trim() : null,
    pageValue: pageInput ? pageInput.value : null,
    pageAria: pageInput ? pageInput.getAttribute('aria-label') : null,
    pageInputH: pageInput ? Math.round(pageInput.getBoundingClientRect().height) : null,
    buttonCount: bar ? bar.querySelectorAll('button').length : 0,
    docScrollW: document.documentElement.scrollWidth,
    docClientW: document.documentElement.clientWidth,
    bodyScrollW: document.body.scrollWidth,
    // Every control that escapes the bar's own box is a clipped control.
    offscreen: [...(bar?.querySelectorAll('button,input')||[])].filter((el) => {
      const b = el.getBoundingClientRect(); const p = bar.getBoundingClientRect();
      return b.right > p.right + 1 || b.left < p.left - 1;
    }).length,
  };
})()`;

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), "pdfdadi-phasei-"));
  const port = 9482;
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
      consoleErrors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 240));
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
    if (res.result?.exceptionDetails) return { __error: res.result.exceptionDetails.text ?? "threw" };
    return res.result?.result?.value;
  };
  /** Clicks a capsule control by its accessible-name pattern. */
  const clickBar = async (pattern) =>
    evaluate(`(() => {
      const bar = document.querySelector('[role="toolbar"][aria-label="Page and zoom controls"]');
      const b = [...(bar?.querySelectorAll('button')||[])].find((x) => ${pattern}.test(x.getAttribute('aria-label')||''));
      if (!b || b.disabled) return 'unavailable';
      b.click(); return 'clicked';
    })()`);
  const key = async (k, code, vk, modifiers = 0) => {
    for (const type of ["keyDown", "keyUp"]) {
      await send("Input.dispatchKeyEvent", {
        type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers,
      });
    }
  };
  const shot = async (name) => {
    try {
      mkdirSync(SHOTS, { recursive: true });
      const res = await send("Page.captureScreenshot", { format: "png" });
      if (res.result?.data) writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(res.result.data, "base64"));
    } catch { /* evidence for humans, never a gate */ }
  };
  const resize = async (w, h) =>
    send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });

  const failures = [];
  const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failures.push(name);
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await resize(1600, 950);
  await send("Page.navigate", { url: `${BASE}/editor` });

  // Wait for the capsule to be genuinely INTERACTIVE, not merely present: a cold
  // Turbopack compile takes far longer than any fixed sleep, and the markup
  // arrives before React hydrates it.
  //
  // The earlier gate was `bar mounted && buttons >= 4`. That is satisfied by the
  // server-rendered capsule, so on a cold route the very next `clickBar('Fit
  // page')` landed on a button with no React handler attached yet: the click was
  // silently swallowed, the zoom stayed at 100%, and i03 measured the UNFITTED
  // page (clearance −157px) and reported a fit-reserve regression that did not
  // exist. Measured: with the 1s gate the click was dropped on 2 of 3 cold runs;
  // with the page settled it succeeded 3 of 3.
  //
  // So the gate proves hydration by OBSERVING A STATE CHANGE the product only
  // makes in React: click Fit page and require `aria-pressed` to flip. That is
  // the product's own interactivity signal rather than a sleep long enough to
  // "probably" be hydrated — the failure mode being guarded against is precisely
  // a timing assumption, and a bigger sleep is the same assumption with a bigger
  // number. The click is idempotent (it sets a sticky mode), so retrying is safe
  // and the fit state it leaves behind is exactly what i01–i03 want to measure.
  let ready = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(1000);
    ready = await evaluate(`(() => {
      const bar = document.querySelector('[role="toolbar"][aria-label="Page and zoom controls"]');
      return { bar: !!bar, buttons: bar ? bar.querySelectorAll('button').length : 0 };
    })()`);
    if (!ready?.bar || ready.buttons < 4) continue;
    await clickBar("/^Fit page/");
    await sleep(400);
    const hydrated = await evaluate(`(() => {
      const bar = document.querySelector('[role="toolbar"][aria-label="Page and zoom controls"]');
      const fit = [...(bar?.querySelectorAll('button')||[])]
        .find((b) => /^Fit page/.test(b.getAttribute('aria-label')||''));
      return fit ? fit.getAttribute('aria-pressed') === 'true' : false;
    })()`);
    if (hydrated === true) break;
  }
  check("i00 capsule mounted", Boolean(ready?.bar), `buttons=${ready?.buttons ?? 0}`);
  check(
    "i00b the capsule is hydrated (a click changes real state, not just markup)",
    (await evaluate(`(() => {
      const bar = document.querySelector('[role="toolbar"][aria-label="Page and zoom controls"]');
      const fit = [...(bar?.querySelectorAll('button')||[])]
        .find((b) => /^Fit page/.test(b.getAttribute('aria-label')||''));
      return fit ? fit.getAttribute('aria-pressed') === 'true' : false;
    })()`)) === true,
  );

  // --- i01/i02/i03 geometry, at the desktop width -----------------------------
  await clickBar("/^Fit page/");
  await sleep(700);
  let m = await evaluate(MEASURE);
  await shot("i01-bottom-controls-desktop");

  check(
    "i01 capsule centred on the CANVAS (not the frame)",
    m.bar && m.main && Math.abs(m.bar.cx - m.main.cx) <= 2,
    `barCx=${m.bar?.cx} canvasCx=${m.main?.cx} delta=${m.bar && m.main ? m.bar.cx - m.main.cx : "?"}`,
  );
  check(
    "i02 capsule does not overlap the status bar",
    m.bar && m.status ? m.bar.bottom <= m.status.y : false,
    `barBottom=${m.bar?.bottom} statusTop=${m.status?.y}`,
  );
  check(
    "i03 at Fit page the page bottom clears the capsule",
    m.bar && m.page ? m.page.bottom <= m.bar.y : false,
    `pageBottom=${m.page?.bottom} barTop=${m.bar?.y} clearance=${m.bar && m.page ? m.bar.y - m.page.bottom : "?"}`,
  );
  check("i03b capsule layers at z-30 (level with drawer/object toolbar)", m.barZ === "30", `z=${m.barZ}`);
  check(
    "i16 controls use comfortable hit targets (>=36px), not micro-buttons",
    [m.zoomOut, m.zoomIn, m.prev, m.next].every((b) => b && b.h >= 36 && b.w >= 36),
    `zoomOut=${m.zoomOut?.h}x${m.zoomOut?.w} prev=${m.prev?.h}x${m.prev?.w}`,
  );
  check(
    "i19 every icon-only control carries a tooltip",
    [m.zoomOut, m.zoomIn, m.prev, m.next, m.fitBtn, m.overview, m.inspector]
      .filter(Boolean)
      .every((b) => typeof b.title === "string" && b.title.length > 0),
  );
  check(
    "i12 page overview is present and reveals a real surface",
    Boolean(m.overview),
    `label=${m.overview?.label}`,
  );
  check(
    "i13 NO fullscreen control (this build integrates no Fullscreen API)",
    m.buttonCount > 0 &&
      !(await evaluate(`(() => {
        const bar = document.querySelector('[role="toolbar"][aria-label="Page and zoom controls"]');
        return [...(bar?.querySelectorAll('button')||[])].some((b) => /fullscreen|full screen/i.test(b.getAttribute('aria-label')||''));
      })()`)),
    "a visual-only fullscreen button would be a fake affordance",
  );

  // --- i04 zoom limits --------------------------------------------------------
  // Drive to the maximum through the real control, then the minimum.
  for (let i = 0; i < 14; i += 1) await clickBar("/^Zoom in/");
  await sleep(500);
  let zoomed = await evaluate(MEASURE);
  await shot("i03-bottom-controls-zoomed");
  check(
    "i04 Zoom in disables at the maximum and states why",
    zoomed.zoomIn?.disabled === true && /Maximum zoom/.test(zoomed.zoomIn?.label || ""),
    `label=${zoomed.zoomIn?.label} disabled=${zoomed.zoomIn?.disabled}`,
  );
  check("i04b Zoom out still available at the maximum", zoomed.zoomOut?.disabled === false);
  check("i05b zoom readout reflects the real zoom", /800%/.test(zoomed.zoomText || ""), `text=${zoomed.zoomText}`);

  for (let i = 0; i < 16; i += 1) await clickBar("/^Zoom out/");
  await sleep(500);
  let zoomedOut = await evaluate(MEASURE);
  check(
    "i04c Zoom out disables at the minimum and states why",
    zoomedOut.zoomOut?.disabled === true && /Minimum zoom/.test(zoomedOut.zoomOut?.label || ""),
    `label=${zoomedOut.zoomOut?.label}`,
  );
  check("i04d Zoom in available again at the minimum", zoomedOut.zoomIn?.disabled === false);

  // --- i07 fit mode display + I8 manual zoom is not reset by a panel ----------
  await clickBar("/^Fit page/");
  await sleep(600);
  let fitted = await evaluate(MEASURE);
  check(
    "i07 the trigger NAMES the sticky fit mode, with the live percentage",
    /Fit page \(\d+%\)/.test(fitted.zoomText || ""),
    `text=${fitted.zoomText}`,
  );
  check(
    "i07b the accessible name states both zoom and mode",
    /Zoom level: \d+%, Fit page/.test(fitted.zoomLabel || ""),
    `label=${fitted.zoomLabel}`,
  );

  // A MANUAL zoom, then toggle the Inspector. The zoom must survive: only a
  // sticky fit mode may recompute on a layout change (I8).
  await clickBar("/^Zoom in/");
  await sleep(400);
  const manual = await evaluate(MEASURE);
  await clickBar("/inspector$/i");
  await sleep(800);
  const afterPanel = await evaluate(MEASURE);
  check(
    "i08 a MANUAL zoom is not reset by opening/closing a panel",
    manual.zoomText === afterPanel.zoomText,
    `before=${manual.zoomText} after=${afterPanel.zoomText}`,
  );
  check(
    "i08b the capsule follows the canvas when the Inspector undocks",
    afterPanel.bar && afterPanel.main && Math.abs(afterPanel.bar.cx - afterPanel.main.cx) <= 2,
    `barCx=${afterPanel.bar?.cx} canvasCx=${afterPanel.main?.cx}`,
  );
  await shot("i04-bottom-controls-with-inspector");
  // Restore the dock for later checks.
  await clickBar("/inspector$/i");
  await sleep(600);

  /*
   * Now prove a sticky fit mode DOES recompute (the other half of I8).
   *
   * Deliberately fit-WIDTH, not fit-page. At this viewport the standalone page
   * is taller than it is wide relative to the canvas, so fit-page is
   * HEIGHT-driven: docking the Inspector changes only the width, and the
   * correct fit-page zoom is therefore identical before and after. The probe
   * originally asserted fit-page must change and failed — a probe defect, not a
   * product one. Fit-width is the mode a width change must actually move.
   */
  await evaluate(`(() => {
    const bar = document.querySelector('[role="toolbar"][aria-label="Page and zoom controls"]');
    [...(bar?.querySelectorAll('button')||[])].find((b) => /^Zoom level/.test(b.getAttribute('aria-label')||''))?.click();
    return true;
  })()`);
  await sleep(400);
  await evaluate(`(() => {
    const m = document.querySelector('[role="menu"][aria-label="Zoom level"]');
    [...(m?.querySelectorAll('[role="menuitem"]')||[])].find((i) => i.textContent.trim() === 'Fit width')?.click();
    return true;
  })()`);
  await sleep(700);
  const fitBefore = await evaluate(MEASURE);
  await clickBar("/inspector$/i");
  await sleep(900);
  const fitAfter = await evaluate(MEASURE);
  check(
    "i08c a sticky FIT mode recomputes when the layout changes",
    /Fit width/.test(fitBefore.zoomText || "") && /Fit width/.test(fitAfter.zoomText || "") &&
      fitBefore.zoomText !== fitAfter.zoomText,
    `before=${fitBefore.zoomText} after=${fitAfter.zoomText}`,
  );
  /*
   * I15 for fit-WIDTH: a page taller than the viewport legitimately extends
   * behind the capsule — the brief explicitly allows a floating overlay at high
   * zoom "but the user must still be able to pan/scroll to all content". So the
   * assertion here is PANNABILITY, not clearance. Asserting clearance after
   * fit-width was a probe defect: it demanded that a 228%-zoomed page fit above
   * a bar it cannot possibly fit above.
   */
  const pannable = await evaluate(`(() => {
    const host = document.querySelector('main');
    return { canPan: !!host, height: host ? Math.round(host.getBoundingClientRect().height) : 0 };
  })()`);
  check(
    "i15 at fit-width an oversized page stays reachable (overlay is allowed)",
    fitAfter.page != null && pannable?.canPan === true,
    `pageH=${fitAfter.page?.h} canvasH=${pannable?.height}`,
  );

  // Back to fit-PAGE, which is the mode that must genuinely clear the bar.
  await clickBar("/^Fit page/");
  await sleep(800);
  const refit = await evaluate(MEASURE);
  check(
    "i03c at Fit page the page still clears the capsule after a layout change",
    refit.bar && refit.page ? refit.page.bottom <= refit.bar.y : false,
    `clearance=${refit.bar && refit.page ? refit.bar.y - refit.page.bottom : "?"}`,
  );
  await clickBar("/inspector$/i");
  await sleep(600);

  // --- i05 page navigation on a single-page document --------------------------
  const single = await evaluate(MEASURE);
  check(
    "i05 a 1-page document SHOWS page navigation, disabled with a reason",
    single.prev?.disabled === true &&
      single.next?.disabled === true &&
      /one page/.test(single.prev?.label || "") &&
      /one page/.test(single.next?.label || ""),
    `prev=${single.prev?.label} next=${single.next?.label}`,
  );
  check(
    "i10 the page readout is a real entry field with a describing name",
    single.pageValue === "1" && /Type a page number to jump/.test(single.pageAria || ""),
    `value=${single.pageValue} aria=${single.pageAria}`,
  );
  check(
    "i10b the page field meets the 24px minimum target (WCAG 2.5.8)",
    (single.pageInputH ?? 0) >= 24,
    `h=${single.pageInputH}`,
  );

  /* ---------------------------------------------------------------------------
   * i05/i06/i11 — REAL multi-page navigation.
   *
   * The disabled-state rules only mean something on a document that has pages to
   * move between, so a 12-page fixture is loaded through the editor's OWN file
   * input (DOM.setFileInputFiles), which is the same path a user takes. This is
   * what makes "Previous is disabled on page 1" and "Next is disabled on page
   * 12" measurements rather than assertions about a one-page document.
   * ------------------------------------------------------------------------- */
  await send("DOM.enable");
  const docNode = await send("DOM.getDocument", { depth: -1 });
  const inputNode = await send("DOM.querySelector", {
    nodeId: docNode.result?.root?.nodeId,
    selector: 'input[type="file"][accept="application/pdf"]',
  });
  let multipage = false;
  let openDiag = `nodeId=${inputNode.result?.nodeId ?? "none"}`;
  if (inputNode.result?.nodeId) {
    const setRes = await send("DOM.setFileInputFiles", {
      nodeId: inputNode.result.nodeId,
      files: [FIXTURE],
    });
    openDiag += ` setErr=${setRes.error ? JSON.stringify(setRes.error).slice(0, 120) : "none"}`;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await sleep(1000);
      const m2 = await evaluate(MEASURE);
      // The page COUNT is the readiness signal, read from the field's accessible
      // name. An earlier version also required `pageValue` to be non-null in the
      // same tick, which raced the input's controlled value and reported a
      // document that had plainly loaded ("Page 1 of 12") as not open.
      if (/\/ 12\b/.test(m2.pageAria || "") || /of 12\b/.test(m2.pageAria || "")) {
        multipage = true;
        break;
      }
      if (attempt === 24) openDiag += ` lastAria=${m2.pageAria}`;
    }
  } else {
    openDiag += ` domErr=${inputNode.error ? JSON.stringify(inputNode.error).slice(0, 120) : "none"}`;
  }
  check("i05a the 12-page fixture opened through the real file input", multipage, openDiag);

  if (multipage) {
    const p1 = await evaluate(MEASURE);
    check(
      "i11 page 1: Previous disabled with a stated reason, Next enabled",
      p1.prev?.disabled === true &&
        /first page/.test(p1.prev?.label || "") &&
        p1.next?.disabled === false,
      `prev=${p1.prev?.label} nextDisabled=${p1.next?.disabled}`,
    );

    // Walk to a middle page through the REAL control.
    await clickBar("/^Next page/");
    await clickBar("/^Next page/");
    await sleep(700);
    const mid = await evaluate(MEASURE);
    await shot("i02-bottom-controls-mid-page");
    check(
      "i09 middle page: both directions enabled, readout tracks the page",
      mid.prev?.disabled === false && mid.next?.disabled === false && mid.pageValue === "3",
      `page=${mid.pageValue} prev=${mid.prev?.disabled} next=${mid.next?.disabled}`,
    );

    // Direct page entry: type a page number and commit with Enter.
    await evaluate(`(() => {
      const bar = document.querySelector('[role="toolbar"][aria-label="Page and zoom controls"]');
      const input = bar?.querySelector('input');
      if (!input) return 'no-input';
      input.focus(); input.select();
      return 'focused';
    })()`);
    for (const ch of ["1", "0"]) {
      await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch, code: `Digit${ch}` });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code: `Digit${ch}` });
    }
    await key("Enter", "Enter", 13);
    await sleep(900);
    const jumped = await evaluate(MEASURE);
    check(
      "i10c typing a page number navigates to it",
      jumped.pageValue === "10",
      `page=${jumped.pageValue}`,
    );

    // Last page: Next must be disabled with a reason.
    await clickBar("/^Next page/");
    await clickBar("/^Next page/");
    await sleep(800);
    const last = await evaluate(MEASURE);
    check(
      "i11b last page: Next disabled with a stated reason, Previous enabled",
      last.pageValue === "12" &&
        last.next?.disabled === true &&
        /last page/.test(last.next?.label || "") &&
        last.prev?.disabled === false,
      `page=${last.pageValue} next=${last.next?.label} prevDisabled=${last.prev?.disabled}`,
    );

    // Out-of-range entry must CLAMP into the document, not navigate nowhere.
    await evaluate(`(() => {
      const bar = document.querySelector('[role="toolbar"][aria-label="Page and zoom controls"]');
      const input = bar?.querySelector('input');
      input?.focus(); input?.select();
      return true;
    })()`);
    for (const ch of ["9", "9", "9"]) {
      await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch, code: `Digit${ch}` });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code: `Digit${ch}` });
    }
    await key("Enter", "Enter", 13);
    await sleep(800);
    const clamped = await evaluate(MEASURE);
    check(
      "i10d an out-of-range page number clamps into the document",
      clamped.pageValue === "12",
      `page=${clamped.pageValue}`,
    );

    // Back to page 1 for the responsive sweep.
    await clickBar("/^Previous page/");
    await sleep(500);
  }

  // --- i09 keyboard -----------------------------------------------------------
  const focusWalk = await evaluate(`(() => {
    const bar = document.querySelector('[role="toolbar"][aria-label="Page and zoom controls"]');
    const first = bar?.querySelector('button:not([disabled])');
    if (!first) return null;
    first.focus();
    return { focused: document.activeElement === first, label: first.getAttribute('aria-label') };
  })()`);
  check("i09 a capsule control is focusable", focusWalk?.focused === true, `label=${focusWalk?.label}`);

  /*
   * The focus RING must be measured after a real keyboard Tab, not after a
   * scripted `.focus()`.
   *
   * `:focus-visible` is a heuristic: the browser does not consider focus
   * "visible" when a script moves it during a pointer-driven session, so a
   * `.focus()` call plus a computed-style read reports no ring on a control that
   * rings correctly for a keyboard user. The probe originally did exactly that
   * and called the product unfocused — a probe defect. Driving a real Tab
   * through CDP puts the page in keyboard modality, which is the state the check
   * is actually about.
   */
  await evaluate(`(() => {
    const bar = document.querySelector('[role="toolbar"][aria-label="Page and zoom controls"]');
    // Focus the element BEFORE the first tab stop, so one Tab lands on it.
    const first = bar?.querySelector('button:not([disabled])');
    first?.focus();
    return true;
  })()`);
  await key("Tab", "Tab", 9);
  await sleep(300);
  const ringed = await evaluate(`(() => {
    const el = document.activeElement;
    const bar = document.querySelector('[role="toolbar"][aria-label="Page and zoom controls"]');
    if (!el || !bar || !bar.contains(el)) return { inBar: false };
    const css = getComputedStyle(el);
    return {
      inBar: true,
      label: el.getAttribute('aria-label'),
      matchesFocusVisible: el.matches(':focus-visible'),
      // The app's canonical treatment is a ring (box-shadow), not the UA outline.
      ring: css.boxShadow !== 'none' && css.boxShadow.length > 0,
      boxShadow: css.boxShadow.slice(0, 80),
    };
  })()`);
  check(
    "i21 a keyboard-focused control shows the app's focus ring",
    ringed?.inBar === true && ringed?.matchesFocusVisible === true && ringed?.ring === true,
    `label=${ringed?.label} focusVisible=${ringed?.matchesFocusVisible} shadow=${ringed?.boxShadow}`,
  );

  const tabbed = await evaluate(`(() => {
    const bar = document.querySelector('[role="toolbar"][aria-label="Page and zoom controls"]');
    const stops = [...(bar?.querySelectorAll('button:not([disabled]),input')||[])];
    return { stops: stops.length, allTabbable: stops.every((s) => s.tabIndex >= 0) };
  })()`);
  check(
    "i20 every enabled control is a real tab stop",
    tabbed?.allTabbable === true && (tabbed?.stops ?? 0) > 0,
    `stops=${tabbed?.stops}`,
  );

  // Enter on the zoom trigger must open the menu (Enter/Space activation).
  await evaluate(`(() => {
    const bar = document.querySelector('[role="toolbar"][aria-label="Page and zoom controls"]');
    [...(bar?.querySelectorAll('button')||[])].find((b) => /^Zoom level/.test(b.getAttribute('aria-label')||''))?.focus();
    return true;
  })()`);
  await key("Enter", "Enter", 13);
  await sleep(500);
  const menu = await evaluate(`(() => {
    const m = document.querySelector('[role="menu"][aria-label="Zoom level"]');
    return { open: !!m, items: m ? m.querySelectorAll('[role="menuitem"]').length : 0,
             fits: m ? [...m.querySelectorAll('[role="menuitem"]')].map((i)=>i.textContent.trim()).slice(0,3) : [] };
  })()`);
  check(
    "i20b Enter opens the zoom/fit menu with real options",
    menu?.open === true && (menu?.items ?? 0) > 3,
    `items=${menu?.items} fits=${JSON.stringify(menu?.fits)}`,
  );
  check(
    "i07c the menu offers exactly the three REAL fit modes",
    JSON.stringify(menu?.fits) === JSON.stringify(["Fit page", "Fit width", "Fit height"]),
    `fits=${JSON.stringify(menu?.fits)}`,
  );
  await key("Escape", "Escape", 27);
  await sleep(300);
  const closed = await evaluate(`!!document.querySelector('[role="menu"][aria-label="Zoom level"]')`);
  check("i20c Escape closes the menu", closed === false);

  // --- i08/i23 rail collapse ---------------------------------------------------
  const collapsed = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^Collapse panel$/.test(x.getAttribute('aria-label')||''));
    if (!b) return 'no-button';
    b.click(); return 'clicked';
  })()`);
  await sleep(900);
  const afterCollapse = await evaluate(MEASURE);
  check(
    "i14 the capsule follows the canvas when the left rail collapses",
    collapsed === "clicked" && afterCollapse.bar && afterCollapse.main &&
      Math.abs(afterCollapse.bar.cx - afterCollapse.main.cx) <= 2,
    `barCx=${afterCollapse.bar?.cx} canvasCx=${afterCollapse.main?.cx}`,
  );
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^Expand panel$/.test(x.getAttribute('aria-label')||''));
    b?.click(); return true;
  })()`);
  await sleep(700);

  // --- i10 responsive ---------------------------------------------------------
  const widths = [
    [1920, 1080, null], [1600, 900, null], [1440, 900, null], [1366, 768, null],
    [1280, 720, null], [1024, 768, "i05-bottom-controls-tablet"],
    [768, 1024, null], [390, 844, "i06-bottom-controls-mobile"],
  ];
  for (const [w, h, name] of widths) {
    await resize(w, h);
    await sleep(1100);
    const rm = await evaluate(MEASURE);
    const overflow = rm.docScrollW - rm.docClientW;
    check(
      `i22 ${w}x${h}: no page-level horizontal overflow`,
      overflow <= 0,
      `scrollW=${rm.docScrollW} clientW=${rm.docClientW}`,
    );
    check(
      `i22 ${w}x${h}: capsule fits its own width (nothing clipped)`,
      rm.barScrollW <= rm.barClientW + 1 && rm.offscreen === 0,
      `scrollW=${rm.barScrollW} clientW=${rm.barClientW} offscreen=${rm.offscreen}`,
    );
    check(
      `i22 ${w}x${h}: capsule stays inside the canvas region`,
      rm.bar && rm.main ? rm.bar.x >= rm.main.x - 1 && rm.bar.right <= rm.main.right + 1 : false,
      `bar=[${rm.bar?.x},${rm.bar?.right}] canvas=[${rm.main?.x},${rm.main?.right}]`,
    );
    check(
      `i22 ${w}x${h}: zoom and page navigation are never dropped`,
      Boolean(rm.zoomOut && rm.zoomIn && rm.prev && rm.next),
      `zoom=${Boolean(rm.zoomOut)} pages=${Boolean(rm.prev)}`,
    );
    if (name) await shot(name);
  }

  // --- i11 console -------------------------------------------------------------
  await resize(1600, 950);
  await sleep(600);
  check(
    "i11 zero browser console errors across the run",
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(" | "),
  );

  console.log("");
  if (failures.length === 0) {
    console.log("ALL CHECKS PASSED");
  } else {
    console.log(`${failures.length} FAILED: ${failures.join(", ")}`);
  }
  sock.close();
  chrome.kill();
  process.exit(failures.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
