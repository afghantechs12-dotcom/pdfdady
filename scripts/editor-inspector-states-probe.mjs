/* global process, console, fetch, WebSocket, setTimeout, Buffer */
/**
 * Stage 5 (part 2) of the P1 Phase H Inspector verification.
 *
 * `editor-inspector-probe.mjs` covers the standalone `/editor` Properties tab:
 * dock geometry, sections, text controls, italic, geometry, heights, console.
 * This script covers the states that one cannot reach:
 *
 *   s01 Image        — contextual heading, grouped controls, real Replace, crop,
 *                      X/Y/W/H with units, visible aspect-lock state.
 *   s02 Shape        — heading, Fill/Stroke, geometry, normal transform fields.
 *   s03 Drawing      — heading, real stroke/colour/width/opacity, no fake fields.
 *   s04 Source text  — read-only heading, NO geometry/opacity/flip/Edit, real
 *                      actions, no canvas transform handles, cannot be moved.
 *   s05 Multi-select — real count, shared actions only, no single-object fields.
 *   s06 Outline      — rows/nesting/title/page, expand-collapse, honest empty.
 *   s07 Comments     — display NAME not raw id, initials, human time, real body.
 *   s08 Versions     — current badge, author/date/origin, Restore disabled on
 *                      current + degraded, enabled on an older writable version,
 *                      confirm wording says a NEW version, 409 does not
 *                      auto-retry, Reload exists, no Preview/Compare.
 *   s09 Overlay      — below the 1200px breakpoint the Inspector is a drawer:
 *                      opens, closes, no offscreen controls, no overflow.
 *   s10 Console      — zero errors across the whole run.
 *
 * The document panels (Outline/Comments/Versions) only exist for a WORKSPACE
 * document, so this probe drives `/workspaces/{ws}/documents/{id}` against a
 * DEDICATED FIXTURE account created by `--doc/--ws/--org/--cookie`. Restore is
 * exercised for real, which is why it must never point at a human's document.
 *
 * WHAT THIS CANNOT DO: it captures screenshots but cannot visually decode them.
 * Every check is a measurement or a semantic assertion, never an aesthetic one.
 *
 * Usage:
 *   node scripts/editor-inspector-states-probe.mjs --cookie "pdfdadi_session=..." \
 *     --ws <workspaceId> --org <organizationId> --doc <documentId>
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg("--url", "http://localhost:3001");
const SHOTS = arg("--shots", "docs/screenshots/phase-h");
const COOKIE = arg("--cookie", "");
const WS = arg("--ws", "");
const ORG = arg("--org", "");
const DOC = arg("--doc", "");
/**
 * FIXTURE IDENTITY, not a product claim.
 *
 * s07/s08 assert that the panels render a real display NAME and a real comment
 * BODY rather than raw ids or placeholder text. Those are product claims. The
 * particular name and the particular words are properties of whichever fixture
 * the run points at, and hardcoding them made the probe fail on a different
 * (equally valid) fixture for a reason that had nothing to do with the product.
 * The defaults are the original Phase H fixture's values, so an invocation that
 * omits these flags behaves exactly as before.
 */
const AUTHOR = arg("--author", "Phase H Probe");
const COMMENT_BODY = arg("--comment", "page break|leaving a note|keep it as-is");
/**
 * The storage key of an artifact the fixture really ingested, used by the s08
 * stale-revision bump. Without it the bump POST is rejected (422) and the
 * conflict path cannot be exercised at all — which reads as five product
 * failures when it is really a missing argument.
 */
const SOURCE_KEY = arg("--source-key", "");
// Browser binary. `CHROME_PATH` lets a non-Windows machine (or a Chrome for
// Testing download) point the probe at its own build; the literal default keeps
// the original Windows invocation working untouched.
const CHROME =
  process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The PAGE surface's rect, as a browser expression.
 *
 * WHY THIS IS NOT `main svg`. The canvas renders an overlay `<svg>` that spans
 * the whole scroll region, so "the largest `main svg`" is the OVERLAY, not the
 * page: at 71% zoom on a 1600px viewport it measured 834×720 starting at x=447
 * while the A4 page really sat at x=653, 422px wide. Every coordinate derived
 * from that box was ~200px to the left of the page, so s02's drag-to-create
 * started OFF the page — and "off-page creates nothing" is correct product
 * behaviour (`editor-shape-draw-probe.mjs` asserts it deliberately). The
 * Drawing case passed only because its drag happened to start further right.
 *
 * The page background `rect` is the surface both this probe and the shape/draw
 * probe now agree on, so the two cannot disagree about where the page is.
 */
const PAGE_RECT_JS = `(() => {
  const rects = [...document.querySelectorAll('main svg rect')]
    .map((r) => r.getBoundingClientRect())
    .filter((b) => b.width > 200 && b.height > 200)
    .sort((a, b) => b.width * b.height - a.width * a.height);
  return rects.length ? rects[0] : null;
})()`;

async function main() {
  if (!COOKIE || !WS || !ORG || !DOC) {
    console.error("Missing --cookie/--ws/--org/--doc (a dedicated fixture, never real user data).");
    process.exit(2);
  }
  const userDataDir = mkdtempSync(join(tmpdir(), "pdfdadi-states-"));
  const port = 9477;
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
        (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 240),
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
      return { __error: res.result.exceptionDetails.text ?? "evaluate threw" };
    }
    return res.result?.result?.value;
  };
  const click = async (x, y, clickCount = 1, holdMs = 110) => {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount, buttons: 1 });
    await sleep(holdMs);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount, buttons: 0 });
  };
  const drag = async (x1, y1, x2, y2) => {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", clickCount: 1, buttons: 1 });
    for (let i = 1; i <= 6; i += 1) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved", button: "left", buttons: 1,
        x: Math.round(x1 + ((x2 - x1) * i) / 6), y: Math.round(y1 + ((y2 - y1) * i) / 6),
      });
      await sleep(28);
    }
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", clickCount: 1, buttons: 0 });
  };
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
    } catch {
      /* evidence for humans, never a gate */
    }
  };

  const failures = [];
  const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failures.push(name);
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  const [cookieName, cookieValue] = COOKIE.split("=");
  await send("Network.setCookie", {
    name: cookieName.trim(), value: cookieValue.trim(), domain: "localhost", path: "/",
  });
  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${BASE}/workspaces/${WS}/documents/${DOC}` });
  /**
   * Wait for the editor to be genuinely INTERACTIVE, not merely mounted. A fixed
   * sleep raced the document load on a cold dev-server compile and reported the
   * still-empty "Page" inspector as a missing Shape/Drawing panel — fifteen
   * "failures" that were all one timing bug.
   */
  let ready;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(1000);
    ready = await evaluate(`(() => {
      const tabs = [...document.querySelectorAll('[role="tablist"][aria-label="Inspector"] [role="tab"]')].length;
      const page = ${PAGE_RECT_JS};
      return { tabs, pageWidth: Math.round(page?.width ?? 0) };
    })()`);
    if ((ready?.tabs ?? 0) >= 4 && (ready?.pageWidth ?? 0) > 200) break;
  }

  const SCOPE = `(() => {
    const list = document.querySelector('[role="tablist"][aria-label="Inspector"]');
    if (!list) return null;
    const tab = [...list.querySelectorAll('[role="tab"]')].find((t) => t.getAttribute('aria-selected') === 'true');
    const panel = tab ? document.getElementById(tab.getAttribute('aria-controls')) : null;
    return { list, tab, panel, dock: list.closest('aside') || list.parentElement.parentElement };
  })()`;

  /** Shared panel reader: heading, sections, buttons, inputs with REAL names. */
  const READ = `(() => {
    const s = ${SCOPE};
    if (!s || !s.panel) return null;
    const accName = (el) => {
      const aria = (el.getAttribute('aria-label') || '').trim();
      if (aria) return aria;
      const ids = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean);
      if (ids.length) {
        const t = ids.map((i) => (document.getElementById(i)?.innerText || '').trim()).join(' ').trim();
        if (t) return t;
      }
      for (const l of [...(el.labels || [])]) {
        const c = l.cloneNode(true);
        for (const x of c.querySelectorAll('input, select, textarea, option')) x.remove();
        const t = (c.innerText || c.textContent || '').trim();
        if (t) return t;
      }
      return (el.getAttribute('title') || '').trim();
    };
    return {
      heading: (s.panel.querySelector('h2')?.textContent || '').trim(),
      sections: [...s.panel.querySelectorAll('h3')].map((h) => h.textContent.trim()),
      buttons: [...s.panel.querySelectorAll('button')].map((b) => ({
        label: ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).trim(),
        title: b.getAttribute('title') || '',
        disabled: b.disabled === true,
        pressed: b.getAttribute('aria-pressed'),
      })),
      inputs: [...s.panel.querySelectorAll('input, select, textarea')].map((el) => ({
        name: accName(el),
        type: el.getAttribute('type') || el.tagName.toLowerCase(),
        height: Math.round(el.getBoundingClientRect().height),
      })),
      text: s.panel.innerText,
      panelOverflow: s.panel.scrollWidth - s.panel.clientWidth,
      dockOverflow: s.dock.scrollWidth - s.dock.clientWidth,
      /**
       * Text that is WIDER than the box drawn for it — i.e. rendered as an
       * ellipsis or hard-clipped. Leaf elements only, so a scrolling container is
       * not reported as a truncated label.
       *
       * This exists because the Inspector shipped with "Properties" truncated to
       * "Proper..." in a 49px box for 55px of text, and every check here passed:
       * panelOverflow was 0 because the PANEL was not overflowing itself — it was
       * 357px wide inside a 319px dock, pushing "Delete" off the window. The number
       * that would have caught it, dockOverflow, was measured on the line above and
       * never compared to anything.
       *
       * No backticks in this comment: it is inside a template literal, and one
       * unescaped backtick ends the string and reports as a syntax error pointing
       * at the wrong line.
       */
      clipped: [...s.dock.querySelectorAll('*')]
        .filter((el) => el.children.length === 0
          && el.clientWidth > 0
          && el.scrollWidth > el.clientWidth + 1
          && (el.innerText || '').trim().length > 0)
        .map((el) => ({ text: (el.innerText || '').trim().slice(0, 24),
                        box: el.clientWidth, needs: el.scrollWidth })),
      /** Controls escaping the dock's own right edge, which is what clipped "Delete". */
      pastDockEdge: [...s.dock.querySelectorAll('button, input, select')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.right > s.dock.getBoundingClientRect().right + 1;
        })
        .map((el) => ((el.getAttribute('aria-label') || el.innerText || '').trim().slice(0, 24))),
      offscreen: [...s.panel.querySelectorAll('button, input, select')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1);
      }).length,
    };
  })()`;

  /**
   * The fit contract, asserted for every Inspector state rather than once: the
   * panel must not overflow itself, the dock must not overflow ITSELF (the defect
   * above), no control may escape the dock's right edge, and no text may be
   * clipped or ellipsised. Presentation may change with width; legibility may not.
   */
  const checkFit = (tag, snap) => {
    check(`${tag} no horizontal overflow`, (snap?.panelOverflow ?? 99) <= 1, `${snap?.panelOverflow}px`);
    check(
      `${tag} the Inspector fits inside its own dock`,
      (snap?.dockOverflow ?? 99) <= 1,
      `dockOverflow=${snap?.dockOverflow}px pastDockEdge=${JSON.stringify(snap?.pastDockEdge ?? null)}`,
    );
    check(
      `${tag} no label is truncated or ellipsised`,
      Array.isArray(snap?.clipped) && snap.clipped.length === 0,
      JSON.stringify(snap?.clipped ?? null),
    );
  };

  const selectTab = async (name) => {
    await evaluate(`(() => {
      const list = document.querySelector('[role="tablist"][aria-label="Inspector"]');
      const t = [...list.querySelectorAll('[role="tab"]')]
        .find((x) => new RegExp(${JSON.stringify("")} + '${name}', 'i').test((x.getAttribute('title') || '') + ' ' + (x.textContent || '')));
      if (t) { t.click(); return 'ok'; }
      return 'missing';
    })()`);
    await sleep(1400);
  };

  const pageBox = async () =>
    evaluate(`(() => {
      const b = ${PAGE_RECT_JS};
      if (!b) return null;
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
               cx: Math.round(b.x + b.width / 2), cy: Math.round(b.y + b.height / 2) };
    })()`);

  const loaded = await evaluate(`(() => {
    const page = ${PAGE_RECT_JS};
    return {
      tabs: [...document.querySelectorAll('[role="tablist"][aria-label="Inspector"] [role="tab"]')]
        .map((t) => (t.getAttribute('title') || t.textContent || '').trim()),
      hasCanvas: Boolean(page && page.width > 200 && page.height > 200),
      pageWidth: Math.round(page?.width ?? 0),
    };
  })()`);
  check(
    "s00 workspace document editor loaded with all four Inspector tabs",
    (loaded?.tabs?.length ?? 0) >= 4 && loaded?.hasCanvas === true,
    JSON.stringify(loaded),
  );
  check(
    "s00 the fixture document presents a usable page surface",
    loaded?.hasCanvas === true,
    loaded?.hasCanvas
      ? `page ${loaded.pageWidth}px`
      : "no page surface — object states cannot be driven; fix the fixture, not the product",
  );

  const box = await pageBox();
  if (!box) {
    check("s00 page canvas present", false, "no page rect found — cannot drive object states");
    console.log(`\nFAILURES (${failures.length}): ${failures.join(", ")}`);
    sock.close(); chrome.kill(); process.exit(1);
  }

  /**
   * Create an object and WAIT for the Inspector to actually describe it.
   *
   * Drag-to-create is asynchronous end to end (pointer stream → tool commit →
   * React commit → panel re-render), and a fixed sleep after the drag raced it:
   * the same code passed one run and failed the next with the panel still on
   * "Page". Retried and polled instead, so a genuine "the tool does not create
   * anything" failure is still reported, but a slow commit is not.
   */
  const createAndAwait = async (toolKey, toolCode, toolVk, from, to, expectHeading) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await key("Escape", "Escape", 27);
      await sleep(200);
      await key(toolKey, toolCode, toolVk);
      await sleep(350);
      await drag(from.x, from.y, to.x, to.y);
      for (let poll = 0; poll < 16; poll += 1) {
        await sleep(180);
        const heading = await evaluate(`(() => {
          const s = ${SCOPE};
          return s && s.panel ? (s.panel.querySelector('h2')?.textContent || '').trim() : '';
        })()`);
        if (expectHeading.test(heading ?? "")) return heading;
      }
    }
    return null;
  };

  // NOTE ON ORDER: source text is probed BEFORE anything is drawn. A rect or
  // a drawing placed on the page covers the imported-text hit rects, so a later
  // click lands on the new object and the panel reports that object instead.
  // ================= s04 Source PDF text ==================================
  // The P0 invariant, re-verified in the Phase H Inspector: original PDF text is
  // a read-only range, so the panel must offer NO geometry, NO opacity, NO flip
  // and NO "Edit", the canvas must show no transform handles, and a drag must
  // not move it.
  await key("Escape", "Escape", 27);
  await sleep(200);
  await key("v", "KeyV", 86);
  await sleep(250);
  const sourceHit = await evaluate(`(() => {
    /**
     * An imported run is a fill="transparent" hit rect over the rendered glyphs
     * (never an <svg text> node) — the same selector the P0 source-text probe
     * uses, kept identical on purpose so the two agree about what source text is.
     * The size floor is deliberately low: a single line of body text is only a
     * few px tall, and an earlier >6px/<700px filter matched nothing here.
     */
    const els = [...document.querySelectorAll('main svg rect')]
      .filter((r) => (r.getAttribute('fill') || '') === 'transparent')
      .map((r) => ({ r, b: r.getBoundingClientRect() }))
      .filter((x) => x.b.width > 20 && x.b.height > 4)
      .sort((a, b) => b.b.width * b.b.height - a.b.width * a.b.height);
    if (!els.length) return null;
    const b = els[0].b;
    return { cx: Math.round(b.x + b.width / 2), cy: Math.round(b.y + b.height / 2),
             x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
             candidates: els.length };
  })()`);
  if (!sourceHit) {
    console.log("SKIP  s04 source PDF text — no imported text hit target found on this page.");
  } else {
    await key("Escape", "Escape", 27);
    await sleep(200);
    await key("v", "KeyV", 86);
    await sleep(300);
    // Poll for the selection to be described, as with object creation.
    let srcHeading;
    for (let poll = 0; poll < 16; poll += 1) {
      if (poll === 0) await click(sourceHit.cx, sourceHit.cy);
      await sleep(200);
      srcHeading = await evaluate(`(() => {
        const s = ${SCOPE};
        return s && s.panel ? (s.panel.querySelector('h2')?.textContent || '').trim() : '';
      })()`);
      if (/original|source|pdf text/i.test(srcHeading ?? "")) break;
    }
    const src = await evaluate(READ);
    await shot("h08-source-pdf-text");
    check(
      "s04 heading identifies ORIGINAL PDF text, not ordinary Text",
      /original|source|pdf text/i.test(src?.heading ?? ""),
      `got "${src?.heading}" (${sourceHit.candidates} hit rects, clicked ${sourceHit.w}x${sourceHit.h})`,
    );
    check(
      "s04 NO geometry fields for source text (X/Y/W/H absent)",
      !(src?.inputs ?? []).some((i) => /^(X position|Y position|Width|Height|Rotation)/.test(i.name)),
      JSON.stringify(src?.inputs?.map((i) => i.name)),
    );
    check(
      "s04 NO opacity control for source text",
      !(src?.inputs ?? []).some((i) => /opacity/i.test(i.name)),
      JSON.stringify(src?.inputs?.map((i) => i.name)),
    );
    check(
      "s04 NO flip controls for source text",
      !(src?.buttons ?? []).some((b) => /flip/i.test(b.label)),
      JSON.stringify(src?.buttons?.map((b) => b.label)),
    );
    check(
      "s04 NO fake Edit affordance for source text",
      !(src?.buttons ?? []).some((b) => /^edit\b/i.test(b.label.trim())),
      JSON.stringify(src?.buttons?.map((b) => b.label)),
    );
    check(
      "s04 real, supported actions ARE offered (copy/highlight/comment)",
      (src?.buttons ?? []).some((b) => /copy|highlight|comment/i.test(b.label)),
      JSON.stringify(src?.buttons?.map((b) => b.label)),
    );
    const handles = await evaluate(`(() => {
      const svg = document.querySelector('main svg');
      if (!svg) return null;
      return {
        resize: svg.querySelectorAll('[data-handle], [data-resize-handle], circle[data-role="handle"]').length,
        rotate: svg.querySelectorAll('[data-rotate-handle]').length,
      };
    })()`);
    check(
      "s04 the canvas shows no resize/rotate handles for source text",
      (handles?.resize ?? 0) === 0 && (handles?.rotate ?? 0) === 0,
      JSON.stringify(handles),
    );
    // Drag it and prove it did not move.
    const before = await evaluate(`(() => {
      const r = [...document.querySelectorAll('main svg rect')]
        .filter((x) => { const b = x.getBoundingClientRect(); return Math.abs(b.x - ${sourceHit.x}) < 3 && Math.abs(b.y - ${sourceHit.y}) < 3; })[0];
      if (!r) return null; const b = r.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y) };
    })()`);
    await drag(sourceHit.cx, sourceHit.cy, sourceHit.cx + 90, sourceHit.cy + 60);
    await sleep(700);
    const after = await evaluate(`(() => {
      const r = [...document.querySelectorAll('main svg rect')]
        .filter((x) => { const b = x.getBoundingClientRect(); return Math.abs(b.width - ${sourceHit.w}) < 3 && Math.abs(b.height - ${sourceHit.h}) < 3; })[0];
      if (!r) return null; const b = r.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y) };
    })()`);
    check(
      "s04 source text cannot be dragged (position unchanged after a drag)",
      before && after && Math.abs(after.x - before.x) <= 1 && Math.abs(after.y - before.y) <= 1,
      JSON.stringify({ before, after }),
    );
    checkFit("s04", src);
  }

  // ================= s02 Shape (R = rectangle) ============================
  /**
   * Drag coordinates are FRACTIONS of the page box, not fixed pixel offsets. A
   * fixed `+380 → +520` is only on the page at one zoom level and one page size;
   * at 71% zoom on this fixture it would have ended 98px past the page's right
   * edge. Fractions keep both gestures wholly on the page whatever the fit-zoom
   * works out to, so a genuine "the tool creates nothing" failure is the only way
   * these can fail.
   */
  const onPage = (fx, fy) => ({
    x: Math.round(box.x + box.w * fx),
    y: Math.round(box.y + box.h * fy),
  });
  const shapeHeading = await createAndAwait(
    "r", "KeyR", 82,
    onPage(0.12, 0.14),
    onPage(0.5, 0.42),
    /shape/i,
  );
  const shape = await evaluate(READ);
  await shot("h06-shape");
  check("s02 heading names the kind (Shape)", /shape/i.test(shape?.heading ?? ""), `got "${shape?.heading}" (created=${shapeHeading})`);
  for (const want of ["Fill", "Stroke"]) {
    check(
      `s02 ${want} control present`,
      (shape?.sections ?? []).some((x) => new RegExp(want, "i").test(x)) ||
        (shape?.inputs ?? []).some((i) => new RegExp(want, "i").test(i.name)),
      JSON.stringify({ sections: shape?.sections, inputs: shape?.inputs?.map((i) => i.name) }),
    );
  }
  const shapeGeom = ["X position", "Y position", "Width", "Height"].filter((f) =>
    (shape?.inputs ?? []).some((i) => i.name.startsWith(f)),
  );
  check(
    "s02 editable shape keeps its full geometry (X/Y/W/H)",
    shapeGeom.length === 4,
    JSON.stringify({ found: shapeGeom, all: shape?.inputs?.map((i) => i.name) }),
  );
  check("s02 rotation is offered for an editable object",
    (shape?.inputs ?? []).some((i) => /rotation/i.test(i.name)),
    JSON.stringify(shape?.inputs?.map((i) => i.name)));
  checkFit("s02", shape);

  // ================= s03 Drawing (D = freehand) ===========================
  const drawHeading = await createAndAwait(
    "d", "KeyD", 68,
    onPage(0.6, 0.18),
    onPage(0.88, 0.52),
    /draw/i,
  );
  const draw = await evaluate(READ);
  await shot("h07-drawing");
  check("s03 heading names the kind (Drawing)", /draw/i.test(draw?.heading ?? ""), `got "${draw?.heading}" (created=${drawHeading})`);
  check(
    "s03 real stroke controls present (colour + width)",
    (draw?.inputs ?? []).some((i) => /colou?r/i.test(i.name)) &&
      (draw?.inputs ?? []).some((i) => /width|thickness|stroke/i.test(i.name)),
    JSON.stringify(draw?.inputs?.map((i) => i.name)),
  );
  check(
    "s03 opacity present for a drawing",
    (draw?.inputs ?? []).some((i) => /opacity/i.test(i.name)),
    JSON.stringify(draw?.inputs?.map((i) => i.name)),
  );
  checkFit("s03", draw);

  // ================= s01 Image ===========================================
  // The image tool opens a file picker, which a headless probe cannot satisfy.
  // Report honestly rather than pretend: the Node suite covers ImageControls,
  // and the crop/aspect contract is asserted there.
  const imageProbe = await evaluate(`(() => {
    const s = ${SCOPE};
    return { fileInputs: document.querySelectorAll('input[type="file"]').length };
  })()`);
  console.log(
    `SKIP  s01 Image inspector — requires a real file-picker selection (${imageProbe?.fileInputs} file inputs present); covered by the Node suite, NOT verified in-browser here.`,
  );

  // ================= s05 Multi-selection ==================================
  await key("Escape", "Escape", 27);
  await sleep(200);
  await key("v", "KeyV", 86);
  await sleep(200);
  // Ctrl+A selects all objects on the page.
  await key("a", "KeyA", 65, 2);
  await sleep(700);
  const multi = await evaluate(READ);
  await shot("h09-multi-selection");
  check(
    "s05 heading reports the real object count",
    /\d+\s+object/i.test(multi?.heading ?? ""),
    `got "${multi?.heading}"`,
  );
  check(
    "s05 shared actions only — Align/Distribute offered",
    (multi?.sections ?? []).some((x) => /align/i.test(x)) &&
      (multi?.sections ?? []).some((x) => /distribute/i.test(x)),
    JSON.stringify(multi?.sections),
  );
  check(
    "s05 no single-object typography fields leak into a multi-selection",
    !(multi?.inputs ?? []).some((i) => /font|leading|track/i.test(i.name)),
    JSON.stringify(multi?.inputs?.map((i) => i.name)),
  );
  check(
    "s05 no per-object geometry fields in a multi-selection",
    !(multi?.inputs ?? []).some((i) => /^(X position|Y position|Width|Height)/.test(i.name)),
    JSON.stringify(multi?.inputs?.map((i) => i.name)),
  );
  checkFit("s05", multi);

  // ================= s06 Outline =========================================
  await key("Escape", "Escape", 27);
  await sleep(300);
  await selectTab("Outline");
  const outline = await evaluate(READ);
  await shot("h10-outline");
  check(
    "s06 Outline panel renders (rows or an honest empty state)",
    Boolean(outline) && (outline.text ?? "").trim().length > 0,
    JSON.stringify({ heading: outline?.heading, text: outline?.text?.slice(0, 160) }),
  );
  const outlineEmpty = /no outline|no bookmarks|empty|doesn't have|does not have/i.test(outline?.text ?? "");
  const outlineRows = await evaluate(`(() => {
    const s = ${SCOPE};
    if (!s || !s.panel) return null;
    const rows = [...s.panel.querySelectorAll('[role="treeitem"], li')];
    return {
      count: rows.length,
      withPage: rows.filter((r) => /\\d+$/.test((r.innerText || '').trim())).length,
      expandable: s.panel.querySelectorAll('[aria-expanded]').length,
      hasTree: Boolean(s.panel.querySelector('[role="tree"]')),
    };
  })()`);
  check(
    "s06 Outline is honest: either real rows, or an explicit empty state (never fake CRUD)",
    outlineEmpty || (outlineRows?.count ?? 0) > 0,
    JSON.stringify({ empty: outlineEmpty, rows: outlineRows }),
  );
  check(
    "s06 Outline offers no fake mutation controls when unimplemented",
    !(outline?.buttons ?? []).some((b) => /^(add|new|rename|delete) (bookmark|outline)/i.test(b.label.trim())) ||
      (outlineRows?.count ?? 0) > 0,
    JSON.stringify(outline?.buttons?.map((b) => b.label)),
  );
  checkFit("s06", outline);

  // ================= s07 Comments ========================================
  await selectTab("Comments");
  await sleep(900);
  const comments = await evaluate(READ);
  await shot("h11-comments");
  check(
    "s07 Comments panel shows the fixture thread body",
    new RegExp(COMMENT_BODY, "i").test(comments?.text ?? ""),
    JSON.stringify(comments?.text?.slice(0, 240)),
  );
  check(
    "s07 author is a display NAME, not a raw internal id",
    new RegExp(AUTHOR).test(comments?.text ?? "") && !/cm[a-z0-9]{22,}/.test(comments?.text ?? ""),
    JSON.stringify({
      hasName: new RegExp(AUTHOR).test(comments?.text ?? ""),
      rawIds: (comments?.text ?? "").match(/cm[a-z0-9]{22,}/g)?.slice(0, 3) ?? [],
    }),
  );
  const initials = await evaluate(`(() => {
    const s = ${SCOPE};
    if (!s || !s.panel) return null;
    const nodes = [...s.panel.querySelectorAll('*')].filter((el) => el.children.length === 0);
    return { initials: nodes.map((n) => (n.textContent || '').trim()).filter((t) => /^[A-Z]{1,2}$/.test(t)).slice(0, 6) };
  })()`);
  check(
    "s07 an avatar/initials treatment is present",
    (initials?.initials?.length ?? 0) > 0,
    JSON.stringify(initials?.initials),
  );
  check(
    "s07 time is human-readable, not a raw ISO timestamp",
    !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(comments?.text ?? ""),
    JSON.stringify((comments?.text ?? "").match(/\d{4}-\d{2}-\d{2}T[^\s]*/g)?.slice(0, 2) ?? []),
  );
  checkFit("s07", comments);

  // Switching tabs must not disturb the page/zoom. Measured on the PAGE, not on
  // `main svg` — that returned the first SVG in the subtree, a 16px toolbar icon,
  // so the check used to compare 16 with 16 and could never have failed.
  const zoomBefore = await evaluate(`(() => (${PAGE_RECT_JS})?.width ?? null)()`);
  await selectTab("Properties");
  await selectTab("Comments");
  const zoomAfter = await evaluate(`(() => (${PAGE_RECT_JS})?.width ?? null)()`);
  check(
    "s07 switching tabs does not resize/reset the page view",
    zoomBefore !== null && Math.abs((zoomAfter ?? 0) - zoomBefore) <= 1,
    `${zoomBefore} -> ${zoomAfter}`,
  );

  // ================= s08 Versions ========================================
  await selectTab("Versions");
  await sleep(1500);
  const versions = await evaluate(READ);
  await shot("h12-versions");
  check(
    "s08 version rows render with author and origin",
    // A label is optional — an imported v1 legitimately has none — so the
    // assertion is on the author and the origin, which every row must carry.
    new RegExp(AUTHOR).test(versions?.text ?? "") && /\b(SAVE|IMPORT|RESTORE)\b/.test(versions?.text ?? ""),
    JSON.stringify(versions?.text?.slice(0, 300)),
  );
  check(
    "s08 the current version is explicitly marked",
    /current/i.test(versions?.text ?? ""),
    JSON.stringify(versions?.text?.slice(0, 200)),
  );
  const restores = (versions?.buttons ?? []).filter((b) => /restore/i.test(b.label));
  check("s08 Restore actions exist", restores.length >= 1, JSON.stringify(restores));
  check(
    "s08 Restore is disabled on the current version, with a stated reason",
    restores.some((b) => b.disabled && b.title.length > 10),
    JSON.stringify(restores),
  );
  check(
    "s08 Restore is available on an older, valid version",
    restores.some((b) => !b.disabled),
    JSON.stringify(restores),
  );
  check(
    "s08 no fake Preview / Compare affordances",
    !(versions?.buttons ?? []).some((b) => /^(preview|compare)/i.test(b.label.trim())),
    JSON.stringify(versions?.buttons?.map((b) => b.label)),
  );
  check(
    "s08 time is human-readable, not a raw ISO timestamp",
    !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(versions?.text ?? ""),
    JSON.stringify((versions?.text ?? "").match(/\d{4}-\d{2}-\d{2}T[^\s]*/g)?.slice(0, 2) ?? []),
  );
  checkFit("s08", versions);

  /**
   * The Restore wording. There is NO confirm dialog by design: Restore is a
   * single click and the "creates a new version" promise rides on the control's
   * own `title`, which is where a user reads it before committing. An earlier
   * version of this probe assumed a two-step confirm, clicked "Restore" twice,
   * and mislabelled both the wording and the conflict behaviour.
   */
  check(
    "s08 the Restore control promises a NEW version and no rewind",
    restores.some((b) => /creates a new version/i.test(b.title) && /history is kept/i.test(b.title)) &&
      !restores.some((b) => /rewind|revert history|undo all/i.test(b.title)),
    JSON.stringify(restores.map((b) => b.title)),
  );

  // --- 409: force a real conflict and prove there is no silent auto-retry ---
  /**
   * The panel holds `document.revision` read at mount. Advancing the document
   * behind its back makes that value stale, so the compare-and-swap MUST reject
   * the next restore.
   *
   * The bump reuses the fixture's REAL ingested artifact rather than a made-up
   * key. An earlier version invented `probe/bump.pdf`, which has no stored bytes:
   * restoring it left the document pointing at an unreadable manifest, so the NEXT
   * run of this probe found a document stuck in the error load phase and reported
   * eleven phantom Inspector failures. A verification script must not corrupt the
   * fixture it verifies.
   */
  const artifact = await evaluate(`(async () => {
    const v = await fetch('/api/workspaces/${WS}/documents/${DOC}/versions?organizationId=${ORG}',
      { credentials: 'include' }).then((r) => r.json());
    const imported = (v.versions || []).find((x) => x.origin === 'import') || (v.versions || [])[0];
    return imported ? { checksum: imported.sourceChecksum, size: imported.sourceByteSize,
                        pages: imported.pageCount ?? 1 } : null;
  })()`);
  let restoreRequests = 0;
  const countRestores = (msg) => {
    const m = JSON.parse(typeof msg.data === "string" ? msg.data : String(msg.data));
    if (m.method === "Network.requestWillBeSent" && /\/versions\/[^/]+\/restore/.test(m.params?.request?.url ?? "")) {
      restoreRequests += 1;
    }
  };
  const bump = await evaluate(`(async () => {
    /**
     * The compare-and-swap is RACING THIS PROBE. s02/s03 created a shape and a
     * drawing, and autosave writes those in the background, so the revision read
     * a moment ago is routinely stale by the time the POST lands — a 409 that
     * says the CAS works, not that the fixture is broken. Re-read and retry a
     * bounded number of times; only a persistent non-2xx is reported.
     */
    let last = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const cur = await fetch('/api/workspaces/${WS}/documents/${DOC}?organizationId=${ORG}', { credentials: 'include' })
        .then((r) => r.json());
      const rev = (cur.document ?? cur).revision;
      // The artifact is the one the fixture really ingested, so every version this
      // probe creates stays loadable.
      const res = await fetch('/api/workspaces/${WS}/documents/${DOC}/versions', {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: '${ORG}', expectedRevision: rev, origin: 'save',
          label: 'Stale-revision bump (probe)',
          manifest: { sourceKey: ${JSON.stringify(SOURCE_KEY)},
                      sourceChecksum: ${JSON.stringify(artifact?.checksum ?? "")},
                      sourceByteSize: ${artifact?.size ?? 0},
                      pageCount: ${artifact?.pages ?? 1} } }),
      });
      last = { status: res.status, revBefore: rev, attempts: attempt + 1 };
      if (res.status < 400) return last;
      await new Promise((r) => setTimeout(r, 700));
    }
    return last;
  })()`);
  sock.addEventListener("message", countRestores);
  const staleClick = await evaluate(`(() => {
    const s = ${SCOPE};
    // An ENABLED Restore on an older row; the panel's held revision is now stale.
    const btn = [...s.panel.querySelectorAll('button')]
      .find((b) => /^restore$/i.test((b.textContent || '').trim()) && !b.disabled);
    if (!btn) return { found: false, labels: [...s.panel.querySelectorAll('button')].map((b) => (b.textContent || '').trim()) };
    btn.click();
    return { found: true };
  })()`);
  await sleep(3000);
  const conflict = await evaluate(READ);
  sock.removeEventListener("message", countRestores);
  await shot("h13-restore-conflict");
  check(
    "s08 a stale revision surfaces the server's conflict message",
    /revision|reload|conflict|does not match/i.test(conflict?.text ?? ""),
    JSON.stringify({ bump, staleClick, snippet: conflict?.text?.slice(0, 260) }),
  );
  check(
    "s08 the conflict offers Reload versions",
    (conflict?.buttons ?? []).some((b) => /reload/i.test(b.label)),
    JSON.stringify(conflict?.buttons?.map((b) => b.label)),
  );
  check(
    "s08 the conflict does NOT silently auto-retry (exactly one restore request)",
    restoreRequests === 1,
    `${restoreRequests} restore requests observed`,
  );

  // ================= s09 Overlay / narrow Inspector =======================
  await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(1800);
  const narrow = await evaluate(`(() => {
    const list = document.querySelector('[role="tablist"][aria-label="Inspector"]');
    const aside = document.querySelector('aside.w-\\\\[320px\\\\]');
    const page = ${PAGE_RECT_JS};
    return {
      docked: Boolean(aside),
      inspectorVisible: Boolean(list && list.getBoundingClientRect().width > 0),
      canvasWidth: Math.round(page?.width ?? 0),
      viewport: window.innerWidth,
    };
  })()`);
  check(
    "s09 below the 1200px breakpoint the Inspector stops being a permanent dock",
    narrow?.docked === false,
    JSON.stringify(narrow),
  );
  check("s09 the canvas remains usable at narrow width", (narrow?.canvasWidth ?? 0) > 200, JSON.stringify(narrow));
  /**
   * The drawer opens from the floating canvas control labelled "Show inspector"
   * (one control at every width: it collapses the dock where the panel docks and
   * opens the drawer where it cannot). Matched EXACTLY — a loose /inspector|panel/
   * test previously matched "Organize pages" and clicked the wrong button.
   *
   * REVISED for the canvas-monotonicity contract (`components/editor/canvasGeometry.ts`).
   * Resizing may change HOW the Inspector is presented but never WHETHER: an
   * Inspector that was docked at 1600 comes back as an OPEN DRAWER at 1100, so
   * there is no "Show inspector" opener to click — only "Hide inspector". The old
   * check demanded the opener and therefore failed on the fixed build for doing
   * the right thing. It now clicks the opener only when the Inspector is actually
   * hidden, and asserts the end state either way: a drawer with real content.
   */
  const opener = await evaluate(`(() => {
    const list = document.querySelector('[role="tablist"][aria-label="Inspector"]');
    if (list && list.getBoundingClientRect().width > 0) {
      return { found: true, alreadyOpen: true, label: 'preserved across the resize' };
    }
    const btn = [...document.querySelectorAll('button')]
      .find((b) => /^show inspector$/i.test(((b.getAttribute('aria-label') || b.getAttribute('title') || '')).trim()));
    if (!btn) {
      return { found: false, alreadyOpen: false,
               candidates: [...document.querySelectorAll('button')]
                 .map((b) => (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim())
                 .filter((x) => /inspector/i.test(x)) };
    }
    btn.click();
    return { found: true, alreadyOpen: false, label: (btn.getAttribute('aria-label') || btn.getAttribute('title') || '').trim() };
  })()`);
  await sleep(1500);
  const drawer = await evaluate(READ);
  await shot("h14-overlay-inspector");
  check(
    "s09 the Inspector is presented as a drawer at narrow width",
    opener?.found === true && Boolean(drawer) && (drawer?.text ?? "").length > 0,
    JSON.stringify({ opener, heading: drawer?.heading }),
  );
  check("s09 no control is rendered offscreen in the drawer", (drawer?.offscreen ?? 99) === 0, `${drawer?.offscreen} offscreen`);
  checkFit("s09 (drawer)", drawer);
  await key("Escape", "Escape", 27);
  await sleep(1000);
  const afterEsc = await evaluate(`(() => {
    const list = document.querySelector('[role="tablist"][aria-label="Inspector"]');
    return { stillOpen: Boolean(list && list.getBoundingClientRect().width > 0) };
  })()`);
  check(
    "s09 the drawer closes and returns the canvas to full width",
    afterEsc?.stillOpen === false,
    JSON.stringify(afterEsc),
  );
  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
  await sleep(800);

  // ================= s10 Console =========================================
  check("s10 no console errors during the whole run", consoleErrors.length === 0, consoleErrors.slice(0, 4).join(" | "));

  console.log("");
  console.log(`Screenshots written to ${SHOTS}.`);
  console.log("NOTE: screenshots are evidence for a human. This probe measures geometry");
  console.log("      and semantics only; visual quality is NOT verified.");
  console.log("");
  console.log(failures.length === 0 ? "ALL CHECKS PASSED" : `FAILURES (${failures.length}): ${failures.join(", ")}`);
  sock.close();
  chrome.kill();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
