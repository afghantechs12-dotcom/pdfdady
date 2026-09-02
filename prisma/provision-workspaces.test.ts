import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { provisionAllDefaultWorkspaces } from "./provision-workspaces";
import { normalizeWorkspaceName, normalizeWorkspaceSlug } from "../src/application/services/workspaceNormalization";

const root = process.cwd();
const prismaExecutable = path.join(root, "node_modules", "prisma", "build", "index.js");
const nodeExecutable = process.execPath;
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "pdfdadi-workspace-provision-"));
const databasePath = path.join(temporaryDirectory, "verification.db").replaceAll("\\", "/");
const databaseUrl = `file:${databasePath}`;
let prisma: PrismaClient;

async function resetData() {
  await prisma.workspaceMembership.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.organizationMembership.deleteMany();
  await prisma.organization.deleteMany();
  await prisma.user.deleteMany();
}

async function createOrganization(id: string, options: { owner?: boolean; slug?: string } = {}) {
  const userId = `${id}-owner`;
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.test` } });
  await prisma.organization.create({ data: { id, name: `${id} Organization`, slug: options.slug ?? id } });
  if (options.owner !== false) {
    await prisma.organizationMembership.create({
      data: { id: `${id}-membership`, organizationId: id, userId, role: "owner" },
    });
  }
  return { organizationId: id, userId };
}

beforeAll(() => {
  if (!existsSync(prismaExecutable)) throw new Error(`Prisma executable is missing at ${prismaExecutable}`);
  execFileSync(nodeExecutable, [prismaExecutable, "migrate", "deploy", "--schema", path.join(root, "prisma", "schema.prisma")], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}, 60000);

afterAll(async () => {
  await prisma?.$disconnect();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("provisionAllDefaultWorkspaces", () => {
  it("creates one authoritative default and is idempotent on repeat", async () => {
    await resetData();
    const organization = await createOrganization("alpha");

    const first = await provisionAllDefaultWorkspaces(prisma);
    const second = await provisionAllDefaultWorkspaces(prisma);
    const stored = await prisma.organization.findUniqueOrThrow({ where: { id: organization.organizationId } });

    expect(first).toMatchObject({ organizations: 1, processed: 1, created: 1, pointersRepaired: 1, failures: [] });
    expect(second).toMatchObject({ organizations: 1, processed: 1, created: 0, skipped: 1, failures: [] });
    expect(await prisma.workspace.count({ where: { organizationId: organization.organizationId } })).toBe(1);
    expect(await prisma.workspaceMembership.count({ where: { workspaceId: stored.defaultWorkspaceId!, userId: organization.userId } })).toBe(1);
  });

  it("resumes deterministically after a bounded interruption", async () => {
    await resetData();
    await createOrganization("alpha");
    await createOrganization("beta");

    const partial = await provisionAllDefaultWorkspaces(prisma, { maxOrganizations: 1 });
    const resumed = await provisionAllDefaultWorkspaces(prisma);

    expect(partial).toMatchObject({ organizations: 2, processed: 1, created: 1, interrupted: true });
    expect(resumed).toMatchObject({ organizations: 2, processed: 2, created: 1, skipped: 1, interrupted: false, failures: [] });
    expect(await prisma.organization.count({ where: { defaultWorkspaceId: { not: null } } })).toBe(2);
  });

  it("repairs a missing pointer by reusing the deterministic Workspace", async () => {
    await resetData();
    const organization = await createOrganization("repair");
    const name = "repair Organization Workspace";
    const slug = normalizeWorkspaceSlug("repair-workspace");
    const workspace = await prisma.workspace.create({
      data: {
        id: "repair-existing",
        organizationId: organization.organizationId,
        name,
        normalizedName: normalizeWorkspaceName(name),
        slug,
        normalizedSlug: slug,
        createdById: organization.userId,
      },
    });

    const report = await provisionAllDefaultWorkspaces(prisma);
    const stored = await prisma.organization.findUniqueOrThrow({ where: { id: organization.organizationId } });

    expect(report).toMatchObject({ reused: 1, created: 0, pointersRepaired: 1, failures: [] });
    expect(stored.defaultWorkspaceId).toBe(workspace.id);
    expect(await prisma.workspace.count()).toBe(1);
  });

  it("uses the next deterministic name and slug when either normalized candidate collides", async () => {
    await resetData();
    const organization = await createOrganization("collision");
    const baseName = "collision Organization Workspace";
    await prisma.workspace.create({
      data: {
        organizationId: organization.organizationId,
        name: baseName,
        normalizedName: normalizeWorkspaceName(baseName),
        slug: "occupied-slug",
        normalizedSlug: "occupied-slug",
        createdById: organization.userId,
      },
    });

    const report = await provisionAllDefaultWorkspaces(prisma);
    const stored = await prisma.organization.findUniqueOrThrow({ where: { id: organization.organizationId } });
    const provisioned = await prisma.workspace.findUniqueOrThrow({ where: { id: stored.defaultWorkspaceId! } });

    expect(report.created).toBe(1);
    expect(provisioned.name).toBe(`${baseName} 2`);
    expect(provisioned.slug).toBe("collision-workspace-2");
  });

  it("isolates an Organization failure and leaves no partial Workspace rows", async () => {
    await resetData();
    await createOrganization("broken", { owner: false });
    await createOrganization("healthy");

    const report = await provisionAllDefaultWorkspaces(prisma);

    expect(report.processed).toBe(2);
    expect(report.created).toBe(1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.organizationId).toBe("broken");
    expect(await prisma.workspace.count({ where: { organizationId: "broken" } })).toBe(0);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: "broken" } })).defaultWorkspaceId).toBeNull();
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: "healthy" } })).defaultWorkspaceId).not.toBeNull();
  });

  it("leaves no invalid default pointers, orphan memberships, or cross-Organization references", async () => {
    await resetData();
    await createOrganization("one");
    await createOrganization("two");
    await provisionAllDefaultWorkspaces(prisma);

    const organizations = await prisma.organization.findMany();
    const workspaces = await prisma.workspace.findMany();
    const memberships = await prisma.workspaceMembership.findMany();
    const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));

    expect(organizations.every((organization) => {
      const workspace = organization.defaultWorkspaceId ? workspaceById.get(organization.defaultWorkspaceId) : undefined;
      return workspace?.organizationId === organization.id;
    })).toBe(true);
    expect(memberships.every((membership) => workspaceById.has(membership.workspaceId))).toBe(true);
    expect(workspaces).toHaveLength(organizations.length);
  });
});
