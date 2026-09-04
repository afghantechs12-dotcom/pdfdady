import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Workspace page's ORGANIZATION boundary — the one a cross-tenant URL hits
 * first.
 *
 * `workspaceRouteAccess.test.ts` covers the Workspace-level refusal, and
 * `WorkspaceService` logs it. This file covers the guard that runs before either:
 * a URL naming another tenant's `organizationId`. It was measured refusing
 * correctly and silently, so the assertions here are about BOTH halves — the
 * controlled not-found and the structured line — because only one of them was
 * missing and a scan of the source cannot tell you it fires.
 */
const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({ notFound: () => notFound(), redirect: (url: string) => redirect(url) }));

let signedInUser: { id: string; email: string; name: string } | null = {
  id: "user_1",
  email: "owner@example.test",
  name: "Owner",
};
vi.mock("./authSession", () => ({
  currentUser: () => Promise.resolve(signedInUser),
  loginRedirectUrl: (path: string) => `/login?next=${encodeURIComponent(path)}`,
}));

const { appContainer } = await import("@/src/application/di/container");
const { Tokens } = await import("@/src/application/di/tokens");

// The container caches on first resolve, so each fake is registered once and
// mutated per test rather than re-registered — which also keeps this honest
// about the singleton behaviour the real pages get.
const warn = vi.fn();
const logger = { debug() {}, info() {}, warn, error() {}, child: () => logger };
const state = {
  orgs: [{ id: "own_org", defaultWorkspaceId: null }] as { id: string; defaultWorkspaceId: string | null }[],
  role: "owner" as string | null,
};
appContainer.register(Tokens.Logger, () => logger);
appContainer.register(Tokens.OrganizationProvider, () => ({ listForUser: () => Promise.resolve(state.orgs) }));
appContainer.register(Tokens.RoleProvider, () => ({ getRole: () => Promise.resolve(state.role) }));

const { workspacePageActor } = await import("./workspacePageData");

beforeEach(() => {
  warn.mockClear();
  notFound.mockClear();
  redirect.mockClear();
  state.orgs = [{ id: "own_org", defaultWorkspaceId: null }];
  state.role = "owner";
  signedInUser = { id: "user_1", email: "owner@example.test", name: "Owner" };
});

const fields = () => warn.mock.calls[0]?.[1] ?? {};

describe("the organization boundary on a Workspace page", () => {
  it("resolves the actor's own organization without logging a refusal", async () => {
    const { org, actor } = await workspacePageActor("own_org");
    expect(org.id).toBe("own_org");
    expect(actor.organizationId).toBe("own_org");
    expect(warn).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
  });

  it("refuses a URL naming another tenant's organization, and says so in the log", async () => {
    await expect(workspacePageActor("someone_elses_org")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toBe("workspace.access.denied");
    expect(fields()).toMatchObject({
      operation: "workspacePageActor",
      category: "ORGANIZATION_NOT_FOUND",
      stage: "organization_unavailable",
      actorId: "user_1",
      organizationId: "someone_elses_org",
    });
  });

  it("logs the refusal with ids only — no email, name, cookie or token", async () => {
    await expect(workspacePageActor("someone_elses_org")).rejects.toThrow("NEXT_NOT_FOUND");
    // Assert the line exists before asserting what is absent from it: an empty
    // `{}` contains no email either, so without this the check would pass with
    // the logging deleted.
    expect(warn).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(fields());
    for (const forbidden of ["owner@example.test", "Owner", "cookie", "token", "password"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("logs the separate case of a membership that no longer carries a role", async () => {
    state.role = null;
    await expect(workspacePageActor("own_org")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(fields()).toMatchObject({
      category: "ORGANIZATION_ROLE_MISSING",
      stage: "role_unavailable",
      organizationId: "own_org",
    });
  });

  it("sends an unauthenticated visitor to the login page instead of logging a refusal", async () => {
    signedInUser = null;
    await expect(workspacePageActor(undefined, "/workspaces/w1")).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirect).toHaveBeenCalledWith("/login?next=%2Fworkspaces%2Fw1");
    // An anonymous visit is not a refusal to audit: logging one would put a line
    // in the log for every crawler that finds a Workspace URL.
    expect(warn).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
  });
});
