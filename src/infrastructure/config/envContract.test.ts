import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * `.env.example` is the deployment contract, and this file is what keeps it true.
 *
 * The failure it prevents is not a lint nit. A variable the application reads and
 * nobody documented is discovered by an operator, in production, in one of two
 * ways: the value is absent and a feature is silently off (analytics unstitched,
 * recovery never sweeping), or the value is present and wrong and the process
 * refuses to boot with no page anywhere explaining the string it rejected —
 * `LOG_LEVEL=verbose` fails the whole zod parse and exits. Both read as an
 * unexplained outage. The fix is cheap only while the reader is being written,
 * which is exactly when this test fails.
 *
 * Scope is the deployed application: `app/`, `lib/`, `src/`, `ingress/`, plus the
 * three root modules Next loads. `scripts/` is excluded on purpose — the probe
 * fleet reads its own harness variables (CHROME_PATH, QA_URL,
 * NODE_TLS_REJECT_UNAUTHORIZED) which no deployment sets and which would turn an
 * operator-facing document into a test-tooling changelog.
 *
 * The check is one-way. Documenting a variable the code no longer reads is not a
 * failure: a stale row costs an operator a moment, an undocumented one costs a
 * deploy.
 */

/** Comments stripped, so prose naming a variable neither satisfies nor breaks the rule. */
const codeOf = (abs: string): string =>
  readFileSync(abs, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");

const SOURCE_DIRS = ["app", "lib", "src", "ingress"];
const SOURCE_FILES = ["next.config.mjs", "instrumentation.ts", "proxy.ts"];
const EXT = /\.(ts|tsx|mjs|mts|js)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (EXT.test(entry.name) && !entry.name.includes(".test.")) out.push(abs);
  }
  return out;
}

/** `process.env.NAME` and `process.env["NAME"]`, dot and bracket form alike. */
const READ_PATTERN = /process\.env(?:\.([A-Z][A-Z0-9_]{2,})|\[\s*["'`]([A-Z][A-Z0-9_]{2,})["'`]\s*\])/g;

function readers(): Map<string, string[]> {
  const root = process.cwd();
  const files = [
    ...SOURCE_DIRS.flatMap((d) => walk(join(root, d))),
    ...SOURCE_FILES.map((f) => join(root, f)),
  ];
  const found = new Map<string, string[]>();
  for (const abs of files) {
    for (const m of codeOf(abs).matchAll(READ_PATTERN)) {
      const name = m[1] ?? m[2];
      const where = found.get(name) ?? [];
      where.push(relative(root, abs));
      found.set(name, where);
    }
  }
  return found;
}

/**
 * The zod schema reads `process.env` wholesale, so its keys never appear as
 * `process.env.KEY` and a grep alone would miss every one of them — including
 * DEPLOYMENT_TOPOLOGY and the three UPLOAD_* limits, which are the variables an
 * operator is most likely to get wrong.
 */
function schemaKeys(): string[] {
  const src = readFileSync(join(process.cwd(), "src/infrastructure/config/env.ts"), "utf8");
  const body = src.slice(src.indexOf("const envSchema = z.object({"));
  return [...body.matchAll(/^\s{2}([A-Z][A-Z0-9_]{2,}):/gm)].map((m) => m[1]);
}

const example = readFileSync(join(process.cwd(), ".env.example"), "utf8");
const documented = new Set(
  [...example.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)].map((m) => m[1]),
);

describe(".env.example documents every variable the application reads", () => {
  it("finds the readers at all (a broken scan would pass vacuously)", () => {
    const found = readers();
    expect(found.size).toBeGreaterThan(15);
    expect(found.has("NODE_ENV")).toBe(true);
    expect(schemaKeys()).toContain("DEPLOYMENT_TOPOLOGY");
  });

  it("documents every process.env reader in the deployed application", () => {
    const missing = [...readers().entries()]
      .filter(([name]) => !documented.has(name))
      .map(([name, where]) => `${name} (read in ${[...new Set(where)].join(", ")})`);
    expect(missing).toEqual([]);
  });

  it("documents every validated schema key", () => {
    expect(schemaKeys().filter((k) => !documented.has(k))).toEqual([]);
  });
});
