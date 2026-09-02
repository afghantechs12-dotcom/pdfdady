import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

/**
 * C16 — `/api/workflow/save-target` answers with the Workspaces this session may
 * actually save into, and nothing else.
 *
 * WHY THIS RUNS AGAINST A REAL DATABASE. The whole point of the route is that the
 * FILTERING happens on the server: the browser is never handed a Workspace it
 * would have to exclude. A fake repository cannot prove that — a fake that
 * filters is only a test of the fake, and a fake that forgets to filter makes
 * every exclusion assertion below pass while production leaks. So the query that
 * does the filtering is the real one (`PrismaWorkspaceRepository.list` through
 * `WorkspaceService.list`), over real migrated SQLite, with real
 * organization/role providers.
 *
 * The two things that are faked are the two this route does not own: the session
 * cookie lookup (`AuthService.getMe`, tested where authentication lives) and
 * nothing else. Everything from `currentUser` down through the repository query
 * is the production code path.
 */

const registry = vi.hoisted(() => new Map<symbol, unknown>());
const session = vi.hoisted(() => ({ token: null as string | null, users: new Map<string, unknown>() }));

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
      name === "pdfdadi_session" && session.token ? { name, value: session.token } : undefined,
  }),
}));

import { Tokens } from "@/src/application/di/tokens";
import { WorkspaceService } from "@/src/application/services/WorkspaceService";
import { PrismaWorkspaceRepository } from "@/src/infrastructure/persistence/PrismaWorkspaceRepository";
import { PrismaWorkspaceMembershipRepository } from "@/src/infrastructure/persistence/PrismaWorkspaceMembershipRepository";
import { LocalOrganizationProvider } from "@/src/infrastructure/auth/LocalOrganizationProvider";
import { LocalRoleProvider } from "@/src/infrastructure/auth/LocalRoleProvider";
import { USER_SESSION_COOKIE } from "@/src/application/services/AuthService";
import { GET } from "@/app/api/workflow/save-target/route";

const root = process.cwd();
const prismaExecutable = path.join(root, "node_modules", "prisma", "build", "index.js");
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "pdfdadi-save-target-route-"));
const databaseUrl = `file:${path.join(temporaryDirectory, "route.db").replaceAll("\\", "/")}`;

let prisma: PrismaClient;
let world: Awaited<ReturnType<typeof seed>>;

/** The cookie name the route's session lookup reads. Pinned, not guessed. */
expect(USER_SESSION_COOKIE).toBe("pdfdadi_session");

function request(query = "") {
  return new NextRequest(`http://localhost:3001/api/workflow/save-target${query}`);
}

async function body() {
  const res = await GET(request());
  return { res, json: (await res.json()) as Record<string, unknown> };
}

interface Destination {
  workspaceId: string;
  organizationId: string;
  workspaceName: string;
}
const names = (json: Record<string, unknown>) =>
  (json.destinations as Destination[]).map((d) => d.workspaceName).sort();

async function makeUser(email: string) {
  const user = await prisma.user.create({
    data: { email, provider: "local", passwordHash: "s:h" },
  });
  session.users.set(`tok-${email}`, user);
  return user.id;
}

async function makeWorkspace(
  organizationId: string,
  name: string,
  createdById: string,
  lifecycleState = "active",
) {
  const slug = `${name.toLowerCase()}-${organizationId.slice(-4)}`;
  const workspace = await prisma.workspace.create({
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
  return workspace.id;
}

async function join(workspaceId: string, userId: string, createdById: string, revoked = false) {
  await prisma.workspaceMembership.create({
    data: {
      workspaceId,
      userId,
      role: "editor",
      createdById,
      revokedAt: revoked ? new Date() : null,
    },
  });
}

/**
 * Two tenants, and every membership shape the route has to exclude: an archived
 * Workspace, a Workspace in the same organization the actor does not belong to, a
 * revoked membership, and a membership in ANOTHER organization's Workspace.
 */
async function seed() {
  const solo = await makeUser("solo@example.test");
  const multi = await makeUser("multi@example.test");
  const orphan = await makeUser("orphan@example.test");

  const alpha = await prisma.organization.create({
    data: { name: "Alpha", slug: "alpha", plan: "free" },
  });
  const beta = await prisma.organization.create({
    data: { name: "Beta", slug: "beta", plan: "free" },
  });
  const lonely = await prisma.organization.create({
    data: { name: "Lonely", slug: "lonely", plan: "free" },
  });
  for (const [org, user] of [
    [alpha.id, solo],
    [alpha.id, multi],
    [beta.id, multi],
    [lonely.id, orphan],
  ] as const) {
    await prisma.organizationMembership.create({
      data: { organizationId: org, userId: user, role: "member" },
    });
  }

  const home = await makeWorkspace(alpha.id, "Home", solo);
  const team = await makeWorkspace(alpha.id, "Team", multi);
  const archived = await makeWorkspace(alpha.id, "Archive", multi, "archived");
  const nobodys = await makeWorkspace(alpha.id, "Private", solo);
  const beeswax = await makeWorkspace(beta.id, "Beeswax", multi);

  await prisma.organization.update({
    where: { id: alpha.id },
    data: { defaultWorkspaceId: home },
  });

  await join(home, solo, solo);
  await join(home, multi, multi);
  await join(team, multi, multi);
  await join(archived, multi, multi);
  // A membership in the OTHER tenant's Workspace: the actor really is a member,
  // and the route must still not offer it for an Alpha result.
  await join(beeswax, multi, multi);
  // A revoked membership is not a destination.
  await join(nobodys, multi, multi, true);

  return {
    users: { solo, multi, orphan },
    orgs: { alpha: alpha.id, beta: beta.id, lonely: lonely.id },
    workspaces: { home, team, archived, nobodys, beeswax },
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
  registry.set(Tokens.AuthService, {
    // The one fake: a token is a token. Whether a cookie names a live session is
    // `AuthService`'s subject, not this route's.
    getMe: async (token: string) => session.users.get(token) ?? null,
  });
  registry.set(Tokens.OrganizationProvider, new LocalOrganizationProvider(prisma));
  registry.set(Tokens.RoleProvider, new LocalRoleProvider(prisma));
  registry.set(
    Tokens.WorkspaceService,
    new WorkspaceService(
      prisma,
      new PrismaWorkspaceRepository(prisma),
      new PrismaWorkspaceMembershipRepository(prisma),
    ),
  );
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.workspaceMembership.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.organizationMembership.deleteMany();
  await prisma.organization.deleteMany();
  await prisma.user.deleteMany();
  session.token = null;
  session.users.clear();
  world = await seed();
});

describe("GET /api/workflow/save-target", () => {
  it("answers a guest with 200 and no destinations, not a 401", async () => {
    const { res, json } = await body();
    // A signed-out visitor on a public tool page is a STATE this UI renders (a
    // sign-in link beside the download), not an error it recovers from. A 401
    // here would make the result panel look broken to every guest.
    expect(res.status).toBe(200);
    expect(json).toEqual({ authenticated: false, destinations: [], defaultWorkspaceId: null });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("treats a cookie that names no live session as signed out", async () => {
    session.token = "tok-deleted@example.test";
    const { json } = await body();
    // The presence of a cookie is not proof of a session — only a lookup is.
    expect(json.authenticated).toBe(false);
    expect(json.destinations).toEqual([]);
  });

  it("offers a single Workspace, and names it the default", async () => {
    session.token = "tok-solo@example.test";
    const { json } = await body();
    expect(json.authenticated).toBe(true);
    expect(names(json)).toEqual(["Home"]);
    // One destination is what lets the client select for the user without asking.
    expect(json.defaultWorkspaceId).toBe(world.workspaces.home);
  });

  it("offers every authorized Workspace to a member of several", async () => {
    session.token = "tok-multi@example.test";
    const { json } = await body();
    // Home and Team. This is the fix: the user picks, instead of being given the
    // account default and left to move the document afterwards.
    expect(names(json)).toEqual(["Home", "Team"]);
    expect(json.defaultWorkspaceId).toBe(world.workspaces.home);
  });

  it("excludes archived, non-member, revoked and cross-organization Workspaces at the server", async () => {
    session.token = "tok-multi@example.test";
    const { json } = await body();
    const offered = (json.destinations as Destination[]).map((d) => d.workspaceId);
    // Archived: the actor IS a member, and a save there would be refused.
    expect(offered).not.toContain(world.workspaces.archived);
    // Revoked membership: a membership row exists and is not a destination.
    expect(offered).not.toContain(world.workspaces.nobodys);
    // Another tenant's Workspace, with a real membership in it.
    expect(offered).not.toContain(world.workspaces.beeswax);
    // And every id offered is in the actor's own organization.
    expect(new Set((json.destinations as Destination[]).map((d) => d.organizationId))).toEqual(
      new Set([world.orgs.alpha]),
    );
  });

  it("returns no destinations for an account with nowhere to save", async () => {
    session.token = "tok-orphan@example.test";
    const { json } = await body();
    // Signed in, in an organization, with no Workspace and no organization
    // default to inherit. No Save button — a button that always fails is not an
    // offer — and no provisioning as a side effect of finishing a merge.
    expect(json.authenticated).toBe(true);
    expect(json.destinations).toEqual([]);
    expect(json.defaultWorkspaceId).toBeNull();
    expect(await prisma.workspace.count({ where: { organizationId: world.orgs.lonely } })).toBe(0);
  });

  it("labels no default when the organization's default is not one of the destinations", async () => {
    await prisma.organization.update({
      where: { id: world.orgs.alpha },
      data: { defaultWorkspaceId: world.workspaces.archived },
    });
    session.token = "tok-multi@example.test";
    const { json } = await body();
    // Naming a default the save routes would refuse advertises a destination that
    // cannot work, so it is not named. The actor's own memberships are untouched
    // by where the organization points its default.
    expect(json.defaultWorkspaceId).toBeNull();
    expect(names(json)).toEqual(["Home", "Team"]);
  });

  it("carries only the ids the save needs and a display name", async () => {
    session.token = "tok-multi@example.test";
    const res = await GET(request());
    const raw = await res.text();
    for (const destination of (JSON.parse(raw) as { destinations: Destination[] }).destinations) {
      expect(Object.keys(destination).sort()).toEqual([
        "organizationId",
        "workspaceId",
        "workspaceName",
      ]);
    }
    // No slug, no normalized forms, no lifecycle, no creator, no email, no
    // membership rows: the browser gets what it renders and what it must send back.
    for (const leak of ["normalizedName", "normalizedSlug", "createdById", "lifecycleState", "@example.test", "passwordHash"]) {
      expect(raw).not.toContain(leak);
    }
  });

  it("takes no input, so a named Workspace cannot widen the set", async () => {
    session.token = "tok-solo@example.test";
    const res = await GET(request(`?workspaceId=${world.workspaces.team}&organizationId=${world.orgs.beta}`));
    const json = (await res.json()) as Record<string, unknown>;
    // `solo` is a member of Home only. Asking for Team and for the other tenant
    // changes nothing: the session decides the set.
    expect(names(json)).toEqual(["Home"]);
  });

  it("degrades to no destination when the lookup itself fails", async () => {
    const working = registry.get(Tokens.OrganizationProvider);
    registry.set(Tokens.OrganizationProvider, {
      listForUser: async () => {
        throw new Error("organization store unavailable");
      },
    });
    session.token = "tok-solo@example.test";
    try {
      const { res, json } = await body();
      // Best-effort by design: a failed lookup must not throw a visitor out of a
      // result page, and it must not be reported as "you are signed out" either —
      // the client renders `none`, and the download is still there.
      expect(res.status).toBe(200);
      expect(json).toMatchObject({ authenticated: true, destinations: [], defaultWorkspaceId: null });
    } finally {
      registry.set(Tokens.OrganizationProvider, working);
    }
  });
});
