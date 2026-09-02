/* global process, console, fetch, WebSocket, setTimeout, clearTimeout */
/**
 * PERMANENT runtime probe: WORKSPACE CREATION → NAVIGATION, in a REAL browser.
 *
 * WHY THIS EXISTS. The launch-blocking defect was invisible to a green suite:
 * `WorkspaceService`, its resolver and its repository were each internally
 * consistent, and the failure lived in the *composition* — `create` wrote one row
 * where two were required, and the page rendered the resulting exception as a
 * generic server error. Vitest runs `environment: "node"`, so no test in this
 * repository has ever rendered a Workspace route, followed a redirect, reloaded a
 * page or clicked the picker.
 *
 * A fully green suite is compatible with all of:
 *
 *  - the create dialog navigating to a URL the server refuses;
 *  - the Workspace route answering 500 instead of the controlled not-found;
 *  - the picker listing a Workspace whose page then fails;
 *  - a reload or a new tab resolving differently from the post-create redirect;
 *  - a double-click creating two Workspaces, or one Workspace with no owner.
 *
 * WHAT WOULD MAKE THIS VACUOUS. Two hazards, both guarded below:
 *
 *  - **Nothing was created.** Every navigation assertion is anchored to the id
 *    the POST returned, and the ids are printed. An empty run fails at step 3.
 *  - **"No error appeared" without a render.** The Workspace shell is asserted by
 *    the Workspace name being on the page, and the generic error copy is asserted
 *    absent — separately, so a blank page passes neither.
 *
 * IT MUTATES DATA. It registers one throwaway account per run and creates
 * Workspaces inside that account's own organization, against whatever database
 * the running server uses. It never touches another account's rows.
 *
 * Usage: node scripts/phase1-workspace-reliability-probe.mjs [origin]
 * Default origin http://localhost:3001, i.e. `npm run dev`.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGIN = process.argv[2] ?? "http://localhost:3001";
const CHROME =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEBUG_PORT = 9412;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function check(label, pass, detail = "") {
  results.push({ label, pass: !!pass, detail: String(detail).slice(0, 300) });
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  const health = await fetch(ORIGIN).then((r) => r.status).catch(() => 0);
  if (health === 0) throw new Error(`No server answering on ${ORIGIN}`);
  check("1a: a server is answering on the verification origin", health < 500, `GET / → ${health}`);

  const userDataDir = mkdtempSync(join(tmpdir(), "phase1-chrome-"));
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
  /** Console errors, page exceptions and failed document loads, in order. */
  const consoleErrors = [];
  const documentStatuses = [];
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

  const goto = async (path, wait = 2500) => {
    await send("Page.navigate", { url: `${ORIGIN}${path}` });
    await sleep(wait);
  };
  /** The document status the last navigation to `path` produced. */
  const statusFor = (path) =>
    documentStatuses.filter((row) => row.url.includes(path)).at(-1)?.status ?? null;
  const page = () =>
    evaluate("({ url: location.href, text: document.body.innerText.slice(0, 4000) })");

  /** Sets a React-controlled input the way a keystroke does. */
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

  // ---- 1: register through the real form ----------------------------------
  const stamp = Date.now();
  const email = `phase1.${stamp}@example.test`;
  await goto("/register", 3000);
  await type("name", "Phase One Prober");
  await type("email", email);
  await type("password", "Phase1-Probe-Password!");
  await type("confirmPassword", "Phase1-Probe-Password!");
  await evaluate(`document.querySelector('input[name="acceptedTerms"]').click()`);
  await clickText("Create account", "button");
  await sleep(6000);
  let view = await page();
  check(
    "1: registering through the form lands the user in the authenticated app",
    /\/workspaces/.test(view.url ?? ""),
    view.url,
  );

  // ---- 2: the picker renders ----------------------------------------------
  await goto("/workspaces", 3000);
  view = await page();
  check(
    "2: the Workspace picker renders for a signed-in user",
    /Workspaces/.test(view.text ?? "") && statusFor("/workspaces") === 200,
    `status ${statusFor("/workspaces")}`,
  );
  const organizationId = await evaluate(
    `(() => { const a = document.querySelector('a[href*="organizationId="]'); return a ? new URL(a.href).searchParams.get("organizationId") : null; })()`,
  );

  // ---- 3: create, and land on the Workspace -------------------------------
  await clickText("Create Workspace", "button");
  await sleep(700);
  await evaluate(`(() => {
    const el = document.querySelector('[role="dialog"] input');
    const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set;
    setter.call(el, "Phase 1 Reliability Test");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return el.value;
  })()`);
  await clickText("Create", "button");
  await sleep(6000);
  view = await page();
  const firstId = /\/workspaces\/([^/?#]+)/.exec(view.url ?? "")?.[1] ?? null;
  check(
    "3: creating a Workspace navigates to that Workspace's own route",
    !!firstId && firstId !== "undefined",
    view.url,
  );
  check(
    "3: the Workspace shell rendered, with the Workspace's name",
    /Phase 1 Reliability Test/.test(view.text ?? ""),
    (view.text ?? "").slice(0, 120).replace(/\n/g, " | "),
  );
  check(
    "3: NOT the generic server-error page — the original recording's outcome",
    !/server error|couldn't load|could not be loaded|Workspace not found/i.test(view.text ?? "") &&
      statusFor(`/workspaces/${firstId}`) === 200,
    `status ${statusFor(`/workspaces/${firstId}`)}`,
  );

  // ---- 4: reload ----------------------------------------------------------
  await goto(`/workspaces/${firstId}?organizationId=${organizationId}`, 3500);
  view = await page();
  check(
    "4: reloading the Workspace URL resolves the same Workspace",
    view.url.includes(firstId) && /Phase 1 Reliability Test/.test(view.text ?? ""),
    `status ${statusFor(`/workspaces/${firstId}`)}`,
  );

  // ---- 5+7: navigate away, return through the picker -----------------------
  await goto("/tools", 2500);
  check("5: navigating away from the Workspace works", /Tools|PDF/i.test((await page()).text ?? ""));
  await goto("/workspaces", 2500);
  const pickerHrefs = await evaluate(
    `[...document.querySelectorAll('a[href*="/workspaces/"]')].map((a) => a.getAttribute("href"))`,
  );
  check(
    "7: the picker lists the Workspace it just created",
    (pickerHrefs ?? []).some((href) => href.includes(firstId)),
    (pickerHrefs ?? []).join(" "),
  );
  await evaluate(
    `document.querySelector('a[href*="${firstId}"]').click()`,
  );
  await sleep(4000);
  view = await page();
  check(
    "7: clicking the picker entry opens that same Workspace",
    view.url.includes(firstId) && /Phase 1 Reliability Test/.test(view.text ?? ""),
    view.url,
  );

  // ---- 8: the copied URL, in a brand new tab -------------------------------
  const fresh = await send("Target.createTarget", {
    url: `${ORIGIN}/workspaces/${firstId}?organizationId=${organizationId}`,
  });
  await sleep(4000);
  const freshTarget = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()).find(
    (t) => t.id === fresh.result.targetId,
  );
  const freshSock = new WebSocket(freshTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    freshSock.addEventListener("open", resolve, { once: true });
    freshSock.addEventListener("error", reject, { once: true });
  });
  const freshText = await new Promise((resolve) => {
    freshSock.addEventListener("message", (event) => {
      const msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      if (msg.id === 1) resolve(msg.result?.result?.value ?? "");
    });
    freshSock.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression: "document.body.innerText.slice(0, 2000)", returnByValue: true },
      }),
    );
  });
  check(
    "8: a copied URL opened in a new tab resolves the same Workspace",
    /Phase 1 Reliability Test/.test(freshText),
    freshText.slice(0, 100).replace(/\n/g, " | "),
  );
  freshSock.close();
  await send("Target.closeTarget", { targetId: fresh.result.targetId });

  // ---- 9: a second Workspace, and both remain distinct ---------------------
  await goto("/workspaces", 2500);
  await clickText("Create Workspace", "button");
  await sleep(700);
  await evaluate(`(() => {
    const el = document.querySelector('[role="dialog"] input');
    const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set;
    setter.call(el, "Phase 1 Reliability Test Two");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await clickText("Create", "button");
  await sleep(6000);
  view = await page();
  const secondId = /\/workspaces\/([^/?#]+)/.exec(view.url ?? "")?.[1] ?? null;
  check(
    "9: a second Workspace gets its own id and its own route",
    !!secondId && secondId !== firstId && /Phase 1 Reliability Test Two/.test(view.text ?? ""),
    `${firstId} vs ${secondId}`,
  );
  await goto("/workspaces", 2500);
  const bothListed = await evaluate(
    `[...document.querySelectorAll('a[href*="/workspaces/"]')].map((a) => a.getAttribute("href")).join(" ")`,
  );
  check(
    "9: the picker shows both, each pointing at its own id",
    bothListed.includes(firstId) && bothListed.includes(secondId),
    bothListed,
  );

  // ---- 10: the duplicate name, and the double submit -----------------------
  await clickText("Create Workspace", "button");
  await sleep(700);
  await evaluate(`(() => {
    const el = document.querySelector('[role="dialog"] input');
    const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set;
    setter.call(el, "Phase 1 Reliability Test");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await clickText("Create", "button");
  await sleep(3500);
  view = await page();
  check(
    "10: a duplicate name is refused in the dialog, with no crash and no navigation",
    /already exists/i.test(view.text ?? "") && !/server error/i.test(view.text ?? ""),
    (view.text ?? "").split("\n").find((line) => /already exists/i.test(line)) ?? "no message",
  );

  // Two POSTs fired in the same tick — the strongest form of a double click,
  // which no client guard can intercept. The server must still leave one row.
  const race = await evaluate(`(async () => {
    const body = JSON.stringify({ organizationId: ${JSON.stringify(organizationId)}, name: "Phase 1 Double Submit" });
    const post = () => fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    const [a, b] = await Promise.all([post(), post()]);
    const list = await fetch("/api/workspaces?limit=100").then((r) => r.json());
    return {
      statuses: [a.status, b.status],
      created: list.items.filter((w) => w.name === "Phase 1 Double Submit").length,
      id: a.body?.workspace?.id ?? b.body?.workspace?.id ?? null,
    };
  })()`);
  check(
    "10: two simultaneous submits create exactly one Workspace",
    race?.created === 1 && race.statuses.includes(201) && race.statuses.includes(409),
    JSON.stringify(race),
  );
  await goto(`/workspaces/${race?.id}?organizationId=${organizationId}`, 3500);
  check(
    "10: the Workspace that won the race is immediately openable",
    /Phase 1 Double Submit/.test((await page()).text ?? ""),
    `status ${statusFor(`/workspaces/${race?.id}`)}`,
  );

  // ---- 11: archive, then restore ------------------------------------------
  await goto(`/workspaces/${secondId}?organizationId=${organizationId}`, 3000);
  const archived = await evaluate(`(async () => {
    const body = JSON.stringify({ organizationId: ${JSON.stringify(organizationId)} });
    const r = await fetch("/api/workspaces/${secondId}/archive", { method: "POST", headers: { "content-type": "application/json" }, body });
    const list = await fetch("/api/workspaces?limit=100").then((res) => res.json());
    return { status: r.status, listed: list.items.some((w) => w.id === "${secondId}") };
  })()`);
  check(
    "11: archiving succeeds and removes the Workspace from the active picker",
    archived?.status === 200 && archived.listed === false,
    JSON.stringify(archived),
  );
  await goto(`/workspaces/${secondId}?organizationId=${organizationId}`, 3500);
  view = await page();
  check(
    "11: an archived Workspace still opens for its owner — restore needs a way in",
    /Phase 1 Reliability Test Two/.test(view.text ?? "") &&
      statusFor(`/workspaces/${secondId}`) === 200,
    `status ${statusFor(`/workspaces/${secondId}`)}`,
  );
  const restored = await evaluate(`(async () => {
    const body = JSON.stringify({ organizationId: ${JSON.stringify(organizationId)} });
    const r = await fetch("/api/workspaces/${secondId}/restore", { method: "POST", headers: { "content-type": "application/json" }, body });
    const list = await fetch("/api/workspaces?limit=100").then((res) => res.json());
    return { status: r.status, listed: list.items.some((w) => w.id === "${secondId}") };
  })()`);
  check(
    "11: restore works and returns the Workspace to the picker",
    restored?.status === 200 && restored.listed === true,
    JSON.stringify(restored),
  );

  // ---- 12: refused ids are a controlled page, never a crash ----------------
  for (const [label, path] of [
    ["a nonexistent id", `/workspaces/ckzzzzzzzzzzzzzzzzzzzzzzz?organizationId=${organizationId}`],
    ["a malformed id", `/workspaces/%20?organizationId=${organizationId}`],
  ]) {
    await goto(path, 3000);
    view = await page();
    const status = documentStatuses.at(-1)?.status ?? null;
    check(
      `12: ${label} renders the controlled not-found page with a 404`,
      status === 404 && /not available/i.test(view.text ?? "") && !/server error/i.test(view.text ?? ""),
      `status ${status} — ${(view.text ?? "").split("\n").filter(Boolean)[0] ?? ""}`,
    );
    check(
      `12: ${label} leaks no identifier and no stack`,
      !/at \w+ \(|node_modules|WorkspaceService|prisma/i.test(view.text ?? ""),
      (view.text ?? "").slice(0, 80).replace(/\n/g, " | "),
    );
  }

  // ---- 13: another account's Workspace is the same controlled answer -------
  const otherEmail = `phase1.other.${stamp}@example.test`;
  // Sign out through the product's own endpoint. Clearing `document.cookie`
  // cannot work here: the session cookie is httpOnly, so the only real way out
  // is the logout route that also invalidates the session row server-side.
  const loggedOut = await evaluate(
    `fetch("/api/auth/logout", { method: "POST" }).then((r) => r.status)`,
  );
  check("13: signing out of the first account succeeds", loggedOut === 200, String(loggedOut));
  await goto("/register", 3000);
  await type("name", "Phase One Outsider");
  await type("email", otherEmail);
  await type("password", "Phase1-Probe-Password!");
  await type("confirmPassword", "Phase1-Probe-Password!");
  await evaluate(`document.querySelector('input[name="acceptedTerms"]').click()`);
  await clickText("Create account", "button");
  await sleep(7000);
  await goto(`/workspaces/${firstId}?organizationId=${organizationId}`, 3500);
  view = await page();
  const outsiderStatus = documentStatuses.at(-1)?.status ?? null;
  check(
    "13: another account gets the same controlled not-found, never the Workspace",
    outsiderStatus !== 200 &&
      !/Phase 1 Reliability Test/.test(view.text ?? "") &&
      !/server error/i.test(view.text ?? ""),
    `status ${outsiderStatus} — ${(view.text ?? "").split("\n").filter(Boolean)[0] ?? ""}`,
  );
  const outsiderList = await evaluate(
    `fetch("/api/workspaces?limit=100").then((r) => r.json()).then((j) => (j.items || []).map((w) => w.id).join(","))`,
  );
  check(
    "13: and the outsider's own picker does not advertise it either",
    !String(outsiderList ?? "").includes(firstId),
    String(outsiderList ?? ""),
  );

  // ---- browser health across the whole walk --------------------------------
  const hydration = consoleErrors.filter((line) =>
    /hydrat|did not match|Minified React error|Unhandled|unhandled/i.test(line),
  );
  check("browser console: no hydration or unhandled-rejection errors", hydration.length === 0, hydration.join(" || "));
  // `next dev` replays server-side console output into the browser console, and
  // `ConsoleLogger` writes warn/error to stderr — so the deliberate
  // `workspace.access.denied` lines from steps 12 and 13 arrive here. They are
  // evidence, not faults: separate them out, then assert that what remains is
  // empty. Splitting rather than loosening the regex keeps this able to fail.
  const forwardedLogs = consoleErrors.filter((line) => /"msg":"workspace\.access\.denied"/.test(line));
  const unexplained = consoleErrors.filter((line) => !forwardedLogs.includes(line));
  check(
    "browser console: no React or page exceptions beyond the deliberate access-denied logs",
    unexplained.length === 0,
    unexplained.slice(0, 3).join(" || "),
  );
  check(
    "observability: the refusals produced structured access-denied lines",
    forwardedLogs.length >= 2 &&
      forwardedLogs.every((line) => /"category":"WORKSPACE_(NOT_FOUND|ID_INVALID|ACCESS_DENIED)"/.test(line)),
    `${forwardedLogs.length} lines`,
  );
  check(
    "observability: those lines carry ids only — no email, token, cookie or password",
    !forwardedLogs.some((line) => /@example\.test|passwordHash|cookie|token|session=|Phase1-Probe-Password/i.test(line)),
    forwardedLogs[0] ?? "",
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
