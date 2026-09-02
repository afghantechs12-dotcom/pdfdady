import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

/**
 * C17/C18 — `/api/jobs/:id/save-to-workspace`, end to end.
 *
 * This route has two independent authorizations (the job, then the destination),
 * moves tenant bytes server-to-server, and is idempotent. None of those can be
 * proved by a route test that mocks the things doing the work, so almost nothing
 * is mocked here:
 *
 *  - the job gate is a real `ProcessingJobService` over a real
 *    `InMemoryJobRepository` with an INJECTED CLOCK, so ownership, completion and
 *    expiry are decided by production code rather than by a stub's return value;
 *  - the destination gate is the real `workspaceHttp` (`getWorkspaceActor`,
 *    `mapWorkspaceError`) and the real `WorkspaceAwareUploadService` writing into
 *    real migrated SQLite, so membership, organization scoping, archived state and
 *    the `(workspaceId, checksum)` idempotency are the real ones;
 *  - the bytes are a real `LocalFileStorage` object, so "the stored document is
 *    the job's output" is a byte comparison and not an inference;
 *  - CSRF is the real `requireSameOrigin`.
 *
 * WHAT IS FAKED, and why it is not the subject: `AuthService.getMe` (a token to a
 * user; authentication is tested where it lives), the audit repository (a counter
 * — the assertion is HOW MANY events, which needs a spy), and
 * `ensureWorkerReady`, a lazy background-worker boot that would otherwise pull the
 * queue, the scheduler and every processor into this file.
 *
 * NO SIGNED URL CAN BE MINTED HERE, and the registry proves it rather than
 * asserting it: `Tokens.DownloadService` and `Tokens.SignedUrlService` are never
 * registered, and the fake container throws on an unregistered token. A route
 * that reached for one would fail every test below.
 */

const registry = vi.hoisted(() => new Map<symbol, unknown>());
const cookieState = vi.hoisted(() => ({
  /** The session cookie, for `resolveJobActor`'s signed-in branch. */
  session: null as string | null,
  /** The anonymous job identity cookie. */
  anon: null as string | null,
}));

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
    get: (name: string) => {
      if (name === "pdfdadi_session" && cookieState.session) {
        return { name, value: cookieState.session };
      }
      if (name === "pdfdadi_jid" && cookieState.anon) return { name, value: cookieState.anon };
      return undefined;
    },
    set: () => {},
  }),
}));

vi.mock("@/src/infrastructure/jobs/workerBootstrap", () => ({ ensureWorkerReady: () => {} }));

import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import { WorkspaceService } from "@/src/application/services/WorkspaceService";
import { WorkspaceAwareUploadService } from "@/src/application/services/WorkspaceAwareUploadService";
import {
  ProcessingJobService,
  PROCESSING_JOB_TYPE,
  type ProcessingJobResult,
} from "@/src/application/services/ProcessingJobService";
import {
  PdfToolJobService,
  PDF_TOOL_JOB_TYPE,
  type PdfToolJobResult,
} from "@/src/application/services/PdfToolJobService";
import { InMemoryJobRepository } from "@/src/infrastructure/persistence/InMemoryJobRepository";
import { PrismaWorkspaceRepository } from "@/src/infrastructure/persistence/PrismaWorkspaceRepository";
import { PrismaWorkspaceMembershipRepository } from "@/src/infrastructure/persistence/PrismaWorkspaceMembershipRepository";
import { PrismaDocumentRecordRepository } from "@/src/infrastructure/persistence/PrismaDocumentRecordRepository";
import { PrismaDocumentIngestionRepository } from "@/src/infrastructure/persistence/PrismaDocumentIngestionRepository";
import { PrismaWorkspaceSaveIntentRepository } from "@/src/infrastructure/persistence/PrismaWorkspaceSaveIntentRepository";
import { PrismaStoredFileRepository } from "@/src/infrastructure/persistence/PrismaStoredFileRepository";
import { PrismaFolderRepository } from "@/src/infrastructure/persistence/PrismaFolderRepository";
import { PrismaProjectRepository } from "@/src/infrastructure/persistence/PrismaProjectRepository";
import { LocalOrganizationProvider } from "@/src/infrastructure/auth/LocalOrganizationProvider";
import { LocalRoleProvider } from "@/src/infrastructure/auth/LocalRoleProvider";
import { LocalFileStorage } from "@/src/infrastructure/storage/LocalFileStorage";
import { DOCUMENT_INGESTION_LIMITS } from "@/src/domain/entities/DocumentIngestion";
import type { ILogger, LogFields } from "@/src/application/ports/Logger";
import { POST } from "@/app/api/jobs/[id]/save-to-workspace/route";
import { saveIntentKeyForJob, saveIntentKeyForTarget } from "@/lib/workflow/saveIntent";

const root = process.cwd();
const prismaExecutable = path.join(root, "node_modules", "prisma", "build", "index.js");
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "pdfdadi-job-save-route-"));
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
let clock: Date;
let audit: Array<{ action: string; resourceId?: string | null; metadata?: unknown }>;
let world: Awaited<ReturnType<typeof seed>>;

/**
 * The result bytes a completed cloud job left in PDFDadi's own storage.
 *
 * Padded to a few KB so the byte-relay assertion below stays an argument rather
 * than an accident: the request body carries two ids and a save-intent key, which
 * is a couple of hundred bytes, and "the request was smaller than the PDF" only
 * means anything while the PDF is comfortably the larger of the two.
 */
const OUTPUT = Buffer.from(
  `%PDF-1.7\n% compressed cloud result\n% ${"pad ".repeat(1024)}\ntrailer\n<< >>\n%%EOF\n`,
);
const NOT_A_PDF = Buffer.from("PK zip of images");

function post(
  id: string,
  body: unknown,
  opts: { origin?: string | null; contentType?: string | null; session?: string | null } = {},
) {
  const headers = new Headers();
  if (opts.origin !== null) headers.set("origin", opts.origin ?? ORIGIN);
  if (opts.contentType !== null) headers.set("content-type", opts.contentType ?? "application/json");
  const token = opts.session === undefined ? cookieState.session : opts.session;
  if (token) headers.set("cookie", `pdfdadi_session=${token}`);
  const payload = typeof body === "string" ? body : JSON.stringify(withSaveIntent(id, body));
  const request = new NextRequest(`${ORIGIN}/api/jobs/${id}/save-to-workspace`, {
    method: "POST",
    headers,
    body: payload,
  });
  return {
    request,
    /** What the browser actually sent — the byte-relay assertion reads this. */
    requestBytes: Buffer.byteLength(payload),
    params: Promise.resolve({ id }),
  };
}

/**
 * What `saveJobResultToWorkspace` actually sends, so these tests exercise the
 * request the product makes: the save INTENTION, per job and per destination.
 *
 * Injected here rather than at each call site because it is not the subject of any
 * one test — it is the shape of every real request. A body that names no Workspace
 * (the malformed-body cases) is left exactly as written.
 */
function withSaveIntent(id: string, body: unknown): unknown {
  if (body === null || typeof body !== "object") return body;
  const named = body as { workspaceId?: unknown; saveIntentKey?: unknown };
  if (typeof named.workspaceId !== "string") return body;
  if ("saveIntentKey" in named) return body;
  return {
    ...named,
    saveIntentKey: saveIntentKeyForTarget(saveIntentKeyForJob(id), named.workspaceId),
  };
}

async function call(...args: Parameters<typeof post>) {
  const { request, params, requestBytes } = post(...args);
  const res = await POST(request, { params });
  const text = await res.text();
  return {
    res,
    requestBytes,
    json: (text ? JSON.parse(text) : null) as Record<string, unknown> | null,
  };
}

/** Puts the job's output where a completed cloud run would have left it. */
async function storeOutput(data: Buffer) {
  const sha256 = crypto.createHash("sha256").update(data).digest("hex");
  const key = `jobs/out/${sha256.slice(0, 12)}.bin`;
  await storage.put(key, data, { contentType: "application/pdf", sha256 });
  return { key, sha256 };
}

interface JobOptions {
  owner?: { ownerType: "user" | "anon"; ownerId: string };
  status?: "completed" | "running" | "failed" | "expired";
  data?: Buffer;
  mimeType?: string;
  bytes?: number;
  expiresAt?: Date | null;
  downloadName?: string;
  omitResult?: boolean;
}

/** A finished server job whose result is sitting in PDFDadi's own storage. */
async function makeJob(options: JobOptions = {}) {
  const owner = options.owner ?? { ownerType: "user" as const, ownerId: world.users.saver };
  const data = options.data ?? OUTPUT;
  const { key } = await storeOutput(data);
  const job = await jobs.create({
    type: PROCESSING_JOB_TYPE,
    payload: { toolSlug: "compress-pdf" },
    status: options.status ?? "completed",
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    toolSlug: "compress-pdf",
    expiresAt: options.expiresAt === undefined ? new Date(clock.getTime() + 3_600_000) : options.expiresAt,
  });
  if (!options.omitResult) {
    const result: ProcessingJobResult = {
      output: {
        key,
        fileId: "job-output-file",
        downloadName: options.downloadName ?? "compressed.pdf",
        mimeType: options.mimeType ?? "application/pdf",
        bytes: options.bytes ?? data.byteLength,
      },
    };
    await jobs.update(job.id, { result });
  }
  return { id: job.id, key, data };
}


/**
 * A finished LEGACY (`pdf-tool`) job — the shape every server tool but the
 * pipeline pilot produces. Same storage, same owner, same recorded output; only
 * `type` and the result's field names differ.
 */
async function makeLegacyJob(options: JobOptions = {}) {
  const owner = options.owner ?? { ownerType: "user" as const, ownerId: world.users.saver };
  const data = options.data ?? OUTPUT;
  const { key } = await storeOutput(data);
  const job = await jobs.create({
    type: PDF_TOOL_JOB_TYPE,
    payload: { slug: "rotate-pdf" },
    status: options.status ?? "completed",
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    toolSlug: "rotate-pdf",
  });
  if (!options.omitResult) {
    const result: PdfToolJobResult = {
      outputFileId: "legacy-output-file",
      outputKey: key,
      downloadName: options.downloadName ?? "rotated.pdf",
      mimeType: options.mimeType ?? "application/pdf",
      originalSize: data.byteLength,
      resultSize: options.bytes ?? data.byteLength,
    };
    await jobs.update(job.id, { result });
  }
  return { id: job.id, key, data };
}

async function seed() {
  const user = async (email: string) => {
    const row = await prisma.user.create({
      data: { email, provider: "local", passwordHash: "s:h" },
    });
    return row.id;
  };
  const saver = await user("saver@example.test");
  const outsider = await user("outsider@example.test");

  const alpha = await prisma.organization.create({
    data: { name: "Alpha", slug: "alpha", plan: "free" },
  });
  const beta = await prisma.organization.create({
    data: { name: "Beta", slug: "beta", plan: "free" },
  });
  for (const [org, who] of [
    [alpha.id, saver],
    [beta.id, outsider],
  ] as const) {
    await prisma.organizationMembership.create({
      data: { organizationId: org, userId: who, role: "member" },
    });
  }

  const workspace = async (organizationId: string, name: string, createdById: string, lifecycleState = "active") => {
    const slug = `${name.toLowerCase()}-${organizationId.slice(-4)}`;
    const row = await prisma.workspace.create({
      data: {
        organizationId,
        name,
        normalizedName: name.toLowerCase(),
        slug,
        normalizedSlug: slug,
        createdById,
        lifecycleState,
      },
    });
    return row.id;
  };
  const home = await workspace(alpha.id, "Home", saver);
  // A SECOND authorized destination, so "one save intention" can be proved to be
  // scoped to a destination rather than to the job.
  const team = await workspace(alpha.id, "Team", saver);
  const archived = await workspace(alpha.id, "Archive", saver, "archived");
  const nobodys = await workspace(alpha.id, "Private", saver);
  const otherTenant = await workspace(beta.id, "Beeswax", outsider);
  for (const id of [home, team, archived]) {
    await prisma.workspaceMembership.create({
      data: { workspaceId: id, userId: saver, role: "editor", createdById: saver },
    });
  }
  await prisma.organization.update({
    where: { id: alpha.id },
    data: { defaultWorkspaceId: home },
  });

  return {
    users: { saver, outsider },
    orgs: { alpha: alpha.id, beta: beta.id },
    workspaces: { home, team, archived, nobodys, otherTenant },
  };
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
  const logger = new SilentLogger();
  const workspaces = new WorkspaceService(
    prisma,
    new PrismaWorkspaceRepository(prisma),
    new PrismaWorkspaceMembershipRepository(prisma),
  );

  registry.set(Tokens.AuthService, {
    getMe: async (token: string) =>
      token === `tok-${world.users.saver}`
        ? { id: world.users.saver }
        : token === `tok-${world.users.outsider}`
          ? { id: world.users.outsider }
          : null,
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
      logger,
      workspaces,
      new PrismaDocumentRecordRepository(prisma),
      new PrismaFolderRepository(prisma),
      new PrismaProjectRepository(prisma),
      new PrismaDocumentIngestionRepository(prisma),
      new PrismaWorkspaceSaveIntentRepository(prisma),
    ),
  );
  registry.set(Tokens.AuditLogRepository, {
    record: async (input: { action: string; resourceId?: string | null; metadata?: unknown }) => {
      audit.push(input);
      return { id: `audit-${audit.length}` };
    },
    listByOrg: async () => [],
  });
  // Resolved by `workspaceServices()` and unused by this route. Registered as
  // present-but-empty so an accidental new call site fails loudly rather than
  // silently reaching a stub that answers.
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
  world = await seed();
  jobs = new InMemoryJobRepository();
  clock = new Date("2026-09-01T12:00:00.000Z");
  audit = [];
  registry.set(Tokens.JobRepository, jobs);
  registry.set(
    Tokens.ProcessingJobService,
    new ProcessingJobService({
      jobRepo: jobs,
      queue: {} as never,
      worker: {} as never,
      logger: new SilentLogger(),
      // Injected clock: expiry is a decision about time, and a test that waits
      // for a TTL is a test that is slow and flaky at once.
      now: () => clock,
    }),
  );
  /*
   * The LEGACY service, and the real one: `getStatus` reads the same job
   * repository the route's own `loadJobRow` reads, so the legacy branch's
   * completion check is production code over production data. Its queue and
   * worker are unused by `getStatus` and are not this file's subject.
   */
  registry.set(Tokens.PdfToolJobService, new PdfToolJobService({} as never, jobs, {} as never));
  cookieState.session = `tok-${world.users.saver}`;
  cookieState.anon = null;
});

/** The Workspace document this save produced, read back from the database. */
async function storedDocument(workspaceId: string) {
  const ingestion = await prisma.documentIngestion.findFirst({ where: { workspaceId } });
  if (!ingestion) return null;
  const file = await prisma.storedFile.findUnique({ where: { id: ingestion.storedFileId } });
  const document = await prisma.documentRecord.findUnique({ where: { id: ingestion.documentId } });
  return { ingestion, file, document, bytes: file ? await storage.get(file.key) : null };
}

describe("POST /api/jobs/:id/save-to-workspace — the gates", () => {
  it("refuses a request with no same-origin evidence, and one from another origin", async () => {
    const job = await makeJob();
    const missing = await call(job.id, { workspaceId: world.workspaces.home }, { origin: null });
    expect(missing.res.status).toBe(403);
    expect((missing.json?.error as { code: string }).code).toBe("CSRF_ORIGIN_REQUIRED");

    const foreign = await call(
      job.id,
      { workspaceId: world.workspaces.home },
      { origin: "https://evil.example" },
    );
    expect(foreign.res.status).toBe(403);
    expect((foreign.json?.error as { code: string }).code).toBe("CSRF_ORIGIN_REJECTED");
    // A refused request is a request that did nothing.
    expect(await prisma.documentRecord.count()).toBe(0);
  });

  it("rejects a body that is not JSON, and JSON that names no Workspace", async () => {
    const job = await makeJob();
    const wrongType = await call(job.id, "workspaceId=home", { contentType: "text/plain" });
    expect(wrongType.res.status).toBe(415);

    const malformed = await call(job.id, "{not json", {});
    expect(malformed.res.status).toBe(422);
    expect((malformed.json?.error as { code: string }).code).toBe("INVALID_INPUT");

    const empty = await call(job.id, { workspaceId: "   " }, {});
    expect(empty.res.status).toBe(422);
    expect(await prisma.documentRecord.count()).toBe(0);
  });

  it("answers a job that is not yours exactly as it answers a job that does not exist", async () => {
    const mine = await makeJob();
    const theirs = await makeJob({
      owner: { ownerType: "user", ownerId: world.users.outsider },
    });
    const unknown = await call("job_does_not_exist", { workspaceId: world.workspaces.home });
    const foreign = await call(theirs.id, { workspaceId: world.workspaces.home });

    expect(unknown.res.status).toBe(404);
    expect(foreign.res.status).toBe(404);
    // Byte-identical bodies: a valid session plus a guessed id learns nothing,
    // not even whether the id is real.
    expect(foreign.json).toEqual(unknown.json);
    expect(foreign.json).toEqual({ error: "Job not found." });
    // And the one job that IS theirs is untouched by the probing.
    expect(await prisma.documentIngestion.count()).toBe(0);
    expect(mine.id).not.toBe(theirs.id);
  });

  it("does not let a signed-in actor claim an anonymous visitor's result", async () => {
    const anonymous = await makeJob({
      owner: { ownerType: "anon", ownerId: "11111111-2222-3333-4444-555555555555" },
    });
    // The session is valid and the Workspace is the user's own. The job is not.
    const res = await call(anonymous.id, { workspaceId: world.workspaces.home });
    expect(res.res.status).toBe(404);
    expect(res.json).toEqual({ error: "Job not found." });
    expect(await prisma.documentRecord.count()).toBe(0);
  });

  it("recognises the anonymous owner of a job, and then asks them to sign in", async () => {
    const anonId = "11111111-2222-3333-4444-555555555555";
    const job = await makeJob({ owner: { ownerType: "anon", ownerId: anonId } });
    cookieState.session = null;
    cookieState.anon = anonId;
    const res = await call(job.id, { workspaceId: world.workspaces.home }, { session: null });
    // The job gate passes — this really is their result — and the DESTINATION gate
    // is the one that refuses, because a guest has no Workspace. Two independent
    // authorizations, and passing one does not grant the other.
    expect(res.res.status).toBe(401);
    expect((res.json?.error as { code: string }).code).toBe("UNAUTHORIZED");
  });

  it("refuses a result that has not finished, and one that has expired", async () => {
    const running = await makeJob({ status: "running" });
    const notReady = await call(running.id, { workspaceId: world.workspaces.home });
    expect(notReady.res.status).toBe(409);
    expect(notReady.json?.reason).toBe("not_ready");

    const stale = await makeJob({ expiresAt: new Date(clock.getTime() - 1_000) });
    const expired = await call(stale.id, { workspaceId: world.workspaces.home });
    expect(expired.res.status).toBe(409);
    expect(expired.json?.reason).toBe("expired");

    const empty = await makeJob({ omitResult: true });
    const noResult = await call(empty.id, { workspaceId: world.workspaces.home });
    expect(noResult.res.status).toBe(409);
    expect(noResult.json?.reason).toBe("no_result");
    expect(await prisma.documentRecord.count()).toBe(0);
  });

  it("refuses a result that is not a PDF, and one too large to store", async () => {
    const zip = await makeJob({ data: NOT_A_PDF, mimeType: "application/zip", downloadName: "pages.zip" });
    const unsupported = await call(zip.id, { workspaceId: world.workspaces.home });
    expect(unsupported.res.status).toBe(415);
    expect((unsupported.json?.error as { code: string }).code).toBe("UNSUPPORTED_OUTPUT");

    // The size gate reads the job's recorded output size, so it refuses before
    // any bytes are moved rather than after.
    const huge = await makeJob({ bytes: DOCUMENT_INGESTION_LIMITS.maxUploadBytes + 1 });
    const tooLarge = await call(huge.id, { workspaceId: world.workspaces.home });
    expect(tooLarge.res.status).toBe(413);
    expect((tooLarge.json?.error as { code: string }).code).toBe("PAYLOAD_TOO_LARGE");
    expect(await prisma.documentRecord.count()).toBe(0);
  });

  it("refuses a Workspace the actor is not a member of, a foreign tenant's, and an archived one", async () => {
    const job = await makeJob();
    const nobodys = await call(job.id, { workspaceId: world.workspaces.nobodys });
    // Not a member: the same 404 "Workspace not found." a nonexistent id gets.
    expect(nobodys.res.status).toBe(404);
    const unknown = await call(job.id, { workspaceId: "wks_nope" });
    expect(unknown.json).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: (nobodys.json?.error as { code: string }).code }),
      }),
    );

    // Another tenant's Workspace, named together with its own organization id: the
    // actor is not a member of that organization, so the actor resolution refuses.
    const crossOrg = await call(job.id, {
      workspaceId: world.workspaces.otherTenant,
      organizationId: world.orgs.beta,
    });
    expect(crossOrg.res.status).toBe(403);
    // And named alone, it is simply not in the actor's organization.
    const crossOrgQuiet = await call(job.id, { workspaceId: world.workspaces.otherTenant });
    expect(crossOrgQuiet.res.status).toBe(404);

    // Archived: a member, and the write is still refused.
    const archived = await call(job.id, { workspaceId: world.workspaces.archived });
    expect(archived.res.status).toBe(409);
    expect(await prisma.documentRecord.count()).toBe(0);
  });
});

describe("POST /api/jobs/:id/save-to-workspace — the save", () => {
  it("stores the job's own output bytes, and never asks the browser for them", async () => {
    const job = await makeJob();
    const { res, json, requestBytes } = await call(job.id, { workspaceId: world.workspaces.home });

    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(json?.deduplicated).toBe(false);
    const documentId = (json?.document as { id: string }).id;
    expect(documentId).toBeTruthy();

    const stored = await storedDocument(world.workspaces.home);
    // The canonical id in the response IS the row that exists.
    expect(stored?.document?.id).toBe(documentId);
    expect(stored?.ingestion.documentId).toBe(documentId);
    // Byte fidelity: what is in the Workspace is the job's output, not a
    // re-encode, not the input, not a stale handoff buffer.
    expect(stored?.bytes?.equals(job.data)).toBe(true);
    expect(stored?.file?.size).toBe(job.data.byteLength);
    expect(stored?.document?.name).toBe("compressed.pdf");

    /*
     * NOT A BYTE RELAY. The request that caused a 76-byte PDF to be stored was
     * itself smaller than that PDF and contained only an id — so the bytes cannot
     * have come from the browser. And the only other way to reach them from a
     * browser is a signed URL, which cannot exist here: resolving either token
     * throws, because neither is registered.
     */
    expect(requestBytes).toBeLessThan(job.data.byteLength);
    expect(JSON.stringify(json)).not.toContain(job.key);
    for (const token of [Tokens.DownloadService, Tokens.SignedUrlService]) {
      expect(() => appContainer.resolve(token)).toThrow(/Unregistered token/);
    }

    // One event for one save, carrying the tool and the name — no PDF content.
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "document.upload", resourceId: documentId });
    expect(JSON.stringify(audit[0].metadata)).toBe(
      JSON.stringify({ documentName: "compressed.pdf", toolSlug: "compress-pdf" }),
    );
  });

  it("answers a retry with the first document, one version, and no second event", async () => {
    const job = await makeJob();
    const first = await call(job.id, { workspaceId: world.workspaces.home });
    const before = await storedDocument(world.workspaces.home);
    const stat = statSync(path.join(temporaryDirectory, "objects", before!.file!.key));

    // The response to the first request was lost; the page is remounted and the
    // user presses Save again. Same request, again.
    const retry = await call(job.id, { workspaceId: world.workspaces.home });

    expect(first.res.status).toBe(201);
    expect(retry.res.status).toBe(200);
    expect(retry.json?.deduplicated).toBe(true);
    expect((retry.json?.document as { id: string }).id).toBe(
      (first.json?.document as { id: string }).id,
    );
    expect(await prisma.documentRecord.count()).toBe(1);
    expect(await prisma.documentIngestion.count()).toBe(1);
    expect(await prisma.storedFile.count()).toBe(1);
    // One activity line about one document, not two.
    expect(audit).toHaveLength(1);
    // And the stored object was not rewritten: same inode, same size, same mtime.
    const after = statSync(path.join(temporaryDirectory, "objects", before!.file!.key));
    expect([after.ino, after.size, after.mtimeMs]).toEqual([stat.ino, stat.size, stat.mtimeMs]);
  });

  it("converges on one document when two requests arrive at once", async () => {
    const job = await makeJob();
    const [a, b] = await Promise.all([
      call(job.id, { workspaceId: world.workspaces.home }),
      call(job.id, { workspaceId: world.workspaces.home }),
    ]);
    // One of them created it and one of them found it — which is a race, so it is
    // not asserted. What is asserted is that they agree on the answer.
    expect([a.res.status, b.res.status].sort()).toEqual([200, 201]);
    expect((a.json?.document as { id: string }).id).toBe((b.json?.document as { id: string }).id);
    // The loser never creates a row at all: the intention's unique index refuses
    // its claim, so it polls and converges on the winner's document.
    expect(await prisma.documentRecord.count({ where: { lifecycleState: { not: "trashed" } } })).toBe(1);
    expect(await prisma.documentIngestion.count()).toBe(1);
    expect(audit).toHaveLength(1);
    // The loser must not have deleted the winner's content-addressed object.
    const stored = await storedDocument(world.workspaces.home);
    expect(stored?.bytes?.equals(job.data)).toBe(true);
  });

  it("does not let the authorization for one destination serve another", async () => {
    const job = await makeJob();
    const home = await call(job.id, { workspaceId: world.workspaces.home });
    const team = await call(job.id, { workspaceId: world.workspaces.team });

    // Same job, same bytes, two Workspaces the actor may save into: two documents.
    // Two destinations are two intentions, so the client narrows the job's key to
    // each — and the server would refuse one key arriving with a second
    // destination, so a save cannot be replayed into a Workspace the first request
    // was never authorized for.
    expect(team.res.status).toBe(201);
    expect(team.json?.deduplicated).toBe(false);
    expect((team.json?.document as { id: string }).id).not.toBe(
      (home.json?.document as { id: string }).id,
    );
    expect(await prisma.documentIngestion.count()).toBe(2);
    expect(audit).toHaveLength(2);

    // A destination the actor may NOT save into is still refused after a
    // successful save of the same result elsewhere.
    const refused = await call(job.id, { workspaceId: world.workspaces.nobodys });
    expect(refused.res.status).toBe(404);
    expect(await prisma.documentIngestion.count()).toBe(2);
  });

  it("leaves nothing behind when the transfer fails after every check passed", async () => {
    const job = await makeJob();
    // The result row says the output is there; the object is gone. Every gate
    // above passes and the storage read is what fails.
    await storage.delete(job.key);
    const res = await call(job.id, { workspaceId: world.workspaces.home });

    expect(res.res.status).toBe(500);
    expect((res.json?.error as { code: string }).code).toBe("INTERNAL_ERROR");
    // No document, no ingestion row, no activity line: a failed save is not a
    // save, and nothing recorded here can make a later retry a no-op.
    expect(await prisma.documentRecord.count()).toBe(0);
    expect(await prisma.documentIngestion.count()).toBe(0);
    expect(audit).toHaveLength(0);

    // And it is still retryable once the object is back.
    await storage.put(job.key, job.data, { contentType: "application/pdf" });
    const retry = await call(job.id, { workspaceId: world.workspaces.home });
    expect(retry.res.status).toBe(201);
    expect(await prisma.documentRecord.count()).toBe(1);
  });

  it("records the result as one pending ingestion, and cuts no version itself", async () => {
    const job = await makeJob();
    await call(job.id, { workspaceId: world.workspaces.home });
    const ingestion = await prisma.documentIngestion.findFirstOrThrow();

    // The ingestion row is the durable description of what was stored, and it
    // describes the JOB'S output: its checksum, its size, its type, its name.
    expect(ingestion.checksum).toBe(crypto.createHash("sha256").update(job.data).digest("hex"));
    expect(ingestion.byteSize).toBe(job.data.byteLength);
    expect(ingestion.mimeType).toBe("application/pdf");
    expect(ingestion.originalName).toBe("compressed.pdf");
    expect(ingestion.status).toBe("pending");
    // And the initial version is the ingestion worker's job, not this route's —
    // the accepted first-save polling debt, pinned so it cannot silently change
    // into "the save route cuts a version" without this failing.
    expect(await prisma.documentVersion.count()).toBe(0);
  });
});

/**
 * R2 — the LEGACY (`pdf-tool`) result shape, which is what `ServerToolRunner`
 * produces for every server tool that is not the pipeline pilot.
 *
 * WHY THIS BLOCK EXISTS AT ALL. `ServerToolRunner` renders `Save to Workspace`
 * and posts here, and this route used to answer `404 "Job not found."` to every
 * row whose `type` was not `processing` — so the button was offered on eleven
 * tools and could not succeed on any of them in the shipped default
 * configuration (`isProcessingPipelineEnabled` is false for every slug but
 * `compress-pdf`, and false for that one too unless a flag row or
 * `PROCESSING_PIPELINE` says otherwise, which no deployment file sets). Every
 * test above used the pipeline shape, which is exactly why a full-green suite
 * did not notice.
 *
 * These are the same four questions the pipeline tests ask, asked of the other
 * shape: does it save, is it still MY job, is it finished, and is it a PDF. They
 * drive the route, not a source scan — the assertion is the response and the
 * bytes in the database.
 */
describe("POST /api/jobs/:id/save-to-workspace — a legacy server-tool result", () => {
  it("stores a completed legacy job's own output bytes", async () => {
    const job = await makeLegacyJob();
    const { res, json, requestBytes } = await call(job.id, {
      workspaceId: world.workspaces.home,
    });

    expect(res.status).toBe(201);
    expect((json?.document as { id: string }).id).toEqual(expect.any(String));

    const stored = await storedDocument(world.workspaces.home);
    // The bytes are the job's, and they came from storage: the request that
    // asked for the save was two orders of magnitude smaller than the PDF.
    expect(stored?.bytes?.equals(job.data)).toBe(true);
    expect(requestBytes).toBeLessThan(job.data.byteLength);
    // Named the way the download names it, so the two agree.
    expect(stored?.document?.name).toBe("rotated.pdf");
    expect(stored?.ingestion.checksum).toBe(
      crypto.createHash("sha256").update(job.data).digest("hex"),
    );
    // One activity line, and it names the tool that produced the result.
    expect(audit).toHaveLength(1);
    expect((audit[0].metadata as { toolSlug: string }).toolSlug).toBe("rotate-pdf");
  });

  it("answers a legacy job that is not yours exactly as it answers an unknown one", async () => {
    const stranger = await makeLegacyJob({
      owner: { ownerType: "user", ownerId: world.users.outsider },
    });
    const notMine = await call(stranger.id, { workspaceId: world.workspaces.home });
    const unknown = await call("job_does_not_exist", { workspaceId: world.workspaces.home });

    expect(notMine.res.status).toBe(404);
    // Indistinguishable, so the endpoint is not an existence oracle for the
    // legacy shape either.
    expect(notMine.json).toEqual(unknown.json);
    expect(await prisma.documentRecord.count()).toBe(0);
    expect(audit).toHaveLength(0);
  });

  it("refuses a legacy job that has not finished, and one with no recorded output", async () => {
    const running = await makeLegacyJob({ status: "running", omitResult: true });
    const unfinished = await call(running.id, { workspaceId: world.workspaces.home });
    expect(unfinished.res.status).toBe(409);
    // The same words the legacy download answers, so a client polling one
    // endpoint and saving through the other reads one story.
    expect(unfinished.json?.error).toBe("Job output is not available.");
    expect(unfinished.json?.status).toBe("running");

    const empty = await makeLegacyJob({ omitResult: true });
    expect((await call(empty.id, { workspaceId: world.workspaces.home })).res.status).toBe(409);
    expect(await prisma.documentRecord.count()).toBe(0);
  });

  it("refuses a legacy result that is not a PDF, and one too large to store", async () => {
    const zip = await makeLegacyJob({
      data: NOT_A_PDF,
      mimeType: "application/zip",
      downloadName: "pages.zip",
    });
    const unsupported = await call(zip.id, { workspaceId: world.workspaces.home });
    expect(unsupported.res.status).toBe(415);
    expect((unsupported.json?.error as { code: string }).code).toBe("UNSUPPORTED_OUTPUT");

    const huge = await makeLegacyJob({ bytes: DOCUMENT_INGESTION_LIMITS.maxUploadBytes + 1 });
    const tooLarge = await call(huge.id, { workspaceId: world.workspaces.home });
    expect(tooLarge.res.status).toBe(413);
    expect(await prisma.documentRecord.count()).toBe(0);
  });

  it("answers a retry with the first document, and adds no second event", async () => {
    const job = await makeLegacyJob();
    const first = await call(job.id, { workspaceId: world.workspaces.home });
    const again = await call(job.id, { workspaceId: world.workspaces.home });

    expect(first.res.status).toBe(201);
    expect(again.res.status).toBe(200);
    expect((again.json?.document as { id: string }).id).toBe(
      (first.json?.document as { id: string }).id,
    );
    expect(again.json?.deduplicated).toBe(true);
    expect(await prisma.documentRecord.count()).toBe(1);
    expect(audit).toHaveLength(1);
  });
});
