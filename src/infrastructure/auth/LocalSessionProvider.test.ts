import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { LocalSessionProvider } from "./LocalSessionProvider";

/**
 * `sessions` retention, against a real (temporary) SQLite database.
 *
 * Why not a fake Prisma: the whole risk in `pruneExpired` is one comparison
 * crossing the ORM boundary. Prisma stores `DateTime` on SQLite as an INTEGER
 * of milliseconds, and a value that lands in that column as TEXT sorts after
 * every integer — so `{ expiresAt: { lt: now } }` against the wrong storage
 * type either deletes nothing or deletes everything, and a hand-written fake
 * that compares two JS Dates would call both of those green. The type
 * assertion below is therefore part of the test, not trivia.
 *
 * The behaviour under test: a row is written on every login and removed only by
 * an explicit logout, so before this method existed an abandoned tab left a row
 * in an authentication table forever. `get` already refuses an expired token,
 * so this is unbounded growth rather than an access risk — which is exactly why
 * it went unnoticed.
 */

const root = process.cwd();
const prismaExecutable = path.join(root, "node_modules", "prisma", "build", "index.js");
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "pdfdadi-session-retention-"));
const databasePath = path.join(temporaryDirectory, "sessions.db").replaceAll("\\", "/");
const databaseUrl = `file:${databasePath}`;
let prisma: PrismaClient;
let provider: LocalSessionProvider;

beforeAll(() => {
  if (!existsSync(prismaExecutable)) throw new Error(`Prisma executable is missing at ${prismaExecutable}`);
  execFileSync(
    process.execPath,
    [prismaExecutable, "migrate", "deploy", "--schema", path.join(root, "prisma", "schema.prisma")],
    { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe" },
  );
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  provider = new LocalSessionProvider(prisma);
}, 60000);

afterAll(async () => {
  await prisma?.$disconnect();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
  await prisma.user.create({
    data: { id: "u1", email: "u1@example.com", provider: "local", passwordHash: "salt:hash" },
  });
});

/** A row with an arbitrary expiry — `create()` cannot produce a past one. */
async function session(token: string, expiresAt: Date) {
  await prisma.session.create({ data: { userId: "u1", token, expiresAt } });
}

describe("LocalSessionProvider.pruneExpired", () => {
  it("deletes expired rows, keeps live ones, and returns the count", async () => {
    const now = new Date();
    await session("expired-a", new Date(now.getTime() - 60_000));
    await session("expired-b", new Date(now.getTime() - 1));
    await session("live", new Date(now.getTime() + 60_000));

    expect(await provider.pruneExpired(now)).toBe(2);

    // Anti-vacuity: a `deleteMany({})` with no predicate passes every line that
    // only checks the expired rows are gone.
    expect(await prisma.session.findMany({ select: { token: true } })).toEqual([{ token: "live" }]);
    expect(await provider.get("live")).not.toBeNull();
  });

  it("is a no-op when nothing has expired", async () => {
    await session("live", new Date(Date.now() + 60_000));
    expect(await provider.pruneExpired(new Date())).toBe(0);
    expect(await prisma.session.count()).toBe(1);
  });

  it("compares against the same storage type Prisma writes", async () => {
    await session("live", new Date(Date.now() + 60_000));
    const [row] = await prisma.$queryRawUnsafe<Array<{ t: string }>>(
      "select typeof(expiresAt) as t from sessions",
    );
    // If this ever reads "text", the `lt` above stops meaning what it says.
    expect(row!.t).toBe("integer");
  });

  it("cleans up after a session the provider itself created and let lapse", async () => {
    // The real lifecycle, not a hand-built row: create() then a clock that moved.
    const created = await provider.create("u1", 1);
    expect(await provider.get(created.token)).not.toBeNull();

    // Nothing in the login/logout lifecycle removes it, so it is still there a
    // moment after its own TTL: that is the leak, not an access risk.
    const afterTtl = new Date(created.expiresAt.getTime() + 1);
    expect(await prisma.session.count()).toBe(1);

    expect(await provider.pruneExpired(afterTtl)).toBe(1);
    expect(await prisma.session.count()).toBe(0);
  });
});
