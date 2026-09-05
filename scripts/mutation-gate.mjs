/* global process, console */
/**
 * §8 mutation testing: does each gate actually fail when the thing it guards
 * breaks?
 *
 * A green suite proves nothing on its own — every one of these tests passed
 * before it was written, against code that did not exist. So each mutation below
 * removes exactly one property of the boundary, runs only the gate that claims to
 * own it, and requires a NON-ZERO exit. A mutation that leaves its gate green is
 * the finding, and the row fails.
 *
 * One at a time, always reverted: the tree must be clean before and after, and
 * the revert is `git checkout --` (or a delete, for a mutation that adds a file)
 * rather than an inverse edit, so a botched patch cannot survive the run.
 *
 * Usage:
 *   node scripts/mutation-gate.mjs [--only M7] [--json out.json]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const POLICY = "ingress/policy.mjs";
const GUARD = "ingress/guard.mjs";
const LEASE = "src/infrastructure/config/instanceLease.ts";
const STATE = "src/infrastructure/config/ingressState.ts";
const PROBE_ROUTE = "app/api/_mutation_probe/route.ts";

/**
 * `gate` is the vitest path; `find`/`replace` is the single edit. `create` writes
 * a new file instead, which is how the "a new body-consuming route appears"
 * mutation is expressed — there is nothing to edit until the route exists.
 */
const MUTATIONS = [
  {
    id: "M1",
    property: "class A refuses every body",
    file: POLICY,
    gate: "ingress/policy.test.ts",
    find: "export const CLASS_A_MAX_BYTES = 0;",
    replace: "export const CLASS_A_MAX_BYTES = 120 * 1024 * 1024;",
  },
  {
    id: "M2",
    property: "a chunked body on A or B is 411, unread",
    file: POLICY,
    gate: "ingress/policy.test.ts",
    find: '  if (headers["transfer-encoding"] !== undefined) {\n    return {\n      status: 411,',
    replace: '  if (false && headers["transfer-encoding"] !== undefined) {\n    return {\n      status: 411,',
  },
  {
    id: "M3",
    property: "the ceiling is inclusive — exactly the limit still reaches the app",
    file: POLICY,
    gate: "ingress/policy.test.ts",
    find: "  if (declared > maxBytes) {",
    replace: "  if (declared >= maxBytes) {",
  },
  {
    id: "M4",
    property: "Content-Length is read the way Node's parser reads it",
    file: POLICY,
    gate: "ingress/policy.test.ts",
    find: "  const declared = /^\\d+$/.test(raw) ? Number(raw) : Number.NaN;",
    replace: "  const declared = Number(raw);",
  },
  {
    id: "M5",
    property: "class C is exactly the matcher's five exclusions",
    file: POLICY,
    gate: "ingress/policy.test.ts",
    find: '  "^/api/tools/[^/]+$",\n',
    replace: "",
  },
  {
    // Not on the policy — `ingressDecision` is keyed on the headers and its own
    // test says so. This is the seam applying it, which is a different claim: a
    // GET may legally carry a body, and Node will parse it either way.
    id: "M6",
    property: "the seam applies the policy to every method, GET included",
    file: GUARD,
    gate: "ingress/guard.test.ts",
    find: "  const decision = ingressDecision({ url: req.url ?? \"/\", headers: req.headers ?? {} });",
    replace:
      "  const decision =\n" +
      "    req.method === \"GET\" || req.method === \"HEAD\"\n" +
      "      ? null\n" +
      "      : ingressDecision({ url: req.url ?? \"/\", headers: req.headers ?? {} });",
  },
  {
    id: "M7",
    property: "a refusal discloses nothing about the path it refused",
    file: POLICY,
    gate: "ingress/policy.test.ts",
    find: '      message: "Request body is too large.",',
    replace: '      message: `Request body is too large for a class ${cls} path.`,',
  },
  {
    id: "M8",
    property: "shutdown releases the lease while it still reads held",
    file: GUARD,
    gate: "ingress/guard.test.ts",
    find: "    releasing = Promise.resolve()\n      .then(release)",
    replace:
      '    ingressState.lease = "released";\n' +
      "    releasing = Promise.resolve()\n      .then(release)",
  },
  {
    id: "M9",
    property: "the exit waits for the release, but not forever",
    file: GUARD,
    gate: "ingress/guard.test.ts",
    find: "  proc.exit = (code) => {\n    if (!releasing) return realExit(code);",
    replace: "  proc.exit = (code) => {\n    if (releasing || !releasing) return realExit(code);",
  },
  {
    id: "M10",
    property: "acquisition is a compare-and-swap, not a read then a write",
    file: LEASE,
    gate: "src/infrastructure/config/instanceLease.test.ts",
    find: "      OR: [{ holder: holderId }, { expiresAt: { lt: stealableBefore } }],",
    replace: "      // mutation: any process may take a live lease",
  },
  {
    id: "M11",
    property: "an unguarded production process refuses to start",
    file: STATE,
    gate: "src/infrastructure/config/ingressState.test.ts",
    find: "  if (ingressState().installed) return;",
    replace: "  if (ingressState().installed || true) return;",
  },
  {
    id: "M12",
    property: "the container starts the entry that installs the guard",
    file: "Dockerfile",
    gate: "deploymentArtifact.test.ts",
    find: "exec node ingress/server.mjs",
    replace: "exec node server.js",
  },
  {
    id: "M13",
    property: "a new body-consuming route cannot appear without a body policy",
    file: PROBE_ROUTE,
    gate: "ingress/bodyRoutes.test.ts",
    create: `import { NextResponse } from "next/server";\n
export async function POST(req: Request) {
  const body = await req.json();
  return NextResponse.json({ ok: true, body });
}\n`,
  },
];

/**
 * Tracked files restored, and the one file a mutation ADDS gone.
 *
 * `-uno` on purpose: this run writes its own evidence into the tree, and an
 * untracked log is not an unreverted mutation. What must be true is that every
 * tracked file matches HEAD and `app/api/_mutation_probe` no longer exists.
 */
function clean() {
  return (
    execFileSync("git", ["status", "--porcelain", "-uno"], { encoding: "utf8" }).trim() === "" &&
    !existsSync(PROBE_ROUTE)
  );
}

function revert(m) {
  if (m.create) {
    rmSync(m.file, { force: true });
    try {
      rmSync(m.file.replace(/\/route\.ts$/, ""), { recursive: true, force: true });
    } catch {
      // The directory may hold something else; the file is what matters.
    }
    return;
  }
  execFileSync("git", ["checkout", "--", m.file]);
}

function apply(m) {
  if (m.create) {
    execFileSync("mkdir", ["-p", m.file.replace(/\/route\.ts$/, "")]);
    writeFileSync(m.file, m.create);
    return true;
  }
  const src = readFileSync(m.file, "utf8");
  const hits = src.split(m.find).length - 1;
  if (hits !== 1) return false;
  writeFileSync(m.file, src.replace(m.find, m.replace));
  return true;
}

const only = arg("only", "");
const rows = [];

if (!clean()) {
  console.error("the working tree is dirty; §8 needs a clean tree to revert into");
  process.exit(2);
}

for (const m of MUTATIONS) {
  if (only && m.id !== only) continue;
  let red = false;
  let detail;
  try {
    const applied = apply(m);
    if (!applied) {
      detail = `anchor not found exactly once in ${m.file} — the mutation did not apply`;
    } else if (m.create && existsSync(m.file) === false) {
      detail = "the file was not written";
    } else {
      const run = spawnSync("npx", ["vitest", "run", m.gate], { encoding: "utf8" });
      const out = `${run.stdout}${run.stderr}`;
      const failed = (out.match(/Tests\s+(\d+) failed/) ?? [])[1] ?? "0";
      const names = [...out.matchAll(/^\s*[×✗]\s+(.+?)(?:\s+\d+ms)?$/gm)]
        .map((x) => x[1].trim())
        .slice(0, 3);
      red = run.status !== 0 && Number(failed) > 0;
      detail =
        `${m.gate} exit ${run.status}, ${failed} test(s) failed` +
        (names.length ? ` — ${names.join(" | ")}` : "");
    }
  } finally {
    revert(m);
  }
  const reverted = clean();
  const pass = red && reverted;
  rows.push({ id: m.id, property: m.property, file: m.file, gate: m.gate, red, reverted, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${m.id} ${m.property}`);
  console.log(`      ${detail}`);
  console.log(`      reverted: ${reverted}`);
}

const bad = rows.filter((r) => !(r.red && r.reverted));
console.log(`\n${rows.length - bad.length}/${rows.length} mutations were caught` +
  (bad.length ? `  NOT CAUGHT: ${bad.map((r) => r.id).join(", ")}` : ""));
const out = arg("json", "");
if (out) {
  writeFileSync(out, JSON.stringify({ rows }, null, 2));
  console.log(`json → ${out}`);
}
process.exit(bad.length ? 1 : 0);
