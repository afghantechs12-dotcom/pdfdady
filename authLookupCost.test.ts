import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { AuthService } from "@/src/application/services/AuthService";
import { LocalSessionProvider } from "@/src/infrastructure/auth/LocalSessionProvider";
import { LocalUserProvider } from "@/src/infrastructure/auth/LocalUserProvider";

/**
 * R12-R13 — what the upload gate's stage 4 actually costs.
 *
 * `workspaceUploadGate` authenticates BEFORE it rate limits, so an unauthenticated
 * flood reaches the session lookup at full request rate: the limiter cannot refuse a
 * caller it has not yet identified, and the 429-before-401 order is deliberate (see the
 * file header of `lib/server/workspaceUploadGate.ts`). That makes the cost of one
 * unauthenticated lookup the price of the whole design, and the brief's instruction is
 * explicit: measure it, do not reason about it.
 *
 * Measured here against real SQLite through the real providers — `AuthService.getMe` is
 * exactly what stage 4 calls — with query COUNTS and the SQLite query PLAN as the
 * assertions, and wall-clock reported alongside. Counts and plans are deterministic;
 * a timing threshold on a shared CI box is a coin flip, so timing is evidence, not a
 * gate. The plan is what proves the lookup is indexed, which is the property that keeps
 * the cost flat as the table grows.
 */

const root = process.cwd();
const prismaExecutable = path.join(root, "node_modules", "prisma", "build", "index.js");
const tempRoot = mkdtempSync(path.join(tmpdir(), "pdfdadi-auth-cost-"));
const databasePath = path.join(tempRoot, "auth-cost.db").replaceAll("\\", "/");
const databaseUrl = `file:${databasePath}`;

/** Sessions seeded besides the one valid row, so an unindexed lookup would show. */
const DECOY_SESSIONS = 5_000;
const VALID_TOKEN = "v".repeat(64);
const EXPIRED_TOKEN = "e".repeat(64);
const UNKNOWN_TOKEN = "u".repeat(64);
/** Not a token this app could ever have issued: wrong charset, wrong length. */
const MALFORMED_TOKEN = "not-a-token; drop table sessions --";

let prisma: PrismaClient & { $on: (e: "query", cb: (q: { query: string }) => void) => void };
let auth: AuthService;
let queries: string[] = [];

beforeAll(async () => {
  if (!existsSync(prismaExecutable)) throw new Error(`Prisma executable is missing at ${prismaExecutable}`);
  execFileSync(
    process.execPath,
    [prismaExecutable, "migrate", "deploy", "--schema", path.join(root, "prisma", "schema.prisma")],
    { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe" },
  );
  prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: [{ emit: "event", level: "query" }],
  }) as typeof prisma;
  prisma.$on("query", (event) => queries.push(event.query));

  await prisma.user.create({ data: { id: "u-live", email: "live@example.test" } });
  const hour = 60 * 60 * 1000;
  await prisma.session.create({
    data: { userId: "u-live", token: VALID_TOKEN, expiresAt: new Date(Date.now() + hour) },
  });
  await prisma.session.create({
    data: { userId: "u-live", token: EXPIRED_TOKEN, expiresAt: new Date(Date.now() - hour) },
  });
  await prisma.session.createMany({
    data: Array.from({ length: DECOY_SESSIONS }, (_, i) => ({
      userId: "u-live",
      // Padded on the NUMBER, not the string: `d1`.padEnd(64,"0") and `d10`.padEnd(64,"0")
      // are the same 64 characters, and `token` is unique.
      token: `d${String(i).padStart(63, "0")}`,
      expiresAt: new Date(Date.now() + hour),
    })),
  });

  auth = new AuthService(new LocalUserProvider(prisma), new LocalSessionProvider(prisma), prisma);
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  rmSync(tempRoot, { recursive: true, force: true });
});

/** Prisma quotes identifiers, so the SQL reads FROM backtick-main-backtick-dot-... */
const FROM_SESSIONS = /FROM `main`\.`sessions`/;
const USERS_TABLE = /`main`\.`users`/;

/** One `getMe`, with the queries it issued. `null` cookie is the absent-cookie case. */
async function measure(token: string | null) {
  queries = [];
  const startedAt = performance.now();
  // The absent-cookie branch lives in `getSessionUser`, which returns before it resolves
  // AuthService at all — reproduced here rather than imported, because importing it drags
  // in `next/headers` and the DI container for a branch that is one falsy check.
  const user = token ? await auth.getMe(token) : null;
  return { user, ms: performance.now() - startedAt, queries: [...queries] };
}

describe("R12 — the query cost of one authentication attempt, per cookie state", () => {
  it("no cookie costs nothing: the 401 is returned before any provider is resolved", async () => {
    const absent = await measure(null);
    expect(absent.queries).toEqual([]);
    // The branch itself, in the code stage 4 actually runs.
    const src = readFileSync("src/application/services/workspaceHttp.ts", "utf8");
    expect(src).toMatch(/if \(!token\) return \{ response: workspaceError\([\s\S]{0,80}401\)/);
  });

  it("a cookie that cannot be a session still costs one lookup — the state to know about", async () => {
    for (const token of [MALFORMED_TOKEN, UNKNOWN_TOKEN]) {
      const r = await measure(token);
      expect(r.user).toBeNull();
      // ONE indexed SELECT, and no user lookup: a wrong token never reaches `users`.
      expect(r.queries.filter((q) => /^SELECT/i.test(q))).toHaveLength(1);
      expect(r.queries.join(" ")).toMatch(FROM_SESSIONS);
      expect(r.queries.join(" ")).not.toMatch(USERS_TABLE);
    }
    // Which is the measured answer to the question §6 asks: an unauthenticated flood
    // costs one indexed SQLite SELECT per request before the limiter can refuse it.
    // Not free, and not a scan. No format pre-check is worth adding: it would only move
    // the same cost behind a regex that a real-looking token walks straight through.
  });

  it("an expired session costs the same one lookup and no user read", async () => {
    const r = await measure(EXPIRED_TOKEN);
    expect(r.user).toBeNull();
    // Expiry is compared in JS after the row loads, so this is one query, not two —
    // and the row is discarded rather than returned, which is the property that matters.
    expect(r.queries.filter((q) => /^SELECT/i.test(q))).toHaveLength(1);
    expect(r.queries.join(" ")).not.toMatch(USERS_TABLE);
  });

  it("a valid session costs two: the session, then the user, both by unique key", async () => {
    const r = await measure(VALID_TOKEN);
    expect(r.user?.id).toBe("u-live");
    const selects = r.queries.filter((q) => /^SELECT/i.test(q));
    expect(selects).toHaveLength(2);
    expect(selects[0]).toMatch(FROM_SESSIONS);
    expect(selects[1]).toMatch(USERS_TABLE);
  });
});

describe("R13 — the lookup is indexed, so the cost does not grow with the table", () => {
  it("SQLite searches the unique token index and never scans sessions", async () => {
    const [plan] = await prisma.$queryRawUnsafe<{ detail: string }[]>(
      `EXPLAIN QUERY PLAN SELECT id FROM sessions WHERE token = ?`,
      UNKNOWN_TOKEN,
    );
    // The whole basis of "one cheap lookup". A SCAN here would make the same code a
    // linear read of every session on every unauthenticated request.
    expect(plan.detail).toMatch(/SEARCH/);
    expect(plan.detail).toMatch(/USING (COVERING )?INDEX/);
    expect(plan.detail).not.toMatch(/SCAN/);
    // And the index is a schema fact, not an accident of this database file.
    expect(readFileSync("prisma/schema.prisma", "utf8")).toMatch(
      /token\s+String\s+@unique/,
    );
  });

  it("reports the measured cost of each cookie state", async () => {
    const rows: { state: string; ms: number; queries: number }[] = [];
    for (const [state, token] of [
      ["absent", null],
      ["malformed", MALFORMED_TOKEN],
      ["unknown", UNKNOWN_TOKEN],
      ["expired", EXPIRED_TOKEN],
      ["valid", VALID_TOKEN],
    ] as const) {
      // Warm, then take the median of 21 — a first call pays connection setup and would
      // report the pool, not the lookup.
      await measure(token);
      const samples: number[] = [];
      for (let i = 0; i < 21; i += 1) samples.push((await measure(token)).ms);
      samples.sort((a, b) => a - b);
      rows.push({ state, ms: Number(samples[10].toFixed(3)), queries: (await measure(token)).queries.length });
    }
    // Evidence, printed: the numbers belong in the report, and a threshold on them
    // would be a flake on a loaded machine.
    console.info(
      `R13 authentication lookup cost (${DECOY_SESSIONS + 2} sessions, median of 21):\n` +
        rows.map((r) => `  ${r.state.padEnd(10)} ${String(r.ms).padStart(7)}ms  ${r.queries} query(ies)`).join("\n"),
    );
    expect(rows.find((r) => r.state === "absent")!.queries).toBe(0);
    expect(rows.find((r) => r.state === "valid")!.queries).toBeGreaterThan(0);
  });
});
