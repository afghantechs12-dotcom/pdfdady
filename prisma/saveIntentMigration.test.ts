/**
 * D20 — the save-intent migration applied to a COPY of a populated database.
 *
 * The two claims that need evidence are not about the new table. They are:
 *
 *  1. nothing already stored is lost or altered — including the rows most likely
 *     to be forgotten, an ARCHIVED document and a TRASHED one, and the versions
 *     that point at them; and
 *  2. the constraint that is dropped really is dropped, so a Workspace can hold
 *     two ingestions of identical bytes — the defect this phase exists to fix.
 *
 * How the "before" state is built. `prisma migrate deploy` only ever brings a
 * database to HEAD, so the pre-migration schema is produced by running every
 * migration BEFORE the one under test through the real Prisma CLI, then seeding it.
 * The migration under test is named, not taken as "the last one": the first
 * migration added after this phase (the instance lease) made "last" a different
 * file, and this test then built its own control with the save-intent table already
 * in it and failed on a claim it was not making. The
 * final migration is then applied — by the same CLI, from the same file the
 * deployment will use — to a byte copy, leaving the seeded original in place as the
 * control. A test that migrated the original could not tell "preserved" from
 * "never existed".
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaDocumentRecordRepository } from "@/src/infrastructure/persistence/PrismaDocumentRecordRepository";
import { PrismaDocumentIngestionRepository } from "@/src/infrastructure/persistence/PrismaDocumentIngestionRepository";
import { PrismaStoredFileRepository } from "@/src/infrastructure/persistence/PrismaStoredFileRepository";

const root = process.cwd();
const prismaExecutable = path.join(root, "node_modules", "prisma", "build", "index.js");
const migrationsDirectory = path.join(root, "prisma", "migrations");
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "pdfdadi-save-intent-migration-"));
const legacyPath = path.join(temporaryDirectory, "legacy.db");
const migratedPath = path.join(temporaryDirectory, "migrated.db");
const url = (file: string) => `file:${file.replaceAll("\\", "/")}`;

/** Chronological, because Prisma names migrations with a sortable timestamp. */
const migrations = readdirSync(migrationsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
/** The migration this test is about, by name. See the note above on why not `at(-1)`. */
const finalMigration = "20260902100000_add_workspace_save_intents";
const beforeFinal = migrations.slice(0, migrations.indexOf(finalMigration));

function runSql(file: string, database: string) {
  execFileSync(
    process.execPath,
    [prismaExecutable, "db", "execute", "--file", file, "--url", url(database)],
    { cwd: root, stdio: "pipe" },
  );
}

let legacy: PrismaClient;
let migrated: PrismaClient;

/** What was in the database before the migration, by id, to compare against. */
let seeded: {
  organizationId: string;
  userId: string;
  workspaceId: string;
  documents: Array<{ id: string; name: string; lifecycleState: string }>;
  ingestions: Array<{ id: string; checksum: string; documentId: string }>;
  versions: Array<{ id: string; versionNumber: number }>;
  files: Array<{ id: string; key: string }>;
};

async function seed(client: PrismaClient) {
  const organization = await client.organization.create({
    data: { name: "Legacy", slug: `legacy-${Date.now()}`, plan: "free" },
  });
  const user = await client.user.create({
    data: { email: `legacy-${Date.now()}@example.test`, provider: "local", passwordHash: "s:h" },
  });
  await client.organizationMembership.create({
    data: { organizationId: organization.id, userId: user.id, role: "owner" },
  });
  const workspace = await client.workspace.create({
    data: {
      organizationId: organization.id,
      name: "Home",
      normalizedName: "home",
      slug: "home",
      normalizedSlug: "home",
      createdById: user.id,
    },
  });

  const documents = [];
  const ingestions = [];
  const files = [];
  const versions = [];
  // One of each lifecycle state, because a migration that quietly dropped the
  // archived or trashed rows would still look correct from the file list.
  for (const [index, lifecycleState] of ["active", "archived", "trashed"].entries()) {
    const checksum = `${index}`.repeat(64).slice(0, 64);
    const file = await client.storedFile.create({
      data: {
        ownerType: "org",
        ownerId: organization.id,
        key: `ca/${checksum.slice(0, 2)}/${checksum.slice(2, 4)}/${checksum}`,
        sha256: checksum,
        size: 128 + index,
        mimeType: "application/pdf",
        originalName: `legacy-${index}.pdf`,
      },
    });
    const document = await client.documentRecord.create({
      data: {
        workspaceId: workspace.id,
        organizationId: organization.id,
        name: `legacy-${index}.pdf`,
        normalizedName: `legacy-${index}.pdf`,
        lifecycleState,
        createdById: user.id,
        archivedAt: lifecycleState === "archived" ? new Date() : null,
        trashedAt: lifecycleState === "trashed" ? new Date() : null,
      },
    });
    const ingestion = await client.documentIngestion.create({
      data: {
        workspaceId: workspace.id,
        organizationId: organization.id,
        documentId: document.id,
        storedFileId: file.id,
        status: "complete",
        checksum,
        byteSize: 128 + index,
        mimeType: "application/pdf",
        originalName: `legacy-${index}.pdf`,
        uploadedById: user.id,
      },
    });
    const version = await client.documentVersion.create({
      data: {
        workspaceId: workspace.id,
        organizationId: organization.id,
        documentId: document.id,
        versionNumber: 1,
        revision: 1,
        origin: "import",
        manifest: JSON.stringify({ sourceKey: file.key, sourceChecksum: checksum }),
        checksum,
        createdById: user.id,
      },
    });
    files.push({ id: file.id, key: file.key });
    documents.push({ id: document.id, name: document.name, lifecycleState });
    ingestions.push({ id: ingestion.id, checksum, documentId: document.id });
    versions.push({ id: version.id, versionNumber: version.versionNumber });
  }

  return {
    organizationId: organization.id,
    userId: user.id,
    workspaceId: workspace.id,
    documents,
    ingestions,
    versions,
    files,
  };
}

beforeAll(async () => {
  if (!existsSync(prismaExecutable)) {
    throw new Error(`Prisma executable is missing at ${prismaExecutable}`);
  }
  // Every migration EXCEPT the one under test, as one script.
  const before = path.join(temporaryDirectory, "before.sql");
  writeFileSync(
    before,
    beforeFinal
      .map((name) => `${readFileSync(path.join(migrationsDirectory, name, "migration.sql"), "utf8")}\n;\n`)
      .join("\n"),
  );
  runSql(before, legacyPath);

  legacy = new PrismaClient({ datasources: { db: { url: url(legacyPath) } } });
  seeded = await seed(legacy);

  // The copy is what gets migrated. The original stays as the control.
  copyFileSync(legacyPath, migratedPath);
  runSql(path.join(migrationsDirectory, finalMigration, "migration.sql"), migratedPath);
  migrated = new PrismaClient({ datasources: { db: { url: url(migratedPath) } } });
}, 180000);

afterAll(async () => {
  await legacy?.$disconnect();
  await migrated?.$disconnect();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

const indexNames = (client: PrismaClient, table: string) =>
  client.$queryRawUnsafe<Array<{ name: string }>>(
    `select name from sqlite_master where type = 'index' and tbl_name = ?`,
    table,
  ).then((rows) => rows.map((row) => row.name));

describe("D20 — the migration preserves everything already stored", () => {
  it("started from a database that genuinely predates the migration", async () => {
    // The control: no save-intent table, and the checksum constraint still unique.
    const tables = await legacy.$queryRawUnsafe<Array<{ name: string }>>(
      `select name from sqlite_master where type = 'table' and name = 'workspace_save_intents'`,
    );
    expect(tables).toHaveLength(0);
    expect(await indexNames(legacy, "document_ingestions")).toContain(
      "document_ingestions_workspaceId_checksum_key",
    );
    expect(migrations).toContain(finalMigration);
    expect(beforeFinal.length).toBeGreaterThan(0);
  });

  it("keeps every document, including the archived and the trashed one", async () => {
    const rows = await migrated.documentRecord.findMany({ orderBy: { name: "asc" } });
    expect(rows.map((row) => [row.id, row.name, row.lifecycleState])).toEqual(
      seeded.documents.map((d) => [d.id, d.name, d.lifecycleState]),
    );
    // Lifecycle timestamps are part of the trash policy, so they must survive too.
    const trashed = rows.find((row) => row.lifecycleState === "trashed");
    expect(trashed?.trashedAt).not.toBeNull();
    expect(rows.find((row) => row.lifecycleState === "archived")?.archivedAt).not.toBeNull();
  });

  it("keeps every ingestion, version and stored file, unchanged", async () => {
    const ingestions = await migrated.documentIngestion.findMany({ orderBy: { checksum: "asc" } });
    expect(ingestions.map((row) => [row.id, row.checksum, row.documentId])).toEqual(
      seeded.ingestions.map((i) => [i.id, i.checksum, i.documentId]),
    );
    const versions = await migrated.documentVersion.findMany({ orderBy: { checksum: "asc" } });
    expect(versions.map((row) => row.id)).toEqual(seeded.versions.map((v) => v.id));
    expect(versions.every((row) => row.manifest.includes("sourceKey"))).toBe(true);
    const files = await migrated.storedFile.findMany({ orderBy: { key: "asc" } });
    expect(files.map((row) => [row.id, row.key])).toEqual(seeded.files.map((f) => [f.id, f.key]));
  });

  it("adds the operation table empty — no history is invented for it", async () => {
    // Old saves had no recorded intention and cannot be given a truthful one. An
    // empty table means "unknown", which is correct; a fabricated row would claim
    // a retry of an ancient save is already satisfied.
    expect(await migrated.workspaceSaveIntent.count()).toBe(0);
    const created = await migrated.workspaceSaveIntent.create({
      data: {
        key: "si-post-migration-smoke-000",
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        workspaceId: seeded.workspaceId,
        sourceKind: "local-result",
        sourceIdentity: "merge-result",
        payloadChecksum: "f".repeat(64),
        status: "pending",
      },
    });
    // The uniqueness that makes it an identity is live on the migrated database.
    await expect(
      migrated.workspaceSaveIntent.create({ data: { ...created, id: undefined } }),
    ).rejects.toThrow(/[Uu]nique constraint/);
    await migrated.workspaceSaveIntent.delete({ where: { id: created.id } });
  });

  it("drops the checksum constraint and keeps the checksum index", async () => {
    const names = await indexNames(migrated, "document_ingestions");
    expect(names).not.toContain("document_ingestions_workspaceId_checksum_key");
    expect(names).toContain("document_ingestions_workspaceId_checksum_idx");

    // The behavioural half: the same bytes in one Workspace, twice. This is the
    // insert that used to fail and return a server error after a trash-and-resave.
    const original = seeded.ingestions[0]!;
    const second = await migrated.documentRecord.create({
      data: {
        workspaceId: seeded.workspaceId,
        organizationId: seeded.organizationId,
        name: "legacy-0-copy.pdf",
        normalizedName: "legacy-0-copy.pdf",
        createdById: seeded.userId,
      },
    });
    await expect(
      migrated.documentIngestion.create({
        data: {
          workspaceId: seeded.workspaceId,
          organizationId: seeded.organizationId,
          documentId: second.id,
          storedFileId: seeded.files[0]!.id,
          status: "complete",
          checksum: original.checksum,
          byteSize: 128,
          mimeType: "application/pdf",
          originalName: "legacy-0-copy.pdf",
          uploadedById: seeded.userId,
        },
      }),
    ).resolves.toMatchObject({ checksum: original.checksum });
    // And the same pair still cannot be ingested twice for ONE document.
    await migrated.documentIngestion.deleteMany({ where: { documentId: second.id } });
    await migrated.documentRecord.delete({ where: { id: second.id } });
  });

  it("still reads a legacy document back through the repositories downloads use", async () => {
    // "Old documents keep opening and downloading" is a read path, so it is
    // asserted through the real adapters rather than raw SQL.
    const documents = new PrismaDocumentRecordRepository(migrated);
    const ingestions = new PrismaDocumentIngestionRepository(migrated);
    const filesRepository = new PrismaStoredFileRepository(migrated);

    const expected = seeded.documents[0]!;
    const document = await documents.getById(seeded.workspaceId, expected.id);
    expect(document?.name).toBe(expected.name);
    const ingestion = await ingestions.findByChecksum(
      seeded.workspaceId,
      seeded.ingestions[0]!.checksum,
    );
    expect(ingestion?.documentId).toBe(expected.id);
    const file = await filesRepository.get(ingestion!.storedFileId);
    expect(file?.key).toBe(seeded.files[0]!.key);
  });
});
