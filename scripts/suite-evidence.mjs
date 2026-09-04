#!/usr/bin/env node
/* global process, console */
/**
 * Runs the vitest suite and KEEPS the evidence — including when it fails.
 *
 * This exists because of a run that could not be diagnosed: the final pre-launch
 * report recorded `1 failed | 7375 passed` at the branch tip and preserved neither
 * the failing test's name nor its output, so ten later green runs could not say what
 * had gone wrong. A suite invocation whose failure detail is only on a terminal that
 * has since scrolled is not evidence.
 *
 * What every run leaves behind, under --out:
 *
 *   <label>.log            complete stdout+stderr, interleaved as it was produced
 *   <label>.json           vitest's own JSON reporter output (machine-readable)
 *   <label>.junit.xml      JUnit, for anything that consumes that instead
 *   <label>.summary.json   the run's identity and every failure, extracted
 *
 * The summary is written in a `finally`, so a non-zero exit, a crash inside vitest
 * or an unwritten JSON report all still produce an artifact — and the runner then
 * exits with the suite's own code, so a caller cannot mistake a red run for green.
 *
 * Identity recorded on every run, because these are what made the original
 * unreproducible: the seed, whether order was shuffled, the worker ceiling, the
 * machine's parallelism, node version, platform, and per-test durations (vitest's
 * JSON carries those, which is how a timeout is told apart from an assertion).
 *
 * Evidence lands under docs/ on purpose. Nothing there is collected by vitest
 * (`include: ["**\/*.test.ts"]`), imported by the app, or copied into the standalone
 * artifact, so writing it cannot change what the product does.
 *
 * Usage:
 *   node scripts/suite-evidence.mjs                                   # full suite
 *   node scripts/suite-evidence.mjs --label single --workers 1
 *   node scripts/suite-evidence.mjs --label shuffled --shuffle --seed 12345
 *   node scripts/suite-evidence.mjs --label upload -- uploadBoundary.test.ts
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus, hostname, loadavg, totalmem, type } from "node:os";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const passthrough = argv.includes("--") ? argv.slice(argv.indexOf("--") + 1) : [];
const own = argv.includes("--") ? argv.slice(0, argv.indexOf("--")) : argv;
const flag = (name, fallback = null) => {
  const i = own.indexOf(`--${name}`);
  return i === -1 ? fallback : own[i + 1];
};
const has = (name) => own.includes(`--${name}`);

const outDir = resolve(flag("out", "docs/evidence/final-prelaunch/suite"));
const label = flag("label", "suite");
const seed = flag("seed");
const workers = flag("workers");
const shuffle = has("shuffle");

mkdirSync(outDir, { recursive: true });
const base = join(outDir, label);
const paths = {
  log: `${base}.log`,
  json: `${base}.json`,
  junit: `${base}.junit.xml`,
  summary: `${base}.summary.json`,
};

const vitestArgs = [
  "vitest",
  "run",
  "--reporter=verbose",
  "--reporter=json",
  `--outputFile.json=${paths.json}`,
  "--reporter=junit",
  `--outputFile.junit=${paths.junit}`,
];
if (shuffle) vitestArgs.push("--sequence.shuffle");
if (seed) vitestArgs.push(`--sequence.seed=${seed}`);
if (workers) vitestArgs.push(`--maxWorkers=${workers}`, `--minWorkers=${workers}`);
// No `--repeats`: vitest 3.2 has no such option, so forwarding one could only ever
// make vitest exit 1 before running a single test — a red run with nothing to
// attribute it to, which is the exact failure mode this harness exists to prevent.
// Repetition is N labelled invocations, each with its own retained artifact.
vitestArgs.push(...passthrough);

// A previous run under the same label leaves its reports on disk, and vitest writes
// them only if it actually runs. Removing them first is what stops last run's JSON
// from being read as this run's evidence.
for (const stale of [paths.json, paths.junit, paths.summary]) rmSync(stale, { force: true });

const log = createWriteStream(paths.log);
const startedAt = new Date();
const startedHr = process.hrtime.bigint();
const child = spawn("npx", vitestArgs, { cwd: process.cwd(), env: process.env });
for (const stream of ["stdout", "stderr"]) {
  child[stream].on("data", (chunk) => {
    process[stream === "stdout" ? "stdout" : "stderr"].write(chunk);
    log.write(chunk);
  });
}

const code = await new Promise((done) => child.on("close", (c) => done(c ?? 1)));
const durationMs = Number(process.hrtime.bigint() - startedHr) / 1e6;

/** Every failing assertion, with the identity needed to run it again alone. */
function failuresFrom(report) {
  const out = [];
  for (const file of report.testResults ?? []) {
    for (const a of file.assertionResults ?? []) {
      if (a.status !== "failed") continue;
      out.push({
        file: file.name,
        fullName: a.fullName ?? a.title,
        title: a.title,
        durationMs: a.duration ?? null,
        failureMessages: a.failureMessages ?? [],
      });
    }
    // A file that fails to collect has no assertions at all — its own message is
    // the only record, and dropping it is how a whole file's failure disappears.
    for (const m of file.message ? [file.message] : []) {
      if (file.status === "failed" && !(file.assertionResults ?? []).some((a) => a.status === "failed")) {
        out.push({ file: file.name, fullName: "(file did not collect)", title: null, durationMs: null, failureMessages: [m] });
      }
    }
  }
  return out;
}

try {
  let report = null;
  let reportError = null;
  try {
    report = JSON.parse(readFileSync(paths.json, "utf8"));
  } catch (err) {
    reportError = String(err?.message ?? err);
  }
  const failures = report ? failuresFrom(report) : [];
  /**
   * Four outcomes, not two. A nonzero exit says only "something went wrong", and the
   * audit this harness serves requires ENVIRONMENTAL and PRODUCT FAILURE to be told
   * apart — `--repeats=2`, a flag vitest 3.2 does not have, exited 1 without running
   * a test and was announced as "RED" beside real product failures.
   *   GREEN          exit 0.
   *   PRODUCT FAILURE  nonzero, and the report names the failing assertions.
   *   ENVIRONMENTAL  nonzero with no parsable report at all: a CLI rejection, a
   *                  crash before the first test, an OOM. Nothing about the product.
   *   UNATTRIBUTED   nonzero, report present, no failing assertion in it. The state
   *                  the original audit's "1 failed | 7375 passed" was left in.
   */
  const verdict =
    code === 0
      ? "GREEN"
      : !report
        ? "ENVIRONMENTAL"
        : failures.length > 0
          ? "PRODUCT FAILURE"
          : "UNATTRIBUTED";
  const slowest = report
    ? (report.testResults ?? [])
        .flatMap((f) => (f.assertionResults ?? []).map((a) => ({ file: f.name, fullName: a.fullName, durationMs: a.duration ?? 0 })))
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 15)
    : [];
  writeFileSync(
    paths.summary,
    `${JSON.stringify(
      {
        label,
        exitCode: code,
        green: code === 0,
        verdict,
        command: ["npx", ...vitestArgs].join(" "),
        startedAt: startedAt.toISOString(),
        durationMs: Math.round(durationMs),
        run: {
          seed: seed ?? null,
          shuffled: shuffle,
          maxWorkers: workers ?? "vitest default",
          availableParallelism: availableParallelism(),
          cpuCount: cpus().length,
          cpuModel: cpus()[0]?.model ?? null,
          loadavgAtExit: loadavg(),
          totalMemBytes: totalmem(),
          node: process.version,
          platform: `${type()} ${process.platform} ${process.arch}`,
          host: hostname(),
        },
        counts: report
          ? {
              totalTests: report.numTotalTests ?? null,
              passed: report.numPassedTests ?? null,
              failed: report.numFailedTests ?? null,
              pending: report.numPendingTests ?? null,
              totalSuites: report.numTotalTestSuites ?? null,
              totalFiles: (report.testResults ?? []).length,
            }
          : null,
        reportError,
        failures,
        slowestTests: slowest,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `\n[suite-evidence] ${verdict} · exit ${code} · ${failures.length} failure(s) recorded` +
      (reportError ? ` · ${reportError}` : ""),
  );
  for (const f of failures) console.log(`[suite-evidence] FAILED ${f.file} > ${f.fullName}`);
  console.log(`[suite-evidence] artifacts: ${paths.log} ${paths.json} ${paths.junit} ${paths.summary}`);
} finally {
  log.end();
}
process.exit(code);
