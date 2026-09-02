/* global process, console, fetch, WebSocket, setTimeout, Buffer */
/**
 * Responsive visual QA harness.
 *
 * Drives the locally-installed Chrome over the DevTools Protocol and measures
 * the REAL rendered layout at each target viewport. Deliberately not a project
 * dependency: this is launch verification tooling, run on demand, and adding
 * Playwright to package.json for it would ship a browser download to everyone
 * who clones the repo.
 *
 * Reports, per page per width:
 *   - horizontal overflow (documentElement.scrollWidth > innerWidth)
 *   - any element wider than the viewport (the usual culprit)
 *   - elements with horizontal scrollbars (e.g. the properties inspector)
 *   - console errors and failed requests
 *
 * With --shots it also writes a FULL-PAGE PNG per page per width. Measurements
 * alone cannot answer "does this look like the design" — a section can have zero
 * overflow and still be visually wrong — so a visual pass needs the image, and
 * `captureBeyondViewport` gets the whole scroll height rather than the fold.
 *
 * Usage: node scripts/responsive-qa.mjs [--url http://localhost:3001] [--shots]
 *        QA_PAGES=home QA_SHOT_DIR=qa-screenshots node scripts/responsive-qa.mjs --shots
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv.includes("--url")
  ? process.argv[process.argv.indexOf("--url") + 1]
  : "http://localhost:3001";

const CHROME =
  "C:/Program Files/Google/Chrome/Application/chrome.exe";

/** Full-page PNGs are opt-in: the default run is a fast measurement sweep. */
const SHOTS = process.argv.includes("--shots") || process.env.QA_SHOTS === "1";
const SHOT_DIR = process.env.QA_SHOT_DIR || "qa-screenshots";

const VIEWPORTS = [
  { w: 360, h: 800, label: "360x800 phone" },
  { w: 390, h: 844, label: "390x844 phone" },
  { w: 768, h: 1024, label: "768x1024 tablet" },
  { w: 1024, h: 768, label: "1024x768 small laptop" },
  { w: 1280, h: 720, label: "1280x720 laptop" },
  { w: 1366, h: 768, label: "1366x768 laptop" },
  { w: 1440, h: 900, label: "1440x900 laptop" },
  { w: 1600, h: 900, label: "1600x900 laptop" },
  { w: 1920, h: 1080, label: "1920x1080 desktop" },
];

// Paths come in as a comma-separated list. Git Bash rewrites a bare "/" into a
// Windows path, so "home" is accepted as an alias for the site root.
const PAGES = (process.env.QA_PAGES
  ? process.env.QA_PAGES.split(",")
  : ["home", "/tools", "/pricing", "/blog", "/editor", "/login", "/signup"]
).map((p) => {
  const trimmed = p.trim();
  if (trimmed === "home" || trimmed === "") return "/";
  // Recover from MSYS path conversion (e.g. "C:/Program Files/Git/tools").
  const m = trimmed.match(/^[A-Za-z]:[\\/].*?Git[\\/](.*)$/);
  if (m) return `/${m[1]}`;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
});

/** `/` → "home", `/blog/x` → "blog-x", so a path is a safe filename stem. */
function shotName(path, vp) {
  const stem = path === "/" ? "home" : path.replace(/^\/+|\/+$/gu, "").replace(/\//gu, "-");
  return `${stem}-${vp.w}x${vp.h}.png`;
}

/** Runs in the page: reports overflow and its causes. */
const PROBE = `(() => {
  const vw = window.innerWidth;
  const de = document.documentElement;
  const wide = [];
  const hscroll = [];
  const all = document.querySelectorAll('*');
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    // Wider than the viewport, or sticking out past its right edge.
    if (r.right > vw + 1 || r.left < -1) {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' && cs.visibility === 'hidden') continue;
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (parseFloat(cs.opacity) === 0) continue;
      wide.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').toString().slice(0, 90),
        left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width),
      });
    }
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
      const cs = getComputedStyle(el);
      if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') {
        hscroll.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').toString().slice(0, 90),
          scrollW: el.scrollWidth, clientW: el.clientWidth,
        });
      }
    }
  }
  // Touch targets that are interactive but very small.
  const tiny = [];
  for (const el of document.querySelectorAll('a,button,[role="button"],input,select')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.height < 24 || r.width < 24) {
      tiny.push({ tag: el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height),
        label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40) });
    }
  }
  // Total document height, so a density pass can be checked against a number
  // rather than an impression.
  const pageH = Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0);
  return JSON.stringify({
    vw, scrollW: de.scrollWidth, pageH, overflow: de.scrollWidth > vw + 1,
    wide: wide.slice(0, 8), hscroll: hscroll.slice(0, 8), tiny: tiny.slice(0, 6),
  });
})()`;

async function main() {
  if (SHOTS) mkdirSync(SHOT_DIR, { recursive: true });
  const userDataDir = mkdtempSync(join(tmpdir(), "pdfdadi-qa-"));
  const port = 9333;
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

  await new Promise((r) => setTimeout(r, 2500));

  const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await listRes.json();
  const page = targets.find((t) => t.type === "page");

  // Node 24 ships a global WebSocket, so this harness needs no dependency at
  // all — which is the point: it must not add weight to the project.
  const sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    sock.addEventListener("open", resolve, { once: true });
    sock.addEventListener("error", reject, { once: true });
  });

  let id = 0;
  const pending = new Map();
  const events = [];
  sock.addEventListener("message", (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      events.push(msg);
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
  await send("Log.enable");
  await send("Network.enable");

  const report = [];
  for (const path of PAGES) {
    for (const vp of VIEWPORTS) {
      await send("Emulation.setDeviceMetricsOverride", {
        width: vp.w,
        height: vp.h,
        deviceScaleFactor: 1,
        mobile: vp.w < 768,
      });
      events.length = 0;
      await send("Page.navigate", { url: BASE + path });
      // Wait for load + a beat for client hydration.
      await new Promise((r) => setTimeout(r, path === "/editor" ? 3500 : 1800));

      const res = await send("Runtime.evaluate", {
        expression: PROBE,
        returnByValue: true,
        awaitPromise: false,
      });
      let probe;
      try {
        probe = JSON.parse(res.result?.result?.value ?? "null");
      } catch {
        probe = null;
      }

      let shot = null;
      if (SHOTS) {
        // Reduced motion + a scroll to the top so every capture is the same
        // frame of any idle animation, and so `Reveal` sections are settled.
        await send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-reduced-motion", value: "reduce" }],
        });
        await send("Runtime.evaluate", { expression: "window.scrollTo(0, 0)" });
        await new Promise((r) => setTimeout(r, 350));
        const cap = await send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: true,
          fromSurface: true,
        });
        const data = cap?.result?.data;
        if (data) {
          shot = join(SHOT_DIR, shotName(path, vp));
          writeFileSync(shot, Buffer.from(data, "base64"));
        }
      }

      const consoleErrors = events
        .filter(
          (e) =>
            e.method === "Log.entryAdded" && e.params?.entry?.level === "error",
        )
        .map((e) => e.params.entry.text.slice(0, 160));
      const failed = events
        .filter((e) => e.method === "Network.loadingFailed")
        .map((e) => e.params.errorText)
        .filter((t) => !/ERR_ABORTED/.test(t));

      report.push({ path, viewport: vp.label, probe, consoleErrors, failed, shot });
      const flag = probe?.overflow ? "OVERFLOW" : "ok";
      console.log(
        `${path.padEnd(10)} ${vp.label.padEnd(22)} ${flag.padEnd(9)} scrollW=${probe?.scrollW ?? "?"} pageH=${probe?.pageH ?? "?"} wide=${probe?.wide?.length ?? "?"} hscroll=${probe?.hscroll?.length ?? "?"} errs=${consoleErrors.length}${shot ? ` → ${shot}` : ""}`,
      );
      if (probe?.overflow && probe.wide?.length) {
        for (const w of probe.wide.slice(0, 3)) {
          console.log(`      ↳ <${w.tag}> ${w.left}..${w.right} (w=${w.w}) ${w.cls}`);
        }
      }
      for (const h of probe?.hscroll ?? []) {
        console.log(`      ↳ h-scroll <${h.tag}> ${h.scrollW}>${h.clientW} ${h.cls}`);
      }
      for (const e of consoleErrors.slice(0, 3)) console.log(`      ! ${e}`);
    }
  }

  writeFileSync("responsive-qa-report.json", JSON.stringify(report, null, 2));
  console.log("\nWrote responsive-qa-report.json");

  sock.close();
  chrome.kill();
  try {
    rmSync(userDataDir, { recursive: true, force: true });
  } catch {}
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
