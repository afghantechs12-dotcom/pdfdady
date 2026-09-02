/* global process, console */
/**
 * Ad-hoc DOM inspector, for auditing a running PDFDadi.
 *
 * `responsive-qa.mjs` answers "does this page overflow at nine widths". This
 * answers "what, specifically, is that 20px-tall button with an em-dash for a
 * name" — the question a visual audit actually asks, and the one that otherwise
 * gets answered by grepping and guessing.
 *
 *   node scripts/ui-inspect.mjs --path /editor --width 360 --eval "document.title"
 *   node scripts/ui-inspect.mjs --path /tools --width 1440 --layout
 *   node scripts/ui-inspect.mjs --path / --width 390 --tab 12
 */
import { openBrowser, sleep } from "./lib/probe-browser.mjs";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg("--url", "http://localhost:3001");
const PATH = arg("--path", "/");
const WIDTH = Number(arg("--width", "1440"));
const HEIGHT = Number(arg("--height", WIDTH < 768 ? "800" : "900"));

const browser = await openBrowser({
  port: Number(arg("--port", "9461")),
  width: WIDTH,
  height: HEIGHT,
  insecure: BASE.startsWith("https:"),
});
try {
  await browser.resize(WIDTH, HEIGHT);
  await browser.goto(BASE, PATH, Number(arg("--wait", "2200")));
  await sleep(400);

  if (process.argv.includes("--layout")) {
    console.log(JSON.stringify(await browser.layout(), null, 1));
  }
  if (process.argv.includes("--errors")) {
    console.log(JSON.stringify(browser.errors(), null, 1));
  }
  const tab = arg("--tab", null);
  if (tab) console.log(JSON.stringify(await browser.tabThrough(Number(tab)), null, 1));
  const expr = arg("--eval", null);
  if (expr) console.log(JSON.stringify(await browser.evaluate(expr), null, 1));
  const shot = arg("--shot", null);
  if (shot) {
    await browser.shot(shot, { fullPage: process.argv.includes("--full") });
    console.log(`wrote ${shot}`);
  }
} finally {
  browser.close();
}
