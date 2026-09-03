/* global process, console, fetch */
/**
 * ENTRY GATE B — the visual acceptance harness.
 *
 * Phase 6 measured structure and geometry: one `main`, no horizontal scroll, 24px
 * targets, contrast ratios. It says so itself — "a change that keeps the structure
 * and ruins the appearance is caught by no gate". This is that gate. It captures
 * the 17 named surfaces at the nine audit viewports, builds the contact sheets a
 * human reviews, and compares against a committed-by-reference baseline set so a
 * later change that moves pixels has to be looked at.
 *
 * WHAT IT CANNOT DO, and does not pretend to: approve the appearance. A machine can
 * prove that the pixels did not move since a baseline. Only a person can say the
 * baseline looked right. With no recorded human approval this run reports
 * VISUAL ACCEPTANCE PENDING and the audit carries that forward — self-generated
 * screenshots are never converted into acceptance here.
 *
 * ## Determinism
 *
 * Three things make two runs of one build byte-comparable, and all three are needed:
 *
 *  1. **Motion is finished, not removed.** Every animation gets `duration: 1ms`,
 *     `delay: 0s` AND `iteration-count: 1`. Removing animation with `none` would be
 *     wrong: `animate-fade-up` starts at `opacity: 0`, so a screenshot of an
 *     un-animated element is a screenshot of an invisible one — a false defect.
 *     Finishing it instead lands on the final keyframe. The same rule stops the
 *     infinite ones (`animate-float-*`, `glow-pulse`, `gradient-drift`, `pulse`,
 *     `spin`) mid-cycle at a fixed point rather than wherever the frame clock was.
 *  2. **Fonts are loaded.** `await document.fonts.ready` before every capture.
 *     Inter is self-hosted by `next/font`, so this settles without a network.
 *  3. **Clock and locale are pinned** to UTC/en-US, so a rendered date is the same
 *     string on both runs. What remains genuinely dynamic — a relative timestamp, a
 *     generated email, a job id — is MASKED by selector, per surface, and the mask
 *     list is in the manifest so a reviewer can see exactly what was excused.
 *
 * ## Viewport shots, and full-page shots
 *
 * The comparison runs on VIEWPORT captures. `captureBeyondViewport` re-lays the page
 * out at its full scroll height, which moves every `min-h-screen` section, so a
 * full-page image is evidence about composition but not a stable baseline. Both are
 * written: nine viewport PNGs per surface, plus one full-page PNG at 390 and 1440
 * for the below-the-fold review the criteria list asks for.
 *
 * ## Usage
 *
 *   node scripts/visual-acceptance-probe.mjs --url https://<lan-ip>:3001 --auth
 *   node scripts/visual-acceptance-probe.mjs --url ... --auth --baseline   # record
 *   node scripts/visual-acceptance-probe.mjs --url ... --only homepage,pricing
 *
 * `--auth` MUTATES DATA: one throwaway account per run, two Workspaces, one
 * uploaded fixture. Without it, the nine authenticated surfaces report
 * NOT EXERCISED by name rather than being skipped silently.
 *
 * Output: `docs/screenshots/final-prelaunch/` (gitignored, like every other phase's
 * screenshots), `--baseline` into `.../baseline/`. The committed artifacts are the
 * manifest, the contact sheets and the write-up under
 * `docs/evidence/final-prelaunch/visual/`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openBrowser, sleep } from "./lib/probe-browser.mjs";
import { decodePng, diffPixels } from "./lib/png-diff.mjs";
import { createWorkspace, makeDriver, signUpFresh } from "./lib/probe-drive.mjs";

const arg = (flag, fallback = null) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const has = (flag) => process.argv.includes(flag);

const BASE = arg("--url", "http://localhost:3001");
const SECURE_FRONT = BASE.startsWith("https:");
if (SECURE_FRONT) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const OUT = arg("--out", "docs/screenshots/final-prelaunch");
const RECORD_BASELINE = has("--baseline");
const BASELINE_DIR = arg("--baseline-dir", join(OUT, "baseline"));
const SHOT_DIR = RECORD_BASELINE ? BASELINE_DIR : join(OUT, "current");
const WITH_AUTH = has("--auth");
const ONLY = (arg("--only", "") || "").split(",").filter(Boolean);
const PASSWORD = "GateB-Probe-Password!";
/*
 * `--cookie name=value`, for a surface that can only be reached on a server this
 * probe cannot register against. `19-app-error` runs against a deployment whose
 * database cannot be opened, so signing up is impossible — but the boundary it
 * documents is what a SIGNED-IN user meets, and the session lookup that throws is
 * the one the cookie triggers. The token does not have to resolve; it has to be
 * looked up.
 */
const COOKIE = arg("--cookie", "");
const FIXTURE = "docs/qa/p1/multipage-fixture.pdf";

/** The brief's nine audit viewports. */
const VIEWPORTS = [
  [320, 800], [360, 800], [390, 844], [412, 915],
  [768, 1024], [1024, 768], [1280, 800], [1440, 900], [1920, 1080],
];
/** Where a full-page companion shot is taken: one narrow, one wide. */
const FULLPAGE_AT = new Set(["390x844", "1440x900"]);
const deviceClass = (w) => (w <= 412 ? "mobile" : w <= 1024 ? "tablet" : "desktop");

/**
 * Finished motion, still caret, no smooth scroll. See the docstring: `1ms` plus
 * `iteration-count: 1` rather than `none`, because `none` freezes a fade-in at
 * opacity 0.
 */
const STILL_CSS = `*,*::before,*::after{
  animation-delay:0s!important;animation-duration:1ms!important;
  animation-iteration-count:1!important;
  transition-delay:0s!important;transition-duration:1ms!important;
}
html{scroll-behavior:auto!important}
*{caret-color:transparent!important}`;

const VERDICTS = ["PASS", "PRODUCT FAILURE", "ENVIRONMENTAL", "NOT EXERCISED", "MANUAL REVIEW REQUIRED"];
const results = [];
const shots = [];
const record = (surface, id, verdict, detail = "") => {
  if (!VERDICTS.includes(verdict)) throw new Error(`bad verdict ${verdict}`);
  results.push({ surface, id, verdict, detail: String(detail).slice(0, 240) });
};

/* ───────────────────────────── capture mechanics ──────────────────────────── */

/** Fonts settled, scrolled home, motion finished. Every capture goes through it. */
async function settle(b, extra = 0) {
  await b.evaluate(`(async () => {
    try { await document.fonts.ready; } catch {}
    window.scrollTo(0, 0);
    return document.fonts.status;
  })()`);
  await sleep(360 + extra);
}

/** Mask rectangles in VIEWPORT coordinates, which is what a viewport shot is in. */
async function maskRects(b, selectors) {
  if (selectors.length === 0) return [];
  const rects = await b.evaluate(`(() => {
    const out = [];
    for (const sel of ${JSON.stringify(selectors)}) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        out.push({
          x: Math.max(0, Math.floor(r.left) - 2), y: Math.max(0, Math.floor(r.top) - 2),
          w: Math.ceil(r.width) + 4, h: Math.ceil(r.height) + 4, sel,
        });
      }
    }
    return out;
  })()`);
  return Array.isArray(rects) ? rects : [];
}

const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);

/**
 * One surface across the nine viewports.
 *
 * The surface is reached ONCE and then resized, deliberately: a resize re-evaluates
 * `@media` for real without a reload, so a driven state — a result panel, an open
 * dialog — survives the sweep. Re-reaching per viewport would cost nine job runs and
 * nine chances for the state to come out different.
 */
async function sweep(b, surface) {
  const dir = join(SHOT_DIR, surface.id);
  const viewports = surface.viewports ?? VIEWPORTS;
  for (const [w, h] of viewports) {
    await b.resize(w, h);
    await settle(b, surface.settle ?? 0);
    const key = `${w}x${h}`;
    const file = join(dir, `${key}.png`);
    if (!(await b.shot(file, { fullPage: false }))) {
      record(surface.id, `${surface.id} ${key}`, "ENVIRONMENTAL", "Chrome returned no screenshot data");
      continue;
    }
    const masks = await maskRects(b, surface.masks ?? []);
    const page = await b.evaluate(
      `({ scrollH: document.documentElement.scrollHeight, chars: document.body.innerText.trim().length })`,
    );
    let img;
    try {
      img = decodePng(readFileSync(file));
    } catch (err) {
      record(surface.id, `${surface.id} ${key}`, "ENVIRONMENTAL", `undecodable PNG: ${err.message}`);
      continue;
    }
    /*
     * The anti-vacuity floor. A blank page, a hydration crash and a 500 all
     * screenshot cleanly, and "the pixels match the baseline" is trivially true of
     * two identical blank images. A surface with almost no text on it is not
     * evidence of anything.
     */
    if ((page?.chars ?? 0) < (surface.minChars ?? 120)) {
      record(surface.id, `${surface.id} ${key}`, "PRODUCT FAILURE",
        `rendered ${page?.chars ?? "?"} chars of text at ${key}, floor ${surface.minChars ?? 120}`);
      continue;
    }
    shots.push({
      surface: surface.id, title: surface.title, group: surface.group, viewport: key,
      device: deviceClass(w), file: file.replace(`${SHOT_DIR}/`, ""), w: img.width, h: img.height,
      scrollH: page?.scrollH ?? null, chars: page?.chars ?? null, sha256: sha(file),
      masks: masks.map((m) => `${m.sel} @${m.x},${m.y} ${m.w}x${m.h}`),
    });

    if (FULLPAGE_AT.has(key)) {
      await b.shot(join(dir, `${key}-full.png`), { fullPage: true });
    }

    if (!RECORD_BASELINE) compare(surface, key, file, masks);
    else record(surface.id, `${surface.id} ${key}`, "PASS", `baseline recorded ${img.width}x${img.height}`);
  }
}

/**
 * Current against baseline, masks excluded.
 *
 * The tolerance is per channel and small (8/255): it absorbs the sub-pixel text
 * rendering that differs between two runs of the same build and nothing else. The
 * ratio threshold is 0.1% of unmasked pixels — a 12px padding change or a shifted
 * brand hue moves whole regions and lands orders of magnitude above it. A generous
 * threshold here would be the whole gate quietly not existing.
 */
function compare(surface, key, file, masks) {
  const baseFile = join(BASELINE_DIR, surface.id, `${key}.png`);
  const id = `${surface.id} ${key}`;
  if (!existsSync(baseFile)) {
    record(surface.id, id, "NOT EXERCISED", `no baseline at ${baseFile.replace(`${BASELINE_DIR}/`, "")}`);
    return;
  }
  const d = diffPixels(decodePng(readFileSync(baseFile)), decodePng(readFileSync(file)), { masks });
  if (!d.comparable) {
    record(surface.id, id, "PRODUCT FAILURE", `dimensions changed: ${d.reason}`);
    return;
  }
  const pct = (d.ratio * 100).toFixed(4);
  if (d.ratio > 0.001) {
    record(surface.id, id, "PRODUCT FAILURE",
      `${d.differing}/${d.considered} px differ (${pct}%), worst box ${d.worst.w}x${d.worst.h} at ${d.worst.x},${d.worst.y}`);
    return;
  }
  record(surface.id, id, "PASS",
    `${d.differing}/${d.considered} px differ (${pct}%), ${masks.length} masked region(s)`);
}

/* ──────────────────────────── driving the product ─────────────────────────── */

function makeCtx(b) {
  return {
    ...makeDriver(b),
    email: null,
    workspaceId: null,
    emptyWorkspaceId: null,
    organizationId: null,
    documentHref: null,
    compressOutcome: null,
  };
}

/** One throwaway account through the real form. Only with `--auth`. */

/* ────────────────────────────── the 17 surfaces ───────────────────────────── */

/**
 * The brief's list, in the order it names them, with the ids the manifest uses.
 * `reach` returns "ok", or a sentence explaining what was not exercised — never a
 * silent skip. `needsAuth` surfaces report NOT EXERCISED without `--auth`.
 *
 * Masks are SELECTORS, not rectangles, and there are few of them on purpose. A
 * mask is a promise that the region is genuinely nondeterministic — a relative
 * timestamp, the throwaway account's own address, a job id. Masking a whole card
 * because it moved would be the same as having no baseline.
 */
const SURFACES = [
  { id: "01-homepage", title: "Homepage", group: "marketing", minChars: 600,
    reach: async (c) => (await c.b.goto(BASE, "/", 2600), "ok") },
  { id: "02-tools-directory", title: "Tools directory", group: "marketing", minChars: 600,
    reach: async (c) => (await c.b.goto(BASE, "/tools", 2600), "ok") },
  { id: "03-merge-initial", title: "Merge — initial state", group: "workflow", minChars: 400,
    reach: async (c) => (await c.b.goto(BASE, "/tools/merge-pdf", 2600), "ok") },
  {
    id: "04-merge-result", title: "Merge — result", group: "workflow", minChars: 200,
    masks: ['[data-testid="result-size"]'],
    reach: async (c) => {
      await c.b.goto(BASE, "/tools/merge-pdf", 2600);
      const second = "/tmp/gateb-second.pdf";
      writeFileSync(second, readFileSync(FIXTURE));
      if (!(await c.attach([FIXTURE, second]))) return "the merge dropzone exposed no file input";
      if ((await c.clickText("Merge PDFs", "button")) !== "ok") return "two staged files did not enable Merge PDFs";
      const done = await c.until(`/Your file is ready/.test(document.body.innerText)`, { tries: 40 });
      return done ? "ok" : "the merge produced no result panel within 16s";
    },
  },
  {
    id: "05-compress-progress", title: "Compress — progress", group: "workflow", minChars: 200,
    // Transient by nature: a server job's progress state cannot be held still for
    // nine resizes, so one width per device class and the manifest says so.
    viewports: [[390, 844], [768, 1024], [1440, 900]],
    masks: ['[role="progressbar"]'],
    reach: async (c) => {
      await c.b.goto(BASE, "/tools/compress-pdf", 2600);
      if (!(await c.attach([FIXTURE]))) return "the compress dropzone exposed no file input";
      if ((await c.clickText("Compress", "button")) !== "ok") return "a staged file did not enable Compress";
      const p = await c.until(`!!document.querySelector('[role="progressbar"]') || null`, { tries: 40, every: 250 });
      return p ? "ok" : "no progressbar appeared within 10s";
    },
  },
  {
    id: "06-compress-outcome", title: "Compress — outcome", group: "workflow", minChars: 150,
    masks: ['[data-testid="result-size"]'],
    // Runs on whatever 05 left on screen. On a host without the processing
    // binaries the terminal state is the error surface, which is a state the
    // criteria list asks to review too — it is recorded as which one it was.
    reach: async (c) => {
      const outcome = await c.until(`(() => {
        const t = document.body.innerText;
        if (/Your file is ready/.test(t)) return 'result';
        const a = document.querySelector('[role="alert"]');
        if (a && a.innerText.trim().length > 8) return 'error';
        return null;
      })()`, { tries: 70, every: 500 });
      c.compressOutcome = outcome;
      return outcome ? "ok" : "the compress job neither completed nor failed within 35s";
    },
  },
  {
    id: "07-destination-choice", title: "Multi-Workspace destination selection", group: "workflow",
    needsAuth: true, minChars: 200,
    reach: async (c) => {
      if (!c.workspaceId || !c.emptyWorkspaceId) return "fewer than two Workspaces exist, so there is no choice to render";
      await c.b.goto(BASE, "/tools/merge-pdf", 2600);
      const second = "/tmp/gateb-second.pdf";
      writeFileSync(second, readFileSync(FIXTURE));
      if (!(await c.attach([FIXTURE, second]))) return "the merge dropzone exposed no file input";
      if ((await c.clickText("Merge PDFs", "button")) !== "ok") return "two staged files did not enable Merge PDFs";
      if (!(await c.until(`/Your file is ready/.test(document.body.innerText)`, { tries: 40 })))
        return "the merge produced no result panel";
      const sel = await c.until(`(() => {
        const s = [...document.querySelectorAll('select')].find((n) => n.options.length > 2);
        return s ? true : null;
      })()`, { tries: 20, every: 500 });
      return sel ? "ok" : "the result panel rendered no Workspace selector";
    },
  },
  {
    id: "08-workspace-populated", title: "Populated Workspace", group: "workspace",
    needsAuth: true, minChars: 200, masks: ["time", "[data-relative-time]"],
    reach: async (c) =>
      c.workspaceId
        ? (await c.b.goto(BASE, `/workspaces/${c.workspaceId}`, 3200), "ok")
        : "no Workspace was created",
  },
  {
    id: "09-workspace-empty", title: "Empty Workspace", group: "workspace",
    needsAuth: true, minChars: 120,
    reach: async (c) =>
      c.emptyWorkspaceId
        ? (await c.b.goto(BASE, `/workspaces/${c.emptyWorkspaceId}`, 3200), "ok")
        : "no second Workspace was created",
  },
  {
    id: "10-activity-recent", title: "Activity / Recent", group: "workspace",
    needsAuth: true, minChars: 150, masks: ["time", "[data-relative-time]"],
    reach: async (c) => (await c.b.goto(BASE, "/workspaces", 3200), "ok"),
  },
  { id: "11-editor-standalone", title: "Standalone Editor", group: "editor", minChars: 60, settle: 1800,
    reach: async (c) => {
      await c.b.goto(BASE, "/editor", 4200);
      const up = await c.until(`document.querySelectorAll('button').length > 4 || null`, { tries: 20, every: 500 });
      return up ? "ok" : "the editor chrome never mounted";
    } },
  {
    id: "12-editor-workspace", title: "Workspace Editor", group: "editor",
    needsAuth: true, minChars: 60, settle: 1800,
    reach: async (c) => {
      if (!c.documentHref) return "no Workspace document was ingested";
      await c.b.goto(BASE, c.documentHref, 5000);
      const up = await c.until(`!!document.querySelector('[role="toolbar"]') || null`, { tries: 24, every: 700 });
      return up ? "ok" : "the editor chrome never mounted inside the Workspace shell";
    },
  },
  {
    id: "13-publish-state", title: "Publish state", group: "editor",
    needsAuth: true, minChars: 60, settle: 1200,
    masks: ['[role="status"]'],
    /*
     * The standalone editor's own publish control, on a session that HAS a
     * Workspace to publish into — `Save to Workspace` in the app bar, and the state
     * it moves through. Driven rather than staged: the file is opened through the
     * editor's real file input and the button is really pressed.
     */
    reach: async (c) => {
      await c.b.goto(BASE, "/editor", 4200);
      if (!(await c.until(`document.querySelectorAll('button').length > 4 || null`, { tries: 20, every: 500 })))
        return "the editor chrome never mounted";
      /*
       * The PDF input by its `accept`, not "the first file input on the page". The
       * editor mounts three: this one, and two image pickers (`EditorCanvas`,
       * `PropertiesPanel`) that exist behind the onboarding overlay. Feeding a PDF
       * to an image picker loads nothing, leaves the stage at `onboarding`, and
       * `Save to Workspace` is correctly absent there — which is how this surface
       * first recorded NOT EXERCISED against a product that was behaving.
       */
      if (!(await c.attach([FIXTURE], 'input[type="file"][accept="application/pdf"]')))
        return "the editor exposed no PDF file input";
      if (!(await c.until(`/Save to Workspace/i.test(document.body.innerText) || null`, { tries: 24, every: 700 })))
        return "the app bar never offered Save to Workspace for this session";
      await c.clickText("Save to Workspace", "button");
      const state = await c.until(`(() => {
        const t = document.body.innerText;
        return /Saving|Saved|could not be saved|Choose a Workspace/i.test(t) ? true : null;
      })()`, { tries: 30, every: 500 });
      return state ? "ok" : "pressing Save to Workspace produced no visible state";
    },
  },
  {
    id: "14-conflict-dialog", title: "Save conflict", group: "editor",
    needsAuth: true, minChars: 60, settle: 900,
    masks: ['[role="status"]'],
    /*
     * The real 409, driven by really losing the race.
     *
     * A save reads the revision immediately before it writes (`revisionForCommit`),
     * so a conflict cannot be staged by advancing the document first — the save
     * would simply read the new number. What loses a compare-and-swap is another
     * writer landing INSIDE that window, so the editor's own upload is cloned in
     * flight: the clone is sent first and commits at the revision the editor read,
     * and the original then arrives one revision behind. Both requests are the
     * product's, the server's CAS decides the outcome, and the banner is the
     * product's own copy.
     *
     * What this surface used to do, and why it could never have passed: it sent an
     * out-of-band `PATCH` to the document metadata route and then looked for a
     * `[role="dialog"]`. That route has only GET and PUT (the PATCH answered 405),
     * a metadata revision is a different domain from the document revision this CAS
     * uses, and the conflict is a `role="alert"` banner rather than a dialog. It
     * reported NOT EXERCISED and blamed an unwinnable race — its own blind spot,
     * described as a property of the product.
     */
    allowedConsoleError: /Publish version failed/,
    reach: async (c) => {
      if (!c.documentHref || !c.workspaceId) return "no Workspace document was ingested";
      await c.b.goto(BASE, c.documentHref, 5000);
      if (!(await c.until(`!!document.querySelector('[role="toolbar"]') || null`, { tries: 24, every: 700 })))
        return "the editor chrome never mounted";
      /*
       * The race, armed once and only for the version upload. The arming result is
       * CHECKED: an interposer that failed to parse leaves the page saving normally,
       * and the surface would then report "no conflict appeared" about a hook that
       * was never installed — the exact shape of the journey-I' probe defect this
       * audit already found once.
       */
      const armed = await c.b.evaluate(`(() => {
        window.__probeRace = { armed: 1, fired: 0, clone: null, original: null };
        const real = window.fetch;
        window.fetch = function (input, init) {
          const url = String(typeof input === "string" ? input : (input && input.url) || "");
          const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
          if (window.__probeRace.fired || method !== "POST" || !/\\/versions\\/upload(\\?|$)/.test(url)) {
            return real.call(this, input, init);
          }
          window.__probeRace.fired = 1;
          const req = new Request(input, init);
          const clone = req.clone();
          return (async () => {
            const first = await real.call(this, clone);
            window.__probeRace.clone = first.status;
            const second = await real.call(this, req);
            window.__probeRace.original = second.status;
            return second;
          })();
        };
        return window.__probeRace.armed;
      })()`);
      if (armed !== 1) return `the upload interposer did not install: ${JSON.stringify(armed)}`;
      const ready = await c.until(
        `(() => { const b = document.querySelector('[aria-label="Publish version"]'); return b && !b.disabled ? "yes" : null; })()`,
        { tries: 30, every: 700 },
      );
      if (!ready) return "Publish version never became enabled for this document";
      await c.b.evaluate(`document.querySelector('[aria-label="Publish version"]').click()`);
      const banner = await c.until(`(() => {
        const a = [...document.querySelectorAll('[role="alert"]')]
          .find((n) => /changed in your Workspace since your last save/i.test(n.innerText));
        return a ? true : null;
      })()`, { tries: 40, every: 800 });
      const race = await c.b.evaluate(`window.__probeRace`);
      return banner
        ? "ok"
        : `no conflict banner appeared: the interposed clone answered ${race?.clone ?? "nothing"} and the editor's own upload answered ${race?.original ?? "nothing"} (fired=${race?.fired ?? "?"})`;
    },
  },
  { id: "15-pricing", title: "Pricing", group: "marketing", minChars: 400,
    reach: async (c) => (await c.b.goto(BASE, "/pricing", 2600), "ok") },
  { id: "16-login", title: "Authentication — sign in", group: "marketing", minChars: 120,
    reach: async (c) => (await c.b.goto(BASE, "/login", 2400), "ok") },
  { id: "17-register", title: "Authentication — register", group: "marketing", minChars: 150,
    reach: async (c) => (await c.b.goto(BASE, "/register", 2400), "ok") },
  { id: "18-not-found", title: "404", group: "states", minChars: 40,
    reach: async (c) => (await c.b.goto(BASE, "/gate-b-no-such-route", 2400), "ok") },
  {
    id: "19-app-error", title: "Application error state", group: "states", minChars: 40,
    /*
     * The route boundary for `/workspaces`, which by design shows nothing from the
     * error. Reaching it needs the unexpected to actually happen, so this surface is
     * captured in a SEPARATE run against a server started with an unopenable
     * `DATABASE_URL` — see the write-up. Against a healthy server it correctly
     * refuses to pretend, because the healthy answer is a Workspace page.
     *
     * The exemption is the whole subject of the surface: a render that threw is what
     * puts this boundary on screen, and React reports that throw to the console. A
     * harness that counted it would call every error state a product failure. The
     * pattern is the production-safe message React emits with the digest and no
     * detail — narrow on purpose, so a SECOND, unrelated error is still a failure.
     */
    allowedConsoleError: /An error occurred in the Server Components render/,
    reach: async (c) => {
      await c.b.goto(BASE, "/workspaces", 3000);
      const shown = await c.b.evaluate(
        `/could not be loaded|something went wrong|try again/i.test(document.body.innerText) || null`,
      );
      return shown
        ? "ok"
        : "this server answered /workspaces normally; the boundary needs a genuinely failing dependency (run with a broken DATABASE_URL)";
    },
  },
];

/* ─────────────────────────────── contact sheets ───────────────────────────── */

/**
 * The five sheets a human actually reviews. Written as HTML and screenshotted by
 * the same browser, so the sheet is one image per device class rather than 153
 * files someone has to open in order — and so no image library is needed to build
 * a montage.
 */
const SHEETS = [
  { id: "mobile", title: "Mobile — 320 / 360 / 390 / 412", widths: [320, 360, 390, 412] },
  { id: "tablet", title: "Tablet — 768 / 1024", widths: [768, 1024] },
  { id: "desktop", title: "Desktop — 1280 / 1440 / 1920", widths: [1280, 1440, 1920] },
  { id: "workflow-states", title: "Workflow states", groups: ["workflow"] },
  { id: "editor-states", title: "Editor states", groups: ["editor"] },
];

async function contactSheets(b, outDir) {
  mkdirSync(outDir, { recursive: true });
  const made = [];
  for (const sheet of SHEETS) {
    const rows = shots.filter((s) =>
      sheet.widths ? sheet.widths.includes(Number(s.viewport.split("x")[0])) : sheet.groups.includes(s.group),
    );
    if (rows.length === 0) continue;
    const cells = rows
      .map((s) => `<figure><img src="file://${process.cwd()}/${SHOT_DIR}/${s.file}" alt=""><figcaption>
        <b>${s.surface}</b><span>${s.title}</span><span>${s.viewport} · ${s.h}px tall</span></figcaption></figure>`)
      .join("\n");
    const html = `<!doctype html><meta charset="utf-8"><title>${sheet.title}</title><style>
      body{margin:0;padding:28px;background:#12131a;color:#e8e9ee;font:13px/1.4 -apple-system,Segoe UI,sans-serif}
      h1{font-size:19px;margin:0 0 4px}p{margin:0 0 22px;color:#9aa0b4}
      .grid{display:flex;flex-wrap:wrap;gap:18px}
      figure{margin:0;width:240px}
      img{width:240px;border:1px solid #2b2d3a;border-radius:6px;background:#fff;display:block}
      figcaption{padding-top:6px;display:flex;flex-direction:column;gap:1px}
      figcaption b{font-size:12px}figcaption span{color:#9aa0b4;font-size:11px}
    </style><h1>PDFDadi — ${sheet.title}</h1>
    <p>${rows.length} captures · ${BASE} · thumbnails link to the full-size PNGs in ${SHOT_DIR}</p>
    <div class="grid">${cells}</div>`;
    const htmlPath = join(outDir, `contact-${sheet.id}.html`);
    writeFileSync(htmlPath, html);
    await b.send("Page.navigate", { url: `file://${process.cwd()}/${htmlPath}` });
    await sleep(1400);
    await b.resize(1360, 900);
    await sleep(500);
    const png = join(outDir, `contact-${sheet.id}.png`);
    await b.shot(png, { fullPage: true });
    made.push({ sheet: sheet.id, title: sheet.title, captures: rows.length, png, html: htmlPath });
  }
  return made;
}

/* ─────────────────────────────────── main ─────────────────────────────────── */

const summary = () => {
  const by = (v) => results.filter((r) => r.verdict === v);
  const pass = by("PASS").length;
  const fail = by("PRODUCT FAILURE");
  const exercised = pass + fail.length;
  console.log(`\n${"═".repeat(74)}`);
  console.log(`VISUAL ACCEPTANCE — PASS ${pass}/${exercised} exercised`);
  for (const v of ["PRODUCT FAILURE", "ENVIRONMENTAL", "NOT EXERCISED", "MANUAL REVIEW REQUIRED"]) {
    const rows = by(v);
    if (rows.length === 0) continue;
    console.log(`\n${v} (${rows.length}) — never counted as a pass:`);
    for (const r of rows) console.log(`  ${r.id}: ${r.detail}`);
  }
  console.log(`\n${"═".repeat(74)}`);
  console.log("VISUAL ACCEPTANCE PENDING — a machine proved the pixels did not move.");
  console.log("Only a human can approve how they look; no approval is recorded here.");
  return fail.length;
};

async function main() {
  if (!existsSync(FIXTURE)) {
    console.error(`fixture ${FIXTURE} is absent — no workflow surface can be driven`);
    process.exit(2);
  }
  try {
    const res = await fetch(BASE, { redirect: "manual" });
    if (res.status >= 500) throw new Error(`origin answered ${res.status}`);
  } catch (err) {
    console.error(`${BASE} is not answering (${err.message}). Start the artifact and the TLS front first.`);
    process.exit(2);
  }

  const b = await openBrowser({ port: 9461, width: 1440, height: 900, insecure: SECURE_FRONT });
  try {
    // Deterministic clock text and finished motion, before the first navigation.
    await b.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
    await b.send("Emulation.setLocaleOverride", { locale: "en-US" });
    await b.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        const css = ${JSON.stringify(STILL_CSS)};
        const add = () => {
          if (!document.documentElement || document.getElementById("gateb-still")) return;
          const s = document.createElement("style");
          s.id = "gateb-still";
          s.textContent = css;
          (document.head || document.documentElement).appendChild(s);
        };
        add();
        document.addEventListener("DOMContentLoaded", add);
        setTimeout(add, 0);
      })()`,
    });

    if (COOKIE) {
      const eq = COOKIE.indexOf("=");
      await b.send("Network.setCookie", {
        name: COOKIE.slice(0, eq), value: COOKIE.slice(eq + 1),
        url: BASE, path: "/", secure: SECURE_FRONT, httpOnly: true,
      });
    }

    const ctx = makeCtx(b);
    if (WITH_AUTH) {
      ctx.email = await signUpFresh(ctx, BASE, { password: PASSWORD, name: "Gate B Reviewer", prefix: "gateb" });
      if (!ctx.email) {
        record("auth", "auth setup", "ENVIRONMENTAL", "registration through the real form did not reach /workspaces");
      } else {
        ctx.workspaceId = await createWorkspace(ctx, BASE, "Gate B Review");
        if (ctx.workspaceId) {
          await ctx.attach([FIXTURE], 'input[type="file"][accept="application/pdf"]');
          ctx.documentHref = await ctx.until(
            `(() => { const a = document.querySelector('a[href*="/documents/"]'); return a ? a.getAttribute('href') : null; })()`,
            { tries: 26, every: 1000 },
          );
        }
        ctx.emptyWorkspaceId = await createWorkspace(ctx, BASE, "Gate B Empty");
        ctx.organizationId = await b.evaluate(
          `new URL(location.href).searchParams.get('organizationId')`,
        );
      }
    }

    for (const surface of SURFACES) {
      if (ONLY.length && !ONLY.some((o) => surface.id.includes(o))) continue;
      if (surface.needsAuth && !WITH_AUTH) {
        record(surface.id, surface.id, "NOT EXERCISED", "needs a session — rerun with --auth");
        continue;
      }
      b.clearErrors();
      let why = "reach threw";
      try {
        why = await surface.reach(ctx);
      } catch (err) {
        why = `reach failed: ${err.message}`;
      }
      if (why !== "ok") {
        record(surface.id, surface.id, "NOT EXERCISED", why);
        continue;
      }
      await sweep(b, surface);
      /*
       * A surface whose SUBJECT is a failure logs the diagnostic that failure
       * writes. `allowedConsoleError` exempts that one string and nothing else, so
       * a driven error state stays a passing reference instead of being reported as
       * a defect of the product it is documenting.
       */
      const js = b.errors().js.filter((e) => !surface.allowedConsoleError?.test(e));
      if (js.length) record(surface.id, `${surface.id} console`, "PRODUCT FAILURE", `${js.length} JS error(s): ${js[0]}`);
    }

    const sheets = await contactSheets(b, "docs/evidence/final-prelaunch/visual");
    const manifestPath = join(OUT, RECORD_BASELINE ? "baseline-manifest.json" : "visual-manifest.json");
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify({
      generatedAt: new Date().toISOString(), base: BASE, mode: RECORD_BASELINE ? "baseline" : "compare",
      authenticated: !!ctx.email, viewports: VIEWPORTS.map(([w, h]) => `${w}x${h}`),
      compressOutcome: ctx.compressOutcome, shots, sheets, results,
    }, null, 2)}\n`);
    console.log(`\nmanifest: ${manifestPath} (${shots.length} captures)`);
    for (const s of sheets) console.log(`sheet: ${s.png} (${s.captures})`);
    process.exit(summary() > 0 ? 1 : 0);
  } finally {
    b.close();
  }
}

await main();
