/**
 * SAVE INTENTION is not CONTENT. The five counterexamples, then D1-D23.
 *
 * The previous Phase 5 closeout called `DocumentIngestion @@unique([workspaceId,
 * checksum])` persistent save idempotency. It is not: it is content
 * deduplication, and the two only look alike while every save of identical bytes
 * happens to be the same save. Three identities are involved and the old design
 * had one row for all three —
 *
 *   1. the user's INTENTION to save ("this press of Save", retried or not),
 *   2. the logical Workspace DOCUMENT that intention produced,
 *   3. the CONTENT, i.e. `sha256(bytes)` and the object it addresses.
 *
 * Collapsing 1 into 3 says "these bytes may exist here once", which is a claim
 * about content and a wrong claim about operations. What it costs, concretely:
 * saving one file deliberately twice under two names silently yields one
 * document under the first name, and saving → trashing → saving the same bytes
 * again hits the unique index and returns a server error for an action the
 * product has no reason to refuse.
 *
 * WHY A REAL DATABASE. The identity under test IS a row and a unique index; the
 * in-memory ingestion twin enforces only `(workspaceId, documentId)`, so the
 * collisions below cannot happen there and a fake would stay green through every
 * defect. SQLite is real, the migrations are real, the storage is a real
 * `LocalFileStorage`, and the service is the real one.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
import type { DocumentIngestionRepository } from "@/src/application/ports/workspaces/DocumentIngestionRepository";
import { PrismaWorkspaceSaveIntentRepository } from "@/src/infrastructure/persistence/PrismaWorkspaceSaveIntentRepository";
import { PrismaStoredFileRepository } from "@/src/infrastructure/persistence/PrismaStoredFileRepository";
import { PrismaFolderRepository } from "@/src/infrastructure/persistence/PrismaFolderRepository";
import { PrismaProjectRepository } from "@/src/infrastructure/persistence/PrismaProjectRepository";
import { LocalFileStorage } from "@/src/infrastructure/storage/LocalFileStorage";
import type { ILogger, LogFields } from "@/src/application/ports/Logger";
import type { IObjectStorage } from "@/src/application/ports/storage/ObjectStorage";

const root = process.cwd();
const prismaExecutable = path.join(root, "node_modules", "prisma", "build", "index.js");
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "pdfdadi-save-intent-"));
const databaseUrl = `file:${path.join(temporaryDirectory, "intent.db").replaceAll("\\", "/")}`;

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

/** A one-page PDF whose bytes are stable, so its checksum is stable too. */
function resultBytes(marker: string): Buffer {
  return Buffer.from(`%PDF-1.7\n% result ${marker}\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\n%%EOF\n`);
}
const sha = (data: Buffer) => crypto.createHash("sha256").update(data).digest("hex");
const keyFor = (data: Buffer) => {
  const hash = sha(data);
  return `ca/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
};

async function reset() {
  await prisma.$executeRawUnsafe("delete from workspace_save_intents").catch(() => 0);
  await prisma.documentIngestion.deleteMany();
  await prisma.documentRecord.deleteMany();
  await prisma.storedFile.deleteMany();
  await prisma.workspaceMembership.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.organizationMembership.deleteMany();
  await prisma.organization.deleteMany();
  await prisma.user.deleteMany();
}

/** One organization, two members plus an outsider, two Workspaces. */
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

/**
 * The save both result surfaces perform. `intent` is what makes it an OPERATION:
 * omitting it is the legacy keyless upload (the file manager, the editor's first
 * save, probe journey K), which keeps deduplicating by content.
 */
function save(
  seeded: Seed,
  userId: string,
  workspaceId: string,
  data: Buffer,
  options: {
    name?: string;
    intent?: { key: string; sourceKind: "local-result" | "processing-job"; sourceIdentity: string };
  } = {},
) {
  const name = options.name ?? "merged.pdf";
  return uploads.uploadToWorkspace(actor(seeded, userId), workspaceId, {
    ownerType: "org",
    ownerId: seeded.organizationId,
    data,
    mimeType: "application/pdf",
    originalName: name,
    name,
    saveIntent: options.intent,
  });
}

/**
 * A key shaped like the client's own (`lib/workflow/saveIntent.ts`): an opaque
 * `si-` body, padded so it clears `SAVE_INTENT_LIMITS.minKeyLength`. The server
 * enforces that bound so a hand-written "save1" cannot be presented as an
 * intention, which is why the labels below are padded rather than short.
 */
const key = (label: string) => `si-${label}`.padEnd(24, "0");

/** A local-result intention, as `ResultActions` mints it. */
const localIntent = (label: string, sourceIdentity = "merge-result") =>
  ({ key: key(label), sourceKind: "local-result", sourceIdentity }) as const;

/**
 * The persistent save-intent rows, read as SQL.
 *
 * Raw on purpose: before the fix there is no such table, so every assertion about
 * operation identity fails with "no such table: workspace_save_intents" — which is
 * the defect stated precisely, rather than a green test over a missing concept.
 */
async function intentRows(key?: string) {
  const rows = (await prisma.$queryRawUnsafe(
    `select key, userId, workspaceId, sourceKind, sourceIdentity, payloadChecksum, status, documentId
       from workspace_save_intents${key ? " where key = ?" : ""}`,
    ...(key ? [key] : []),
  )) as Array<Record<string, string | null>>;
  return rows;
}

const activeDocuments = (workspaceId: string) =>
  prisma.documentRecord.findMany({
    where: { workspaceId, lifecycleState: { not: "trashed" } },
    orderBy: { createdAt: "asc" },
  });

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
  uploads = buildUploads(prisma, storage);
}, 120000);

/**
 * The real service over real repositories. Rebuilt in the restart test.
 *
 * `ingestions` is overridable for one reason: the mid-transaction failure cases
 * need the write that makes a document real to fail AFTER the object is stored and
 * the claim is held, and no input to a real repository produces that. Everything
 * else stays the production adapter.
 */
function buildUploads(
  client: PrismaClient,
  files: IObjectStorage,
  ingestions: DocumentIngestionRepository = new PrismaDocumentIngestionRepository(client),
) {
  return new WorkspaceAwareUploadService(
    files,
    new PrismaStoredFileRepository(client),
    logger,
    new WorkspaceService(
      client,
      new PrismaWorkspaceRepository(client),
      new PrismaWorkspaceMembershipRepository(client),
    ),
    new PrismaDocumentRecordRepository(client),
    new PrismaFolderRepository(client),
    new PrismaProjectRepository(client),
    ingestions,
    new PrismaWorkspaceSaveIntentRepository(client),
  );
}

/**
 * The real storage, reporting every object as ABSENT.
 *
 * This is the only honest way to reach the race in a sequential test: two saves of
 * identical bytes both `head` the content-addressed key before either `put` lands,
 * so both believe they are the one creating the object. The loser's rollback then
 * has to decide whether the object is its own to delete — and the answer is a
 * question about OTHER references, not about what this request saw.
 */
function storageThatSeesNoObject(files: LocalFileStorage): IObjectStorage {
  const blind = Object.create(files) as IObjectStorage;
  blind.head = async (key: string) => ({ key, size: 0, contentType: null, exists: false });
  return blind;
}

/** The same repository, with the one write that makes a document real broken. */
function ingestionThatFails(client: PrismaClient): DocumentIngestionRepository {
  const broken = Object.create(
    new PrismaDocumentIngestionRepository(client),
  ) as DocumentIngestionRepository;
  broken.create = async () => {
    throw new Error("ingestion write failed");
  };
  return broken;
}

afterAll(async () => {
  await prisma?.$disconnect();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

beforeEach(async () => {
  await reset();
  world = await seed();
  logger.entries.length = 0;
});

describe("§2 A — the same intention, retried, is one save", () => {
  it("returns the one canonical document and records one completed operation", async () => {
    const data = resultBytes("A");
    const intent = localIntent("k-retry-A");
    const first = await save(world, world.users.saver!, world.workspaces.Home!, data, { intent });
    const retry = await save(world, world.users.saver!, world.workspaces.Home!, data, { intent });

    expect(retry.document.id).toBe(first.document.id);
    expect(retry.deduplicated).toBe(true);
    expect(await activeDocuments(world.workspaces.Home!)).toHaveLength(1);
    expect(await prisma.documentIngestion.count()).toBe(1);

    // The part no checksum index can answer: a durable record of THE OPERATION,
    // completed once, pointing at the document it produced.
    const rows = await intentRows(intent.key);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("completed");
    expect(rows[0]!.documentId).toBe(first.document.id);
    expect(rows[0]!.payloadChecksum).toBe(sha(data));
  });
});

describe("§2 B — a new intention over identical bytes is a new document", () => {
  it("creates a second logical document, and keeps the name that intention asked for", async () => {
    const data = resultBytes("B");
    const first = await save(world, world.users.saver!, world.workspaces.Home!, data, {
      name: "quarterly.pdf",
      intent: localIntent("k-B-first"),
    });
    // The user pressed Save again on a NEW result of the same tool run — or chose
    // Save a copy. Different intention, identical bytes.
    const second = await save(world, world.users.saver!, world.workspaces.Home!, data, {
      name: "quarterly-copy.pdf",
      intent: localIntent("k-B-second"),
    });

    expect(second.deduplicated).toBe(false);
    expect(second.document.id).not.toBe(first.document.id);
    expect(second.document.name).toBe("quarterly-copy.pdf");
    expect((await activeDocuments(world.workspaces.Home!)).map((d) => d.name)).toEqual([
      "quarterly.pdf",
      "quarterly-copy.pdf",
    ]);
    // Two logical documents, ONE physical object: dedup is allowed to stay, at the
    // layer where it is true.
    expect(new Set((await prisma.storedFile.findMany()).map((f) => f.key))).toEqual(
      new Set([keyFor(data)]),
    );
  });
});

describe("§2 C — two deliberate saves of one file under two names", () => {
  it("does not converge them on the checksum", async () => {
    const data = resultBytes("C");
    const contract = await save(world, world.users.saver!, world.workspaces.Home!, data, {
      name: "contract.pdf",
      intent: localIntent("k-C-1"),
    });
    const copy = await save(world, world.users.saver!, world.workspaces.Home!, data, {
      name: "contract-copy.pdf",
      intent: localIntent("k-C-2"),
    });

    expect(copy.document.id).not.toBe(contract.document.id);
    expect(contract.document.name).toBe("contract.pdf");
    expect(copy.document.name).toBe("contract-copy.pdf");
    expect(copy.ingestion.id).not.toBe(contract.ingestion.id);
    expect(copy.ingestion.checksum).toBe(contract.ingestion.checksum);
    expect(await prisma.documentIngestion.count()).toBe(2);
  });
});

describe("§2 D — save, trash, then save the same bytes again", () => {
  it("produces a new active document instead of a server error", async () => {
    const data = resultBytes("D");
    const original = await save(world, world.users.saver!, world.workspaces.Home!, data, {
      name: "receipt.pdf",
      intent: localIntent("k-D-first"),
    });
    await prisma.documentRecord.update({
      where: { id: original.document.id },
      data: { lifecycleState: "trashed", trashedAt: new Date(), trashedById: world.users.saver! },
    });

    // The user runs the tool again and saves. Same bytes, new intention. The old
    // design reached `ingestions.create` and violated the checksum unique index,
    // so this line threw and the route answered 500.
    const again = await save(world, world.users.saver!, world.workspaces.Home!, data, {
      name: "receipt.pdf",
      intent: localIntent("k-D-second"),
    });

    expect(again.deduplicated).toBe(false);
    expect(again.document.id).not.toBe(original.document.id);
    // Not a silent restoration: the trashed record stays trashed, and stays the
    // record the trash policy governs.
    const before = await prisma.documentRecord.findUniqueOrThrow({
      where: { id: original.document.id },
    });
    expect(before.lifecycleState).toBe("trashed");
    expect(before.trashedAt).not.toBeNull();
    // Exactly one active document, and it is the new one — not the old one handed
    // back as though the save had succeeded.
    const live = await activeDocuments(world.workspaces.Home!);
    expect(live.map((d) => d.id)).toEqual([again.document.id]);
    // Both ingestions exist, sharing the checksum that used to be unique.
    const ingestions = await prisma.documentIngestion.findMany({
      where: { workspaceId: world.workspaces.Home! },
    });
    expect(ingestions).toHaveLength(2);
    expect(new Set(ingestions.map((i) => i.checksum))).toEqual(new Set([sha(data)]));
    // And the new document's bytes are readable.
    expect(Buffer.from(await storage.get(again.file.key)).equals(data)).toBe(true);
  });
});

describe("§2 E — one key, a different meaning", () => {
  it("conflicts on a different payload, and hands back no document at all", async () => {
    const intent = localIntent("k-E-payload");
    const original = await save(world, world.users.saver!, world.workspaces.Home!, resultBytes("E1"), {
      intent,
    });
    // A different result presented under the same key. Returning `original` would
    // tell the user their new file was saved when the old one is what is stored.
    const conflict = await save(
      world,
      world.users.saver!,
      world.workspaces.Home!,
      resultBytes("E1-different"),
      { intent },
    ).catch((error: unknown) => error);

    expect(conflict).toBeInstanceOf(Error);
    expect((conflict as Error).name).toBe("SaveIntentConflictError");
    expect((conflict as Error).message).not.toContain(original.document.id);
    expect((conflict as Error).message).not.toContain(world.workspaces.Home!);
    // Nothing was created for the refused attempt.
    expect(await activeDocuments(world.workspaces.Home!)).toHaveLength(1);
    expect(await prisma.documentIngestion.count()).toBe(1);
  });

  it("conflicts on a different destination", async () => {
    const data = resultBytes("E2");
    const intent = localIntent("k-E-destination");
    await save(world, world.users.saver!, world.workspaces.Home!, data, { intent });
    const conflict = await save(world, world.users.saver!, world.workspaces.Other!, data, {
      intent,
    }).catch((error: unknown) => error);

    expect((conflict as Error).name).toBe("SaveIntentConflictError");
    expect(await activeDocuments(world.workspaces.Other!)).toHaveLength(0);
  });

  it("conflicts on a different source result or job", async () => {
    const data = resultBytes("E3");
    await save(world, world.users.saver!, world.workspaces.Home!, data, {
      intent: { key: key("E-source"), sourceKind: "processing-job", sourceIdentity: "job_1" },
    });
    const conflict = await save(world, world.users.saver!, world.workspaces.Home!, data, {
      intent: { key: key("E-source"), sourceKind: "processing-job", sourceIdentity: "job_2" },
    }).catch((error: unknown) => error);

    expect((conflict as Error).name).toBe("SaveIntentConflictError");
    expect((conflict as Error).message).not.toContain("job_1");
  });

  it("never lets one actor's key reach another actor's operation", async () => {
    const data = resultBytes("E4");
    const intent = localIntent("k-E-shared-literal");
    const mine = await save(world, world.users.saver!, world.workspaces.Home!, data, {
      name: "mine.pdf",
      intent,
    });
    // A colleague — a legitimate member of the same Workspace — happens to present
    // the same key literal. They must not converge on another member's operation,
    // and must not learn that the key exists: they get their own save.
    const theirs = await save(world, world.users.colleague!, world.workspaces.Home!, data, {
      name: "theirs.pdf",
      intent,
    });

    expect(theirs.document.id).not.toBe(mine.document.id);
    expect(theirs.deduplicated).toBe(false);
    expect(theirs.document.name).toBe("theirs.pdf");
    const rows = await intentRows(intent.key);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.userId))).toEqual(
      new Set([world.users.saver!, world.users.colleague!]),
    );
  });
});

describe("D2/D3 — one intention under concurrency, and across a restart", () => {
  it("hands every concurrent caller the same document and records one operation", async () => {
    const data = resultBytes("D2");
    const intent = localIntent("k-D2-burst");
    // Five requests for one press: a double click, plus the retries of a request
    // whose response was slow. Only the first can claim the identity.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        save(world, world.users.saver!, world.workspaces.Home!, data, { intent }),
      ),
    );

    expect(new Set(results.map((r) => r.document.id)).size).toBe(1);
    expect(results.filter((r) => !r.deduplicated)).toHaveLength(1);
    // One row of each kind. The losers never reached storage, so there is nothing
    // of theirs to unwind and no trashed leftover either.
    expect(await prisma.documentRecord.count()).toBe(1);
    expect(await prisma.documentIngestion.count()).toBe(1);
    expect(await prisma.storedFile.count()).toBe(1);
    const rows = await intentRows(intent.key);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("completed");
    expect(rows[0]!.documentId).toBe(results[0]!.document.id);
    expect(Buffer.from(await storage.get(keyFor(data))).equals(data)).toBe(true);
  });

  it("is still the same intention to a service built after a restart", async () => {
    const data = resultBytes("D3");
    const intent = localIntent("k-D3-restart");
    const original = await save(world, world.users.saver!, world.workspaces.Home!, data, { intent });

    // A second connection, a second service instance, nothing shared in memory —
    // the assertion a process-local lock cannot pass.
    const restarted = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
      const rebuilt = buildUploads(
        restarted,
        new LocalFileStorage(path.join(temporaryDirectory, "objects")),
      );
      const retry = await rebuilt.uploadToWorkspace(
        actor(world, world.users.saver!),
        world.workspaces.Home!,
        {
          ownerType: "org",
          ownerId: world.organizationId,
          data,
          mimeType: "application/pdf",
          originalName: "merged.pdf",
          name: "merged.pdf",
          saveIntent: intent,
        },
      );
      expect(retry.deduplicated).toBe(true);
      expect(retry.document.id).toBe(original.document.id);
      expect(retry.ingestion.id).toBe(original.ingestion.id);
    } finally {
      await restarted.$disconnect();
    }
    expect(await prisma.documentRecord.count()).toBe(1);
  });
});

describe("D14/D15 — content shared by several documents outlives any one of them", () => {
  it("keeps every live reference readable when one of them is trashed", async () => {
    const data = resultBytes("D14");
    const first = await save(world, world.users.saver!, world.workspaces.Home!, data, {
      name: "one.pdf",
      intent: localIntent("k-D14-first"),
    });
    const second = await save(world, world.users.saver!, world.workspaces.Home!, data, {
      name: "two.pdf",
      intent: localIntent("k-D14-second"),
    });
    // Two documents, two StoredFile references, one object.
    expect(second.file.key).toBe(first.file.key);
    expect(second.file.id).not.toBe(first.file.id);
    expect(await prisma.storedFile.count()).toBe(2);

    await prisma.documentRecord.update({
      where: { id: first.document.id },
      data: { lifecycleState: "trashed", trashedAt: new Date(), trashedById: world.users.saver! },
    });

    // Trashing one must not take the other's bytes with it.
    expect(Buffer.from(await storage.get(second.file.key)).equals(data)).toBe(true);
    const live = await activeDocuments(world.workspaces.Home!);
    expect(live.map((d) => d.id)).toEqual([second.document.id]);
  });

  it("does not let a failed save's cleanup delete an object another document uses", async () => {
    const data = resultBytes("D15");
    const kept = await save(world, world.users.saver!, world.workspaces.Home!, data, {
      name: "kept.pdf",
      intent: localIntent("k-D15-kept"),
    });

    // A second intention over the same bytes fails after the object is confirmed
    // present and the claim is held. Its rollback must not treat a content-
    // addressed object as its own — the key it would delete is the key `kept` reads.
    const broken = buildUploads(prisma, storage, ingestionThatFails(prisma));
    await expect(
      broken.uploadToWorkspace(actor(world, world.users.saver!), world.workspaces.Home!, {
        ownerType: "org",
        ownerId: world.organizationId,
        data,
        mimeType: "application/pdf",
        originalName: "doomed.pdf",
        name: "doomed.pdf",
        saveIntent: localIntent("k-D15-doomed"),
      }),
    ).rejects.toThrow(/ingestion write failed/);

    expect((await storage.head(kept.file.key)).exists).toBe(true);
    expect(Buffer.from(await storage.get(kept.file.key)).equals(data)).toBe(true);
    // The winner's own reference row is untouched, and the loser's is gone.
    expect(await prisma.storedFile.findUnique({ where: { id: kept.file.id } })).not.toBeNull();
    expect(await prisma.storedFile.count()).toBe(1);
    const live = await activeDocuments(world.workspaces.Home!);
    expect(live.map((d) => d.id)).toEqual([kept.document.id]);
  });

  it("does not delete a shared object it believes it created, when it did not", async () => {
    const data = resultBytes("D15-race");
    const kept = await save(world, world.users.saver!, world.workspaces.Home!, data, {
      name: "winner.pdf",
      intent: localIntent("k-D15-winner"),
    });

    // The loser of the race: it looked before the winner's object landed, so it
    // stored the bytes itself and its rollback is entitled to clean up after
    // itself — but the key is content-addressed, so "its own object" and "the
    // winner's object" are the same bytes at the same key.
    const racing = buildUploads(prisma, storageThatSeesNoObject(storage), ingestionThatFails(prisma));
    await expect(
      racing.uploadToWorkspace(actor(world, world.users.saver!), world.workspaces.Home!, {
        ownerType: "org",
        ownerId: world.organizationId,
        data,
        mimeType: "application/pdf",
        originalName: "loser.pdf",
        name: "loser.pdf",
        saveIntent: localIntent("k-D15-loser"),
      }),
    ).rejects.toThrow(/ingestion write failed/);

    // The winner still has its bytes. Without the reference check this is exactly
    // where a document keeps its row, its version and its name, and loses its file.
    expect((await storage.head(kept.file.key)).exists).toBe(true);
    expect(Buffer.from(await storage.get(kept.file.key)).equals(data)).toBe(true);
    expect(await prisma.storedFile.count()).toBe(1);
  });
});

describe("D17/D18 — a refused save and a broken one both stay retryable", () => {
  it("records no completed operation for a save that failed validation", async () => {
    const intent = localIntent("k-D17-rejected");
    // Refused before the claim: the type is not one this Workspace ingests.
    await expect(
      uploads.uploadToWorkspace(actor(world, world.users.saver!), world.workspaces.Home!, {
        ownerType: "org",
        ownerId: world.organizationId,
        data: resultBytes("D17"),
        mimeType: "application/zip",
        originalName: "pages.zip",
        name: "pages.zip",
        saveIntent: intent,
      }),
    ).rejects.toThrow(/Unsupported file type/);

    // No row at all, so nothing can later be mistaken for "this was saved".
    expect(await intentRows(intent.key)).toHaveLength(0);
    expect(await prisma.documentRecord.count()).toBe(0);
    expect(await prisma.storedFile.count()).toBe(0);

    // And the same key still works for the save the user meant to make.
    const saved = await save(world, world.users.saver!, world.workspaces.Home!, resultBytes("D17"), {
      intent,
    });
    expect(saved.deduplicated).toBe(false);
    expect((await intentRows(intent.key))[0]!.status).toBe("completed");
  });

  it("releases the claim when the write fails mid-way, and the retry completes it", async () => {
    const data = resultBytes("D18");
    const intent = localIntent("k-D18-midway");
    const broken = buildUploads(prisma, storage, ingestionThatFails(prisma));
    await expect(
      broken.uploadToWorkspace(actor(world, world.users.saver!), world.workspaces.Home!, {
        ownerType: "org",
        ownerId: world.organizationId,
        data,
        mimeType: "application/pdf",
        originalName: "half.pdf",
        name: "half.pdf",
        saveIntent: intent,
      }),
    ).rejects.toThrow(/ingestion write failed/);

    // The claim is released, not left pending: a retry must not have to wait out a
    // stale-claim timeout for a save that is already known to have failed.
    const failed = await intentRows(intent.key);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.status).toBe("failed");
    expect(failed[0]!.documentId).toBeNull();
    expect(await activeDocuments(world.workspaces.Home!)).toHaveLength(0);
    expect(await prisma.documentIngestion.count()).toBe(0);

    // The retry — the same intention, through a working service — makes the one
    // document, and the row now points at it.
    const retry = await save(world, world.users.saver!, world.workspaces.Home!, data, { intent });
    expect(retry.deduplicated).toBe(false);
    const completed = await intentRows(intent.key);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.status).toBe("completed");
    expect(completed[0]!.documentId).toBe(retry.document.id);
    expect((await activeDocuments(world.workspaces.Home!)).map((d) => d.id)).toEqual([
      retry.document.id,
    ]);
    expect(Buffer.from(await storage.get(retry.file.key)).equals(data)).toBe(true);
  });
});

describe("D19 — documents saved before intentions existed still work", () => {
  it("reads a keyless save back, and lets a new intention save the same bytes", async () => {
    const data = resultBytes("D19");
    // The legacy shape: a save with no intention key at all, which is what every
    // row written before this migration looks like — and what a file-manager
    // upload still looks like.
    const legacy = await save(world, world.users.saver!, world.workspaces.Home!, data, {
      name: "legacy.pdf",
    });
    expect(await intentRows()).toHaveLength(0);
    expect(Buffer.from(await storage.get(legacy.file.key)).equals(data)).toBe(true);

    // A keyless repeat still converges on content, unchanged.
    const again = await save(world, world.users.saver!, world.workspaces.Home!, data, {
      name: "legacy.pdf",
    });
    expect(again.document.id).toBe(legacy.document.id);
    expect(again.deduplicated).toBe(true);

    // And an intention over those same bytes is its own save, with its own name,
    // reading the object the legacy row already put there.
    const intentional = await save(world, world.users.saver!, world.workspaces.Home!, data, {
      name: "deliberate-copy.pdf",
      intent: localIntent("k-D19-new"),
    });
    expect(intentional.document.id).not.toBe(legacy.document.id);
    expect(intentional.document.name).toBe("deliberate-copy.pdf");
    expect(intentional.file.key).toBe(legacy.file.key);
    expect(Buffer.from(await storage.get(intentional.file.key)).equals(data)).toBe(true);
  });
});

/**
 * D24 — the intention table is bounded, proved against the real column.
 *
 * The horizon itself lives with the sweep that applies it
 * (`SAVE_INTENT_RETENTION_MS`, asserted in `PdfToolWorkerHandler.test.ts`). What
 * has to be proved HERE is the adapter, because the in-memory twin compares two
 * `Date` objects in a Map while Prisma compares a column, and a twin that agreed
 * with a broken adapter is how an unbounded table stays unbounded through a green
 * suite. The cutoff is moved rather than the row's age: that asks the real
 * database the same question in both directions without assuming how SQLite
 * spells a DateTime.
 */
describe("D24 — save intentions are pruned by cutoff, not kept forever", () => {
  it("deletes a row older than the cutoff and keeps one newer than it", async () => {
    const intents = new PrismaWorkspaceSaveIntentRepository(prisma);
    const intent = localIntent("D24-a");

    await save(world, world.users.saver!, world.workspaces.Home!, resultBytes("D24-a"), {
      name: "bounded-a.pdf",
      intent,
    });
    // Read by the key the client actually minted: querying a label the padding
    // never produced would make every assertion below pass on an empty table.
    expect(await intentRows(intent.key)).toHaveLength(1);

    // A cutoff before the row was written: nothing is eligible, and the sweep
    // must not take a live intention with it.
    expect(await intents.pruneBefore(new Date(Date.now() - 60_000))).toBe(0);
    expect(await intentRows(intent.key)).toHaveLength(1);

    // A cutoff after it: the row is past the horizon and goes.
    expect(await intents.pruneBefore(new Date(Date.now() + 60_000))).toBe(1);
    expect(await intentRows(intent.key)).toHaveLength(0);
  });

  it("leaves the document the pruned intention produced", async () => {
    // The row is bookkeeping for one press of Save, not the save itself. Losing
    // it must cost the user nothing.
    const intent = localIntent("D24-b");
    const saved = await save(world, world.users.saver!, world.workspaces.Home!, resultBytes("D24-b"), {
      name: "bounded-b.pdf",
      intent,
    });
    expect(await intentRows(intent.key)).toHaveLength(1);
    expect(
      await new PrismaWorkspaceSaveIntentRepository(prisma).pruneBefore(new Date(Date.now() + 60_000)),
    ).toBe(1);

    expect(await intentRows(intent.key)).toHaveLength(0);
    const doc = await prisma.documentRecord.findUnique({ where: { id: saved.document.id } });
    expect(doc?.name).toBe("bounded-b.pdf");
    expect(Buffer.from(await storage.get(saved.file.key)).equals(resultBytes("D24-b"))).toBe(true);
  });
});
