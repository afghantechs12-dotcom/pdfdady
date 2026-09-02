import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

/**
 * C19 — `/api/workspaces/:workspaceId/documents/:documentId/opened`, end to end.
 *
 * This route exists to write ONE column and nothing else, so what has to be
 * proved is mostly a set of absences: no version, no revision bump, no content
 * change. An absence cannot be proved against a mock — a stubbed repository has
 * no revision to leave alone and no version table to leave empty — so the
 * document side here is real: the real `DocumentRecordService` over the real
 * `PrismaDocumentRecordRepository` and real migrated SQLite, and the row is read
 * back with a second Prisma client-independent query after every call.
 *
 * The complement is proved through the neighbouring READ routes rather than by
 * reasoning about them: the document GET and the Workspace document list are the
 * two things a page fires on its way to an open, and they run here against the
 * same row to show that neither of them advances `lastAccessedAt`. That is the
 * whole reason this route exists instead of a write inside the content GET.
 *
 * FAKED: `AuthService.getMe` (a token to a user), and the audit repository as a
 * counter — an open is deliberately not an audit event, and a counter is how you
 * assert "none".
 */

const registry = vi.hoisted(() => new Map<symbol, unknown>());
const session = vi.hoisted(() => ({ token: null as string | null }));

vi.mock("@/src/application/di/container", () => ({
  appContainer: {
    resolve: (token: symbol) => {
      const found = registry.get(token);
      if (!found) throw new Error(`Unregistered token in test: ${String(token)}`);
      return found;
    },
  },
}));

import { Tokens } from "@/src/application/di/tokens";
import { WorkspaceService } from "@/src/application/services/WorkspaceService";
import { DocumentRecordService } from "@/src/application/services/DocumentRecordService";
import { PrismaWorkspaceRepository } from "@/src/infrastructure/persistence/PrismaWorkspaceRepository";
import { PrismaWorkspaceMembershipRepository } from "@/src/infrastructure/persistence/PrismaWorkspaceMembershipRepository";
import { PrismaDocumentRecordRepository } from "@/src/infrastructure/persistence/PrismaDocumentRecordRepository";
import { PrismaFolderRepository } from "@/src/infrastructure/persistence/PrismaFolderRepository";
import { PrismaProjectRepository } from "@/src/infrastructure/persistence/PrismaProjectRepository";
import { LocalOrganizationProvider } from "@/src/infrastructure/auth/LocalOrganizationProvider";
import { LocalRoleProvider } from "@/src/infrastructure/auth/LocalRoleProvider";
import { POST as OPENED } from "@/app/api/workspaces/[workspaceId]/documents/[documentId]/opened/route";
import { GET as DOCUMENT } from "@/app/api/workspaces/[workspaceId]/documents/[documentId]/route";
import { GET as DOCUMENT_LIST } from "@/app/api/workspaces/[workspaceId]/documents/route";

const root = process.cwd();
const prismaExecutable = path.join(root, "node_modules", "prisma", "build", "index.js");
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "pdfdadi-opened-route-"));
const databaseUrl = `file:${path.join(temporaryDirectory, "route.db").replaceAll("\\", "/")}`;
const ORIGIN = "http://localhost:3001";

let prisma: PrismaClient;
let audit: string[];
let world: Awaited<ReturnType<typeof seed>>;

function opened(
  workspaceId: string,
  documentId: string,
  body: unknown,
  opts: { origin?: string | null; session?: string | null } = {},
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.origin !== null) headers.set("origin", opts.origin ?? ORIGIN);
  const token = opts.session === undefined ? session.token : opts.session;
  if (token) headers.set("cookie", `pdfdadi_session=${token}`);
  const request = new NextRequest(
    `${ORIGIN}/api/workspaces/${workspaceId}/documents/${documentId}/opened`,
    { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) },
  );
  return { request, params: Promise.resolve({ workspaceId, documentId }) };
}

async function open(...args: Parameters<typeof opened>) {
  const { request, params } = opened(...args);
  const res = await OPENED(request, { params });
  const text = await res.text();
  return { res, json: (text ? JSON.parse(text) : null) as Record<string, unknown> | null };
}

/** A signed-in GET, the way the page loads a document on its way to opening it. */
function get(url: string) {
  const headers = new Headers();
  if (session.token) headers.set("cookie", `pdfdadi_session=${session.token}`);
  return new NextRequest(`${ORIGIN}${url}`, { headers });
}

/** The document row as the database holds it — never as a service reported it. */
function row(documentId: string) {
  return prisma.documentRecord.findUniqueOrThrow({ where: { id: documentId } });
}

async function makeDocument(workspaceId: string, organizationId: string, name: string) {
  const file = await prisma.storedFile.create({
    data: {
      ownerType: "org",
      ownerId: organizationId,
      key: `ca/aa/bb/${crypto.randomUUID()}`,
      sha256: crypto.createHash("sha256").update(name).digest("hex"),
      size: 42,
      mimeType: "application/pdf",
      originalName: name,
    },
  });
  const document = await prisma.documentRecord.create({
    data: {
      workspaceId,
      organizationId,
      name,
      normalizedName: name.toLowerCase(),
      orderKey: "a0",
      createdById: world?.users.member ?? "seed",
    },
  });
  await prisma.documentIngestion.create({
    data: {
      workspaceId,
      organizationId,
      documentId: document.id,
      storedFileId: file.id,
      status: "ready",
      checksum: file.sha256!,
      byteSize: file.size,
      mimeType: file.mimeType,
      originalName: name,
      uploadedById: document.createdById,
    },
  });
  return document.id;
}

async function seed() {
  const user = async (email: string) => {
    const created = await prisma.user.create({
      data: { email, provider: "local", passwordHash: "s:h" },
    });
    return created.id;
  };
  const member = await user("member@example.test");
  const outsider = await user("outsider@example.test");

  const alpha = await prisma.organization.create({
    data: { name: "Alpha", slug: "alpha", plan: "free" },
  });
  const beta = await prisma.organization.create({
    data: { name: "Beta", slug: "beta", plan: "free" },
  });
  for (const [org, who] of [
    [alpha.id, member],
    [beta.id, outsider],
  ] as const) {
    await prisma.organizationMembership.create({
      data: { organizationId: org, userId: who, role: "member" },
    });
  }

  const workspace = async (organizationId: string, name: string, createdById: string, lifecycleState = "active") => {
    const slug = `${name.toLowerCase()}-${organizationId.slice(-4)}`;
    const created = await prisma.workspace.create({
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
    return created.id;
  };
  const home = await workspace(alpha.id, "Home", member);
  const other = await workspace(alpha.id, "Other", member);
  const archived = await workspace(alpha.id, "Archive", member, "archived");
  const otherTenant = await workspace(beta.id, "Beeswax", outsider);
  for (const id of [home, other, archived]) {
    await prisma.workspaceMembership.create({
      data: { workspaceId: id, userId: member, role: "viewer", createdById: member },
    });
  }
  await prisma.workspaceMembership.create({
    data: { workspaceId: otherTenant, userId: outsider, role: "editor", createdById: outsider },
  });

  return {
    users: { member, outsider },
    orgs: { alpha: alpha.id, beta: beta.id },
    workspaces: { home, other, archived, otherTenant },
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
  const workspaces = new WorkspaceService(
    prisma,
    new PrismaWorkspaceRepository(prisma),
    new PrismaWorkspaceMembershipRepository(prisma),
  );
  registry.set(Tokens.AuthService, {
    getMe: async (token: string) =>
      token === `tok-${world.users.member}`
        ? { id: world.users.member }
        : token === `tok-${world.users.outsider}`
          ? { id: world.users.outsider }
          : null,
  });
  registry.set(Tokens.OrganizationProvider, new LocalOrganizationProvider(prisma));
  registry.set(Tokens.RoleProvider, new LocalRoleProvider(prisma));
  registry.set(Tokens.WorkspaceService, workspaces);
  registry.set(
    Tokens.DocumentRecordService,
    new DocumentRecordService(
      new PrismaDocumentRecordRepository(prisma),
      new PrismaFolderRepository(prisma),
      new PrismaProjectRepository(prisma),
      workspaces,
    ),
  );
  registry.set(Tokens.AuditLogRepository, {
    record: async (input: { action: string }) => {
      audit.push(input.action);
      return { id: `audit-${audit.length}` };
    },
    listByOrg: async () => [],
  });
  // Resolved eagerly by `workspaceServices()` and unused by these routes.
  for (const token of [Tokens.WorkspaceMembershipService, Tokens.ProjectService, Tokens.FolderService]) {
    registry.set(token, {});
  }
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.documentIngestion.deleteMany();
  await prisma.documentVersion.deleteMany();
  await prisma.documentRecord.deleteMany();
  await prisma.storedFile.deleteMany();
  await prisma.workspaceMembership.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.organizationMembership.deleteMany();
  await prisma.organization.deleteMany();
  await prisma.user.deleteMany();
  world = await seed();
  audit = [];
  session.token = `tok-${world.users.member}`;
});

describe("POST …/documents/:documentId/opened — the gates", () => {
  it("refuses a request with no same-origin evidence, and one from another origin", async () => {
    const documentId = await makeDocument(world.workspaces.home, world.orgs.alpha, "Brief.pdf");
    const missing = await open(world.workspaces.home, documentId, { organizationId: world.orgs.alpha }, { origin: null });
    expect(missing.res.status).toBe(403);
    expect((missing.json?.error as { code: string }).code).toBe("CSRF_ORIGIN_REQUIRED");

    const foreign = await open(
      world.workspaces.home,
      documentId,
      { organizationId: world.orgs.alpha },
      { origin: "https://evil.example" },
    );
    expect(foreign.res.status).toBe(403);
    expect((foreign.json?.error as { code: string }).code).toBe("CSRF_ORIGIN_REJECTED");
    expect((await row(documentId)).lastAccessedAt).toBeNull();
  });

  it("refuses a signed-out caller and a body that names no organization", async () => {
    const documentId = await makeDocument(world.workspaces.home, world.orgs.alpha, "Brief.pdf");
    const guest = await open(world.workspaces.home, documentId, { organizationId: world.orgs.alpha }, { session: null });
    expect(guest.res.status).toBe(401);

    const malformed = await open(world.workspaces.home, documentId, "{not json");
    expect(malformed.res.status).toBe(422);
    const empty = await open(world.workspaces.home, documentId, {});
    expect(empty.res.status).toBe(422);
    expect((empty.json?.error as { code: string }).code).toBe("INVALID_INPUT");
    expect((await row(documentId)).lastAccessedAt).toBeNull();
  });

  it("answers a document in another Workspace exactly as it answers one that does not exist", async () => {
    // The actor is a member of BOTH Workspaces, so this is not an access failure —
    // it is the pair `(workspaceId, documentId)` being wrong, and the id of a real
    // document must not become a way to write to it from the wrong Workspace.
    const elsewhere = await makeDocument(world.workspaces.other, world.orgs.alpha, "Brief.pdf");
    const mismatched = await open(world.workspaces.home, elsewhere, { organizationId: world.orgs.alpha });
    const unknown = await open(world.workspaces.home, "doc_does_not_exist", { organizationId: world.orgs.alpha });

    expect(mismatched.res.status).toBe(404);
    expect(unknown.res.status).toBe(404);
    expect((mismatched.json?.error as { message: string }).message).toBe(
      (unknown.json?.error as { message: string }).message,
    );
    // And the document really was left alone, in its own Workspace.
    expect((await row(elsewhere)).lastAccessedAt).toBeNull();
  });

  it("refuses another tenant's Workspace, whether or not its organization is named", async () => {
    const theirs = await makeDocument(world.workspaces.otherTenant, world.orgs.beta, "Theirs.pdf");
    // Named with its own organization: the actor is not a member of Beta.
    const named = await open(world.workspaces.otherTenant, theirs, { organizationId: world.orgs.beta });
    expect(named.res.status).toBe(403);
    // Named with the actor's own organization: the Workspace is not in it.
    const quiet = await open(world.workspaces.otherTenant, theirs, { organizationId: world.orgs.alpha });
    expect(quiet.res.status).toBe(404);
    expect((await row(theirs)).lastAccessedAt).toBeNull();
  });
});

describe("POST …/documents/:documentId/opened — the write", () => {
  /** Backdates the row so "did this column move" is a deterministic comparison. */
  const backdate = async (documentId: string) => {
    await prisma.$executeRawUnsafe(
      `UPDATE document_records SET updatedAt = ?, lastAccessedAt = NULL WHERE id = ?`,
      new Date("2026-01-01T00:00:00.000Z").getTime(),
      documentId,
    );
    return row(documentId);
  };

  it("records the open, and moves nothing else at all", async () => {
    const documentId = await makeDocument(world.workspaces.home, world.orgs.alpha, "Brief.pdf");
    const before = await backdate(documentId);
    const ingestionBefore = await prisma.documentIngestion.findFirstOrThrow({ where: { documentId } });

    const res = await open(world.workspaces.home, documentId, { organizationId: world.orgs.alpha });
    expect(res.res.status).toBe(204);
    expect(res.res.headers.get("Cache-Control")).toBe("no-store");

    const after = await row(documentId);
    // The one thing this route is for.
    expect(after.lastAccessedAt).not.toBeNull();
    expect(after.lastAccessedAt!.getTime()).toBeGreaterThan(before.updatedAt.getTime());

    /*
     * AND THE ABSENCES, which are the actual contract. `revision` is the
     * document's compare-and-swap fence: if an open advanced it, opening a
     * document in a second tab would turn the first tab's next autosave into a
     * conflict. `currentVersionId` and the version table are the content: an open
     * is not a save, so it cuts nothing.
     */
    // `updatedAt` is the file manager's **Modified** column, and it is sortable.
    // An open is not a modification, so it must not move — otherwise looking at a
    // document tells everyone else it was edited, and reorders their list.
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.revision).toBe(before.revision);
    expect(after.currentVersionId).toBe(before.currentVersionId);
    expect(await prisma.documentVersion.count()).toBe(0);
    // The stored bytes and the row that points at them are untouched.
    expect(await prisma.documentIngestion.findFirstOrThrow({ where: { documentId } })).toEqual(
      ingestionBefore,
    );
    expect(after.name).toBe(before.name);
    expect(after.lifecycleState).toBe(before.lifecycleState);
    // An open is not an audit event: it is a column, read by one listing.
    expect(audit).toEqual([]);
  });

  it("is safe to repeat, because a remount is not a second document", async () => {
    const documentId = await makeDocument(world.workspaces.home, world.orgs.alpha, "Brief.pdf");
    await backdate(documentId);
    for (let i = 0; i < 3; i += 1) {
      expect((await open(world.workspaces.home, documentId, { organizationId: world.orgs.alpha })).res.status).toBe(204);
    }
    const after = await row(documentId);
    // Three opens, one row, one revision, no versions. The editor re-mounts on
    // every navigation and this must cost nothing but a timestamp.
    expect(await prisma.documentRecord.count()).toBe(1);
    expect(after.revision).toBe(1);
    expect(await prisma.documentVersion.count()).toBe(0);
    expect(after.lastAccessedAt).not.toBeNull();
  });

  it("records an open in an archived Workspace, because reading one is still allowed", async () => {
    const documentId = await makeDocument(world.workspaces.archived, world.orgs.alpha, "Old.pdf");
    await backdate(documentId);
    const res = await open(world.workspaces.archived, documentId, { organizationId: world.orgs.alpha });
    // The existing policy: archived restricts WRITES to Workspace content, and
    // `touchAccessed` resolves at read level. Someone who can open a document can
    // be recorded as having opened it — the alternative is an archived Workspace
    // whose Recent list silently stops working.
    expect(res.res.status).toBe(204);
    expect((await row(documentId)).lastAccessedAt).not.toBeNull();
  });

  it("is the only thing that records an open — the reads a page makes do not", async () => {
    const documentId = await makeDocument(world.workspaces.home, world.orgs.alpha, "Brief.pdf");
    await backdate(documentId);

    // Exactly what a page fires on its way to an open, through the real routes.
    const detail = await DOCUMENT(get(`/api/workspaces/${world.workspaces.home}/documents/${documentId}?organizationId=${world.orgs.alpha}`), {
      params: Promise.resolve({ workspaceId: world.workspaces.home, documentId }),
    });
    const list = await DOCUMENT_LIST(get(`/api/workspaces/${world.workspaces.home}/documents?organizationId=${world.orgs.alpha}`), {
      params: Promise.resolve({ workspaceId: world.workspaces.home }),
    });
    expect([detail.status, list.status]).toEqual([200, 200]);
    // A GET that writes turns a prefetch, a retry or a range request into a
    // phantom open, and fires two or three times for one real open. This is the
    // reason the explicit POST exists, asserted rather than argued.
    expect((await row(documentId)).lastAccessedAt).toBeNull();

    // The POST, and only then does the column move.
    await open(world.workspaces.home, documentId, { organizationId: world.orgs.alpha });
    const opened = (await row(documentId)).lastAccessedAt;
    expect(opened).not.toBeNull();

    // A later background read does not move it again either.
    await DOCUMENT_LIST(get(`/api/workspaces/${world.workspaces.home}/documents?organizationId=${world.orgs.alpha}&view=recent&sortBy=lastAccessedAt`), {
      params: Promise.resolve({ workspaceId: world.workspaces.home }),
    });
    expect((await row(documentId)).lastAccessedAt!.getTime()).toBe(opened!.getTime());
  });
});
