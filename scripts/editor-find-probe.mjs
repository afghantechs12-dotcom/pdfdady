/* global process, console, fetch, WebSocket, setTimeout */
/**
 * Functional probe for the in-document find bar (Ctrl+F).
 *
 * The unit tests prove `searchDocument` is correct; they cannot prove the feature
 * is WIRED. This drives the real editor in a real browser: it types text into the
 * canvas document, presses Ctrl+F, types a query, and asserts that the bar opened
 * and reported the matches the engine should have found.
 *
 * Usage: node scripts/editor-find-probe.mjs [--url http://localhost:3001]
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg("--url", "http://localhost:3001");
// Browser binary. `CHROME_PATH` lets a non-Windows machine (or a Chrome for
// Testing download) point the probe at its own build; the literal default keeps
// the original Windows invocation working untouched.
const CHROME =
  process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), "pdfdadi-find-"));
  const port = 9417;
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
  const consoleErrors = [];
  sock.addEventListener("message", (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      consoleErrors.push(
        (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200),
      );
    }
    if (msg.method === "Runtime.exceptionThrown") {
      consoleErrors.push(msg.params?.exceptionDetails?.text ?? "exception");
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
    return res.result?.result?.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: `${BASE}/editor` });
  await sleep(3200);

  const failures = [];
  const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failures.push(name);
  };

  // Dismiss onboarding so the canvas (and the tool row) is live.
  await evaluate(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const blank = btns.find((b) => /blank/i.test(b.textContent || ''));
    if (blank) { blank.click(); return 'clicked'; }
    return 'none';
  })()`);
  await sleep(1200);

  // --- Seed real text into the document -------------------------------------
  // Selects the text tool and clicks the canvas, so the document contains a real
  // text object created the way a user creates one. If the gesture does not
  // produce an object the probe still runs: the find bar's wiring, honesty
  // messaging and Escape behaviour are all observable on an empty document, and
  // `searchDocument` itself is covered exhaustively by unit tests.
  // --- Seed real text into the document -------------------------------------
  // Selects the text tool and clicks the PAGE (the largest white rect — not the
  // ruler strips, which are also SVG rects and which an earlier version of this
  // probe hit by mistake), then types via real CDP key events so the editor's own
  // input handling runs. The resulting text object is what search must find.
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('[role="toolbar"] button')].find((x) =>
      /^(text tool|add text|text)$/i.test((x.getAttribute('aria-label') || x.textContent || '').trim()));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(400);

  const pagePoint = await evaluate(`(() => {
    const rects = [...document.querySelectorAll('main svg rect')]
      .map((r) => r.getBoundingClientRect())
      .filter((b) => b.width > 200 && b.height > 200)
      .sort((a, b) => b.width * b.height - a.width * a.height);
    if (!rects.length) return null;
    const b = rects[0];
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  })()`);

  const SEED_WORD = "Findable";
  let seeded = { ok: false, why: "no page rect" };
  if (pagePoint) {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", {
        type,
        x: pagePoint.x,
        y: pagePoint.y,
        button: "left",
        clickCount: 1,
        buttons: type === "mousePressed" ? 1 : 0,
      });
    }
    await sleep(900);
    // Entering the text object's inline editor requires a DOUBLE click (a single
    // click places/selects it); that opens a real <textarea>. `Input.insertText`
    // is used rather than per-character key events because the latter do not
    // produce input in a headless textarea reliably.
    for (const clickCount of [1, 2]) {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", {
          type,
          x: pagePoint.x,
          y: pagePoint.y,
          button: "left",
          clickCount,
          buttons: type === "mousePressed" ? 1 : 0,
        });
      }
    }
    await sleep(800);
    await send("Input.insertText", { text: SEED_WORD });
    await sleep(500);
    for (const type of ["keyDown", "keyUp"]) {
      await send("Input.dispatchKeyEvent", {
        type,
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      });
    }
    await sleep(700);
    seeded = await evaluate(`(() => ({
      ok: true,
      texts: [...document.querySelectorAll('main svg text')].map((t) => t.textContent),
    }))()`);
  }

  console.log(`seed: ${JSON.stringify(seeded)}`);

  // --- Ctrl+F opens the find bar --------------------------------------------
  const pressCtrlF = async () => {
    for (const type of ["keyDown", "keyUp"]) {
      await send("Input.dispatchKeyEvent", {
        type,
        key: "f",
        code: "KeyF",
        windowsVirtualKeyCode: 70,
        nativeVirtualKeyCode: 70,
        modifiers: 2, // Ctrl
      });
    }
  };
  await pressCtrlF();
  await sleep(700);

  const bar = await evaluate(`(() => {
    const el = document.querySelector('[role="search"][aria-label="Find in document"]');
    if (!el) return { open: false };
    const input = el.querySelector('input');
    return {
      open: true,
      focused: document.activeElement === input,
      placeholder: input?.getAttribute('placeholder') || '',
      hasCaseToggle: !!el.querySelector('[aria-label="Match case"]'),
      hasWholeWord: !!el.querySelector('[aria-label="Match whole word"]'),
      hasNext: !!el.querySelector('[aria-label="Next match"]'),
      hasPrev: !!el.querySelector('[aria-label="Previous match"]'),
    };
  })()`);
  check("Ctrl+F opens the find bar", bar?.open === true, JSON.stringify(bar));
  check("find input receives focus", bar?.focused === true);
  check("placeholder reads 'Search in document'", /search in document/i.test(bar?.placeholder || ""));
  check("case + whole-word toggles present", bar?.hasCaseToggle && bar?.hasWholeWord);
  check("next/prev controls present", bar?.hasNext && bar?.hasPrev);

  // --- Typing a query that cannot match reports 0, not a crash ---------------
  const typeQuery = async (text) => {
    await evaluate(`(() => {
      const el = document.querySelector('[role="search"][aria-label="Find in document"] input');
      if (!el) return false;
      el.focus();
      return true;
    })()`);
    // `Input.insertText` goes through the browser's real text-input path, which
    // per-character key events do not do reliably in headless mode.
    await send("Input.insertText", { text });
    await sleep(500);
  };

  await typeQuery("zzzznotpresent");
  const noHits = await evaluate(`(() => {
    const el = document.querySelector('[role="search"][aria-label="Find in document"]');
    return { status: el?.querySelector('[role="status"]')?.textContent?.trim() || '', body: el?.textContent || '' };
  })()`);
  check(
    "a query with no matches reports zero honestly",
    /0/.test(noHits.status) || /no matches|no searchable text/i.test(noHits.body),
    JSON.stringify(noHits).slice(0, 200),
  );

  // --- Adversarial: a regex metacharacter must not throw ---------------------
  await evaluate(`(() => {
    const el = document.querySelector('[role="search"][aria-label="Find in document"] input');
    if (el) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`);
  const errorsBefore = consoleErrors.length;
  await typeQuery("(");
  await sleep(400);
  check(
    "a lone '(' does not throw (query is literal, not regex)",
    consoleErrors.length === errorsBefore,
    consoleErrors.slice(errorsBefore).join(" | ").slice(0, 200),
  );

  // --- A query that SHOULD match reports hits and renders results ------------
  // The word is read back off the canvas rather than assumed, but ruler tick
  // labels are also SVG <text> nodes ("0", "500", …) — so only alphabetic runs
  // qualify, which excludes the rulers by construction.
  const canvasWord = await evaluate(`(() => {
    const words = [...document.querySelectorAll('main svg text')]
      .map((t) => (t.textContent || '').trim())
      .flatMap((s) => s.match(/[A-Za-z]{4,}/g) || []);
    return words[0] || null;
  })()`);

  if (canvasWord) {
    await evaluate(`(() => {
      const el = document.querySelector('[role="search"][aria-label="Find in document"] input');
      if (el) {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
          .set.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()`);
    await typeQuery(canvasWord);
    const hits = await evaluate(`(() => {
      const el = document.querySelector('[role="search"][aria-label="Find in document"]');
      if (!el) return null;
      const status = el.querySelector('[role="status"]')?.textContent?.trim() || '';
      const results = [...el.querySelectorAll('ul[aria-label="Search results"] button')];
      return {
        status,
        resultCount: results.length,
        marks: el.querySelectorAll('mark').length,
        firstResult: (results[0]?.textContent || '').trim().slice(0, 60),
      };
    })()`);
    check(
      `a real word from the canvas ("${canvasWord}") is found`,
      !!hits && /[1-9]/.test(hits.status) && hits.resultCount > 0,
      JSON.stringify(hits),
    );
    check(
      "matches are highlighted in the results list",
      !!hits && hits.marks > 0,
      `marks=${hits?.marks}`,
    );
  } else {
    check("canvas exposed searchable text to query", false, "no text found on canvas to search for");
  }

  // --- Escape closes ---------------------------------------------------------
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
  }
  await sleep(500);
  const closed = await evaluate(
    `!document.querySelector('[role="search"][aria-label="Find in document"]')`,
  );
  check("Escape closes the find bar", closed === true);

  // --- The browser's native find must not have been triggered ---------------
  check(
    "no console errors during the whole flow",
    consoleErrors.length === 0,
    consoleErrors.join(" | ").slice(0, 300),
  );

  console.log("");
  console.log(failures.length === 0 ? "ALL CHECKS PASSED" : `FAILURES: ${failures.join(", ")}`);

  sock.close();
  chrome.kill();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("probe error:", err);
  process.exit(2);
});
