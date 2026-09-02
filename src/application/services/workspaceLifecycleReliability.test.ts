import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { WorkspaceService, type ActorContext } from "./WorkspaceService";
import { PrismaWorkspaceRepository } from "@/src/infrastructure/persistence/PrismaWorkspaceRepository";
import { PrismaWorkspaceMembershipRepository } from "@/src/infrastructure/persistence/PrismaWorkspaceMembershipRepository";
import { WorkspaceAccessError, WorkspaceLifecycleError } from "@/src/domain/errors";
import { runBackfill } from "@/prisma/backfill-workspace-owner-memberships";

/**
 * Workspace creation → navigation reliability, against a real migrated SQLite
 * database rather than a fake.
 *
 * A fake `prisma` cannot fail this suite the way production failed: the defect
 * was a *missing second write* inside `create`, and every fake in this repo is
 * written from the adapter's own assumptions. The transaction, the unique
 * indexes and the two-query membership join are the things under test, so the
 * database has to be real.
 *
 * The invariant every case here defends: a Workspace that creation returned is
 * already openable by its creator, by the exact id creation returned, with no
 * delay, and the picker and the direct route agree about it.
 */

const root = process.cwd();
const prismaExecutable = path.join(root, "node_modules", "prisma", "build", "index.js");
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "pdfdadi-workspace-reliability-"));
const databaseUrl = `file:${path.join(temporaryDirectory, "reliability.db").replaceAll("\\", "/")}`;
let prisma: PrismaClient;
let service: WorkspaceService;

async function reset() {
  await prisma.workspaceMembership.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.organizationMembership.deleteMany();
  await prisma.organization.deleteMany();
  await prisma.user.deleteMany();
}

/** An organization with an owner, an editor and an unrelated member. */
async function seedTenant(key: string) {
  const org = await prisma.organization.create({
    data: { name: `${key} Org`, slug: key, plan: "free" },
  });
  const users: Record<string, string> = {};
  for (const role of ["owner", "member"] as const) {
    const user = await prisma.user.create({
      data: { email: `${key}-${role}@example.test`, provider: "local", passwordHash: "s:h" },
    });
    await prisma.organizationMembership.create({
      data: { organizationId: org.id, userId: user.id, role },
    });
    users[role] = user.id;
  }
  return { organizationId: org.id, owner: users.owner, member: users.member };
}

function actorFor(
  tenant: { organizationId: string },
  userId: string,
  role: ActorContext["organizationRole"] = "owner",
  defaultWorkspaceId: string | null = null,
): ActorContext {
  return {
    userId,
    organizationId: tenant.organizationId,
    organizationRole: role,
    organizationDefaultWorkspaceId: defaultWorkspaceId,
  };
}

function serviceFor(client: PrismaClient) {
  return new WorkspaceService(
    client,
    new PrismaWorkspaceRepository(client),
    new PrismaWorkspaceMembershipRepository(client),
  );
}

beforeAll(() => {
  if (!existsSync(prismaExecutable)) throw new Error(`Prisma executable is missing at ${prismaExecutable}`);
  execFileSync(
    process.execPath,
    [prismaExecutable, "migrate", "deploy", "--schema", path.join(root, "prisma", "schema.prisma")],
    { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe" },
  );
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  service = serviceFor(prisma);
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

beforeEach(reset);

/** The error a call threw. Fails loudly if the call resolved instead. */
async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected this call to be refused, but it resolved.");
}

/**
 * A client whose Workspace transaction fails on the membership insert.
 *
 * The proxy only replaces `workspaceMembership.create` on the transaction
 * client; the transaction itself is the real one, so SQLite performs the real
 * rollback. Nothing here reaches into Prisma internals, which is what keeps the
 * test about the repository's contract rather than about Prisma's version.
 */
function clientWithFailingMembershipInsert(client: PrismaClient): PrismaClient {
  const forward = (target: object, property: string | symbol) => {
    const value = (target as Record<string | symbol, unknown>)[property];
    return typeof value === "function" ? value.bind(target) : value;
  };

  return new Proxy(client, {
    get(target, property) {
      if (property !== "$transaction") return forward(target, property);
      return (callback: (tx: unknown) => unknown) =>
        client.$transaction((tx) =>
          Promise.resolve(
            callback(
              new Proxy(tx as object, {
                get(txTarget, txProperty) {
                  if (txProperty === "workspaceMembership") {
                    return { create: () => Promise.reject(new Error("forced membership failure")) };
                  }
                  return forward(txTarget, txProperty);
                },
              }),
            ),
          ),
        );
    },
  }) as unknown as PrismaClient;
}

describe("create → open, the defect this phase exists for", () => {
  it("1+3: the id creation returns is immediately accepted by get, with no delay", async () => {
    const tenant = await seedTenant("alpha");
    const actor = actorFor(tenant, tenant.owner);

    const created = await service.create(actor, { name: "Phase 1 Reliability Test" });
    // No await of a timer, no retry, no second attempt: the very next call.
    const opened = await service.get(actor, created.id);

    expect(opened.workspace.id).toBe(created.id);
    expect(opened.role).toBe("owner");
  });

  it("2: create writes the creator's owner membership in the same transaction", async () => {
    const tenant = await seedTenant("alpha");
    const created = await service.create(actorFor(tenant, tenant.owner), { name: "Atomic" });

    const memberships = await prisma.workspaceMembership.findMany({ where: { workspaceId: created.id } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ userId: tenant.owner, role: "owner", revokedAt: null });
  });

  it("2: a failed membership insert rolls the Workspace row back entirely", async () => {
    const tenant = await seedTenant("alpha");
    const failing = serviceFor(clientWithFailingMembershipInsert(prisma));

    await expect(
      failing.create(actorFor(tenant, tenant.owner), { name: "Half Written" }),
    ).rejects.toThrow("forced membership failure");

    // The half-written state is what shipped: a Workspace with no owner. There
    // must be no row at all rather than an unopenable one.
    expect(await prisma.workspace.count({ where: { organizationId: tenant.organizationId } })).toBe(0);
    expect(await prisma.workspaceMembership.count()).toBe(0);
  });

  it("4+5: repeated and fresh-instance lookups of the same id resolve identically", async () => {
    const tenant = await seedTenant("alpha");
    const actor = actorFor(tenant, tenant.owner);
    const created = await service.create(actor, { name: "Deep Link" });

    const reload = await service.get(actor, created.id);
    // A reload, a copied URL and a new tab all reach a process with no memory of
    // the create — a service built from scratch is that condition.
    const freshProcess = await serviceFor(prisma).get(actor, created.id);

    expect([reload.workspace.id, freshProcess.workspace.id]).toEqual([created.id, created.id]);
    expect(freshProcess.role).toBe("owner");
  });

  it("6+E: everything the picker lists, get accepts — and nothing else", async () => {
    const tenant = await seedTenant("alpha");
    const actor = actorFor(tenant, tenant.owner);
    await service.create(actor, { name: "First" });
    await service.create(actor, { name: "Second" });

    const { items } = await service.list(actor);
    const opened = await Promise.all(items.map((item) => service.get(actor, item.id).then((r) => r.workspace.id)));

    expect(items).toHaveLength(2);
    expect(opened.sort()).toEqual(items.map((item) => item.id).sort());
  });

  it("6+E: the picker does not advertise a Workspace the actor cannot open", async () => {
    const tenant = await seedTenant("alpha");
    const owned = await service.create(actorFor(tenant, tenant.owner), { name: "Owner Only" });
    const outsider = actorFor(tenant, tenant.member, "member");

    // The listing used to filter on organizationId alone, so this returned the
    // Workspace that `get` then refused — the recording's "it appeared in the
    // picker afterwards".
    const { items } = await service.list(outsider);
    expect(items).toEqual([]);
    await expect(service.get(outsider, owned.id)).rejects.toBeInstanceOf(WorkspaceAccessError);
  });
});

describe("refusals stay controlled and indistinguishable", () => {
  it("7: a same-organization non-member is refused as ACCESS_DENIED", async () => {
    const tenant = await seedTenant("alpha");
    const owned = await service.create(actorFor(tenant, tenant.owner), { name: "Private" });

    const error = await refusal(service.get(actorFor(tenant, tenant.member, "member"), owned.id));

    expect(error).toBeInstanceOf(WorkspaceAccessError);
    expect((error as WorkspaceAccessError).code).toBe("WORKSPACE_ACCESS_DENIED");
    // The category is for the log. The message a prober can observe is the same
    // one a nonexistent id produces, so it is not an existence oracle.
    expect((error as Error).message).toBe("Workspace not found.");
  });

  it("7: another organization's member is refused, and organization scoping is what refuses", async () => {
    const alpha = await seedTenant("alpha");
    const beta = await seedTenant("beta");
    const owned = await service.create(actorFor(alpha, alpha.owner), { name: "Alpha Private" });

    // Even as an owner in their own organization, and even holding a membership
    // row on the target Workspace, the actor is refused: `getById` is
    // organization-scoped, so a stray membership cannot cross tenants.
    await prisma.workspaceMembership.create({
      data: { workspaceId: owned.id, userId: beta.owner, role: "owner", createdById: beta.owner },
    });

    await expect(service.get(actorFor(beta, beta.owner), owned.id)).rejects.toMatchObject({
      code: "WORKSPACE_NOT_FOUND",
      message: "Workspace not found.",
    });
    expect((await service.list(actorFor(beta, beta.owner))).items).toEqual([]);
  });

  it("8: a nonexistent id is NOT_FOUND and a blank id is ID_INVALID, both worded the same", async () => {
    const tenant = await seedTenant("alpha");
    const actor = actorFor(tenant, tenant.owner);

    await expect(service.get(actor, "ckzzzzzzzzzzzzzzzzzzzzzzz")).rejects.toMatchObject({
      code: "WORKSPACE_NOT_FOUND",
      message: "Workspace not found.",
    });
    for (const malformed of ["", "   "]) {
      await expect(service.get(actor, malformed)).rejects.toMatchObject({
        code: "WORKSPACE_ID_INVALID",
        message: "Workspace not found.",
      });
    }
  });

  it("F: a refusal carries no identifier or internal detail in its message", async () => {
    const tenant = await seedTenant("alpha");
    const owned = await service.create(actorFor(tenant, tenant.owner), { name: "Leak Check" });
    const error = await refusal(service.get(actorFor(tenant, tenant.member, "member"), owned.id));

    expect(error.message).not.toContain(owned.id);
    expect(error.message).not.toContain(tenant.member);
    expect(error.message).not.toContain(tenant.organizationId);
  });

  it("observability: a refusal logs ids and stages, never a secret or a name", async () => {
    const tenant = await seedTenant("alpha");
    const owned = await service.create(actorFor(tenant, tenant.owner), { name: "Logged" });
    const lines: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const logged = new WorkspaceService(
      prisma,
      new PrismaWorkspaceRepository(prisma),
      new PrismaWorkspaceMembershipRepository(prisma),
      undefined,
      {
        debug() {},
        info() {},
        warn: (message: string, context?: Record<string, unknown>) => lines.push({ message, context }),
        error() {},
        child() {
          throw new Error("child() is not used by WorkspaceService.");
        },
      },
    );

    await expect(logged.get(actorFor(tenant, tenant.member, "member"), owned.id)).rejects.toThrow();

    expect(lines).toHaveLength(1);
    expect(lines[0].context).toMatchObject({
      operation: "WorkspaceService.get",
      category: "WORKSPACE_ACCESS_DENIED",
      actorId: tenant.member,
      organizationId: tenant.organizationId,
      workspaceId: owned.id,
      workspaceExists: true,
      membershipExists: false,
    });
    // No email, token, cookie, session or document content may appear.
    expect(JSON.stringify(lines[0])).not.toMatch(/@example\.test|passwordHash|s:h|cookie|token/i);
  });
});

describe("names are not identity", () => {
  /**
   * Test 9 as the schema allows it.
   *
   * Two Workspaces with the *same* name cannot exist: `@@unique([organizationId,
   * normalizedName])` and `@@unique([organizationId, normalizedSlug])` forbid it,
   * and dropping those indexes to satisfy a navigation test would weaken data
   * integrity in a phase that is not about the naming model. So the requirement
   * behind test 9 — that routing never depends on a display name — is proven the
   * two ways that are actually reachable: similar names route by id, and a real
   * duplicate is a controlled conflict instead of a raw Prisma 500.
   */
  it("9: near-identical names resolve to their own ids, not to each other", async () => {
    const tenant = await seedTenant("alpha");
    const actor = actorFor(tenant, tenant.owner);
    const first = await service.create(actor, { name: "Reports" });
    const second = await service.create(actor, { name: "Reports 2" });

    expect(first.id).not.toBe(second.id);
    expect((await service.get(actor, first.id)).workspace.name).toBe("Reports");
    expect((await service.get(actor, second.id)).workspace.name).toBe("Reports 2");
  });

  it("9: a duplicate name is a controlled conflict, not a Prisma failure", async () => {
    const tenant = await seedTenant("alpha");
    const actor = actorFor(tenant, tenant.owner);
    await service.create(actor, { name: "Reports" });

    const error = await refusal(service.create(actor, { name: "reports" }));

    expect(error.name).toBe("DomainError");
    expect(error.message).toBe("A Workspace with this name already exists in this organization.");
    expect(await prisma.workspace.count()).toBe(1);
  });

  it("10: two concurrent submits of one name leave exactly one Workspace", async () => {
    const tenant = await seedTenant("alpha");
    const actor = actorFor(tenant, tenant.owner);

    const results = await Promise.allSettled([
      service.create(actor, { name: "Double Clicked" }),
      service.create(actor, { name: "Double Clicked" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.workspace.count()).toBe(1);
    // And the one that succeeded is openable — a duplicate race must not leave a
    // Workspace whose membership insert lost.
    const winner = results.find((result) => result.status === "fulfilled");
    const created = (winner as PromiseFulfilledResult<{ id: string }>).value;
    expect((await service.get(actor, created.id)).role).toBe("owner");
  });
});

describe("11: read-after-write is not served from a stale copy", () => {
  it("a Workspace appears in the very next listing, and a rename is visible at once", async () => {
    const tenant = await seedTenant("alpha");
    const actor = actorFor(tenant, tenant.owner);

    expect((await service.list(actor)).items).toEqual([]);
    const created = await service.create(actor, { name: "Fresh" });
    expect((await service.list(actor)).items.map((item) => item.id)).toEqual([created.id]);

    const renamed = await service.update(actor, created.id, { name: "Renamed", revision: created.revision });
    expect(renamed.name).toBe("Renamed");
    expect((await service.get(actor, created.id)).workspace.name).toBe("Renamed");
  });
});

describe("12: archive, refuse writes, restore", () => {
  it("an archived Workspace stays readable, refuses writes with a reason, and restores", async () => {
    const tenant = await seedTenant("alpha");
    const actor = actorFor(tenant, tenant.owner);
    const created = await service.create(actor, { name: "Seasonal" });

    await service.setLifecycle(actor, created.id, "archived");

    // Readable: the owner must be able to open it in order to restore it.
    const read = await service.get(actor, created.id);
    expect(read.workspace.lifecycleState).toBe("archived");
    // Write-intent refusal is a controlled 409-class error naming the state,
    // never the uniform "not found" — this actor already has read access, so the
    // reason is safe and is the only actionable answer.
    const error = await refusal(service.get(actor, created.id, true));
    expect(error).toBeInstanceOf(WorkspaceLifecycleError);
    expect(error.message).toContain("archived");
    // Out of the active picker while archived.
    expect((await service.list(actor)).items).toEqual([]);

    // Restore. This used to be impossible: `setLifecycle` authorized with write
    // intent, and write intent is exactly what an archived Workspace refuses.
    await service.setLifecycle(actor, created.id, "active");
    expect((await service.get(actor, created.id, true)).workspace.lifecycleState).toBe("active");
    expect((await service.list(actor)).items.map((item) => item.id)).toEqual([created.id]);
  });
});

describe("inherited access on the organization default Workspace", () => {
  it("an organization member reaches the default Workspace with no membership row", async () => {
    const tenant = await seedTenant("alpha");
    const created = await service.create(actorFor(tenant, tenant.owner), { name: "Default" });
    await prisma.organization.update({
      where: { id: tenant.organizationId },
      data: { defaultWorkspaceId: created.id },
    });
    const member = actorFor(tenant, tenant.member, "member", created.id);

    expect((await service.get(member, created.id)).workspace.id).toBe(created.id);
    // And the picker agrees, which is the same invariant as everywhere else.
    expect((await service.list(member)).items.map((item) => item.id)).toEqual([created.id]);
  });
});

describe("backfill for Workspaces created before create was atomic", () => {
  it("repairs a missing owner membership, is idempotent, and leaves a revocation alone", async () => {
    const tenant = await seedTenant("alpha");
    const actor = actorFor(tenant, tenant.owner);
    // A row exactly as the buggy `create` left it: Workspace, no membership.
    const orphan = await prisma.workspace.create({
      data: {
        organizationId: tenant.organizationId,
        name: "Orphan",
        normalizedName: "orphan",
        slug: "orphan",
        normalizedSlug: "orphan",
        createdById: tenant.owner,
      },
    });
    await expect(service.get(actor, orphan.id)).rejects.toBeInstanceOf(WorkspaceAccessError);

    expect(await runBackfill(prisma)).toMatchObject({ workspaces: 1, repaired: 1, alreadyPresent: 0 });
    expect((await service.get(actor, orphan.id)).role).toBe("owner");
    expect(await runBackfill(prisma)).toMatchObject({ repaired: 0, alreadyPresent: 1 });

    // A deliberate revocation is a decision, not damage: the repair must not
    // hand back access an administrator removed.
    await prisma.workspaceMembership.updateMany({
      where: { workspaceId: orphan.id },
      data: { revokedAt: new Date() },
    });
    expect(await runBackfill(prisma)).toMatchObject({ repaired: 0, revoked: 1 });
    await expect(service.get(actor, orphan.id)).rejects.toBeInstanceOf(WorkspaceAccessError);
  });
});
