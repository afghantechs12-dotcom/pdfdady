/* global process, fetch, WebSocket, setTimeout, clearTimeout, Buffer */
/**
 * One Chrome-over-CDP client, shared by the Phase 6 UI probe and the ad-hoc
 * inspector beside it.
 *
 * Every probe in `scripts/` before this one inlined its own copy of the launch +
 * WebSocket + `Runtime.evaluate` dance, and the copies drifted: two of them
 * hardcoded a Windows Chrome path and were dead on this machine, and only some of
 * them collected console errors. This is deliberately NOT a refactor of those ten
 * scripts — rewriting working probes to rename their internals would risk the
 * evidence Phases 1-5 rest on. It is the one implementation the NEW tooling uses.
 *
 * What it adds over the inlined copies, because Phase 6 needs it:
 *
 *  - `errors()` separates **JS console errors** (a real defect) from **network
 *    entries** (a 401 from `/api/auth/me` is the documented signed-out answer, and
 *    counting it as a console error would make every page look broken).
 *  - `layout()` measures overflow, off-viewport elements and small touch targets
 *    in one round trip, so a viewport sweep is one evaluate per page.
 *  - `resize()` uses `Emulation.setDeviceMetricsOverride`, so a width change does
 *    not need a fresh browser and `@media` queries re-evaluate for real.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Measured in the page. Returns everything a responsive sweep asks about, so one
 * viewport costs one evaluate rather than six.
 *
 * `wide` deliberately ignores anything whose nearest clipping ancestor already
 * contains it: the homepage's decorative blur circles are 460px wide inside a
 * 360px `overflow-hidden` section, which is correct and must not read as a defect.
 * The thing that matters is whether the DOCUMENT scrolls sideways.
 */
export const LAYOUT_PROBE = `(() => {
  const vw = window.innerWidth;
  const de = document.documentElement;
  const clipped = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') return true;
    }
    return false;
  };
  const label = (el) =>
    (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '')
      .trim().replace(/\\s+/gu, ' ').slice(0, 48);
  const cls = (el) => {
    const c = el.className;
    return (c && c.baseVal !== undefined ? c.baseVal : c || '').toString().slice(0, 110);
  };
  const wide = [];
  const hscroll = [];
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
    if ((r.right > vw + 1 || r.left < -1) && !clipped(el)) {
      wide.push({ tag: el.tagName.toLowerCase(), cls: cls(el),
        left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) });
    }
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 &&
        (cs.overflowX === 'auto' || cs.overflowX === 'scroll')) {
      hscroll.push({ tag: el.tagName.toLowerCase(), cls: cls(el),
        scrollW: el.scrollWidth, clientW: el.clientWidth });
    }
  }
  /* Touch targets. sr-only skip links collapse to 1x1 until focused, which is
     correct, so anything smaller than 4px in both axes is excluded as hidden
     rather than reported as a 1px button. */
  const tiny = [];
  for (const el of document.querySelectorAll('a,button,[role="button"],input:not([type=hidden]),select,summary')) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 && r.height < 4) continue;
    if (r.width === 0 || r.height === 0) continue;
    if (r.height < 24 || r.width < 24) {
      tiny.push({ tag: el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height), label: label(el) });
    }
  }
  return {
    vw,
    scrollW: de.scrollWidth,
    pageH: Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0),
    overflow: de.scrollWidth > vw + 1,
    wide, hscroll, tiny,
  };
})()`;

/**
 * Launch a headless Chrome and attach to its first page target.
 *
 * `--force-device-scale-factor=1` matters: without it a Retina host reports CSS
 * pixels that are not the CSS pixels the viewport matrix names, and every width
 * assertion measures something the brief did not ask for.
 */
export async function openBrowser({ port = 9455, width = 1440, height = 900, insecure = false } = {}) {
  spawnSync("pkill", ["-f", `remote-debugging-port=${port}`], { stdio: "ignore" });
  await sleep(350);
  const userDataDir = mkdtempSync(join(tmpdir(), "pdfdadi-probe-"));
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
      "--force-device-scale-factor=1",
      `--window-size=${width},${height}`,
      ...(insecure ? ["--ignore-certificate-errors"] : []),
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let targets = null;
  for (let attempt = 0; attempt < 50 && !targets; attempt += 1) {
    await sleep(250);
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    } catch {
      targets = null;
    }
  }
  const target = (targets ?? []).find((t) => t.type === "page");
  if (!target) {
    chrome.kill();
    throw new Error(`Chrome never opened a debug page on ${port}`);
  }

  const sock = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    sock.addEventListener("open", resolve, { once: true });
    sock.addEventListener("error", reject, { once: true });
  });

  let id = 0;
  const pending = new Map();
  /** JS errors and `console.error` calls — a genuine defect signal. */
  const jsErrors = [];
  /** Non-2xx responses and blocked requests — reported separately on purpose. */
  const netErrors = [];

  sock.addEventListener("message", (event) => {
    const msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      jsErrors.push(String(msg.params?.exceptionDetails?.text ?? "exception").slice(0, 300));
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      const text = (msg.params.args ?? [])
        .map((a) => a.value ?? a.description ?? a.unserializableValue ?? "")
        .join(" ")
        .slice(0, 300);
      jsErrors.push(text || "console.error");
    }
    if (msg.method === "Log.entryAdded") {
      const e = msg.params?.entry ?? {};
      if (e.level !== "error") return;
      // Chrome files "Failed to load resource: 401" under source "network".
      if (e.source === "network" || e.networkRequestId) {
        netErrors.push(`${e.url ?? ""} ${String(e.text ?? "").slice(0, 160)}`.trim());
      } else {
        jsErrors.push(String(e.text ?? "").slice(0, 300));
      }
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      const timer = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), 60_000);
      pending.set(mid, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      sock.send(JSON.stringify({ id: mid, method, params }));
    });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("DOM.enable");
  await send("Log.enable");
  await send("Network.enable");
  // A headless CDP window is not the OS-focused window, so `:focus` matches
  // NOTHING and `el.focus()` changes no styles. The layout's
  // `sr-only focus:not-sr-only` skip link measured 1x1 with
  // `matches(':focus') === false` — indistinguishable from a skip link that was
  // never styled. With focus emulated it measures 138x40. Every focus-visible
  // assertion any probe makes is wrong without this.
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });

  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.result?.exceptionDetails) {
      return { __probeError: res.result.exceptionDetails.text ?? "evaluate failed" };
    }
    return res.result?.result?.value;
  };

  return {
    send,
    evaluate,
    /** Both error channels, and a reset so a scenario can measure only itself. */
    errors: () => ({ js: [...jsErrors], net: [...netErrors] }),
    clearErrors: () => {
      jsErrors.length = 0;
      netErrors.length = 0;
    },
    goto: async (base, path, wait = 1600) => {
      await send("Page.navigate", { url: path.startsWith("http") ? path : `${base}${path}` });
      await sleep(wait);
    },
    resize: async (w, h) => {
      await send("Emulation.setDeviceMetricsOverride", {
        width: w,
        height: h,
        deviceScaleFactor: 1,
        mobile: w < 768,
      });
      await sleep(420);
    },
    /** `prefers-reduced-motion: reduce`, for the motion scenario. */
    reduceMotion: (on) =>
      send("Emulation.setEmulatedMedia", {
        features: on ? [{ name: "prefers-reduced-motion", value: "reduce" }] : [],
      }),
    layout: () => evaluate(LAYOUT_PROBE),
    text: () => evaluate("document.body.innerText"),
    url: () => evaluate("location.href"),
    /** Tab N times from the document start and report where focus landed. */
    tabThrough: async (steps) => {
      await evaluate("document.body.focus()");
      const seen = [];
      for (let i = 0; i < steps; i += 1) {
        await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
        await sleep(45);
        seen.push(
          await evaluate(`(() => {
            const a = document.activeElement;
            if (!a || a === document.body) return null;
            const cs = getComputedStyle(a);
            const r = a.getBoundingClientRect();
            return {
              tag: a.tagName.toLowerCase(),
              name: (a.getAttribute('aria-label') || a.textContent || a.getAttribute('name') || '').trim().replace(/\\s+/gu,' ').slice(0, 48),
              outline: cs.outlineStyle + ' ' + cs.outlineWidth,
              shadow: cs.boxShadow.slice(0, 80),
              visible: r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight,
            };
          })()`),
        );
      }
      return seen;
    },
    key: async (key, code, extra = {}) => {
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, ...extra });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, ...extra });
      await sleep(160);
    },
    click: async (x, y) => {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0 });
      await sleep(300);
    },
    /**
     * Click the first visible element matching `selector` whose text or accessible
     * name matches `label`. Returns false when nothing matched, so a caller can
     * assert "the control was there" rather than silently doing nothing.
     */
    clickLabel: async function clickLabel(label, selector = "button, a, [role=button]") {
      const box = await evaluate(`(() => {
        const re = new RegExp(${JSON.stringify(label)}, "i");
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((n) => {
          const r = n.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          return re.test((n.textContent || '').trim()) || re.test(n.getAttribute('aria-label') || '');
        });
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (!box || box.__probeError) return false;
      await this.click(box.x, box.y);
      return true;
    },
    shot: async (outPath, { fullPage = false } = {}) => {
      const res = await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: fullPage,
      });
      const data = res.result?.data;
      if (!data) return false;
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, Buffer.from(data, "base64"));
      return true;
    },
    close: () => {
      try {
        sock.close();
      } catch {
        /* already gone */
      }
      chrome.kill();
    },
  };
}
