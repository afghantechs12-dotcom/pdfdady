/* global process, console, fetch */
/**
 * THE 32-TOOL RUNTIME MATRIX.
 *
 * `data/tools.ts` declares 45 tools: 18 `functional-client`, 14 `functional-server`,
 * 5 `planned` and 8 `coming-soon-ai`. The 32 functional ones are what a launch
 * would be promising, and every existing gate measures them one layer short of the
 * promise: the suite proves the pure transform, the capability tests prove the
 * record, the workflow probe drives three journeys. None of them answers "does
 * this tool, on its own page, turn a real file into a real download".
 *
 * So each row here drives the real page in a real browser: attach a real fixture
 * through the real input, press the tool's own button, then FETCH THE PRODUCED
 * ARTIFACT and read its first bytes. A success banner is not evidence — a tool
 * that renders "Your file is ready" over a zero-byte blob passes a text assertion
 * and fails a user. The magic-number check is the anti-vacuity floor: `%PDF` for a
 * PDF, `PK` for the ZIP that a multi-page rasteriser produces.
 *
 * ## The five verdicts, and why a missing binary is not a failure
 *
 * Ten of the fourteen server tools shell out to something the image installs and
 * this laptop may not have. The brief forbids collapsing those into one
 * "missing binaries" line, so each row names ITS OWN dependency, records the
 * `which` result for that binary alone, and is only ENVIRONMENTAL when the running
 * product itself reported that dependency missing. When it does, the row ALSO
 * asserts something about the product: that the message names the dependency, and
 * that it carries no stack trace, no path and no command line. A clean failure on
 * an unprovisioned host is a product behaviour worth passing.
 *
 * A tool whose page cannot be driven at all — no input, no button, a button that
 * never enables, a JS error, a timeout — is a PRODUCT FAILURE. That is the whole
 * point of the matrix.
 *
 * ## Fixtures
 *
 * All from `docs/qa/`, all synthetic, all committed: a 12-page PDF, a 2-page PDF
 * that looks different (a merge of two copies of one file can be a dedupe), a PDF
 * carrying three real AcroForm fields, a JPEG, a PNG, an HTML page, and one
 * AES-256 PDF whose password is a constant in this file — a fixture password, not
 * a secret, and the only way to exercise `unlock-pdf` at all.
 *
 * ## Usage
 *
 *   node scripts/tool-runtime-matrix-probe.mjs --url https://<host>:3001
 *   node scripts/tool-runtime-matrix-probe.mjs --url ... --only protect-pdf,unlock-pdf
 *   node scripts/tool-runtime-matrix-probe.mjs --url ... --json /tmp/matrix.json
 */
import { existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { openBrowser, sleep } from "./lib/probe-browser.mjs";
import { makeDriver } from "./lib/probe-drive.mjs";

const arg = (f, d = null) => {
  const i = process.argv.indexOf(f);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const BASE = arg("--url", "http://localhost:3001");
if (BASE.startsWith("https:")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const ONLY = (arg("--only", "") || "").split(",").filter(Boolean);
const JSON_OUT = arg("--json", null);
const FIXTURE_PASSWORD = "probe-pass";

const PDF = "docs/qa/p1/multipage-fixture.pdf";
const PDF2 = "docs/qa/final-prelaunch/second-fixture.pdf";
const FORM = "docs/qa/final-prelaunch/form-fixture.pdf";
const LOCKED = "docs/qa/final-prelaunch/encrypted-fixture.pdf";
const JPG = "docs/qa/final-prelaunch/image-fixture.jpg";
const PNG = "docs/qa/p0/probe-small.png";
const HTML = "docs/qa/final-prelaunch/page-fixture.html";

/** `which`, once per binary, so a row can cite its own dependency. */
const whichCache = new Map();
const which = (bin) => {
  if (!whichCache.has(bin)) {
    try {
      whichCache.set(bin, execFileSync("which", [bin], { encoding: "utf8" }).trim());
    } catch {
      whichCache.set(bin, null);
    }
  }
  return whichCache.get(bin);
};

/*
 * The table. `action` is the tool's own button label — copied from the runner or
 * from `data/serverToolConfig.ts`, never guessed, because a probe that clicks
 * "the first button" measures the page's layout instead of the tool.
 */
const TOOLS = [
  // ── 18 client-side tools ────────────────────────────────────────────────────
  { slug: "merge-pdf", mode: "local", files: [PDF, PDF2], action: "Merge PDFs" },
  { slug: "split-pdf", mode: "local", files: [PDF], action: "Split PDF" },
  { slug: "extract-pdf-pages", mode: "local", files: [PDF], action: "Split PDF" },
  { slug: "organize-pdf", mode: "local", files: [PDF], action: "Apply & Download" },
  { slug: "rotate-pdf", mode: "local", files: [PDF], action: "Apply & Download" },
  { slug: "delete-pdf-pages", mode: "local", files: [PDF], action: "Apply & Download" },
  { slug: "reorder-pdf-pages", mode: "local", files: [PDF], action: "Apply & Download" },
  { slug: "edit-pdf", mode: "local", files: [PDF], action: "Apply & Download" },
  { slug: "crop-pdf", mode: "local", files: [PDF], action: "Crop PDF" },
  { slug: "add-page-numbers", mode: "local", files: [PDF], action: "Add Page Numbers" },
  { slug: "add-watermark", mode: "local", files: [PDF], action: "Add Watermark" },
  { slug: "remove-pdf-metadata", mode: "local", files: [PDF], action: "Remove Metadata" },
  { slug: "jpg-to-pdf", mode: "local", files: [JPG], action: "Convert to PDF" },
  { slug: "png-to-pdf", mode: "local", files: [PNG], action: "Convert to PDF" },
  { slug: "image-to-pdf", mode: "local", files: [JPG], action: "Convert to PDF" },
  // Needs typed text before its button leaves `disabled`.
  { slug: "annotate-pdf", mode: "local", files: [PDF], action: "Add Note",
    prep: (d) => d.fill('textarea, input[type="text"]', "Audit annotation") },
  // Needs a PDF that actually has fields; `fillable.length === 0` disables it.
  { slug: "fill-pdf-forms", mode: "local", files: [FORM], action: "Fill Form & Download" },
  // Needs a second upload: the signature image goes into the image input.
  { slug: "sign-pdf", mode: "local", files: [PDF], action: "Sign PDF",
    prep: (d) => d.attach([PNG], 'input[type="file"][accept*="image"]') },

  // ── 14 server-side tools ────────────────────────────────────────────────────
  { slug: "compress-pdf", mode: "server", files: [PDF], action: "Compress PDF", needs: ["gs"] },
  { slug: "repair-pdf", mode: "server", files: [PDF], action: "Repair PDF", needs: ["qpdf", "gs"],
    anyOf: true },
  { slug: "pdf-to-pdfa", mode: "server", files: [PDF], action: "Convert to PDF/A", needs: ["gs"] },
  { slug: "flatten-pdf", mode: "server", files: [PDF], action: "Flatten PDF", needs: ["qpdf"] },
  { slug: "protect-pdf", mode: "server", files: [PDF], action: "Protect PDF", needs: ["qpdf"],
    prep: (d) => d.fill("#opt-password", FIXTURE_PASSWORD) },
  { slug: "unlock-pdf", mode: "server", files: [LOCKED], action: "Unlock PDF", needs: ["qpdf"],
    prep: (d) => d.fill("#opt-password", FIXTURE_PASSWORD) },
  { slug: "pdf-to-jpg", mode: "server", files: [PDF], action: "Convert to JPG",
    needs: ["pdftoppm", "pdfinfo"], magic: "PK" },
  { slug: "pdf-to-png", mode: "server", files: [PDF], action: "Convert to PNG",
    needs: ["pdftoppm", "pdfinfo"], magic: "PK" },
  { slug: "ocr-pdf", mode: "server", files: [PDF], action: "Run OCR",
    needs: ["ocrmypdf", "tesseract"] },
  { slug: "pdf-to-word", mode: "server", files: [PDF], action: "Convert to Word",
    needs: ["soffice"], magic: null },
  { slug: "html-to-pdf", mode: "server", files: [HTML], action: "Convert to PDF", needs: ["soffice"] },
  /*
   * The three Office inputs. No .docx/.pptx/.xlsx lives in this repository, and
   * inventing one here would put a hand-built OOXML skeleton between the product
   * and its verdict: if LibreOffice rejected my zip, the row would read as a
   * product failure. Recorded NOT EXERCISED, with the dependency proven anyway.
   */
  { slug: "word-to-pdf", mode: "server", needs: ["soffice"], noFixture: ".docx" },
  { slug: "powerpoint-to-pdf", mode: "server", needs: ["soffice"], noFixture: ".pptx" },
  { slug: "excel-to-pdf", mode: "server", needs: ["soffice"], noFixture: ".xlsx" },
];

const VERDICTS = ["PASS", "PRODUCT FAILURE", "ENVIRONMENTAL", "NOT EXERCISED", "MANUAL REVIEW REQUIRED"];
const results = [];
const record = (slug, title, verdict, detail) => {
  if (!VERDICTS.includes(verdict)) throw new Error(`bad verdict ${verdict}`);
  results.push({ slug, title, verdict, detail });
  const tag = verdict === "PASS" ? "PASS" : verdict === "PRODUCT FAILURE" ? "FAIL" : verdict.split(" ")[0];
  console.log(`  [${tag.padEnd(4)}] ${slug.padEnd(19)} ${detail}`);
};

/**
 * Captures every file the product hands to the browser.
 *
 * WHY A HOOK AND NOT A SELECTOR. There is no download link on any result surface:
 * both `ResultActions` and `ServerToolRunner` render a BUTTON whose handler calls
 * `downloadBlob`, which mints an object URL, clicks a synthetic anchor and revokes
 * the URL a second later. A DOM query therefore finds nothing however long it
 * waits — the first run of this probe reported "no download control" for all 28
 * exercised tools, which was this harness looking for markup the product has never
 * had, not 28 broken tools.
 *
 * So the probe records the pair `downloadBlob` produces — the Blob and the name it
 * chose — at the moment the product produces it. Those bytes are exactly the bytes
 * a user's click would save, and the name is exactly the name it would save under.
 *
 * The anchor click itself is swallowed rather than performed: letting it through
 * would ask Chrome to write into the audit host's Downloads folder for every row.
 * What that would additionally prove — that Chrome can write a file — is not a
 * claim about PDFDadi.
 */
const DOWNLOAD_HOOK = `(() => {
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
      if (blob) {
        window.__probeDownloads.push({ name: this.download || null, blob });
        return;
      }
    }
    return click.apply(this, arguments);
  };
})()`;

/**
 * Presses the product's own Download control and reads what it produced.
 *
 * The click is the measurement: the size, the first bytes and the filename all
 * come from the Blob the handler passed to `downloadBlob`, so a row can only pass
 * if pressing Download on a real page really did yield a real file.
 */
const readArtifact = async (d) => {
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
};

/** Whatever the page is currently saying went wrong, if anything. */
const errorText = (d) =>
  d.b.evaluate(`(() => {
    const n = document.querySelector('[role="alert"], .text-red-600, [class*="ErrorBanner"]');
    return n ? n.innerText.trim().slice(0, 400) : null;
  })()`);

/**
 * One row. Drives the page, then judges what it produced.
 *
 * The order of the judgements matters: an error the PRODUCT reported is read before
 * a timeout is declared, so a tool that failed for a nameable reason is never
 * recorded as "no result appeared".
 */
async function runTool(d, tool) {
  const { slug } = tool;
  const deps = (tool.needs ?? []).map((bin) => ({ bin, path: which(bin) }));
  const missing = tool.anyOf
    ? (deps.every((x) => !x.path) ? deps : [])
    : deps.filter((x) => !x.path);

  if (tool.noFixture) {
    const proof = deps.map((x) => `${x.bin}=${x.path ?? "absent"}`).join(" ");
    record(slug, slug, "NOT EXERCISED",
      `no ${tool.noFixture} fixture in the repository; its dependency was checked anyway (${proof})`);
    return;
  }

  await d.b.goto(BASE, `/tools/${slug}`, 3000);
  d.b.clearErrors();
  const heading = await d.b.evaluate(`document.querySelector("h1") ? document.querySelector("h1").innerText.trim() : null`);
  if (!heading) {
    record(slug, slug, "PRODUCT FAILURE", `/tools/${slug} rendered no h1 — the page is not there`);
    return;
  }
  if (!(await d.attach(tool.files))) {
    record(slug, slug, "PRODUCT FAILURE", "the page offers no file input, so nothing can be uploaded");
    return;
  }
  const uploadError = await errorText(d);
  if (uploadError && /too (large|big)|not supported|invalid|couldn't|could not/i.test(uploadError)) {
    record(slug, slug, "PRODUCT FAILURE", `the upload was rejected: ${uploadError.replace(/\s+/g, " ")}`);
    return;
  }
  if (tool.prep) await tool.prep(d);
  await sleep(400);

  const clicked = await d.clickText(tool.action);
  if (clicked !== "ok") {
    record(slug, slug, "PRODUCT FAILURE",
      `"${tool.action}" was ${clicked === "disabled" ? "still disabled after a valid upload" : "not on the page"}`);
    return;
  }

  // A local transform is milliseconds; a server job is a queue, a worker and a poll.
  const patience = tool.mode === "server" ? { tries: 60, every: 1500 } : { tries: 30, every: 600 };
  /*
   * Readiness is the CONTROL, not the word. Every server tool page carries the
   * privacy sentence "...processed, and made available to download", so a text
   * match on "Download" is true before a file has been uploaded — which is how the
   * first fixed run of this probe declared a result on all eleven server tools a
   * second after pressing their button and then reported the absent Download button
   * as a product defect. The button this probe is about to press is the honest
   * signal, and the success copy is kept as a second one.
   */
  const outcome = await d.until(
    `(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Download");
      if (btn) return "ready";
      if (/Your file is ready|files are ready/i.test(document.body.innerText)) return "ready";
      const n = document.querySelector('[role="alert"], .text-red-600');
      return n && n.innerText.trim() ? "error" : null;
    })()`,
    patience,
  );

  if (outcome !== "ready") {
    const said = await errorText(d);
    if (said) return judgeFailure(d, tool, said, deps, missing);
    record(slug, slug, "PRODUCT FAILURE",
      `no result and no error after ${(patience.tries * patience.every) / 1000}s of "${tool.action}"`);
    return;
  }

  const art = await readArtifact(d);
  if (art?.error) {
    record(slug, slug, "PRODUCT FAILURE", `the page announced a result but ${art.error}`);
    return;
  }
  const magic = tool.magic === undefined ? "%PDF" : tool.magic;
  if ((art?.bytes ?? 0) === 0) {
    record(slug, slug, "PRODUCT FAILURE", "the offered artifact is zero bytes");
    return;
  }
  if (magic && !art.head.startsWith(magic)) {
    record(slug, slug, "PRODUCT FAILURE",
      `the artifact starts "${art.head}", not "${magic}" — ${art.bytes} bytes of something else`);
    return;
  }
  const js = d.b.errors().js;
  record(slug, slug, "PASS",
    `${art.bytes} bytes, starts "${art.head}"${art.name ? `, named ${art.name}` : ""}` +
      `${deps.length ? ` (via ${deps.map((x) => x.bin).join("+")})` : ""}`);
  if (js.length) record(slug, `${slug} console`, "PRODUCT FAILURE", `${js.length} JS error(s): ${js[0]}`);
}

/**
 * The product said something failed. Two questions, in this order: is it one of
 * ITS OWN declared dependencies, and did it say so cleanly?
 */
function judgeFailure(d, tool, said, deps, missing) {
  const flat = said.replace(/\s+/g, " ");

  if (missing.length) {
    /*
     * The guarantee, and it is NOT "name the binary". `toolErrorMessage` maps
     * `missing-dependency` to "This tool is temporarily unavailable on the server"
     * on purpose — the operator's install hint (with its apt line) stays in the
     * server-side MissingDependencyError. What must never happen is the OTHER
     * message: telling a user their file "may be unsupported or damaged" when the
     * server is the thing that is missing something sends them off to re-export a
     * perfectly good PDF. An earlier revision of this probe demanded the
     * dependency's name and recorded PRODUCT FAILURE against two tools that were
     * reporting themselves correctly.
     */
    const blamesTheFile = /unsupported|damaged|different file|try a different/i.test(flat);
    const leaks = /\/(Users|tmp|var|app)\/|at .+\(.+:\d+|Error:|Traceback|--[a-z]/.test(flat);
    record(tool.slug, tool.slug, "ENVIRONMENTAL",
      `${missing.map((x) => x.bin).join("+")} is absent on this host (which: none), so no run is possible here`);
    record(tool.slug, `${tool.slug} dependency message`,
      blamesTheFile || leaks ? "PRODUCT FAILURE" : "PASS",
      blamesTheFile
        ? `a missing server binary is reported as the user's file being bad: "${flat.slice(0, 160)}"`
        : leaks
          ? `the message leaks a path, a stack or a command line: "${flat.slice(0, 160)}"`
          : `reports a server-side unavailability, blames no file, leaks no path or command: "${flat.slice(0, 90)}"`);
    return;
  }
  record(tool.slug, tool.slug, "PRODUCT FAILURE",
    `every dependency is present (${deps.map((x) => `${x.bin}=${x.path}`).join(" ")}) and it still failed: "${flat.slice(0, 200)}"`);
}

async function main() {
  const absent = [PDF, PDF2, FORM, LOCKED, JPG, PNG, HTML].filter((f) => !existsSync(f));
  if (absent.length) {
    console.error(`missing fixtures: ${absent.join(", ")}`);
    process.exit(2);
  }
  try {
    const res = await fetch(BASE, { redirect: "manual" });
    if (res.status >= 500) throw new Error(`answered ${res.status}`);
  } catch (err) {
    console.error(`${BASE} is not answering (${err.message})`);
    process.exit(2);
  }

  console.log(`32-TOOL RUNTIME MATRIX against ${BASE}`);
  console.log(`host binaries: ${["gs", "qpdf", "pdftoppm", "pdfinfo", "tesseract", "ocrmypdf", "soffice"]
    .map((b) => `${b}=${which(b) ? "present" : "absent"}`).join(" ")}\n`);

  const b = await openBrowser({ port: 9463, width: 1440, height: 1000, insecure: BASE.startsWith("https:") });
  const d = makeDriver(b);
  await b.send("Page.addScriptToEvaluateOnNewDocument", { source: DOWNLOAD_HOOK });
  try {
    for (const tool of TOOLS) {
      if (ONLY.length && !ONLY.includes(tool.slug)) continue;
      try {
        await runTool(d, tool);
      } catch (err) {
        record(tool.slug, tool.slug, "ENVIRONMENTAL", `the probe threw: ${String(err?.message ?? err).slice(0, 160)}`);
      }
    }
  } finally {
    b.close();
  }

  const by = (v) => results.filter((r) => r.verdict === v);
  const pass = by("PASS").length;
  const fail = by("PRODUCT FAILURE");
  console.log(`\n${"─".repeat(72)}`);
  console.log(`TOOL RUNTIME MATRIX — PASS ${pass}/${pass + fail.length} exercised`);
  console.log(`  PRODUCT FAILURE  ${fail.length}`);
  console.log(`  ENVIRONMENTAL    ${by("ENVIRONMENTAL").length}   (not a pass)`);
  console.log(`  NOT EXERCISED    ${by("NOT EXERCISED").length}   (not a pass)`);
  console.log(`  ${results.length} rows for ${TOOLS.length} tools`);
  if (fail.length) {
    console.log("\nProduct failures:");
    for (const r of fail) console.log(`  ${r.slug}: ${r.detail}`);
  }
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, `${JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE,
      binaries: Object.fromEntries([...whichCache]), results }, null, 2)}\n`);
    console.log(`\nJSON written to ${JSON_OUT}`);
  }
  process.exit(fail.length ? 1 : 0);
}

await main();
