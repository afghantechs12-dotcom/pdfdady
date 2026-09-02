import { describe, expect, it, vi } from "vitest";
import { NotFoundError, WorkspaceAccessError, WorkspaceLifecycleError } from "@/src/domain/errors";

const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
vi.mock("next/navigation", () => ({ notFound: () => notFound() }));

const { loadWorkspaceForRoute, routeOr404 } = await import("./workspaceRouteAccess");

const actor = {
  userId: "u1",
  organizationId: "o1",
  organizationRole: "owner" as const,
  organizationDefaultWorkspaceId: null,
};

function reader(result: Promise<never> | { workspace: { id: string }; role: string }) {
  return { get: () => (result instanceof Promise ? result : Promise.resolve(result)) } as never;
}

describe("loadWorkspaceForRoute", () => {
  it("passes a successful lookup straight through", async () => {
    const resolved = await loadWorkspaceForRoute(
      reader({ workspace: { id: "w1" }, role: "owner" }),
      actor,
      "w1",
    );
    expect(resolved.workspace.id).toBe("w1");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("turns every refusal category into one controlled not-found", async () => {
    for (const code of ["WORKSPACE_NOT_FOUND", "WORKSPACE_ACCESS_DENIED", "WORKSPACE_ID_INVALID"] as const) {
      notFound.mockClear();
      await expect(
        loadWorkspaceForRoute(reader(Promise.reject(new WorkspaceAccessError(code))), actor, "w1"),
      ).rejects.toThrow("NEXT_NOT_FOUND");
      expect(notFound).toHaveBeenCalledOnce();
    }
  });

  it("lets an infrastructure failure propagate instead of reporting 'no such Workspace'", async () => {
    notFound.mockClear();
    const outage = new Error("SQLITE_BUSY: database is locked");
    await expect(loadWorkspaceForRoute(reader(Promise.reject(outage)), actor, "w1")).rejects.toBe(outage);
    // A database outage rendered as a not-found would silently tell every user
    // their Workspaces are gone, which is why the mapping is by error type.
    expect(notFound).not.toHaveBeenCalled();
  });

  it("does not swallow an archived-Workspace refusal, which is not a not-found", async () => {
    notFound.mockClear();
    const lifecycle = new WorkspaceLifecycleError("archived");
    await expect(loadWorkspaceForRoute(reader(Promise.reject(lifecycle)), actor, "w1")).rejects.toBe(lifecycle);
    expect(notFound).not.toHaveBeenCalled();
  });
});

describe("routeOr404", () => {
  it("applies the same mapping to any route read, e.g. the document a URL names", async () => {
    notFound.mockClear();
    await expect(routeOr404(Promise.reject(new NotFoundError("Document not found.")))).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(notFound).toHaveBeenCalledOnce();
    await expect(routeOr404(Promise.resolve("value"))).resolves.toBe("value");
  });
});
