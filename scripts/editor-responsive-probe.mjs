/* global process, console, fetch, WebSocket, setTimeout, Buffer */
/**
 * PERMANENT probe: editor responsive geometry + modal honesty.
 *
 * Two measured defects live here, both of which passed their unit tests.
 *
 * 1. CANVAS INVERSION. Growing the window shrank the page:
 *
 *      viewport 1199  ->  canvas 1023px
 *      viewport 1200  ->  canvas  704px      (+1px window, -319px page)
 *
 *    `editorPanelLayout` had a test literally named "never shrinks the canvas as
 *    the viewport grows" and it was green the whole time, because it counted
 *    DOCKED PANELS (0 or 1) instead of pixels. This probe measures the real
 *    `<main>` rect at every sampled width and asserts monotonicity in pixels.
 *
 * 2. MODAL DRAWER CLICK-THROUGH. With the Inspector open as a drawer —
 *    `aria-modal="true"`, focus trapped — clicking the bottom capsule still
 *    changed zoom from 100% to 125%. The old check compared z-index values and
 *    read `z-index: auto` off the wrong (child) node, so it could pass while the
 *    control was live. The assertion here is BEHAVIOURAL: with the drawer open,
 *    clicking the capsule must not change the zoom readout; with it closed, the
 *    same click must. A z-index test can be satisfied by accident; this cannot.
 *
 * Usage: node scripts/editor-responsive-probe.mjs [--url http://localhost:3001]
 *        [--shots]
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

/** Reads the layout numbers that matter, from the REAL rendered boxes. */
const MEASURE = `(() => {
  const px = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const main = document.querySelector('main');
  const rail = [...document.querySelectorAll('aside')]
    .find((a) => a.querySelector('[role="tablist"][aria-label="Sidebar panels"]'));
  const dock = [...document.querySelectorAll('aside')]
    .find((a) => a !== rail && a.getBoundingClientRect().width >= 240);
  const drawer = document.querySelector('[role="dialog"][aria-modal="true"]');
  const zoomBtn = [...document.querySelectorAll('button')]
    .find((b) => /Zoom level/i.test(b.getAttribute('aria-label') || ''));
  const capsule = document.querySelector('[role="toolbar"][aria-label="Page and zoom controls"]');
  return {
    vw: window.innerWidth,
    main: px(main), rail: px(rail), dock: px(dock), drawer: px(drawer),
    capsule: px(capsule),
    zoomLabel: zoomBtn ? (zoomBtn.getAttribute('aria-label') || '').trim() : null,
    // USABLE canvas width: the layout width of <main> minus the horizontal strip
    // any open drawer covers. A drawer is absolutely positioned so it does NOT
    // shrink <main>, but the page underneath it is just as unusable as it is
    // under a dock — so a raw <main> reading calls 1023px "canvas" while 320px of
    // it is hidden. That mismatch is precisely how a 319px regression hid behind
    // a green test, and comparing raw <main> across the boundary compares a
    // no-drawer number against a drawer number.
    usable: (() => {
      if (!main) return 0;
      const mr = main.getBoundingClientRect();
      if (!drawer) return Math.round(mr.width);
      const dr = drawer.getBoundingClientRect();
      const overlap = Math.max(0, Math.min(mr.right, dr.right) - Math.max(mr.left, dr.left));
      return Math.round(mr.width - overlap);
    })(),
    docScrollW: document.documentElement.scrollWidth,
    // Anything wider than the viewport causes a horizontal scrollbar.
    overflowing: [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().width > window.innerWidth + 1)
      .map((el) => el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 40))
      .slice(0, 5),
  };
})()`;

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), "pdfdadi-resp-"));
  const port = 9489;
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
    return res.result?.result?.value;
  };
  const resize = (width, height) =>
    send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  const mouseClick = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
    await sleep(80);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0 });
    await sleep(260);
  };
  const key = async (keyName, code, vk) => {
    // `code` must be the STRING form ("Escape"); the numeric code goes in
    // `windowsVirtualKeyCode`. Passing the number as `code` yields an event
    // Chrome drops silently — which is how Escape appeared not to close a modal.
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, windowsVirtualKeyCode: vk });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: vk });
    await sleep(300);
  };
  const shot = async (name) => {
    if (!SHOTS) return;
    const res = await send("Page.captureScreenshot", { format: "png" });
    if (!res.result?.data) return;
    mkdirSync(SHOT_DIR, { recursive: true });
    writeFileSync(join(SHOT_DIR, `${name}.png`), Buffer.from(res.result.data, "base64"));
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await resize(1600, 900);
  await send("Page.navigate", { url: `${BASE}/editor` });
  await sleep(3600);
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /blank/i.test(x.textContent || ''));
    if (b) { b.click(); return 'clicked'; } return 'none';
  })()`);
  await sleep(1500);

  const failures = [];
  const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failures.push(name);
  };

  console.log("\n============ CANVAS WIDTH MONOTONICITY ============");
  /*
   * Densely sampled around the 1200px dock boundary, which is where the
   * inversion lived and where coarse sampling (1440/1536/1600) saw nothing.
   */
  const widths = [
    390, 768, 1024, 1100, 1180, 1190, 1195, 1198, 1199, 1200, 1201, 1205, 1210, 1240,
    1280, 1366, 1440, 1600, 1920,
  ];
  const rows = [];
  for (const w of widths) {
    await resize(w, w < 500 ? 844 : 900);
    await sleep(520);
    const m = await evaluate(MEASURE);
    rows.push({ w, ...m });
    console.log(
      `    ${String(w).padStart(4)}: usable=${String(m.usable).padStart(4)} layout=${String(m.main?.w).padStart(4)}` +
        ` rail=${String(m.rail?.w ?? 0).padStart(3)} dock=${String(m.dock?.w ?? 0).padStart(3)}` +
        ` drawer=${m.drawer?.w ?? 0} scrollW=${m.docScrollW}`,
    );
  }

  // THE contract: canvas width never decreases as the viewport grows.
  let inversions = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if ((cur.usable ?? 0) < (prev.usable ?? 0)) {
      inversions.push(`${prev.w}(${prev.usable}) -> ${cur.w}(${cur.usable})`);
    }
  }
  check(
    "canvas width is monotonic as the viewport grows (no 1199->1200 cliff)",
    inversions.length === 0,
    inversions.length ? `inversions: ${inversions.join(", ")}` : `${rows.length} widths sampled`,
  );

  // The specific measured pair from the report.
  const at1199 = rows.find((r) => r.w === 1199);
  const at1200 = rows.find((r) => r.w === 1200);
  check(
    "crossing the dock threshold does not take pixels from the page",
    (at1200?.usable ?? 0) >= (at1199?.usable ?? 0),
    `1199=${at1199?.usable}px, 1200=${at1200?.usable}px usable (raw <main> was 1023 -> 704)`,
  );

  // No accidental horizontal overflow at any width.
  const overflowed = rows.filter((r) => r.docScrollW > r.w + 1);
  check(
    "no horizontal viewport overflow at any sampled width",
    overflowed.length === 0,
    overflowed.map((r) => `${r.w}:scrollW=${r.docScrollW} ${JSON.stringify(r.overflowing)}`).join("; ") || "clean",
  );


  console.log("\n============ LEFT RAIL TAB LABELS ============");
  /*
   * P2-4. The 176px rail shipped with two of its three tab labels clipped —
   * "Layers" client 43px vs scroll 47px, "History" 43 vs 50 — because the
   * collapse button joined that row after the width was chosen, and the tabs
   * were equal thirds, so the widest label set the budget for all three.
   *
   * A truncated tab is a silent ellipsis on PRIMARY navigation, and no unit test
   * can see it: text advance width exists only in a real font engine. So the
   * guard is here, and it is the box model rather than a screenshot —
   * scrollWidth > clientWidth is exactly "this element is hiding some of its
   * own content".
   */
  await resize(1600, 900);
  await sleep(520);
  const railTabs = await evaluate(`(() => {
    const list = document.querySelector('[role="tablist"][aria-label="Sidebar panels"]');
    if (!list) return null;
    const collapse = [...document.querySelectorAll('button')]
      .find((b) => /Collapse panel/i.test(b.getAttribute('aria-label') || ''));
    return {
      railWidth: Math.round((list.closest('aside')?.getBoundingClientRect().width) || 0),
      collapseWidth: collapse ? Math.round(collapse.getBoundingClientRect().width) : 0,
      tabs: [...list.querySelectorAll('[role="tab"]')].map((el) => ({
        label: (el.textContent || '').trim(),
        client: el.clientWidth,
        scroll: el.scrollWidth,
      })),
    };
  })()`);
  check(
    "the sidebar tablist renders all three panel tabs",
    railTabs?.tabs?.length === 3,
    railTabs ? `tabs=${JSON.stringify(railTabs.tabs.map((t) => t.label))} rail=${railTabs.railWidth}px` : "tablist not found",
  );
  const clippedTabs = (railTabs?.tabs ?? []).filter((t) => t.scroll > t.client);
  check(
    "no left-rail tab label is clipped",
    (railTabs?.tabs?.length ?? 0) === 3 && clippedTabs.length === 0,
    clippedTabs.length
      ? `clipped: ${clippedTabs.map((t) => `${t.label} ${t.client}/${t.scroll}`).join(", ")}`
      : (railTabs?.tabs ?? []).map((t) => `${t.label} ${t.client}/${t.scroll}`).join(", "),
  );
  // The fix must not have been "delete the collapse button to make room".
  check(
    "the rail still offers its collapse control beside the tabs",
    (railTabs?.collapseWidth ?? 0) > 0,
    `collapse button width=${railTabs?.collapseWidth ?? 0}px`,
  );

  /*
   * The SAME defect class on the right, found later and fixed the same way. The
   * Inspector strip truncated "Properties" to a 49px box for 55px of text because
   * it hid its labels below a 1320px VIEWPORT — the wrong axis entirely, since the
   * dock is a fixed 320px wherever it docks. Standalone `/editor` has one tab and
   * so must show icon AND label with room to spare; the four-tab workspace strip
   * is covered by `editor-inspector-states-probe.mjs`, which is the only route
   * where those tabs exist.
   */
  const inspectorTabs = await evaluate(`(() => {
    const list = document.querySelector('[role="tablist"][aria-label="Inspector"]');
    if (!list) return null;
    const dock = list.closest('aside');
    return {
      stripWidth: Math.round(list.getBoundingClientRect().width),
      dockOverflow: dock ? dock.scrollWidth - dock.clientWidth : null,
      tabs: [...list.querySelectorAll('[role="tab"]')].map((el) => {
        const label = el.querySelector('span');
        return {
          name: (el.getAttribute('aria-label') || '').trim(),
          text: (el.textContent || '').trim(),
          hasIcon: Boolean(el.querySelector('svg')),
          client: label ? label.clientWidth : 0,
          scroll: label ? label.scrollWidth : 0,
        };
      }),
    };
  })()`);
  const clippedInspectorTabs = (inspectorTabs?.tabs ?? []).filter((t) => t.scroll > t.client);
  check(
    "no Inspector tab label is clipped",
    (inspectorTabs?.tabs?.length ?? 0) >= 1 && clippedInspectorTabs.length === 0,
    clippedInspectorTabs.length
      ? `clipped: ${clippedInspectorTabs.map((t) => `${t.name} ${t.client}/${t.scroll}`).join(", ")}`
      : (inspectorTabs?.tabs ?? []).map((t) => `${t.name} ${t.client}/${t.scroll}`).join(", "),
  );
  check(
    "the standalone Inspector's single tab shows both its icon and its word",
    (inspectorTabs?.tabs?.length ?? 0) === 1 &&
      inspectorTabs.tabs[0].hasIcon &&
      inspectorTabs.tabs[0].text.length > 0,
    JSON.stringify(inspectorTabs?.tabs ?? null),
  );
  check(
    "the Inspector fits inside its own dock",
    inspectorTabs?.dockOverflow !== null && (inspectorTabs?.dockOverflow ?? 99) <= 1,
    `dockOverflow=${inspectorTabs?.dockOverflow}px strip=${inspectorTabs?.stripWidth}px`,
  );

  // Every tab must be NAMED whichever presentation it is in — the icon is
  // `aria-hidden`, so an icon-only tab with no `aria-label` is an unnamed control.
  check(
    "every Inspector tab has an accessible name",
    (inspectorTabs?.tabs?.length ?? 0) >= 1 &&
      inspectorTabs.tabs.every((t) => t.name.length > 0),
    JSON.stringify((inspectorTabs?.tabs ?? []).map((t) => t.name)),
  );

  console.log("\n============ APP BAR ============");
  /*
   * P2. The app bar shipped with four different control heights in one 51px row —
   * a 26px logo link, 32px text links, a 34px "Open PDF" button and a 28px avatar
   * — which is the difference between application density and a marketing navbar.
   * Height is measurable, so it is asserted here rather than eyeballed.
   *
   * The TOOL row is excluded deliberately: it keeps a taller 38px/44px rhythm
   * because those are drawing targets, not chrome, and flattening them would take
   * touch targets below the accessible minimum.
   */
  await resize(1440, 900);
  await sleep(520);
  const appBar = await evaluate(`(() => {
    const header = document.querySelector('header');
    if (!header) return null;
    const controls = [...header.querySelectorAll('a, button')]
      .filter((el) => el.getBoundingClientRect().height > 0)
      .map((el) => ({
        label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24),
        h: Math.round(el.getBoundingClientRect().height),
      }));
    return { headerHeight: Math.round(header.getBoundingClientRect().height), controls };
  })()`);
  const barHeights = [...new Set((appBar?.controls ?? []).map((c) => c.h))].sort((a, b) => a - b);
  check(
    "every app-bar control sits on one height rhythm",
    barHeights.length === 1 && barHeights[0] === 32,
    `heights=${JSON.stringify(barHeights)} controls=${JSON.stringify(appBar?.controls ?? null)}`,
  );

  /*
   * The save indicator was `hidden … md:inline-flex`, so below 768px the app bar
   * said NOTHING about whether the document was safe — "Save failed" included.
   * Checked at 420px, the narrowest width this probe visits, because that is the
   * width the old rule silently blanked.
   */
  await resize(420, 780);
  await sleep(620);
  const saveState = await evaluate(`(() => {
    const el = document.querySelector('header [role="status"]');
    if (!el) return { present: false };
    const r = el.getBoundingClientRect();
    /*
     * VISIBLE text only. sr-only hides with clip, not display:none, so innerText
     * returns the screen-reader detail too — which made a naive "is the tooltip
     * longer than the label" comparison read the detail against itself and fail
     * for a bar that was rendering correctly. Elements whose computed style takes
     * them out of the visual flow are stripped first.
     *
     * No backticks anywhere in this comment: it lives inside a template literal,
     * and one unescaped backtick ends the string and reports as a syntax error
     * pointing at the wrong line.
     */
    const clone = el.cloneNode(true);
    const originals = [...el.querySelectorAll('*')];
    [...clone.querySelectorAll('*')].forEach((node, i) => {
      const src = originals[i];
      if (!src) return;
      const cs = getComputedStyle(src);
      const box = src.getBoundingClientRect();
      const clipped = cs.clip === 'rect(0px, 0px, 0px, 0px)' || cs.clipPath === 'inset(50%)';
      if (clipped || box.width <= 1 || box.height <= 1) node.remove();
    });
    return {
      present: true,
      visible: r.width > 0 && r.height > 0,
      text: (clone.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60),
      srText: (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 90),
      title: el.getAttribute('title') || '',
      width: Math.round(r.width),
      insideViewport: r.right <= window.innerWidth + 1 && r.left >= -1,
    };
  })()`);
  check(
    "the save state is still visible on a narrow window",
    saveState?.present === true && saveState.visible === true,
    JSON.stringify(saveState),
  );
  check(
    "the narrow save state says something, and stays on screen",
    (saveState?.text ?? "").length > 0 && saveState?.insideViewport === true,
    JSON.stringify(saveState),
  );
  // The short form must not have thrown away the unambiguous phrasing: the
  // abbreviation is visible, the full sentence stays reachable as the tooltip,
  // and a screen reader still gets the sentence rather than the abbreviation.
  check(
    "the narrow save state keeps its full explanation available",
    (saveState?.title ?? "").length > (saveState?.text ?? "").length &&
      (saveState?.srText ?? "").length > (saveState?.text ?? "").length,
    `visible="${saveState?.text}" title="${saveState?.title}" announced="${saveState?.srText}"`,
  );

  console.log("\n============ MODAL DRAWER BEHAVIOUR ============");
  /*
   * Behavioural, not z-index: does clicking a background control MUTATE the
   * document while a modal drawer is open? The old probe compared z-index and
   * read `auto` off a child node, so it passed while zoom changed underneath.
   */
  await resize(1024, 768);
  await sleep(700);

  /*
   * Ensure NO drawer is open before the control click. The visibility-preserving
   * resize can legitimately arrive here with the drawer showing (demoted from the
   * dock at 1600), and in that state its scrim is CORRECTLY blocking the capsule —
   * so a "control" click would fail for the right reason and prove nothing. Escape
   * closes it; then assert the closure so this precondition can never silently rot.
   */
  // The width loop ends at 1920 with the Inspector DOCKED, so arriving at 1024
  // demotes it to a drawer — asynchronously, via a resize effect and a re-render.
  // Escape sent before that commit lands hits nothing and the drawer then appears
  // anyway, so poll for the settled state instead of guessing a sleep duration.
  let preDrawer = await evaluate(`Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))`);
  for (let attempt = 0; attempt < 8 && preDrawer; attempt++) {
    await key("Escape", "Escape", 27);
    await sleep(400);
    preDrawer = await evaluate(`Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))`);
  }
  check("precondition: no modal drawer open before the control click", preDrawer === false,
    `drawer present=${preDrawer}`);

  /*
   * Normalise zoom before the control test. Two traps, both hit while writing
   * this: a FIT mode recomputes on resize so "+" can be a no-op, and a previous
   * step may already have driven zoom to the 800% ceiling where "+" is disabled.
   * Ctrl+1 sets an explicit 100%, which has headroom in both directions, so the
   * control click is guaranteed to be able to change something.
   */
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "1", code: "Digit1", modifiers: 2, text: "1", windowsVirtualKeyCode: 49 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "1", code: "Digit1", modifiers: 2 });
  await sleep(600);

  const zoomBefore = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /Zoom level/i.test(x.getAttribute('aria-label')||''));
    return b ? (b.getAttribute('aria-label')||'').trim() : null;
  })()`);

  // Establish the control IS live when no drawer is open — otherwise the
  // "blocked" assertion below would pass trivially on a dead button.
  const capsuleTarget = await evaluate(`(() => {
    const bar = document.querySelector('[role="toolbar"][aria-label="Page and zoom controls"]');
    if (!bar) return null;
    const b = [...bar.querySelectorAll('button')].find((x) => /Zoom in/i.test(x.getAttribute('aria-label')||''));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
  })()`);
  check("the capsule's zoom-in control was found for the control test", Boolean(capsuleTarget));
  if (capsuleTarget) {
    await mouseClick(capsuleTarget.x, capsuleTarget.y);
    await sleep(400);
    const zoomAfterOpenClick = await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /Zoom level/i.test(x.getAttribute('aria-label')||''));
      return b ? (b.getAttribute('aria-label')||'').trim() : null;
    })()`);
    check(
      "CONTROL: with no drawer open, clicking the capsule DOES change zoom",
      zoomAfterOpenClick !== zoomBefore,
      `${zoomBefore} -> ${zoomAfterOpenClick}`,
    );
  }

  // Now open the drawer and repeat the identical click.
  const opened = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find((x) => /Show inspector|Inspector|Properties/i.test(x.getAttribute('aria-label')||'') && !x.disabled);
    if (!b) return 'none';
    b.click(); return (b.getAttribute('aria-label')||'').trim();
  })()`);
  await sleep(800);
  const drawerState = await evaluate(`(() => {
    const d = document.querySelector('[role="dialog"][aria-modal="true"]');
    if (!d) return { open: false };
    const scrim = [...document.querySelectorAll('div[aria-hidden="true"]')]
      .find((el) => { const cs = getComputedStyle(el); return cs.position === 'absolute' && el.getBoundingClientRect().width > 400 && cs.backgroundColor !== 'rgba(0, 0, 0, 0)'; });
    const cap = document.querySelector('[role="toolbar"][aria-label="Page and zoom controls"]');
    // Read z-index off the POSITIONED wrapper, not the child (which is z-auto).
    const positioned = (el) => { let n = el; while (n && n !== document.body) {
        const cs = getComputedStyle(n); if (cs.position !== 'static' && cs.zIndex !== 'auto') return { z: cs.zIndex, cls: String(n.className).slice(0,50) };
        n = n.parentElement; } return null; };
    return { open: true, scrimZ: scrim ? getComputedStyle(scrim).zIndex : null,
             capsuleZ: cap ? positioned(cap) : null };
  })()`);
  check("the Inspector drawer opened as a modal dialog", drawerState.open === true, `trigger=${opened}`);
  await shot("drawer-modal");

  if (drawerState.open && capsuleTarget) {
    const zoomBeforeBlocked = await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /Zoom level/i.test(x.getAttribute('aria-label')||''));
      return b ? (b.getAttribute('aria-label')||'').trim() : null;
    })()`);
    // The SAME coordinates that just worked.
    await mouseClick(capsuleTarget.x, capsuleTarget.y);
    await sleep(500);
    const zoomAfterBlocked = await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /Zoom level/i.test(x.getAttribute('aria-label')||''));
      return b ? (b.getAttribute('aria-label')||'').trim() : null;
    })()`);
    check(
      "with the modal drawer open, clicking the capsule does NOT change zoom",
      zoomAfterBlocked === zoomBeforeBlocked,
      `${zoomBeforeBlocked} -> ${zoomAfterBlocked}; scrimZ=${drawerState.scrimZ} capsuleWrapperZ=${JSON.stringify(drawerState.capsuleZ)}`,
    );
    check(
      "the scrim paints above the capsule's positioned wrapper",
      Number(drawerState.scrimZ ?? 0) > Number(drawerState.capsuleZ?.z ?? 0),
      `scrim=${drawerState.scrimZ} capsuleWrapper=${drawerState.capsuleZ?.z}`,
    );
  }
  await key("Escape", "Escape", 27);
  await sleep(500);

  console.log("\n============ CONSOLE ============");
  const realErrors = consoleErrors.filter(
    (e) => !/favicon|ERR_INTERNET_DISCONNECTED|net::ERR_FAILED|React DevTools/i.test(e),
  );
  for (const e of realErrors) console.log("  ERR:", e);
  check("no unexplained console errors", realErrors.length === 0, `${realErrors.length}`);

  console.log("\n============ MEASUREMENT TABLE ============");
  for (const r of rows) {
    console.log(
      `  ${String(r.w).padStart(4)}  usable=${String(r.usable).padStart(4)}  layout=${String(r.main?.w).padStart(4)}  rail=${String(r.rail?.w ?? 0).padStart(3)}` +
        `  inspector=${r.dock?.w ? `docked ${r.dock.w}` : r.drawer?.w ? `drawer ${r.drawer.w}` : "closed"}`,
    );
  }

  console.log(`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} FAILURE(S)`}`);
  for (const f of failures) console.log("  - " + f);
  sock.close();
  chrome.kill();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
