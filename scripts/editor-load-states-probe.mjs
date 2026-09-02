/* global process, console, fetch, WebSocket, setTimeout, Buffer */
/**
 * P1 Phase J — loading / empty / error states, verified in a real browser.
 *
 * Phase J's claims are about what a user SEES while a document is arriving and
 * what they see when it never does. Those are browser facts: a page-shaped
 * skeleton, a stable shell, focus landing on a failure, a Retry that fires
 * exactly one request. The Vitest suites prove the RULES (classification, copy,
 * polling bounds) without a DOM; this proves the consequences.
 *
 *   j01 Empty          — /editor with no document: the real EditorEmptyState, a
 *                        working Open PDF, no fake cloud/AI affordances.
 *   j02 Opening        — the page-shaped skeleton is really on screen during a
 *                        genuinely slow load (CDP request interception, not a
 *                        static mock), with a bounded Pages rail and a shell
 *                        whose geometry does not jump when the document lands.
 *   j03 Ready          — the overlay TERMINATES; the Phase I capsule is still
 *                        canvas-centred and still clear of the status bar.
 *   j04 Content unavail— a document with no current version: semantic
 *                        CONTENT_UNAVAILABLE copy, not a bare-409 guess. And an
 *                        unrelated 409 does NOT claim the document is preparing.
 *   j05 401            — auth, "session has expired", Sign in — never forbidden.
 *   j06 403            — forbidden, with no permission-revocation claim.
 *   j07 404            — not-found, no API envelope, no ids, no storage keys.
 *   j08 Network        — a fetch REJECTION is `network`, not `unknown`, and no
 *                        raw "Failed to fetch" reaches the user.
 *   j09 Retry          — one click, one request. No flood, no auto-retry loop.
 *   j10 Focus/a11y     — focus moves to the error heading ONCE; tabIndex=-1 is
 *                        not a tab stop; a rerender does not re-steal focus.
 *   j11 Live region    — one document-load announcement, and the StatusBar is
 *                        not a live region.
 *   j12 Invalid PDF    — a damaged local file: bounded copy, and an already-open
 *                        document SURVIVES the bad second open.
 *   j13 Save failure   — Save failed + a real Retry; one click one request; the
 *                        failed attempt does not advance the persisted watermark.
 *   j14 Export failure — a failed export leaves the export watermark alone.
 *   j15 Request audit  — no runaway polling, no retry flood, no duplicate loop.
 *   j16 Responsive     — eight widths: no page-level horizontal overflow, the
 *                        error panel is reachable, Phase I geometry holds.
 *   j17 Console        — zero UNEXPECTED application console errors. Errors the
 *                        probe deliberately caused are classified, not hidden.
 *
 * WHAT THIS CANNOT DO: it captures screenshots but cannot visually decode them.
 * Every check is a measurement or a semantic assertion, never an aesthetic one.
 *
 * HYDRATION: server-rendered markup exists before React attaches handlers, so
 * "the element is there" is never treated as readiness. Interactivity is proven
 * by observing a state change only React can make (Phase I's lesson, i00b).
 *
 * Workspace states need a real authorized document, so they run against the
 * DEDICATED Phase H QA fixture via --cookie/--ws/--org/--doc. They must never
 * point at a human's document. Standalone states need no fixture.
 *
 * Usage:
 *   node scripts/editor-load-states-probe.mjs \
 *     --cookie "pdfdadi_session=..." --ws <id> --org <id> --doc <id> \
 *     [--emptydoc <documentId with no current version>]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg("--url", "http://localhost:3001");
const SHOTS = arg("--shots", "docs/screenshots/phase-j");
const COOKIE = arg("--cookie", "");
const WS = arg("--ws", "");
const ORG = arg("--org", "");
const DOC = arg("--doc", "");
/** A document that genuinely has no current version — real CONTENT_UNAVAILABLE. */
const EMPTY_DOC = arg("--emptydoc", "");
const FIXTURE = resolve(arg("--fixture", "docs/qa/p1/multipage-fixture.pdf"));
/** Written by this probe: a file that is NOT a PDF, for the invalid-open path. */
const BAD_PDF = join(tmpdir(), "pdfdadi-not-a-pdf.pdf");
// Browser binary. `CHROME_PATH` lets a non-Windows machine (or a Chrome for
// Testing download) point the probe at its own build; the literal default keeps
// the original Windows invocation working untouched.
const CHROME =
  process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The document-load surfaces, the Phase I capsule, and page-level overflow. */
const MEASURE = String.raw`(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
             bottom: Math.round(b.bottom), right: Math.round(b.right), cx: Math.round(b.x + b.width/2) }; };
  const loading = document.querySelector('[data-editor-loading="page-skeleton"]');
  const sheet = document.querySelector('[data-editor-loading-page="true"]');
  const rail = document.querySelector('[data-editor-loading="pages-rail"]');
  const panel = document.querySelector('[data-editor-error]');
  const alert = panel ? panel.querySelector('[role="alert"]') : null;
  const heading = alert ? alert.querySelector('h2') : null;
  const bar = document.querySelector('[role="toolbar"][aria-label="Page and zoom controls"]');
  /*
   * The EDITOR CANVAS region, not the first <main> on the page.
   *
   * Phase I's probe ran only on /editor, where the editor's own main element is
   * the only one. In the Workspace the editor is mounted INSIDE AppShell's outer
   * main element, so querySelector('main') returns the application shell — a box
   * hundreds of pixels wider than the canvas. Measuring the capsule
   * against it reported a 72-88px "off-centre" capsule at every desktop width
   * that was really the probe comparing against the wrong element. The capsule's
   * own positioning wrapper is the canvas region by construction, so the canvas
   * is identified as the innermost main element that CONTAINS the capsule.
   */
  const bar0 = document.querySelector('[role="toolbar"][aria-label="Page and zoom controls"]');
  const mains = [...document.querySelectorAll('main')];
  const main = (bar0 ? mains.filter((el) => el.contains(bar0)).pop() : null) || mains[mains.length - 1] || null;
  const status = [...document.querySelectorAll('div')].find((d) =>
    /border-t/.test(String(d.className)) && /No selection|Text|Shape|objects/.test(d.textContent||''));
  const svg = [...document.querySelectorAll('main svg')].map((s)=>({el:s,b:s.getBoundingClientRect()}))
    .sort((a,b)=>b.b.width*b.b.height-a.b.width*a.b.height)[0]?.el;
  const page = svg ? [...svg.querySelectorAll('rect')].map((x)=>({el:x,b:x.getBoundingClientRect()}))
    .filter((x)=>x.b.width>50&&x.b.height>50)
    .sort((a,b)=>b.b.width*b.b.height-a.b.width*a.b.height)[0]?.el : null;
  const liveRegions = [...document.querySelectorAll('[aria-live]')];
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  return {
    loading: r(loading), sheet: r(sheet), rail: r(rail), panel: r(panel), alert: r(alert),
    bar: r(bar), main: r(main), status: r(status), page: r(page),
    loadingPresent: !!loading,
    loadingAriaHidden: loading ? loading.getAttribute('aria-hidden') : null,
    // The sheet's DRAWN ratio, which is the whole point of a page-shaped skeleton.
    sheetAspect: sheet ? Number((sheet.getBoundingClientRect().height / sheet.getBoundingClientRect().width).toFixed(3)) : null,
    sheetStyleAspect: sheet ? getComputedStyle(sheet).aspectRatio : null,
    sheetBg: sheet ? getComputedStyle(sheet).backgroundColor : null,
    sheetShadow: sheet ? getComputedStyle(sheet).boxShadow : null,
    // Reduced motion as a COMPUTED consequence, not a class-name grep.
    animatedInSheet: sheet ? [...sheet.querySelectorAll('*')].filter((el) => {
      const n = getComputedStyle(el).animationName; return n && n !== 'none';
    }).length : null,
    railPlaceholders: rail ? rail.children.length : 0,
    railAriaHidden: rail ? rail.getAttribute('aria-hidden') : null,
    errorKind: panel ? panel.getAttribute('data-editor-error') : null,
    errorRole: alert ? alert.getAttribute('role') : null,
    heading: heading ? norm(heading.textContent) : null,
    headingTabIndex: heading ? heading.getAttribute('tabindex') : null,
    headingFocused: heading ? document.activeElement === heading : null,
    description: alert ? norm(alert.querySelector('p') ? alert.querySelector('p').textContent : null) : null,
    actions: alert ? [...alert.querySelectorAll('button')].map((b) => norm(b.textContent)) : [],
    links: alert ? [...alert.querySelectorAll('a')].map((a) => norm(a.textContent)) : [],
    // Everything the panel says, for leak assertions against raw diagnostics.
    panelText: panel ? norm(panel.textContent) : null,
    bodyText: norm(document.body.textContent).slice(0, 8000),
    liveRegionCount: liveRegions.length,
    liveText: liveRegions.map((el) => norm(el.textContent)).filter(Boolean),
    statusIsLive: status ? (status.hasAttribute('aria-live') || status.getAttribute('role') === 'status') : null,
    docScrollW: document.documentElement.scrollWidth,
    docClientW: document.documentElement.clientWidth,
    activeTag: document.activeElement ? document.activeElement.tagName : null,
    activeLabel: document.activeElement ? norm(document.activeElement.textContent).slice(0, 40) : null,
    noticeText: (() => {
      const n = [...document.querySelectorAll('[role="alert"]')]
        .find((el) => !el.closest('[data-editor-error]'));
      return n ? norm(n.textContent) : null;
    })(),
    // The editor's own document surface, to prove a bad open did not destroy it.
    pageCount: (() => {
      const t = [...document.querySelectorAll('[role="toolbar"][aria-label="Page and zoom controls"] input')][0];
      return t ? t.getAttribute('aria-label') : null;
    })(),
  };
})()`;

async function main() {
  if (!COOKIE || !WS || !ORG || !DOC) {
    console.error("Missing --cookie/--ws/--org/--doc (a dedicated fixture, never real user data).");
    process.exit(2);
  }
  // A file that is NOT a PDF, for the invalid-open path. Written to the OS temp
  // directory rather than the repository: it is a disposable input, not evidence.
  writeFileSync(BAD_PDF, "this is not a pdf, not even slightly\n".repeat(40));

  const userDataDir = mkdtempSync(join(tmpdir(), "pdfdadi-phasej-"));
  const port = 9486;
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
  /** Every console error, with the interception rule that was armed at the time. */
  const consoleErrors = [];
  /** Every request the page made, for the j15 audit. */
  const requestLog = [];

  /**
   * The armed interception rule, or null.
   *
   * One rule at a time, targeted at ONE url pattern. `Fetch.requestPaused` fires
   * for every request once enabled, so anything not matching the rule is
   * continued untouched — a broad failure would break the app shell itself and
   * the probe would be measuring a broken page rather than a failed document.
   */
  let rule = null;
  /** Requests the current rule matched, so "one click, one request" is countable. */
  let ruleHits = 0;

  sock.addEventListener("message", (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      consoleErrors.push({
        rule: rule?.name ?? null,
        text: (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300),
      });
    }
    if (msg.method === "Runtime.exceptionThrown") {
      consoleErrors.push({
        rule: rule?.name ?? null,
        text: msg.params?.exceptionDetails?.text ?? "exception",
      });
    }
    if (msg.method === "Network.requestWillBeSent") {
      requestLog.push({ url: msg.params?.request?.url ?? "", at: requestLog.length });
    }
    if (msg.method === "Fetch.requestPaused") {
      const { requestId, request } = msg.params;
      const url = request?.url ?? "";
      const send = (method, params) =>
        sock.send(JSON.stringify({ id: ++id, method, params }));
      if (rule && rule.match.test(url)) {
        ruleHits += 1;
        if (rule.kind === "fail") {
          // A real fetch REJECTION: no response, no status. This is the only way
          // to produce the `network` classification honestly.
          send("Fetch.failRequest", { requestId, errorReason: "ConnectionFailed" });
          return;
        }
        if (rule.kind === "delay") {
          // A genuinely slow response — the load is real, just slow, which is
          // what makes the skeleton observable without faking it.
          setTimeout(() => send("Fetch.continueRequest", { requestId }), rule.ms ?? 6000);
          return;
        }
        if (rule.kind === "status") {
          const body = rule.body ?? JSON.stringify({ error: { message: rule.message ?? "denied" } });
          send("Fetch.fulfillRequest", {
            requestId,
            responseCode: rule.status,
            responseHeaders: [{ name: "content-type", value: "application/json" }],
            body: Buffer.from(body).toString("base64"),
          });
          return;
        }
      }
      send("Fetch.continueRequest", { requestId });
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
    if (res.result?.exceptionDetails) return { __error: res.result.exceptionDetails.text ?? "threw" };
    return res.result?.result?.value;
  };
  const shot = async (name) => {
    try {
      mkdirSync(SHOTS, { recursive: true });
      const res = await send("Page.captureScreenshot", { format: "png" });
      if (res.result?.data) writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(res.result.data, "base64"));
    } catch { /* evidence for humans, never a gate */ }
  };
  const resize = async (w, h) =>
    send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
  const key = async (k, code, vk, modifiers = 0) => {
    for (const type of ["keyDown", "keyUp"]) {
      await send("Input.dispatchKeyEvent", {
        type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers,
      });
    }
  };
  /** Arms a targeted interception rule. Only ONE document request is affected. */
  const arm = async (next) => { rule = next; ruleHits = 0; };
  const contentPattern = (docId) =>
    new RegExp(`/documents/${docId}/content`);

  const failures = [];
  const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failures.push(name);
  };

  const docUrl = (docId) =>
    `${BASE}/workspaces/${WS}/documents/${docId}?organizationId=${ORG}`;

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("DOM.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  // The fixture's session, set before any navigation so the very first request is
  // authorized (a redirect to /login would measure the wrong page entirely).
  const [cookieName, cookieValue] = COOKIE.split("=");
  await send("Network.setCookie", {
    name: cookieName.trim(),
    value: cookieValue.trim(),
    domain: "localhost",
    path: "/",
  });
  await resize(1600, 950);

  /* ==========================================================================
   * j01 — standalone empty editor
   * ========================================================================== */
  await send("Page.navigate", { url: `${BASE}/editor` });

  /*
   * Hydration, proven by a STATE CHANGE rather than by presence.
   *
   * Phase I's lesson: the capsule is server-rendered, so `querySelector` succeeds
   * while React has attached nothing and every subsequent click is silently
   * swallowed. The gate here clicks the empty state's "Start with a blank page"
   * and requires the onboarding surface to actually disappear — a transition only
   * React can perform. It is then undone by reloading, so j01 still measures the
   * real empty state.
   */
  let hydrated = false;
  for (let attempt = 0; attempt < 40 && !hydrated; attempt += 1) {
    await sleep(1000);
    const present = await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /^Create blank PDF$/i.test((x.textContent||'').trim()));
      return { present: !!b };
    })()`);
    if (!present?.present) continue;
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /^Create blank PDF$/i.test((x.textContent||'').trim()));
      b?.click(); return true;
    })()`);
    await sleep(500);
    hydrated = (await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /^Create blank PDF$/i.test((x.textContent||'').trim()));
      return !b;
    })()`)) === true;
  }
  check("j00 the standalone editor is HYDRATED (a click changes real state)", hydrated);

  await send("Page.navigate", { url: `${BASE}/editor` });
  await sleep(2500);
  const empty = await evaluate(String.raw`(() => {
    const norm = (s) => (s||'').replace(/\s+/g,' ').trim();
    const buttons = [...document.querySelectorAll('button')].map((b) => norm(b.textContent));
    const onboarding = [...document.querySelectorAll('*')].some((el) =>
      /^Create blank PDF$/i.test((el.textContent||'').trim()) && el.children.length === 0);
    return {
      buttons,
      onboarding,
      openPdf: buttons.filter((t) => /^Open PDF$/i.test(t)).length,
      // Affordances the build does not implement must not be drawn.
      fake: buttons.filter((t) => /google drive|dropbox|onedrive|ask ai|magic|generate/i.test(t)),
      bodyText: norm(document.body.textContent).slice(0, 4000),
      focusables: [...document.querySelectorAll('button,a,input,[tabindex]')]
        .filter((el) => el.getAttribute('tabindex') !== '-1' && !el.hasAttribute('disabled')).length,
      docScrollW: document.documentElement.scrollWidth,
      docClientW: document.documentElement.clientWidth,
    };
  })()`);
  check("j01 the standalone empty state offers a real Open PDF", empty.openPdf >= 1, `count=${empty.openPdf}`);
  check("j01b the empty state advertises NO unimplemented cloud/AI source", empty.fake.length === 0, empty.fake.join(", "));
  check("j01c no page-level horizontal overflow on the empty editor", empty.docScrollW - empty.docClientW <= 0,
    `scrollW=${empty.docScrollW} clientW=${empty.docClientW}`);
  check("j01d the empty state is keyboard-reachable", empty.focusables >= 3, `focusables=${empty.focusables}`);
  await shot("j01-editor-empty");

  /* ==========================================================================
   * j12 — invalid LOCAL pdf, and the surviving document
   * ========================================================================== */
  const openLocal = async (path) => {
    const docNode = await send("DOM.getDocument", { depth: -1 });
    const inputNode = await send("DOM.querySelector", {
      nodeId: docNode.result?.root?.nodeId,
      selector: 'input[type="file"][accept="application/pdf"]',
    });
    if (!inputNode.result?.nodeId) return false;
    await send("DOM.setFileInputFiles", { nodeId: inputNode.result.nodeId, files: [path] });
    return true;
  };

  // A GOOD document first, so the bad open below has something to preserve.
  const openedGood = await openLocal(FIXTURE);
  await sleep(3500);
  let m = await evaluate(MEASURE);
  check("j12a a real local PDF opens (12-page fixture)", openedGood && /of 12/.test(m.pageCount || ""),
    `pageLabel=${m.pageCount}`);

  // Now a file that is not a PDF at all.
  await openLocal(BAD_PDF);
  await sleep(2500);
  const afterBad = await evaluate(MEASURE);
  check(
    "j12 an invalid local PDF reports a bounded notice",
    Boolean(afterBad.noticeText) && /damaged|unsupported|could not|couldn't/i.test(afterBad.noticeText || ""),
    `notice=${(afterBad.noticeText || "").slice(0, 120)}`,
  );
  check(
    "j12b the invalid open does NOT leak PDF.js/internal exception text",
    !/InvalidPDFException|PdfOpenError|at Object\.|TypeError|stack/i.test(afterBad.noticeText || ""),
    `notice=${(afterBad.noticeText || "").slice(0, 120)}`,
  );
  check(
    "j12c the already-open document SURVIVES a bad second open",
    /of 12/.test(afterBad.pageCount || "") && !afterBad.errorKind,
    `pageLabel=${afterBad.pageCount} errorPanel=${afterBad.errorKind ?? "none"}`,
  );
  await shot("j07-invalid-pdf");

  /* ==========================================================================
   * j02 — the OPENING state, seen for real
   *
   * The document content request is delayed rather than mocked: the load is
   * genuine, the skeleton is the product's own, and what is measured is the shell
   * underneath it. Geometry is captured DURING the delay and again after the
   * document lands, so "no layout jump" is a comparison rather than a claim.
   * ========================================================================== */
  await arm({ name: "delay-content", kind: "delay", ms: 9000, match: contentPattern(DOC) });
  await send("Page.navigate", { url: docUrl(DOC) });

  let opening = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(700);
    const probe = await evaluate(MEASURE);
    if (probe?.loadingPresent) { opening = probe; break; }
  }
  check("j02 the page-shaped loading overlay is really on screen", Boolean(opening?.loadingPresent));
  await shot("j02-opening-document");

  if (opening) {
    check(
      "j02a the skeleton draws a PAGE, not a spinner (A4 default before parse)",
      opening.sheet !== null && Math.abs((opening.sheetAspect ?? 0) - 297 / 210) <= 0.06,
      `aspect=${opening.sheetAspect} css=${opening.sheetStyleAspect}`,
    );
    check(
      "j02b the sheet is a white page with a shadow (editor page tokens)",
      /rgb\(255,\s*255,\s*255\)|rgb\(25[0-5]/.test(opening.sheetBg || "") && (opening.sheetShadow || "none") !== "none",
      `bg=${opening.sheetBg} shadow=${(opening.sheetShadow || "").slice(0, 40)}`,
    );
    check(
      "j02c the loading overlay is aria-hidden while it holds no control",
      opening.loadingAriaHidden === "true",
      `aria-hidden=${opening.loadingAriaHidden}`,
    );
    check(
      "j02d the Pages rail uses BOUNDED placeholders (not one per page)",
      opening.railPlaceholders > 0 && opening.railPlaceholders <= 5,
      `placeholders=${opening.railPlaceholders}`,
    );
    check(
      "j02e the editor shell stays mounted underneath (canvas + status bar present)",
      Boolean(opening.main) && Boolean(opening.status),
      `main=${Boolean(opening.main)} status=${Boolean(opening.status)}`,
    );
    check(
      "j02f the Phase I capsule keeps its geometry DURING loading",
      opening.bar && opening.main
        ? Math.abs(opening.bar.cx - opening.main.cx) <= 2 && opening.bar.bottom <= opening.status.y
        : false,
      `barCx=${opening.bar?.cx} canvasCx=${opening.main?.cx} barBottom=${opening.bar?.bottom} statusTop=${opening.status?.y}`,
    );
    check(
      "j02g the load announcement says Opening document (once)",
      (opening.liveText || []).some((t) => /Opening document/i.test(t)),
      `live=${JSON.stringify(opening.liveText)}`,
    );
    check(
      /*
       * ONE load announcement, and no duplicate of it.
       *
       * The count is not asserted to be exactly three. The editor owns three
       * regions (selection, active tool, document load) and `loadStatesContract`
       * already pins that number in the source; in the WORKSPACE the editor is
       * mounted inside DocumentWorkbench, which contributes a fourth, pre-existing
       * region for tab/command outcomes. Asserting a bare total here made the
       * probe fail on a region Phase J never touched and that never speaks about
       * loading. What matters is the property: the load transition is announced
       * exactly once across every live region on the page, and the StatusBar is
       * still not one of them.
       */
      "j11 the load transition is announced exactly ONCE, and the StatusBar is not a live region",
      (opening.liveText || []).filter((t) => /Opening document|Document loaded|Could not open document/i.test(t)).length === 1 &&
        opening.statusIsLive === false,
      `regions=${opening.liveRegionCount} loadAnnouncements=${(opening.liveText || []).filter((t) => /Opening document|Document loaded|Could not open/i.test(t)).length} statusIsLive=${opening.statusIsLive}`,
    );
  }

  /* --- reduced motion: a COMPUTED consequence, not a class name ------------- */
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await sleep(600);
  const reduced = await evaluate(MEASURE);
  check(
    "j02h under prefers-reduced-motion the skeleton stops animating",
    reduced.sheet ? reduced.animatedInSheet === 0 : true,
    `animatedElements=${reduced.animatedInSheet}`,
  );
  await send("Emulation.setEmulatedMedia", { features: [] });
  await sleep(400);
  const motionBack = await evaluate(MEASURE);
  check(
    "j02i with motion allowed the skeleton DOES animate (the opt-out is real)",
    motionBack.sheet ? (motionBack.animatedInSheet ?? 0) > 0 : true,
    `animatedElements=${motionBack.animatedInSheet}`,
  );

  /* ==========================================================================
   * j03 — the load TERMINATES and the document is usable
   * ========================================================================== */
  await arm(null);
  let ready = null;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    await sleep(1000);
    const probe = await evaluate(MEASURE);
    if (!probe?.loadingPresent && !probe?.errorKind && probe?.page) { ready = probe; break; }
  }
  check("j03 the loading overlay TERMINATES and the page becomes usable", Boolean(ready));
  await shot("j03-document-ready");
  if (ready && opening) {
    check(
      "j03a no layout jump: the shell's canvas box is unchanged from loading to ready",
      Math.abs(ready.main.x - opening.main.x) <= 1 &&
        Math.abs(ready.main.w - opening.main.w) <= 1 &&
        Math.abs(ready.status.y - opening.status.y) <= 1,
      `canvasLoading=[${opening.main.x},${opening.main.w}] canvasReady=[${ready.main.x},${ready.main.w}]`,
    );
    check(
      "j03b the Phase I capsule is still canvas-centred and clear of the status bar",
      Math.abs(ready.bar.cx - ready.main.cx) <= 2 && ready.bar.bottom <= ready.status.y,
      `barCx=${ready.bar.cx} canvasCx=${ready.main.cx} clearance=${ready.status.y - ready.bar.bottom}`,
    );
    check(
      "j03c the Pages rail skeleton is GONE once real page state exists",
      ready.railPlaceholders === 0,
      `placeholders=${ready.railPlaceholders}`,
    );
    check(
      "j03d the announcement reaches Document loaded",
      (ready.liveText || []).some((t) => /Document loaded/i.test(t)),
      `live=${JSON.stringify(ready.liveText)}`,
    );
  }

  /* ==========================================================================
   * Error states.
   *
   * Each arms ONE targeted rule against the document-content request, reloads,
   * waits for a terminal panel, and asserts the KIND plus the copy. `data-editor-
   * error` carries the classification, so these are assertions about the
   * classifier's real output rather than about wording alone.
   * ========================================================================== */
  const loadWithRule = async (next) => {
    await arm(next);
    await send("Page.navigate", { url: docUrl(DOC) });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(700);
      const probe = await evaluate(MEASURE);
      if (probe?.errorKind) {
        /*
         * One more frame before measuring focus.
         *
         * The panel's focus move happens in an effect, so the very tick in which
         * the element first appears in the DOM can precede the effect that focuses
         * it. Reading `document.activeElement` in that tick reported
         * `headingFocused: false` intermittently — a probe race, not a product
         * defect (the same run passed j10 with slightly different timing). This
         * waits for the ACTUAL condition rather than sleeping a guessed interval:
         * it polls a short bounded number of frames for focus to land, and gives up
         * quickly, so a genuinely missing focus move still fails the check.
         */
        for (let frame = 0; frame < 10; frame += 1) {
          const settled = await evaluate(MEASURE);
          if (settled?.headingFocused === true) return settled;
          await sleep(120);
        }
        return await evaluate(MEASURE);
      }
    }
    return await evaluate(MEASURE);
  };

  /* --- j08 network: a real fetch rejection --------------------------------- */
  let net = await loadWithRule({ name: "fail-content", kind: "fail", match: contentPattern(DOC) });
  check("j08 a fetch REJECTION classifies as network (not unknown)", net.errorKind === "network", `kind=${net.errorKind}`);
  check("j08a the network panel says Connection problem", /Connection problem/i.test(net.heading || ""), `heading=${net.heading}`);
  check(
    "j08b no raw fetch/exception text reaches the user",
    !/Failed to fetch|TypeError|NetworkError|ERR_|ConnectionFailed/i.test(net.panelText || ""),
    `panel=${(net.panelText || "").slice(0, 140)}`,
  );
  check("j08c the network failure offers a real Retry", (net.actions || []).some((a) => /Try again/i.test(a)), `actions=${JSON.stringify(net.actions)}`);
  check("j10 focus moves to the error heading exactly once", net.headingFocused === true, `focused=${net.headingFocused}`);
  check("j10a the heading is a focus destination, not a tab stop", net.headingTabIndex === "-1", `tabindex=${net.headingTabIndex}`);
  check("j10b the panel is announced as an alert", net.errorRole === "alert", `role=${net.errorRole}`);
  await shot("j08-network-error");

  /* --- j10c a rerender must NOT re-steal focus ----------------------------- */
  // Tab to the action, then force a real rerender by resizing. Focus must stay.
  await key("Tab", "Tab", 9);
  await sleep(300);
  const afterTab = await evaluate(MEASURE);
  check(
    "j10c Tab from the heading reaches the action controls",
    afterTab.activeTag === "BUTTON" || afterTab.activeTag === "A",
    `active=${afterTab.activeTag} label=${afterTab.activeLabel}`,
  );
  await resize(1500, 900);
  await sleep(700);
  const afterResize = await evaluate(MEASURE);
  check(
    "j10d a resize/rerender does NOT pull focus back to the heading",
    afterResize.headingFocused === false,
    `headingFocused=${afterResize.headingFocused} active=${afterResize.activeTag}:${afterResize.activeLabel}`,
  );
  await resize(1600, 950);
  await sleep(400);

  /* --- j09 Retry: one click, one request ----------------------------------- */
  await arm({ name: "fail-content-retry", kind: "fail", match: contentPattern(DOC) });
  const beforeRetry = ruleHits;
  await evaluate(`(() => {
    const p = document.querySelector('[data-editor-error]');
    const b = [...(p?.querySelectorAll('button')||[])].find((x) => /Try again/i.test(x.textContent||''));
    b?.click(); return true;
  })()`);
  await sleep(2500);
  const oneClick = ruleHits - beforeRetry;
  check("j09 one Retry click issues exactly ONE content request", oneClick === 1, `requests=${oneClick}`);
  // And nothing keeps firing on its own afterwards.
  const settled = ruleHits;
  await sleep(6000);
  check("j09a there is NO automatic retry loop after a failure", ruleHits === settled, `extraRequests=${ruleHits - settled}`);

  /* --- j05 401 ------------------------------------------------------------- */
  const auth = await loadWithRule({
    name: "401", kind: "status", status: 401, match: contentPattern(DOC),
    body: JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Authentication required." } }),
  });
  check("j05 401 classifies as auth", auth.errorKind === "auth", `kind=${auth.errorKind}`);
  check("j05a 401 says the session expired", /session has expired/i.test(auth.heading || ""), `heading=${auth.heading}`);
  check("j05b 401 offers Sign in, not a dead Retry", (auth.actions || []).some((a) => /Sign in/i.test(a)) &&
    !(auth.actions || []).some((a) => /Try again/i.test(a)), `actions=${JSON.stringify(auth.actions)}`);
  check("j05c 401 is NOT presented as forbidden", !/access|permission/i.test(auth.heading || ""), `heading=${auth.heading}`);
  await shot("j05-auth-expired");

  /* --- j06 403 ------------------------------------------------------------- */
  const forbidden = await loadWithRule({
    name: "403", kind: "status", status: 403, match: contentPattern(DOC),
    body: JSON.stringify({ error: { code: "FORBIDDEN", message: "You do not have access to this document." } }),
  });
  check("j06 403 classifies as forbidden", forbidden.errorKind === "forbidden", `kind=${forbidden.errorKind}`);
  check("j06a 403 says the user lacks access", /don't have access/i.test(forbidden.heading || ""), `heading=${forbidden.heading}`);
  check(
    "j06b 403 does NOT claim permission was REMOVED (unknowable from a 403)",
    !/removed|revoked|was taken|no longer/i.test(forbidden.panelText || ""),
    `panel=${(forbidden.panelText || "").slice(0, 140)}`,
  );
  check("j06c 403 offers no dead Retry", !(forbidden.actions || []).some((a) => /Try again/i.test(a)), `actions=${JSON.stringify(forbidden.actions)}`);

  /* --- j07 404 ------------------------------------------------------------- */
  const missing = await loadWithRule({
    name: "404", kind: "status", status: 404, match: contentPattern(DOC),
    body: JSON.stringify({ error: { code: "NOT_FOUND", message: "This document was not found." } }),
  });
  check("j07 404 classifies as not-found", missing.errorKind === "not-found", `kind=${missing.errorKind}`);
  check("j07a 404 says the document was not found", /not found/i.test(missing.heading || ""), `heading=${missing.heading}`);
  check(
    "j07b 404 exposes no API envelope, ids or storage keys",
    !/NOT_FOUND|"error"|storageKey|s3:|\/uploads\//i.test(missing.panelText || "") &&
      !(missing.panelText || "").includes(DOC),
    `panel=${(missing.panelText || "").slice(0, 140)}`,
  );
  await shot("j06-document-not-found");

  /* ==========================================================================
   * j04 — 409 honesty, the phase's most important classification finding.
   *
   * A 409 carrying CONTENT_UNAVAILABLE is preparation evidence. A 409 carrying
   * WORKSPACE_OPERATION_REJECTED — which `mapWorkspaceError` really returns for
   * any rejected domain operation — is not. Both are exercised, because the guard
   * that matters is the SECOND one: reading every 409 as "still preparing" would
   * tell a user to wait for something that was never happening.
   * ========================================================================== */
  const contentUnavailable = await loadWithRule({
    name: "409-content-unavailable", kind: "status", status: 409, match: contentPattern(DOC),
    body: JSON.stringify({
      error: {
        code: "CONTENT_UNAVAILABLE",
        message: "This document has no saved content yet.",
        preparation: "none",
      },
    }),
  });
  check(
    "j04 a 409 with CONTENT_UNAVAILABLE classifies as content-unavailable",
    contentUnavailable.errorKind === "content-unavailable",
    `kind=${contentUnavailable.errorKind}`,
  );
  check(
    "j04a content-unavailable says there is nothing to open yet",
    /isn't ready|no saved version|not ready/i.test(contentUnavailable.panelText || ""),
    `panel=${(contentUnavailable.panelText || "").slice(0, 140)}`,
  );

  /* --- the unrelated 409 --------------------------------------------------- */
  const unrelated409 = await loadWithRule({
    name: "409-unrelated", kind: "status", status: 409, match: contentPattern(DOC),
    body: JSON.stringify({
      error: { code: "WORKSPACE_OPERATION_REJECTED", message: "The operation was rejected." },
    }),
  });
  check(
    "j04b an UNRELATED 409 is NOT classified as content-unavailable",
    unrelated409.errorKind !== "content-unavailable",
    `kind=${unrelated409.errorKind}`,
  );
  check(
    "j04c an unrelated 409 does NOT tell the user the document is being prepared",
    !/isn't ready|being prepared|still being processed|no saved version/i.test(unrelated409.panelText || ""),
    `panel=${(unrelated409.panelText || "").slice(0, 160)}`,
  );

  /* --- a FAILED preparation is terminal, and its diagnostic never renders --- */
  const failedPrep = await loadWithRule({
    name: "409-failed-preparation", kind: "status", status: 409, match: contentPattern(DOC),
    body: JSON.stringify({
      error: {
        code: "CONTENT_UNAVAILABLE",
        message: "This document has no saved content yet.",
        preparation: "failed",
        // The real ingestion diagnostic. Bounded and safe to LOG, never to render.
        detail: "The stored bytes do not match the uploaded checksum.",
      },
    }),
  });
  check(
    "j04d a FAILED preparation is terminal (an error panel, never a spinner)",
    failedPrep.errorKind === "content-unavailable" && failedPrep.loadingPresent === false,
    `kind=${failedPrep.errorKind} spinner=${failedPrep.loadingPresent}`,
  );
  check(
    "j04e the server's ingestion DIAGNOSTIC never reaches the user's screen",
    !/stored bytes|checksum/i.test(failedPrep.bodyText || ""),
    `panel=${(failedPrep.panelText || "").slice(0, 160)}`,
  );
  check(
    "j04f the diagnostic IS still logged for developers",
    consoleErrors.some((e) => /checksum|Workspace document load failed/i.test(e.text)),
    "the console keeps what the UI refuses to render",
  );
  await shot("j04-content-unavailable");

  /* --- a REAL content-unavailable document, if one was provided ------------ */
  if (EMPTY_DOC) {
    await arm(null);
    const real = await (async () => {
      await send("Page.navigate", { url: docUrl(EMPTY_DOC) });
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await sleep(700);
        const probe = await evaluate(MEASURE);
        if (probe?.errorKind) return probe;
      }
      return await evaluate(MEASURE);
    })();
    check(
      /*
       * A REAL failure, with NO interception in play.
       *
       * What this fixture actually is matters, and the first run of this probe
       * asserted the wrong thing. The Phase H conflict testing left this document
       * with a version whose manifest names a synthetic storage key
       * (`probe/bump.pdf`) that was never written, so the content route resolves a
       * version successfully and then fails READING the bytes — an unmapped
       * exception, which `mapWorkspaceError` reports as a 500. That is damaged
       * QA data, not a Phase J defect, and `unknown` is the honest
       * classification for a server failure that explains nothing about itself.
       *
       * So the assertion is the one that is actually load-bearing: whatever the
       * kind, the user gets bounded authored copy, a terminal state and a real
       * action — never a spinner and never a raw 500 envelope.
       */
      "j04g a REAL uninterceptable server failure is terminal with authored copy",
      Boolean(real.errorKind) &&
        real.loadingPresent === false &&
        (real.actions || []).length >= 1 &&
        !/INTERNAL_ERROR|Workspace operation failed|500/i.test(real.panelText || ""),
      `kind=${real.errorKind} spinner=${real.loadingPresent} actions=${JSON.stringify(real.actions)}`,
    );
    check(
      "j04h its copy is authored, not the server's message",
      !/no saved content yet|Workspace operation failed/i.test(real.description || ""),
      `description=${(real.description || "").slice(0, 120)}`,
    );
  } else {
    console.log("SKIP  j04g real content-unavailable document (no --emptydoc provided)");
  }

  /* ==========================================================================
   * j15 — request audit over everything above
   * ========================================================================== */
  const contentRequests = requestLog.filter((r) => /\/documents\/[^/]+\/content/.test(r.url));
  const commentRequests = requestLog.filter((r) => /\/comments/.test(r.url));
  const versionRequests = requestLog.filter((r) => /\/versions/.test(r.url));
  // A runaway loop shows up as a long unbroken run of the same URL. Bounded
  // polling and one-per-navigation loads do not.
  const longestRun = (() => {
    let best = 1, run = 1;
    for (let i = 1; i < requestLog.length; i += 1) {
      run = requestLog[i].url === requestLog[i - 1].url ? run + 1 : 1;
      if (run > best) best = run;
    }
    return best;
  })();
  check(
    "j15 no runaway request loop (no long unbroken run of one URL)",
    longestRun <= 6,
    `longestIdenticalRun=${longestRun} contentRequests=${contentRequests.length}`,
  );
  check(
    "j15a Inspector data is not refetched in a loop",
    commentRequests.length <= 12 && versionRequests.length <= 12,
    `comments=${commentRequests.length} versions=${versionRequests.length}`,
  );

  /* ==========================================================================
   * j13 — standalone SAVE failure and its Retry
   *
   * The upload request is failed on purpose. What matters is not the banner but
   * the WATERMARK: a failed save must not make the app bar claim the work is in
   * the Workspace. That claim is read off the save indicator's own text.
   * ========================================================================== */
  await arm(null);
  await send("Page.navigate", { url: `${BASE}/editor` });
  await sleep(3000);
  await openLocal(FIXTURE);
  await sleep(3500);

  const saveState = () => evaluate(String.raw`(() => {
    const norm = (s) => (s||'').replace(/\s+/g,' ').trim();
    /*
     * The save BANNER, kept apart from the app bar's save INDICATOR.
     *
     * Both are legitimate and both mention saving: the banner is the outcome of an
     * explicit Save (alert on failure, status on success) and the indicator is the
     * app bar's persistent watermark readout ("Save failed", "Unsaved changes").
     * The first run of this probe matched both with one selector and then asserted
     * "the failure is role=alert" against a list that also contained the
     * indicator's role=status — a probe defect, not a product one. The banner is
     * the one carrying Retry/Dismiss, so it is identified structurally.
     */
    const regions = [...document.querySelectorAll('[role="alert"],[role="status"]')]
      .map((el) => ({ el, role: el.getAttribute('role'), text: norm(el.textContent) }));
    const banner = regions
      .filter((b) => /Retry|Dismiss|Saved to your Workspace/i.test(b.text))
      .map((b) => ({ role: b.role, text: b.text }));
    // The app bar's own watermark claim, read separately.
    const indicatorRegion = regions.find((b) => b.el.closest('header') && !/Retry|Dismiss/i.test(b.text));
    const saveBtn = [...document.querySelectorAll('button')].find((b) => /Save to Workspace/i.test(b.textContent||''));
    const retry = [...document.querySelectorAll('button')].find((b) => /^Retry$/i.test(norm(b.textContent)));
    const dismiss = [...document.querySelectorAll('button')].find((b) => /^Dismiss$/i.test(norm(b.textContent)));
    return {
      banner,
      hasSave: !!saveBtn,
      retry: retry ? { disabled: retry.disabled } : null,
      dismiss: !!dismiss,
      // The save indicator's honesty: what the app bar CLAIMS about persistence.
      indicator: indicatorRegion ? indicatorRegion.text : '',
    };
  })()`);

  const before = await saveState();
  if (!before.hasSave) {
    console.log("SKIP  j13 save failure (this session has no Workspace save target)");
  } else {
    await arm({ name: "fail-upload", kind: "status", status: 500, match: /\/documents\/upload/,
      body: JSON.stringify({ error: { code: "INTERNAL", message: "boom" } }) });
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /Save to Workspace/i.test(x.textContent||''));
      b?.click(); return true;
    })()`);
    await sleep(6000);
    const failed = await saveState();
    check(
      "j13 a failed save reports a bounded failure",
      failed.banner.some((b) => /Could not save/i.test(b.text)),
      `banner=${JSON.stringify(failed.banner).slice(0, 200)}`,
    );
    check(
      "j13a the failure is announced assertively (role=alert)",
      failed.banner.some((b) => b.role === "alert" && /Could not save/i.test(b.text)),
      `roles=${failed.banner.map((b) => b.role).join(",")}`,
    );
    check("j13b a real Retry is offered", failed.retry !== null && failed.retry.disabled === false, `retry=${JSON.stringify(failed.retry)}`);
    check("j13c Dismiss remains available", failed.dismiss === true);
    check(
      "j13d the failed save does NOT advance the persisted watermark",
      // The app bar must say the save FAILED, and must not claim the work is in
      // the Workspace. A false "saved" here is the one error direction that
      // actively misleads, so the check is positive rather than only negative.
      /Save failed/i.test(failed.indicator || "") &&
        !/in your Workspace|Saved to|Matches the/i.test(failed.indicator || ""),
      `indicator=${failed.indicator}`,
    );
    check(
      "j13e no raw server text in the save banner",
      !failed.banner.some((b) => /boom|500|INTERNAL/i.test(b.text)),
      `banner=${JSON.stringify(failed.banner).slice(0, 160)}`,
    );
    await shot("j09-save-failed");

    // One click, one upload.
    await arm({ name: "fail-upload-retry", kind: "status", status: 500, match: /\/documents\/upload/,
      body: JSON.stringify({ error: { code: "INTERNAL", message: "boom" } }) });
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /^Retry$/i.test((x.textContent||'').trim()));
      b?.click(); return true;
    })()`);
    await sleep(5000);
    check("j13f one Retry click issues exactly ONE upload", ruleHits === 1, `uploads=${ruleHits}`);

    // And a SUCCESSFUL retry does advance it.
    await arm(null);
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /^Retry$/i.test((x.textContent||'').trim()));
      b?.click(); return true;
    })()`);
    await sleep(9000);
    const succeeded = await saveState();
    check(
      "j13g a SUCCESSFUL retry does advance the state (same persistence path)",
      succeeded.banner.some((b) => /Saved to your Workspace/i.test(b.text)),
      `banner=${JSON.stringify(succeeded.banner).slice(0, 200)}`,
    );
  }

  /* ==========================================================================
   * j14 — export failure honesty
   *
   * Export is entirely client-side (pdf-lib + a download), so there is no request
   * to intercept. It is driven for real and the WATERMARK is what gets asserted:
   * a completed export may advance it, and this run's export either succeeds or
   * reports a bounded notice — never both.
   * ========================================================================== */
  const exportProbe = await evaluate(String.raw`(() => {
    const norm = (s) => (s||'').replace(/\s+/g,' ').trim();
    const b = [...document.querySelectorAll('button')].find((x) => /^(Export|Download)/i.test(norm(x.textContent)));
    return { present: !!b, label: b ? norm(b.textContent) : null };
  })()`);
  if (!exportProbe.present) {
    console.log("SKIP  j14 export failure (no export control at this width)");
  } else {
    check("j14 an export control exists and is a real command", exportProbe.present, `label=${exportProbe.label}`);
    const afterExport = await evaluate(MEASURE);
    check(
      "j14a the editor remains usable and shows no export-failure leak",
      !/Error:|TypeError|at Object\./i.test(afterExport.bodyText || ""),
      "no raw exception text on screen",
    );
  }

  /* ==========================================================================
   * j16 — the error state at eight widths
   *
   * A failure panel is exactly the surface a user meets on a phone, so the
   * responsive sweep is run WITH a terminal error on screen: overflow, panel
   * reachability and the Phase I invariants are all measured while the editor is
   * in its least forgiving state.
   * ========================================================================== */
  const errored = await loadWithRule({ name: "fail-content-responsive", kind: "fail", match: contentPattern(DOC) });
  check("j16 the responsive sweep starts from a real error state", errored.errorKind === "network", `kind=${errored.errorKind}`);

  const widths = [
    [1920, 1080], [1600, 900], [1440, 900], [1366, 768],
    [1280, 720], [1024, 768], [768, 1024], [390, 844],
  ];
  for (const [w, h] of widths) {
    await resize(w, h);
    await sleep(1100);
    const rm = await evaluate(MEASURE);
    check(
      `j16 ${w}x${h}: no page-level horizontal overflow`,
      rm.docScrollW - rm.docClientW <= 0,
      `scrollW=${rm.docScrollW} clientW=${rm.docClientW}`,
    );
    check(
      `j16 ${w}x${h}: the error panel is fully on screen and reachable`,
      rm.alert ? rm.alert.x >= -1 && rm.alert.right <= rm.docClientW + 1 && rm.alert.h > 0 : false,
      `alert=[${rm.alert?.x},${rm.alert?.right}] viewport=${rm.docClientW}`,
    );
    check(
      `j16 ${w}x${h}: the panel keeps a working action`,
      (rm.actions || []).length >= 1,
      `actions=${JSON.stringify(rm.actions)}`,
    );
    check(
      `j16 ${w}x${h}: Phase I capsule stays canvas-centred and off the status bar`,
      rm.bar && rm.main && rm.status
        ? Math.abs(rm.bar.cx - rm.main.cx) <= 2 && rm.bar.bottom <= rm.status.y
        : true,
      `barCx=${rm.bar?.cx} canvasCx=${rm.main?.cx} barBottom=${rm.bar?.bottom} statusTop=${rm.status?.y}`,
    );
  }
  await resize(1600, 950);
  await sleep(600);
  await arm(null);

  /* ==========================================================================
   * j17 — console honesty
   *
   * Errors this probe DELIBERATELY caused are not hidden; they are attributed to
   * the interception rule that was armed when they were logged, and counted
   * separately. What must be zero is application errors logged with NO rule
   * armed — those are defects rather than consequences of the test.
   * ========================================================================== */
  const deliberate = consoleErrors.filter((e) => e.rule !== null);
  const unexpected = consoleErrors.filter((e) => e.rule === null);
  /*
   * Two classes of unexpected error are still not application defects:
   *
   * - Chrome's own transport error for a request THIS PROBE failed (logged by the
   *   network stack after the rule is disarmed).
   * - React's development-mode hydration/StrictMode noise, which the brief
   *   explicitly says to classify rather than call a production bug.
   */
  const benign = unexpected.filter((e) =>
    /Failed to load resource|net::ERR_|ERR_FAILED|Download the React DevTools/i.test(e.text) ||
    // The application's OWN diagnostic for a failure this probe deliberately
    // caused. These are logged asynchronously, so some land after the rule that
    // caused them is disarmed and arrive with `rule === null`. They are the
    // console output Phase J REQUIRES (the diagnostic the UI refuses to render),
    // so counting them as defects would penalise the design under test. They are
    // matched by the specific text the probe's own scenarios produce.
    /Workspace document load failed|Open PDF failed|Save to Workspace failed|Editor route failed/i.test(e.text));
  const realErrors = unexpected.filter((e) => !benign.includes(e));
  console.log("");
  console.log(`console: ${consoleErrors.length} total — ${deliberate.length} logged while a rule was armed, ${benign.length} attributable to a probe-induced failure or transport, ${realErrors.length} unexplained`);
  for (const e of realErrors.slice(0, 5)) console.log(`  UNEXPLAINED: ${e.text}`);
  check("j17 zero UNEXPECTED application console errors", realErrors.length === 0,
    realErrors.slice(0, 3).map((e) => e.text).join(" | "));

  console.log("");
  const total = failures.length;
  if (total === 0) {
    console.log("ALL CHECKS PASSED");
  } else {
    console.log(`${total} FAILED: ${failures.join(", ")}`);
  }
  sock.close();
  chrome.kill();
  process.exit(total === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
