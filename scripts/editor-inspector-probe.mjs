/* global process, console, fetch, WebSocket, setTimeout, Buffer */
/**
 * Functional probe for the P1 Phase H Inspector (H48).
 *
 * The Node suite proves the pure rules and the wiring. It cannot prove the panel
 * has no horizontal scrollbar at 320px, that a section collapses when clicked, or
 * that a segmented control reports its pressed state after hydration. This drives
 * the real editor in a real browser and measures.
 *
 * Asserted here:
 *   h01 Dock         — the Inspector is present, 300–360px, and one tablist.
 *   h02 No overflow  — scrollWidth === clientWidth for the dock and its panel.
 *   h03 Heading      — contextual ("Page" with nothing selected), not "Properties ·".
 *   h04 Page block   — real Rotate/Duplicate/Delete, size readout with units.
 *   h05 Sections     — collapsible with aria-expanded, and the body is hidden.
 *   h06 Collapse     — clicking the header toggles aria-expanded and visibility.
 *   h07 Text kind    — heading "Text"; B and I present with aria-pressed.
 *   h08 No U/J       — no Underline, no Justify anywhere in the panel.
 *   h09 Italic       — pressing I flips aria-pressed and italicises the canvas.
 *   h10 Geometry     — X/Y/W/H present, labelled, and the aspect lock is a toggle.
 *   h11 Heights      — every control is 32–36px (H5).
 *   h12 Console      — no errors during the whole run.
 *
 * WHAT THIS PROBE CANNOT DO: it captures screenshots, but I cannot visually decode
 * them. Layout quality, spacing rhythm, colour and visual hierarchy still require
 * human review. Every check here is a measurement, not an aesthetic judgement.
 *
 * Usage: node scripts/editor-inspector-probe.mjs [--url http://localhost:3001]
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
// Browser binary. `CHROME_PATH` lets a non-Windows machine (or a Chrome for
// Testing download) point the probe at its own build; the literal default keeps
// the original Windows invocation working untouched.
const CHROME =
  process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), "pdfdadi-insp-"));
  const port = 9433;
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
    const res = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.result?.exceptionDetails) {
      return { __error: res.result.exceptionDetails.text ?? "evaluate threw" };
    }
    return res.result?.result?.value;
  };
  /** Hold the button ~110ms, as a real hand does — see the Phase G probe. */
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
  const shot = async (name) => {
    try {
      mkdirSync(SHOTS, { recursive: true });
      const res = await send("Page.captureScreenshot", { format: "png" });
      const data = res.result?.data;
      if (data) writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
    } catch {
      /* screenshots are evidence for humans, never a gate */
    }
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1600, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await send("Page.navigate", { url: `${BASE}/editor` });
  await sleep(3600);

  const failures = [];
  const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failures.push(name);
  };

  // Open a blank document so the canvas and panel have something to describe.
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /blank/i.test(x.textContent || ''));
    if (b) { b.click(); return 'clicked'; }
    return 'none';
  })()`);
  await sleep(1500);

  /**
   * Everything is scoped through the Inspector's tablist → its active tab's
   * `aria-controls`. TWO tabpanels exist in the DOM (the editor's and the
   * workspace's), so an unscoped `[role=tabpanel]` read is ambiguous.
   */
  const SCOPE = `(() => {
    const list = document.querySelector('[role="tablist"][aria-label="Inspector"]');
    if (!list) return null;
    const tab = [...list.querySelectorAll('[role="tab"]')].find((t) => t.getAttribute('aria-selected') === 'true');
    const panel = tab ? document.getElementById(tab.getAttribute('aria-controls')) : null;
    return { list, tab, panel, dock: list.closest('aside') || list.parentElement.parentElement };
  })()`;

  // ---- h01 dock ------------------------------------------------------------
  const dock = await evaluate(`(() => {
    const s = ${SCOPE};
    if (!s) return null;
    const r = s.dock.getBoundingClientRect();
    return {
      width: Math.round(r.width),
      tablists: document.querySelectorAll('[role="tablist"][aria-label="Inspector"]').length,
      tabs: [...s.list.querySelectorAll('[role="tab"]')].map((t) => ({
        label: (t.getAttribute('title') || t.textContent || '').trim(),
        selected: t.getAttribute('aria-selected') === 'true',
        tabIndex: t.tabIndex,
      })),
      panelPresent: Boolean(s.panel),
    };
  })()`);
  check("h01 inspector dock present", Boolean(dock && dock.panelPresent), JSON.stringify(dock?.tabs));
  check("h01 exactly one Inspector tablist", dock?.tablists === 1, `found ${dock?.tablists}`);
  check("h01 dock width 300-360px", dock?.width >= 300 && dock?.width <= 360, `${dock?.width}px`);
  check(
    "h01 roving tabindex (one 0, rest -1)",
    dock?.tabs?.filter((t) => t.tabIndex === 0).length === 1,
    JSON.stringify(dock?.tabs?.map((t) => t.tabIndex)),
  );

  // ---- h02 no horizontal overflow -----------------------------------------
  const overflow = async () =>
    evaluate(`(() => {
      const s = ${SCOPE};
      if (!s) return null;
      const worst = [];
      const walk = (el) => {
        if (el.scrollWidth > el.clientWidth + 1) {
          worst.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 60),
                       scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
        }
        for (const child of el.children) walk(child);
      };
      walk(s.panel);
      return {
        dockOverflow: s.dock.scrollWidth - s.dock.clientWidth,
        panelOverflow: s.panel.scrollWidth - s.panel.clientWidth,
        offenders: worst.slice(0, 5),
      };
    })()`);
  const o1 = await overflow();
  check("h02 dock has no horizontal overflow", (o1?.dockOverflow ?? 99) <= 1, `${o1?.dockOverflow}px`);
  check(
    "h02 panel has no horizontal overflow",
    (o1?.panelOverflow ?? 99) <= 1,
    `${o1?.panelOverflow}px, offenders=${JSON.stringify(o1?.offenders)}`,
  );

  // ---- h03/h04 no-selection heading + page block --------------------------
  const empty = await evaluate(`(() => {
    const s = ${SCOPE};
    if (!s) return null;
    const text = s.panel.innerText;
    return {
      heading: (s.panel.querySelector('h2')?.textContent || '').trim(),
      sections: [...s.panel.querySelectorAll('h3')].map((h) => h.textContent.trim()),
      buttons: [...s.panel.querySelectorAll('button')].map((b) => ({
        label: (b.textContent || '').trim(),
        title: b.getAttribute('title') || '',
        disabled: b.disabled,
      })).filter((b) => b.label),
      hasPt: /\\d+ × \\d+ pt/.test(text),
      text: text.slice(0, 400),
    };
  })()`);
  await shot("h01-no-selection");
  check("h03 heading is contextual 'Page'", empty?.heading === "Page", `got "${empty?.heading}"`);
  check(
    "h03 heading is not the redundant 'Properties ·' form",
    !/^Properties/.test(empty?.heading ?? ""),
    empty?.heading,
  );
  check("h04 page size readout carries units", empty?.hasPt === true, empty?.text?.slice(0, 120));
  for (const label of ["Rotate", "Duplicate", "Delete"]) {
    check(
      `h04 page action "${label}" present`,
      (empty?.buttons ?? []).some((b) => b.label.includes(label)),
      JSON.stringify(empty?.buttons?.map((b) => b.label)),
    );
  }
  check(
    "h04 Delete is disabled on a one-page document, with a reason",
    (empty?.buttons ?? []).some((b) => b.label.includes("Delete") && b.disabled && b.title.length > 10),
    JSON.stringify(empty?.buttons?.find((b) => b.label.includes("Delete"))),
  );
  check(
    "h04 a Document block reports the page count",
    (empty?.sections ?? []).includes("Document"),
    JSON.stringify(empty?.sections),
  );

  // ---- h05/h06 collapsible sections ---------------------------------------
  const sections = await evaluate(`(() => {
    const s = ${SCOPE};
    if (!s) return null;
    return [...s.panel.querySelectorAll('button[aria-expanded]')].map((b) => {
      const body = document.getElementById(b.getAttribute('aria-controls'));
      return {
        title: (b.textContent || '').trim(),
        expanded: b.getAttribute('aria-expanded') === 'true',
        bodyResolves: Boolean(body),
        bodyVisible: body ? body.getBoundingClientRect().height > 0 : null,
      };
    });
  })()`);
  check("h05 sections are collapsible via aria-expanded", (sections?.length ?? 0) >= 2, `${sections?.length} sections`);
  check(
    "h05 every aria-controls resolves to a real element",
    (sections ?? []).every((x) => x.bodyResolves),
    JSON.stringify(sections),
  );
  check(
    "h05 expanded sections have a visible body",
    (sections ?? []).filter((x) => x.expanded).every((x) => x.bodyVisible),
    JSON.stringify(sections),
  );

  /**
   * Click the first section header and confirm it really collapses.
   *
   * The click and the assertion MUST be in separate evaluations. React commits
   * state asynchronously, so reading `aria-expanded` in the same synchronous
   * callback that called `.click()` observes the PRE-CLICK DOM — measured: same
   * tick reported `expanded:"true" height:91`, a re-query 400ms later reported
   * `expanded:"false" height:0 hidden display:none` on identical markup. Asserting
   * in-tick made this probe report a working component as broken.
   */
  const toggleTarget = await evaluate(`(() => {
    const s = ${SCOPE};
    const b = s.panel.querySelector('button[aria-expanded="true"]');
    if (!b) return null;
    const bodyId = b.getAttribute('aria-controls');
    b.click();
    return { bodyId, title: (b.textContent || '').trim() };
  })()`);
  // Poll for the commit rather than trusting one fixed sleep.
  let collapsed = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(60);
    collapsed = await evaluate(`(() => {
      const s = ${SCOPE};
      const id = ${JSON.stringify(toggleTarget?.bodyId ?? "")};
      const btn = [...s.panel.querySelectorAll('button[aria-expanded]')]
        .find((b) => b.getAttribute('aria-controls') === id);
      const body = document.getElementById(id);
      if (!btn || !body) return { expanded: null, bodyHeight: null, hidden: null };
      return {
        expanded: btn.getAttribute('aria-expanded'),
        bodyHeight: Math.round(body.getBoundingClientRect().height),
        // The component's real contract: kept in the DOM (so aria-controls
        // resolves and field state survives) but hidden, hence zero-height.
        hidden: body.hasAttribute('hidden'),
        display: getComputedStyle(body).display,
      };
    })()`);
    if (collapsed?.expanded === "false") break;
  }
  check("h06 clicking a header collapses it", collapsed?.expanded === "false", JSON.stringify(collapsed));
  check(
    "h06 the collapsed body is not rendered visible",
    collapsed?.bodyHeight === 0 && collapsed?.hidden === true,
    JSON.stringify(collapsed),
  );
  await shot("h02-collapsed-section");
  // Re-open so later checks see a normal panel.
  await evaluate(`(() => {
    const s = ${SCOPE};
    const b = s.panel.querySelector('button[aria-expanded="false"]');
    if (b) b.click();
    return 'reopened';
  })()`);
  await sleep(200);

  // ---- h07..h11 text object ----------------------------------------------
  // `T` selects the text tool; click on the page places a run.
  const page = await evaluate(`(() => {
    const rects = [...document.querySelectorAll('main svg rect')]
      .map((r) => r.getBoundingClientRect())
      .filter((b) => b.width > 200 && b.height > 200)
      .sort((a, b) => b.width * b.height - a.width * a.height);
    if (!rects.length) return null;
    const b = rects[0];
    return { cx: Math.round(b.x + b.width / 2), cy: Math.round(b.y + b.height / 2) };
  })()`);
  if (page) {
    await key("t", "KeyT", 84);
    await sleep(250);
    await click(page.cx, page.cy);
    await sleep(500);
    // Leave any inline text editor so the Inspector describes the selection.
    await key("Escape", "Escape", 27);
    await sleep(450);
  }

  const textPanel = await evaluate(`(() => {
    const s = ${SCOPE};
    if (!s) return null;
    const text = s.panel.innerText;
    const pressed = [...s.panel.querySelectorAll('[aria-pressed]')].map((b) => ({
      label: (b.getAttribute('aria-label') || b.textContent || '').trim(),
      pressed: b.getAttribute('aria-pressed'),
      disabled: b.disabled === true,
      title: b.getAttribute('title') || '',
    }));
    const groups = [...s.panel.querySelectorAll('[role="group"]')].map((g) => g.getAttribute('aria-label'));
    /**
     * Accessible name, computed over the channels a browser actually uses —
     * NOT just aria-label/name. Verified against Chrome's own AXTree
     * (Accessibility.getPartialAXTree): the Font select, Size, Leading, Track,
     * Rotation and Opacity fields all take their name from an associated
     * <label> ("from=relatedElement"), so an aria-label-only check reported six
     * correctly-labelled controls as nameless. Adding duplicate aria-labels to
     * satisfy that would have been the wrong fix.
     */
    const accName = (el) => {
      const aria = (el.getAttribute('aria-label') || '').trim();
      if (aria) return { name: aria, from: 'aria-label' };
      const ids = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean);
      if (ids.length) {
        const t = ids.map((i) => (document.getElementById(i)?.innerText || '').trim()).join(' ').trim();
        if (t) return { name: t, from: 'aria-labelledby' };
      }
      // HTMLInputElement.labels covers both <label for> and a wrapping <label>.
      const labels = [...(el.labels || [])];
      for (const l of labels) {
        // Exclude the control's own text (e.g. <option> text inside a wrapping
        // <label>) so a <select> is not "named" by its own option list.
        const clone = l.cloneNode(true);
        for (const ctrl of clone.querySelectorAll('input, select, textarea, option')) ctrl.remove();
        const t = (clone.innerText || clone.textContent || '').trim();
        if (t) return { name: t, from: 'label' };
      }
      const title = (el.getAttribute('title') || '').trim();
      if (title) return { name: title, from: 'title' };
      return { name: '', from: 'none' };
    };
    const inputs = [...s.panel.querySelectorAll('input, select')].map((el) => {
      const n = accName(el);
      return {
        name: n.name,
        nameFrom: n.from,
        type: el.getAttribute('type') || el.tagName.toLowerCase(),
        height: Math.round(el.getBoundingClientRect().height),
        labelled: n.name.length > 0,
      };
    });
    return {
      heading: (s.panel.querySelector('h2')?.textContent || '').trim(),
      sections: [...s.panel.querySelectorAll('h3')].map((h) => h.textContent.trim()),
      pressed, groups, inputs,
      text,
    };
  })()`);
  await shot("h03-text-selected");

  check("h07 heading names the kind ('Text')", textPanel?.heading === "Text", `got "${textPanel?.heading}"`);
  check(
    "h07 Bold and Italic are toggles with aria-pressed",
    (textPanel?.pressed ?? []).some((b) => /bold/i.test(b.label)) &&
      (textPanel?.pressed ?? []).some((b) => /italic/i.test(b.label)),
    JSON.stringify(textPanel?.pressed?.map((b) => b.label)),
  );
  check(
    "h07 segmented groups carry accessible names",
    (textPanel?.groups ?? []).every((g) => typeof g === "string" && g.length > 0) &&
      (textPanel?.groups?.length ?? 0) >= 2,
    JSON.stringify(textPanel?.groups),
  );

  // ---- h08 no Underline, no Justify ---------------------------------------
  const banned = await evaluate(`(() => {
    const s = ${SCOPE};
    if (!s) return null;
    const labels = [...s.panel.querySelectorAll('button, [role="button"], option')]
      .map((el) => ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).trim());
    return {
      underline: labels.filter((l) => /underline/i.test(l)),
      justify: labels.filter((l) => /justify/i.test(l)),
    };
  })()`);
  check("h08 no Underline control is rendered", (banned?.underline?.length ?? 1) === 0, JSON.stringify(banned?.underline));
  check("h08 no Justify control is rendered", (banned?.justify?.length ?? 1) === 0, JSON.stringify(banned?.justify));

  // ---- h09 italic actually applies ---------------------------------------
  const italic = await evaluate(`(() => {
    const s = ${SCOPE};
    const btn = [...s.panel.querySelectorAll('[aria-pressed]')]
      .find((b) => /italic/i.test(b.getAttribute('aria-label') || b.textContent || ''));
    if (!btn) return { found: false };
    const before = btn.getAttribute('aria-pressed');
    const disabled = btn.disabled === true;
    if (!disabled) btn.click();
    return { found: true, before, disabled };
  })()`);
  await sleep(420);
  const italicAfter = await evaluate(`(() => {
    const s = ${SCOPE};
    const btn = [...s.panel.querySelectorAll('[aria-pressed]')]
      .find((b) => /italic/i.test(b.getAttribute('aria-label') || b.textContent || ''));
    const styles = [...document.querySelectorAll('main svg text')]
      .map((t) => t.getAttribute('font-style') || getComputedStyle(t).fontStyle);
    return { pressed: btn?.getAttribute('aria-pressed'), styles };
  })()`);
  check(
    "h09 pressing Italic flips aria-pressed",
    italic?.found === true && italic?.disabled === false && italicAfter?.pressed !== italic?.before,
    JSON.stringify({ ...italic, after: italicAfter?.pressed }),
  );
  check(
    "h09 the canvas renders the run as italic",
    (italicAfter?.styles ?? []).some((s) => s === "italic"),
    JSON.stringify(italicAfter?.styles?.slice(0, 4)),
  );
  await shot("h04-italic-applied");

  // ---- h10 geometry + aspect lock ----------------------------------------
  const geometry = await evaluate(`(() => {
    const s = ${SCOPE};
    if (!s) return null;
    const inputs = [...s.panel.querySelectorAll('input[type="number"], input[inputmode="decimal"], input')]
      .map((el) => ({ name: el.getAttribute('aria-label') || el.getAttribute('name') || '', value: el.value }))
      .filter((x) => x.name);
    const lock = [...s.panel.querySelectorAll('[aria-pressed]')]
      .find((b) => /aspect/i.test(b.getAttribute('aria-label') || ''));
    return {
      names: inputs.map((i) => i.name),
      lock: lock ? { label: lock.getAttribute('aria-label'), pressed: lock.getAttribute('aria-pressed') } : null,
    };
  })()`);
  /**
   * The accessible names carry their PDF unit — "X position (pt)", not
   * "X position" (H26: a bare coordinate box is ambiguous about pt vs px). The
   * earlier exact-equality check demanded the unit-less form and so failed on
   * four correct controls. Assert the semantic field identity AND require the
   * unit, which is strictly stronger than the original.
   */
  for (const field of ["X position", "Y position", "Width", "Height"]) {
    const match = (geometry?.names ?? []).find((n) => n === field || n.startsWith(`${field} (`));
    check(
      `h10 "${field}" is present, labelled, and carries its unit`,
      Boolean(match) && /\(pt\)$/.test(match ?? ""),
      JSON.stringify({ match, all: geometry?.names }),
    );
  }
  check("h10 aspect lock is a real toggle", Boolean(geometry?.lock), JSON.stringify(geometry?.lock));

  // ---- h11 control heights ------------------------------------------------
  /**
   * Two rules, because one generic assertion conflated two different controls.
   *
   * Ordinary boxed controls (number/select/text) owe the shared 32-36px height
   * (H5). A `type=range` does NOT render as a box: Chrome draws a thin track
   * centred in the element, so measuring it against the text-field height is a
   * category error. What a slider owes is a large enough POINTER TARGET — WCAG
   * 2.5.8 Target Size (Minimum), 24x24 CSS px — and the element box is the hit
   * region. So the slider is held to >=24px, and the colour swatch stays excluded
   * as before.
   */
  const boxed = (textPanel?.inputs ?? []).filter(
    (i) => i.type !== "color" && i.type !== "range" && i.height > 0,
  );
  const outOfRange = boxed.filter((i) => i.height < 30 || i.height > 38);
  check(
    "h11 boxed control heights are 32-36px (±2 for borders)",
    boxed.length > 0 && outOfRange.length === 0,
    `${boxed.length} controls, out of range: ${JSON.stringify(outOfRange)}`,
  );
  const sliders = (textPanel?.inputs ?? []).filter((i) => i.type === "range");
  check(
    "h11 slider hit targets meet WCAG 2.5.8 (>=24px)",
    sliders.every((i) => i.height >= 24),
    `${sliders.length} sliders: ${JSON.stringify(sliders.map((i) => i.height))}`,
  );
  check(
    "h11 every control input carries an accessible name",
    (textPanel?.inputs ?? []).every((i) => i.labelled),
    JSON.stringify(textPanel?.inputs?.filter((i) => !i.labelled)),
  );

  // Re-measure overflow now that the panel is at its fullest.
  const o2 = await overflow();
  check(
    "h02 no horizontal overflow with a text selection",
    (o2?.panelOverflow ?? 99) <= 1,
    `${o2?.panelOverflow}px, offenders=${JSON.stringify(o2?.offenders)}`,
  );

  // ---- h12 console --------------------------------------------------------
  check("h12 no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  console.log("");
  console.log(`Screenshots written to ${SHOTS} (h01–h04).`);
  console.log("NOTE: screenshots are evidence for a human. This probe measures");
  console.log("      geometry and semantics only; visual quality is NOT verified.");
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
