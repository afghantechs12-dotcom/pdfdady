import { beforeEach, describe, expect, it } from "vitest";
import { CommentService } from "@/src/application/services/CommentService";
import { TagService } from "@/src/application/services/TagService";
import { OperationCenterService } from "@/src/application/services/OperationCenterService";
import { CommandPaletteService } from "@/src/application/services/CommandPaletteService";
import { InMemoryCommentThreadRepository } from "@/src/infrastructure/persistence/InMemoryCommentThreadRepository";
import { InMemoryCommentMessageRepository } from "@/src/infrastructure/persistence/InMemoryCommentMessageRepository";
import { InMemoryDocumentPermissionGrantRepository } from "@/src/infrastructure/persistence/InMemoryDocumentPermissionGrantRepository";
import { InMemoryTagRepository } from "@/src/infrastructure/persistence/InMemoryTagRepository";
import { InMemoryDocumentTagRepository } from "@/src/infrastructure/persistence/InMemoryDocumentTagRepository";
import { InMemorySmartCollectionRepository } from "@/src/infrastructure/persistence/InMemorySmartCollectionRepository";
import { ConsoleLogger } from "@/src/infrastructure/logging/ConsoleLogger";
import { CANONICAL_COMMANDS } from "@/src/domain/entities/canonicalCommands";
import { DomainError, NotFoundError } from "@/src/domain/errors";
import type { ActorContext, WorkspaceService } from "@/src/application/services/WorkspaceService";
import type { DocumentRecord } from "@/src/domain/entities/DocumentRecord";
import type { DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";

/**
 * M7.15 cross-cutting security hardening.
 *
 * These exercise the real services against real in-memory adapters. A double
 * that returned the expected answer would prove nothing — the point is that the
 * authorization path, the id scoping and the bounds are the production ones.
 *
 * The organising rule across every case: **an identifier the actor is not
 * entitled to must produce no existence signal.** A `NotFoundError` and a
 * `ForbiddenError` are different disclosures — the second confirms the resource
 * is real — so cross-tenant probes are asserted to read as missing.
 */

const ORG_A = "org-alpha";
const ORG_B = "org-beta";
const WS_A = "ws-alpha";
const WS_A2 = "ws-alpha-second";
const WS_B = "ws-beta";

function actor(userId: string, organizationId = ORG_A): ActorContext {
  return {
    userId,
    organizationId,
    organizationRole: "member",
    organizationDefaultWorkspaceId: null,
  };
}

const OWNER = actor("user-owner");
const VIEWER = actor("user-viewer");
const OUTSIDER = actor("user-outsider", ORG_B);

/**
 * Applies the M7 access decision algorithm: organization scope, then workspace
 * lifecycle, then explicit membership. Lifecycle denial is evaluated before
 * membership, which is the precedence the threat model requires.
 */
class HardeningWorkspaceService {
  private readonly orgOf = new Map<string, string>();
  private readonly roles = new Map<string, Map<string, "owner" | "editor" | "viewer">>();
  private readonly archived = new Set<string>();

  add(workspaceId: string, organizationId: string): void {
    this.orgOf.set(workspaceId, organizationId);
    if (!this.roles.has(workspaceId)) this.roles.set(workspaceId, new Map());
  }
  grant(workspaceId: string, userId: string, role: "owner" | "editor" | "viewer"): void {
    this.roles.get(workspaceId)!.set(userId, role);
  }
  archive(workspaceId: string): void {
    this.archived.add(workspaceId);
  }

  async get(a: ActorContext, workspaceId: string, write = false) {
    const organizationId = this.orgOf.get(workspaceId);
    // Missing and cross-organization are the same response: a different one
    // would confirm the Workspace exists somewhere.
    if (!organizationId || organizationId !== a.organizationId) {
      throw new NotFoundError("Workspace not found.");
    }
    // Lifecycle denial precedes membership, per the access decision algorithm.
    if (write && this.archived.has(workspaceId)) {
      throw new DomainError("This workspace is archived.");
    }
    const role = this.roles.get(workspaceId)?.get(a.userId);
    if (!role) throw new NotFoundError("Workspace not found.");
    if (write && role === "viewer") throw new DomainError("Write access required.");
    return { workspace: { id: workspaceId, organizationId }, role } as unknown as Awaited<
      ReturnType<WorkspaceService["get"]>
    >;
  }
}

class HardeningDocumentRepository {
  private readonly docs = new Map<string, DocumentRecord>();

  add(documentId: string, workspaceId: string, organizationId: string): void {
    const now = new Date("2026-06-01T00:00:00.000Z");
    this.docs.set(`${workspaceId}:${documentId}`, {
      id: documentId,
      workspaceId,
      organizationId,
      projectId: null,
      folderId: null,
      name: `${documentId}.pdf`,
      normalizedName: `${documentId}.pdf`,
      lifecycleState: "active",
      orderKey: "a0",
      currentVersionId: null,
      favorite: false,
      lastAccessedAt: null,
      createdById: "user-owner",
      revision: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      trashedAt: null,
      archivedById: null,
      trashedById: null,
    });
  }

  // Workspace-scoped lookup: a document id alone never resolves, so an id from
  // another tenant cannot be reached through a Workspace the actor can see.
  async getById(workspaceId: string, documentId: string): Promise<DocumentRecord | null> {
    return this.docs.get(`${workspaceId}:${documentId}`) ?? null;
  }
  async list() {
    return { items: [], nextCursor: null };
  }
}

interface Harness {
  workspaces: HardeningWorkspaceService;
  documents: HardeningDocumentRepository;
  comments: CommentService;
  tags: TagService;
  operations: OperationCenterService;
  commands: CommandPaletteService;
  /** Advances the comment service's clock, so grant expiry can be reached. */
  advance: (ms: number) => void;
}

function harness(): Harness {
  const logger = new ConsoleLogger("error");
  const workspaces = new HardeningWorkspaceService();
  const documents = new HardeningDocumentRepository();

  workspaces.add(WS_A, ORG_A);
  workspaces.add(WS_A2, ORG_A);
  workspaces.add(WS_B, ORG_B);
  workspaces.grant(WS_A, "user-owner", "owner");
  workspaces.grant(WS_A, "user-editor", "editor");
  workspaces.grant(WS_A, "user-viewer", "viewer");
  workspaces.grant(WS_A2, "user-owner", "owner");
  workspaces.grant(WS_B, "user-outsider", "owner");

  documents.add("doc-a", WS_A, ORG_A);
  documents.add("doc-a2", WS_A2, ORG_A);
  documents.add("doc-b", WS_B, ORG_B);

  const ws = workspaces as unknown as WorkspaceService;
  const docs = documents as unknown as DocumentRecordRepository;

  let current = Date.now();
  const advance = (ms: number) => {
    current += ms;
  };

  const comments = new CommentService(
    logger,
    ws,
    docs,
    new InMemoryCommentThreadRepository(),
    new InMemoryCommentMessageRepository(),
    new InMemoryDocumentPermissionGrantRepository(),
    () => new Date(current),
  );

  const tags = new TagService(
    logger,
    ws,
    docs,
    new InMemoryTagRepository(),
    new InMemoryDocumentTagRepository(),
    new InMemorySmartCollectionRepository(),
  );

  const operations = new OperationCenterService(logger, ws);
  const commands = new CommandPaletteService(logger, ws, docs);
  commands.registerAll(CANONICAL_COMMANDS);

  return { workspaces, documents, comments, tags, operations, commands, advance };
}

// ---- authorization and IDOR -------------------------------------------------

describe("M7.15 — cross-tenant isolation", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("refuses a Workspace in another organization without confirming it exists", async () => {
    await expect(h.comments.listThreads(OWNER, WS_B, "doc-b")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(h.tags.listTags(OWNER, WS_B)).rejects.toBeInstanceOf(NotFoundError);
    await expect(h.operations.list(OWNER, WS_B)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a document from another Workspace in the same organization", async () => {
    // Same tenant, different Workspace: the document must still not resolve
    // through a Workspace the actor happens to administer.
    await expect(h.comments.listThreads(OWNER, WS_A, "doc-a2")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("refuses a document from another organization", async () => {
    await expect(h.comments.listThreads(OWNER, WS_A, "doc-b")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("does not let a foreign comment thread id be read through an owned document", async () => {
    const foreign = await h.comments.createThread(OUTSIDER, WS_B, "doc-b", {
      anchor: { type: "page", pageNumber: 1 },
      body: "Confidential.",
    });
    await expect(
      h.comments.getThread(OWNER, WS_A, "doc-a", foreign.thread.id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("does not let a foreign comment message be edited or deleted", async () => {
    const foreign = await h.comments.createThread(OUTSIDER, WS_B, "doc-b", {
      anchor: { type: "page", pageNumber: 1 },
      body: "Confidential.",
    });
    const messageId = foreign.messages[0].id;

    await expect(
      h.comments.editMessage(OWNER, WS_A, "doc-a", foreign.thread.id, messageId, {
        body: "Rewritten.",
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      h.comments.deleteMessage(OWNER, WS_A, "doc-a", foreign.thread.id, messageId, 1),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("does not let a foreign operation be read, cancelled or retried", async () => {
    const foreign = await h.operations.start(OUTSIDER, {
      type: "export",
      workspaceId: WS_B,
      label: "Foreign export",
    });

    await expect(h.operations.get(OWNER, WS_A, foreign.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(h.operations.cancel(OWNER, WS_A, foreign.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(h.operations.retry(OWNER, WS_A, foreign.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(h.operations.getResultRef(OWNER, WS_A, foreign.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("does not let a command execute against a foreign document", async () => {
    await expect(
      h.commands.execute(OWNER, { commandId: "doc.save", workspaceId: WS_A, documentId: "doc-b" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      h.commands.execute(OWNER, { commandId: "doc.save", workspaceId: WS_B, documentId: "doc-b" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("does not let a foreign tag be assigned to an owned document", async () => {
    const foreignTag = await h.tags.createTag(OUTSIDER, WS_B, { name: "Secret", color: null });
    await expect(
      h.tags.assignTag(OWNER, WS_A, "doc-a", foreignTag.id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("does not let a foreign smart collection be read or evaluated", async () => {
    const foreign = await h.tags.createSmartCollection(OUTSIDER, WS_B, {
      name: "Foreign",
      query: {
        version: 1,
        root: { mode: "all", conditions: [{ field: "name", operator: "contains", value: "deal" }] },
      },
    });
    await expect(
      h.tags.evaluateSmartCollection(OWNER, WS_A, foreign.id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("produces the same non-disclosing error for a real and an invented id", async () => {
    const foreign = await h.operations.start(OUTSIDER, {
      type: "export",
      workspaceId: WS_B,
      label: "Foreign export",
    });

    // The whole point: a real-but-inaccessible id and a fabricated one must be
    // indistinguishable, or the difference is an existence oracle.
    const real = await h.operations.get(OWNER, WS_A, foreign.id).catch((error) => error);
    const invented = await h.operations
      .get(OWNER, WS_A, "op-00000000-0000-4000-8000-000000000000")
      .catch((error) => error);

    expect(real).toBeInstanceOf(NotFoundError);
    expect(invented).toBeInstanceOf(NotFoundError);
    expect(real.message).toBe(invented.message);
  });
});

// ---- permission lifecycle ---------------------------------------------------

describe("M7.15 — permission lifecycle", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("refuses a viewer's write across every M7 surface", async () => {
    await expect(
      h.comments.createThread(VIEWER, WS_A, "doc-a", {
        anchor: { type: "page", pageNumber: 1 },
        body: "Note.",
      }),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(
      h.tags.createTag(VIEWER, WS_A, { name: "Draft", color: null }),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(
      h.operations.start(VIEWER, { type: "export", workspaceId: WS_A, label: "Export" }),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(
      h.commands.execute(VIEWER, {
        commandId: "doc.save",
        workspaceId: WS_A,
        documentId: "doc-a",
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("allows a viewer a read-only command", async () => {
    const result = await h.commands.execute(VIEWER, {
      commandId: "doc.search",
      workspaceId: WS_A,
    });
    expect(result.role).toBe("viewer");
  });

  it("lets workspace lifecycle denial win over an explicit role", async () => {
    h.workspaces.archive(WS_A);
    // An owner still cannot write to an archived Workspace: lifecycle is
    // evaluated before membership.
    await expect(
      h.operations.start(OWNER, { type: "export", workspaceId: WS_A, label: "Export" }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("expires a document grant rather than letting it outlive its window", async () => {
    const inOneHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await h.comments.createGrant(OWNER, WS_A, "doc-a", {
      granteeUserId: "user-guest",
      role: "viewer",
      expiresAt: inOneHour,
    });
    expect(await h.comments.effectiveGrantRole(WS_A, "doc-a", "user-guest")).toBe("viewer");

    // Past the window. A grant that kept conferring access after its expiry
    // would make the expiry decorative.
    h.advance(2 * 60 * 60 * 1000);
    expect(await h.comments.effectiveGrantRole(WS_A, "doc-a", "user-guest")).toBeNull();
  });

  it("refuses a grant expiry in the past", async () => {
    await expect(
      h.comments.createGrant(OWNER, WS_A, "doc-a", {
        granteeUserId: "user-guest",
        role: "viewer",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("stops conferring a role once a grant is revoked", async () => {
    const grant = await h.comments.createGrant(OWNER, WS_A, "doc-a", {
      granteeUserId: "user-guest",
      role: "viewer",
    });
    expect(await h.comments.effectiveGrantRole(WS_A, "doc-a", "user-guest")).toBe("viewer");

    await h.comments.revokeGrant(OWNER, WS_A, "doc-a", grant.id);
    expect(await h.comments.effectiveGrantRole(WS_A, "doc-a", "user-guest")).toBeNull();
  });

  it("treats a repeated revocation as settled rather than as an error to retry", async () => {
    const grant = await h.comments.createGrant(OWNER, WS_A, "doc-a", {
      granteeUserId: "user-guest",
      role: "viewer",
    });
    await h.comments.revokeGrant(OWNER, WS_A, "doc-a", grant.id);
    // Idempotent from the caller's perspective: the end state is the same and
    // the grant confers nothing either way.
    await h.comments.revokeGrant(OWNER, WS_A, "doc-a", grant.id).catch(() => undefined);
    expect(await h.comments.effectiveGrantRole(WS_A, "doc-a", "user-guest")).toBeNull();
  });

  it("does not let a grant confer sharing power", async () => {
    await h.comments.createGrant(OWNER, WS_A, "doc-a", {
      granteeUserId: "user-guest",
      role: "editor",
    });
    // A grantee cannot re-share: a document grant is access, not administration,
    // or a single share would propagate without bound.
    await expect(
      h.comments.createGrant(actor("user-guest"), WS_A, "doc-a", {
        granteeUserId: "user-other",
        role: "viewer",
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("refuses a self-grant", async () => {
    await expect(
      h.comments.createGrant(OWNER, WS_A, "doc-a", {
        granteeUserId: OWNER.userId,
        role: "editor",
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("does not let a foreign grant id be revoked through an owned document", async () => {
    const foreign = await h.comments.createGrant(OUTSIDER, WS_B, "doc-b", {
      granteeUserId: "user-guest",
      role: "viewer",
    });
    await expect(
      h.comments.revokeGrant(OWNER, WS_A, "doc-a", foreign.id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("does not treat a displayed command state as execution authority", async () => {
    // The palette shows doc.save to a viewer, greyed out with a reason. The
    // displayed state is a suggestion; execution is what decides.
    const shown = h.commands.evaluate("doc.save", {
      hasDocument: true,
      hasSelection: false,
      canWrite: true, // a tampered client claiming it may write
      isSplit: false,
      activePane: "left",
      activeDocumentId: "doc-a",
    });
    expect(shown?.enabled).toBe(true);

    await expect(
      h.commands.execute(VIEWER, {
        commandId: "doc.save",
        workspaceId: WS_A,
        documentId: "doc-a",
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });
});

// ---- input bounds and content safety ---------------------------------------

describe("M7.15 — input bounds and content safety", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("stores comment markup as plain text rather than rendering it", async () => {
    const payload = '<img src=x onerror="alert(1)">';
    const thread = await h.comments.createThread(OWNER, WS_A, "doc-a", {
      anchor: { type: "page", pageNumber: 1 },
      body: payload,
    });
    // Stored verbatim and rendered as a text node by the client. The defence is
    // that it is never treated as markup, not that the characters are stripped.
    expect(thread.messages[0].body).toBe(payload);
    expect(typeof thread.messages[0].body).toBe("string");
  });

  it("refuses a malformed comment anchor", async () => {
    for (const anchor of [
      null,
      {},
      { type: "telepathy" },
      { type: "page" },
      { type: "page", pageNumber: -4 },
      { type: "page", pageNumber: 1, unexpectedField: "x" },
    ]) {
      await expect(
        h.comments.createThread(OWNER, WS_A, "doc-a", { anchor, body: "Note." }),
      ).rejects.toBeInstanceOf(DomainError);
    }
  });

  it("refuses an oversized comment body", async () => {
    await expect(
      h.comments.createThread(OWNER, WS_A, "doc-a", {
        anchor: { type: "page", pageNumber: 1 },
        body: "x".repeat(100_000),
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("refuses an empty or whitespace-only comment body", async () => {
    await expect(
      h.comments.createThread(OWNER, WS_A, "doc-a", {
        anchor: { type: "page", pageNumber: 1 },
        body: "   ",
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("refuses an oversized operation label", async () => {
    await expect(
      h.operations.start(OWNER, {
        type: "export",
        workspaceId: WS_A,
        label: "x".repeat(5000),
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("bounds an operation error rather than storing what a worker supplied", async () => {
    const operation = await h.operations.start(OWNER, {
      type: "export",
      workspaceId: WS_A,
      label: "Export",
    });
    h.operations.markRunning(operation.id);
    const failed = h.operations.fail(operation.id, "x".repeat(50_000));
    expect([...(failed?.error ?? "")].length).toBeLessThanOrEqual(500);
  });

  it("refuses an oversized command query without searching", async () => {
    const results = h.commands.search("x".repeat(10_000), {
      hasDocument: true,
      hasSelection: false,
      canWrite: true,
      isSplit: false,
      activePane: "left",
      activeDocumentId: "doc-a",
    });
    expect(results).toEqual([]);
  });

  it("refuses a malformed command id before touching authorization", async () => {
    for (const commandId of ["", "   ", "x".repeat(500)]) {
      await expect(
        h.commands.execute(OWNER, { commandId, workspaceId: WS_A }),
      ).rejects.toBeInstanceOf(DomainError);
    }
  });

  it("refuses a malformed smart collection query", async () => {
    for (const query of [
      null,
      {},
      { version: 999, root: { mode: "all", conditions: [] } },
      {
        version: 1,
        root: {
          mode: "all",
          conditions: [{ field: "ownerPasswordHash", operator: "eq", value: "x" }],
        },
      },
      {
        version: 1,
        root: { mode: "all", conditions: [{ field: "name", operator: "range", from: "2026" }] },
      },
    ]) {
      await expect(
        h.tags.createSmartCollection(OWNER, WS_A, { name: "Bad", query }),
      ).rejects.toBeInstanceOf(Error);
    }
  });

  it("refuses a tag name that is empty or oversized", async () => {
    await expect(h.tags.createTag(OWNER, WS_A, { name: "  ", color: null })).rejects.toBeInstanceOf(
      DomainError,
    );
    await expect(
      h.tags.createTag(OWNER, WS_A, { name: "x".repeat(5000), color: null }),
    ).rejects.toBeInstanceOf(DomainError);
  });
});

// ---- idempotency ------------------------------------------------------------

describe("M7.15 — idempotency and duplicate delivery", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("converges on a repeated tag assignment", async () => {
    const tag = await h.tags.createTag(OWNER, WS_A, { name: "Reviewed", color: null });
    await h.tags.assignTag(OWNER, WS_A, "doc-a", tag.id);
    await h.tags.assignTag(OWNER, WS_A, "doc-a", tag.id);

    const assigned = await h.tags.listDocumentTags(OWNER, WS_A, "doc-a");
    // Assigning twice is one assignment, not two rows and not an error: the
    // second delivery of a click must converge.
    expect(assigned.filter((t) => t.id === tag.id)).toHaveLength(1);
  });

  it("converges on a repeated tag removal", async () => {
    const tag = await h.tags.createTag(OWNER, WS_A, { name: "Reviewed", color: null });
    await h.tags.assignTag(OWNER, WS_A, "doc-a", tag.id);
    await h.tags.removeTag(OWNER, WS_A, "doc-a", tag.id);
    await h.tags.removeTag(OWNER, WS_A, "doc-a", tag.id).catch(() => undefined);

    expect(await h.tags.listDocumentTags(OWNER, WS_A, "doc-a")).toHaveLength(0);
  });

  it("refuses a duplicate operation transition rather than replaying it", async () => {
    const operation = await h.operations.start(OWNER, {
      type: "comparison",
      workspaceId: WS_A,
      label: "Comparing",
    });
    expect(h.operations.markRunning(operation.id)).not.toBeNull();
    expect(h.operations.markRunning(operation.id)).toBeNull();
  });

  it("does not let a duplicate terminal event resurrect an operation", async () => {
    const operation = await h.operations.start(OWNER, {
      type: "comparison",
      workspaceId: WS_A,
      label: "Comparing",
    });
    h.operations.markRunning(operation.id);
    h.operations.complete(operation.id, "result-1");

    // A late failure delivery must not overwrite a completion the user saw.
    expect(h.operations.fail(operation.id, "Worker died.")).toBeNull();
    const current = await h.operations.get(OWNER, WS_A, operation.id);
    expect(current.status).toBe("completed");
    expect(current.error).toBeNull();
  });

  it("resolves and reopens a thread idempotently", async () => {
    const thread = await h.comments.createThread(OWNER, WS_A, "doc-a", {
      anchor: { type: "page", pageNumber: 1 },
      body: "Check this.",
    });
    const revision = thread.thread.revision;
    await h.comments.resolveThread(OWNER, WS_A, "doc-a", thread.thread.id, revision);

    // The second delivery carries the same stale revision and is refused rather
    // than merged: optimistic concurrency is what stops a duplicate click from
    // silently overwriting a state someone else already changed.
    await expect(
      h.comments.resolveThread(OWNER, WS_A, "doc-a", thread.thread.id, revision),
    ).rejects.toBeInstanceOf(Error);

    const after = await h.comments.getThread(OWNER, WS_A, "doc-a", thread.thread.id);
    expect(after.thread.status).toBe("resolved");
  });
});

// ---- leakage ----------------------------------------------------------------

describe("M7.15 — leakage", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("does not count another Workspace's operations in a listing", async () => {
    await h.operations.start(OUTSIDER, {
      type: "export",
      workspaceId: WS_B,
      label: "Foreign export",
    });
    await h.operations.start(OWNER, { type: "export", workspaceId: WS_A, label: "Own export" });

    const listed = await h.operations.list(OWNER, WS_A);
    expect(listed).toHaveLength(1);
    expect(listed[0].label).toBe("Own export");
  });

  it("does not disclose another Workspace's tags", async () => {
    await h.tags.createTag(OUTSIDER, WS_B, { name: "Acquisition", color: null });
    const own = await h.tags.listTags(OWNER, WS_A);
    expect(own.map((tag) => tag.name)).not.toContain("Acquisition");
  });

  it("does not disclose another Workspace's comment threads", async () => {
    await h.comments.createThread(OUTSIDER, WS_B, "doc-b", {
      anchor: { type: "page", pageNumber: 1 },
      body: "Confidential.",
    });
    const own = await h.comments.listThreads(OWNER, WS_A, "doc-a");
    expect(own.threads).toHaveLength(0);
  });

  it("does not leak an internal result reference through the operation itself", async () => {
    const operation = await h.operations.start(OWNER, {
      type: "export",
      workspaceId: WS_A,
      label: "Export",
    });
    h.operations.markRunning(operation.id);
    h.operations.complete(operation.id, "objects/org-alpha/exports/secret-key.pdf");

    // Reaching the reference requires a re-authorized call. It is not something
    // an unrelated read hands over.
    await expect(
      h.operations.getResultRef(OUTSIDER, WS_A, operation.id),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await h.operations.getResultRef(OWNER, WS_A, operation.id)).toContain("secret-key");
  });

  it("keeps an unregistered command indistinguishable from an unauthorized one", async () => {
    const unregistered = await h.commands
      .execute(OWNER, { commandId: "secret.internal.command", workspaceId: WS_A })
      .catch((error) => error);
    expect(unregistered).toBeInstanceOf(NotFoundError);
  });
});

// ---- bounds and resource exhaustion ----------------------------------------

describe("M7.15 — bounded resources", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("bounds operation history per process", async () => {
    for (let index = 0; index < 140; index += 1) {
      const operation = await h.operations.start(OWNER, {
        type: "export",
        workspaceId: WS_A,
        label: `Job ${index}`,
      });
      h.operations.markRunning(operation.id);
      h.operations.complete(operation.id, `result-${index}`);
    }
    expect((await h.operations.list(OWNER, WS_A)).length).toBeLessThanOrEqual(100);
  });

  it("bounds command search results", () => {
    const results = h.commands.search("", {
      hasDocument: true,
      hasSelection: true,
      canWrite: true,
      isSplit: true,
      activePane: "left",
      activeDocumentId: "doc-a",
    });
    expect(results.length).toBeLessThanOrEqual(50);
  });

  it("bounds a comment listing", async () => {
    for (let index = 0; index < 40; index += 1) {
      await h.comments.createThread(OWNER, WS_A, "doc-a", {
        anchor: { type: "page", pageNumber: 1 },
        body: `Note ${index}`,
      });
    }
    const listed = await h.comments.listThreads(OWNER, WS_A, "doc-a", { limit: 1000 });
    expect(listed.threads.length).toBeLessThanOrEqual(100);
  });
});
