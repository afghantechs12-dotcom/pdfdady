#!/usr/bin/env node
/* global process, console, URL, fetch, setTimeout, setInterval, clearInterval */
/**
 * The two performance numbers `perf-load-probe.mjs` does not produce: what memory
 * looks like under sustained load, and how long a cold process takes to serve.
 *
 * `perf-load-probe.mjs` measures a *burst* — how wide a fan-out is accepted before
 * something sheds. That answers "does the limiter hold", not "does RSS come back
 * down afterwards", and the second question is the one that sizes a container's
 * memory limit. A burst that peaks at 650MB and settles at 370MB needs a very
 * different `mem_limit` from one that peaks and stays there, and neither is visible
 * in a fan-out ladder: it finishes in 110ms.
 *
 * Cold start is here for the same reason. `/api/health` answering 200 is what a
 * platform's health check waits for before it routes traffic, so the interval
 * between exec and that first 200 is the deploy's blind window — and it is not the
 * same number as the first SSR render, which is what the first visitor actually
 * waits for. Both are measured, separately.
 *
 * Sustained means *bounded*: a fixed duration at a fixed concurrency over GET paths
 * that are not rate limited, so the soak measures the server rather than the
 * limiter. It writes nothing, creates no jobs, and needs no credentials.
 *
 *   node scripts/perf-soak-probe.mjs --seconds 60 --concurrency 4 --idle 30
 *   AUDIT_DATABASE_URL=… AUDIT_STORAGE_ROOT=… node scripts/perf-soak-probe.mjs --cold-start
 *
 * `--cold-start` SIGTERMs whatever is listening and relaunches it with
 * `scripts/restart-origin.sh`, inheriting this process's environment — so the AUDIT_*
 * overrides have to be passed the same way that script is normally invoked, or the
 * origin comes back pointed at different throwaway state. It is deliberately opt-in
 * for that reason. Like the load probe, this one measures and does not judge: there
 * is no pass threshold, and it exits 0 unless it cannot find a server at all.
 */
import { spawn, execFileSync } from "node:child_process";
import { openSync } from "node:fs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const URL_ = arg("url", "http://127.0.0.1:3002");
const PORT = new URL(URL_).port || "80";
const SECONDS = Number(arg("seconds", 60));
const CONC = Number(arg("concurrency", 4));
const IDLE = Number(arg("idle", 30));
const COLD = process.argv.includes("--cold-start");
/** Unauthenticated GETs, none of them rate limited: the soak measures the server. */
const PATHS = ["/", "/tools", "/api/health", "/pricing"];

const sleep = (n) => new Promise((r) => setTimeout(r, n));
const since = (t) => Number(process.hrtime.bigint() - t) / 1e6;
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
const pid = () => { try { return sh("lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN", "-t"]).split("\n")[0]; } catch { return ""; } };
const rss = (p) => { try { return Number(sh("ps", ["-o", "rss=", "-p", p])); } catch { return 0; } };
const get = async (p) => { try { const r = await fetch(URL_ + p); await r.arrayBuffer(); return r.status; } catch { return 0; } };

let server = pid();
if (!server) { console.error(`no process is listening on ${URL_}`); process.exit(1); }
console.log(`SOAK/COLD-START PROBE — ${URL_} · pid ${server} · ${SECONDS}s at concurrency ${CONC}`);
console.log(`paths: ${PATHS.join(" ")} (unauthenticated, not rate limited)\n`);

const lat = [];
const codes = new Map();
const samples = [rss(server)];
let n = 0;
const deadline = Date.now() + SECONDS * 1000;
const sampler = setInterval(() => samples.push(rss(server)), 2000);
await Promise.all(
  Array.from({ length: CONC }, async () => {
    while (Date.now() < deadline) {
      const t = process.hrtime.bigint();
      const code = await get(PATHS[n++ % PATHS.length]);
      lat.push(since(t));
      codes.set(code, (codes.get(code) ?? 0) + 1);
    }
  }),
);
clearInterval(sampler);
lat.sort((a, b) => a - b);
const q = (p) => Math.round(lat[Math.floor((lat.length - 1) * p)]);
console.log("══ SUSTAINED LOAD ══");
console.log(`  requests            ${lat.length} (${Math.round(lat.length / SECONDS)}/s)`);
console.log(`  statuses            ${[...codes].map(([k, v]) => `${v}×${k || "network error"}`).join(" ")}`);
console.log(`  latency ms          p50=${q(0.5)} p95=${q(0.95)} p99=${q(0.99)} max=${Math.round(lat.at(-1))}`);
console.log(`  rss KB              start=${samples[0]} peak=${Math.max(...samples)} end=${samples.at(-1)}`);

if (IDLE > 0) {
  console.log(`\n══ AFTER LOAD (${IDLE}s idle, sampled every 10s) ══`);
  for (let t = 10; t <= IDLE; t += 10) { await sleep(10_000); console.log(`  +${String(t).padStart(3)}s              rss=${rss(server)} KB`); }
}

if (COLD) {
  console.log("\n══ COLD START ══");
  let t = process.hrtime.bigint();
  process.kill(Number(server), "SIGTERM");
  while (pid()) await sleep(25);
  console.log(`  SIGTERM to port free  ${Math.round(since(t))} ms`);
  const log = openSync("/tmp/perf-soak-coldstart.log", "w");
  t = process.hrtime.bigint();
  spawn("scripts/restart-origin.sh", [], { cwd: process.cwd(), detached: true, stdio: ["ignore", log, log] }).unref();
  while (!pid()) await sleep(25);
  const listening = since(t);
  let code, health;
  do { code = await get("/api/health"); health = since(t); } while (code !== 200 && health < 60_000);
  console.log(`  exec to listening     ${Math.round(listening)} ms (includes the .next/static copy)`);
  console.log(`  exec to /api/health   ${Math.round(health)} ms ${code === 200 ? "" : `— gave up at ${code}`}`);
  t = process.hrtime.bigint();
  const first = await get("/");
  console.log(`  first GET / (cold)    ${Math.round(since(t))} ms → ${first}`);
  t = process.hrtime.bigint();
  const second = await get("/");
  console.log(`  second GET / (warm)   ${Math.round(since(t))} ms → ${second}`);
  server = pid();
  console.log(`  /api/health/ready     ${await get("/api/health/ready")}`);
  console.log(`  rss KB (fresh boot)   ${rss(server)} · pid ${server} · boot log /tmp/perf-soak-coldstart.log`);
}
