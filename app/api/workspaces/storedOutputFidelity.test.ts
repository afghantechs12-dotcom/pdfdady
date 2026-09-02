import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

/**
 * C14/C15 — the bytes in the Workspace are the bytes the tool produced.
 *
 * "One document exists" is not fidelity. A save that stored the INPUT instead of
 * the result, or a stale handoff buffer, or a re-encode that dropped pages, all
 * produce exactly one document with exactly the right name — so every assertion
 * here is about the stored object itself, read back out of storage and PARSED,
 * not about a row count.
 *
 * The two save paths are different enough to need separate proof and are both
 * exercised through their real routes:
 *
 *  - **Merge → Workspace** is a local result: the browser produced the bytes, so
 *    they arrive as a multipart upload. The merge is the REAL `mergePdfs` over two
 *    real PDFs, so the output is a genuine pdf-lib merge and not a fixture that
 *    happens to have five pages.
 *  - **Compress → Workspace** is a cloud result: the bytes never touch the
 *    browser, and the input is also sitting in storage — which is what makes
 *    "stored the output, not the input" a real thing to get wrong. Ghostscript is
 *    not invoked (it is not the subject and is not installed everywhere); what is
 *    real is that two DIFFERENT objects exist and the route has to pick the job's.
 *
 * Fidelity is asserted three ways over the stored object: its sha256 equals the
 * result's, its page count and per-page geometry survive a pdf-lib reparse, and
 * the other candidate's checksum appears nowhere in the database or storage.
 */

const registry = vi.hoisted(() => new Map<symbol, unknown>());
const cookieState = vi.hoisted(() => ({ session: null as string | null }));

vi.mock("@/src/application/di/container", () => ({
  appContainer: {
    resolve: (token: symbol) => {
      const found = registry.get(token);
      if (!found) throw new Error(`Unregistered token in test: ${String(token)}`);
      return found;
    },
  },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "pdfdadi_session" && cookieState.session
        ? { name, value: cookieState.session }
        : undefined,
    set: () => {},
  }),
}));

vi.mock("@/src/infrastructure/jobs/workerBootstrap", () => ({ ensureWorkerReady: () => {} }));

import { Tokens } from "@/src/application/di/tokens";
import { WorkspaceService } from "@/src/application/services/WorkspaceService";
import { WorkspaceAwareUploadService } from "@/src/application/services/WorkspaceAwareUploadService";
import {
  ProcessingJobService,
  PROCESSING_JOB_TYPE,
  type ProcessingJobResult,
} from "@/src/application/services/ProcessingJobService";
import { InMemoryJobRepository } from "@/src/infrastructure/persistence/InMemoryJobRepository";
import { PrismaWorkspaceRepository } from "@/src/infrastructure/persistence/PrismaWorkspaceRepository";
import { PrismaWorkspaceMembershipRepository } from "@/src/infrastructure/persistence/PrismaWorkspaceMembershipRepository";
import { PrismaDocumentRecordRepository } from "@/src/infrastructure/persistence/PrismaDocumentRecordRepository";
import { PrismaDocumentIngestionRepository } from "@/src/infrastructure/persistence/PrismaDocumentIngestionRepository";
import { PrismaStoredFileRepository } from "@/src/infrastructure/persistence/PrismaStoredFileRepository";
import { PrismaFolderRepository } from "@/src/infrastructure/persistence/PrismaFolderRepository";
import { PrismaProjectRepository } from "@/src/infrastructure/persistence/PrismaProjectRepository";
import { LocalOrganizationProvider } from "@/src/infrastructure/auth/LocalOrganizationProvider";
import { LocalRoleProvider } from "@/src/infrastructure/auth/LocalRoleProvider";
import { LocalFileStorage } from "@/src/infrastructure/storage/LocalFileStorage";
import { mergePdfs } from "@/lib/pdf/merge";
import type { ILogger, LogFields } from "@/src/application/ports/Logger";
import { POST as UPLOAD } from "@/app/api/workspaces/[workspaceId]/documents/upload/route";
import { POST as SAVE_JOB } from "@/app/api/jobs/[id]/save-to-workspace/route";

const root = process.cwd();
const prismaExecutable = path.join(root, "node_modules", "prisma", "build", "index.js");
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "pdfdadi-fidelity-"));
const databaseUrl = `file:${path.join(temporaryDirectory, "route.db").replaceAll("\\", "/")}`;
const ORIGIN = "http://localhost:3001";

class SilentLogger implements ILogger {
  debug(_m: string, _f?: LogFields) {}
  info(_m: string, _f?: LogFields) {}
  warn(_m: string, _f?: LogFields) {}
  error(_m: string, _f?: LogFields) {}
  child(): ILogger { return this; }
}

let prisma: PrismaClient;
let storage: LocalFileStorage;
let jobs: InMemoryJobRepository;
let audit: number;
let world: Awaited<ReturnType<typeof seed>>;

const sha = (data: Buffer) => crypto.createHash("sha256").update(data).digest("hex");
const objectKey = (checksum: string) =>
  `ca/${checksum.slice(0, 2)}/${checksum.slice(2, 4)}/${checksum}`;

/** A real PDF with `pages` pages, each `size` wide and tall. */
async function makePdf(pages: number, size: number, title?: string) {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  if (title) doc.setTitle(title);
  for (let i = 0; i < pages; i += 1) doc.addPage([size, size]);
  return Buffer.from(await doc.save());
}

/** What a reader gets when they open the stored document: shape, not bytes. */
async function describePdf(data: Buffer) {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(data);
  return {
    title: doc.getTitle() ?? null,
    pages: doc.getPageCount(),
    sizes: doc.getPages().map((page) => Math.round(page.getWidth())),
  };
}

/** POSTs bytes to the real upload route the way the browser posts a local result. */
async function upload(workspaceId: string, data: Buffer, name: string) {
  const form = new FormData();
  form.set("file", new File([data], name, { type: "application/pdf" }));
  form.set("organizationId", world.orgs.alpha);
  const request = new NextRequest(`${ORIGIN}/api/workspaces/${workspaceId}/documents/upload`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      cookie: `pdfdadi_session=${cookieState.session}`,
    },
    body: form,
  });
  const res = await UPLOAD(request, { params: Promise.resolve({ workspaceId }) });
  return { res, json: (await res.json()) as Record<string, unknown> };
}

/** POSTs the id of a finished cloud job to the real save-to-workspace route. */
async function saveJob(id: string, workspaceId: string) {
  const payload = JSON.stringify({ workspaceId, organizationId: world.orgs.alpha });
  const request = new NextRequest(`${ORIGIN}/api/jobs/${id}/save-to-workspace`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      cookie: `pdfdadi_session=${cookieState.session}`,
    },
    body: payload,
  });
  const res = await SAVE_JOB(request, { params: Promise.resolve({ id }) });
  return {
    res,
    requestBytes: Buffer.byteLength(payload),
    json: (await res.json()) as Record<string, unknown>,
  };
}

/** A completed compress job whose output is already in PDFDadi's storage. */
async function completedCompressJob(output: Buffer) {
  const key = `jobs/out/${sha(output).slice(0, 12)}.pdf`;
  await storage.put(key, output, { contentType: "application/pdf", sha256: sha(output) });
  const job = await jobs.create({
    type: PROCESSING_JOB_TYPE,
    payload: { toolSlug: "compress-pdf" },
    status: "completed",
    ownerType: "user",
    ownerId: world.users.saver,
    toolSlug: "compress-pdf",
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const result: ProcessingJobResult = {
    output: {
      key,
      fileId: "job-output-file",
      downloadName: "compressed.pdf",
      mimeType: "application/pdf",
      bytes: output.byteLength,
    },
  };
  await jobs.update(job.id, { result });
  return { id: job.id, key };
}

/** The stored object behind the one document in a Workspace. */
async function storedBytes(workspaceId: string) {
  const ingestion = await prisma.documentIngestion.findFirstOrThrow({ where: { workspaceId } });
  const file = await prisma.storedFile.findUniqueOrThrow({ where: { id: ingestion.storedFileId } });
  return { ingestion, file, bytes: await storage.get(file.key) };
}

async function seed() {
  const user = await prisma.user.create({
    data: { email: "saver@example.test", provider: "local", passwordHash: "s:h" },
  });
  const alpha = await prisma.organization.create({
    data: { name: "Alpha", slug: "alpha", plan: "free" },
  });
  await prisma.organizationMembership.create({
    data: { organizationId: alpha.id, userId: user.id, role: "member" },
  });
  const home = await prisma.workspace.create({
    data: {
      organizationId: alpha.id,
      name: "Home",
      normalizedName: "home",
      slug: "home",
      normalizedSlug: "home",
      createdById: user.id,
    },
  });
  await prisma.workspaceMembership.create({
    data: { workspaceId: home.id, userId: user.id, role: "editor", createdById: user.id },
  });
  await prisma.organization.update({
    where: { id: alpha.id },
    data: { defaultWorkspaceId: home.id },
  });
  return { users: { saver: user.id }, orgs: { alpha: alpha.id }, workspaces: { home: home.id } };
}

beforeAll(() => {
  if (!existsSync(prismaExecutable)) throw new Error(`Prisma is missing at ${prismaExecutable}`);
  execFileSync(
    process.execPath,
    [prismaExecutable, "migrate", "deploy", "--schema", path.join(root, "prisma", "schema.prisma")],
    { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe" },
  );
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  storage = new LocalFileStorage(path.join(temporaryDirectory, "objects"));
  const workspaces = new WorkspaceService(
    prisma,
    new PrismaWorkspaceRepository(prisma),
    new PrismaWorkspaceMembershipRepository(prisma),
  );
  registry.set(Tokens.AuthService, {
    getMe: async (token: string) =>
      token === `tok-${world.users.saver}` ? { id: world.users.saver } : null,
  });
  registry.set(Tokens.OrganizationProvider, new LocalOrganizationProvider(prisma));
  registry.set(Tokens.RoleProvider, new LocalRoleProvider(prisma));
  registry.set(Tokens.WorkspaceService, workspaces);
  registry.set(Tokens.ObjectStorage, storage);
  registry.set(
    Tokens.WorkspaceAwareUploadService,
    new WorkspaceAwareUploadService(
      storage,
      new PrismaStoredFileRepository(prisma),
      new SilentLogger(),
      workspaces,
      new PrismaDocumentRecordRepository(prisma),
      new PrismaFolderRepository(prisma),
      new PrismaProjectRepository(prisma),
      new PrismaDocumentIngestionRepository(prisma),
    ),
  );
  registry.set(Tokens.AuditLogRepository, {
    record: async () => {
      audit += 1;
      return { id: `audit-${audit}` };
    },
    listByOrg: async () => [],
  });
  for (const token of [
    Tokens.WorkspaceMembershipService,
    Tokens.ProjectService,
    Tokens.FolderService,
    Tokens.DocumentRecordService,
  ]) {
    registry.set(token, {});
  }
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.documentIngestion.deleteMany();
  await prisma.documentRecord.deleteMany();
  await prisma.storedFile.deleteMany();
  await prisma.workspaceMembership.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.organizationMembership.deleteMany();
  await prisma.organization.deleteMany();
  await prisma.user.deleteMany();
  rmSync(path.join(temporaryDirectory, "objects"), { recursive: true, force: true });
  world = await seed();
  jobs = new InMemoryJobRepository();
  audit = 0;
  registry.set(Tokens.JobRepository, jobs);
  registry.set(
    Tokens.ProcessingJobService,
    new ProcessingJobService({
      jobRepo: jobs,
      queue: {} as never,
      worker: {} as never,
      logger: new SilentLogger(),
      now: () => new Date(),
    }),
  );
  cookieState.session = `tok-${world.users.saver}`;
});

describe("C14 — a local Merge result becomes the Workspace document", () => {
  it("stores the merged PDF: its bytes, its pages, and neither input", async () => {
    // Two real PDFs, distinguishable by page geometry so the ORDER and SOURCE of
    // every page in the merge is checkable afterwards.
    const alpha = await makePdf(2, 200);
    const beta = await makePdf(3, 300);
    const merged = Buffer.from(
      await (await mergePdfs([
        new File([alpha], "alpha.pdf", { type: "application/pdf" }),
        new File([beta], "beta.pdf", { type: "application/pdf" }),
      ])).blob.arrayBuffer(),
    );
    // The real merge, not a fixture: five pages, the first two 200 wide.
    expect(await describePdf(merged)).toEqual({ title: null, pages: 5, sizes: [200, 200, 300, 300, 300] });

    const { res, json } = await upload(world.workspaces.home, merged, "merged.pdf");
    expect(res.status).toBe(201);
    const documentId = (json.document as { id: string }).id;

    const stored = await storedBytes(world.workspaces.home);
    // Byte identity with what the tool produced.
    expect(stored.bytes.equals(merged)).toBe(true);
    expect(stored.ingestion.checksum).toBe(sha(merged));
    expect(stored.file.size).toBe(merged.byteLength);
    // And semantic identity, in case a future ingestion step legitimately
    // rewrites bytes: reopening the document yields the same document.
    expect(await describePdf(stored.bytes)).toEqual({ title: null, pages: 5, sizes: [200, 200, 300, 300, 300] });

    /*
     * NEITHER INPUT WAS STORED. This is the failure a document count cannot see: a
     * save that uploaded the first selected file, or a stale handoff buffer left
     * over from an earlier run, produces one document with the right name and the
     * wrong contents.
     */
    for (const input of [alpha, beta]) {
      expect(sha(input)).not.toBe(stored.ingestion.checksum);
      expect(await prisma.storedFile.count({ where: { sha256: sha(input) } })).toBe(0);
      expect((await storage.head(objectKey(sha(input)))).exists).toBe(false);
    }
    expect(await prisma.storedFile.count()).toBe(1);
    expect(await prisma.documentRecord.count()).toBe(1);

    // And the retry after a lost response is the same document, not a sixth page
    // count somewhere else.
    const retry = await upload(world.workspaces.home, merged, "merged.pdf");
    expect(retry.res.status).toBe(200);
    expect(retry.json.deduplicated).toBe(true);
    expect((retry.json.document as { id: string }).id).toBe(documentId);
    expect(await prisma.documentIngestion.count()).toBe(1);
    expect(audit).toBe(1);
  });
});

describe("C15 — a cloud Compress result becomes the Workspace document", () => {
  it("stores the job's output, not the file that was submitted to it", async () => {
    // The input the user uploaded and the output the job produced are BOTH in
    // storage, which is the situation in which storing the wrong one is possible.
    const input = await makePdf(4, 500, "original");
    const output = await makePdf(4, 500, "compressed");
    expect(sha(input)).not.toBe(sha(output));
    const inputKey = `jobs/in/${sha(input).slice(0, 12)}.pdf`;
    await storage.put(inputKey, input, { contentType: "application/pdf", sha256: sha(input) });

    const job = await completedCompressJob(output);
    const { res, json, requestBytes } = await saveJob(job.id, world.workspaces.home);
    expect(res.status).toBe(201);
    const documentId = (json.document as { id: string }).id;

    const stored = await storedBytes(world.workspaces.home);
    // The output, byte for byte, and the output's own page shape.
    expect(stored.bytes.equals(output)).toBe(true);
    expect(stored.ingestion.checksum).toBe(sha(output));
    expect(await describePdf(stored.bytes)).toEqual({ title: "compressed", pages: 4, sizes: [500, 500, 500, 500] });
    // The input is still in storage where the job left it, and is not the
    // document: `title: "original"` never reached the Workspace.
    expect((await storage.head(inputKey)).exists).toBe(true);
    expect(await prisma.storedFile.count({ where: { sha256: sha(input) } })).toBe(0);
    expect(await prisma.storedFile.count()).toBe(1);

    /*
     * The browser was not the courier. The request that moved a multi-kilobyte PDF
     * into the Workspace carried two ids, the response carries no storage key, and
     * no signed-URL machinery is even resolvable in this process.
     */
    expect(requestBytes).toBeLessThan(output.byteLength);
    expect(JSON.stringify(json)).not.toContain(job.key);
    expect(JSON.stringify(json)).not.toContain(inputKey);

    // Retry: the same document, and no second copy of the result.
    const retry = await saveJob(job.id, world.workspaces.home);
    expect(retry.res.status).toBe(200);
    expect((retry.json.document as { id: string }).id).toBe(documentId);
    expect(await prisma.documentIngestion.count()).toBe(1);
    expect(await prisma.storedFile.count()).toBe(1);
    expect(audit).toBe(1);
  });

  it("keeps two different results apart, so dedup is about content and not about the job", async () => {
    // Same tool, same Workspace, two runs with different results. Content-addressed
    // identity must not collapse them into one document.
    const first = await completedCompressJob(await makePdf(2, 400, "run one"));
    const second = await completedCompressJob(await makePdf(2, 400, "run two"));
    const a = await saveJob(first.id, world.workspaces.home);
    const b = await saveJob(second.id, world.workspaces.home);

    expect([a.res.status, b.res.status]).toEqual([201, 201]);
    expect((a.json.document as { id: string }).id).not.toBe((b.json.document as { id: string }).id);
    const titles = await Promise.all(
      (await prisma.documentIngestion.findMany({ orderBy: { createdAt: "asc" } })).map(
        async (ingestion) => {
          const file = await prisma.storedFile.findUniqueOrThrow({ where: { id: ingestion.storedFileId } });
          return (await describePdf(await storage.get(file.key))).title;
        },
      ),
    );
    expect(titles.sort()).toEqual(["run one", "run two"]);
    expect(audit).toBe(2);
  });
});
