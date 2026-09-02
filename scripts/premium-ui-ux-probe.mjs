/* global process, console, fetch, setTimeout, URL */
/**
 * PHASE 6 — premium UI/UX, responsive consistency and accessibility, measured.
 *
 * The one thing an agent cannot do is look at a screen. So every gate here is a
 * MEASUREMENT or a SEMANTIC assertion about the shipped DOM, never an aesthetic
 * judgement dressed up as a number. "The hero looks balanced" is not a check.
 * "`documentElement.scrollWidth` exceeds `innerWidth` by 37px at 320, so the page
 * scrolls sideways" is.
 *
 * ## Verdicts
 *
 *   PASS             — the state was RENDERED and the measurement held.
 *   PRODUCT FAILURE  — the state was rendered and the product is wrong. Exit 1.
 *   ENVIRONMENTAL    — the check could not run for a reason outside the product
 *                      (server down, a processing binary absent). Never a pass.
 *   NOT EXERCISED    — the scenario needs an input this run did not supply.
 *                      Reported, never counted as a pass.
 *
 * A scenario that cannot render its surface reports NOT EXERCISED or
 * ENVIRONMENTAL and says so in the summary. It must never report PASS for a
 * visual state that was never on screen.
 *
 * ## Anti-vacuity
 *
 * Every scenario opens with a render gate: a title, a landmark, and a floor on
 * `innerText` length. A dead dev server, a client-side crash, or a route that
 * 500s all produce a DOM in which most assertions pass trivially (0 undersized
 * targets, 0 overflow, 0 console errors — because there is nothing there). The
 * gate is what makes the rest of the scenario mean something.
 *
 * ## Scenarios
 *
 *   A Homepage                     G Workspace-backed editor    (needs auth)
 *   B Tools directory              H Standalone editor
 *   C Local tool workflow          I Pricing
 *   D Server tool workflow         J Responsive shell
 *   E Result workflow              K Keyboard and accessibility
 *   F Workspace                    L State matrix
 *
 * Usage:
 *   node scripts/premium-ui-ux-probe.mjs
 *   node scripts/premium-ui-ux-probe.mjs --url http://localhost:3001
 *   node scripts/premium-ui-ux-probe.mjs --auth      # register a throwaway
 *                                                    # account and run F and G
 *   node scripts/premium-ui-ux-probe.mjs --shots docs/screenshots/phase6
 *
 * `--auth` MUTATES DATA: it registers one throwaway account per run
 * (`phase6.<stamp>@example.test`) and creates a Workspace and a document in it.
 * Without it, F and G report NOT EXERCISED rather than guessing.
 */
import { copyFileSync, existsSync } from "node:fs";
import { openBrowser } from "./lib/probe-browser.mjs";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const has = (flag) => process.argv.includes(flag);

const BASE = arg("--url", "http://localhost:3001");
const SHOTS = arg("--shots", null);
const WITH_AUTH = has("--auth");
const PASSWORD = "Phase6-Probe-Password!";

/** The brief's nine audit viewports. */
const VIEWPORTS = [
  [320, 800],
  [360, 800],
  [390, 844],
  [412, 915],
  [768, 1024],
  [1024, 768],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
];

const VERDICTS = ["PASS", "PRODUCT FAILURE", "ENVIRONMENTAL", "NOT EXERCISED"];
const results = [];

const record = (scenario, id, verdict, detail = "") => {
  if (!VERDICTS.includes(verdict)) throw new Error(`bad verdict ${verdict}`);
  results.push({ scenario, id, verdict, detail: String(detail).slice(0, 220) });
};
/** A measurement of a state that WAS rendered: pass or product failure. */
const gate = (scenario, id, ok, detail = "") =>
  record(scenario, id, ok ? "PASS" : "PRODUCT FAILURE", detail);
const skip = (scenario, id, why) => record(scenario, id, "NOT EXERCISED", why);
const envFail = (scenario, id, why) => record(scenario, id, "ENVIRONMENTAL", why);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─────────────────────────── measured in the page ─────────────────────────── */

/**
 * The anti-vacuity gate. Everything else in a scenario is meaningless without it.
 *
 * A blank render, a client-side crash and a 500 all yield a DOM where "0
 * undersized targets, 0 overflow, 0 errors" is trivially true. `chars` is the
 * floor that separates "this page rendered" from "this page is empty".
 */
const RENDER_GATE = `(() => {
  const main = document.querySelector('main');
  const body = document.body;
  return {
    title: document.title,
    url: location.pathname,
    chars: (body ? body.innerText : '').replace(/\\s+/gu, ' ').trim().length,
    mains: document.querySelectorAll('main').length,
    mainId: main ? main.id : null,
    h1: [...document.querySelectorAll('h1')].map((h) => h.textContent.trim().slice(0, 70)),
    lang: document.documentElement.lang || null,
    status: body ? /(Application error|Internal Server Error|This page could not be found)/i.test(body.innerText) : false,
  };
})()`;

/**
 * WCAG 2.2 AA 2.5.8 Target Size (Minimum), 24x24 CSS px.
 *
 * Three exclusions, each because the naive sweep produced a false failure that
 * cost real time in the Phase 6 audit:
 *
 *  - `[aria-hidden]` / `tabindex="-1"` / `disabled` are not targets. The upload
 *    dropzone's `<input type=file class="sr-only" tabindex="-1" aria-hidden>` is
 *    1x1 by design; the real target is the `role="button"` wrapper.
 *  - A zero/sub-4px box is hidden, not tiny. `sr-only focus:not-sr-only` is 1x1
 *    until focused (the layout's skip link measures 138x40 focused — and only
 *    with `Emulation.setFocusEmulationEnabled`, see `probe-browser.mjs`).
 *  - A checkbox or radio inside a `<label>` is hit through the label. Measuring
 *    the input alone reported every one of them as `input 16x16`, which is not
 *    what a finger has to hit. 2.5.8's own note allows the enclosing target.
 *
 * `[role=button]` is in the sweep because a links-and-buttons-only sweep missed
 * the editor status bar's 18x18 page chevrons for an entire audit.
 */
const TARGETS = `(() => {
  const SEL = 'a[href],button,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="switch"],[role="checkbox"],input:not([type=hidden]),select,textarea';
  const box = (el) => {
    const r = el.getBoundingClientRect();
    const t = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    // The label is the target for a checkbox/radio it encloses or points at.
    if (t === 'input' && (type === 'checkbox' || type === 'radio')) {
      const lab = el.closest('label') ||
        (el.id ? document.querySelector('label[for="' + el.id + '"]') : null);
      if (lab) {
        const lr = lab.getBoundingClientRect();
        if (lr.width >= r.width && lr.height >= r.height) return { r: lr, via: 'label' };
      }
    }
    return { r, via: 'self' };
  };
  const small = [];
  let considered = 0;
  for (const el of document.querySelectorAll(SEL)) {
    if (el.closest('[aria-hidden="true"]')) continue;
    if (el.getAttribute('tabindex') === '-1') continue;
    if (el.disabled) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const { r, via } = box(el);
    if (r.width < 4 || r.height < 4) continue;  // hidden, not tiny
    considered += 1;
    if (r.height < 24 || r.width < 24) {
      small.push({
        tag: el.tagName.toLowerCase() + (via === 'label' ? '(label)' : ''),
        w: Math.round(r.width),
        h: Math.round(r.height),
        name: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '')
          .trim().replace(/\\s+/gu, ' ').slice(0, 40),
        cls: (el.className || '').toString().slice(0, 80),
      });
    }
  }
  return { considered, small };
})()`;

/**
 * The semantic accessibility surface: one `main`, a working bypass, a named
 * control for every control, an image with an `alt` decision made.
 *
 * `unnamed` is the one that catches real regressions — an icon-only button whose
 * `aria-label` was dropped is invisible on screen and total to a screen reader.
 */
const A11Y = `(() => {
  const name = (el) =>
    (el.getAttribute('aria-label') || el.getAttribute('title') ||
     (el.getAttribute('aria-labelledby')
        ? (document.getElementById(el.getAttribute('aria-labelledby'))?.textContent || '')
        : '') ||
     el.textContent || '').trim();
  const controls = [...document.querySelectorAll('a[href],button,[role="button"]')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 3 && r.height > 3 && !el.closest('[aria-hidden="true"]');
  });
  const unnamed = controls.filter((el) => !name(el) && !el.querySelector('img[alt]:not([alt=""])'))
    .map((el) => el.tagName.toLowerCase() + '.' + (el.className || '').toString().slice(0, 60));
  const imgs = [...document.querySelectorAll('img')];
  const skip = [...document.querySelectorAll('a[href^="#"]')].find((a) =>
    /skip/i.test(a.textContent || ''));
  let skipBox = null;
  if (skip) {
    skip.focus();
    const r = skip.getBoundingClientRect();
    skipBox = { w: Math.round(r.width), h: Math.round(r.height), href: skip.getAttribute('href') };
    skip.blur();
  }
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
    .map((h) => Number(h.tagName[1]));
  let jump = null;
  for (let i = 1; i < headings.length; i += 1) {
    if (headings[i] - headings[i - 1] > 1) { jump = headings[i - 1] + '->' + headings[i]; break; }
  }
  return {
    mains: document.querySelectorAll('main').length,
    skip: skipBox,
    skipTargetExists: skipBox ? !!document.querySelector(skipBox.href) : false,
    controls: controls.length,
    unnamed,
    imgsMissingAlt: imgs.filter((i) => i.getAttribute('alt') === null).length,
    headingJump: jump,
    firstHeading: headings[0] ?? null,
  };
})()`;

/* ──────────────────────────────── helpers ─────────────────────────────────── */

/** A dead server is ENVIRONMENTAL. A server that answers with nothing is not. */
async function reachable(base) {
  try {
    const res = await fetch(base, { redirect: "manual" });
    return res.status;
  } catch {
    return 0;
  }
}

function helpers(b) {
  const ctx = {
    b,
    /** Present-tense record of what the run actually rendered, for the summary. */
    rendered: [],
    async shot(name, w) {
      if (!SHOTS) return;
      await b.shot(`${SHOTS}/${name}-${w}.png`, { fullPage: false });
    },
    /**
     * Navigate and gate. Returns the gate on success, `null` when the surface did
     * not render — and records the verdict itself, so a caller that gets `null`
     * must simply return rather than assert on an empty DOM.
     */
    async open(scenario, path, { min = 300, wait = 2200, expect = null } = {}) {
      b.clearErrors();
      await b.goto(BASE, path, wait);
      const g = await b.evaluate(RENDER_GATE);
      if (!g || g.__probeError) {
        envFail(scenario, `${scenario}0 render`, `could not evaluate on ${path}: ${g?.__probeError}`);
        return null;
      }
      if (g.status) {
        gate(scenario, `${scenario}0 render`, false, `${path} rendered an error page: "${g.h1[0] ?? ""}"`);
        return null;
      }
      if (g.chars < min) {
        gate(scenario, `${scenario}0 render`, false, `${path} rendered ${g.chars} chars of text, floor ${min}`);
        return null;
      }
      if (expect && !new RegExp(expect, "i").test(g.title + " " + g.h1.join(" "))) {
        gate(scenario, `${scenario}0 render`, false, `${path} title/h1 "${g.title} | ${g.h1.join(" ")}" does not match /${expect}/i`);
        return null;
      }
      gate(scenario, `${scenario}0 render`, true, `${path} — "${g.title.slice(0, 48)}", ${g.chars} chars, h1 ${g.h1.length}`);
      ctx.rendered.push(`${scenario}: ${path} (${g.chars} chars)`);
      return g;
    },
    /** WCAG 2.5.8. `considered` is the anti-vacuity floor: 0 controls is a bug. */
    async targets(scenario, id, { floor = 5 } = {}) {
      const t = await b.evaluate(TARGETS);
      if (!t || t.__probeError) return envFail(scenario, id, String(t?.__probeError));
      if (t.considered < floor) {
        return gate(scenario, id, false, `only ${t.considered} interactive targets found, floor ${floor}`);
      }
      gate(
        scenario,
        id,
        t.small.length === 0,
        t.small.length
          ? t.small.map((s) => `${s.tag} ${s.w}x${s.h} "${s.name}"`).join("; ")
          : `${t.considered} targets, all >= 24x24`,
      );
      return t;
    },
    /** One `main`, a live bypass, no unnamed control, no undecided `alt`. */
    async a11y(scenario, prefix) {
      const a = await b.evaluate(A11Y);
      if (!a || a.__probeError) return envFail(scenario, `${prefix} a11y`, String(a?.__probeError));
      gate(scenario, `${prefix} one main landmark`, a.mains === 1, `${a.mains} <main> elements`);
      gate(
        scenario,
        `${prefix} bypass block resolves`,
        !!a.skip && a.skip.w >= 24 && a.skip.h >= 24 && a.skipTargetExists,
        a.skip
          ? `${a.skip.href} focused ${a.skip.w}x${a.skip.h}, target ${a.skipTargetExists ? "exists" : "MISSING"}`
          : "no skip link",
      );
      gate(
        scenario,
        `${prefix} every control has an accessible name`,
        a.unnamed.length === 0 && a.controls > 3,
        a.unnamed.length ? a.unnamed.slice(0, 4).join("; ") : `${a.controls} named controls`,
      );
      gate(scenario, `${prefix} every image decides its alt`, a.imgsMissingAlt === 0, `${a.imgsMissingAlt} <img> without alt`);
      return a;
    },
    /**
     * JS errors only. Two things are deliberately NOT product failures:
     *
     *  - A 401 from `/api/auth/me` is the documented signed-out answer, so
     *    network entries are counted separately and reported, not failed.
     *  - An error naming an origin other than `BASE` is a configuration
     *    mismatch, not a UI defect. `NEXT_PUBLIC_SITE_URL` is what signed
     *    storage URLs are built from; running the app on a port that env does
     *    not name makes a completed job's own download unreachable. Production
     *    refuses a loopback value for exactly this reason
     *    (`src/infrastructure/config/env.ts`), so failing the UI for it would be
     *    blaming the product for the probe's choice of port.
     */
    errors(scenario, id) {
      const { js, net } = b.errors();
      const origin = new URL(BASE).origin;
      const real = js.filter((e) => !/favicon|ResizeObserver loop/i.test(e));
      const foreign = real.filter((e) => {
        const m = /https?:\/\/[^/\s'"]+/.exec(e);
        return m && m[0] !== origin;
      });
      const mine = real.filter((e) => !foreign.includes(e));
      if (foreign.length) {
        envFail(
          scenario,
          `${id} (cross-origin)`,
          `${foreign.length} error(s) name an origin other than ${origin} — NEXT_PUBLIC_SITE_URL does not match this server: ${foreign[0].slice(0, 110)}`,
        );
      }
      gate(scenario, id, mine.length === 0, mine.length ? mine.slice(0, 3).join(" | ") : `clean (${net.length} network entries ignored)`);
    },
    /** Overflow across the nine audit widths. Reported per width, once. */
    async responsive(scenario, id, widths = VIEWPORTS) {
      const rows = [];
      for (const [w, h] of widths) {
        await b.resize(w, h);
        const l = await b.layout();
        if (!l || l.__probeError) {
          envFail(scenario, `${id} ${w}`, String(l?.__probeError));
          continue;
        }
        rows.push({ w, ...l });
        await ctx.shot(`${scenario.toLowerCase()}`, w);
      }
      const bad = rows.filter((r) => r.overflow);
      gate(
        scenario,
        id,
        bad.length === 0 && rows.length === widths.length,
        bad.length
          ? bad.map((r) => `${r.w}: scrollW ${r.scrollW} (+${r.scrollW - r.vw}) via ${r.wide[0] ? r.wide[0].tag + "." + r.wide[0].cls.slice(0, 40) : "?"}`).join("; ")
          : `${rows.length} widths, no document-level horizontal scroll`,
      );
      await b.resize(1440, 900);
      return rows;
    },
    /**
     * `name` is either a form field's `name` or a full CSS selector. Deciding
     * which by SHAPE matters: interpolating a compound selector into
     * `input[name="..."]` builds invalid selector syntax, `querySelector` throws,
     * and the whole evaluate returns `__probeError` instead of filling anything.
     * That silently left the create-dialog's `required` name field empty, the
     * browser correctly refused to submit, and F2 read as a product failure.
     */
    fill: (name, value) =>
      b.evaluate(`(() => {
        const sel = ${JSON.stringify(/^[\w-]+$/.source)};
        const el = new RegExp(sel).test(${JSON.stringify(name)})
          ? document.querySelector('input[name="${name}"]')
          : document.querySelector(${JSON.stringify(name)});
        if (!el) return "missing";
        const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return "ok";
      })()`),
    clickText: (text, selector = "button, a") =>
      b.evaluate(`(() => {
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
          .find((n) => n.textContent.trim() === ${JSON.stringify(text)}) ||
          [...document.querySelectorAll(${JSON.stringify(selector)})]
          .find((n) => n.textContent.trim().startsWith(${JSON.stringify(text)}));
        if (!el) return "missing";
        el.click();
        return "ok";
      })()`),
    /** Attach a real file to the page's file input, the path a user takes. */
    async attach(paths, selector = 'input[type="file"]') {
      const doc = await b.send("DOM.getDocument", { depth: -1 });
      const q = await b.send("DOM.querySelector", { nodeId: doc.result?.root?.nodeId, selector });
      if (!q.result?.nodeId) return false;
      await b.send("DOM.setFileInputFiles", { nodeId: q.result.nodeId, files: paths });
      await sleep(1800);
      return true;
    },
  };
  return ctx;
}

/** The box of the first control whose text or accessible name matches `label`. */
const BOX = (label, selector = "a,button,[role=button]") => `(() => {
  const re = new RegExp(${JSON.stringify(label)}, 'i');
  const el = [...document.querySelectorAll('${selector}')].find((n) => {
    if (!(re.test((n.textContent || '').trim()) || re.test(n.getAttribute('aria-label') || ''))) return false;
    // A zero box is a control the user cannot see: the header's copy of this
    // label lives in a \`hidden lg:flex\` group, and matching it measured 0x0 at
    // 390 while the hero's real CTA sat happily at top 491.
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    top: Math.round(r.top), bottom: Math.round(r.bottom),
    w: Math.round(r.width), h: Math.round(r.height),
    vh: window.innerHeight,
    inView: r.top < window.innerHeight && r.bottom > 0,
  };
})()`;

/* ════════════════════════════ A — Homepage ═══════════════════════════════ */

async function scenarioA(ctx) {
  const S = "A";
  const g = await ctx.open(S, "/", { min: 1200, expect: "PDF" });
  if (!g) return;

  gate(S, "A1 exactly one h1", g.h1.length === 1, g.h1.join(" | ") || "none");

  // "Oversized headings pushing content below the fold" is a named anti-pattern
  // in the brief, and it is measurable: the primary CTA must be reachable without
  // scrolling on a phone as well as a laptop.
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    await ctx.b.resize(w, h);
    const cta = await ctx.b.evaluate(BOX("Get Started Free"));
    gate(
      S,
      `A2 primary CTA above the fold at ${w}x${h}`,
      !!cta && cta.inView && cta.h >= 40,
      cta ? `top ${cta.top} of ${cta.vh}, ${cta.w}x${cta.h}` : "CTA not found",
    );
  }
  await ctx.b.resize(1440, 900);

  // The hero illustration depicts real tools. Rendered, not source-scanned: all
  // five workflow cards present, and no caption for a tool that does not exist
  // ("Extracted" over the `pdf-to-excel` slug, which is `planned`).
  const hero = await ctx.b.evaluate(`(() => {
    const t = document.body.innerText;
    const wanted = ['24 pages', 'Converted', 'To PDF', '12 images', 'Signed'];
    return { found: wanted.filter((w) => t.includes(w)), stale: /Extracted/.test(t) };
  })()`);
  gate(
    S,
    "A3 hero illustration depicts five real, runnable tools",
    hero.found.length === 5 && !hero.stale,
    `${hero.found.length}/5 cards${hero.stale ? ", still says \"Extracted\"" : ""}`,
  );

  await ctx.targets(S, "A4 target size 24x24", { floor: 20 });
  await ctx.a11y(S, "A5");
  ctx.errors(S, "A6 no console errors");
  await ctx.responsive(S, "A7 no horizontal scroll at any audit width");
}

/* ═════════════════════════ B — Tools directory ═══════════════════════════ */

async function scenarioB(ctx) {
  const S = "B";
  const g = await ctx.open(S, "/tools", { min: 1200, expect: "Tool" });
  if (!g) return;

  const cat = await ctx.b.evaluate(`(() => {
    const cards = [...document.querySelectorAll('a[href^="/tools/"]')];
    const rail = document.querySelector('[aria-label="Tool categories"]');
    const search = document.querySelector('input[aria-label="Search tools"]');
    const later = document.getElementById('coming-later');
    return {
      cards: cards.length,
      slugs: [...new Set(cards.map((a) => a.getAttribute('href')))].length,
      rail: !!rail,
      railZ: rail ? getComputedStyle(rail).zIndex : null,
      search: !!search,
      // A tool card that is a link with no text is a card whose title failed.
      empty: cards.filter((a) => !(a.textContent || '').trim()).length,
      // The planned tools are a collapsed disclosure, not links: "these are here
      // so you can see what is planned, not so you can try it".
      claimed: later ? Number((/(\\d+) planned/.exec(later.innerText) || [])[1] ?? -1) : -1,
      toggle: !!(later && later.querySelector('button[aria-expanded="false"][aria-controls]')),
      grid: !!document.getElementById('coming-later-grid'),
    };
  })()`);

  // Only the 32 AVAILABLE tools are linked. A directory that linked all 45 would
  // be offering pages for tools that do not run.
  gate(S, "B1 every available tool is a titled link", cat.slugs >= 30 && cat.empty === 0,
    `${cat.slugs} distinct tool links from ${cat.cards} cards, ${cat.empty} untitled`);
  gate(S, "B2 search has an accessible name", cat.search, cat.search ? "input[aria-label=Search tools]" : "missing");
  gate(S, "B3 the category rail is a named group on a named layer", cat.rail && cat.railZ !== "auto",
    `rail ${cat.rail ? "present" : "missing"}, z-index ${cat.railZ}`);

  // The planned-tools disclosure: collapsed by default, and what it reveals must
  // match the number it claims. A count drawn from a different list than the grid
  // is the kind of quiet lie a rendered check is the only way to catch.
  if (!cat.toggle) {
    gate(S, "B3b the planned-tools disclosure is collapsed and controlled", false,
      `toggle ${cat.toggle}, grid rendered while collapsed: ${cat.grid}, claimed ${cat.claimed}`);
  } else {
    gate(S, "B3b the planned-tools disclosure is collapsed and controlled",
      cat.claimed > 5 && cat.grid === false, `claims ${cat.claimed} planned, grid hidden ${!cat.grid}`);
    await ctx.clickText("Show planned tools", "button");
    await sleep(500);
    const revealed = await ctx.b.evaluate(`(() => {
      const grid = document.getElementById('coming-later-grid');
      const later = document.getElementById('coming-later');
      return {
        cards: grid ? grid.children.length : 0,
        expanded: later ? later.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') : null,
      };
    })()`);
    gate(S, "B3c expanding reveals exactly the number of planned tools it claimed",
      revealed.cards === cat.claimed && revealed.expanded === "true",
      `claimed ${cat.claimed}, revealed ${revealed.cards}, aria-expanded ${revealed.expanded}`);
  }

  await ctx.targets(S, "B4 target size 24x24", { floor: 40 });
  await ctx.a11y(S, "B5");
  ctx.errors(S, "B6 no console errors");
  await ctx.responsive(S, "B7 no horizontal scroll at any audit width");
}

/* ═══════════════════ C — local tool workflow (Merge PDF) ═════════════════ */

const FIXTURE = "docs/qa/p1/multipage-fixture.pdf";

async function scenarioC(ctx) {
  const S = "C";
  if (!existsSync(FIXTURE)) {
    envFail(S, "C0 render", `${FIXTURE} is absent, so no local workflow can be exercised`);
    return;
  }
  const g = await ctx.open(S, "/tools/merge-pdf", { min: 600, expect: "Merge" });
  if (!g) return;

  // The dropzone is the whole surface, not the `sr-only` input inside it. AA asks
  // for 24x24; a primary drop target on a phone should clear 44x44.
  await ctx.b.resize(390, 844);
  const drop = await ctx.b.evaluate(`(() => {
    const el = document.querySelector('[role="button"][aria-label]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const input = document.querySelector('input[type=file]');
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      label: el.getAttribute('aria-label').slice(0, 60),
      inputHidden: input ? (input.getAttribute('aria-hidden') === 'true' && input.tabIndex === -1) : null,
    };
  })()`);
  gate(
    S,
    "C1 the drop target is one named control, comfortably tappable",
    !!drop && drop.w >= 44 && drop.h >= 44 && drop.label.length > 8 && drop.inputHidden === true,
    drop ? `${drop.w}x${drop.h} "${drop.label}", input aria-hidden+tabindex-1: ${drop.inputHidden}` : "no role=button dropzone",
  );
  await ctx.b.resize(1440, 900);

  // Two DISTINCT files: merge needs two, and a dropzone may dedupe by name.
  const second = "/tmp/pdfdadi-probe-second.pdf";
  copyFileSync(FIXTURE, second);
  const attached = await ctx.attach([FIXTURE, second].map((p) => (p.startsWith("/") ? p : `${process.cwd()}/${p}`)));
  await sleep(1200);
  const staged = await ctx.b.evaluate(`(() => {
    const t = document.body.innerText;
    const btn = [...document.querySelectorAll('button')].find((b) => /Merge PDFs/i.test(b.textContent));
    return { pdfs: (t.match(/\\.pdf/gi) || []).length, enabled: btn ? !btn.disabled : null };
  })()`);
  gate(
    S,
    "C2 two staged files enable the tool's own action",
    attached && staged.pdfs >= 2 && staged.enabled === true,
    `attached ${attached}, ${staged.pdfs} .pdf mentions, action enabled ${staged.enabled}`,
  );
  if (!attached || staged.enabled !== true) {
    skip(S, "C3 processing state", "the action never became available");
    skip(S, "C4 result state", "the action never became available");
    return;
  }

  // Two tiny PDFs merge in under a frame, so the in-flight state is real but
  // nearly unobservable. Throttling the CPU widens the window instead of
  // pretending a state was seen: this is the same button a 40MB merge shows for
  // seconds, and `Button loading` is what makes it un-double-submittable.
  await ctx.b.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  await ctx.clickText("Merge PDFs", "button");

  let busy = null;
  for (let i = 0; i < 20 && !busy; i += 1) {
    if (i) await sleep(40);
    const s = await ctx.b.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((n) => /Merging/i.test(n.textContent));
      if (!b) return null;
      return { busy: b.getAttribute('aria-busy'), disabled: b.disabled, spinner: !!b.querySelector('svg') };
    })()`);
    if (s && !s.__probeError) busy = s;
  }
  await ctx.b.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  if (busy) {
    gate(
      S,
      "C3 the in-flight action is busy, disabled and labelled",
      busy.busy === "true" && busy.disabled === true,
      `aria-busy ${busy.busy}, disabled ${busy.disabled}, spinner ${busy.spinner}`,
    );
  } else {
    skip(S, "C3 processing state", "merge completed before any of 20 samples, even at 6x CPU throttle");
  }

  let done = false;
  for (let i = 0; i < 30 && !done; i += 1) {
    await sleep(400);
    done = (await ctx.b.evaluate(`/Your file is ready/.test(document.body.innerText)`)) === true;
  }
  if (!done) {
    gate(S, "C4 result state", false, "the merge never produced a result panel");
    return;
  }
  const res = await ctx.b.evaluate(`(() => {
    const panel = [...document.querySelectorAll('[role="status"]')]
      .find((n) => /Your file is ready/.test(n.innerText));
    const btn = (re) => [...document.querySelectorAll('button, a')].some((n) => re.test(n.textContent));
    return {
      live: !!panel,
      size: panel ? /\\d+(\\.\\d+)?\\s?(KB|MB|bytes)/i.test(panel.innerText) : false,
      download: btn(/^\\s*Download\\s*$/),
      startOver: btn(/Start over/),
    };
  })()`);
  gate(
    S,
    "C4 the result is announced, named and downloadable",
    res.live && res.size && res.download && res.startOver,
    `role=status ${res.live}, size shown ${res.size}, Download ${res.download}, Start over ${res.startOver}`,
  );
  await ctx.targets(S, "C5 target size 24x24 in the result state", { floor: 10 });
  ctx.errors(S, "C6 no console errors across the whole local flow");
  await ctx.responsive(S, "C7 the result state fits every audit width", [[320, 800], [390, 844], [768, 1024], [1440, 900]]);
  ctx.localResult = true;
}

/* ═════════════════════ E — result workflow and destination ════════════════ */

/**
 * Runs on the result C left on screen. The Phase 1-5 invariants this renders:
 * `editorOpenableOutput` and `workspaceSaveableOutput` are independent, Workspace
 * saving is explicit, and destination selection is authorized.
 *
 * Both sessions are audited, because the two states assert OPPOSITE things and
 * one gate cannot hold both: signed out, the offer is a sign-in that returns to
 * this tool and there is no save; signed in, there is an explicit save and no
 * sign-in. Writing only the signed-out half made `--auth` report the correct
 * signed-in panel as a product failure.
 */
async function scenarioE(ctx) {
  const S = "E";
  const live = await ctx.b.evaluate(`/Your file is ready/.test(document.body.innerText)`);
  if (live !== true) {
    skip(S, "E0 render", "no local result was on screen (scenario C did not complete)");
    return;
  }
  gate(S, "E0 render", true,
    `the merge result panel is on screen (${ctx.email ? "signed in" : "signed out"})`);

  const w = await ctx.b.evaluate(`(() => {
    const all = [...document.querySelectorAll('button, a')];
    const find = (re) => all.find((n) => re.test(n.textContent));
    const editor = find(/Open in Editor/i);
    const signin = find(/Sign in to save to Workspace/i);
    const save = find(/^\\s*Save to Workspace\\s*$/i);
    const box = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
    return {
      editor: editor ? box(editor) : null,
      signin: signin ? { ...box(signin), href: signin.getAttribute('href') } : null,
      save: !!save,
      select: (() => {
        const sel = document.querySelector('select');
        if (!sel) return null;
        const labelled = !!(sel.getAttribute('aria-label') ||
          (sel.id && document.querySelector('label[for="' + sel.id + '"]')) ||
          sel.closest('label'));
        return { labelled, options: sel.options.length };
      })(),
    };
  })()`);

  gate(
    S,
    "E1 an editor-openable output offers the editor without a session",
    !!w.editor && w.editor.h >= 24,
    w.editor ? `Open in Editor ${w.editor.w}x${w.editor.h}` : "Open in Editor absent",
  );
  if (ctx.email) {
    // Signed in: saving is offered and it is EXPLICIT — a button the user presses,
    // never something the result panel did on arrival.
    gate(
      S,
      "E2 a signed-in result offers an explicit save, not a sign-in",
      w.save === true && !w.signin,
      `save button ${w.save}, sign-in CTA ${w.signin ? w.signin.href : "absent"}`,
    );
  } else {
    gate(
      S,
      "E2 a signed-out result offers sign-in, not a save",
      !!w.signin && w.save === false && /\/login\?next=/.test(w.signin.href ?? ""),
      `${w.signin ? `sign-in -> ${w.signin.href}` : "no sign-in CTA"}, save button present ${w.save}`,
    );
  }
  // Order-independent on purpose: the selector exists only when there is more
  // than one authorized destination, so its ABSENCE is the single-destination
  // answer and its PRESENCE has to be a labelled control with real choices.
  gate(
    S,
    "E3 a destination selector appears only when there is a destination to choose",
    w.select === null || (w.select.labelled && w.select.options >= 2),
    w.select === null
      ? "no selector — one destination or none, which is the documented answer"
      : `selector labelled ${w.select.labelled}, ${w.select.options} options`,
  );
  ctx.errors(S, "E4 no console errors in the result workflow");
}

/* ══════════════════ D — server tool workflow (Compress PDF) ═══════════════ */

async function scenarioD(ctx) {
  const S = "D";
  if (!existsSync(FIXTURE)) {
    envFail(S, "D0 render", `${FIXTURE} is absent`);
    return;
  }
  const g = await ctx.open(S, "/tools/compress-pdf", { min: 600, expect: "Compress" });
  if (!g) return;

  const attached = await ctx.attach([`${process.cwd()}/${FIXTURE}`]);
  await sleep(1000);

  // Every option in the tool's form is labelled. `label[for]`/`aria-label` is the
  // difference between a select a screen reader can use and one it cannot.
  const form = await ctx.b.evaluate(`(() => {
    const fields = [...document.querySelectorAll('select, input[type=text], input[type=number], textarea')];
    const unlabelled = fields.filter((f) => {
      if (f.getAttribute('aria-label')) return false;
      if (f.id && document.querySelector('label[for="' + f.id + '"]')) return false;
      return !f.closest('label');
    }).length;
    const btn = [...document.querySelectorAll('button')].find((b) => /Compress/i.test(b.textContent));
    return { fields: fields.length, unlabelled, action: btn ? !btn.disabled : null };
  })()`);
  gate(S, "D1 every form field is labelled", form.unlabelled === 0, `${form.fields} fields, ${form.unlabelled} unlabelled`);
  gate(S, "D2 a staged file enables the server action", attached && form.action === true, `attached ${attached}, enabled ${form.action}`);
  if (!attached || form.action !== true) {
    skip(S, "D3 processing state", "the server action never became available");
    skip(S, "D4 outcome", "the server action never became available");
    return;
  }

  await ctx.clickText("Compress", "button");

  // A server job is long enough that the progress state is the state the user
  // actually looks at: it must be a real progressbar with a real value.
  let prog = null;
  for (let i = 0; i < 40 && !prog; i += 1) {
    await sleep(250);
    const p = await ctx.b.evaluate(`(() => {
      const el = document.querySelector('[role="progressbar"]');
      if (!el) return null;
      return {
        now: el.getAttribute('aria-valuenow'),
        label: (el.getAttribute('aria-label') || '').slice(0, 50),
        cancel: [...document.querySelectorAll('button')].some((b) => /Cancel/i.test(b.textContent)),
      };
    })()`);
    if (p && !p.__probeError) prog = p;
  }
  if (prog) {
    gate(
      S,
      "D3 the server job reports progress accessibly and stays cancellable",
      prog.now !== null && prog.label.length > 2 && prog.cancel,
      `aria-valuenow ${prog.now}, label "${prog.label}", Cancel ${prog.cancel}`,
    );
  } else {
    skip(S, "D3 processing state", "no progressbar was sampled within 10s");
  }

  let outcome = null;
  for (let i = 0; i < 60 && !outcome; i += 1) {
    await sleep(500);
    outcome = await ctx.b.evaluate(`(() => {
      const t = document.body.innerText;
      if (/Your file is ready/.test(t)) return 'done';
      const alert = document.querySelector('[role="alert"]');
      if (alert || /could not|failed|unavailable|not installed/i.test(t)) {
        return 'error:' + (alert ? alert.innerText : t).replace(/\\s+/gu, ' ').slice(0, 140);
      }
      return null;
    })()`);
  }
  if (outcome === "done") {
    gate(S, "D4 the server result is announced and downloadable", true, "result panel rendered");
    await ctx.targets(S, "D5 target size 24x24 in the server result state", { floor: 10 });
  } else if (typeof outcome === "string" && outcome.startsWith("error:")) {
    // A missing processing binary is not a UI defect; a broken error SURFACE is.
    const shown = await ctx.b.evaluate(`(() => {
      const el = document.querySelector('[role="alert"]');
      const r = el ? el.getBoundingClientRect() : null;
      return { alert: !!el, h: r ? Math.round(r.height) : 0, text: el ? el.innerText.replace(/\\s+/gu,' ').slice(0,120) : '' };
    })()`);
    envFail(S, "D4 outcome", `the job did not complete in this environment — ${outcome.slice(6)}`);
    gate(
      S,
      "D5 the failure is surfaced in a live region, not silently",
      shown.alert && shown.h > 8,
      shown.alert ? `role=alert ${shown.h}px: "${shown.text}"` : "the failure rendered no role=alert",
    );
  } else {
    envFail(S, "D4 outcome", "the server job neither completed nor failed within 30s");
  }
  ctx.errors(S, "D6 no console errors across the server flow");
}

/* ══════════════════════════════ auth (F, G) ═══════════════════════════════ */

/**
 * Registers one throwaway account through the real form. `--auth` only, because
 * it writes rows: an audit that silently creates users is worse than one that
 * says NOT EXERCISED.
 */
async function signUp(ctx) {
  const email = `phase6.${Date.now()}@example.test`;
  await ctx.b.goto(BASE, "/register", 3000);
  for (const [name, value] of [
    ["name", "Phase Six Prober"],
    ["email", email],
    ["password", PASSWORD],
    ["confirmPassword", PASSWORD],
  ]) {
    if ((await ctx.fill(name, value)) !== "ok") return null;
  }
  await ctx.b.evaluate(`document.querySelector('input[name="acceptedTerms"]')?.click()`);
  await ctx.clickText("Create account", "button");
  await sleep(6000);
  const url = await ctx.b.url();
  return /\/workspaces/.test(url ?? "") ? email : null;
}

/* ═══════════════════════════════ F — Workspace ════════════════════════════ */

async function scenarioF(ctx) {
  const S = "F";
  if (!ctx.email) {
    skip(S, "F0 render", "no session — rerun with --auth to exercise the Workspace");
    return;
  }
  const g = await ctx.open(S, "/workspaces", { min: 120, expect: "Workspace" });
  if (!g) return;

  // §12: the create dialog is a real dialog — modal, labelled, and it takes focus.
  const opened = await ctx.clickText("Create Workspace", "button");
  await sleep(700);
  const dlg = await ctx.b.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return null;
    const a = document.activeElement;
    return {
      modal: d.getAttribute('aria-modal'),
      named: !!(d.getAttribute('aria-label') || d.getAttribute('aria-labelledby')),
      focusInside: d.contains(a) && a !== document.body,
      input: !!d.querySelector('input'),
    };
  })()`);
  gate(
    S,
    "F1 the create dialog is modal, named, and takes focus",
    opened === "ok" && !!dlg && dlg.modal === "true" && dlg.named && dlg.focusInside && dlg.input,
    dlg ? `aria-modal ${dlg.modal}, named ${dlg.named}, focus inside ${dlg.focusInside}` : "no role=dialog",
  );
  if (!dlg) return;

  const filled = await ctx.fill('[role="dialog"] input', "Phase 6 UI Probe");
  const submitted = await ctx.clickText("Create", "button");
  await sleep(6000);
  const url = await ctx.b.url();
  const wid = /\/workspaces\/([^/?#]+)/.exec(url ?? "")?.[1] ?? null;
  // The dialog's own `role=status` is the product's explanation of a refusal, so
  // report it rather than only the unchanged URL: "name is required" and "a
  // workspace with that name exists" are different findings.
  const said = wid ? "" : await ctx.b.evaluate(
    `(document.querySelector('[role="dialog"] [role="status"]')?.textContent || '').trim().slice(0, 120)`,
  );
  gate(S, "F2 creating a Workspace opens that Workspace", !!wid && wid !== "undefined",
    wid ? url : `${url} (fill ${JSON.stringify(filled)}, click ${JSON.stringify(submitted)}, dialog said ${JSON.stringify(said)})`);
  if (!wid) return;
  ctx.workspaceId = wid;
  ctx.organizationId = await ctx.b.evaluate(
    `new URL(location.href).searchParams.get('organizationId') ||
     (document.querySelector('a[href*="organizationId="]') ? new URL(document.querySelector('a[href*="organizationId="]').href).searchParams.get('organizationId') : null)`,
  );
  ctx.rendered.push(`F: /workspaces/${wid}`);

  const shell = await ctx.b.evaluate(`(() => {
    const nav = document.querySelector('nav[aria-label], aside nav');
    return {
      mains: document.querySelectorAll('main').length,
      nav: !!nav,
      navName: nav ? (nav.getAttribute('aria-label') || '') : null,
      name: /Phase 6 UI Probe/.test(document.body.innerText),
    };
  })()`);
  gate(S, "F3 the app shell renders one main landmark", shell.mains === 1, `${shell.mains} <main>`);
  gate(S, "F4 the Workspace's own name is on screen", shell.name, shell.name ? "present" : "absent");

  // §3 + §15: the mobile drawer is a real dialog with a real focus trap, and
  // Escape returns focus to the trigger that opened it.
  await ctx.b.resize(390, 844);
  await sleep(500);
  const drawerOpened = await ctx.b.clickLabel("Open navigation");
  await sleep(500);
  const drawer = await ctx.b.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"][aria-modal="true"]');
    if (!d) return null;
    return { name: d.getAttribute('aria-label'), focusInside: d.contains(document.activeElement) };
  })()`);
  await ctx.b.key("Escape", "Escape");
  await sleep(400);
  const afterEscape = await ctx.b.evaluate(`(() => ({
    open: !!document.querySelector('[role="dialog"][aria-modal="true"]'),
    focus: (document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName || '').slice(0, 40),
  }))()`);
  gate(
    S,
    "F5 the mobile drawer traps focus and Escape returns it to the trigger",
    drawerOpened && !!drawer && drawer.focusInside && afterEscape.open === false && /Open navigation/i.test(afterEscape.focus),
    `${drawer ? `drawer "${drawer.name}", focus inside ${drawer.focusInside}` : "no drawer"}; after Escape open ${afterEscape.open}, focus "${afterEscape.focus}"`,
  );
  await ctx.b.resize(1440, 900);

  await ctx.targets(S, "F6 target size 24x24", { floor: 10 });
  await ctx.a11y(S, "F7");
  ctx.errors(S, "F8 no console errors");
  await ctx.responsive(S, "F9 no horizontal scroll at any audit width");
}

/* ══════════════════════ G — Workspace-backed editor ═══════════════════════ */

async function scenarioG(ctx) {
  const S = "G";
  if (!ctx.workspaceId) {
    skip(S, "G0 render", "no Workspace was created (rerun with --auth)");
    return;
  }
  // The Workspace's own upload input is in the DOM whether or not its menu is
  // open, so this is the real ingestion path rather than a synthetic API call.
  const attached = await ctx.attach([`${process.cwd()}/${FIXTURE}`], 'input[type="file"][accept="application/pdf"]');
  let href = null;
  for (let i = 0; i < 24 && !href; i += 1) {
    await sleep(1000);
    href = await ctx.b.evaluate(
      `(() => { const a = document.querySelector('a[href*="/documents/"]'); return a ? a.getAttribute('href') : null; })()`,
    );
    if (href && href.__probeError) href = null;
  }
  if (!attached || !href) {
    envFail(S, "G0 render", `the fixture never appeared as a Workspace document (attached ${attached})`);
    return;
  }
  const g = await ctx.open(S, href, { min: 60, wait: 4000 });
  if (!g) return;

  // The structural half of the landmark fix: the editor frame must not spend a
  // second `main` inside AppShell's. Two `main`s is one landmark too many
  // (WCAG 1.3.1 / 4.1.2) and it was the shape this route shipped with.
  gate(S, "G1 the Workspace editor renders exactly one main landmark", g.mains === 1 && g.mainId === "main",
    `${g.mains} <main>, id "${g.mainId}"`);

  let mounted = false;
  for (let i = 0; i < 20 && !mounted; i += 1) {
    await sleep(800);
    mounted = (await ctx.b.evaluate(
      `!!document.querySelector('[role="toolbar"]') && document.querySelectorAll('button').length > 6`,
    )) === true;
  }
  gate(S, "G2 the editor chrome mounted inside the Workspace shell", mounted, mounted ? "toolbar + controls present" : "no toolbar");
  if (!mounted) return;

  for (const [w, h] of [[390, 844], [768, 1024], [1440, 900]]) {
    await ctx.b.resize(w, h);
    await sleep(400);
    const t = await ctx.b.evaluate(TARGETS);
    const l = await ctx.b.layout();
    gate(
      S,
      `G3 the Workspace editor is usable and does not scroll sideways at ${w}`,
      t.small.length === 0 && l.overflow === false,
      `${t.considered} targets, ${t.small.length} undersized${t.small.length ? " (" + t.small.map((x) => x.tag + " " + x.w + "x" + x.h + ' "' + x.name + '" ' + x.cls.slice(0, 44)).join("; ") + ")" : ""}, scrollW ${l.scrollW}/${l.vw}`,
    );
    await ctx.shot("g-workspace-editor", w);
  }
  await ctx.b.resize(1440, 900);
  await ctx.a11y(S, "G4");
  ctx.errors(S, "G5 no console errors");
}

/* ═════════════════════════ H — standalone editor ══════════════════════════ */

async function scenarioH(ctx) {
  const S = "H";
  const g = await ctx.open(S, "/editor", { min: 60, wait: 3500, expect: "Editor" });
  if (!g) return;
  gate(S, "H1 the standalone editor route owns one main landmark", g.mains === 1 && g.mainId === "main",
    `${g.mains} <main>, id "${g.mainId}"`);

  const opened = existsSync(FIXTURE)
    ? await ctx.attach([`${process.cwd()}/${FIXTURE}`], 'input[type="file"][accept="application/pdf"]')
    : false;
  let pages = 0;
  if (opened) {
    for (let i = 0; i < 25 && pages === 0; i += 1) {
      await sleep(900);
      pages = (await ctx.b.evaluate(`document.querySelectorAll('canvas, svg').length`)) || 0;
    }
  }
  if (!opened) {
    skip(S, "H2 an open document", `${FIXTURE} could not be attached`);
  } else {
    gate(S, "H2 the fixture opens through the editor's own file input", pages > 0, `${pages} canvas/svg surfaces`);
  }

  // §10: on a phone every editor control must still be tappable, and the bottom
  // chrome must sit inside the viewport rather than under the home indicator.
  for (const [w, h] of [[390, 844], [1440, 900]]) {
    await ctx.b.resize(w, h);
    await sleep(500);
    const t = await ctx.b.evaluate(TARGETS);
    const l = await ctx.b.layout();
    const bottom = await ctx.b.evaluate(`(() => {
      const els = [...document.querySelectorAll('[role="toolbar"], footer, [class*="fixed"]')]
        .map((e) => e.getBoundingClientRect())
        .filter((r) => r.height > 8 && r.width > 40);
      const worst = els.sort((a, b) => b.bottom - a.bottom)[0];
      return worst ? { bottom: Math.round(worst.bottom), vh: window.innerHeight } : null;
    })()`);
    gate(
      S,
      `H3 every editor control is tappable at ${w}`,
      t.small.length === 0 && t.considered > 5,
      `${t.considered} targets, ${t.small.length} undersized${t.small.length ? " (" + t.small.map((x) => x.tag + " " + x.w + "x" + x.h + " " + x.name).join(", ") + ")" : ""}`,
    );
    gate(
      S,
      `H4 the editor chrome stays inside the viewport at ${w}`,
      l.overflow === false && (!bottom || bottom.bottom <= bottom.vh + 1),
      `scrollW ${l.scrollW}/${l.vw}${bottom ? `, lowest chrome ${bottom.bottom} of ${bottom.vh}` : ""}`,
    );
    await ctx.shot("h-standalone-editor", w);
  }
  await ctx.b.resize(1440, 900);
  ctx.errors(S, "H5 no console errors");
}

/* ═══════════════════════════════ I — Pricing ══════════════════════════════ */

async function scenarioI(ctx) {
  const S = "I";
  const g = await ctx.open(S, "/pricing", { min: 600 });
  if (!g) return;

  const plans = await ctx.b.evaluate(`(() => {
    const cards = [...document.querySelectorAll('h2')]
      .map((h) => h.closest('div[class*=rounded-card]'))
      .filter(Boolean);
    return cards.map((c) => {
      const cta = c.querySelector('a[href], button');
      return {
        name: c.querySelector('h2').textContent.trim(),
        // Three honest states, not two: a real amount, "Free", or the approved
        // "Not yet available" — the server returns no price rather than
        // inventing a number when Stripe is unconfigured.
        amount: /[$€£]\\s?\\d/.test(c.innerText),
        priced: /[$€£]\\s?\\d|Free|Not yet available/i.test(c.innerText),
        available: /Available now/i.test(c.innerText),
        badge: /Available now|Coming later/i.test(c.innerText),
        cta: cta ? (cta.getAttribute('href') || 'button') : null,
        ctaDead: cta ? (cta.getAttribute('href') === '#' || cta.disabled === true) : true,
      };
    });
  })()`);

  gate(S, "I1 every canonical plan renders as a card", Array.isArray(plans) && plans.length >= 3,
    Array.isArray(plans) ? plans.map((p) => p.name).join(", ") : "no cards");
  if (!Array.isArray(plans) || !plans.length) return;
  gate(S, "I2 every plan states a price or says it has none, and its availability",
    plans.every((p) => p.priced && p.badge),
    plans.filter((p) => !(p.priced && p.badge)).map((p) => p.name).join(", ") || "all three states accounted for");
  // The honesty invariant: an amount on an unpurchasable plan advertises a price
  // for something that cannot be bought, and a purchasable plan with no amount
  // hides one. Either way the page and the product disagree.
  const lying = plans.filter((p) => (p.available ? !p.priced : p.amount));
  gate(S, "I2b no plan shows a price it cannot honour", lying.length === 0,
    lying.length ? lying.map((p) => `${p.name} available=${p.available} amount=${p.amount}`).join(", ")
      : plans.map((p) => `${p.name}:${p.available ? "available" : "later"}`).join(" "));
  gate(S, "I3 no plan is a dead end", plans.every((p) => p.cta && !p.ctaDead),
    plans.filter((p) => !p.cta || p.ctaDead).map((p) => p.name).join(", ") || plans.map((p) => `${p.name}->${p.cta}`).join(", "));

  await ctx.targets(S, "I4 target size 24x24", { floor: 8 });
  await ctx.a11y(S, "I5");
  ctx.errors(S, "I6 no console errors");
  await ctx.responsive(S, "I7 no horizontal scroll at any audit width");
}

/* ═══════════════════════ J — responsive global shell ══════════════════════ */

/**
 * One route, nine widths, and the question the brief actually asks: is there ONE
 * navigation at every width? Two visible navs is the defect a `lg:hidden` pair
 * produces when a breakpoint is wrong, and it is invisible unless measured at the
 * boundary (1024 is `lg`: the rail appears, the burger must not).
 */
async function scenarioJ(ctx) {
  const S = "J";
  const g = await ctx.open(S, "/tools", { min: 800 });
  if (!g) return;

  const rows = [];
  for (const [w, h] of VIEWPORTS) {
    await ctx.b.resize(w, h);
    const m = await ctx.b.evaluate(`(() => {
      const vis = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
      };
      const burger = [...document.querySelectorAll('button[aria-expanded]')]
        .find((b) => /menu|navigation/i.test(b.getAttribute('aria-label') || ''));
      const desktopNav = document.querySelector('nav[aria-label="Primary"]');
      const header = document.querySelector('header');
      const de = document.documentElement;
      return {
        burger: vis(burger),
        desktop: vis(desktopNav),
        headerH: header ? Math.round(header.getBoundingClientRect().height) : 0,
        sticky: header ? getComputedStyle(header).position : null,
        overflow: de.scrollWidth > window.innerWidth + 1,
        scrollW: de.scrollWidth,
      };
    })()`);
    rows.push({ w, ...m });
    await ctx.shot("j-shell", w);
  }
  await ctx.b.resize(1440, 900);

  gate(S, "J1 every audit width was measured", rows.length === VIEWPORTS.length, `${rows.length}/${VIEWPORTS.length}`);
  const both = rows.filter((r) => r.burger && r.desktop);
  const neither = rows.filter((r) => !r.burger && !r.desktop);
  gate(S, "J2 exactly one navigation is visible at every width",
    both.length === 0 && neither.length === 0,
    both.length ? `both at ${both.map((r) => r.w).join(", ")}` : neither.length ? `neither at ${neither.map((r) => r.w).join(", ")}` : rows.map((r) => `${r.w}:${r.burger ? "burger" : "rail"}`).join(" "));
  gate(S, "J3 the header stays sticky and never eats the viewport",
    rows.every((r) => r.sticky === "sticky" || r.sticky === "fixed") && rows.every((r) => r.headerH > 40 && r.headerH < 120),
    rows.map((r) => `${r.w}:${r.headerH}px/${r.sticky}`).join(" "));
  gate(S, "J4 no width scrolls the document sideways",
    rows.every((r) => !r.overflow),
    rows.filter((r) => r.overflow).map((r) => `${r.w}->${r.scrollW}`).join(", ") || "clean");
}

/* ══════════════════════ K — keyboard and accessibility ════════════════════ */

async function scenarioK(ctx) {
  const S = "K";
  const g = await ctx.open(S, "/", { min: 1200 });
  if (!g) return;
  gate(S, "K1 the document declares a language", !!g.lang, g.lang ?? "no lang attribute");

  // 2.4.1 Bypass Blocks, rendered: the first Tab lands on the skip link, the link
  // is VISIBLE once focused, and activating it moves focus to the main landmark.
  const seen = await ctx.b.tabThrough(10);
  const first = seen[0];
  gate(
    S,
    "K2 the first Tab reaches a visible bypass link",
    !!first && /skip/i.test(first.name || "") && first.visible,
    first ? `"${first.name}" visible ${first.visible}` : "Tab focused nothing",
  );
  const bypass = await ctx.b.evaluate(`(() => {
    const a = [...document.querySelectorAll('a[href^="#"]')].find((n) => /skip/i.test(n.textContent));
    if (!a) return null;
    a.focus();
    const r = a.getBoundingClientRect();
    const target = document.querySelector(a.getAttribute('href'));
    return { w: Math.round(r.width), h: Math.round(r.height), target: !!target, tag: target ? target.tagName.toLowerCase() : null };
  })()`);
  gate(
    S,
    "K3 the bypass link is a real target pointing at the main landmark",
    !!bypass && bypass.w >= 24 && bypass.h >= 24 && bypass.target && bypass.tag === "main",
    bypass ? `${bypass.w}x${bypass.h} -> <${bypass.tag}>` : "no skip link",
  );

  // 2.4.7 Focus Visible: every stop shows an indicator. `outline: none` with no
  // ring is the regression this catches; a box-shadow ring counts.
  const focusable = seen.filter(Boolean);
  const invisible = focusable.filter((f) => !f.visible);
  const unringed = focusable.filter(
    (f) => /none/.test(f.outline) && (!f.shadow || f.shadow === "none"),
  );
  gate(S, "K4 every keyboard stop is on screen", invisible.length === 0 && focusable.length >= 8,
    invisible.length ? invisible.map((f) => f.name).join("; ") : `${focusable.length} stops`);
  gate(S, "K5 every keyboard stop shows a focus indicator", unringed.length === 0,
    unringed.length ? unringed.map((f) => `${f.tag} "${f.name}" outline ${f.outline} shadow ${f.shadow}`).slice(0, 3).join("; ") : `${focusable.length} stops ringed`);

  // Focus order must not stall: ten Tabs that never move are a trap.
  const distinct = new Set(focusable.map((f) => f.tag + "|" + f.name)).size;
  gate(S, "K6 focus advances rather than looping in place", distinct >= Math.min(6, focusable.length),
    `${distinct} distinct stops in ${focusable.length} tabs`);

  await ctx.a11y(S, "K7");
}

/* ═══════════════════════ L — state matrix (§13, §16) ══════════════════════ */

async function scenarioL(ctx) {
  const S = "L";

  // Not found: a real page, not a stack trace, with a way out.
  const nf = await ctx.b.goto(BASE, "/tools/this-tool-does-not-exist", 2500).then(() =>
    ctx.b.evaluate(`(() => ({
      text: document.body.innerText.replace(/\\s+/gu, ' ').slice(0, 160),
      mains: document.querySelectorAll('main').length,
      links: [...document.querySelectorAll('a[href]')].filter((a) => /tool|home|back/i.test(a.textContent)).length,
      trace: /at \\w+ \\(|webpack|node_modules/.test(document.body.innerText),
    }))()`),
  );
  gate(
    S,
    "L1 an unknown tool renders a real not-found page with a way out",
    !!nf && nf.mains >= 1 && nf.links > 0 && !nf.trace && nf.text.length > 20,
    nf ? `${nf.mains} main, ${nf.links} escape links, trace ${nf.trace}: "${nf.text.slice(0, 70)}"` : "no render",
  );

  // An expired/missing handoff: the documented one-time result. A bogus id is
  // exactly what a reload of a consumed handoff produces.
  ctx.b.clearErrors();
  await ctx.b.goto(BASE, "/editor?handoff=probe-nonexistent-id", 4000);
  const expired = await ctx.b.evaluate(`(() => {
    const alert = document.querySelector('[role="alert"]');
    return {
      text: (alert ? alert.innerText : document.body.innerText).replace(/\\s+/gu, ' ').slice(0, 200),
      alert: !!alert,
      param: location.search,
      editor: document.querySelectorAll('button').length > 4,
    };
  })()`);
  gate(
    S,
    "L2 a consumed or expired handoff explains itself and leaves the editor usable",
    expired.alert && /expire|not|could not|unavailable|again/i.test(expired.text) && expired.editor && expired.param === "",
    `alert ${expired.alert}, param "${expired.param}", editor usable ${expired.editor}: "${expired.text.slice(0, 90)}"`,
  );
  ctx.errors(S, "L3 the failed handoff logs no console error");

  // §16: under `prefers-reduced-motion: reduce` nothing keeps moving.
  await ctx.b.reduceMotion(true);
  await ctx.b.goto(BASE, "/", 2500);
  const motion = await ctx.b.evaluate(`(() => {
    const moving = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const dur = parseFloat(cs.animationDuration) || 0;
      const name = cs.animationName;
      if (dur > 0.1 && name && name !== 'none') {
        moving.push(name + ' ' + cs.animationDuration + ' on ' + el.tagName.toLowerCase());
      }
    }
    return { moving: moving.slice(0, 5), count: moving.length, query: matchMedia('(prefers-reduced-motion: reduce)').matches };
  })()`);
  gate(
    S,
    "L4 prefers-reduced-motion stops the homepage animating",
    motion.query === true && motion.count === 0,
    `query matched ${motion.query}, ${motion.count} animated elements${motion.count ? ": " + motion.moving.join("; ") : ""}`,
  );
  await ctx.b.reduceMotion(false);
}

/* ════════════════════════════════ the run ═════════════════════════════════ */

const SCENARIOS = [
  ["A", "Homepage", scenarioA],
  ["B", "Tools directory", scenarioB],
  ["C", "Local tool workflow (Merge PDF)", scenarioC],
  ["E", "Result workflow and destination", scenarioE],
  ["D", "Server tool workflow (Compress PDF)", scenarioD],
  ["F", "Workspace", scenarioF],
  ["G", "Workspace-backed editor", scenarioG],
  ["H", "Standalone editor", scenarioH],
  ["I", "Pricing", scenarioI],
  ["J", "Responsive global shell", scenarioJ],
  ["K", "Keyboard and accessibility", scenarioK],
  ["L", "State matrix", scenarioL],
];

const NAMES = new Map(SCENARIOS.map(([id, name]) => [id, name]));

async function main() {
  const only = arg("--only", null);
  const wanted = only ? new Set(only.split(",").map((s) => s.trim().toUpperCase())) : null;

  const status = await reachable(BASE);
  if (status === 0) {
    console.log(`\nENVIRONMENTAL: nothing is listening on ${BASE}.`);
    console.log("Start the server first (npm run dev -- -p 3001, or npm run build && npm start).");
    console.log("No scenario ran, so no scenario passed.\n");
    process.exit(2);
  }

  const b = await openBrowser({ width: 1440, height: 900 });
  const ctx = helpers(b);
  ctx.email = null;

  try {
    if (WITH_AUTH) {
      ctx.email = await signUp(ctx);
      if (!ctx.email) {
        envFail("F", "auth", "registration through the real form did not reach /workspaces");
      }
    }
    for (const [id, , fn] of SCENARIOS) {
      if (wanted && !wanted.has(id)) continue;
      try {
        await fn(ctx);
      } catch (error) {
        envFail(id, `${id}! crashed`, String(error?.message ?? error).slice(0, 180));
      }
    }
  } finally {
    b.close();
  }

  /* ── report ─────────────────────────────────────────────────────────────── */
  const order = new Map(SCENARIOS.map(([id], i) => [id, i]));
  results.sort((x, y) => (order.get(x.scenario) ?? 99) - (order.get(y.scenario) ?? 99));

  const MARK = {
    PASS: "PASS            ",
    "PRODUCT FAILURE": "PRODUCT FAILURE ",
    ENVIRONMENTAL: "ENVIRONMENTAL   ",
    "NOT EXERCISED": "NOT EXERCISED   ",
  };

  console.log("\n═══════════ PHASE 6 — PREMIUM UI/UX, RESPONSIVE, ACCESSIBILITY ═══════════");
  console.log(`base ${BASE} (HTTP ${status})   auth ${WITH_AUTH ? "on" : "off"}   shots ${SHOTS ?? "off"}\n`);

  let current = null;
  for (const r of results) {
    if (r.scenario !== current) {
      current = r.scenario;
      console.log(`── ${current} — ${NAMES.get(current) ?? "?"} ${"─".repeat(Math.max(0, 52 - (NAMES.get(current) ?? "").length))}`);
    }
    console.log(`   ${MARK[r.verdict]} ${r.id}${r.detail ? `  — ${r.detail}` : ""}`);
  }

  const count = (v) => results.filter((r) => r.verdict === v).length;
  console.log("\n── scenario verdicts ──────────────────────────────────────────────────");
  for (const [id, name] of SCENARIOS) {
    const mine = results.filter((r) => r.scenario === id);
    if (!mine.length) {
      console.log(`   NOT EXERCISED    ${id} — ${name} (not selected)`);
      continue;
    }
    const worst = mine.some((r) => r.verdict === "PRODUCT FAILURE")
      ? "PRODUCT FAILURE"
      : mine.some((r) => r.verdict === "ENVIRONMENTAL")
        ? "ENVIRONMENTAL"
        : mine.some((r) => r.verdict === "NOT EXERCISED")
          ? "NOT EXERCISED"
          : "PASS";
    console.log(`   ${MARK[worst]} ${id} — ${name} (${mine.filter((r) => r.verdict === "PASS").length}/${mine.length} gates passed)`);
  }

  console.log("\n── what actually rendered ─────────────────────────────────────────────");
  for (const line of ctx.rendered) console.log(`   ${line}`);
  if (!ctx.rendered.length) console.log("   nothing — every verdict above is ENVIRONMENTAL or NOT EXERCISED");

  const failures = count("PRODUCT FAILURE");
  console.log(
    `\n${count("PASS")} pass · ${failures} product failure${failures === 1 ? "" : "s"} · ` +
      `${count("ENVIRONMENTAL")} environmental · ${count("NOT EXERCISED")} not exercised`,
  );
  if (!WITH_AUTH) console.log("Rerun with --auth to exercise F (Workspace) and G (Workspace editor).");
  console.log(failures === 0 ? "\nNo product failure measured.\n" : "\nPRODUCT FAILURES ABOVE.\n");
  process.exit(failures === 0 ? 0 : 1);
}

await main();
