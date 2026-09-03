/* global process, console, Buffer, FormData, Blob, fetch */
/**
 * §18 evidence: page performance, workflow timing and concurrency capacity, measured
 * against a PRODUCTION build over the real network path.
 *
 * Three parts, selectable with `--part page|workflow|load` (default: all):
 *
 *  page      7 routes × N runs (default 3) of LCP, CLS, FCP, TTFB, hydration, a real
 *            interaction latency, transferred bytes, route JS and console errors.
 *            Reported as median (min–max) — a single run of a browser metric is a
 *            sample of the machine's mood, not a property of the page.
 *  workflow  the named operations across six fixture shapes (tiny, ordinary, large
 *            but allowed, many-page, encrypted, malformed), timed end to end.
 *  load      concurrency against the endpoints the product actually exposes, at
 *            rising fan-out, until something refuses — and then the refusal is read
 *            rather than assumed.
 *
 * WHAT THIS DOES NOT DO. It never runs against anything but a disposable local
 * server with a throwaway database, and it uses only fixtures generated here or
 * committed as QA inputs. Two ceilings are read from source before measuring, so a
 * refusal can be attributed instead of guessed: lib/server/concurrency.ts caps
 * simultaneous staging at TOOLS_MAX_CONCURRENCY (default 4) with a 20s wait and
 * then 503, and app/api/jobs/route.ts limits one client to
 * TOOLS_RATE_LIMIT_PER_MIN (default 20) per 60s window and then 429. Both are
 * in-process and single-instance.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { openBrowser, sleep } from "./lib/probe-browser.mjs";
import {
  DOWNLOAD_HOOK,
  abs,
  createWorkspace,
  makeDriver,
  signUpFresh,
  takeDownload,
} from "./lib/probe-drive.mjs";

const arg = (flag, d = null) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const BASE = arg("--url", "http://127.0.0.1:3002");
/*
 * WHY TWO ADDRESSES. The browser has to use the public origin: `requireSameOrigin`
 * trusts exactly `NEXT_PUBLIC_SITE_URL` in production, so a tab pointed at the bind
 * address cannot sign in or save anything. The HTTP measurements go straight to the
 * origin server instead, carrying that same public origin in the `Origin` header —
 * the check is satisfied honestly, and the numbers are the application's rather
 * than `scripts/tls-front.mjs`'s. A load ceiling measured through a 40-line test
 * proxy would be the proxy's ceiling reported as the product's.
 */
const API = arg("--api-url", BASE);
const CSRF = arg("--csrf-origin", BASE);
if (BASE.startsWith("https:")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const PARTS = (arg("--part", "page,workflow,load") || "").split(",").map((s) => s.trim());
const RUNS = Number(arg("--runs", "3"));
const JSON_OUT = arg("--json", null);
/** Restricts the workflow matrix to named shapes — for re-measuring one row. */
const ONLY = (arg("--shapes", "") || "").split(",").map((x) => x.trim()).filter(Boolean);
const PASSWORD = "Probe-Perf-9æ1";
const FIXTURES = "/tmp/perf-fixtures";

const rows = [];
const record = (part, name, metrics, note = "") => {
  rows.push({ part, name, metrics, note });
  // Printed as it happens, not only in the summary: this probe runs for the better
  // part of an hour, and a run that dies at minute 40 must not take its evidence with
  // it. The summary below re-renders the same rows.
  console.log(`  · ${part}/${name}: ${Object.entries(metrics).map(([k, v]) => `${k}=${v}`).join(" ")}`);
};
const median = (xs) => {
  const s = [...xs].filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const span = (xs) => {
  const s = [...xs].filter((x) => typeof x === "number" && Number.isFinite(x));
  return s.length ? `${median(s)} (${Math.min(...s)}–${Math.max(...s)})` : "—";
};
const ms = (t0) => Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
const now = () => process.hrtime.bigint();

/* ─────────────────────────── fixtures ─────────────────────────── */
/**
 * The six input shapes, generated into /tmp rather than committed: a 24MB PDF has
 * no business in a Git history, and the audit's own rule is not to commit uploaded
 * documents. Each is derived from a committed QA fixture so the content is known.
 */
const QA_PDF = "docs/qa/p1/multipage-fixture.pdf";
const QA_TINY = "docs/qa/final-prelaunch/second-fixture.pdf";
const QA_ENC = "docs/qa/final-prelaunch/encrypted-fixture.pdf";
const QA_JPG = "docs/qa/final-prelaunch/image-fixture.jpg";

async function buildFixtures() {
  mkdirSync(FIXTURES, { recursive: true });
  const large = `${FIXTURES}/large-fixture.pdf`;
  const many = `${FIXTURES}/manypage-fixture.pdf`;
  const bad = `${FIXTURES}/malformed-fixture.pdf`;
  if (!existsSync(bad)) {
    // A genuinely damaged PDF: a valid file cut mid-object, so the trailer and the
    // xref it points at are gone. Truncation, not a crafted payload.
    const src = readFileSync(abs(QA_PDF));
    writeFileSync(bad, src.subarray(0, Math.floor(src.length * 0.55)));
  }
  if (!existsSync(large) || !existsSync(many)) {
    const { PDFDocument } = await import("pdf-lib");
    if (!existsSync(large)) {
      // Each page embeds its OWN copy of the JPEG, so the bytes do not dedupe and
      // the file reaches a realistic size without re-encoding anything.
      const doc = await PDFDocument.create();
      const jpg = readFileSync(abs(QA_JPG));
      for (let i = 0; i < 340; i += 1) {
        const img = await doc.embedJpg(new Uint8Array(jpg));
        const page = doc.addPage([595, 842]);
        page.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
      }
      writeFileSync(large, await doc.save());
    }
    if (!existsSync(many)) {
      const src = await PDFDocument.load(readFileSync(abs(QA_PDF)));
      const doc = await PDFDocument.create();
      for (let i = 0; i < 25; i += 1) {
        const pages = await doc.copyPages(src, src.getPageIndices());
        for (const p of pages) doc.addPage(p);
      }
      writeFileSync(many, await doc.save());
    }
  }
  const shapes = [
    { key: "tiny", path: abs(QA_TINY) },
    { key: "ordinary", path: abs(QA_PDF) },
    { key: "large", path: large },
    { key: "many-page", path: many },
    { key: "encrypted", path: abs(QA_ENC) },
    { key: "malformed", path: bad },
  ];
  for (const s of shapes) s.kb = Math.round(statSync(s.path).size / 1024);
  return shapes;
}

/* ─────────────────────────── part 1: pages ─────────────────────────── */
/**
 * Installed before every navigation, because LCP, CLS and the interaction entries
 * are only observable from the first frame — an observer attached after load sees a
 * blank history and reports zero, which is the shape of a green number that means
 * nothing.
 */
const PERF_HOOK = `(() => {
  window.__perf = { lcp: 0, cls: 0, inp: 0, hydratedAt: null };
  const obs = (type, fn, extra = {}) => {
    try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true, ...extra }); } catch {}
  };
  obs("largest-contentful-paint", (e) => { window.__perf.lcp = e.startTime; });
  obs("layout-shift", (e) => { if (!e.hadRecentInput) window.__perf.cls += e.value; });
  obs("event", (e) => { if (e.interactionId) window.__perf.inp = Math.max(window.__perf.inp, e.duration); },
      { durationThreshold: 0 });
  /*
   * Hydration, as the moment React takes ownership of the server-rendered DOM: the
   * framework emits no mark for it, but React attaches its fiber keys to the host
   * nodes it adopts, and those appear only once hydration reaches them.
   */
  const tick = () => {
    if (window.__perf.hydratedAt !== null) return;
    const owned = [...document.querySelectorAll("main, main *, body > div")]
      .some((n) => { for (const k in n) if (k.startsWith("__react")) return true; return false; });
    if (owned) { window.__perf.hydratedAt = performance.now(); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()`;

const READ_PERF = `(() => {
  const nav = performance.getEntriesByType("navigation")[0] || {};
  const res = performance.getEntriesByType("resource");
  const kb = (f) => Math.round(res.filter(f).reduce((a, r) => a + (r.transferSize || 0), 0) / 1024);
  const fcp = performance.getEntriesByName("first-contentful-paint")[0];
  return {
    lcp: Math.round(window.__perf.lcp), cls: Number(window.__perf.cls.toFixed(4)),
    // Null, not zero, when no interaction was observed: a 0ms INP and "the click
    // never landed" are the same number and opposite facts.
    inp: window.__perf.inp > 0 ? Math.round(window.__perf.inp) : null, fcp: fcp ? Math.round(fcp.startTime) : null,
    hydrate: window.__perf.hydratedAt === null ? null : Math.round(window.__perf.hydratedAt),
    ttfb: Math.round(nav.responseStart || 0),
    kb: kb(() => true) + Math.round((nav.transferSize || 0) / 1024),
    js: kb((r) => /\\.js(\\?|$)/.test(r.name)),
    requests: res.length + 1,
  };
})()`;

/** A real mouse click at the element's centre, so the interaction is a browser event. */
async function realClick(b, selector) {
  const box = await b.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width && r.height ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null;
  })()`);
  if (!box) return false;
  for (const type of ["mousePressed", "mouseReleased"]) {
    await b.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
  return true;
}

/**
 * The seven routes §18 names. `click` is the control whose latency is measured; it
 * is a control the page really has, because clicking nothing measures nothing.
 */
const pageSet = (ctx) => [
  { name: "Homepage", path: "/", click: 'a[href="/tools"], header a' },
  { name: "Tools directory", path: "/tools", click: 'a[href^="/tools/"]' },
  { name: "Merge (tool page)", path: "/tools/merge-pdf", click: 'input[type="file"] ~ *, [class*="dropzone"]' },
  { name: "Pricing", path: "/pricing", click: "button, a[href^='/register']" },
  { name: "Editor (standalone)", path: "/editor", click: "button" },
  ...(ctx.workspaceId
    ? [{ name: "Workspace", path: `/workspaces/${ctx.workspaceId}`, click: "button" }]
    : []),
  ...(ctx.documentHref
    ? [{ name: "Workspace Editor", path: ctx.documentHref, click: "button" }]
    : []),
];

async function partPage(b, d, ctx) {
  const pages = pageSet(ctx);
  for (const page of pages) {
    const runs = [];
    for (let i = 0; i < RUNS; i += 1) {
      // Cold cache every run: a first visit is the load that decides whether someone
      // stays, and a warmed second run would flatter every byte count on the page.
      await b.send("Network.setCacheDisabled", { cacheDisabled: true });
      b.clearErrors();
      await b.goto(BASE, page.path, page.path === "/editor" || page.name.includes("Editor") ? 7000 : 4000);
      await sleep(1200);
      await realClick(b, page.click);
      await sleep(700);
      const m = await b.evaluate(READ_PERF);
      if (m && !m.__probeError) runs.push({ ...m, js_errors: b.errors().js.length });
    }
    if (!runs.length) {
      record("page", page.name, {}, "no run produced metrics");
      continue;
    }
    const pick = (k) => runs.map((r) => r[k]);
    record("page", page.name, {
      lcp: span(pick("lcp")), fcp: span(pick("fcp")), ttfb: span(pick("ttfb")),
      cls: median(pick("cls").map((c) => c * 1000)) === null ? "—" : (median(pick("cls").map((c) => c * 1000)) / 1000).toFixed(3),
      inp: span(pick("inp")), hydrate: span(pick("hydrate")),
      kb: span(pick("kb")), js: span(pick("js")), requests: median(pick("requests")),
      js_errors: Math.max(...pick("js_errors")),
    }, `${runs.length} runs, cold cache${runs.some((r) => r.hydrate === null) ? ", hydration unobserved in ≥1 run" : ""}${
      runs.every((r) => r.inp === null) ? ", no interaction was registered so INP is unmeasured here" : ""
    }`);
  }
  await b.send("Network.setCacheDisabled", { cacheDisabled: false });
}

/* ─────────────────────────── HTTP, with the session ─────────────────────────── */
/**
 * The workflow stages that are pure server work are measured over HTTP rather than
 * by watching the DOM, for two reasons. A DOM watcher can only report the interval
 * between two repaints, so "server processing" would silently include React's
 * render and the polling interval's rounding — 500ms of slack on a number the
 * brief asks for to the millisecond. And the load part needs concurrent requests
 * anyway, which a single browser tab cannot express.
 *
 * The session is the browser's own: cookies are read out of the live tab, so these
 * requests are the same authenticated identity that just signed up, and
 * `requireSameOrigin` sees the Origin it demands. Nothing here bypasses a check —
 * every route runs its full authorization on every one of these calls.
 */
async function cookieHeader(b) {
  const got = await b.send("Network.getCookies", { urls: [BASE] });
  return (got.result?.cookies ?? []).map((c) => `${c.name}=${c.value}`).join("; ");
}

const head4 = (buf) => buf.subarray(0, 4).toString("latin1");

async function api(ctx, path, init = {}) {
  const t0 = now();
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Origin: CSRF, Cookie: ctx.cookie, ...(init.headers || {}) },
    redirect: "manual",
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    ms: ms(t0),
    retryAfter: res.headers.get("retry-after"),
    bytes: buf.byteLength,
    head: head4(buf),
    json: () => {
      try {
        return JSON.parse(buf.toString("utf8"));
      } catch {
        return null;
      }
    },
  };
}

/**
 * A download measured all the way to the bytes, through the redirect.
 *
 * `GET /api/jobs/:id/download` answers `302` to a time-limited signed URL — so
 * `api()`, which uses `redirect: "manual"`, records a 302 and no payload. That is
 * not "the result download failed"; it is the probe stopping one hop early. The
 * user's download is both hops, so both are timed, and the `%PDF` check is applied
 * to what actually arrives rather than to an empty redirect body.
 *
 * Cookies travel on the first hop only: the signed URL carries its own
 * authorization, and sending session cookies to it would hide the case where the
 * signature is doing no work.
 */
async function downloadFollowing(ctx, path) {
  const t0 = now();
  const first = await fetch(`${API}${path}`, {
    headers: { Origin: CSRF, Cookie: ctx.cookie },
    redirect: "manual",
  });
  if (first.status < 300 || first.status >= 400) {
    const buf = Buffer.from(await first.arrayBuffer());
    return { status: first.status, ms: ms(t0), hops: 1, bytes: buf.byteLength, head: head4(buf) };
  }
  const location = first.headers.get("location");
  if (!location) return { status: first.status, ms: ms(t0), hops: 1, bytes: 0, head: "", noLocation: true };
  const url = location.startsWith("/") ? `${API}${location}` : location;
  const second = await fetch(url, { redirect: "follow" });
  const buf = Buffer.from(await second.arrayBuffer());
  return { status: second.status, ms: ms(t0), hops: 2, bytes: buf.byteLength, head: head4(buf) };
}

const filePart = (buf, name) => {
  const fd = new FormData();
  // The MIME matters: ingestion rejects `application/octet-stream`, which is what a
  // typeless Blob sends, and a browser posting a real file never does.
  fd.set("file", new Blob([buf], { type: "application/pdf" }), name);
  return fd;
};

/**
 * The same PDF, with distinct bytes.
 *
 * `uploadToWorkspace` deduplicates on `(workspaceId, sha256)` and returns the
 * EXISTING document for identical bytes, so a fan-out that posts one buffer N
 * times creates one document and measures the dedupe hit path. A trailing `%`
 * comment changes the checksum without touching the structure a reader parses —
 * `%PDF-` is still the signature and the xref still resolves.
 */
const uniqueBytes = (buf) => Buffer.concat([buf, Buffer.from(`\n% pdfdadi-load ${randomUUID()}\n`)]);

/** The refusal a route gave, without quoting a whole error page into the report. */
const why = (res) => {
  const body = res.json();
  const msg = body?.error?.message ?? body?.error ?? body?.message ?? null;
  return `${res.status}${typeof msg === "string" ? ` ${msg.slice(0, 72)}` : ""}`;
};

/**
 * Submits a server tool job and waits for a terminal state, timing the two halves
 * separately: the POST is what the user's connection pays for, and the poll is what
 * the queue and the binary cost after the bytes have landed.
 */
async function serverJob(ctx, slug, buf, name) {
  const post = await api(ctx, `/api/jobs?slug=${slug}`, { method: "POST", body: filePart(buf, name) });
  if (post.status !== 202 && post.status !== 200) return { refused: why(post), uploadMs: post.ms };
  const jobId = post.json()?.jobId;
  if (!jobId) return { refused: `${post.status} without a jobId`, uploadMs: post.ms };
  const t0 = now();
  for (let i = 0; i < 600; i += 1) {
    await sleep(500);
    const s = await api(ctx, `/api/jobs/${jobId}`);
    const body = s.json();
    if (body?.status === "completed") return { jobId, uploadMs: post.ms, workMs: ms(t0), result: body.result };
    if (body?.status === "failed") {
      return { jobId, uploadMs: post.ms, workMs: ms(t0), refused: body?.result?.message ?? "the job failed" };
    }
    if (s.status >= 400) return { jobId, uploadMs: post.ms, workMs: ms(t0), refused: why(s) };
  }
  return { jobId, uploadMs: post.ms, workMs: ms(t0), refused: "still running after 5 minutes" };
}

/* ─────────────────────────── part 2: workflow ─────────────────────────── */
/** Two runs, not three: a 340-page compress is minutes of CPU, and the third run
 *  buys a narrower range on a number whose spread is already reported. */
const WRUNS = Math.max(1, Math.min(RUNS, 2));

/**
 * The browser-local half of the workflow: two files merged by pdf-lib in the tab,
 * with no server involved at all. Timed from the click to the moment the result
 * surface offers a download, then the download itself.
 */
async function localMerge(b, d, shape, tiny) {
  await b.goto(BASE, "/tools/merge-pdf", 6000);
  await sleep(1200);
  if (!(await d.attach([shape.path, tiny.path]))) return { refused: "no file input on the merge page" };
  const t0 = now();
  const clicked = await d.clickText("Merge PDFs");
  if (clicked !== "ok") return { refused: `the Merge control was ${clicked}` };
  const done = await d.until(
    `(() => {
      const t = document.body.innerText;
      if (/Download/.test(t)) return "ok";
      if (/failed|could ?n[o']t|unsupported|damaged|password|encrypted|Something went wrong/i.test(t)) return "no";
      return null;
    })()`,
    { tries: 240, every: 500 },
  );
  if (done !== "ok") {
    const said = await b.evaluate(
      `(document.body.innerText.match(/[^\\n]*(failed|could ?n[o']t|unsupported|damaged|password|encrypted|went wrong)[^\\n]*/i) || [""])[0].trim().slice(0, 80)`,
    );
    return { mergeMs: ms(t0), refused: said || "no result and no message" };
  }
  const mergeMs = ms(t0);
  const t1 = now();
  const file = await takeDownload(d);
  return { mergeMs, downloadMs: ms(t1), bytes: file.bytes ?? null, refused: file.error ?? null };
}

/**
 * Time until a PDF page is actually on the screen — a canvas that exists and has
 * ink in it. `querySelector("canvas")` alone would pass against an empty element
 * the renderer has not drawn into yet, which is the shape of a fast number that
 * measures nothing.
 */
/**
 * "The document's first page is on screen" — for the standalone editor and the
 * Workspace workbench alike, which render through the same `EditorCanvas`.
 *
 * The signal is the SVG `<image>` that carries the rasterised page
 * (`EditorCanvas.tsx`, `bgImage`): it exists only once the page has been rendered,
 * so its presence is not a guess about progress. An earlier revision of this probe
 * looked for a `<canvas>` with ink in it and reported "no page was painted" for
 * every editor row — there is no page canvas in the DOM, and the probe was
 * measuring its own wrong assumption. The href length and the on-screen size are
 * checked too, so a zero-sized or empty placeholder cannot pass as a painted page.
 */
const PAGE_PAINTED = `(() => {
  for (const node of document.querySelectorAll("svg image")) {
    const href = node.getAttribute("href") || node.getAttribute("xlink:href") || "";
    const box = node.getBoundingClientRect();
    if (href.length > 1000 && box.width > 100 && box.height > 100) return "painted";
  }
  return null;
})()`;

/**
 * Navigation start → the first page visible, polled.
 *
 * `b.goto` cannot be used here: it is `Page.navigate` followed by a FIXED sleep, so
 * a measurement taken after it returns is a measurement of that sleep. An earlier
 * revision reported `editor_load = 9016 ms` for a 2 KB document because the wait was
 * 9000 ms — the number was the probe's own constant, not the product's latency.
 * Navigation is issued directly and the paint signal is polled at 100 ms, so every
 * editor figure in this table carries ±100 ms of poll granularity and nothing else.
 */
async function editorLoad(b, d, href) {
  const t0 = now();
  await b.send("Page.navigate", { url: `${BASE}${href}` });
  /*
   * The paint must be the NEW document's. `Page.navigate` returns before the
   * navigation commits, so for the first hundred milliseconds the old document is
   * still live and answering — and if the probe came from another editor page, its
   * page image would satisfy the check and the measurement would be a stale hit of
   * a few tens of milliseconds. Pinning the pathname makes that impossible: it
   * changes only when the requested document is the one on screen.
   */
  const here = JSON.stringify(href.split("?")[0]);
  const painted = await d.until(`(location.pathname === ${here} ? ${PAGE_PAINTED} : null)`, {
    tries: 300,
    every: 100,
  });
  if (painted === "painted") return { ms: ms(t0) };
  /*
   * A slow load and a REFUSED one look identical to a poll that gives up, and
   * reporting "no page was painted within 30s" for a document the editor
   * deliberately declines is the harness describing its own blind spot as a
   * product property. The editor says why in its own error panel, so it is read:
   * the two many-page fixtures are refused in about two seconds by
   * MAX_OPEN_PAGES, not waited on for thirty.
   */
  const panel = await b.send("Runtime.evaluate", {
    expression: `(() => {
      const t = (document.body.innerText || "").replace(/\\s+/g, " ");
      const m = t.match(/(This PDF has too many pages to edit|We couldn't open this PDF|Document not found|You don't have access|This document isn't ready|Your session has expired|Could not open this document)[^.]*\\.?/);
      return m ? m[0].slice(0, 120) : null;
    })()`,
    returnByValue: true,
  });
  const said = panel.result?.result?.value ?? null;
  return { refused: said ? `refused after ${ms(t0)}ms — "${said}"` : "no page was painted within 30s" };
}

/**
 * The eight stages the brief names, for each of the six input shapes, in the order
 * a real user meets them. A stage that cannot run because an earlier one refused is
 * recorded as `n/a` with the refusal that caused it — never as a zero, and never
 * omitted, because a blank cell and a fast cell look identical in a table.
 *
 * The refusals are read, not assumed. Whether an encrypted or truncated PDF is
 * turned away at ingestion or accepted and then fails to render is a fact about
 * this product that only the run can establish, so both outcomes are recorded as
 * they happen.
 */
async function partWorkflow(b, d, ctx, shapes) {
  const tiny = shapes.find((s) => s.key === "tiny");
  const ordinary = shapes.find((s) => s.key === "ordinary");
  for (const shape of shapes) {
    if (ONLY.length && !ONLY.includes(shape.key)) continue;
    const buf = readFileSync(shape.path);
    const partner = shape.key === "tiny" ? ordinary : tiny;
    const runs = [];
    const said = {};
    for (let i = 0; i < WRUNS; i += 1) {
      const r = {};
      const merged = await localMerge(b, d, shape, partner);
      r.local_merge = merged.mergeMs ?? null;
      r.local_download = merged.downloadMs ?? null;
      if (merged.refused) said.local_merge = merged.refused;

      const up = await api(ctx, `/api/workspaces/${ctx.workspaceId}/documents/upload`, {
        method: "POST",
        body: (() => {
          const fd = filePart(buf, `${shape.key}-${Date.now()}.pdf`);
          fd.set("name", `perf ${shape.key} ${i + 1}`);
          fd.set("organizationId", ctx.organizationId ?? "");
          return fd;
        })(),
      });
      const documentId = up.status < 300 ? (up.json()?.document?.id ?? null) : null;
      r.upload = up.status < 300 ? up.ms : null;
      if (!documentId) said.upload = why(up);

      const job = await serverJob(ctx, "compress-pdf", buf, `${shape.key}.pdf`);
      r.job_submit = job.uploadMs ?? null;
      r.server_processing = job.refused ? null : job.workMs;
      if (job.refused) said.server_processing = job.refused;

      if (job.jobId && !job.refused) {
        const dl = await downloadFollowing(ctx, `/api/jobs/${job.jobId}/download`);
        // A 200 that is not a PDF is a failure, not a fast download: the cell stays
        // empty and says what arrived instead.
        if (dl.status < 300 && dl.head === "%PDF") r.result_download = dl.ms;
        else if (dl.status >= 300) said.result_download = `HTTP ${dl.status}${dl.noLocation ? " with no Location" : ""}`;
        else said.result_download = `${dl.bytes} bytes starting "${dl.head}"`;

        const save = await api(ctx, `/api/jobs/${job.jobId}/save-to-workspace`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId: ctx.workspaceId, organizationId: ctx.organizationId }),
        });
        r.workspace_save = save.status < 300 ? save.ms : null;
        if (save.status >= 300) said.workspace_save = why(save);
      }

      if (documentId) {
        const href = `/workspaces/${ctx.workspaceId}/documents/${documentId}`;
        const load = await editorLoad(b, d, href);
        r.editor_load = load.ms ?? null;
        if (load.refused) said.editor_load = load.refused;

        const got = await api(ctx, `/api/workspaces/${ctx.workspaceId}/documents/${documentId}`);
        const revision = got.json()?.document?.revision ?? null;
        if (revision === null) said.publish = `could not read the revision (${why(got)})`;
        else {
          const fd = filePart(buf, `${shape.key}-v2.pdf`);
          fd.set("expectedRevision", String(revision));
          const pub = await api(
            ctx,
            `/api/workspaces/${ctx.workspaceId}/documents/${documentId}/versions/upload`,
            { method: "POST", body: fd },
          );
          r.publish = pub.status < 300 ? pub.ms : null;
          if (pub.status >= 300) said.publish = why(pub);
        }

        await b.goto(BASE, `/workspaces/${ctx.workspaceId}`, 6000);
        await sleep(600);
        const again = await editorLoad(b, d, href);
        r.reopen = again.ms ?? null;
        if (again.refused) said.reopen = again.refused;
      }
      runs.push(r);
    }
    const cell = (k) => {
      const xs = runs.map((x) => x[k]).filter((x) => typeof x === "number");
      if (xs.length) return span(xs);
      return said[k] ? `n/a — ${said[k]}` : "n/a";
    };
    record(
      "workflow",
      `${shape.key} (${shape.kb} KB)`,
      {
        local_merge: cell("local_merge"),
        local_download: cell("local_download"),
        upload: cell("upload"),
        job_submit: cell("job_submit"),
        server_processing: cell("server_processing"),
        result_download: cell("result_download"),
        workspace_save: cell("workspace_save"),
        editor_load: cell("editor_load"),
        publish: cell("publish"),
        reopen: cell("reopen"),
      },
      `${WRUNS} runs; compress-pdf is the server tool`,
    );
  }
}

/* ─────────────────────────── part 3: load ─────────────────────────── */
/**
 * Rising fan-out against the shipped configuration, on this disposable host.
 *
 * WHAT A LEVEL MEANS. Every level fires N requests at once and reports what came
 * back — accepted, and every refusal by status code. A refusal is not a failure of
 * the measurement; `/api/jobs` is supposed to answer 429 past its per-IP window and
 * 503 past its concurrency slots, and a load probe that treated those as errors
 * would report a broken product. What matters is that the ceiling is the ceiling
 * the code declares, and that nothing is silently dropped or served wrong.
 *
 * WHY THE SLEEPS. `/api/jobs` counts 20 requests per 60 seconds per IP, so a
 * 2→4→8→16 ramp fired back to back would spend its last two levels measuring the
 * rate limiter instead of the queue. The window is allowed to drain between levels,
 * and the limiter is then measured on purpose by one deliberate burst — two
 * different facts, each with its own run.
 */
const LOAD_LEVELS = [2, 4, 8, 16];

async function fanOut(n, make) {
  const t0 = now();
  const settled = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      make(i).then(
        (r) => r,
        (e) => ({ status: 0, ms: 0, error: String(e).slice(0, 70) }),
      ),
    ),
  );
  return { wallMs: ms(t0), settled };
}

/** Accepted count, every status seen, and the latency of the accepted ones. */
const tally = ({ wallMs, settled }) => {
  const ok = settled.filter((r) => r.status >= 200 && r.status < 300);
  const codes = {};
  for (const r of settled) {
    const k = r.status ? String(r.status) : `error(${r.error ?? "unknown"})`;
    codes[k] = (codes[k] ?? 0) + 1;
  }
  const lat = ok.map((r) => r.ms).sort((a, b) => a - b);
  return {
    accepted: `${ok.length}/${settled.length}`,
    statuses: Object.entries(codes).map(([k, v]) => `${v}×${k}`).join(" "),
    latency: lat.length ? span(lat) : "—",
    wall: `${wallMs}ms`,
    retry_after: settled.find((r) => r.retryAfter)?.retryAfter ?? "—",
  };
};

async function partLoad(b, d, ctx, shapes) {
  const buf = readFileSync(shapes.find((s) => s.key === "ordinary").path);
  const anon = { cookie: "" };

  /* 1. Concurrent server jobs, anonymous — the public tool path. */
  for (const n of LOAD_LEVELS) {
    if (n !== LOAD_LEVELS[0]) {
      // Drain the per-IP window so this level measures the queue, not the counter.
      await sleep(62_000);
    }
    const got = await fanOut(n, () =>
      api(anon, "/api/jobs?slug=compress-pdf", { method: "POST", body: filePart(buf, "load.pdf") }),
    );
    record("load", `anonymous server jobs ×${n}`, tally(got), "cold window; POST /api/jobs");
  }

  /* 2. The rate limiter itself, measured rather than assumed. */
  await sleep(62_000);
  const burst = await fanOut(25, () =>
    api(anon, "/api/jobs?slug=compress-pdf", { method: "POST", body: filePart(buf, "burst.pdf") }),
  );
  record(
    "load",
    "one-IP burst ×25 (limiter under test)",
    tally(burst),
    "20 per 60s per IP is the declared ceiling; a 429 here is the correct answer",
  );

  /* 3. Concurrent Workspace uploads — authenticated, size-capped. */
  const created = [];
  for (const n of [2, 4, 8]) {
    const got = await fanOut(n, (i) => {
      const fd = filePart(uniqueBytes(buf), `load-${n}-${i}-${Date.now()}.pdf`);
      fd.set("name", `load ${n}/${i}`);
      fd.set("organizationId", ctx.organizationId ?? "");
      return api(ctx, `/api/workspaces/${ctx.workspaceId}/documents/upload`, { method: "POST", body: fd });
    });
    for (const r of got.settled) {
      const id = r.status < 300 ? ((r.json?.() ?? {}).document?.id ?? null) : null;
      if (id) created.push(id);
    }
    record("load", `workspace uploads ×${n}`, tally(got), "authenticated; POST documents/upload");
  }

  /* 4. Concurrent document opens — the read path the editor uses. */
  const openable = created[0] ?? null;
  if (openable) {
    for (const n of [4, 8, 16]) {
      const got = await fanOut(n, () =>
        api(ctx, `/api/workspaces/${ctx.workspaceId}/documents/${openable}`),
      );
      record("load", `document opens ×${n}`, tally(got), "GET one document, same reader");
    }
  }

  /* 5. Concurrent publishes to DISTINCT documents — independent writes.
   *    `created` is de-duplicated first: identical upload bytes used to collapse
   *    into ONE document, and this row then re-ran the same-document CAS race
   *    under a label claiming otherwise. The count is recorded so a shed here
   *    cannot be read as a capacity ceiling when it is really a conflict. */
  const distinct = [...new Set(created)].slice(0, 4);
  if (distinct.length) {
    const revs = await Promise.all(
      distinct.map(async (id) => ({
        id,
        revision: (await api(ctx, `/api/workspaces/${ctx.workspaceId}/documents/${id}`)).json()?.document?.revision,
      })),
    );
    const got = await fanOut(revs.length, (i) => {
      const fd = filePart(buf, `pub-${i}.pdf`);
      fd.set("expectedRevision", String(revs[i].revision));
      return api(ctx, `/api/workspaces/${ctx.workspaceId}/documents/${revs[i].id}/versions/upload`, {
        method: "POST",
        body: fd,
      });
    });
    record(
      "load",
      `publishes ×${revs.length} (distinct documents)`,
      { ...tally(got), documents: `${distinct.length} distinct of ${created.length} uploaded` },
      "each its own document and its own revision",
    );
  }

  /* 6. Concurrent publishes to the SAME document, same expected revision.
   *    A perf number is the lesser half of this row: exactly one may win, and the
   *    losers must be told they lost rather than have their save vanish into a
   *    document that no longer matches what they edited. */
  if (openable) {
    const revision = (await api(ctx, `/api/workspaces/${ctx.workspaceId}/documents/${openable}`))
      .json()?.document?.revision;
    const got = await fanOut(4, (i) => {
      const fd = filePart(buf, `race-${i}.pdf`);
      fd.set("expectedRevision", String(revision));
      return api(ctx, `/api/workspaces/${ctx.workspaceId}/documents/${openable}/versions/upload`, {
        method: "POST",
        body: fd,
      });
    });
    const winners = got.settled.filter((r) => r.status >= 200 && r.status < 300).length;
    record(
      "load",
      "publishes ×4 (one document, one revision)",
      { ...tally(got), cas: winners === 1 ? "held — one winner, the rest refused" : `BROKEN — ${winners} winners` },
      "the compare-and-swap under contention",
    );
  }
}

/**
 * Concurrent anonymous browser workflows — three separate Chrome instances, each
 * with its own profile, doing the merge a first-time visitor does, at the same time.
 *
 * Three processes rather than three tabs: tabs in one browser share a renderer
 * scheduler, so a slow tab can be starved by its neighbour and the number would
 * describe Chrome's scheduling rather than the product's. Separate instances are
 * also what three separate people actually are.
 */
async function concurrentBrowsers(shapes, count = 3) {
  const files = [shapes.find((s) => s.key === "ordinary").path, shapes.find((s) => s.key === "tiny").path];
  const ports = Array.from({ length: count }, (_, i) => 9470 + i);
  const opened = [];
  for (const port of ports) {
    opened.push(await openBrowser({ port, width: 1280, height: 900, insecure: BASE.startsWith("https") }));
  }
  const t0 = now();
  const results = await Promise.all(
    opened.map(async (browser) => {
      const drive = makeDriver(browser);
      const started = now();
      try {
        await browser.goto(BASE, "/tools/merge-pdf", 5000);
        if (!(await drive.attach(files))) return { status: 0, ms: ms(started), error: "no file input" };
        if ((await drive.clickText("Merge PDFs")) !== "ok") {
          return { status: 0, ms: ms(started), error: "merge control unavailable" };
        }
        const done = await drive.until(`/Download/.test(document.body.innerText) ? "ok" : null`, {
          tries: 180,
          every: 500,
        });
        return done === "ok"
          ? { status: 200, ms: ms(started) }
          : { status: 0, ms: ms(started), error: "no result within 90s" };
      } catch (e) {
        return { status: 0, ms: ms(started), error: String(e).slice(0, 60) };
      }
    }),
  );
  for (const port of ports) {
    try {
      execFileSync("pkill", ["-f", `remote-debugging-port=${port}`], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
  record(
    "load",
    `anonymous browser workflows ×${count} (concurrent)`,
    tally({ wallMs: ms(t0), settled: results }),
    "separate Chrome instances; merge is entirely in the tab, so the server sees only page loads",
  );
}

/* ─────────────────────────── output ─────────────────────────── */
function report() {
  const parts = [...new Set(rows.map((r) => r.part))];
  for (const part of parts) {
    console.log(`\n══ ${part.toUpperCase()} ══`);
    for (const row of rows.filter((r) => r.part === part)) {
      console.log(`\n  ${row.name}`);
      for (const [k, v] of Object.entries(row.metrics)) console.log(`    ${k.padEnd(18)} ${v}`);
      if (row.note) console.log(`    ${"—".padEnd(18)} ${row.note}`);
    }
  }
  /*
   * Capacity, stated as the largest fan-out at which EVERY request was accepted.
   * Not the largest that returned some successes: a level that sheds half its load
   * is the ceiling being exceeded, not capacity.
   */
  const capacity = rows
    .filter((r) => r.part === "load" && typeof r.metrics.accepted === "string")
    .map((r) => {
      const [ok, of] = r.metrics.accepted.split("/").map(Number);
      return { name: r.name, full: ok === of, n: of, statuses: r.metrics.statuses };
    });
  if (capacity.length) {
    console.log(`\n══ MEASURED CAPACITY (fully accepted fan-out) ══`);
    const family = (name) => name.replace(/×\d+.*$/, "").trim();
    for (const fam of [...new Set(capacity.map((c) => family(c.name)))]) {
      const mine = capacity.filter((c) => family(c.name) === fam);
      const best = mine.filter((c) => c.full).map((c) => c.n).sort((a, b) => b - a)[0] ?? 0;
      const shed = mine.filter((c) => !c.full).sort((a, b) => a.n - b.n)[0];
      console.log(
        `  ${fam.padEnd(44)} ${best ? `${best} concurrent` : "none at any level"}` +
          (shed ? `; sheds at ${shed.n} (${shed.statuses})` : ""),
      );
    }
  }
}

async function main() {
  // The TLS front is a self-signed local certificate; Chrome is already told to
  // ignore it. This affects only this probe process, which talks to nothing but
  // this host.
  if (API.startsWith("https:") || BASE.startsWith("https:")) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  const shapes = await buildFixtures();
  console.log(`PERF/LOAD PROBE — pages ${BASE} · api ${API} (origin header ${CSRF})`);
  console.log(`fixtures: ${shapes.map((s) => `${s.key} ${s.kb}KB`).join(", ")}`);
  console.log(`parts: ${PARTS.join(",")} · page runs: ${RUNS} · workflow runs: ${WRUNS}\n`);

  const b = await openBrowser({ width: 1440, height: 900, insecure: BASE.startsWith("https") });
  const d = makeDriver(b);
  // Both hooks must be installed before any document runs: the observers cannot
  // see a paint that already happened, and the download interceptor cannot catch a
  // click on an anchor whose prototype it has not wrapped yet.
  await b.send("Page.addScriptToEvaluateOnNewDocument", { source: PERF_HOOK });
  await b.send("Page.addScriptToEvaluateOnNewDocument", { source: DOWNLOAD_HOOK });

  const ctx = { workspaceId: null, documentHref: null, organizationId: "", cookie: "" };
  const email = await signUpFresh(d, BASE, { password: PASSWORD, name: "Perf Reviewer", prefix: "perf" });
  if (!email) {
    console.log("FATAL: could not create the probe account — nothing authenticated can be measured.");
    process.exit(2);
  }
  ctx.cookie = await cookieHeader(b);
  ctx.workspaceId = await createWorkspace(d, BASE, "Perf Review");
  if (!ctx.workspaceId) {
    console.log("FATAL: could not create a Workspace.");
    process.exit(2);
  }
  // One document up front: the page part needs a Workspace Editor route to load,
  // and every route in it must be a real one rather than a guessed id.
  const seedFd = filePart(readFileSync(shapes.find((s) => s.key === "ordinary").path), "seed.pdf");
  seedFd.set("name", "Perf seed");
  const seed = await api(ctx, `/api/workspaces/${ctx.workspaceId}/documents/upload`, {
    method: "POST",
    body: seedFd,
  });
  const seedId = seed.status < 300 ? ((seed.json() ?? {}).document?.id ?? null) : null;
  if (seedId) ctx.documentHref = `/workspaces/${ctx.workspaceId}/documents/${seedId}`;
  else console.log(`note: the seed upload answered ${why(seed)} — Workspace Editor rows will be absent`);

  if (PARTS.includes("page")) await partPage(b, d, ctx);
  if (PARTS.includes("workflow")) await partWorkflow(b, d, ctx, shapes);
  if (PARTS.includes("load")) {
    await partLoad(b, d, ctx, shapes);
    await concurrentBrowsers(shapes);
  }

  report();
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ base: BASE, runs: RUNS, rows }, null, 2));
    console.log(`\njson: ${JSON_OUT}`);
  }
  // The probe measures; it does not judge. A number that is too slow is a finding
  // for the report to weigh against the brief's thresholds, not an exit code here.
  process.exit(0);
}

main().catch((err) => {
  console.log(`FATAL ${String(err).slice(0, 200)}`);
  process.exit(2);
});
