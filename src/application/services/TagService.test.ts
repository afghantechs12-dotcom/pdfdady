import { describe, expect, it } from "vitest";
import { TagService } from "./TagService";
import type { ActorContext, WorkspaceService } from "./WorkspaceService";
import type { ILogger, LogFields } from "@/src/application/ports/Logger";
import type {
  DocumentRecordListQuery,
  DocumentRecordRepository,
} from "@/src/application/ports/workspaces/DocumentRecordRepository";
import type {
  DocumentRecord,
  DocumentRecordLifecycleState,
} from "@/src/domain/entities/DocumentRecord";
import { TAG_LIMITS } from "@/src/domain/entities/Tag";
import { SMART_COLLECTION_LIMITS } from "@/src/domain/entities/SmartCollection";
import { InMemoryTagRepository } from "@/src/infrastructure/persistence/InMemoryTagRepository";
import { InMemoryDocumentTagRepository } from "@/src/infrastructure/persistence/InMemoryDocumentTagRepository";
import { InMemorySmartCollectionRepository } from "@/src/infrastructure/persistence/InMemorySmartCollectionRepository";
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

function actor(userId: string, organizationId = ORG): ActorContext {
  return {
    userId,
    organizationId,
    organizationRole: "member",
    organizationDefaultWorkspaceId: null,
  };
}

/**
 * Authorization double. It keeps the three refusals distinct that the service
 * must keep distinct: a Workspace in another organization is *missing* (so a
 * probe cannot confirm it exists), a non-member is refused, and a viewer is
 * refused only for writes.
 */
class FakeWorkspaceService {
  private readonly grants = new Map<string, Map<string, "admin" | "editor" | "viewer">>();
  private readonly orgOf = new Map<string, string>();

  addWorkspace(workspaceId: string, organizationId = ORG): void {
    this.orgOf.set(workspaceId, organizationId);
    if (!this.grants.has(workspaceId)) this.grants.set(workspaceId, new Map());
  }
  grant(workspaceId: string, userId: string, role: "admin" | "editor" | "viewer" = "editor"): void {
    if (!this.grants.has(workspaceId)) this.addWorkspace(workspaceId);
    this.grants.get(workspaceId)!.set(userId, role);
  }
  async get(a: ActorContext, workspaceId: string, write = false) {
    const organizationId = this.orgOf.get(workspaceId);
    if (!organizationId) throw new NotFoundError("Workspace not found.");
    if (organizationId !== a.organizationId) throw new NotFoundError("Workspace not found.");
    const role = this.grants.get(workspaceId)?.get(a.userId);
    if (!role) throw new DomainError("You are not a member of this workspace.");
    if (write && role === "viewer") throw new DomainError("Write access required.");
    return { workspace: { id: workspaceId, organizationId }, role } as unknown as Awaited<
      ReturnType<WorkspaceService["get"]>
    >;
  }
}

interface DocumentSeed {
  id: string;
  workspaceId: string;
  name?: string;
  lifecycleState?: DocumentRecordLifecycleState;
  favorite?: boolean;
  projectId?: string | null;
  folderId?: string | null;
  createdById?: string;
  createdAt?: Date;
  updatedAt?: Date;
  organizationId?: string;
}

class FakeDocumentRecordRepository {
  private readonly docs = new Map<string, DocumentRecord>();

  add(seed: DocumentSeed): void {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const name = seed.name ?? `${seed.id}.pdf`;
    this.docs.set(`${seed.workspaceId}:${seed.id}`, {
      id: seed.id,
      workspaceId: seed.workspaceId,
      organizationId: seed.organizationId ?? ORG,
      projectId: seed.projectId ?? null,
      folderId: seed.folderId ?? null,
      name,
      normalizedName: name.toLowerCase(),
      lifecycleState: seed.lifecycleState ?? "active",
      orderKey: "a0",
      currentVersionId: null,
      favorite: seed.favorite ?? false,
      lastAccessedAt: null,
      createdById: seed.createdById ?? "user-1",
      revision: 1,
      createdAt: seed.createdAt ?? now,
      updatedAt: seed.updatedAt ?? now,
      archivedAt: null,
      trashedAt: null,
      archivedById: null,
      trashedById: null,
    });
  }

  async getById(workspaceId: string, documentId: string): Promise<DocumentRecord | null> {
    const doc = this.docs.get(`${workspaceId}:${documentId}`);
    return doc ? { ...doc } : null;
  }

  async list(
    query: DocumentRecordListQuery,
  ): Promise<{ items: DocumentRecord[]; nextCursor: string | null }> {
    const items = [...this.docs.values()]
      .filter((doc) => doc.workspaceId === query.workspaceId)
      .sort((a, b) => a.normalizedName.localeCompare(b.normalizedName))
      .slice(0, query.limit)
      .map((doc) => ({ ...doc }));
    return { items, nextCursor: null };
  }
}

function harness(options: { maxTagsPerWorkspace?: number } = {}) {
  const logger = new TestLogger();
  const workspaces = new FakeWorkspaceService();
  const documents = new FakeDocumentRecordRepository();
  const tags = new InMemoryTagRepository();
  const documentTags = new InMemoryDocumentTagRepository();
  const collections = new InMemorySmartCollectionRepository();

  workspaces.addWorkspace(WS_A, ORG);
  workspaces.addWorkspace(WS_B, ORG_OTHER);
  workspaces.grant(WS_A, "user-1", "editor");
  workspaces.grant(WS_A, "user-2", "editor");
  workspaces.grant(WS_A, "viewer-1", "viewer");
  workspaces.grant(WS_B, "user-3", "editor");

  const service = new TagService(
    logger,
    workspaces as unknown as WorkspaceService,
    documents as unknown as DocumentRecordRepository,
    tags,
    documentTags,
    collections,
    options,
  );

  return { service, logger, workspaces, documents, tags, documentTags, collections };
}

/** A minimal valid query: every document whose name contains the given term. */
function nameQuery(term: string) {
  return {
    version: 1,
    root: { mode: "all", conditions: [{ field: "name", operator: "contains", value: term }] },
  };
}

describe("TagService — tag lifecycle", () => {
  it("creates a Workspace-scoped tag carrying the authorizing Workspace's organization", async () => {
    const { service } = harness();
    const tag = await service.createTag(actor("user-1"), WS_A, { name: "Contract" });

    expect(tag.workspaceId).toBe(WS_A);
    expect(tag.organizationId).toBe(ORG);
    expect(tag.createdById).toBe("user-1");
    expect(tag.revision).toBe(1);
  });

  it("normalizes the tag name deterministically while preserving the display form", async () => {
    const { service } = harness();
    const tag = await service.createTag(actor("user-1"), WS_A, { name: "  Legal   Review  " });

    expect(tag.name).toBe("Legal Review");
    expect(tag.normalizedName).toBe("legal review");
  });

  it("rejects a duplicate normalized name in the same Workspace", async () => {
    const { service } = harness();
    await service.createTag(actor("user-1"), WS_A, { name: "Contract" });

    // Differs only by case and whitespace, which normalization folds away.
    await expect(service.createTag(actor("user-1"), WS_A, { name: "  CONTRACT " })).rejects.toThrow();
  });

  it("allows the same name in a different Workspace", async () => {
    const { service } = harness();
    const first = await service.createTag(actor("user-1"), WS_A, { name: "Contract" });
    const second = await service.createTag(actor("user-3", ORG_OTHER), WS_B, { name: "Contract" });

    expect(second.id).not.toBe(first.id);
    expect(second.workspaceId).toBe(WS_B);
  });

  it("rejects an empty or whitespace-only name", async () => {
    const { service } = harness();
    await expect(service.createTag(actor("user-1"), WS_A, { name: "   " })).rejects.toThrow(
      DomainError,
    );
  });

  it("rejects a name longer than the domain bound", async () => {
    const { service } = harness();
    const tooLong = "a".repeat(TAG_LIMITS.maxNameLength + 1);
    await expect(service.createTag(actor("user-1"), WS_A, { name: tooLong })).rejects.toThrow(
      DomainError,
    );
  });

  it("rejects a colour that is not a hex triplet", async () => {
    const { service } = harness();
    await expect(
      service.createTag(actor("user-1"), WS_A, { name: "Contract", color: "red; content:evil" }),
    ).rejects.toThrow(DomainError);
  });

  it("enforces the per-Workspace tag cap", async () => {
    const { service } = harness({ maxTagsPerWorkspace: 2 });
    await service.createTag(actor("user-1"), WS_A, { name: "One" });
    await service.createTag(actor("user-1"), WS_A, { name: "Two" });

    await expect(service.createTag(actor("user-1"), WS_A, { name: "Three" })).rejects.toThrow(
      DomainError,
    );
  });

  it("lists only the authorizing Workspace's tags", async () => {
    const { service } = harness();
    await service.createTag(actor("user-1"), WS_A, { name: "Alpha" });
    await service.createTag(actor("user-3", ORG_OTHER), WS_B, { name: "Beta" });

    const listed = await service.listTags(actor("user-1"), WS_A);
    expect(listed.map((tag) => tag.name)).toEqual(["Alpha"]);
  });

  it("renames a tag under optimistic concurrency", async () => {
    const { service } = harness();
    const tag = await service.createTag(actor("user-1"), WS_A, { name: "Draft" });
    const renamed = await service.updateTag(actor("user-1"), WS_A, tag.id, tag.revision, {
      name: "Final",
    });

    expect(renamed.name).toBe("Final");
    expect(renamed.normalizedName).toBe("final");
    expect(renamed.revision).toBe(tag.revision + 1);
  });

  it("rejects an update carrying a stale revision", async () => {
    const { service } = harness();
    const tag = await service.createTag(actor("user-1"), WS_A, { name: "Draft" });
    await service.updateTag(actor("user-1"), WS_A, tag.id, tag.revision, { name: "Second" });

    await expect(
      service.updateTag(actor("user-2"), WS_A, tag.id, tag.revision, { name: "Third" }),
    ).rejects.toThrow(DomainError);
  });

  it("deletes a tag and every assignment to it", async () => {
    const { service, documents, documentTags } = harness();
    documents.add({ id: "doc-1", workspaceId: WS_A });
    const tag = await service.createTag(actor("user-1"), WS_A, { name: "Temp" });
    await service.assignTag(actor("user-1"), WS_A, "doc-1", tag.id);

    await service.deleteTag(actor("user-1"), WS_A, tag.id);

    expect(await service.listTags(actor("user-1"), WS_A)).toEqual([]);
    expect(await documentTags.countForTag(WS_A, tag.id)).toBe(0);
  });
});

describe("TagService — authorization", () => {
  it("refuses a mutation by a viewer", async () => {
    const { service } = harness();
    await expect(service.createTag(actor("viewer-1"), WS_A, { name: "Contract" })).rejects.toThrow(
      DomainError,
    );
  });

  it("permits a viewer to list tags", async () => {
    const { service } = harness();
    await service.createTag(actor("user-1"), WS_A, { name: "Contract" });

    const listed = await service.listTags(actor("viewer-1"), WS_A);
    expect(listed).toHaveLength(1);
  });

  it("refuses a non-member of the Workspace", async () => {
    const { service } = harness();
    await expect(service.listTags(actor("stranger"), WS_A)).rejects.toThrow(DomainError);
  });

  it("reports a Workspace in another organization as missing rather than forbidden", async () => {
    const { service } = harness();
    // user-1 belongs to ORG; WS_B belongs to ORG_OTHER. A Forbidden here would
    // confirm the Workspace exists.
    await expect(service.listTags(actor("user-1"), WS_B)).rejects.toThrow(NotFoundError);
  });

  it("reports a tag id from another Workspace as missing", async () => {
    const { service } = harness();
    const foreign = await service.createTag(actor("user-3", ORG_OTHER), WS_B, { name: "Foreign" });

    await expect(
      service.updateTag(actor("user-1"), WS_A, foreign.id, 1, { name: "Stolen" }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("TagService — document assignment", () => {
  it("persists an assignment as a real row", async () => {
    const { service, documents, documentTags } = harness();
    documents.add({ id: "doc-1", workspaceId: WS_A });
    const tag = await service.createTag(actor("user-1"), WS_A, { name: "Contract" });

    const assignment = await service.assignTag(actor("user-1"), WS_A, "doc-1", tag.id);

    expect(assignment.documentId).toBe("doc-1");
    expect(assignment.tagId).toBe(tag.id);
    expect(assignment.assignedById).toBe("user-1");
    expect(await documentTags.isAssigned(WS_A, "doc-1", tag.id)).toBe(true);
  });

  it("treats a repeated assignment as idempotent rather than as a duplicate", async () => {
    const { service, documents, documentTags } = harness();
    documents.add({ id: "doc-1", workspaceId: WS_A });
    const tag = await service.createTag(actor("user-1"), WS_A, { name: "Contract" });

    const first = await service.assignTag(actor("user-1"), WS_A, "doc-1", tag.id);
    const second = await service.assignTag(actor("user-2"), WS_A, "doc-1", tag.id);

    expect(second.id).toBe(first.id);
    expect(await documentTags.countForDocument(WS_A, "doc-1")).toBe(1);
  });

  it("removes an assignment", async () => {
    const { service, documents, documentTags } = harness();
    documents.add({ id: "doc-1", workspaceId: WS_A });
    const tag = await service.createTag(actor("user-1"), WS_A, { name: "Contract" });
    await service.assignTag(actor("user-1"), WS_A, "doc-1", tag.id);

    await service.removeTag(actor("user-1"), WS_A, "doc-1", tag.id);
    expect(await documentTags.isAssigned(WS_A, "doc-1", tag.id)).toBe(false);
  });

  it("treats a repeated removal as idempotent", async () => {
    const { service, documents } = harness();
    documents.add({ id: "doc-1", workspaceId: WS_A });
    const tag = await service.createTag(actor("user-1"), WS_A, { name: "Contract" });
    await service.assignTag(actor("user-1"), WS_A, "doc-1", tag.id);

    await service.removeTag(actor("user-1"), WS_A, "doc-1", tag.id);
    await expect(service.removeTag(actor("user-1"), WS_A, "doc-1", tag.id)).resolves.toBeUndefined();
  });

  it("refuses to assign a tag to a document in another Workspace", async () => {
    const { service, documents } = harness();
    // The document exists, but in WS_B — addressing it through WS_A must fail.
    documents.add({ id: "doc-b", workspaceId: WS_B, organizationId: ORG_OTHER });
    const tag = await service.createTag(actor("user-1"), WS_A, { name: "Contract" });

    await expect(service.assignTag(actor("user-1"), WS_A, "doc-b", tag.id)).rejects.toThrow(
      NotFoundError,
    );
  });

  it("refuses to assign a tag from another Workspace to a local document", async () => {
    const { service, documents } = harness();
    documents.add({ id: "doc-1", workspaceId: WS_A });
    const foreign = await service.createTag(actor("user-3", ORG_OTHER), WS_B, { name: "Foreign" });

    await expect(service.assignTag(actor("user-1"), WS_A, "doc-1", foreign.id)).rejects.toThrow(
      NotFoundError,
    );
  });

  it("reports a missing document without disclosing whether it exists elsewhere", async () => {
    const { service } = harness();
    const tag = await service.createTag(actor("user-1"), WS_A, { name: "Contract" });

    await expect(service.assignTag(actor("user-1"), WS_A, "doc-nowhere", tag.id)).rejects.toThrow(
      NotFoundError,
    );
  });

  it("refuses to tag a trashed document", async () => {
    const { service, documents } = harness();
    documents.add({ id: "doc-trashed", workspaceId: WS_A, lifecycleState: "trashed" });
    const tag = await service.createTag(actor("user-1"), WS_A, { name: "Contract" });

    await expect(service.assignTag(actor("user-1"), WS_A, "doc-trashed", tag.id)).rejects.toThrow(
      DomainError,
    );
  });

  it("refuses to tag an archived document", async () => {
    const { service, documents } = harness();
    documents.add({ id: "doc-archived", workspaceId: WS_A, lifecycleState: "archived" });
    const tag = await service.createTag(actor("user-1"), WS_A, { name: "Contract" });

    await expect(service.assignTag(actor("user-1"), WS_A, "doc-archived", tag.id)).rejects.toThrow(
      DomainError,
    );
  });

  it("lists a document's tags scoped to the Workspace", async () => {
    const { service, documents } = harness();
    documents.add({ id: "doc-1", workspaceId: WS_A });
    const alpha = await service.createTag(actor("user-1"), WS_A, { name: "Alpha" });
    const beta = await service.createTag(actor("user-1"), WS_A, { name: "Beta" });
    await service.createTag(actor("user-1"), WS_A, { name: "Unassigned" });
    await service.assignTag(actor("user-1"), WS_A, "doc-1", alpha.id);
    await service.assignTag(actor("user-1"), WS_A, "doc-1", beta.id);

    const listed = await service.listDocumentTags(actor("user-1"), WS_A, "doc-1");
    expect(listed.map((tag) => tag.name).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("reports a missing document when listing its tags", async () => {
    const { service } = harness();
    await expect(service.listDocumentTags(actor("user-1"), WS_A, "doc-nowhere")).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe("TagService — bulk operations", () => {
  it("assigns tags across several documents", async () => {
    const { service, documents, documentTags } = harness();
    documents.add({ id: "doc-1", workspaceId: WS_A });
    documents.add({ id: "doc-2", workspaceId: WS_A });
    const tag = await service.createTag(actor("user-1"), WS_A, { name: "Batch" });

    const result = await service.bulkAssignTags(actor("user-1"), WS_A, {
      documentIds: ["doc-1", "doc-2"],
      tagIds: [tag.id],
    });

    expect(result.succeeded).toEqual(["doc-1", "doc-2"]);
    expect(result.failed).toEqual([]);
    expect(await documentTags.countForTag(WS_A, tag.id)).toBe(2);
  });

  it("rejects a bulk request naming more documents than the bound allows", async () => {
    const { service } = harness();
    const tag = await service.createTag(actor("user-1"), WS_A, { name: "Batch" });
    const documentIds = Array.from(
      { length: TAG_LIMITS.maxBulkDocuments + 1 },
      (_, index) => `doc-${index}`,
    );

    await expect(
      service.bulkAssignTags(actor("user-1"), WS_A, { documentIds, tagIds: [tag.id] }),
    ).rejects.toThrow(DomainError);
  });

  it("rejects a bulk request naming more tags than the bound allows", async () => {
    const { service, documents } = harness();
    documents.add({ id: "doc-1", workspaceId: WS_A });
    const tagIds = Array.from({ length: TAG_LIMITS.maxBulkTags + 1 }, (_, i) => `tag-${i}`);

    await expect(
      service.bulkAssignTags(actor("user-1"), WS_A, { documentIds: ["doc-1"], tagIds }),
    ).rejects.toThrow(DomainError);
  });

  it("reports partial failures honestly instead of failing the whole batch", async () => {
    const { service, documents } = harness();
    documents.add({ id: "doc-ok", workspaceId: WS_A });
    documents.add({ id: "doc-trashed", workspaceId: WS_A, lifecycleState: "trashed" });
    const tag = await service.createTag(actor("user-1"), WS_A, { name: "Batch" });

    const result = await service.bulkAssignTags(actor("user-1"), WS_A, {
      documentIds: ["doc-ok", "doc-trashed", "doc-missing"],
      tagIds: [tag.id],
    });

    expect(result.succeeded).toEqual(["doc-ok"]);
    expect(result.failed.map((entry) => entry.documentId).sort()).toEqual([
      "doc-missing",
      "doc-trashed",
    ]);
    expect(result.failed.every((entry) => entry.error.length > 0)).toBe(true);
  });

  it("bulk-removes tags from several documents", async () => {
    const { service, documents, documentTags } = harness();
    documents.add({ id: "doc-1", workspaceId: WS_A });
    documents.add({ id: "doc-2", workspaceId: WS_A });
    const tag = await service.createTag(actor("user-1"), WS_A, { name: "Batch" });
    await service.bulkAssignTags(actor("user-1"), WS_A, {
      documentIds: ["doc-1", "doc-2"],
      tagIds: [tag.id],
    });

    const result = await service.bulkRemoveTags(actor("user-1"), WS_A, {
      documentIds: ["doc-1", "doc-2"],
      tagIds: [tag.id],
    });

    expect(result.succeeded).toEqual(["doc-1", "doc-2"]);
    expect(await documentTags.countForTag(WS_A, tag.id)).toBe(0);
  });

  it("refuses a bulk operation naming a tag from another Workspace", async () => {
    const { service, documents } = harness();
    documents.add({ id: "doc-1", workspaceId: WS_A });
    const foreign = await service.createTag(actor("user-3", ORG_OTHER), WS_B, { name: "Foreign" });

    await expect(
      service.bulkAssignTags(actor("user-1"), WS_A, {
        documentIds: ["doc-1"],
        tagIds: [foreign.id],
      }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("TagService — smart collection definitions", () => {
  it("creates a collection from a validated query", async () => {
    const { service } = harness();
    const collection = await service.createSmartCollection(actor("user-1"), WS_A, {
      name: "Contracts",
      query: nameQuery("contract"),
    });

    expect(collection.workspaceId).toBe(WS_A);
    expect(collection.queryVersion).toBe(SMART_COLLECTION_LIMITS.queryVersion);
    expect(collection.queryDegraded).toBe(false);
    expect(collection.query.root.conditions).toHaveLength(1);
  });

  it("rejects a query carrying an unknown grammar version", async () => {
    const { service } = harness();
    await expect(
      service.createSmartCollection(actor("user-1"), WS_A, {
        name: "Future",
        query: { ...nameQuery("x"), version: 99 },
      }),
    ).rejects.toThrow(DomainError);
  });

  it("rejects a query naming a field outside the allowlist", async () => {
    const { service } = harness();
    await expect(
      service.createSmartCollection(actor("user-1"), WS_A, {
        name: "Sneaky",
        query: {
          version: 1,
          root: {
            mode: "all",
            conditions: [{ field: "ownerPasswordHash", operator: "eq", value: "x" }],
          },
        },
      }),
    ).rejects.toThrow(DomainError);
  });

  it("rejects an operator the field does not support", async () => {
    const { service } = harness();
    await expect(
      service.createSmartCollection(actor("user-1"), WS_A, {
        name: "Bad operator",
        // `name` supports `contains`, never `range`.
        query: {
          version: 1,
          root: {
            mode: "all",
            conditions: [{ field: "name", operator: "range", from: "2026-01-01" }],
          },
        },
      }),
    ).rejects.toThrow(DomainError);
  });

  it("rejects nesting deeper than the depth cap", async () => {
    const { service } = harness();
    let group: Record<string, unknown> = {
      mode: "all",
      conditions: [{ field: "name", operator: "contains", value: "x" }],
    };
    for (let depth = 0; depth < SMART_COLLECTION_LIMITS.maxDepth + 1; depth += 1) {
      group = { mode: "all", groups: [group] };
    }

    await expect(
      service.createSmartCollection(actor("user-1"), WS_A, {
        name: "Deep",
        query: { version: 1, root: group },
      }),
    ).rejects.toThrow(DomainError);
  });

  it("rejects more conditions than the condition cap allows", async () => {
    const { service } = harness();
    const conditions = Array.from(
      { length: SMART_COLLECTION_LIMITS.maxConditions + 1 },
      (_, index) => ({ field: "name", operator: "contains", value: `term-${index}` }),
    );

    await expect(
      service.createSmartCollection(actor("user-1"), WS_A, {
        name: "Wide",
        query: { version: 1, root: { mode: "all", conditions } },
      }),
    ).rejects.toThrow(DomainError);
  });

  it("rejects an unbounded string in a condition value", async () => {
    const { service } = harness();
    const value = "a".repeat(SMART_COLLECTION_LIMITS.maxTermLength + 1);

    await expect(
      service.createSmartCollection(actor("user-1"), WS_A, {
        name: "Long term",
        query: nameQuery(value),
      }),
    ).rejects.toThrow(DomainError);
  });

  it("rejects a payload that is not a query object at all", async () => {
    const { service } = harness();
    for (const payload of ["1=1", null, [], 42, { version: 1 }]) {
      await expect(
        service.createSmartCollection(actor("user-1"), WS_A, {
          name: `Junk ${String(payload)}`,
          query: payload,
        }),
      ).rejects.toThrow(DomainError);
    }
  });

  it("stores the canonical parsed query rather than the caller's object", async () => {
    const { service, collections } = harness();
    const collection = await service.createSmartCollection(actor("user-1"), WS_A, {
      name: "Canonical",
      query: {
        version: 1,
        root: {
          mode: "all",
          conditions: [{ field: "name", operator: "contains", value: "spec", extra: "smuggled" }],
        },
        unknownTopLevel: "smuggled",
      },
    });

    const reloaded = await collections.getById(WS_A, collection.id);
    const serialized = JSON.stringify(reloaded?.query ?? {});
    expect(serialized).not.toContain("smuggled");
    expect(serialized).not.toContain("unknownTopLevel");
  });

  it("updates a collection under optimistic concurrency and rejects a stale revision", async () => {
    const { service } = harness();
    const collection = await service.createSmartCollection(actor("user-1"), WS_A, {
      name: "Contracts",
      query: nameQuery("contract"),
    });

    const updated = await service.updateSmartCollection(
      actor("user-1"),
      WS_A,
      collection.id,
      collection.revision,
      { name: "Signed contracts" },
    );
    expect(updated.name).toBe("Signed contracts");
    expect(updated.revision).toBe(collection.revision + 1);

    await expect(
      service.updateSmartCollection(actor("user-2"), WS_A, collection.id, collection.revision, {
        name: "Conflicting",
      }),
    ).rejects.toThrow(DomainError);
  });

  it("deletes an authorized collection and refuses a viewer's delete", async () => {
    const { service } = harness();
    const collection = await service.createSmartCollection(actor("user-1"), WS_A, {
      name: "Temp",
      query: nameQuery("x"),
    });

    await expect(
      service.deleteSmartCollection(actor("viewer-1"), WS_A, collection.id),
    ).rejects.toThrow(DomainError);

    await service.deleteSmartCollection(actor("user-1"), WS_A, collection.id);
    expect(await service.listSmartCollections(actor("user-1"), WS_A)).toEqual([]);
  });

  it("reports a collection from another Workspace as missing", async () => {
    const { service } = harness();
    const foreign = await service.createSmartCollection(actor("user-3", ORG_OTHER), WS_B, {
      name: "Foreign",
      query: nameQuery("x"),
    });

    await expect(
      service.evaluateSmartCollection(actor("user-1"), WS_A, foreign.id),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("TagService — smart collection evaluation", () => {
  it("evaluates membership from real document records", async () => {
    const { service, documents } = harness();
    documents.add({ id: "doc-1", workspaceId: WS_A, name: "Contract A.pdf" });
    documents.add({ id: "doc-2", workspaceId: WS_A, name: "Invoice B.pdf" });
    const collection = await service.createSmartCollection(actor("user-1"), WS_A, {
      name: "Contracts",
      query: nameQuery("contract"),
    });

    const evaluated = await service.evaluateSmartCollection(actor("user-1"), WS_A, collection.id);
    expect(evaluated.documentIds).toEqual(["doc-1"]);
    expect(evaluated.total).toBe(1);
  });

  it("re-evaluates membership dynamically as tag data changes", async () => {
    const { service, documents } = harness();
    documents.add({ id: "doc-1", workspaceId: WS_A });
    documents.add({ id: "doc-2", workspaceId: WS_A });
    const tag = await service.createTag(actor("user-1"), WS_A, { name: "Urgent" });
    const collection = await service.createSmartCollection(actor("user-1"), WS_A, {
      name: "Urgent work",
      query: {
        version: 1,
        root: { mode: "all", conditions: [{ field: "tags", operator: "in", value: [tag.id] }] },
      },
    });

    const before = await service.evaluateSmartCollection(actor("user-1"), WS_A, collection.id);
    expect(before.documentIds).toEqual([]);

    // No write to the collection: membership follows the assignment.
    await service.assignTag(actor("user-1"), WS_A, "doc-2", tag.id);

    const after = await service.evaluateSmartCollection(actor("user-1"), WS_A, collection.id);
    expect(after.documentIds).toEqual(["doc-2"]);
  });

  it("requires every named tag for an `in` tag condition", async () => {
    const { service, documents } = harness();
    documents.add({ id: "doc-both", workspaceId: WS_A });
    documents.add({ id: "doc-one", workspaceId: WS_A });
    const alpha = await service.createTag(actor("user-1"), WS_A, { name: "Alpha" });
    const beta = await service.createTag(actor("user-1"), WS_A, { name: "Beta" });
    await service.assignTag(actor("user-1"), WS_A, "doc-both", alpha.id);
    await service.assignTag(actor("user-1"), WS_A, "doc-both", beta.id);
    await service.assignTag(actor("user-1"), WS_A, "doc-one", alpha.id);

    const preview = await service.previewSmartCollectionQuery(actor("user-1"), WS_A, {
      version: 1,
      root: {
        mode: "all",
        conditions: [{ field: "tags", operator: "in", value: [alpha.id, beta.id] }],
      },
    });

    expect(preview.documentIds).toEqual(["doc-both"]);
  });

  it("never returns a document id from another Workspace", async () => {
    const { service, documents } = harness();
    documents.add({ id: "doc-a", workspaceId: WS_A, name: "Shared name.pdf" });
    documents.add({
      id: "doc-b",
      workspaceId: WS_B,
      name: "Shared name.pdf",
      organizationId: ORG_OTHER,
    });
    const collection = await service.createSmartCollection(actor("user-1"), WS_A, {
      name: "Shared",
      query: nameQuery("shared"),
    });

    const evaluated = await service.evaluateSmartCollection(actor("user-1"), WS_A, collection.id);
    expect(evaluated.documentIds).toEqual(["doc-a"]);
  });

  it("combines conditions with `any` as a disjunction", async () => {
    const { service, documents } = harness();
    documents.add({ id: "doc-fav", workspaceId: WS_A, name: "Alpha.pdf", favorite: true });
    documents.add({ id: "doc-named", workspaceId: WS_A, name: "Contract.pdf" });
    documents.add({ id: "doc-neither", workspaceId: WS_A, name: "Invoice.pdf" });

    const preview = await service.previewSmartCollectionQuery(actor("user-1"), WS_A, {
      version: 1,
      root: {
        mode: "any",
        conditions: [
          { field: "favorite", operator: "eq", value: true },
          { field: "name", operator: "contains", value: "contract" },
        ],
      },
    });

    expect([...preview.documentIds].sort()).toEqual(["doc-fav", "doc-named"]);
  });

  it("matches a date range against real record timestamps", async () => {
    const { service, documents } = harness();
    documents.add({
      id: "doc-old",
      workspaceId: WS_A,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    documents.add({
      id: "doc-new",
      workspaceId: WS_A,
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
    });

    const preview = await service.previewSmartCollectionQuery(actor("user-1"), WS_A, {
      version: 1,
      root: {
        mode: "all",
        conditions: [{ field: "createdAt", operator: "range", from: "2026-06-01T00:00:00.000Z" }],
      },
    });

    expect(preview.documentIds).toEqual(["doc-new"]);
  });

  it("honours the query's own result limit", async () => {
    const { service, documents } = harness();
    for (let index = 0; index < 5; index += 1) {
      documents.add({ id: `doc-${index}`, workspaceId: WS_A, name: `Report ${index}.pdf` });
    }

    const preview = await service.previewSmartCollectionQuery(actor("user-1"), WS_A, {
      version: 1,
      root: { mode: "all", conditions: [{ field: "name", operator: "contains", value: "report" }] },
      limit: 2,
    });

    expect(preview.documentIds).toHaveLength(2);
    expect(preview.total).toBe(2);
  });

  it("evaluates an unreadable stored definition to nothing rather than to everything", async () => {
    const { service, documents, collections } = harness();
    documents.add({ id: "doc-1", workspaceId: WS_A });
    documents.add({ id: "doc-2", workspaceId: WS_A });
    const collection = await service.createSmartCollection(actor("user-1"), WS_A, {
      name: "Corrupt",
      query: nameQuery("doc"),
    });

    // Corrupt the stored definition the way a bad write or an unknown grammar
    // version would. Failing closed is the point: a listing of every document in
    // the Workspace would be the worst possible degradation.
    await collections.update(WS_A, collection.id, collection.revision, {
      queryJson: "{ not json",
    });

    const evaluated = await service.evaluateSmartCollection(actor("user-1"), WS_A, collection.id);
    expect(evaluated.collection.queryDegraded).toBe(true);
    expect(evaluated.documentIds).toEqual([]);
  });

  it("rejects an invalid preview query without touching stored state", async () => {
    const { service, collections } = harness();
    await expect(
      service.previewSmartCollectionQuery(actor("user-1"), WS_A, { version: 1, root: {} }),
    ).rejects.toThrow(DomainError);
    expect(await collections.countForWorkspace(WS_A)).toBe(0);
  });

  it("refuses evaluation for a non-member", async () => {
    const { service } = harness();
    const collection = await service.createSmartCollection(actor("user-1"), WS_A, {
      name: "Contracts",
      query: nameQuery("contract"),
    });

    await expect(
      service.evaluateSmartCollection(actor("stranger"), WS_A, collection.id),
    ).rejects.toThrow(DomainError);
  });
});

describe("TagService — returned state is a copy", () => {
  it("does not let a caller mutating a returned tag reach repository state", async () => {
    const { service } = harness();
    const tag = await service.createTag(actor("user-1"), WS_A, { name: "Contract" });

    tag.name = "Mutated";
    tag.createdAt.setFullYear(1990);

    const [reloaded] = await service.listTags(actor("user-1"), WS_A);
    expect(reloaded.name).toBe("Contract");
    expect(reloaded.createdAt.getFullYear()).not.toBe(1990);
  });

  it("does not let a caller mutating a returned collection reach repository state", async () => {
    const { service } = harness();
    const collection = await service.createSmartCollection(actor("user-1"), WS_A, {
      name: "Contracts",
      query: nameQuery("contract"),
    });

    collection.query.root.conditions.length = 0;
    collection.updatedAt.setFullYear(1990);

    const [reloaded] = await service.listSmartCollections(actor("user-1"), WS_A);
    expect(reloaded.query.root.conditions).toHaveLength(1);
    expect(reloaded.updatedAt.getFullYear()).not.toBe(1990);
  });
});
