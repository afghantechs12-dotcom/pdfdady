/* global process */
/**
 * The four things every driving probe needs from a page, and nothing else.
 *
 * Extracted when the second consumer appeared (the visual acceptance harness and
 * the tool runtime matrix drive the same controls), so a fix to how a React input
 * is filled or how a file reaches a dropzone lands once.
 *
 * `fill` uses the prototype value setter and then dispatches `input`: assigning
 * `el.value` alone leaves React's state untouched, so the control re-renders back
 * to its old value and the form submits empty.
 */
import { resolve } from "node:path";
import { sleep } from "./probe-browser.mjs";

export const abs = (p) => (p.startsWith("/") ? p : resolve(process.cwd(), p));

export function makeDriver(b) {
  return {
    b,
    /** `fill("email", …)` targets `input[name=email]`; anything else is a selector. */
    fill: (name, value) =>
      b.evaluate(`(() => {
        const el = /^[\\w-]+$/.test(${JSON.stringify(name)})
          ? document.querySelector('input[name="${name}"]')
          : document.querySelector(${JSON.stringify(name)});
        if (!el) return "missing";
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : el.constructor;
        Object.getOwnPropertyDescriptor(proto.prototype, "value").set
          .call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return "ok";
      })()`),
    /** Clicks the first VISIBLE match: an offscreen duplicate is not the control. */
    clickText: (text, selector = "button, a") =>
      b.evaluate(`(() => {
        const all = [...document.querySelectorAll(${JSON.stringify(selector)})]
          .filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        const el = all.find((n) => n.textContent.trim() === ${JSON.stringify(text)}) ||
                   all.find((n) => n.textContent.trim().startsWith(${JSON.stringify(text)}));
        if (!el) return "missing";
        if (el.disabled) return "disabled";
        el.click();
        return "ok";
      })()`),
    /** A real upload through the real input, so the app's own validation runs. */
    async attach(paths, selector = 'input[type="file"]', settle = 1600) {
      const doc = await b.send("DOM.getDocument", { depth: -1 });
      const q = await b.send("DOM.querySelector", { nodeId: doc.result?.root?.nodeId, selector });
      if (!q.result?.nodeId) return false;
      await b.send("DOM.setFileInputFiles", { nodeId: q.result.nodeId, files: paths.map(abs) });
      await sleep(settle);
      return true;
    },
    /** Poll a predicate in the page. Returns the truthy value, or null. */
    async until(expression, { tries = 30, every = 400 } = {}) {
      for (let i = 0; i < tries; i += 1) {
        const v = await b.evaluate(expression);
        if (v && !v.__probeError) return v;
        await sleep(every);
      }
      return null;
    },
  };
}

/**
 * A brand-new account, through the real registration form.
 *
 * Every probe that needs an authenticated session creates its own throwaway user
 * rather than sharing one: a run then cannot be contaminated by what a previous run
 * left behind, and nothing in these scripts ever holds a real person's credentials.
 * Returns the email on success and null if the form did not take the session to
 * `/workspaces`.
 */
export async function signUpFresh(d, base, { password, name = "Probe Reviewer", prefix = "probe" }) {
  const email = `${prefix}.${Date.now()}@example.test`;
  await d.b.goto(base, "/register", 3000);
  for (const [field, value] of [
    ["name", name],
    ["email", email],
    ["password", password],
    ["confirmPassword", password],
  ]) {
    if ((await d.fill(field, value)) !== "ok") return null;
  }
  await d.b.evaluate(`document.querySelector('input[name="acceptedTerms"]')?.click()`);
  await d.clickText("Create account", "button");
  await sleep(6500);
  return /\/workspaces/.test((await d.b.url()) ?? "") ? email : null;
}

/** A Workspace through the real dialog. Returns its id, or null. */
export async function createWorkspace(d, base, name) {
  await d.b.goto(base, "/workspaces", 2600);
  if ((await d.clickText("Create Workspace", "button")) !== "ok") return null;
  await sleep(800);
  if ((await d.fill('[role="dialog"] input', name)) !== "ok") return null;
  await d.clickText("Create", "button");
  await sleep(6000);
  return /\/workspaces\/([^/?#]+)/.exec((await d.b.url()) ?? "")?.[1] ?? null;
}

/**
 * How a finished result is captured, and why it cannot be done by finding a link.
 *
 * `lib/utils/download.ts` is the only path a result takes to disk in this product:
 * an object URL, a synthetic `<a download>`, `.click()`, revoke. No result surface
 * contains a download anchor to query — an earlier probe looked for one and
 * recorded "no download control" against 28 working tools. So the browser's own two
 * primitives are wrapped at document start: every Blob URL is remembered, and a
 * programmatic click on a `download` anchor is intercepted before the browser can
 * open a save dialog the probe cannot answer.
 */
export const DOWNLOAD_HOOK = `(() => {
  const mint = URL.createObjectURL.bind(URL);
  const urls = new Map();
  window.__probeDownloads = [];
  URL.createObjectURL = (obj) => {
    const url = mint(obj);
    try { if (obj instanceof Blob) urls.set(url, obj); } catch {}
    return url;
  };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.hasAttribute("download")) {
      const blob = urls.get(this.href);
      if (blob) { window.__probeDownloads.push({ name: this.download || null, blob }); return; }
    }
    return click.apply(this, arguments);
  };
})()`;

/**
 * Presses the product's own Download control and reads the bytes it produced.
 * Answers `{ error }` rather than throwing, so a caller can record the reason.
 */
export async function takeDownload(d) {
  await d.b.evaluate(`window.__probeDownloads = []`);
  const clicked = await d.clickText("Download");
  if (clicked !== "ok") return { error: `the Download control was ${clicked}` };
  const got = await d.until(`window.__probeDownloads.length ? "yes" : null`, { tries: 20, every: 250 });
  if (got !== "yes") return { error: "pressing Download produced no file" };
  return d.b.evaluate(`(async () => {
    const last = window.__probeDownloads[window.__probeDownloads.length - 1];
    const buf = await last.blob.arrayBuffer();
    const head = [...new Uint8Array(buf.slice(0, 4))]
      .map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : "."))
      .join("");
    return { bytes: buf.byteLength, head, name: last.name, type: last.blob.type || null };
  })()`);
}
