/**
 * R1..R5 — the reconciliation half of the final readiness evidence.
 *
 * The audit these follow left four contradictions behind. Two of them were about
 * evidence rather than product: nine high-severity dependency advisories the static
 * harness reported as one opaque PRODUCT FAILURE, and one suite run that recorded
 * `1 failed | 7375 passed` without retaining the failing test's name. Both were
 * failures of record-keeping that a green test cannot notice, so these five tests
 * pin the records themselves.
 *
 * Numbering is this reconciliation's own; `finalPrelaunchRegression.test.ts` has an
 * unrelated R1..R30 from the audit before it. Cited by file, not by number alone.
 *
 * Same rule as its predecessor: every assertion calls, parses or executes the thing
 * it is about. R1..R3 re-derive the advisory inventory from npm's own machine-readable
 * audit output and from `package-lock.json`, so the written inventory cannot drift from
 * either the advisory data or the installed tree. R4 runs the evidence harness against
 * a deliberately red fixture and reads what it retained; R4b reads the vitest config
 * object the runner itself consumes. R5 re-runs the three files that actually failed,
 * in the shuffled order that failed them.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, matchesGlob } from "node:path";
import { describe, expect, it } from "vitest";
import vitestConfig from "./vitest.config";

const ROOT = process.cwd();
const EVIDENCE = join(ROOT, "docs/evidence/final-prelaunch");
const readJSON = (p: string) => JSON.parse(readFileSync(p, "utf8"));

type Advisory = {
  advisoryId: number;
  ghsa: string;
  package: string;
  severity: string;
  cwe: string[];
  title: string;
  vulnerableRange: string;
  introducedAtOrAbove: string;
  fixedAtOrAbove: string;
  productionReachable: boolean;
  dependencyPath: string;
  installedBefore: string;
  installedAfter: string;
  disposition: string;
  remediation: string;
};

const inventory = readJSON(join(EVIDENCE, "dependency-advisories.json")) as {
  baseline: Record<string, string | number>;
  advisories: Advisory[];
};

/**
 * npm's `metadata.vulnerabilities` counts flagged PACKAGES rolled up to their worst
 * severity, not advisories — which is exactly how "nine high" came to be reported for
 * a set that is seven high and two moderate. The real records are the objects in each
 * `via` array, keyed by `source`.
 */
function advisorySources(audit: { vulnerabilities?: Record<string, { via?: unknown[] }> }) {
  const found = new Map<number, { source: number; name: string; severity: string; range: string; title: string; url: string; cwe: string[] }>();
  for (const entry of Object.values(audit.vulnerabilities ?? {})) {
    for (const via of entry.via ?? []) {
      if (typeof via === "object" && via !== null && "source" in via) {
        const v = via as { source: number; name: string; severity: string; range: string; title: string; url: string; cwe: string[] };
        found.set(v.source, v);
      }
    }
  }
  return found;
}

const prodBaseline = advisorySources(readJSON(join(EVIDENCE, "audit-baseline-prod.json")));
const fullBaseline = advisorySources(readJSON(join(EVIDENCE, "audit-baseline-full.json")));

const lock = readJSON(join(ROOT, "package-lock.json")) as {
  packages: Record<string, { version?: string; dev?: boolean; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> }>;
};

/** Every copy of a package the lockfile installs, with the dev flag npm itself set. */
function installed(name: string) {
  return Object.entries(lock.packages)
    .filter(([path]) => path.endsWith(`node_modules/${name}`))
    .map(([path, meta]) => ({ path, version: meta.version ?? "", dev: meta.dev === true }));
}

/** Numeric release compare; every version in this inventory is a plain x.y.z. */
function cmp(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}
const inWindow = (v: string, from: string, to: string) => cmp(v, from) >= 0 && cmp(v, to) < 0;

describe("R1 — the advisory inventory is derived from the audit data, not written beside it", () => {
  it("carries every advisory both baseline audits reported, and invents none", () => {
    const recorded = new Set(inventory.advisories.map((a) => a.advisoryId));
    const audited = new Set([...prodBaseline.keys(), ...fullBaseline.keys()]);
    // Both directions. One catches an omission — this is the check that would have
    // caught `sharp`, the ninth flagged package missing from the earlier list of
    // eight. The other catches an entry with no advisory behind it.
    expect([...audited].filter((id) => !recorded.has(id)).sort()).toEqual([]);
    expect([...recorded].filter((id) => !audited.has(id)).sort()).toEqual([]);
    expect(recorded.size).toBe(11);
    expect(new Set(inventory.advisories.map((a) => a.advisoryId)).size).toBe(inventory.advisories.length);
  });

  it("repeats each advisory's package, severity, range, title, CWE and URL verbatim", () => {
    for (const entry of inventory.advisories) {
      const source = fullBaseline.get(entry.advisoryId) ?? prodBaseline.get(entry.advisoryId);
      expect(source, `advisory ${entry.advisoryId} is not in either baseline`).toBeDefined();
      expect(entry.package, String(entry.advisoryId)).toBe(source!.name);
      expect(entry.severity, String(entry.advisoryId)).toBe(source!.severity);
      expect(entry.vulnerableRange, String(entry.advisoryId)).toBe(source!.range);
      expect(entry.title, String(entry.advisoryId)).toBe(source!.title);
      expect(entry.cwe, String(entry.advisoryId)).toEqual(source!.cwe);
      expect(entry.ghsa, String(entry.advisoryId)).toBe(source!.url);
    }
  });

  it("states the same counts npm's own rollup states, keeping package and advisory apart", () => {
    const prodAudit = readJSON(join(EVIDENCE, "audit-baseline-prod.json")) as {
      vulnerabilities: Record<string, unknown>;
      metadata: { vulnerabilities: Record<string, number> };
    };
    // Nine flagged packages, nine distinct advisories, and the severities do not
    // agree with the rollup: npm reports all nine as high, the advisories are 7+2.
    expect(inventory.baseline.flaggedProductionPackages).toBe(Object.keys(prodAudit.vulnerabilities).length);
    expect(inventory.baseline.distinctProductionAdvisories).toBe(prodBaseline.size);
    expect(inventory.baseline.distinctFullGraphAdvisories).toBe(fullBaseline.size);
    expect(prodAudit.metadata.vulnerabilities.high).toBe(9);
    const bySeverity = [...prodBaseline.values()].reduce<Record<string, number>>((acc, v) => ({ ...acc, [v.severity]: (acc[v.severity] ?? 0) + 1 }), {});
    expect(bySeverity).toEqual({ high: 7, moderate: 2 });
  });
});

describe("R2 — dev-only and production-reachable are told apart by the real production graph", () => {
  it("re-derives each production-reachable claim from the audit graph and the lockfile's dev flags", () => {
    for (const entry of inventory.advisories) {
      // `npm audit --omit=dev` is the production graph's own answer.
      expect(entry.productionReachable, `${entry.advisoryId} ${entry.package}`).toBe(prodBaseline.has(entry.advisoryId));
      const copies = installed(entry.package);
      expect(copies.length, `${entry.package} is not installed at all`).toBeGreaterThan(0);
      // And the lockfile has to agree: something not in the production graph must
      // have no non-dev copy. "Transitive" is not an argument here, and neither is
      // "it looks like a build tool" — only npm's own dev flag counts.
      expect(copies.some((c) => !c.dev), `${entry.package} prod copy`).toBe(entry.productionReachable);
    }
    expect(inventory.advisories.filter((a) => a.productionReachable).length).toBe(9);
    expect(inventory.advisories.filter((a) => !a.productionReachable).map((a) => a.package)).toEqual(["browserslist", "browserslist"]);
  });

  it("walks each declared dependency path as real lockfile edges", () => {
    for (const entry of inventory.advisories) {
      const hops = entry.dependencyPath
        .split(/\s+[—(]/)[0]
        .split(">")
        .map((h) => h.replace(/\[[^\]]*\]/g, "").trim())
        .filter(Boolean);
      expect(hops[0], entry.dependencyPath).toBe("pdfdadi");
      expect(hops.at(-1), entry.dependencyPath).toBe(entry.package);
      for (let i = 0; i < hops.length - 1; i += 1) {
        const parent = hops[i];
        const child = hops[i + 1];
        const parents = parent === "pdfdadi" ? [lock.packages[""]] : installed(parent).map((c) => lock.packages[c.path]);
        expect(parents.length, `${parent} missing from lockfile`).toBeGreaterThan(0);
        const declares = parents.some((p) =>
          child in { ...(p?.dependencies ?? {}), ...(p?.devDependencies ?? {}), ...(p?.optionalDependencies ?? {}), ...(p?.peerDependencies ?? {}) },
        );
        expect(declares, `${entry.dependencyPath}: ${parent} does not depend on ${child}`).toBe(true);
      }
    }
  });
});

describe("R3 — every remediated advisory has an installed version outside its vulnerable range", () => {
  it("leaves no copy of any flagged package inside the advisory's window", () => {
    for (const entry of inventory.advisories) {
      for (const copy of installed(entry.package)) {
        expect(
          inWindow(copy.version, entry.introducedAtOrAbove, entry.fixedAtOrAbove),
          `${entry.advisoryId}: ${copy.path} is ${copy.version}, inside ${entry.vulnerableRange}`,
        ).toBe(false);
      }
    }
  });

  it("proves the window it checks is the one that was actually violated", () => {
    // Anti-vacuity. A window of [0.0.0, 0.0.0) excludes everything and would make
    // the test above pass for a dependency that was never fixed, so each entry has
    // to show its pre-fix version falling inside its own declared window.
    for (const entry of inventory.advisories) {
      const before = entry.installedBefore.match(/\d+\.\d+\.\d+/g) ?? [];
      expect(before.length, `${entry.advisoryId} records no pre-fix version`).toBeGreaterThan(0);
      expect(
        before.some((v) => inWindow(v, entry.introducedAtOrAbove, entry.fixedAtOrAbove)),
        `${entry.advisoryId}: none of ${before.join("/")} is inside ${entry.introducedAtOrAbove}..${entry.fixedAtOrAbove}`,
      ).toBe(true);
      expect(entry.disposition, String(entry.advisoryId)).toMatch(/^FIXED/);
    }
  });

  it("records the versions the lockfile actually installs today", () => {
    for (const entry of inventory.advisories) {
      for (const copy of installed(entry.package)) {
        expect(entry.installedAfter, `${entry.package} ${copy.version} is installed but unrecorded`).toContain(copy.version);
      }
    }
    // The two that needed something other than a version bump, pinned by name so a
    // silent revert of either is a red test rather than a returning advisory.
    expect(inventory.advisories.find((a) => a.advisoryId === 1145093)?.remediation).toContain("overrides");
    expect(readJSON(join(ROOT, "package.json")).overrides["deepmerge-ts"]).toBe("^8.0.2");
    expect(installed("deepmerge-ts").every((c) => cmp(c.version, "8.0.0") >= 0)).toBe(true);
  });
});

describe("R4 — a failing run leaves evidence that names what failed", () => {
  it("retains the test name, file, seed, worker count, timing and stack trace, and still exits nonzero", () => {
    const out = mkdtempSync(join(tmpdir(), "suite-evidence-r4-"));
    try {
      let exitCode = 0;
      try {
        execFileSync(
          process.execPath,
          ["scripts/suite-evidence.mjs", "--out", out, "--label", "r4", "--seed", "424242", "--workers", "1",
           "--", "--config", "test/fixtures/vitest.fixture.config.ts"],
          { cwd: ROOT, stdio: "pipe" },
        );
      } catch (err) {
        exitCode = (err as { status?: number }).status ?? -1;
      }
      // The point of the harness: a red run does not lose its evidence to its own
      // exit code. Both have to be true at once.
      expect(exitCode, "the harness must propagate vitest's failure").toBe(1);

      const summary = readJSON(join(out, "r4.summary.json"));
      expect(summary.exitCode).toBe(1);
      expect(summary.green).toBe(false);
      expect(summary.counts).toMatchObject({ totalTests: 2, passed: 1, failed: 1 });
      expect(summary.run).toMatchObject({ seed: "424242", maxWorkers: "1", shuffled: false });
      expect(typeof summary.run.availableParallelism).toBe("number");
      expect(summary.run.node).toBe(process.version);
      expect(summary.durationMs).toBeGreaterThan(0);

      expect(summary.failures).toHaveLength(1);
      const [failure] = summary.failures;
      expect(failure.file).toContain("test/fixtures/failing.fixture.ts");
      expect(failure.fullName).toContain("fails so that a retained artifact has a failure to carry");
      expect(typeof failure.durationMs).toBe("number");
      expect(failure.failureMessages[0]).toContain("this fixture is supposed to be red");
      expect(failure.failureMessages[0], "a stack frame is what makes it reproducible")
        .toContain("failing.fixture.ts:");
      // The passing sibling must not appear as a failure, or the record is noise.
      expect(summary.failures.map((f: { fullName: string }) => f.fullName).join(" ")).not.toContain("distinguish the two");
      // The replacement for the timing signal a tight per-test timeout used to give.
      expect(summary.slowestTests.length).toBeGreaterThan(0);
      expect(summary.slowestTests[0]).toHaveProperty("durationMs");

      // Complete stdout/stderr, plus a machine-readable result in two formats.
      const log = readFileSync(join(out, "r4.log"), "utf8");
      expect(log).toContain("failing.fixture.ts");
      expect(log.length).toBeGreaterThan(200);
      expect(readJSON(join(out, "r4.json")).numFailedTests).toBe(1);
      expect(readFileSync(join(out, "r4.junit.xml"), "utf8")).toContain("<failure");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("says ENVIRONMENTAL, not RED, when vitest never ran at all", () => {
    // Found by using the harness: `--repeats=2`, a flag vitest 3.2 does not have,
    // exited 1 before the first test and was announced as "RED · 0 failure(s)
    // recorded" — the shape of a mystery product failure, which is what this whole
    // section exists to abolish. The forwarding is gone; the classification is the
    // part that has to survive the next dead flag.
    const out = mkdtempSync(join(tmpdir(), "suite-evidence-env-"));
    try {
      let exitCode = 0;
      try {
        execFileSync(
          process.execPath,
          ["scripts/suite-evidence.mjs", "--out", out, "--label", "env", "--", "--no-such-vitest-flag"],
          { cwd: ROOT, stdio: "pipe" },
        );
      } catch (err) {
        exitCode = (err as { status?: number }).status ?? -1;
      }
      expect(exitCode).toBe(1);
      const summary = readJSON(join(out, "env.summary.json"));
      expect(summary.verdict).toBe("ENVIRONMENTAL");
      expect(summary.green).toBe(false);
      // The distinction it draws: nothing was measured, so nothing is attributed.
      expect(summary.failures).toEqual([]);
      expect(summary.counts).toBeNull();
      expect(summary.reportError).toBeTruthy();
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("attributes a real failure to the product, and never to the environment", () => {
    // The red artifact predates the `verdict` field, so it is read on the facts the
    // field is derived FROM: a parsed report (no reportError) that names its failures.
    // That is the discriminator; the label is downstream of it.
    const red = readJSON(join(EVIDENCE, "suite/m3-shuffle-20260904.summary.json"));
    expect(red.reportError).toBeNull();
    expect(red.failures.length).toBe(3);
    // And a leg recorded since carries the label itself.
    const green = readJSON(join(EVIDENCE, "suite/m10-shuffle-31337.summary.json"));
    expect(green.verdict).toBe("GREEN");
    expect(green.counts.failed).toBe(0);
  });

  it("keeps the intentionally red fixture out of the suite that must stay green", () => {
    const { include, exclude } = vitestConfig.test as { include: string[]; exclude: string[] };
    const collected = (file: string) =>
      include.some((p) => matchesGlob(file, p)) && !exclude.some((p) => matchesGlob(file, p));
    expect(collected("test/fixtures/failing.fixture.ts")).toBe(false);
    expect(collected("finalReconciliation.test.ts")).toBe(true);
  });
});

describe("R4b — the per-test time budget is chosen, and it covers the test that crossed it", () => {
  // Measured on the machine that recorded the failure: `app/seoIndexingTruth.test.ts`
  // imports all 55 `app/**/page.tsx` modules, taking 1591ms alone and 4263ms under
  // the CPU contention of the other 379 test files, against vitest's unset-and-
  // therefore-default 5000ms. That is the number the budget has to clear.
  const MEASURED_WORST_MS = 4263;

  it("declares testTimeout explicitly instead of inheriting vitest's 5000ms default", () => {
    const config = vitestConfig.test as { testTimeout?: number };
    expect(typeof config.testTimeout, "an unset budget is the defect this pins").toBe("number");
    expect(config.testTimeout).not.toBe(5000);
    // Six times the worst measurement, so a slower machine and a bigger app tree
    // both stay inside it. Anything smaller is a budget that will be crossed again.
    expect(config.testTimeout!).toBeGreaterThanOrEqual(MEASURED_WORST_MS * 6);
  });

  it("applies that budget to the file that timed out, and to the whole suite with it", () => {
    const { include, exclude } = vitestConfig.test as { include: string[]; exclude: string[] };
    // No per-file timeout override exists in this config, so the check is that the
    // file which crossed the default is collected by the config that now sets one.
    expect(include.some((p) => matchesGlob("app/seoIndexingTruth.test.ts", p))).toBe(true);
    expect(exclude.some((p) => matchesGlob("app/seoIndexingTruth.test.ts", p))).toBe(false);
    // And the walk whose cost caused it is still the real one: 55 page modules and
    // growing, which is why the budget is a multiple rather than the measurement.
    expect(execFileSync("git", ["ls-files", "app/**/page.tsx"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").length)
      .toBeGreaterThan(40);
  });
});

describe("R5 — ordering, seeds and parallelism cannot silently reintroduce cross-test interference", () => {
  /**
   * The unnamed failure, once it had a name.
   *
   * A full-suite run at `--sequence.shuffle --sequence.seed=20260904` recorded three
   * failures (retained: `suite/m3-shuffle-20260904.summary.json`) where the default
   * order, a single worker, and two other seeds were all green. Two were ORDER
   * COUPLING — a test reading shared state a sibling had left behind: a module-level
   * `vi.fn()`'s call count, and a module-level migration registry with no unregister
   * API. Those reproduce exactly, at this seed, with these three files, which is what
   * the first test below runs.
   *
   * The third was a load-dependent TIMING RACE, not an ordering one: five waits in
   * `ProcessingJobHandler.test.ts` raced the handler's abort against a 3s fallback
   * timer of their own, so "the abort was late" and "the abort never came" were the
   * same anonymous red. No seed reproduces a 56-loadavg scheduling window, so that one
   * is fixed by construction — the fallback is gone — and pinned by source below
   * rather than by re-running it.
   */
  const SEED = "20260904";
  const COUPLED = [
    "src/application/services/workspaceRouteAccess.test.ts",
    "src/application/editor/serialization/SerializationService.test.ts",
    "src/infrastructure/jobs/ProcessingJobHandler.test.ts",
  ];

  it("runs the three files that failed, in the shuffled order that failed them", () => {
    let status = 0;
    let out: string;
    try {
      out = execFileSync(
        process.execPath,
        ["node_modules/vitest/vitest.mjs", "run", ...COUPLED, "--sequence.shuffle", `--sequence.seed=${SEED}`],
        // NO_COLOR so the summary line is greppable: vitest's own ANSI codes sit
        // between "Test Files" and its count.
        { cwd: ROOT, encoding: "utf8", stdio: "pipe", env: { ...process.env, NO_COLOR: "1" } },
      );
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      status = e.status ?? -1;
      out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    // Revert either fix and this is red again at this seed — it is the reproduction,
    // not a smoke test.
    expect(out).toContain(`seed "${SEED}"`);
    expect(status, out.slice(-4000)).toBe(0);
    expect(out).toMatch(/Test Files\s+3 passed \(3\)/);
  });

  it("keeps the red artifact that found it, and a green one at the same seed", () => {
    const red = readJSON(join(EVIDENCE, "suite/m3-shuffle-20260904.summary.json"));
    expect(red.run).toMatchObject({ seed: SEED, shuffled: true });
    expect(red.green).toBe(false);
    expect(red.counts.failed).toBe(3);
    // The retained record names all three files, so the diagnosis can be re-derived
    // from evidence rather than from this comment.
    expect(red.failures.map((f: { file: string }) => f.file.replace(`${ROOT}/`, "")).sort()).toEqual(
      [...COUPLED].sort(),
    );
    for (const f of red.failures as { failureMessages: string[] }[]) {
      expect(f.failureMessages[0]).toMatch(/\.test\.ts:\d+/);
    }
    // Same seed, same shuffle, after the fixes. Two artifacts, not one edited one.
    const green = readJSON(join(EVIDENCE, "suite/m6-shuffle-20260904-fixed.summary.json"));
    expect(green.run).toMatchObject({ seed: SEED, shuffled: true });
    expect(green.green).toBe(true);
    expect(green.counts.failed).toBe(0);
    expect(green.counts.totalTests).toBeGreaterThanOrEqual(red.counts.totalTests);
  });

  it("leaves no wall-clock fallback racing an abort in the handler suite", () => {
    const src = readFileSync(join(ROOT, "src/infrastructure/jobs/ProcessingJobHandler.test.ts"), "utf8");
    expect(src).toContain("function abortOf(signal: AbortSignal)");
    expect(src.match(/await abortOf\(ctx\.signal\)/g)).toHaveLength(5);
    // The reintroduction this pins: a timer that resolves the wait the HANDLER was
    // supposed to resolve. It makes a broken ceiling and a busy machine indistinguishable.
    expect(src).not.toMatch(/setTimeout\(resolve/);
  });

  it("resets the shared not-found spy in a hook, not in whichever test runs first", () => {
    const src = readFileSync(join(ROOT, "src/application/services/workspaceRouteAccess.test.ts"), "utf8");
    expect(src).toMatch(/beforeEach\(\(\) => \{\s*notFound\.mockClear\(\);\s*\}\)/);
  });
});
