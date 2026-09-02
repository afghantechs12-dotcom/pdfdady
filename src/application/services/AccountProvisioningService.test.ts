import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  personalOrganizationName,
  personalOrganizationSlug,
  provisionPersonalAccount,
} from "./AccountProvisioningService";

/**
 * Tenant provisioning against a real (temporary) SQLite database.
 *
 * Idempotence is the property that matters here: a retried signup must converge
 * on exactly one Organization, one default Workspace and one membership pair.
 * That can only be verified against real unique indexes and transactions, so
 * this suite migrates a throwaway database rather than using fakes.
 */

const root = process.cwd();
const prismaExecutable = path.join(root, "node_modules", "prisma", "build", "index.js");
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "pdfdadi-account-provision-"));
const databasePath = path.join(temporaryDirectory, "verification.db").replaceAll("\\", "/");
const databaseUrl = `file:${databasePath}`;
let prisma: PrismaClient;

beforeAll(() => {
  if (!existsSync(prismaExecutable)) throw new Error(`Prisma executable is missing at ${prismaExecutable}`);
  execFileSync(
    process.execPath,
    [prismaExecutable, "migrate", "deploy", "--schema", path.join(root, "prisma", "schema.prisma")],
    { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe" },
  );
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}, 60000);

afterAll(async () => {
  await prisma?.$disconnect();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

async function resetData() {
  await prisma.workspaceMembership.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.organizationMembership.deleteMany();
  await prisma.organization.deleteMany();
  await prisma.user.deleteMany();
}

async function createUser(id: string, email: string, name: string | null = null) {
  await prisma.user.create({ data: { id, email, name, provider: "local", passwordHash: "salt:hash" } });
  return { id, email, name };
}

describe("personalOrganizationName / Slug", () => {
  it("prefers the display name and falls back to the email local part", () => {
    expect(personalOrganizationName("Ada Lovelace", "ada@example.com")).toBe("Ada Lovelace's Organization");
    expect(personalOrganizationName(null, "ada@example.com")).toBe("ada's Organization");
    expect(personalOrganizationName("   ", "ada@example.com")).toBe("ada's Organization");
  });

  it("always produces a non-empty slug", () => {
    expect(personalOrganizationSlug("ada@example.com")).toBe("ada");
    expect(personalOrganizationSlug("Ada.Lovelace@example.com")).toBe("ada-lovelace");
    // A local part with no slug-safe characters must still yield something.
    expect(personalOrganizationSlug("!!!@example.com")).toBe("workspace");
  });
});

describe("provisionPersonalAccount", () => {
  it("creates the organization, workspace, memberships and default pointer", async () => {
    await resetData();
    const user = await createUser("u1", "ada@example.com", "Ada Lovelace");

    const result = await provisionPersonalAccount(prisma, user.id, user.email, user.name);

    const organization = await prisma.organization.findUniqueOrThrow({
      where: { id: result.organizationId },
    });
    expect(result.created).toBe(true);
    // The pointer is authoritative — the page layer reads it, so it must be set.
    expect(organization.defaultWorkspaceId).toBe(result.workspaceId);
    expect(
      await prisma.organizationMembership.findFirst({
        where: { organizationId: organization.id, userId: user.id, role: "owner" },
      }),
    ).not.toBeNull();
    expect(
      await prisma.workspaceMembership.findFirst({
        where: { workspaceId: result.workspaceId, userId: user.id, role: "owner" },
      }),
    ).not.toBeNull();
  });

  it("is idempotent — a retried signup creates no duplicates", async () => {
    await resetData();
    const user = await createUser("u1", "ada@example.com", "Ada Lovelace");

    const first = await provisionPersonalAccount(prisma, user.id, user.email, user.name);
    const second = await provisionPersonalAccount(prisma, user.id, user.email, user.name);
    const third = await provisionPersonalAccount(prisma, user.id, user.email, user.name);

    expect(second.organizationId).toBe(first.organizationId);
    expect(third.organizationId).toBe(first.organizationId);
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(third.workspaceId).toBe(first.workspaceId);
    expect(second.created).toBe(false);

    expect(await prisma.organization.count()).toBe(1);
    expect(await prisma.workspace.count()).toBe(1);
    expect(await prisma.organizationMembership.count()).toBe(1);
    expect(await prisma.workspaceMembership.count()).toBe(1);
  });

  it("repairs a dangling defaultWorkspaceId instead of leaving the tenant unusable", async () => {
    await resetData();
    const user = await createUser("u1", "ada@example.com", "Ada Lovelace");
    const provisioned = await provisionPersonalAccount(prisma, user.id, user.email, user.name);

    // Simulate an interrupted earlier run: pointer references a missing row.
    await prisma.organization.update({
      where: { id: provisioned.organizationId },
      data: { defaultWorkspaceId: "does-not-exist" },
    });

    const repaired = await provisionPersonalAccount(prisma, user.id, user.email, user.name);
    const organization = await prisma.organization.findUniqueOrThrow({
      where: { id: provisioned.organizationId },
    });

    expect(organization.defaultWorkspaceId).toBe(repaired.workspaceId);
    // The existing Workspace is reused, not duplicated.
    expect(await prisma.workspace.count()).toBe(1);
    expect(repaired.workspaceId).toBe(provisioned.workspaceId);
  });

  it("restores a missing owner WorkspaceMembership on the existing default", async () => {
    await resetData();
    const user = await createUser("u1", "ada@example.com", "Ada Lovelace");
    const provisioned = await provisionPersonalAccount(prisma, user.id, user.email, user.name);
    await prisma.workspaceMembership.deleteMany({ where: { workspaceId: provisioned.workspaceId } });

    await provisionPersonalAccount(prisma, user.id, user.email, user.name);

    expect(
      await prisma.workspaceMembership.count({
        where: { workspaceId: provisioned.workspaceId, userId: user.id, role: "owner" },
      }),
    ).toBe(1);
  });

  it("gives two users with the same email local part distinct organizations", async () => {
    await resetData();
    const first = await createUser("u1", "ada@example.com", "Ada One");
    const second = await createUser("u2", "ada@other.test", "Ada Two");

    const a = await provisionPersonalAccount(prisma, first.id, first.email, first.name);
    const b = await provisionPersonalAccount(prisma, second.id, second.email, second.name);

    expect(a.organizationId).not.toBe(b.organizationId);
    expect(a.workspaceId).not.toBe(b.workspaceId);
    // Organization.slug is globally unique, so the collision must be resolved.
    const organizations = await prisma.organization.findMany({ orderBy: { id: "asc" } });
    const slugs = organizations.map((organization) => organization.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(await prisma.workspace.count()).toBe(2);
  });

  it("reuses an existing organization the user already belongs to", async () => {
    await resetData();
    const user = await createUser("u1", "ada@example.com", "Ada Lovelace");
    const existing = await prisma.organization.create({
      data: { id: "org-existing", name: "Existing Org", slug: "existing-org" },
    });
    await prisma.organizationMembership.create({
      data: { organizationId: existing.id, userId: user.id, role: "owner" },
    });

    const result = await provisionPersonalAccount(prisma, user.id, user.email, user.name);

    expect(result.organizationId).toBe(existing.id);
    expect(result.created).toBe(false);
    expect(await prisma.organization.count()).toBe(1);
  });

  it("leaves no orphan or cross-tenant rows after concurrent-style repeats", async () => {
    await resetData();
    const user = await createUser("u1", "ada@example.com", "Ada Lovelace");

    // Sequential rather than Promise.all: SQLite serializes writers, and the
    // property under test is convergence, not lock behaviour.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await provisionPersonalAccount(prisma, user.id, user.email, user.name);
    }

    const organizations = await prisma.organization.findMany();
    const workspaces = await prisma.workspace.findMany();
    expect(organizations).toHaveLength(1);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].organizationId).toBe(organizations[0].id);
    expect(organizations[0].defaultWorkspaceId).toBe(workspaces[0].id);
  });
});
