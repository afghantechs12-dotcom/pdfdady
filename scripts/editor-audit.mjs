/* global process, console, fetch, WebSocket, setTimeout */
/**
 * Editor layout audit — structural ground truth for the premium redesign.
 *
 * Screenshots answer "does this look right" for a human reviewer. This answers
 * the questions a reviewer cannot eyeball reliably and an agent cannot eyeball
 * at all: how many pixels the canvas actually gets, whether the toolbar renders
 * labels or bare icons, which regions are docked at a given width, computed
 * colors/radii/shadows of the key surfaces, and whether anything overflows.
 *
 * Usage: node scripts/editor-audit.mjs [--url http://localhost:3001] [--path /editor]
 *        [--widths 1920,1600,1440,1366,1280,1024,768,390]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const BASE = arg("--url", "http://localhost:3001");
const PATH = arg("--path", "/editor");
const WIDTHS = arg("--widths", "1920,1600,1440,1366,1280,1024,768,390")
  .split(",")
  .map((w) => Number(w.trim()))
  .filter(Boolean);
const OUT = arg("--out", "");
// Browser binary. `CHROME_PATH` lets a non-Windows machine (or a Chrome for
// Testing download) point the probe at its own build; the literal default keeps
// the original Windows invocation working untouched.
const CHROME =
  process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const HEIGHTS = { 1920: 1080, 1600: 900, 1440: 900, 1366: 768, 1280: 720, 1024: 768, 768: 1024, 390: 844 };

/** Runs in the page: measures the real editor layout. */
const PROBE = `(() => {
  const px = (n) => Math.round(n);
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: px(r.x), y: px(r.y), w: px(r.width), h: px(r.height) };
  };
  const style = (el, props) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const out = {};
    for (const p of props) out[p] = cs.getPropertyValue(p);
    return out;
  };

  // The editor frame root: the element that owns the shell.
  const frame =
    document.querySelector('[data-editor-frame]') ||
    document.querySelector('main')?.closest('div.flex.h-full') ||
    document.body;

  const toolbar = document.querySelector('[role="toolbar"]');
  const toolbarRoot = toolbar?.closest('div') ?? toolbar;
  const canvasMain = document.querySelector('main');

  // Tool buttons: does each render a visible text label, or icon only?
  const toolButtons = [...(toolbar?.querySelectorAll('button') ?? [])].map((b) => {
    const label = (b.textContent || '').trim();
    const r = b.getBoundingClientRect();
    return {
      name: b.getAttribute('aria-label') || label || b.title || '(unnamed)',
      text: label,
      hasVisibleLabel: label.length > 0,
      pressed: b.getAttribute('aria-pressed'),
      disabled: b.disabled || b.getAttribute('aria-disabled') === 'true',
      w: px(r.width),
      h: px(r.height),
    };
  });

  // Every landmark/region we can identify by role or aria-label.
  const regions = [...document.querySelectorAll('aside,[role="region"],[role="tablist"],[role="dialog"]')]
    .map((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return null;
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        name: el.getAttribute('aria-label') || el.querySelector('h1,h2,h3,h4')?.textContent?.trim() || '',
        box: { x: px(r.x), y: px(r.y), w: px(r.width), h: px(r.height) },
      };
    })
    .filter(Boolean);

  // Overflow: page-level scroll and any element wider than the viewport.
  const de = document.documentElement;
  const wide = [...document.querySelectorAll('*')]
    .filter((el) => el.getBoundingClientRect().width > window.innerWidth + 1)
    .slice(0, 8)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 90),
      w: px(el.getBoundingClientRect().width),
    }));
  const xScrollers = [...document.querySelectorAll('*')]
    .filter((el) => el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 40)
    .filter((el) => ['auto', 'scroll'].includes(getComputedStyle(el).overflowX))
    .slice(0, 8)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 90),
      scrollW: px(el.scrollWidth),
      clientW: px(el.clientWidth),
    }));

  // The rendered PDF page surface, if a document is open.
  const pageSurface = document.querySelector('[data-page-surface], canvas');

  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    pageScrollWidth: px(de.scrollWidth),
    horizontalOverflow: de.scrollWidth > window.innerWidth + 1,
    frame: box(frame),
    toolbar: {
      box: box(toolbarRoot),
      buttonCount: toolButtons.length,
      labelled: toolButtons.filter((b) => b.hasVisibleLabel).length,
      iconOnly: toolButtons.filter((b) => !b.hasVisibleLabel).length,
      buttons: toolButtons,
      styles: style(toolbarRoot, ['background-color', 'border-bottom-color', 'box-shadow', 'padding']),
    },
    canvas: {
      box: box(canvasMain),
      styles: style(canvasMain, ['background-color']),
      pageSurface: box(pageSurface),
      pageStyles: style(pageSurface, ['background-color', 'box-shadow', 'border-radius']),
    },
    regions,
    overflow: { wide, xScrollers },
    text: {
      // Everything the shell says, for a quick read of the chrome content.
      headings: [...document.querySelectorAll('h1,h2,h3')].map((h) => h.textContent.trim()).slice(0, 12),
      buttons: [...document.querySelectorAll('button')]
        .map((b) => (b.textContent || '').trim() || b.getAttribute('aria-label') || '')
        .filter(Boolean)
        .slice(0, 60),
    },
  };
})()`;

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), "pdfdadi-audit-"));
  const port = 9412;
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
  await new Promise((r) => setTimeout(r, 2200));

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  const sock = new WebSocket(page.webSocketDebuggerUrl);
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
      consoleErrors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
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

  await send("Page.enable");
  await send("Runtime.enable");

  const results = {};
  for (const w of WIDTHS) {
    const h = HEIGHTS[w] ?? 900;
    consoleErrors.length = 0;
    await send("Emulation.setDeviceMetricsOverride", {
      width: w,
      height: h,
      deviceScaleFactor: 1,
      mobile: w < 500,
    });
    await send("Page.navigate", { url: `${BASE}${PATH}` });
    await new Promise((r) => setTimeout(r, 2600));
    const res = await send("Runtime.evaluate", {
      expression: PROBE,
      returnByValue: true,
      awaitPromise: false,
    });
    const value = res.result?.result?.value;
    results[`${w}x${h}`] = value
      ? { ...value, consoleErrors: [...consoleErrors] }
      : { error: res.result?.result?.description ?? "probe failed", consoleErrors: [...consoleErrors] };

    const r = results[`${w}x${h}`];
    if (r.error) {
      console.log(`${w}x${h}: PROBE ERROR ${r.error}`);
    } else {
      const c = r.canvas.box;
      const t = r.toolbar;
      const canvasPct = c && r.frame ? Math.round((c.w / r.frame.w) * 100) : 0;
      console.log(
        `${String(w).padStart(4)}x${h}: canvas ${c ? `${c.w}x${c.h}` : "none"} (${canvasPct}% width) | ` +
          `toolbar ${t.buttonCount} btns ${t.labelled} labelled/${t.iconOnly} icon-only | ` +
          `regions ${r.regions.length} | overflow ${r.horizontalOverflow ? "YES" : "no"} | ` +
          `errors ${r.consoleErrors.length}`,
      );
      for (const reg of r.regions) {
        console.log(`        region: ${reg.tag}${reg.role ? `[${reg.role}]` : ""} "${reg.name}" ${reg.box.w}x${reg.box.h}`);
      }
      if (r.overflow.wide.length) console.log(`        WIDE: ${JSON.stringify(r.overflow.wide)}`);
      if (r.overflow.xScrollers.length) console.log(`        X-SCROLL: ${JSON.stringify(r.overflow.xScrollers)}`);
      if (r.consoleErrors.length) console.log(`        ERR: ${r.consoleErrors.slice(0, 3).join(" | ")}`);
    }
  }

  if (OUT) {
    writeFileSync(OUT, JSON.stringify(results, null, 2));
    console.log(`\nwrote ${OUT}`);
  }

  sock.close();
  chrome.kill();
  try {
    rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    /* the profile dir is Chrome's; a locked file here is not a failure */
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
