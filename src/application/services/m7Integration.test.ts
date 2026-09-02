import { beforeEach, describe, expect, it } from "vitest";
import { StatisticsService } from "@/src/application/services/StatisticsService";
import { TagService } from "@/src/application/services/TagService";
import { CommandPaletteService } from "@/src/application/services/CommandPaletteService";
import { OperationCenterService } from "@/src/application/services/OperationCenterService";
import {
  COMPARISON_JOB_TYPE,
  ComparisonJobHandler,
  isComparisonJobPayload,
} from "@/src/application/services/ComparisonJobHandler";
import { InMemoryDocumentVersionRepository } from "@/src/infrastructure/persistence/InMemoryDocumentVersionRepository";
import { InMemoryDocumentStatisticsRepository } from "@/src/infrastructure/persistence/InMemoryDocumentStatisticsRepository";
import { InMemoryComparisonOperationRepository } from "@/src/infrastructure/persistence/InMemoryComparisonOperationRepository";
import { InMemoryComparisonResultRepository } from "@/src/infrastructure/persistence/InMemoryComparisonResultRepository";
import { InMemoryTagRepository } from "@/src/infrastructure/persistence/InMemoryTagRepository";
import { InMemoryDocumentTagRepository } from "@/src/infrastructure/persistence/InMemoryDocumentTagRepository";
import { InMemorySmartCollectionRepository } from "@/src/infrastructure/persistence/InMemorySmartCollectionRepository";
import { InMemoryJobRepository } from "@/src/infrastructure/persistence/InMemoryJobRepository";
import { InMemoryQueue } from "@/src/infrastructure/queue/InMemoryQueue";
import { ConsoleLogger } from "@/src/infrastructure/logging/ConsoleLogger";
import { CANONICAL_COMMANDS } from "@/src/domain/entities/canonicalCommands";
import { DomainError, NotFoundError } from "@/src/domain/errors";
import type { ActorContext, WorkspaceService } from "@/src/application/services/WorkspaceService";
import type { DocumentRecord } from "@/src/domain/entities/DocumentRecord";
import type { DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";
import type { JobContext } from "@/src/application/ports/queue/Worker";
import type { Job } from "@/src/domain/entities/Job";

/**
 * M7.16 final integration.
 *
 * Real services and real in-memory adapters composed into whole flows. The point
 * is that state written by one subsystem is read back by another through its own
 * authorized path — a mock that returned the expected answer would prove that
 * the test knows the answer, not that the system works.
 */

const ORG_A = "org-alpha";
const ORG_B = "org-beta";
const WS_A = "ws-alpha";
const WS_B = "ws-beta";
const DOC_A = "doc-alpha";
const DOC_B = "doc-beta";

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

class IntegrationWorkspaceService {
  private readonly orgOf = new Map<string, string>();
  private readonly roles = new Map<string, Map<string, "owner" | "editor" | "viewer">>();

  add(workspaceId: string, organizationId: string): void {
    this.orgOf.set(workspaceId, organizationId);
    if (!this.roles.has(workspaceId)) this.roles.set(workspaceId, new Map());
  }
  grant(workspaceId: string, userId: string, role: "owner" | "editor" | "viewer"): void {
    this.roles.get(workspaceId)!.set(userId, role);
  }
  async get(a: ActorContext, workspaceId: string, write = false) {
    const organizationId = this.orgOf.get(workspaceId);
    if (!organizationId || organizationId !== a.organizationId) {
      throw new NotFoundError("Workspace not found.");
    }
    const role = this.roles.get(workspaceId)?.get(a.userId);
    if (!role) throw new NotFoundError("Workspace not found.");
    if (write && role === "viewer") throw new DomainError("Write access required.");
    return { workspace: { id: workspaceId, organizationId }, role } as unknown as Awaited<
      ReturnType<WorkspaceService["get"]>
    >;
  }
}

class IntegrationDocumentRepository {
  private readonly docs = new Map<string, DocumentRecord>();

  add(documentId: string, workspaceId: string, organizationId: string, favorite = false): void {
    const now = new Date("2026-06-01T00:00:00.000Z");
    this.docs.set(`${workspaceId}:${documentId}`, {
      id: documentId,
      workspaceId,
      organizationId,
      projectId: "project-1",
      folderId: "folder-1",
      name: `${documentId}.pdf`,
      normalizedName: `${documentId}.pdf`,
      lifecycleState: "active",
      orderKey: "a0",
      currentVersionId: null,
      favorite,
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

  async getById(workspaceId: string, documentId: string): Promise<DocumentRecord | null> {
    return this.docs.get(`${workspaceId}:${documentId}`) ?? null;
  }
  async list(query: { workspaceId: string }) {
    const items = [...this.docs.values()].filter((doc) => doc.workspaceId === query.workspaceId);
    return { items, nextCursor: null };
  }
  setFavorite(workspaceId: string, documentId: string, favorite: boolean): void {
    const doc = this.docs.get(`${workspaceId}:${documentId}`);
    if (doc) this.docs.set(`${workspaceId}:${documentId}`, { ...doc, favorite });
  }
}

function manifest(pageCount: number) {
  return JSON.stringify({
    schema: 1,
    sourceKey: "objects/source.pdf",
    sourceChecksum: "a".repeat(64),
    sourceByteSize: 2048,
    editorStateKey: null,
    editorStateChecksum: null,
    outputKey: null,
    outputChecksum: null,
    pageCount,
    thumbnailKeys: [],
  });
}

interface Harness {
  workspaces: IntegrationWorkspaceService;
  documents: IntegrationDocumentRepository;
  versions: InMemoryDocumentVersionRepository;
  statistics: StatisticsService;
  tags: TagService;
  commands: CommandPaletteService;
  operations: OperationCenterService;
  queue: InMemoryQueue;
  jobs: InMemoryJobRepository;
}

function harness(): Harness {
  const logger = new ConsoleLogger("error");
  const workspaces = new IntegrationWorkspaceService();
  const documents = new IntegrationDocumentRepository();

  workspaces.add(WS_A, ORG_A);
  workspaces.add(WS_B, ORG_B);
  workspaces.grant(WS_A, "user-owner", "owner");
  workspaces.grant(WS_A, "user-viewer", "viewer");
  workspaces.grant(WS_B, "user-outsider", "owner");

  documents.add(DOC_A, WS_A, ORG_A);
  documents.add(DOC_B, WS_B, ORG_B);

  const ws = workspaces as unknown as WorkspaceService;
  const docs = documents as unknown as DocumentRecordRepository;

  const versions = new InMemoryDocumentVersionRepository();

  const statistics = new StatisticsService(
    logger,
    ws,
    docs,
    versions,
    new InMemoryDocumentStatisticsRepository(),
    new InMemoryComparisonOperationRepository(),
    new InMemoryComparisonResultRepository(),
    { listForDocument: async () => [] } as never,
    { countForDocument: async () => 0 } as never,
    { countForDocument: async () => 0 } as never,
  );

  const tags = new TagService(
    logger,
    ws,
    docs,
    new InMemoryTagRepository(),
    new InMemoryDocumentTagRepository(),
    new InMemorySmartCollectionRepository(),
  );

  const commands = new CommandPaletteService(logger, ws, docs);
  commands.registerAll(CANONICAL_COMMANDS);

  const jobs = new InMemoryJobRepository();
  const queue = new InMemoryQueue(jobs, logger);

  return {
    workspaces,
    documents,
    versions,
    statistics,
    tags,
    commands,
    operations: new OperationCenterService(logger, ws),
    queue,
    jobs,
  };
}

async function makeVersion(h: Harness, revision: number, pageCount = 2) {
  return h.versions.create({
    workspaceId: WS_A,
    organizationId: ORG_A,
    documentId: DOC_A,
    revision,
    origin: "save",
    restoredFromVersionId: null,
    label: null,
    manifest: manifest(pageCount),
    checksum: String(revision).repeat(64).slice(0, 64),
    createdById: "user-owner",
  });
}

// ---- flow: versions ---------------------------------------------------------

describe("M7.16 — durable versions", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("creates immutable versions that a later save does not rewrite", async () => {
    const first = await makeVersion(h, 1);
    const second = await makeVersion(h, 2);

    expect(second.versionNumber).toBeGreaterThan(first.versionNumber);
    // The earlier version is still exactly what it was: a save adds history
    // rather than replacing it, which is what makes restore possible at all.
    const stored = await h.versions.getById(WS_A, first.id);
    expect(stored?.checksum).toBe(first.checksum);
    expect(stored?.versionNumber).toBe(first.versionNumber);
  });

  it("preserves an older version when a newer one is added", async () => {
    const first = await makeVersion(h, 1);
    await makeVersion(h, 2);
    await makeVersion(h, 3);

    const listed = await h.versions.list({ workspaceId: WS_A, documentId: DOC_A, limit: 50 });
    expect(listed.some((version) => version.id === first.id)).toBe(true);
    expect(listed).toHaveLength(3);
  });
});

// ---- flow: statistics -------------------------------------------------------

describe("M7.16 — statistics from trusted server content", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("calculates version-scoped statistics", async () => {
    const version = await makeVersion(h, 1);
    const stats = await h.statistics.calculateStatistics(OWNER, WS_A, DOC_A, version.id, {
      segments: [
        { pageNumber: 1, text: "one two three" },
        { pageNumber: 2, text: "four five" },
      ],
    });

    expect(stats.status).toBe("ready");
    expect(stats.counts.wordCount).toBe(5);
    expect(stats.versionId).toBe(version.id);
  });

  it("keeps statistics scoped to the version they were measured from", async () => {
    const first = await makeVersion(h, 1);
    const second = await makeVersion(h, 2);

    await h.statistics.calculateStatistics(OWNER, WS_A, DOC_A, first.id, {
      segments: [{ pageNumber: 1, text: "one two three" }],
    });
    await h.statistics.calculateStatistics(OWNER, WS_A, DOC_A, second.id, {
      segments: [{ pageNumber: 1, text: "one" }],
    });

    // Two versions, two independent measurements. Sharing one row would make a
    // document's statistics change when an unrelated version was measured.
    const forFirst = await h.statistics.getStatistics(OWNER, WS_A, DOC_A, first.id);
    const forSecond = await h.statistics.getStatistics(OWNER, WS_A, DOC_A, second.id);
    expect(forFirst?.counts.wordCount).toBe(3);
    expect(forSecond?.counts.wordCount).toBe(1);
  });

  it("distinguishes an unmeasured count from a measured zero", async () => {
    const version = await makeVersion(h, 1);
    const stats = await h.statistics.calculateStatistics(OWNER, WS_A, DOC_A, version.id, {
      segments: [{ pageNumber: 1, text: "one two" }],
    });

    // Nobody counted images, so the count is null rather than 0 — a document
    // nobody scanned must not claim it has no images.
    expect(stats.counts.wordCount).toBe(2);
    expect(stats.counts.imageCount).toBeNull();
  });
});

// ---- flow: comparison through the queue ------------------------------------

describe("M7.16 — comparison through the durable queue", () => {
  let h: Harness;
  let left: Awaited<ReturnType<typeof makeVersion>>;
  let right: Awaited<ReturnType<typeof makeVersion>>;

  beforeEach(async () => {
    h = harness();
    left = await makeVersion(h, 1, 2);
    right = await makeVersion(h, 2, 3);
  });

  function jobContext(cancelled = false): JobContext {
    return { progress: async () => undefined, isCancelled: () => cancelled };
  }

  function content(leftId: string, rightId: string) {
    return {
      left: { versionId: leftId, pages: new Map([[1, "one two"]]), pageCount: 2 },
      right: {
        versionId: rightId,
        pages: new Map([
          [1, "one two three"],
          [2, "new page"],
        ]),
        pageCount: 3,
      },
    };
  }

  function handler(target: Harness, leftId: string, rightId: string) {
    return new ComparisonJobHandler(
      new ConsoleLogger("error"),
      target.statistics,
      async () => content(leftId, rightId),
    );
  }

  async function enqueuedJob(target: Harness, comparisonId: string): Promise<Job> {
    await ComparisonJobHandler.enqueue(target.queue, WS_A, comparisonId);
    const job = await target.queue.pull(10);
    expect(job).not.toBeNull();
    return job!;
  }

  it("runs a comparison end to end through the queue boundary", async () => {
    const comparison = await h.statistics.createComparison(OWNER, WS_A, DOC_A, {
      leftVersionId: left.id,
      rightVersionId: right.id,
      type: "textual",
    });
    expect(comparison.status).toBe("pending");

    const job = await enqueuedJob(h, comparison.id);
    expect(job.type).toBe(COMPARISON_JOB_TYPE);

    await handler(h, left.id, right.id).handle(job, jobContext());

    const view = await h.statistics.getComparison(OWNER, WS_A, DOC_A, comparison.id);
    expect(view.operation.status).toBe("completed");
    expect(view.operation.progress).toBe(100);
    expect(view.result).not.toBeNull();
    // A textual comparison reports line-level additions and removals;
    // `pagesAdded` belongs to the structural comparison, and conflating the two
    // would describe a rewritten line as a new page.
    expect(view.result!.summary.added).toBeGreaterThan(0);
    expect(view.result!.differences.some((d) => d.kind === "added")).toBe(true);
  });

  it("converges when the same job is delivered twice", async () => {
    const comparison = await h.statistics.createComparison(OWNER, WS_A, DOC_A, {
      leftVersionId: left.id,
      rightVersionId: right.id,
      type: "textual",
    });
    const job = await enqueuedJob(h, comparison.id);
    const jobHandler = handler(h, left.id, right.id);

    await jobHandler.handle(job, jobContext());
    // At-least-once delivery is the queue's normal behaviour. The second
    // delivery must not produce a second result or fail work that succeeded.
    const second = await jobHandler.handle(job, jobContext());
    expect(second.result).toEqual({ status: "already-claimed" });

    const view = await h.statistics.getComparison(OWNER, WS_A, DOC_A, comparison.id);
    expect(view.operation.status).toBe("completed");
  });

  it("does not let a duplicate completion overwrite a terminal state", async () => {
    const comparison = await h.statistics.createComparison(OWNER, WS_A, DOC_A, {
      leftVersionId: left.id,
      rightVersionId: right.id,
      type: "textual",
    });
    const job = await enqueuedJob(h, comparison.id);
    await handler(h, left.id, right.id).handle(job, jobContext());

    // A late worker calling the trusted surface directly is refused by the state
    // machine, not by the handler.
    const late = await h.statistics.completeComparison(
      WS_A,
      comparison.id,
      content(left.id, right.id),
    );
    expect(late).toBeNull();
  });

  it("records a failure that remains retriable", async () => {
    const comparison = await h.statistics.createComparison(OWNER, WS_A, DOC_A, {
      leftVersionId: left.id,
      rightVersionId: right.id,
      type: "textual",
    });
    const job = await enqueuedJob(h, comparison.id);

    const failing = new ComparisonJobHandler(new ConsoleLogger("error"), h.statistics, async () => {
      throw new Error("Version content was unavailable.");
    });
    // Rethrown so the worker applies its retry policy; the comparison row records
    // the failure either way.
    await expect(failing.handle(job, jobContext())).rejects.toThrow(/unavailable/i);

    const view = await h.statistics.getComparison(OWNER, WS_A, DOC_A, comparison.id);
    expect(view.operation.status).toBe("failed");
    expect(view.operation.error).toContain("unavailable");

    const retried = await h.statistics.retryComparison(OWNER, WS_A, DOC_A, comparison.id);
    expect(retried.id).not.toBe(comparison.id);
    expect(retried.status).toBe("pending");
  });

  it("refuses a comparison whose delivered content names the wrong versions", async () => {
    const comparison = await h.statistics.createComparison(OWNER, WS_A, DOC_A, {
      leftVersionId: left.id,
      rightVersionId: right.id,
      type: "textual",
    });
    const job = await enqueuedJob(h, comparison.id);

    // A result filed against versions the operation did not name would be a
    // diff attributed to the wrong pair.
    await handler(h, right.id, left.id).handle(job, jobContext());
    const view = await h.statistics.getComparison(OWNER, WS_A, DOC_A, comparison.id);
    expect(view.operation.status).toBe("failed");
    expect(view.result).toBeNull();
  });

  it("does not deliver work that finished after a cancellation", async () => {
    const comparison = await h.statistics.createComparison(OWNER, WS_A, DOC_A, {
      leftVersionId: left.id,
      rightVersionId: right.id,
      type: "textual",
    });
    const job = await enqueuedJob(h, comparison.id);

    await h.statistics.startComparison(WS_A, comparison.id);
    await h.statistics.cancelComparison(OWNER, WS_A, DOC_A, comparison.id);

    // "Cancel" must not mean "cancel, unless it happened to finish first".
    const completed = await h.statistics.completeComparison(
      WS_A,
      comparison.id,
      content(left.id, right.id),
    );
    expect(completed?.status).toBe("cancelled");
    expect(completed?.resultId).toBeNull();
    expect(isComparisonJobPayload(job.payload)).toBe(true);
  });

  it("refuses a visual comparison honestly rather than pretending to run it", async () => {
    await expect(
      h.statistics.createComparison(OWNER, WS_A, DOC_A, {
        leftVersionId: left.id,
        rightVersionId: right.id,
        type: "visual",
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("rejects a malformed job payload without retrying it", async () => {
    const job = await h.queue.enqueue({ type: COMPARISON_JOB_TYPE, payload: { nonsense: true } });
    const pulled = await h.queue.pull(10);
    expect(pulled?.id).toBe(job.id);

    const outcome = await handler(h, left.id, right.id).handle(pulled!, jobContext());
    // Another attempt produces the same result and only occupies the queue.
    expect(outcome.result).toEqual({ status: "rejected" });
  });

  it("commits the job durably, so a lost dispatch is recoverable", async () => {
    const comparison = await h.statistics.createComparison(OWNER, WS_A, DOC_A, {
      leftVersionId: left.id,
      rightVersionId: right.id,
      type: "textual",
    });
    const enqueued = await ComparisonJobHandler.enqueue(h.queue, WS_A, comparison.id);

    // The job row exists independently of whether anything pulled it: a commit
    // that succeeded followed by a dispatch that did not is still recoverable.
    const stored = await h.jobs.get(enqueued.id);
    expect(stored).not.toBeNull();
    expect(stored?.type).toBe(COMPARISON_JOB_TYPE);
  });
});

// ---- flow: tags and smart collections ---------------------------------------

describe("M7.16 — tags and dynamic collections", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("changes collection membership as the underlying documents change", async () => {
    const collection = await h.tags.createSmartCollection(OWNER, WS_A, {
      name: "Favourites",
      query: {
        version: 1,
        root: { mode: "all", conditions: [{ field: "favorite", operator: "eq", value: true }] },
      },
    });

    const before = await h.tags.evaluateSmartCollection(OWNER, WS_A, collection.id);
    expect(before.documentIds).toHaveLength(0);

    h.documents.setFavorite(WS_A, DOC_A, true);

    // Dynamic, not a stored list: the collection is a query, so the same
    // collection answers differently once the document changed.
    const after = await h.tags.evaluateSmartCollection(OWNER, WS_A, collection.id);
    expect(after.documentIds).toContain(DOC_A);
  });

  it("assigns a tag and reads it back through the authorized path", async () => {
    const tag = await h.tags.createTag(OWNER, WS_A, { name: "Contract" });
    await h.tags.assignTag(OWNER, WS_A, DOC_A, tag.id);

    const assigned = await h.tags.listDocumentTags(OWNER, WS_A, DOC_A);
    expect(assigned.map((t) => t.id)).toContain(tag.id);
  });
});

// ---- flow: command palette --------------------------------------------------

describe("M7.16 — command palette against a live workspace", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  const context = {
    hasDocument: true,
    hasSelection: false,
    canWrite: true,
    isSplit: true,
    activePane: "right",
    activeDocumentId: DOC_A,
  };

  it("searches, then executes against the active pane's document", async () => {
    const results = h.commands.search("compare", context);
    expect(results[0].id).toBe("doc.compare");

    const executed = await h.commands.execute(OWNER, {
      commandId: "doc.compare",
      workspaceId: WS_A,
      documentId: DOC_A,
      paneId: "right",
    });
    // The pane the user is focused in, not a default: a command applied to the
    // wrong pane is worse than one that failed.
    expect(executed.paneId).toBe("right");
    expect(executed.documentId).toBe(DOC_A);
  });

  it("re-authorizes at execution even when the palette displayed the command", async () => {
    const shown = h.commands.search("save", context);
    expect(shown[0].enabled).toBe(true);

    await expect(
      h.commands.execute(VIEWER, {
        commandId: "doc.save",
        workspaceId: WS_A,
        documentId: DOC_A,
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });
});

// ---- flow: operation center -------------------------------------------------

describe("M7.16 — operation center lifecycle", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("carries an operation from start to a retrievable result", async () => {
    const started = await h.operations.start(OWNER, {
      type: "comparison",
      workspaceId: WS_A,
      documentId: DOC_A,
      label: "Comparing versions",
    });
    expect(started.status).toBe("pending");

    expect(h.operations.markRunning(started.id)?.status).toBe("running");
    expect(h.operations.reportProgress(started.id, 55)?.progress).toBe(55);
    expect(h.operations.complete(started.id, "comparison-result-1")?.progress).toBe(100);

    expect(await h.operations.getResultRef(OWNER, WS_A, started.id)).toBe("comparison-result-1");
  });

  it("cancels active work and retries finished work", async () => {
    const cancellable = await h.operations.start(OWNER, {
      type: "export",
      workspaceId: WS_A,
      label: "Exporting",
    });
    h.operations.markRunning(cancellable.id);
    const cancelled = await h.operations.cancel(OWNER, WS_A, cancellable.id);
    expect(cancelled.status).toBe("cancelled");

    const retried = await h.operations.retry(OWNER, WS_A, cancellable.id);
    expect(retried.id).not.toBe(cancellable.id);
    // The cancellation stays on the record: history is what tells a user the
    // problem is recurring.
    expect((await h.operations.get(OWNER, WS_A, cancellable.id)).status).toBe("cancelled");
  });

  it("keeps operations scoped to their Workspace", async () => {
    const mine = await h.operations.start(OWNER, {
      type: "export",
      workspaceId: WS_A,
      label: "Mine",
    });
    await h.operations.start(OUTSIDER, { type: "export", workspaceId: WS_B, label: "Theirs" });

    const listed = await h.operations.list(OWNER, WS_A);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(mine.id);
  });
});

// ---- flow: cross-tenant sweep -----------------------------------------------

describe("M7.16 — cross-tenant sweep across subsystems", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("gives no existence signal for a representative id from each subsystem", async () => {
    const version = await makeVersion(h, 1);
    const other = await makeVersion(h, 2);
    const comparison = await h.statistics.createComparison(OWNER, WS_A, DOC_A, {
      leftVersionId: version.id,
      rightVersionId: other.id,
      type: "textual",
    });
    const tag = await h.tags.createTag(OWNER, WS_A, { name: "Internal" });
    const operation = await h.operations.start(OWNER, {
      type: "export",
      workspaceId: WS_A,
      label: "Internal export",
    });

    // Every one of these ids is real. None of them may be reachable from the
    // other tenant, and none may report anything other than "not found".
    const probes = [
      () => h.statistics.getStatistics(OUTSIDER, WS_A, DOC_A, version.id),
      () => h.statistics.getComparison(OUTSIDER, WS_A, DOC_A, comparison.id),
      () => h.statistics.getComparisonResult(OUTSIDER, WS_A, DOC_A, comparison.id),
      () => h.tags.listDocumentTags(OUTSIDER, WS_A, DOC_A),
      () => h.tags.evaluateSmartCollection(OUTSIDER, WS_A, tag.id),
      () => h.operations.get(OUTSIDER, WS_A, operation.id),
      () => h.operations.getResultRef(OUTSIDER, WS_A, operation.id),
      () => h.commands.execute(OUTSIDER, { commandId: "doc.save", workspaceId: WS_A, documentId: DOC_A }),
      () => h.versions.list({ workspaceId: WS_B, documentId: DOC_A, limit: 10 }).then((v) => {
        expect(v).toHaveLength(0);
        throw new NotFoundError("Workspace not found.");
      }),
    ];

    for (const probe of probes) {
      await expect(probe()).rejects.toBeInstanceOf(NotFoundError);
    }
  });
});
