#!/usr/bin/env node
/* global process, console */
/**
 * The upgrade rehearsal: a POPULATED pre-Phase-5 database is migrated to head,
 * then backed up, destroyed and restored — and every claim is checked against the
 * bytes rather than against the absence of an error message.
 *
 * WHY A POPULATED DATABASE. `prisma migrate deploy` on an empty file proves the SQL
 * parses. It does not prove the migration is safe for a database that already holds
 * documents, which is the only kind a launch has. So this drill starts at the
 * schema the last release shipped, fills it with the rows a real Workspace has
 * (organization, membership, Workspace, document, version, ingestion), migrates,
 * and then compares a checksum taken over every populated table BEFORE and AFTER.
 * A migration that silently rewrote or dropped a row fails here even though Prisma
 * would have reported success.
 *
 * WHY `resolve --applied` AND NOT A HAND-WRITTEN LEDGER. The pre-Phase-5 state is
 * reached by applying the first N-1 migration files directly, which leaves Prisma
 * with no record of them. Prisma's own baselining command writes that record — with
 * its own table shape and its own checksums — so the `migrate deploy` under test
 * runs against bookkeeping this script did not invent.
 *
 * WHY THE BACKUP IS NOT `cp`. Copying a live SQLite file can capture a torn page.
 * `node:sqlite`'s `backup()` is the online backup API, which is what an operator
 * should actually run, so that is what is rehearsed.
 *
 * Never points at the live database: every path below is inside a fresh
 * `mkdtemp` directory that is removed on the way out.
 */
import { DatabaseSync, backup } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MIGRATIONS = "prisma/migrations";
const rows = [];
const record = (title, ok, detail) => {
  rows.push({ title, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${title}${detail ? `  — ${detail}` : ""}`);
};

/** Prisma CLI, with the drill's own DATABASE_URL and nothing from the shell's. */
const prisma = (args, url) => {
  const r = spawnSync("npx", ["prisma", ...args], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: url },
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

/**
 * A checksum over the CONTENT of every populated table.
 *
 * Ordered by primary key and read column-by-column, so it is stable across a
 * migration that adds a table or an index but changes with any edit to a value —
 * which is precisely the difference the drill needs to see.
 */
const contentHash = (file, tables) => {
  const db = new DatabaseSync(file, { readOnly: true });
  const h = createHash("sha256");
  for (const t of tables) {
    const cols = db
      .prepare(`PRAGMA table_info("${t}")`)
      .all()
      .map((c) => c.name)
      .sort();
    h.update(`\n#${t}(${cols.join(",")})`);
    for (const row of db.prepare(`SELECT * FROM "${t}" ORDER BY id`).all()) {
      h.update(`\n${cols.map((c) => `${c}=${String(row[c])}`).join("|")}`);
    }
  }
  db.close();
  return h.digest("hex");
};

const TABLES = [
  "users",
  "organizations",
  "organization_memberships",
  "workspaces",
  "document_records",
  "document_versions",
  "document_ingestions",
];

/** The rows a real Workspace has, at the pre-Phase-5 schema. */
function populate(file) {
  const db = new DatabaseSync(file);
  const t = "2026-09-01T09:00:00.000Z";
  db.exec("PRAGMA foreign_keys=ON");
  const ins = (sql, ...v) => db.prepare(sql).run(...v);
  ins(
    `INSERT INTO users (id,email,name,provider,passwordHash,createdAt,updatedAt)
     VALUES (?,?,?,?,?,?,?)`,
    "drill-user", "owner@drill.invalid", "Drill Owner", "local", "not-a-real-hash", t, t,
  );
  ins(
    `INSERT INTO organizations (id,name,slug,plan,defaultWorkspaceId,createdAt)
     VALUES (?,?,?,?,?,?)`,
    "drill-org", "Drill Org", "drill-org", "free", "drill-ws", t,
  );
  const memberCols = db.prepare(`PRAGMA table_info("organization_memberships")`).all().map((c) => c.name);
  ins(
    `INSERT INTO organization_memberships (id,organizationId,userId,role${memberCols.includes("createdAt") ? ",createdAt" : ""})
     VALUES (?,?,?,?${memberCols.includes("createdAt") ? ",?" : ""})`,
    ...["drill-mem", "drill-org", "drill-user", "owner", ...(memberCols.includes("createdAt") ? [t] : [])],
  );
  ins(
    `INSERT INTO workspaces (id,organizationId,name,normalizedName,slug,normalizedSlug,lifecycleState,createdById,revision,createdAt,updatedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    "drill-ws", "drill-org", "Drill Workspace", "drill workspace", "drill-workspace", "drill-workspace",
    "active", "drill-user", 3, t, t,
  );
  ins(
    `INSERT INTO document_records (id,workspaceId,organizationId,name,normalizedName,lifecycleState,orderKey,currentVersionId,favorite,createdById,revision,createdAt,updatedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    "drill-doc", "drill-ws", "drill-org", "Quarterly report.pdf", "quarterly report.pdf",
    "active", "a0", "drill-ver-2", 1, "drill-user", 5, t, t,
  );
  for (const n of [1, 2]) {
    ins(
      `INSERT INTO document_versions (id,workspaceId,organizationId,documentId,versionNumber,revision,origin,manifest,checksum,createdById,createdAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      `drill-ver-${n}`, "drill-ws", "drill-org", "drill-doc", n, n + 2, "save",
      JSON.stringify({ pages: n + 1, objects: [] }),
      createHash("sha256").update(`drill-version-${n}`).digest("hex"),
      "drill-user", t,
    );
  }
  ins(
    `INSERT INTO document_ingestions (id,workspaceId,organizationId,documentId,storedFileId,checksum,byteSize,mimeType,originalName,status,uploadedById,createdAt,updatedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    "drill-ing", "drill-ws", "drill-org", "drill-doc", "stored-drill-1",
    createHash("sha256").update("drill-bytes").digest("hex"), 182_144, "application/pdf",
    "Quarterly report.pdf", "ready", "drill-user", t, t,
  );
  const counts = Object.fromEntries(
    TABLES.map((x) => [x, db.prepare(`SELECT count(*) n FROM "${x}"`).get().n]),
  );
  db.close();
  return counts;
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "pdfdadi-drill-"));
  const live = join(root, "pre-phase5.db");
  const url = `file:${live}`;
  try {
    const all = readdirSync(MIGRATIONS).filter((d) => /^\d/.test(d)).sort();
    const head = all[all.length - 1];
    const earlier = all.slice(0, -1);

    /*
     * The table the HEAD migration creates, read out of its own SQL.
     *
     * This name was hardcoded as `workspace_save_intents`, which was the head when
     * the drill was written. `20260905090000_add_instance_lease` then landed and the
     * hardcode went stale in BOTH directions at once: the "does NOT yet contain the
     * migration under test" row failed, because the table it named is now created by
     * one of the earlier migrations — and the "table exists afterwards" row kept
     * passing while proving nothing, for exactly the same reason. A green row that
     * cannot fail is worse than the red one, so the name is derived and both rows
     * track whatever the head migration actually is.
     *
     * A head migration that creates no table (an added column, an index) leaves this
     * null; the presence rows then rest on the table count and on Prisma's own ledger
     * rows below, which is what already carries "the upgrade really happened".
     */
    const headSql = readFileSync(join(MIGRATIONS, head, "migration.sql"), "utf8");
    const HEAD_TABLE =
      /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`'[]?([A-Za-z_][A-Za-z0-9_]*)/i.exec(headSql)?.[1] ??
      null;
    const hasTable = (db, name) =>
      db
        .prepare(`SELECT count(*) n FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(name).n === 1;

    console.log(`MIGRATION + RESTORE DRILL in ${root}`);
    console.log(`  ${earlier.length} migration(s) to reach the schema before ${head}, then ${head}`);
    console.log(`  migration under test creates: ${HEAD_TABLE ?? "(no table)"}\n`);

    /*
     * ---- 0. the blank chain (R5) -----------------------------------------------
     *
     * The leg every project has and nobody trusts: `migrate deploy` against an
     * empty file. It proves only that the SQL parses and that the chain is
     * self-consistent from zero — which is exactly what a FIRST deployment does,
     * so it has to be recorded, and it is deliberately kept separate from the
     * populated leg below so neither can be mistaken for the other.
     */
    const blankFile = join(root, "blank.db");
    const blankUrl = `file:${blankFile}`;
    const blankDeploy = prisma(["migrate", "deploy"], blankUrl);
    record(
      `migrate deploy applies all ${all.length} migrations to an empty database`,
      blankDeploy.code === 0,
      blankDeploy.code === 0
        ? `exit 0, ${all.length} migration(s)`
        : blankDeploy.out.trim().split("\n").slice(-3).join(" ").slice(0, 220),
    );
    const blankStatus = prisma(["migrate", "status"], blankUrl);
    const blankClean =
      blankStatus.code === 0 && !/pending|drift|not yet been applied/i.test(blankStatus.out);
    record(
      "the blank database lands at migration head with nothing pending and no drift",
      blankClean,
      blankClean ? "up to date" : blankStatus.out.trim().split("\n").slice(-3).join(" ").slice(0, 220),
    );
    const blankDb = new DatabaseSync(blankFile);
    const blankTables = blankDb
      .prepare(`SELECT count(*) n FROM sqlite_master WHERE type = 'table'`)
      .get().n;
    const blankHasHead = HEAD_TABLE === null || hasTable(blankDb, HEAD_TABLE);
    blankDb.close();
    record(
      "and the schema it produced is the current one, table for table",
      blankTables > 30 && blankHasHead,
      `${blankTables} tables, ${HEAD_TABLE ?? "head table"} present=${blankHasHead}`,
    );

    // ---- 1. the database the last release shipped ------------------------------
    const db = new DatabaseSync(live);
    for (const m of earlier) db.exec(readFileSync(join(MIGRATIONS, m, "migration.sql"), "utf8"));
    const preTables = db
      .prepare(`SELECT count(*) n FROM sqlite_master WHERE type = 'table'`)
      .get().n;
    const preHasHead = HEAD_TABLE !== null && hasTable(db, HEAD_TABLE);
    db.close();
    record(
      `the schema before ${head} builds, and does NOT yet contain the migration under test`,
      preTables > 30 && !preHasHead,
      HEAD_TABLE === null
        ? `${preTables} tables, head migration creates no table — tracked by the ledger rows below`
        : `${preTables} tables, ${HEAD_TABLE} present=${preHasHead}`,
    );

    // ---- 2. Prisma's own baseline record --------------------------------------
    let baselined = 0;
    let baselineErr = "";
    for (const m of earlier) {
      const r = prisma(["migrate", "resolve", "--applied", m], url);
      if (r.code === 0) baselined += 1;
      else if (!baselineErr) baselineErr = `${m}: ${r.out.trim().split("\n").slice(-2).join(" ").slice(0, 160)}`;
    }
    record(
      "Prisma records the shipped migrations as applied, with its own table and checksums",
      baselined === earlier.length,
      baselined === earlier.length ? `${baselined} baselined` : baselineErr,
    );

    // ---- 3. real rows, then the migration -------------------------------------
    const counts = populate(live);
    const before = contentHash(live, TABLES);
    record(
      "the database holds a populated Workspace before the migration runs",
      counts.document_versions === 2 && counts.document_records === 1 && counts.workspaces === 1,
      Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" "),
    );

    const pending = prisma(["migrate", "status"], url);
    record(
      "migrate status names the pending migration rather than reporting a clean database",
      pending.out.includes(head),
      pending.out.includes(head) ? `pending: ${head}` : pending.out.trim().split("\n").slice(-2).join(" ").slice(0, 200),
    );

    const deploy = prisma(["migrate", "deploy"], url);
    record(
      `migrate deploy applies ${head} to the populated database`,
      deploy.code === 0 && deploy.out.includes(head),
      deploy.code === 0
        ? `exit 0, applied ${head}`
        : deploy.out.trim().split("\n").slice(-3).join(" ").slice(0, 240),
    );

    // ---- 4. the data survived, byte for byte ----------------------------------
    const after = contentHash(live, TABLES);
    record(
      "every populated row survived the migration unchanged",
      after === before,
      after === before ? `content sha256 ${before.slice(0, 16)}… before and after` : `${before.slice(0, 16)}… → ${after.slice(0, 16)}…`,
    );
    const post = new DatabaseSync(live, { readOnly: true });
    const postHasHead = HEAD_TABLE === null || hasTable(post, HEAD_TABLE);
    const docsStill = post.prepare(`SELECT name, revision FROM document_records`).all();
    post.close();
    record(
      "the migration's own table exists afterwards, so the upgrade really happened",
      postHasHead,
      `${HEAD_TABLE ?? "head table"} present=${postHasHead}`,
    );
    record(
      "the document still carries its name and its revision",
      docsStill.length === 1 && docsStill[0].name === "Quarterly report.pdf" && docsStill[0].revision === 5,
      JSON.stringify(docsStill),
    );
    const statusAfter = prisma(["migrate", "status"], url);
    record(
      "migrate status reports no drift and nothing pending after the upgrade",
      /up to date|No pending migrations/i.test(statusAfter.out) && !/drift|failed/i.test(statusAfter.out),
      statusAfter.out.trim().split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 160) ?? "",
    );

    // ---- 5. backup, destroy, restore -----------------------------------------
    const backupFile = join(root, "backup.db");
    const source = new DatabaseSync(live);
    let backupOk = true;
    let backupNote = "";
    try {
      /*
       * The online backup API, AWAITED. It returns a promise, and an earlier
       * revision of this drill did not await it: the backup file was still 0 bytes
       * when the size was checked, and the half-finished copy held a lock that made
       * the next read of the source fail with "database is locked". A backup step
       * that is not awaited does not rehearse a backup — it rehearses a race.
       */
      const total = await backup(source, backupFile);
      backupNote = `${total} page(s)`;
    } catch (err) {
      backupOk = false;
      backupNote = String(err?.message ?? err).slice(0, 160);
    }
    return { root, source, backupFile, backupOk, backupNote, live, url, before };
  } catch (err) {
    record("the drill ran to completion", false, String(err?.message ?? err).slice(0, 300));
    rmSync(root, { recursive: true, force: true });
    return null;
  }
}

const stage = await main();

if (stage) {
  const { root, source, backupFile, backupOk, backupNote, live, url, before } = stage;
  try {
    source.close();
    const size = existsSync(backupFile) ? statSync(backupFile).size : 0;
    record(
      "an online backup of the open database is written",
      backupOk && size > 0,
      backupOk ? `${size} bytes (${backupNote})` : backupNote,
    );

    // Destroy the way a bad afternoon does: the documents, not the file.
    const victim = new DatabaseSync(live);
    victim.exec(`DELETE FROM document_versions; DELETE FROM document_ingestions; DELETE FROM document_records;`);
    const emptied = victim.prepare(`SELECT count(*) n FROM document_records`).get().n;
    victim.close();
    record(
      "the drill really destroyed data, so the restore below has something to prove",
      emptied === 0 && contentHash(live, TABLES) !== before,
      `${emptied} document record(s) left`,
    );

    const restoredHash = contentHash(backupFile, TABLES);
    record(
      "the backup restores the destroyed Workspace exactly",
      restoredHash === before,
      restoredHash === before ? `content sha256 ${before.slice(0, 16)}… matches` : `${before.slice(0, 16)}… vs ${restoredHash.slice(0, 16)}…`,
    );
    const restoredStatus = prisma(["migrate", "status"], `file:${backupFile}`);
    record(
      "the restored database is at migration head, not at the schema it was baselined from",
      /up to date|No pending migrations/i.test(restoredStatus.out),
      // The line that answers the question, not the last line printed: prisma
      // writes "Environment variables loaded from .env" to stderr, which lands
      // after stdout in the combined buffer and made this row report it.
      (restoredStatus.out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .find((l) => /up to date|No pending migrations|pending|drift/i.test(l)) ?? "")
        .slice(0, 160),
    );
    void url;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const failed = rows.filter((r) => !r.ok);
console.log(`\n${"─".repeat(72)}`);
console.log(`MIGRATION + RESTORE DRILL — PASS ${rows.length - failed.length}/${rows.length}`);
for (const f of failed) console.log(`  FAIL ${f.title}`);
process.exit(failed.length ? 1 : 0);
