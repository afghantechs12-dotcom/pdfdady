import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { InMemoryUsageRepository } from "@/src/infrastructure/persistence/InMemoryUsageRepository";
import {
  ReadOnlyViolation,
  WRITE_METHODS,
  databaseUrl,
  readOnly,
  sqliteFileFor,
} from "@/scripts/usage-readiness";

/**
 * The readiness command: where it looks, and that looking is all it does.
 *
 * Two failures are worth a test here, and neither is caught by running the script
 * and reading the output:
 *
 *  - It reports on the WRONG database. `file:./prisma/dev.db` does not mean
 *    `prisma/dev.db`; Prisma resolves it against the schema's directory, so it
 *    means `prisma/prisma/dev.db`. Both files exist in this repo and the shallow
 *    one is empty, so the failure mode is a confident "no traffic observed" — an
 *    operator would read that as a dead product, not as a broken tool.
 *
 *  - It MUTATES what it reports on. A readiness command that moved a counter would
 *    corrupt the observation window it exists to measure, in a developer's own
 *    database, with no error to notice. Proved twice below: the guard rejects a
 *    write, and a real subprocess run leaves the file's bytes identical.
 */

const ROOT = process.cwd();
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

describe("which database it reads", () => {
  it("resolves a relative SQLite URL against the prisma directory, as Prisma does", () => {
    expect(sqliteFileFor("file:./prisma/dev.db", "/srv/app")).toBe(
      "/srv/app/prisma/prisma/dev.db",
    );
    expect(sqliteFileFor("file:dev.db", "/srv/app")).toBe("/srv/app/prisma/dev.db");
    expect(sqliteFileFor("file:../shared/usage.db", "/srv/app")).toBe(
      "/srv/app/shared/usage.db",
    );
  });

  it("leaves an absolute path and any non-SQLite provider alone", () => {
    expect(sqliteFileFor("file:/var/data/usage.db", "/srv/app")).toBe("/var/data/usage.db");
    expect(sqliteFileFor("postgresql://u@h/db", "/srv/app")).toBeNull();
    expect(sqliteFileFor("file::memory:", "/srv/app")).toBeNull();
  });

  it("points at the developer database that actually holds the ledger", () => {
    // The anti-vacuity half of the rule above: it is not enough for the resolver to
    // be self-consistent, the file it names has to be the real one. `prisma/dev.db`
    // exists here and is empty — if a change ever made the resolver prefer it, this
    // fails with the two sizes side by side instead of with a silent zero.
    const url = databaseUrl(ROOT, {}).url;
    const resolved = sqliteFileFor(url, ROOT);
    expect(resolved).toBe(path.join(ROOT, "prisma/prisma/dev.db"));
    const decoy = path.join(ROOT, "prisma/dev.db");
    if (statSync(decoy, { throwIfNoEntry: false })) {
      expect(statSync(resolved!).size).toBeGreaterThan(statSync(decoy).size);
    }
  });

  it("prefers the environment, then .env, then the dev fallback", () => {
    // A plain node process does not read `.env`; Next.js does. Reporting on the
    // fallback while the app serves from `.env` is the same wrong-database bug in a
    // different disguise.
    expect(databaseUrl(ROOT, { DATABASE_URL: "postgresql://a@b/c" })).toEqual({
      url: "postgresql://a@b/c",
      source: "DATABASE_URL",
    });
    expect(databaseUrl(ROOT, {})).toMatchObject({ source: ".env" });
    expect(databaseUrl(mkdtempSync(path.join(tmpdir(), "no-env-")), {})).toEqual({
      url: "file:./prisma/dev.db",
      source: "dev default",
    });
  });
});

describe("the read-only guard", () => {
  it("refuses every mutating call and lets reads through", async () => {
    const guarded = readOnly(new InMemoryUsageRepository());
    for (const method of WRITE_METHODS) {
      expect(
        () => (guarded as unknown as Record<string, () => unknown>)[method]!(),
        `${method} must be refused`,
      ).toThrow(ReadOnlyViolation);
    }
    await expect(
      guarded.toolUsageSummary({ from: new Date(0), to: new Date() }),
    ).resolves.toEqual([]);
    await expect(guarded.readCounters([])).resolves.toEqual([]);
  });

  it("names every write on the port, so a new one cannot slip past unguarded", () => {
    // Without this the guard silently narrows the day someone adds a write method:
    // `WRITE_METHODS` would still pass its own test while no longer covering the
    // port. Reads are listed explicitly so a NEW method belongs to neither list and
    // this fails until somebody classifies it.
    const port = readFileSync(
      path.join(ROOT, "src/application/ports/metering/UsageRepository.ts"),
      "utf8",
    );
    const body = port.slice(port.indexOf("export interface IUsageRepository {"));
    const declared = new Set([...body.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]!));
    expect(declared.size).toBeGreaterThan(5);
    const reads = [
      "readCounters",
      "countActiveOperations",
      "toolUsageSummary",
      "observedOperationDays",
      "eventCounts",
      "eventCountsByTool",
      "dimensionCounts",
    ];
    expect([...declared].sort()).toEqual([...WRITE_METHODS, ...reads].sort());
  });
});

describe("running it", () => {
  it("reports the real verdict and leaves the database byte-identical", () => {
    // The end-to-end proof. The guard above covers a write through the repository;
    // this covers one issued any other way — a stray `prisma.$executeRaw`, a
    // migration, a Prisma client that upserts on connect — because it compares the
    // bytes rather than the call.
    const dir = mkdtempSync(path.join(tmpdir(), "usage-readiness-"));
    const db = path.join(dir, "copy.db");
    const real = path.join(ROOT, "prisma/prisma/dev.db");
    if (statSync(real, { throwIfNoEntry: false })) copyFileSync(real, db);
    else writeFileSync(db, "");
    const before = sha256(db);

    const out = execFileSync(
      "npx",
      ["tsx", "scripts/usage-readiness.ts", "--json", "--days", "30"],
      { cwd: ROOT, env: { ...process.env, DATABASE_URL: `file:${db}` }, encoding: "utf8" },
    );

    expect(sha256(db), "the readiness command must not write").toBe(before);
    const report = JSON.parse(out);
    expect(report.database.file).toBe(db);
    expect(report.readiness.thresholds.minObservationDays).toBeGreaterThan(0);
    expect(typeof report.readiness.ready_for_enforcement).toBe("boolean");
    // Aggregates only. The payload is the service's, so this is the same guarantee
    // the admin route has — asserted again here because this one prints to a shell
    // and gets pasted into tickets.
    for (const forbidden of ["subjectHash", "ownerId", "properties", "SECRET"]) {
      expect(out).not.toContain(forbidden);
    }
  }, 60_000);
});
