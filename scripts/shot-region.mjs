/* global process, console, fetch, WebSocket, setTimeout, Buffer */
/**
 * Ad-hoc region capture, for looking closely at one band of a page.
 *
 * `responsive-qa.mjs --shots` writes a whole 6000px page as one PNG, which is
 * the right artefact for "does the composition match the design" and the wrong
 * one for "is that badge clipped". This crops.
 *
 * Usage: node scripts/shot-region.mjs <width> <y> <height> <out.png> [path]
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const [, , wArg, yArg, hArg, out, rawPath = "/"] = process.argv;
const W = Number(wArg);
const Y = Number(yArg);
const H = Number(hArg);

// Git Bash rewrites a bare "/" argument into a Windows path, so a naive
// `BASE + pathArg` silently navigates nowhere and every capture comes back
// blank. Recover the intended route the same way responsive-qa.mjs does.
const PATH = (() => {
  const trimmed = rawPath.trim();
  if (trimmed === "" || trimmed === "home") return "/";
  const m = trimmed.match(/^[A-Za-z]:[\\/].*?Git[\\/]?(.*)$/);
  if (m) return `/${m[1]}`;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
})();

const BASE = process.env.QA_URL || "http://localhost:3001";
// Browser binary. `CHROME_PATH` lets a non-Windows machine (or a Chrome for
// Testing download) point the probe at its own build; the literal default keeps
// the original Windows invocation working untouched.
const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), "pdfdadi-shot-"));
  const port = 9334;
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
  sock.addEventListener("message", (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
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
  // Size the viewport to the region and scroll to it. `clip` regions come back
  // blank in this Chrome build, and so does any capture taken after
  // `Emulation.setEmulatedMedia` — hence neither is used here.
  await send("Emulation.setDeviceMetricsOverride", {
    width: W,
    height: H,
    deviceScaleFactor: 1,
    mobile: W < 768,
  });
  await send("Page.navigate", { url: BASE + PATH });
  await new Promise((r) => setTimeout(r, 2500));
  await send("Runtime.evaluate", { expression: `window.scrollTo(0, ${Y})` });
  await new Promise((r) => setTimeout(r, 800));

  const probe = await send("Runtime.evaluate", {
    expression:
      "JSON.stringify({url:location.href,y:Math.round(scrollY),h:document.documentElement.scrollHeight})",
    returnByValue: true,
  });
  console.log("page:", probe.result?.result?.value);

  const cap = await send("Page.captureScreenshot", { format: "png" });
  const data = cap.result?.data;
  if (!data) throw new Error(`capture failed: ${JSON.stringify(cap).slice(0, 300)}`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`wrote ${out} (${W}x${H} at y=${Y})`);

  sock.close();
  chrome.kill();
  try {
    rmSync(userDataDir, { recursive: true, force: true });
  } catch {}
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
