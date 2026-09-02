/**
 * C9-C13 — one logical save of one result produces one document, against a real
 * migrated database.
 *
 * WHY A REAL DATABASE. The identity that makes a save idempotent is a unique index
 * — `WorkspaceSaveIntent @@unique([organizationId, userId, key])` — and no fake in
 * this repository can fail the way production would: two concurrent saves that both
 * "insert" happily would leave the suite green while the user collected two
 * documents. The constraint, the transaction boundary and the losing request's
 * rollback are the things under test, so SQLite is real, the migrations are real,
 * and the storage is a real `LocalFileStorage`.
 *
 * WHAT PROVIDES THE IDENTITY. The save intention's own key, carried with the result
 * and re-sent by every retry of it. An earlier closeout claimed `(workspaceId,
 * sha256(result))` was enough; it is not, because it is a fact about CONTENT, not
 * about an operation — it makes two deliberate saves of one file collapse into one
 * document and makes a save after trashing collide with the trashed row. The
 * checksum keeps the job it is right for: one stored object per distinct bytes.
 * `saveIntentIdentity.test.ts` holds that separation; this file holds the race, the
 * lost response and the rollback.
 *
 * WHAT A KEYLESS SAVE STILL GETS, and does not. A request with no intention key —
 * a plain Workspace upload, or a client older than the key — keeps the original
 * content pre-check, so a sequential repeat still converges and a trashed row is
 * still skipped rather than returned. What it no longer gets is convergence under
 * genuine CONCURRENCY: that came from the checksum constraint, and nothing content-
 * shaped can replace it without becoming save identity again. Every save surface in
 * the product sends a key, which is why the tests below do.
 *
 * The banned mechanisms are all absent by construction: no process-level lock, no
 * timestamp heuristic, no filename uniqueness, no audit row consulted for identity
 * — the document id comes from the intention's row every time.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { WorkspaceAwareUploadService } from "./WorkspaceAwareUploadService";
import { WorkspaceService, type ActorContext } from "./WorkspaceService";
import { PrismaWorkspaceRepository } from "@/src/infrastructure/persistence/PrismaWorkspaceRepository";
import { PrismaWorkspaceMembershipRepository } from "@/src/infrastructure/persistence/PrismaWorkspaceMembershipRepository";
import { PrismaDocumentRecordRepository } from "@/src/infrastructure/persistence/PrismaDocumentRecordRepository";
import { PrismaDocumentIngestionRepository } from "@/src/infrastructure/persistence/PrismaDocumentIngestionRepository";
import { PrismaWorkspaceSaveIntentRepository } from "@/src/infrastructure/persistence/PrismaWorkspaceSaveIntentRepository";
import { PrismaStoredFileRepository } from "@/src/infrastructure/persistence/PrismaStoredFileRepository";
import { PrismaFolderRepository } from "@/src/infrastructure/persistence/PrismaFolderRepository";
import { PrismaProjectRepository } from "@/src/infrastructure/persistence/PrismaProjectRepository";
import { LocalFileStorage } from "@/src/infrastructure/storage/LocalFileStorage";
import type { ILogger, LogFields } from "@/src/application/ports/Logger";

const root = process.cwd();
const prismaExecutable = path.join(root, "node_modules", "prisma", "build", "index.js");
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "pdfdadi-save-idempotency-"));
const databaseUrl = `file:${path.join(temporaryDirectory, "idempotency.db").replaceAll("\\", "/")}`;

let prisma: PrismaClient;
let storage: LocalFileStorage;
let uploads: WorkspaceAwareUploadService;

class SilentLogger implements ILogger {
  readonly entries: Array<{ level: string; message: string }> = [];
  debug(m: string, _f?: LogFields) { this.entries.push({ level: "debug", message: m }); }
  info(m: string, _f?: LogFields) { this.entries.push({ level: "info", message: m }); }
  warn(m: string, _f?: LogFields) { this.entries.push({ level: "warn", message: m }); }
  error(m: string, _f?: LogFields) { this.entries.push({ level: "error", message: m }); }
  child(): ILogger { return this; }
}
let logger: SilentLogger;

/** A one-page PDF whose bytes are stable, so its checksum is the save identity. */
function resultBytes(marker: string): Buffer {
  return Buffer.from(`%PDF-1.7\n% result ${marker}\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\n%%EOF\n`);
}
const sha = (data: Buffer) => crypto.createHash("sha256").update(data).digest("hex");
const keyFor = (data: Buffer) => {
  const hash = sha(data);
  return `ca/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
};

async function reset() {
  await prisma.documentIngestion.deleteMany();
  await prisma.documentRecord.deleteMany();
  await prisma.storedFile.deleteMany();
  await prisma.workspaceMembership.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.organizationMembership.deleteMany();
  await prisma.organization.deleteMany();
  await prisma.user.deleteMany();
}

/** One organization, two members, two Workspaces both members belong to. */
async function seed() {
  const org = await prisma.organization.create({
    data: { name: "Alpha", slug: `alpha-${Date.now()}`, plan: "free" },
  });
  const users: Record<string, string> = {};
  for (const who of ["saver", "colleague", "outsider"] as const) {
    const user = await prisma.user.create({
      data: { email: `${who}-${Date.now()}@example.test`, provider: "local", passwordHash: "s:h" },
    });
    users[who] = user.id;
    if (who !== "outsider") {
      await prisma.organizationMembership.create({
        data: { organizationId: org.id, userId: user.id, role: "member" },
      });
    }
  }
  const workspaces: Record<string, string> = {};
  for (const name of ["Home", "Other"] as const) {
    const workspace = await prisma.workspace.create({
      data: {
        organizationId: org.id,
        name,
        normalizedName: name.toLowerCase(),
        slug: name.toLowerCase(),
        normalizedSlug: name.toLowerCase(),
        createdById: users.saver!,
      },
    });
    workspaces[name] = workspace.id;
    for (const who of ["saver", "colleague"] as const) {
      await prisma.workspaceMembership.create({
        data: {
          workspaceId: workspace.id,
          userId: users[who]!,
          role: "editor",
          createdById: users.saver!,
        },
      });
    }
  }
  return { organizationId: org.id, users, workspaces };
}

type Seed = Awaited<ReturnType<typeof seed>>;
let world: Seed;

function actor(seeded: Seed, userId: string): ActorContext {
  return {
    userId,
    organizationId: seeded.organizationId,
    organizationRole: "member",
    organizationDefaultWorkspaceId: seeded.workspaces.Home ?? null,
  };
}

/** The save both surfaces perform: the result's bytes into a chosen Workspace. */
function save(
  seeded: Seed,
  userId: string,
  workspaceId: string,
  data: Buffer,
  name = "merged.pdf",
  intentKey?: string,
) {
  return uploads.uploadToWorkspace(actor(seeded, userId), workspaceId, {
    ownerType: "org",
    ownerId: seeded.organizationId,
    data,
    mimeType: "application/pdf",
    originalName: name,
    name,
    saveIntent: intentKey
      ? { key: intentKey, sourceKind: "local-result", sourceIdentity: "merge-result" }
      : null,
  });
}

/** A key of the shape the server accepts, from a label short enough to read. */
const saveKey = (label: string) => `si-${label}`.padEnd(24, "0");

beforeAll(() => {
  if (!existsSync(prismaExecutable)) {
    throw new Error(`Prisma executable is missing at ${prismaExecutable}`);
  }
  execFileSync(
    process.execPath,
    [prismaExecutable, "migrate", "deploy", "--schema", path.join(root, "prisma", "schema.prisma")],
    { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe" },
  );
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  storage = new LocalFileStorage(path.join(temporaryDirectory, "objects"));
  logger = new SilentLogger();
  uploads = new WorkspaceAwareUploadService(
    storage,
    new PrismaStoredFileRepository(prisma),
    logger,
    new WorkspaceService(
      prisma,
      new PrismaWorkspaceRepository(prisma),
      new PrismaWorkspaceMembershipRepository(prisma),
    ),
    new PrismaDocumentRecordRepository(prisma),
    new PrismaFolderRepository(prisma),
    new PrismaProjectRepository(prisma),
    new PrismaDocumentIngestionRepository(prisma),
    new PrismaWorkspaceSaveIntentRepository(prisma),
    // No queue: ingestion promotion is a different test's subject, and a missing
    // queue is a tolerated state the service documents.
  );
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

beforeEach(async () => {
  await reset();
  world = await seed();
  logger.entries.length = 0;
});

describe("C9/C10 — two concurrent saves of one result create one document", () => {
  it("hands both requests the same canonical document, and stores the bytes once", async () => {
    const data = resultBytes("concurrent");
    // One intention, pressed twice — the double click, or the retry of a request
    // still in flight. Both carry the key the result was minted with.
    const key = saveKey("concurrent");
    const [first, second] = await Promise.all([
      save(world, world.users.saver!, world.workspaces.Home!, data, "merged.pdf", key),
      save(world, world.users.saver!, world.workspaces.Home!, data, "merged.pdf", key),
    ]);

    // Neither request fails. The loser converges instead of reporting an error
    // for a save that happened — reporting one is what makes a client retry.
    expect(first.document.id).toBe(second.document.id);
    // Exactly one of them created it; the other says so.
    expect([first.deduplicated, second.deduplicated].sort()).toEqual([false, true]);

    // One document, one ingestion, one stored file, one object. Counted in the
    // database, not inferred from the responses.
    const live = await prisma.documentRecord.findMany({
      where: { workspaceId: world.workspaces.Home!, lifecycleState: { not: "trashed" } },
    });
    expect(live.map((d) => d.id)).toEqual([first.document.id]);
    const ingestions = await prisma.documentIngestion.findMany({
      where: { workspaceId: world.workspaces.Home! },
    });
    expect(ingestions).toHaveLength(1);
    expect(ingestions[0]!.checksum).toBe(sha(data));
    expect(ingestions[0]!.documentId).toBe(first.document.id);
    expect(await prisma.storedFile.count()).toBe(1);

    // And the winner's bytes are still there. The losing request used to delete
    // this object on its way out, because the key is content-addressed and its
    // own `head` check had said the object was new.
    const stored = await storage.get(keyFor(data));
    expect(Buffer.from(stored).equals(data)).toBe(true);
    const file = await prisma.storedFile.findFirstOrThrow();
    expect(file.key).toBe(keyFor(data));
    expect(file.id).toBe(ingestions[0]!.storedFileId);
  });

  it("holds for a burst, not just for two", async () => {
    const data = resultBytes("burst");
    const key = saveKey("burst");
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        save(world, world.users.saver!, world.workspaces.Home!, data, "merged.pdf", key),
      ),
    );
    expect(new Set(results.map((r) => r.document.id)).size).toBe(1);
    expect(results.filter((r) => !r.deduplicated)).toHaveLength(1);
    expect(await prisma.documentIngestion.count()).toBe(1);
    expect(
      await prisma.documentRecord.count({ where: { lifecycleState: { not: "trashed" } } }),
    ).toBe(1);
    expect(Buffer.from(await storage.get(keyFor(data))).equals(data)).toBe(true);
  });
});

describe("C11 — a retry after a lost response returns the original document", () => {
  it("answers the second attempt with the first document and no second write", async () => {
    const data = resultBytes("lost-response");
    // The first save succeeds on the server. Its response never reaches the
    // browser, so the user presses Save again on a remounted result panel: same
    // result, same bytes, same destination, new request.
    const original = await save(world, world.users.saver!, world.workspaces.Home!, data);
    expect(original.deduplicated).toBe(false);
    const stored = await prisma.storedFile.findFirstOrThrow();

    const retry = await save(world, world.users.saver!, world.workspaces.Home!, data);
    expect(retry.deduplicated).toBe(true);
    expect(retry.document.id).toBe(original.document.id);
    expect(retry.ingestion.id).toBe(original.ingestion.id);
    // No second document, no second ingestion, no second copy of the bytes.
    expect(await prisma.documentRecord.count()).toBe(1);
    expect(await prisma.documentIngestion.count()).toBe(1);
    expect(await prisma.storedFile.count()).toBe(1);
    expect((await prisma.storedFile.findFirstOrThrow()).createdAt).toEqual(stored.createdAt);
  });

  it("survives the process the identity was created in", async () => {
    // The identity is a row and a unique index, not anything held in memory: a
    // second client, on a second connection, with its own service instance, sees
    // the same one. This is the assertion an in-memory lock cannot pass.
    const data = resultBytes("restart");
    const original = await save(world, world.users.saver!, world.workspaces.Home!, data);

    const restarted = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
      const afterRestart = new WorkspaceAwareUploadService(
        new LocalFileStorage(path.join(temporaryDirectory, "objects")),
        new PrismaStoredFileRepository(restarted),
        logger,
        new WorkspaceService(
          restarted,
          new PrismaWorkspaceRepository(restarted),
          new PrismaWorkspaceMembershipRepository(restarted),
        ),
        new PrismaDocumentRecordRepository(restarted),
        new PrismaFolderRepository(restarted),
        new PrismaProjectRepository(restarted),
        new PrismaDocumentIngestionRepository(restarted),
        new PrismaWorkspaceSaveIntentRepository(restarted),
      );
      const retry = await afterRestart.uploadToWorkspace(
        actor(world, world.users.saver!),
        world.workspaces.Home!,
        {
          ownerType: "org",
          ownerId: world.organizationId,
          data,
          mimeType: "application/pdf",
          originalName: "merged.pdf",
          name: "merged.pdf",
        },
      );
      expect(retry.deduplicated).toBe(true);
      expect(retry.document.id).toBe(original.document.id);
    } finally {
      await restarted.$disconnect();
    }
  });
});

describe("C12 — the identity is bound to the destination and to authorization", () => {
  it("does not let a second destination reuse the first save", async () => {
    const data = resultBytes("two-destinations");
    const home = await save(world, world.users.saver!, world.workspaces.Home!, data);
    const other = await save(world, world.users.saver!, world.workspaces.Other!, data);

    // Two Workspaces, two documents. Saving the same result into a second
    // Workspace is a second, legitimate save — the identity is
    // `(workspaceId, checksum)`, so it cannot silently answer with the document
    // in a Workspace the user did not choose.
    expect(other.deduplicated).toBe(false);
    expect(other.document.id).not.toBe(home.document.id);
    expect(other.document.workspaceId).toBe(world.workspaces.Other!);
    expect(await prisma.documentIngestion.count()).toBe(2);
    // The bytes themselves are still stored once: the key is content-addressed,
    // so the second destination adds a reference, not a copy.
    const files = await prisma.storedFile.findMany();
    expect(files).toHaveLength(2);
    expect(new Set(files.map((f) => f.key))).toEqual(new Set([keyFor(data)]));
  });

  it("refuses an actor who is not a member of the destination, before consulting the checksum", async () => {
    const data = resultBytes("not-yours");
    const mine = await save(world, world.users.saver!, world.workspaces.Other!, data);

    // Same bytes, same Workspace, an actor with no membership in it. If the
    // dedup lookup ran first they would be handed `mine.document.id` — an
    // existence oracle for another member's document.
    const refusal = await save(world, world.users.outsider!, world.workspaces.Other!, data).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(Error);
    // And the refusal is the same one an unknown Workspace id produces, so
    // "exists but not yours" is not distinguishable from "does not exist".
    const unknown = await save(world, world.users.outsider!, "wks_does_not_exist", data).catch(
      (error: unknown) => error,
    );
    expect((refusal as Error).message).toBe((unknown as Error).message);
    expect(String((refusal as Error).message)).not.toContain(mine.document.id);

    // Nothing was created by either attempt.
    expect(await prisma.documentIngestion.count()).toBe(1);
    expect(await prisma.documentRecord.count()).toBe(1);
    expect(await prisma.storedFile.count()).toBe(1);
  });

  it("still allows two different results to share a filename", async () => {
    // The ban this pins: idempotency must not become "one document per name".
    const first = await save(world, world.users.saver!, world.workspaces.Home!, resultBytes("a"));
    const second = await save(world, world.users.saver!, world.workspaces.Home!, resultBytes("b"));
    expect(second.deduplicated).toBe(false);
    expect(second.document.id).not.toBe(first.document.id);
    expect(await prisma.documentIngestion.count()).toBe(2);
  });
});

describe("C13 — a failure before persistence leaves nothing behind and stays retryable", () => {
  it("writes no rows, no object and no success record for a rejected save", async () => {
    const data = resultBytes("rejected");
    // The two ways a save is refused before anything is persisted: a type the
    // Workspace does not ingest, and bytes that do not match the declared type.
    await expect(
      uploads.uploadToWorkspace(actor(world, world.users.saver!), world.workspaces.Home!, {
        ownerType: "org",
        ownerId: world.organizationId,
        data,
        mimeType: "application/zip",
        originalName: "pages.zip",
        name: "pages.zip",
      }),
    ).rejects.toThrow(/Unsupported file type/);
    await expect(
      uploads.uploadToWorkspace(actor(world, world.users.saver!), world.workspaces.Home!, {
        ownerType: "org",
        ownerId: world.organizationId,
        data: Buffer.from("PK not a pdf"),
        mimeType: "application/pdf",
        originalName: "claims.pdf",
        name: "claims.pdf",
      }),
    ).rejects.toThrow(/do not match the declared type/);

    expect(await prisma.documentIngestion.count()).toBe(0);
    expect(await prisma.documentRecord.count()).toBe(0);
    expect(await prisma.storedFile.count()).toBe(0);
    expect((await storage.head(keyFor(data))).exists).toBe(false);

    // Retryable: the refusal recorded no "this result is saved" fact, so the
    // same result saved properly still creates its document.
    const saved = await save(world, world.users.saver!, world.workspaces.Home!, data);
    expect(saved.deduplicated).toBe(false);
    expect(await prisma.documentIngestion.count()).toBe(1);
  });

  it("does not rewrite the stored bytes on a retry", async () => {
    const data = resultBytes("no-second-write");
    await save(world, world.users.saver!, world.workspaces.Home!, data);
    const objectPath = path.join(temporaryDirectory, "objects", keyFor(data));
    const before = statSync(objectPath);

    const retry = await save(world, world.users.saver!, world.workspaces.Home!, data);
    expect(retry.deduplicated).toBe(true);
    const after = statSync(objectPath);
    // Same inode, same size, same mtime: the retry returned before `storage.put`.
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    expect(Buffer.from(await storage.get(keyFor(data))).equals(data)).toBe(true);
  });
});
