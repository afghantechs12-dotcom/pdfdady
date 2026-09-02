import { beforeEach, describe, expect, it } from "vitest";
import { OperationCenterService } from "./OperationCenterService";
import type { ActorContext, WorkspaceService } from "./WorkspaceService";
import type { ILogger, LogFields } from "@/src/application/ports/Logger";
import { COMMAND_LIMITS } from "@/src/domain/entities/CommandPalette";
import { DomainError, NotFoundError } from "@/src/domain/errors";

class TestLogger implements ILogger {
  readonly entries: Array<{ level: string; message: string; fields?: LogFields }> = [];
  debug(message: string, fields?: LogFields): void {
    this.entries.push({ level: "debug", message, fields });
  }
  info(message: string, fields?: LogFields): void {
    this.entries.push({ level: "info", message, fields });
  }
  warn(message: string, fields?: LogFields): void {
    this.entries.push({ level: "warn", message, fields });
  }
  error(message: string, fields?: LogFields): void {
    this.entries.push({ level: "error", message, fields });
  }
  child(): ILogger {
    return this;
  }
}

const ORG = "org-alpha";
const ORG_OTHER = "org-beta";
const WS_A = "ws-alpha";
const WS_B = "ws-beta";
const WS_FOREIGN = "ws-foreign";

function actor(userId: string, organizationId = ORG): ActorContext {
  return {
    userId,
    organizationId,
    organizationRole: "member",
    organizationDefaultWorkspaceId: null,
  };
}

/**
 * A Workspace service double that enforces the same precedence the real one
 * does: unknown or cross-organization Workspaces read as missing, and a viewer
 * is refused a write. Tests that assert authorization would prove nothing
 * against a double that always allows.
 */
class FakeWorkspaceService {
  private readonly grants = new Map<string, Map<string, "owner" | "editor" | "viewer">>();
  private readonly orgOf = new Map<string, string>();

  addWorkspace(workspaceId: string, organizationId = ORG): void {
    this.orgOf.set(workspaceId, organizationId);
    if (!this.grants.has(workspaceId)) this.grants.set(workspaceId, new Map());
  }
  grant(workspaceId: string, userId: string, role: "owner" | "editor" | "viewer" = "editor"): void {
    if (!this.grants.has(workspaceId)) this.addWorkspace(workspaceId);
    this.grants.get(workspaceId)!.set(userId, role);
  }
  async get(a: ActorContext, workspaceId: string, write = false) {
    const organizationId = this.orgOf.get(workspaceId);
    if (!organizationId) throw new NotFoundError("Workspace not found.");
    if (organizationId !== a.organizationId) throw new NotFoundError("Workspace not found.");
    const role = this.grants.get(workspaceId)?.get(a.userId);
    if (!role) throw new NotFoundError("Workspace not found.");
    if (write && role === "viewer") throw new DomainError("Write access required.");
    return { workspace: { id: workspaceId, organizationId }, role } as unknown as Awaited<
      ReturnType<WorkspaceService["get"]>
    >;
  }
}

/** A clock the test advances explicitly, so ordering assertions are not racy. */
class TestClock {
  private current = new Date("2026-08-04T09:00:00.000Z").getTime();
  now = (): Date => new Date(this.current);
  advance(ms: number): void {
    this.current += ms;
  }
}

interface Harness {
  service: OperationCenterService;
  workspaces: FakeWorkspaceService;
  clock: TestClock;
  logger: TestLogger;
}

function harness(): Harness {
  const workspaces = new FakeWorkspaceService();
  const clock = new TestClock();
  const logger = new TestLogger();

  workspaces.addWorkspace(WS_A, ORG);
  workspaces.addWorkspace(WS_B, ORG);
  workspaces.addWorkspace(WS_FOREIGN, ORG_OTHER);
  workspaces.grant(WS_A, "user-owner", "owner");
  workspaces.grant(WS_A, "user-viewer", "viewer");
  workspaces.grant(WS_B, "user-owner", "owner");
  workspaces.grant(WS_FOREIGN, "user-outsider", "owner");

  const service = new OperationCenterService(
    logger,
    workspaces as unknown as WorkspaceService,
    clock.now,
  );
  return { service, workspaces, clock, logger };
}

async function startOne(h: Harness, workspaceId = WS_A, label = "Exporting report") {
  return h.service.start(actor("user-owner"), {
    type: "export",
    workspaceId,
    documentId: "doc-1",
    label,
  });
}

describe("OperationCenterService — starting work", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("starts a real pending operation", async () => {
    const operation = await startOne(h);
    expect(operation.status).toBe("pending");
    expect(operation.type).toBe("export");
    expect(operation.label).toBe("Exporting report");
  });

  it("issues distinct UUID-backed ids", async () => {
    const first = await startOne(h);
    const second = await startOne(h);
    expect(first.id).not.toBe(second.id);
    // A real UUID, not a counter: ids are handed to clients and a predictable
    // one would let a caller guess at another operation.
    expect(first.id).toMatch(
      /^op-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
  });

  it("requires a usable label", async () => {
    await expect(
      h.service.start(actor("user-owner"), { type: "export", workspaceId: WS_A, label: "  " }),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(
      h.service.start(actor("user-owner"), {
        type: "export",
        workspaceId: WS_A,
        label: "x".repeat(COMMAND_LIMITS.maxLabelLength + 1),
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("requires a usable type", async () => {
    await expect(
      h.service.start(actor("user-owner"), { type: "", workspaceId: WS_A, label: "Work" }),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(
      h.service.start(actor("user-owner"), {
        type: "x".repeat(COMMAND_LIMITS.maxIdLength + 1),
        workspaceId: WS_A,
        label: "Work",
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("records the Workspace and document context", async () => {
    const operation = await startOne(h);
    expect(operation.workspaceId).toBe(WS_A);
    expect(operation.documentId).toBe("doc-1");
  });

  it("requires write access to start", async () => {
    await expect(
      h.service.start(actor("user-viewer"), {
        type: "export",
        workspaceId: WS_A,
        label: "Exporting",
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("starts at zero progress", async () => {
    expect((await startOne(h)).progress).toBe(0);
  });
});

describe("OperationCenterService — transitions", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("moves pending to running", async () => {
    const operation = await startOne(h);
    expect(h.service.markRunning(operation.id)?.status).toBe("running");
  });

  it("refuses a duplicate running transition", async () => {
    const operation = await startOne(h);
    expect(h.service.markRunning(operation.id)).not.toBeNull();
    // A second delivery of the same start event finds the state already moved.
    expect(h.service.markRunning(operation.id)).toBeNull();
  });

  it("reports progress while running", async () => {
    const operation = await startOne(h);
    h.service.markRunning(operation.id);
    expect(h.service.reportProgress(operation.id, 42)?.progress).toBe(42);
  });

  it("rejects progress outside the allowed range", async () => {
    const operation = await startOne(h);
    h.service.markRunning(operation.id);
    expect(() => h.service.reportProgress(operation.id, -1)).toThrow(DomainError);
    expect(() => h.service.reportProgress(operation.id, 101)).toThrow(DomainError);
    expect(() => h.service.reportProgress(operation.id, Number.NaN)).toThrow(DomainError);
  });

  it("ignores progress reported after the operation finished", async () => {
    const operation = await startOne(h);
    h.service.markRunning(operation.id);
    h.service.complete(operation.id, "result-1");
    // A late worker cannot animate an operation the user already saw finish.
    expect(h.service.reportProgress(operation.id, 50)).toBeNull();
  });

  it("completes at full progress", async () => {
    const operation = await startOne(h);
    h.service.markRunning(operation.id);
    const completed = h.service.complete(operation.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.progress).toBe(100);
  });

  it("retains the result reference of a completed operation", async () => {
    const operation = await startOne(h);
    h.service.markRunning(operation.id);
    expect(h.service.complete(operation.id, "export-42")?.resultRef).toBe("export-42");
  });

  it("offers no result when a completed operation carries none", async () => {
    const operation = await startOne(h);
    h.service.markRunning(operation.id);
    h.service.complete(operation.id);
    // An interrupted worker can produce exactly this state; handing back a
    // reference that is not there would open an empty result.
    await expect(
      h.service.getResultRef(actor("user-owner"), WS_A, operation.id),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("fails with a bounded reason", async () => {
    const operation = await startOne(h);
    h.service.markRunning(operation.id);
    const failed = h.service.fail(operation.id, "x".repeat(COMMAND_LIMITS.maxErrorLength + 500));
    expect(failed?.status).toBe("failed");
    expect([...(failed?.error ?? "")]).toHaveLength(COMMAND_LIMITS.maxErrorLength);
  });

  it("cannot be resurrected by a late terminal event", async () => {
    const operation = await startOne(h);
    h.service.markRunning(operation.id);
    h.service.fail(operation.id, "Network unavailable.");
    // The duplicate delivery is refused, and the operation the user saw fail
    // does not later report success.
    expect(h.service.complete(operation.id, "result-1")).toBeNull();
    const current = await h.service.get(actor("user-owner"), WS_A, operation.id);
    expect(current.status).toBe("failed");
    expect(current.resultRef).toBeNull();
  });
});

describe("OperationCenterService — cancel and retry", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("cancels a pending operation", async () => {
    const operation = await startOne(h);
    const cancelled = await h.service.cancel(actor("user-owner"), WS_A, operation.id);
    expect(cancelled.status).toBe("cancelled");
  });

  it("cancels a running operation", async () => {
    const operation = await startOne(h);
    h.service.markRunning(operation.id);
    expect((await h.service.cancel(actor("user-owner"), WS_A, operation.id)).status).toBe(
      "cancelled",
    );
  });

  it("refuses a viewer's cancellation", async () => {
    const operation = await startOne(h);
    await expect(
      h.service.cancel(actor("user-viewer"), WS_A, operation.id),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("refuses to cancel finished work", async () => {
    const operation = await startOne(h);
    h.service.markRunning(operation.id);
    h.service.complete(operation.id, "result-1");
    await expect(
      h.service.cancel(actor("user-owner"), WS_A, operation.id),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("retries by creating a new operation", async () => {
    const operation = await startOne(h);
    h.service.markRunning(operation.id);
    h.service.fail(operation.id, "Timed out.");

    const retried = await h.service.retry(actor("user-owner"), WS_A, operation.id);
    expect(retried.id).not.toBe(operation.id);
    expect(retried.status).toBe("pending");
    expect(retried.type).toBe(operation.type);
    expect(retried.label).toBe(operation.label);
  });

  it("preserves the original failure after a retry", async () => {
    const operation = await startOne(h);
    h.service.markRunning(operation.id);
    h.service.fail(operation.id, "Timed out.");
    await h.service.retry(actor("user-owner"), WS_A, operation.id);

    // Rewriting the terminal state would erase the fact that the work failed,
    // and that history is what tells a user the problem is recurring.
    const original = await h.service.get(actor("user-owner"), WS_A, operation.id);
    expect(original.status).toBe("failed");
    expect(original.error).toBe("Timed out.");
  });

  it("refuses to retry work that is still active", async () => {
    const operation = await startOne(h);
    h.service.markRunning(operation.id);
    await expect(h.service.retry(actor("user-owner"), WS_A, operation.id)).rejects.toBeInstanceOf(
      DomainError,
    );
  });
});

describe("OperationCenterService — reads and scoping", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("re-authorizes every listing", async () => {
    await startOne(h);
    await expect(h.service.list(actor("user-outsider"), WS_A)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("lists only the requested Workspace's operations", async () => {
    const inA = await startOne(h, WS_A, "In A");
    await startOne(h, WS_B, "In B");

    const listed = await h.service.list(actor("user-owner"), WS_A);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(inA.id);
  });

  it("does not confirm an operation from another Workspace", async () => {
    const inB = await startOne(h, WS_B, "In B");
    // Scoped rather than merely filtered: an id must not confirm work the actor
    // is not entitled to see, so it reads as missing.
    await expect(h.service.get(actor("user-owner"), WS_A, inB.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("re-authorizes result access", async () => {
    const operation = await startOne(h);
    h.service.markRunning(operation.id);
    h.service.complete(operation.id, "export-7");
    await expect(
      h.service.getResultRef(actor("user-outsider"), WS_A, operation.id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a result before the operation completed", async () => {
    const operation = await startOne(h);
    h.service.markRunning(operation.id);
    await expect(
      h.service.getResultRef(actor("user-owner"), WS_A, operation.id),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("returns the result reference of a completed operation", async () => {
    const operation = await startOne(h);
    h.service.markRunning(operation.id);
    h.service.complete(operation.id, "export-7");
    expect(await h.service.getResultRef(actor("user-owner"), WS_A, operation.id)).toBe("export-7");
  });
});

describe("OperationCenterService — history bounds and isolation", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("bounds retained history", async () => {
    for (let index = 0; index < COMMAND_LIMITS.maxOperationHistory + 20; index += 1) {
      h.clock.advance(1000);
      const operation = await startOne(h, WS_A, `Job ${index}`);
      h.service.markRunning(operation.id);
      h.service.complete(operation.id, `result-${index}`);
    }
    const listed = await h.service.list(actor("user-owner"), WS_A);
    expect(listed.length).toBeLessThanOrEqual(COMMAND_LIMITS.maxOperationHistory);
  });

  it("never drops active work to make room", async () => {
    // Started first, so a naive oldest-first eviction would take it: it is also
    // the operation the user is actually waiting on.
    const active = await startOne(h, WS_A, "Long running import");
    h.service.markRunning(active.id);

    for (let index = 0; index < COMMAND_LIMITS.maxOperationHistory + 20; index += 1) {
      h.clock.advance(1000);
      const operation = await startOne(h, WS_A, `Job ${index}`);
      h.service.markRunning(operation.id);
      h.service.complete(operation.id, `result-${index}`);
    }

    const listed = await h.service.list(actor("user-owner"), WS_A);
    expect(listed.some((operation) => operation.id === active.id)).toBe(true);
    // Active work sorts first, so it stays visible rather than being buried.
    expect(listed[0].id).toBe(active.id);
  });

  it("forgets one Workspace without touching another", async () => {
    const inA = await startOne(h, WS_A, "In A");
    const inB = await startOne(h, WS_B, "In B");

    h.service.forgetWorkspace(WS_A);

    await expect(h.service.get(actor("user-owner"), WS_A, inA.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect((await h.service.get(actor("user-owner"), WS_B, inB.id)).id).toBe(inB.id);
  });

  it("hands out copies a caller cannot use to reach stored state", async () => {
    const operation = await startOne(h);
    const listed = await h.service.list(actor("user-owner"), WS_A);

    listed[0].status = "completed";
    listed[0].label = "Tampered";
    listed[0].createdAt.setFullYear(1999);

    const stored = await h.service.get(actor("user-owner"), WS_A, operation.id);
    expect(stored.status).toBe("pending");
    expect(stored.label).toBe("Exporting report");
    expect(stored.createdAt.getFullYear()).toBe(2026);
  });
});
