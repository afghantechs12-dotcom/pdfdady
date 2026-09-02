/* global process, console, fetch, FormData, Blob, Buffer, AbortController, setTimeout, clearTimeout */
/**
 * PERMANENT regression probe: LEGACY job endpoints refuse a stranger.
 *
 * WHY THIS EXISTS — and it is not a hypothetical. The unified pipeline enforced
 * ownership correctly from the start, while the legacy `pdf-tool` branch of the
 * SAME four route files enforced nothing. With no session at all, a caller who
 * knew a job id got:
 *
 *   GET /api/jobs/{id}          → 200   (a stranger's job status)
 *   GET /api/jobs/{id}/download → 302 → follow the signed URL → 200 → their PDF
 *
 * Every unit test of the ownership predicate was green the whole time.
 * `actorOwnsJob` was never wrong — it was never called on that branch. No Node
 * test in this repo can invoke a Next route handler with a real cookie jar, so
 * only something that speaks HTTP to a running server can make this claim.
 *
 * The fix has two halves and this probe is what proves BOTH landed. Stamping the
 * row without gating the reads leaves the hole open; gating without stamping is
 * worse than the bug — `actorOwnsJob` reads a null owner as "belongs to nobody",
 * so every anonymous visitor would be locked out of the job they just created.
 * Section 3 asserts the deny, section 2 and 5 assert the owner still works.
 *
 * WHAT IT PINS, as the mutations it was run against:
 *
 *  - Gate removed from any of the four routes: that route's deny check fails.
 *  - Gate present but the row left unowned (revert the queue/service half):
 *    section 2 fails FIRST — the owner cannot read its own job. That ordering is
 *    deliberate, so a half-applied fix reports "locked out the owner" rather than
 *    a confusing pass on the security checks.
 *  - Gate answers 403 instead of 404: the status assertions fail — a 403 confirms
 *    the id exists and turns the endpoint into an existence oracle.
 *
 * THE HAZARD IT IS BUILT AGAINST is a vacuous pass. A 404 for everyone would
 * satisfy every deny check while the product is broken, so no deny is asserted
 * before the OWNER has been observed to get a 200 on the same id in section 2.
 * The probe also verifies the row really is a LEGACY row (section 2 checks the
 * response is the legacy status shape, not the pipeline's) — otherwise the whole
 * run could be silently exercising the pipeline branch, which was never the bug.
 *
 * The security checks come BEFORE the completion check on purpose: they hold
 * whether or not Ghostscript is installed on this machine. The positive `302`
 * download check needs a completed job, so it degrades to a skip-with-reason.
 *
 * Run the app in PRODUCTION mode with the pilot forced OFF, which makes
 * `compress-pdf` take the legacy branch deterministically:
 *
 *   node scripts/next-build.js
 *   NEXT_PUBLIC_SITE_URL=http://localhost:3001 PROCESSING_PIPELINE=off \
 *     npx next start -p 3001
 *   node scripts/legacy-job-ownership-probe.mjs [--url http://localhost:3001]
 *
 * No browser: every claim here is an HTTP status or a header, and plain `fetch`
 * with a hand-rolled cookie jar is both sufficient and far less flaky than
 * driving Chrome. Node's `fetch` sends no cookies of its own, which is exactly
 * what this needs — every identity in this file is explicit.
 */
import { URL } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg("--url", "http://localhost:3001");
const SLUG = "compress-pdf";
const ANON_COOKIE = "pdfdadi_jid";

/** A different visitor: a well-formed anon id that is simply not the owner's. */
const STRANGER_ID = "11111111-2222-3333-4444-555555555555";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
const skips = [];
function check(label, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function skip(label, reason) {
  skips.push(`${label} — ${reason}`);
  console.log(`  skip ${label} — ${reason}`);
}
const section = (n, title) => console.log(`\n── ${n}. ${title}`);

/**
 * A fixture with real content, generated rather than committed so the probe
 * cannot start passing against an empty file someone checked in.
 */
async function makeFixture(pages = 2) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([612, 792]);
    for (let row = 0; row < 36; row++) {
      page.drawText(`Page ${i + 1} line ${row + 1} — legacy ownership probe fixture`, {
        x: 40, y: 740 - row * 19, size: 11, font, color: rgb(0.1, 0.1, 0.25),
      });
    }
    page.drawRectangle({ x: 40, y: 40, width: 500, height: 60, color: rgb(0.2, 0.4, 0.7) });
  }
  return Buffer.from(await doc.save());
}

/**
 * Extracts the anon-job cookie from a response.
 *
 * Parsed by hand rather than trusting a jar: the value is the identity under
 * test, and reading it explicitly is what lets section 3 forge a *different* one.
 * `getSetCookie` keeps multiple Set-Cookie headers separate — joining them into
 * one string would corrupt the value at the first `expires=...,` comma.
 */
function readAnonCookie(res) {
  const raw = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : [res.headers.get("set-cookie") ?? ""];
  for (const line of raw) {
    const m = /(?:^|;\s*)pdfdadi_jid=([^;]+)/.exec(line);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

/** Fetch with an explicit identity: `cookie` may be null for "no session at all". */
function req(path, { cookie = null, method = "GET", body = null, redirect = "manual" } = {}) {
  const headers = {};
  if (cookie) headers.cookie = `${ANON_COOKIE}=${cookie}`;
  return fetch(new URL(path, BASE), { method, body, headers, redirect });
}

/**
 * A `GET` that must not hang. `/progress` is an endless SSE stream when it is
 * allowed to open, so a probe that awaited its body would hang forever on a
 * regression instead of failing. Only the status line is needed.
 */
async function statusOnly(path, cookie) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(new URL(path, BASE), {
      headers: cookie ? { cookie: `${ANON_COOKIE}=${cookie}` } : {},
      redirect: "manual",
      signal: ac.signal,
    });
    return { status: res.status, contentType: res.headers.get("content-type") ?? "" };
  } catch (err) {
    return { status: 0, contentType: "", error: String(err) };
  } finally {
    clearTimeout(timer);
    // Never leave the SSE socket open — the server holds a poller per connection.
    ac.abort();
  }
}

async function main() {
  console.log(`\nLEGACY JOB OWNERSHIP PROBE  →  ${BASE}`);
  console.log("(run the server with PROCESSING_PIPELINE=off)");

  // ==========================================================================
  section(1, "The server is up and serving the legacy tool");
  let reachable = false;
  try {
    const res = await req(`/api/jobs?slug=${SLUG}`, { method: "POST", body: new FormData() });
    // 400 "No file was provided" proves the route exists and reached submit.
    reachable = res.status !== 0;
    check("POST /api/jobs is reachable and rejects an empty submit", res.status === 400,
      `got ${res.status}`);
  } catch (err) {
    check("POST /api/jobs is reachable", false, String(err));
  }
  if (!reachable) {
    console.log("\nserver unreachable — start it first (see the header of this file)");
    process.exit(1);
  }

  // ==========================================================================
  section(2, "An anonymous visitor submits and can read its OWN job");
  const pdf = await makeFixture(2);
  const form = new FormData();
  form.append("file", new Blob([pdf], { type: "application/pdf" }), "probe.pdf");

  const submit = await req(`/api/jobs?slug=${SLUG}`, { method: "POST", body: form });
  check("submit accepted (202)", submit.status === 202, `got ${submit.status}`);
  const submitBody = await submit.json().catch(() => ({}));
  const jobId = submitBody.jobId;
  check("submit returned a job id", typeof jobId === "string" && jobId.length > 0,
    JSON.stringify(submitBody).slice(0, 120));

  const owner = readAnonCookie(submit);
  check("submit minted an anonymous identity cookie", typeof owner === "string" && owner.length > 0,
    "no pdfdadi_jid in Set-Cookie");
  check("the minted identity is a per-visitor uuid, not a shared bucket",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(owner ?? ""),
    `got ${owner}`);

  if (!jobId || !owner) {
    console.log("\ncannot continue without a job id and an owner cookie");
    report();
    return;
  }

  const ownerStatus = await req(`/api/jobs/${jobId}`, { cookie: owner });
  const ownerBody = await ownerStatus.json().catch(() => ({}));
  // THE anti-lockout check, and the reason it comes before every deny below: a
  // server that 404s everyone would satisfy all of section 3 while the product is
  // broken for its own users.
  check("the owner reads its own job (200)", ownerStatus.status === 200,
    `got ${ownerStatus.status} ${JSON.stringify(ownerBody).slice(0, 120)}`);

  // And confirm this really is the LEGACY branch. The legacy status shape has no
  // `stage`/`stageLabel`; the pipeline's always does. Without this the whole run
  // could be exercising the pipeline, which was never the vulnerable path.
  const isLegacyShape =
    ownerStatus.status === 200 &&
    ownerBody.stage === undefined &&
    ownerBody.stageLabel === undefined &&
    typeof ownerBody.status === "string";
  check("the job is a LEGACY pdf-tool row, not a pipeline row", isLegacyShape,
    `keys: ${Object.keys(ownerBody).join(",")}`);

  if (ownerStatus.status !== 200 || !isLegacyShape) {
    console.log(
      "\nrefusing to assert the security properties: the precondition failed.\n" +
      "  • owner locked out  → the row was created unowned (the stamping half is missing)\n" +
      "  • pipeline shape    → run the server with PROCESSING_PIPELINE=off",
    );
    report();
    return;
  }

  // ==========================================================================
  section(3, "A stranger is refused on every legacy endpoint (404, never 403)");
  // Two strangers per endpoint, because they fail for different reasons: no
  // cookie at all mints a brand-new identity server-side, while a well-formed
  // foreign cookie is accepted as an identity and then fails the owner
  // comparison. Both must be denied; only testing one would miss half the fix.
  const strangers = [
    ["no session at all", null],
    ["a different visitor's cookie", STRANGER_ID],
  ];

  for (const [who, cookie] of strangers) {
    const s = await req(`/api/jobs/${jobId}`, { cookie });
    check(`GET /api/jobs/{id} → 404 for ${who}`, s.status === 404, `got ${s.status}`);

    const d = await req(`/api/jobs/${jobId}/download`, { cookie });
    // 302 here is the original vulnerability: it hands out a signed storage URL.
    check(`GET /download → 404 for ${who}`, d.status === 404,
      `got ${d.status}${d.status === 302 ? ` → ${d.headers.get("location")}` : ""}`);
    check(`GET /download leaks no signed URL to ${who}`, !d.headers.get("location"),
      String(d.headers.get("location")));

    const c = await req(`/api/jobs/${jobId}/cancel`, { cookie, method: "POST" });
    check(`POST /cancel → 404 for ${who}`, c.status === 404, `got ${c.status}`);

    const p = await statusOnly(`/api/jobs/${jobId}/progress`, cookie);
    check(`GET /progress → 404 for ${who}`, p.status === 404, `got ${p.status}`);
    // The refusal must be a plain response, not an opened stream that then
    // reports `not-found` frames — an SSE connection is a read like any other.
    check(`GET /progress opens no event stream for ${who}`,
      !p.contentType.includes("text/event-stream"), p.contentType);
  }

  // A denial must be indistinguishable from a genuinely unknown id, or the
  // endpoint becomes an oracle for which job ids exist.
  const unknown = await req("/api/jobs/inmem-job-does-not-exist-000", { cookie: STRANGER_ID });
  check("an unknown id answers the same 404 as a forbidden one", unknown.status === 404,
    `got ${unknown.status}`);

  // ==========================================================================
  section(4, "The owner's access survived all of that");
  const stillOk = await req(`/api/jobs/${jobId}`, { cookie: owner });
  check("the owner still reads its own job after the denied attempts (200)",
    stillOk.status === 200, `got ${stillOk.status}`);

  // ==========================================================================
  section(5, "The owner can actually download the output");
  let terminal = null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const res = await req(`/api/jobs/${jobId}`, { cookie: owner });
    if (res.status !== 200) break;
    const body = await res.json().catch(() => ({}));
    if (["completed", "failed", "cancelled"].includes(body.status)) {
      terminal = body;
      break;
    }
    await sleep(400);
  }

  if (!terminal) {
    skip("owner download returns 302", "job did not reach a terminal state in 90s");
  } else if (terminal.status !== "completed") {
    // Not a security failure: a missing Ghostscript binary is an environment
    // fact. Reported as a skip so it cannot be mistaken for a passing check.
    skip("owner download returns 302",
      `job ended ${terminal.status} (${terminal.errorType ?? terminal.error ?? "no detail"}) — likely a missing tool binary`);
  } else {
    const dl = await req(`/api/jobs/${jobId}/download`, { cookie: owner });
    check("owner download returns 302 to a signed URL", dl.status === 302, `got ${dl.status}`);
    const loc = dl.headers.get("location");
    check("the redirect carries a signed storage location", !!loc, String(loc));
    check("the redirect names a download file",
      (dl.headers.get("content-disposition") ?? "").includes("attachment"),
      String(dl.headers.get("content-disposition")));

    if (loc) {
      const bytes = await fetch(loc.startsWith("http") ? loc : new URL(loc, BASE))
        .then(async (r) => ({ status: r.status, buf: Buffer.from(await r.arrayBuffer()) }))
        .catch((err) => ({ status: 0, buf: Buffer.alloc(0), error: String(err) }));
      check("following the owner's signed URL yields a real PDF",
        bytes.status === 200 && bytes.buf.subarray(0, 5).toString() === "%PDF-",
        `status ${bytes.status}, ${bytes.buf.length} bytes, head ${JSON.stringify(bytes.buf.subarray(0, 8).toString("latin1"))}`);
    }
  }

  report();
}

function report() {
  console.log(`\n${"─".repeat(64)}`);
  console.log(`checks passed: ${passed}   failed: ${failures.length}   skipped: ${skips.length}`);
  if (skips.length) {
    console.log("\nSKIPPED (environment, not a regression):");
    for (const s of skips) console.log(`  · ${s}`);
  }
  if (failures.length) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }
  console.log("LEGACY JOB OWNERSHIP: PASS");
}

main().catch((err) => {
  console.error("\nprobe crashed:", err);
  process.exit(1);
});
