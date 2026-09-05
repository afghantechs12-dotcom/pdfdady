/* global process, console, fetch, WebSocket, setTimeout, clearTimeout */
/**
 * PERMANENT runtime probe: PRODUCT CAPABILITY, AVAILABILITY & PLAN TRUTH.
 *
 * WHY THIS EXISTS. Every inconsistency this phase fixed was a *rendered* one, and
 * every one of them was compatible with a fully green suite. Vitest runs with
 * `environment: "node"`: no test in this repository can render the pricing page,
 * read what the upgrade control decided after its fetch resolved, or see that a
 * tool route offers an upload box for a tool nobody built.
 *
 * A green suite is compatible with all of:
 *
 *  - the homepage stating one tool count and /tools stating another;
 *  - /pricing asserting "there is no checkout on this site" while the same
 *    deployment renders a working Stripe upgrade button two sections below;
 *  - a Workspace usage card reading "100 left" under a sentence saying the
 *    allowance is being measured and not applied;
 *  - a planned tool's route rendering a file input that can never complete;
 *  - a hero mock advertising a control for a tool that does not exist;
 *  - a "secure cloud" label that never says whether waiting means a blocked
 *    request or a job with a progress bar and a cancel button.
 *
 * WHAT WOULD MAKE THIS VACUOUS. Three hazards, each guarded:
 *
 *  - **Nothing rendered.** Every text assertion is paired with a positive anchor
 *    from the same page (a heading, a count, a control label), so a blank or
 *    errored page fails rather than passing an absence check.
 *  - **Comparing a page against itself.** The pricing checks compare rendered
 *    output against `/api/billing/summary` — the same per-request decision the
 *    component uses — fetched separately in the page context, not against a
 *    string in the source. The count checks compare two different surfaces.
 *  - **Asserting an absence that was never possible.** Each absence check names
 *    the phrase actually recorded on the running site, and the counts, filters
 *    and control labels are printed so an empty scan is visible in the log.
 *
 * IT MUTATES DATA. Scenarios D and E register one throwaway account per run and
 * create one Workspace inside that account's own organization. It never submits
 * the add-member form, so NO EMAIL IS SENT to anyone: the membership assertions
 * are about the labels and the disclaimer, which is the recorded defect.
 *
 * Usage: node scripts/product-capability-truth-probe.mjs [origin]
 * Default origin http://localhost:3001, i.e. `npm run dev`.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGIN = process.argv[2] ?? "http://localhost:3001";
const CHROME =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEBUG_PORT = 9417;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function check(label, pass, detail = "") {
  results.push({ label, pass: !!pass, detail: String(detail).slice(0, 300) });
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

/** The integers a surface states as a tool count, e.g. "32 tools". */
function statedCounts(text) {
  return [...String(text).matchAll(/(\d+)\s+(?:PDF\s+)?tools?\b/gi)].map((m) => Number(m[1]));
}

async function main() {
  const health = await fetch(ORIGIN).then((r) => r.status).catch(() => 0);
  if (health === 0) throw new Error(`No server answering on ${ORIGIN}`);
  check("0: a server is answering on the verification origin", health < 500, `GET / → ${health}`);

  const userDataDir = mkdtempSync(join(tmpdir(), "capability-chrome-"));
  spawnSync("pkill", ["-f", `remote-debugging-port=${DEBUG_PORT}`], { stdio: "ignore" });
  await sleep(400);
  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${userDataDir}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      ...(ORIGIN.startsWith("https:") ? ["--ignore-certificate-errors"] : []),
      "--window-size=1440,1100",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let targets = null;
  for (let attempt = 0; attempt < 40 && !targets; attempt += 1) {
    await sleep(300);
    try {
      targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    } catch {
      targets = null;
    }
  }
  if (!targets) throw new Error(`Chrome never opened a debug port on ${DEBUG_PORT}`);
  const target = targets.find((t) => t.type === "page");
  const sock = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    sock.addEventListener("open", resolve, { once: true });
    sock.addEventListener("error", reject, { once: true });
  });

  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  const documentStatuses = [];
  /** Every request the page made, so "no email was sent" is checkable. */
  const requests = [];
  sock.addEventListener("message", (event) => {
    const msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      consoleErrors.push(
        (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300),
      );
    }
    if (msg.method === "Runtime.exceptionThrown") {
      consoleErrors.push(msg.params?.exceptionDetails?.text ?? "exception");
    }
    if (msg.method === "Network.requestWillBeSent") {
      requests.push({ url: msg.params.request.url, method: msg.params.request.method });
    }
    if (msg.method === "Network.responseReceived" && msg.params?.type === "Document") {
      documentStatuses.push({ url: msg.params.response.url, status: msg.params.response.status });
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      const timer = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), 45_000);
      pending.set(mid, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      sock.send(JSON.stringify({ id: mid, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.result?.exceptionDetails) return { __err: res.result.exceptionDetails.text };
    return res.result?.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");

  const goto = async (path, wait = 2200) => {
    await send("Page.navigate", { url: `${ORIGIN}${path}` });
    await sleep(wait);
  };
  const statusFor = (path) =>
    documentStatuses.filter((row) => row.url.includes(path)).at(-1)?.status ?? null;
  const page = () =>
    evaluate("({ url: location.href, text: document.body.innerText.slice(0, 12000) })");
  const type = (name, value) =>
    evaluate(`(() => {
      const el = document.querySelector('input[name="${name}"]');
      if (!el) return "missing";
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return "ok";
    })()`);
  const clickText = (text, selector = "button, a") =>
    evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((node) => node.textContent.trim() === ${JSON.stringify(text)});
      if (!el) return "missing";
      el.click();
      return "ok";
    })()`);

  // ---- B (first, it produces the canonical count) --------------------------
  // /tools renders the registry. Counting its cards gives the number every other
  // surface must agree with, without this probe deciding what the number should be.
  await goto("/tools", 3200);
  const toolsView = await page();
  const catalog = await evaluate(`(() => {
    const links = [...document.querySelectorAll('a[href^="/tools/"]')]
      .map((a) => a.getAttribute("href"))
      .filter((href) => /^\\/tools\\/[a-z0-9-]+$/.test(href));
    return {
      hrefs: [...new Set(links)].sort(),
      unique: [...new Set(links)].length,
      filters: [...document.querySelectorAll("button, [role=tab], label")]
        .map((n) => n.textContent.trim())
        .filter((t) => t === "Browser" || t === "Secure cloud"),
    };
  })()`);
  const toolsStated = statedCounts(toolsView.text);
  check(
    "B1: /tools renders and states a tool count",
    statusFor("/tools") === 200 && toolsStated.length > 0,
    `status ${statusFor("/tools")}, stated ${toolsStated.join("/")}, ${catalog.unique} distinct tool links`,
  );
  const canonicalCount = toolsStated[0] ?? null;
  check(
    "B2: every count /tools states is the same number",
    toolsStated.length > 0 && toolsStated.every((n) => n === canonicalCount),
    toolsStated.join(" / "),
  );
  check(
    "B3: the catalog offers both execution filters, so the two modes are distinguishable",
    (catalog.filters ?? []).includes("Browser") && (catalog.filters ?? []).includes("Secure cloud"),
    (catalog.filters ?? []).join(", "),
  );

  const routeStatus = {};
  for (const slug of [
    "merge-pdf",
    "compress-pdf",
    "word-to-pdf",
    "redact-pdf",
    "chat-with-pdf",
    "edit-pdf",
  ]) {
    await goto(`/tools/${slug}`, 2000);
    routeStatus[slug] = statusFor(`/tools/${slug}`);
  }
  check(
    "B4: every representative route answers 200 — available and unavailable alike",
    Object.values(routeStatus).every((s) => s === 200),
    Object.entries(routeStatus).map(([k, v]) => `${k}:${v}`).join(" "),
  );

  // ---- A: the homepage ----------------------------------------------------
  await goto("/", 3200);
  // The homepage writes its figures as bare numbers beside a label — the hero
  // stat is a `dt`/`dd` pair reordered by CSS, so `innerText` reads
  // "tools ready 32", and the catalog CTA reads "Explore all 32" with no noun at
  // all. `statedCounts` only sees "N tools", so scanning for that on this page
  // would find nothing and pass vacuously. Every number the page actually shows
  // is collected explicitly instead.
  const heroFigures = await evaluate(`(() => {
    const t = document.body.innerText;
    const near = (label) => {
      // Label THEN number, and no number-first alternative. The stat is a dt/dd
      // pair (label first in the DOM; CSS order swaps it visually only), and the
      // three stats sit in one row: "tools ready 32 run in your browser 18". A
      // number-first alternative matches at the leftmost position, so it reads
      // the *previous* stat's value — which is how "browser 32" was reported for
      // a page that says 18. Null when the label is absent, so a moved figure
      // fails the check instead of silently borrowing a neighbour's number.
      const re = new RegExp(label + "\\\\s*(\\\\d+)", "i");
      const m = t.match(re);
      return m ? Number(m[1]) : null;
    };
    const cta = t.match(/Explore all\\s*(\\d+)/i);
    return {
      ready: near("tools ready"),
      browser: near("run in your browser"),
      cta: cta ? Number(cta[1]) : null,
    };
  })()`);
  const homeStated = [heroFigures.ready, heroFigures.cta].filter((n) => typeof n === "number");
  check(
    "A1: the homepage states the same tool count /tools does",
    canonicalCount !== null && homeStated.length === 2 && homeStated.every((n) => n === canonicalCount),
    `homepage ${homeStated.join("/")} vs /tools ${canonicalCount}`,
  );
  check(
    "A2: the hero's own figures are the registry's, and its browser count is a subset",
    heroFigures.ready === canonicalCount &&
      typeof heroFigures.browser === "number" &&
      heroFigures.browser > 0 &&
      heroFigures.browser < heroFigures.ready,
    `ready ${heroFigures.ready}, browser ${heroFigures.browser}, canonical ${canonicalCount}`,
  );
  const heroMock = await evaluate(`(() => {
    const t = document.body.innerText;
    const ai = t.indexOf("AI Assistant");
    return {
      redact: /\\bRedact\\b/.test(t),
      aiAt: ai,
      // Case-insensitive: the badge is \`uppercase\` in CSS and \`innerText\`
      // applies text-transform, so the rendered word is "PREVIEW".
      aiMarked: ai > -1 ? /preview/i.test(t.slice(Math.max(0, ai - 200), ai + 200)) : false,
      hasEditorMock: /\\bSelect\\b/.test(t) && /\\bSign\\b/.test(t),
    };
  })()`);
  check(
    "A3: the hero mock advertises no control for an unbuilt tool (Redact)",
    heroMock.redact === false && heroMock.hasEditorMock === true,
    `redact:${heroMock.redact} mock-anchor:${heroMock.hasEditorMock}`,
  );
  check(
    "A4: where the homepage names the AI assistant, it is marked Preview",
    heroMock.aiAt > -1 && heroMock.aiMarked === true,
    `index ${heroMock.aiAt}, marked ${heroMock.aiMarked}`,
  );
  const homeClaims = await evaluate(`(() => {
    const t = document.body.innerText;
    return {
      bought: /Nothing on this site can be bought/i.test(t),
      noCheckout: /there is no checkout/i.test(t),
      freeWhileWeBuild: /Free while we build/i.test(t),
      // Anti-vacuity anchor. Not a pricing heading: \`PricingPreview\` is
      // deliberately not mounted on this page (\`/pricing\` is the page for it),
      // so requiring one would fail on a correct homepage — and a phrase check
      // over an empty string passes for the wrong reason.
      rendered: /tools ready/i.test(t) && t.length > 1500,
      jobsClaim: (t.match(/[^.]*progress[^.]*\\./i) || [""])[0].slice(0, 200),
    };
  })()`);
  check(
    "A5: the homepage makes no absolute claim about checkout or billing",
    homeClaims.bought === false &&
      homeClaims.noCheckout === false &&
      homeClaims.freeWhileWeBuild === false &&
      homeClaims.rendered === true,
    `page rendered:${homeClaims.rendered}`,
  );
  check(
    "A6: the jobs claim promises progress and cancellation, not retry",
    /progress/i.test(homeClaims.jobsClaim) &&
      /cancel/i.test(homeClaims.jobsClaim) &&
      !/retr(y|ied)/i.test(homeClaims.jobsClaim),
    homeClaims.jobsClaim,
  );

  // ---- C: /pricing, rendered against the config the server actually used ---
  await goto("/pricing", 3600);
  const pricing = await page();
  // The same per-request decision ProUpgradeAction consumes. Fetched in the page
  // so it carries the page's own cookies, and read AFTER the render so a
  // disagreement is a disagreement about one deployment, not two.
  const summary = await evaluate(`(async () => {
    const res = await fetch("/api/billing/summary", { cache: "no-store" });
    if (!res.ok) return { status: res.status, body: null };
    return { status: res.status, body: await res.json() };
  })()`);
  const canSell = summary.status === 200 && summary.body?.configured === true;
  const offerAction = summary.body?.action ?? null;
  const offerLabel = summary.body?.actionLabel ?? null;
  check(
    "C1: the pricing page renders and its billing summary resolved",
    statusFor("/pricing") === 200 && /Free to start|What it costs|Pricing/i.test(pricing.text),
    `status ${statusFor("/pricing")}, summary ${summary.status}, configured ${summary.body?.configured}, action ${offerAction}`,
  );
  const pricingRendered = await evaluate(`(() => {
    const t = document.body.innerText;
    const buttons = [...document.querySelectorAll("button, a")].map((n) => n.textContent.trim());
    return {
      text: t.slice(0, 8000),
      buttons,
      proPurchaseControl: buttons.some((b) => /^(Upgrade|Subscribe|Get Pro|Continue to checkout)/i.test(b)),
      contactControls: buttons.filter((b) => /^Contact us$/i.test(b)).length,
      absoluteAbsence: /no checkout on this site|Nothing on this site can be bought|there is no checkout and no/i.test(t),
    };
  })()`);
  if (canSell && offerAction && offerAction !== "unavailable") {
    check(
      "C2: with billing configured, the page renders the control the summary decided",
      offerLabel ? pricingRendered.buttons.some((b) => b.includes(offerLabel)) : false,
      `action ${offerAction}, label ${offerLabel}`,
    );
  } else {
    check(
      "C2: with no purchasable plan, the page renders no purchase control at all",
      pricingRendered.proPurchaseControl === false && pricingRendered.contactControls > 0,
      `purchase control ${pricingRendered.proPurchaseControl}, contact controls ${pricingRendered.contactControls}, action ${offerAction}`,
    );
  }
  check(
    "C3: the page states no absolute absence of checkout in either deployment",
    pricingRendered.absoluteAbsence === false && pricingRendered.text.length > 500,
    `page length ${pricingRendered.text.length}`,
  );
  // The Business *card*, found by its heading — not by the first "Business" in the
  // page text. The intro paragraph says "Business team billing is not built yet",
  // so a text-offset slice starts in the intro and runs through the Free card,
  // whose bullets legitimately advertise shared Workspaces. That reads as
  // Business re-selling them and fails a correct page.
  const businessTruth = await evaluate(`(() => {
    const heading = [...document.querySelectorAll("h2")].find(
      (h) => h.textContent.trim() === "Business",
    );
    const card = heading?.closest("div.flex.flex-col") ?? heading?.parentElement?.parentElement;
    const block = card ? card.innerText : "";
    // The *bullets* are what a plan offers. The description may name shared
    // Workspaces — it now says they are already on Free, which is the correction
    // this check exists to protect. Matching the whole card would fail on the
    // fixed copy while still passing a card that re-sold them in a bullet.
    const bullets = card ? [...card.querySelectorAll("li")].map((li) => li.innerText).join(" | ") : "";
    return {
      at: heading ? 1 : -1,
      block,
      bullets,
      claimsSharedWorkspaces: /shared (team )?workspaces?|per-member roles?/i.test(bullets),
      saysNotBuilt: /not built yet|Not yet available/i.test(block),
    };
  })()`);
  check(
    "C4: Business is described as unbuilt and does not re-sell what Free includes",
    businessTruth.at > -1 &&
      businessTruth.saysNotBuilt === true &&
      businessTruth.claimsSharedWorkspaces === false &&
      businessTruth.bullets.length > 0,
    `bullets ${businessTruth.bullets.slice(0, 160)}`,
  );
  // Card-anchored for the same reason as C4: "Free" appears in the page intro and
  // in the header CTA, so a text offset would assert against copy the Free card
  // does not own.
  const freeTruth = await evaluate(`(() => {
    const heading = [...document.querySelectorAll("h2")].find(
      (h) => h.textContent.trim() === "Free",
    );
    const card = heading?.closest("div.flex.flex-col") ?? heading?.parentElement?.parentElement;
    const block = card ? card.innerText : "";
    return { block, sharesWorkspaces: /shared workspaces/i.test(block), forever: /forever/i.test(block) };
  })()`);
  check(
    "C5: Free advertises the collaboration it actually grants, and promises no 'forever'",
    freeTruth.sharesWorkspaces === true && freeTruth.forever === false,
    freeTruth.block.replace(/\n/g, " | ").slice(0, 200),
  );

  // ---- F: an unavailable route must not look operational -------------------
  for (const [slug, kind] of [
    ["chat-with-pdf", "AI"],
    ["redact-pdf", "planned conventional"],
  ]) {
    await goto(`/tools/${slug}`, 2400);
    const probe = await evaluate(`(() => {
      const t = document.body.innerText;
      // Scoped to \`main\`: the site header carries a "Convert" dropdown on every
      // page, so scanning the whole document would report the navigation as a
      // start control and fail a correct page. The claim under test is about the
      // tool surface, which is inside \`main\`.
      const surface = document.querySelector("main") ?? document.body;
      return {
        text: t.slice(0, 3000),
        fileInputs: surface.querySelectorAll('input[type="file"]').length,
        dropzones: surface.querySelectorAll('[data-dropzone], [class*="dropzone" i]').length,
        submits: [...surface.querySelectorAll("button")]
          .map((b) => b.textContent.trim())
          .filter((b) => /^(Start|Run|Process|Convert|Compress|Upload|Chat|Redact|Try)/i.test(b)),
        saysUnavailable: /not (yet )?(live|available)|coming|being prepared|nothing to try/i.test(t),
        backToTools: [...document.querySelectorAll('a[href="/tools"]')].length,
      };
    })()`);
    check(
      `F: /tools/${slug} (${kind}) says it is not available and offers a way back`,
      probe.saysUnavailable === true && probe.backToTools > 0,
      probe.text.replace(/\n/g, " | ").slice(0, 160),
    );
    check(
      `F: /tools/${slug} (${kind}) offers no upload, no dropzone and no start control`,
      probe.fileInputs === 0 && probe.dropzones === 0 && probe.submits.length === 0,
      `inputs ${probe.fileInputs}, dropzones ${probe.dropzones}, controls ${probe.submits.join("/")}`,
    );
  }

  // ---- G: execution and privacy disclosure on real tool routes -------------
  const disclosures = {};
  for (const slug of ["merge-pdf", "compress-pdf", "word-to-pdf"]) {
    await goto(`/tools/${slug}`, 2600);
    disclosures[slug] = await evaluate(`(() => {
      const t = document.body.innerText;
      return {
        browser: /Browser processing\\./.test(t),
        cloud: /Secure cloud processing\\./.test(t),
        local: /Runs on your device/i.test(t),
        job: /background job/i.test(t),
        cancellable: /cancel/i.test(t),
        upload: document.querySelectorAll('input[type="file"]').length,
        anchor: t.length,
      };
    })()`);
  }
  check(
    "G1: Merge discloses browser processing and local execution, with an upload control",
    disclosures["merge-pdf"].browser === true &&
      disclosures["merge-pdf"].local === true &&
      disclosures["merge-pdf"].cloud === false &&
      disclosures["merge-pdf"].upload > 0,
    JSON.stringify(disclosures["merge-pdf"]),
  );
  check(
    "G2: Compress discloses secure-cloud processing AND that waiting means a background job",
    disclosures["compress-pdf"].cloud === true &&
      disclosures["compress-pdf"].job === true &&
      disclosures["compress-pdf"].local === false,
    JSON.stringify(disclosures["compress-pdf"]),
  );
  check(
    "G3: a second server tool makes the same two-part disclosure, not a vaguer one",
    disclosures["word-to-pdf"].cloud === true &&
      disclosures["word-to-pdf"].job === true &&
      disclosures["word-to-pdf"].local === false,
    JSON.stringify(disclosures["word-to-pdf"]),
  );
  check(
    "G4: no available tool route claims both browser and cloud processing",
    Object.values(disclosures).every((d) => !(d.browser && d.cloud)),
    Object.entries(disclosures).map(([k, d]) => `${k}:${d.browser ? "B" : ""}${d.cloud ? "C" : ""}`).join(" "),
  );

  // ---- D + E: signed in. One throwaway account, one Workspace. -------------
  const stamp = Date.now();
  const email = `capability.${stamp}@example.test`;
  await goto("/register", 3000);
  await type("name", "Capability Prober");
  await type("email", email);
  await type("password", "Capability-Probe-Pass!");
  await type("confirmPassword", "Capability-Probe-Pass!");
  await evaluate(`document.querySelector('input[name="acceptedTerms"]').click()`);
  await clickText("Create account", "button");
  await sleep(6500);
  let view = await page();
  check(
    "D0: a throwaway account reaches the authenticated app",
    /\/workspaces/.test(view.url ?? ""),
    view.url,
  );
  const organizationId = await evaluate(
    `(() => { const a = document.querySelector('a[href*="organizationId="]'); return a ? new URL(a.href).searchParams.get("organizationId") : null; })()`,
  );
  await clickText("Create Workspace", "button");
  await sleep(700);
  await evaluate(`(() => {
    const el = document.querySelector('[role="dialog"] input');
    const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set;
    setter.call(el, "Capability Truth Probe");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return el.value;
  })()`);
  await clickText("Create", "button");
  await sleep(6500);
  view = await page();
  const workspaceId = /\/workspaces\/([^/?#]+)/.exec(view.url ?? "")?.[1] ?? null;
  check(
    "D0: the Workspace that carries the usage card exists",
    !!workspaceId && workspaceId !== "undefined" && /Capability Truth Probe/.test(view.text ?? ""),
    view.url,
  );

  // The canonical usage policy for this visitor, from the endpoint the card reads.
  const usage = await evaluate(`(async () => {
    const res = await fetch("/api/usage", { cache: "no-store" });
    if (!res.ok) return { status: res.status, body: null };
    return { status: res.status, body: await res.json() };
  })()`);
  const usageMode = usage.body?.mode ?? null;
  await sleep(2500);
  const card = await evaluate(`(() => {
    const t = document.body.innerText;
    const at = t.indexOf("Usage");
    const block = at > -1 ? t.slice(at, at + 1200) : "";
    return {
      at,
      block,
      monitoringBadge: /Monitoring/.test(block),
      measuredSentence: /measured, not applied/i.test(block),
      headroom: /\\b\\d[\\d.,]*\\s*(MB|GB|operations|units|tokens)?\\s*left\\b/i.test(block),
      usedOfLimit: /\\d[\\d.,]*\\s*(of|\\/)\\s*\\d/.test(block),
      planCeiling: /Largest file this plan allows per upload/i.test(block),
      ceilingCaveat: /each upload box states its own limit/i.test(block),
      literalNull: /\\bnull\\b/.test(block),
      unavailable: /Usage is unavailable/i.test(block),
    };
  })()`);
  check(
    "D1: the usage card rendered with real figures, not an unavailable state",
    card.at > -1 && card.unavailable === false && card.usedOfLimit === true,
    `mode ${usageMode}, usage status ${usage.status}, block ${card.block.replace(/\n/g, " | ").slice(0, 160)}`,
  );
  if (usageMode === "enforce") {
    check(
      "D2: with enforcement ON, the card states headroom and drops the monitoring copy",
      card.headroom === true && card.measuredSentence === false,
      `headroom ${card.headroom}, measured sentence ${card.measuredSentence}`,
    );
  } else {
    check(
      "D2: in observe mode the card states no headroom figure — the recorded defect",
      card.headroom === false && card.measuredSentence === true && card.monitoringBadge === true,
      `mode ${usageMode}, headroom ${card.headroom}, measured ${card.measuredSentence}, badge ${card.monitoringBadge}`,
    );
  }
  check(
    "D3: measured usage is still shown, so observe mode is not a blank card",
    card.usedOfLimit === true && card.literalNull === false,
    `used-of-limit ${card.usedOfLimit}, literal null ${card.literalNull}`,
  );
  check(
    "D4: the file-size figure says which ceiling it is",
    card.planCeiling === true && card.ceilingCaveat === true,
    `plan ceiling ${card.planCeiling}, caveat ${card.ceilingCaveat}`,
  );

  // ---- E: membership labels. The form is NEVER submitted. ------------------
  await goto(`/workspaces/${workspaceId}/settings?organizationId=${organizationId}`, 3600);
  const members = await evaluate(`(() => {
    const t = document.body.innerText;
    const buttons = [...document.querySelectorAll("button")].map((b) => b.textContent.trim());
    const roleOptions = [...document.querySelectorAll("select option")].map((o) => o.textContent.trim());
    return {
      text: t.slice(0, 6000),
      buttons,
      addMember: buttons.some((b) => /^Add member$/i.test(b)),
      invite: buttons.some((b) => /invite/i.test(b)) || /\\bInvite\\b/.test(t),
      disclaimer: /does not send an invitation email/i.test(t),
      roles: roleOptions,
      owner: /Owner/i.test(t),
    };
  })()`);
  check(
    "E1: the membership control is 'Add member', never 'Invite'",
    members.addMember === true && members.invite === false,
    `buttons ${members.buttons.join("/")}`,
  );
  check(
    "E2: the page says plainly that no invitation email is sent",
    members.disclaimer === true,
    members.disclaimer ? "disclaimer present" : members.text.replace(/\n/g, " | ").slice(0, 200),
  );
  check(
    "E3: the roles offered are the roles the domain implements",
    ["viewer", "commenter", "editor"].every((role) =>
      members.roles.some((option) => option.toLowerCase().includes(role)),
    ) && members.owner === true,
    `roles ${members.roles.join("/")}`,
  );
  const memberPosts = requests.filter(
    (r) => r.method === "POST" && /\/members/.test(r.url),
  );
  check(
    "E4: no membership request was sent, so no email could have been sent to anyone",
    memberPosts.length === 0,
    memberPosts.map((r) => r.url).join(" ") || "none",
  );

  // ---- H: a CMS record cannot manufacture a public tool --------------------
  //
  // Phase 4 closeout. The admin store is a hand-editable JSON volume with one
  // override entry per tool slug, and the merge used to be `registry UNION
  // store`: any key it held became a whole tool — listed in the catalog, counted
  // in "tools ready", put in the sitemap when its own status said
  // `functional-server`, and linked to a route that 404s, because
  // `generateStaticParams` and `/tools/[slug]` answer from the compiled
  // capability registry and the job API refuses an unknown tool.
  //
  // Vitest covers the merge and the write boundary. What no node test can do is
  // read what the running catalog states after the volume has been edited, which
  // is exactly the surface that used to lie. So this scenario edits the real
  // store beneath the running server and re-reads the rendered pages.
  //
  // It writes the store INTO the backup it took, so the admin password hash and
  // every unrelated setting survive, and restores the exact bytes in `finally`.
  // The adversarial record is written to the file rather than posted to
  // `/api/admin/tools`, because that route now refuses it (422) — the file is the
  // stricter test: it is the state a pre-fix deployment would already be in.
  // The file the RUNNING SERVER reads, which is not necessarily the one under this
  // probe's working directory: the server resolves `ADMIN_STORE_DIR`, and unset it
  // resolves against ITS working directory — `.next/standalone` for the standalone
  // entry, because that entry chdirs into its own directory. Export the same value
  // the origin was started with (the audit launcher uses
  // AUDIT_ADMIN_STORE_DIR, default /tmp/audit-admin). Getting this wrong does not
  // make the scenario vacuous — H4 asserts the edit IS rendered, so it fails — but
  // it fails as "the CMS override is live" and costs an investigation, which is
  // what it cost in Stage 7 of production acceptance.
  const STORE_PATH = join(
    process.env.ADMIN_STORE_DIR?.trim() || join(process.cwd(), "data", "admin"),
    "store.json",
  );
  const storeBackup = (() => {
    try {
      return readFileSync(STORE_PATH, "utf8");
    } catch {
      return null;
    }
  })();
  const sitemapBefore = await fetch(`${ORIGIN}/sitemap.xml`).then((r) => r.text()).catch(() => "");
  check(
    "H0: the store volume and the sitemap are both readable, so this scenario can run",
    storeBackup !== null && /\/tools\/merge-pdf</.test(sitemapBefore),
    `store ${storeBackup === null ? "missing" : `${storeBackup.length}b`}, sitemap ${sitemapBefore.length}b`,
  );
  if (storeBackup !== null) {
    try {
      const hostile = JSON.parse(storeBackup);
      hostile.tools = {
        ...(hostile.tools ?? {}),
        // An identity nothing implements, claiming to be a working server tool.
        "invented-tool": {
          slug: "invented-tool",
          name: "Invented Tool",
          description: "Created in the CMS, implemented nowhere.",
          href: "/tools/invented-tool",
          icon: "FileText",
          iconTone: "purple",
          status: "functional-server",
          category: "organize",
          accept: ["application/pdf"],
          multiple: false,
        },
        // An editorial override that must survive, on a tool the same record
        // tries to take offline.
        "merge-pdf": { name: "Merge PDF (CMS edited)", status: "planned" },
        // An unbuilt AI tool promoted to a working one.
        "chat-with-pdf": { status: "functional-server" },
        // A live card's link aimed at the dead route.
        "split-pdf": { slug: "invented-tool", href: "/tools/invented-tool" },
      };
      // Hiding a tool whose route, capability row and job handler all still work
      // is the same disagreement in the other direction.
      hostile.deleted = { ...(hostile.deleted ?? {}), tools: ["compress-pdf"] };
      writeFileSync(STORE_PATH, JSON.stringify(hostile, null, 2));

      await goto("/tools", 3600);
      const afterView = { text: String(await evaluate("document.body.innerText")) };
      const afterCatalog = await evaluate(`(() => {
        const links = [...document.querySelectorAll('a[href^="/tools/"]')]
          .map((a) => a.getAttribute("href"))
          .filter((href) => /^\\/tools\\/[a-z0-9-]+$/.test(href));
        return { hrefs: [...new Set(links)].sort() };
      })()`);
      const afterStated = statedCounts(afterView.text);
      check(
        "H1: the catalog states the same count it stated before the CMS edit",
        afterStated.length > 0 &&
          canonicalCount !== null &&
          afterStated.every((n) => n === canonicalCount),
        `after ${afterStated.join("/")} vs canonical ${canonicalCount}`,
      );
      check(
        "H2: the set of tool links is byte-identical to the canonical inventory",
        (afterCatalog.hrefs ?? []).join(",") === (catalog.hrefs ?? []).join(","),
        `${(afterCatalog.hrefs ?? []).length} links after vs ${(catalog.hrefs ?? []).length} before`,
      );
      check(
        "H3: the invented tool is neither linked nor named anywhere in the catalog",
        !(afterCatalog.hrefs ?? []).includes("/tools/invented-tool") &&
          !/Invented Tool/.test(afterView.text),
        `linked ${(afterCatalog.hrefs ?? []).includes("/tools/invented-tool")}, named ${/Invented Tool/.test(afterView.text)}`,
      );
      check(
        "H4: the editorial override IS rendered — the fix did not disable the CMS",
        /Merge PDF \(CMS edited\)/.test(afterView.text),
        /Merge PDF \(CMS edited\)/.test(afterView.text)
          ? "renamed card present"
          : afterView.text.replace(/\n/g, " | ").slice(0, 200),
      );
      check(
        "H5: the same record could not take that working tool offline",
        (afterCatalog.hrefs ?? []).includes("/tools/merge-pdf"),
        "merge-pdf still an active card",
      );
      check(
        "H6: the tombstoned working tool is still listed, still active",
        (afterCatalog.hrefs ?? []).includes("/tools/compress-pdf"),
        "compress-pdf still an active card",
      );
      // The catalog renders AI cards only under their own tab, so "the name is
      // absent from the default view" would pass whatever the store said. The
      // route is where the promotion would have to show up, and it is the surface
      // that used to render an upload box on the strength of a stored status.
      await goto("/tools/chat-with-pdf", 2600);
      const promoted = await evaluate(`(() => {
        const t = document.body.innerText;
        const surface = document.querySelector("main") ?? document.body;
        return {
          named: /Chat with PDF/.test(t),
          saysUnavailable: /not (yet )?(live|available)|coming|being prepared|nothing to try/i.test(t),
          fileInputs: surface.querySelectorAll('input[type="file"]').length,
        };
      })()`);
      check(
        "H7: the promoted AI tool's route still refuses to look operational",
        promoted.named === true &&
          promoted.saysUnavailable === true &&
          promoted.fileInputs === 0 &&
          !(afterCatalog.hrefs ?? []).includes("/tools/chat-with-pdf"),
        `named ${promoted.named}, unavailable ${promoted.saysUnavailable}, inputs ${promoted.fileInputs}, catalog link ${(afterCatalog.hrefs ?? []).includes("/tools/chat-with-pdf")}`,
      );

      await goto("/tools/invented-tool", 2600);
      check(
        "H8: the invented route 404s — nothing PDFDadi rendered points at it",
        statusFor("/tools/invented-tool") === 404,
        `status ${statusFor("/tools/invented-tool")}`,
      );

      const sitemapAfter = await fetch(`${ORIGIN}/sitemap.xml`).then((r) => r.text()).catch(() => "");
      const toolUrls = (text) => (text.match(/\/tools\/[a-z0-9-]+</g) ?? []).sort();
      check(
        "H9: the sitemap is unchanged: no invented URL, no promoted AI tool, merge-pdf kept",
        toolUrls(sitemapAfter).join(",") === toolUrls(sitemapBefore).join(",") &&
          !/invented-tool/.test(sitemapAfter) &&
          !/\/tools\/chat-with-pdf</.test(sitemapAfter) &&
          /\/tools\/merge-pdf</.test(sitemapAfter),
        `${toolUrls(sitemapAfter).length} tool URLs after vs ${toolUrls(sitemapBefore).length} before`,
      );

      const anonPost = await fetch(`${ORIGIN}/api/admin/tools`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "anon-invented-tool",
          name: "Anon",
          description: "No session",
          icon: "FileText",
          iconTone: "purple",
          status: "functional-server",
          category: "organize",
          accept: ["application/pdf"],
          multiple: false,
        }),
      }).catch(() => null);
      const storeNow = JSON.parse(readFileSync(STORE_PATH, "utf8"));
      check(
        "H10: an unauthenticated create is refused and writes nothing to the volume",
        anonPost !== null && anonPost.status >= 400 && !("anon-invented-tool" in storeNow.tools),
        `POST → ${anonPost?.status}, key written ${"anon-invented-tool" in storeNow.tools}`,
      );
    } finally {
      writeFileSync(STORE_PATH, storeBackup);
    }
    check(
      "H11: the store volume was restored byte-for-byte, so the probe left no test data",
      readFileSync(STORE_PATH, "utf8") === storeBackup,
      `${storeBackup.length}b restored`,
    );
    await goto("/tools", 3200);
    const restored = statedCounts(String(await evaluate("document.body.innerText")));
    check(
      "H12: after restore the catalog states the canonical count again",
      restored.length > 0 && restored.every((n) => n === canonicalCount),
      `${restored.join("/")} vs canonical ${canonicalCount}`,
    );
  }

  // ---- whole-walk hygiene --------------------------------------------------
  check(
    "browser console: no React or page exceptions anywhere in the walk",
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(" || "),
  );
  const serverErrors = documentStatuses.filter((row) => row.status >= 500);
  check(
    "no document response in the whole walk was a 5xx",
    serverErrors.length === 0,
    serverErrors.map((row) => `${row.status} ${row.url}`).join(" "),
  );

  sock.close();
  chrome.kill("SIGKILL");

  const failed = results.filter((row) => !row.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log("FAILED:");
    for (const row of failed) console.log(`  - ${row.label} — ${row.detail}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
