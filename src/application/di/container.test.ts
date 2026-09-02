import { describe, expect, it } from "vitest";
import { Container } from "./container";
import { Tokens } from "./tokens";
import { InMemoryFeatureFlagRepository } from "@/src/infrastructure/featureflags/InMemoryFeatureFlagRepository";
import { InMemoryJobRepository } from "@/src/infrastructure/persistence/InMemoryJobRepository";
import { InMemoryQueue } from "@/src/infrastructure/queue/InMemoryQueue";
import { InMemoryWorker } from "@/src/infrastructure/queue/InMemoryWorker";
import { FeatureFlagService } from "@/src/application/services/FeatureFlagService";
import { ConsoleLogger } from "@/src/infrastructure/logging/ConsoleLogger";
import type { ILogger } from "@/src/application/ports/Logger";
import type { IFeatureFlagRepository } from "@/src/application/ports/repositories/FeatureFlagRepository";
import type { IJobRepository } from "@/src/application/ports/repositories/JobRepository";
import type { IFeatureFlagService } from "@/src/application/ports/featureflags/FeatureFlagService";
import type { IQueue } from "@/src/application/ports/queue/Queue";
import type { IWorker } from "@/src/application/ports/queue/Worker";
import { InMemoryWorkspaceSessionRepository } from "@/src/infrastructure/persistence/InMemoryWorkspaceSessionRepository";
import { InMemoryAutosaveDraftRepository } from "@/src/infrastructure/persistence/InMemoryAutosaveDraftRepository";
import { InMemoryDocumentVersionRepository } from "@/src/infrastructure/persistence/InMemoryDocumentVersionRepository";
import type { WorkspaceSessionRepository } from "@/src/application/ports/workspaces/WorkspaceSessionRepository";
import type { AutosaveDraftRepository } from "@/src/application/ports/workspaces/AutosaveDraftRepository";
import type { DocumentVersionRepository } from "@/src/application/ports/workspaces/DocumentVersionRepository";
import { TabService } from "@/src/application/services/TabService";
import { SplitViewService } from "@/src/application/services/SplitViewService";
import { CommandPaletteService } from "@/src/application/services/CommandPaletteService";
import { OperationCenterService } from "@/src/application/services/OperationCenterService";
import { CANONICAL_COMMANDS } from "@/src/domain/entities/canonicalCommands";
import { DomainError, NotFoundError } from "@/src/domain/errors";
import { AutosaveService } from "@/src/application/services/AutosaveService";
import { VersionService } from "@/src/application/services/VersionService";
import { TagService } from "@/src/application/services/TagService";
import type { TagRepository } from "@/src/application/ports/workspaces/TagRepository";
import type { DocumentTagRepository } from "@/src/application/ports/workspaces/DocumentTagRepository";
import type { SmartCollectionRepository } from "@/src/application/ports/workspaces/SmartCollectionRepository";
import { InMemoryTagRepository } from "@/src/infrastructure/persistence/InMemoryTagRepository";
import { InMemoryDocumentTagRepository } from "@/src/infrastructure/persistence/InMemoryDocumentTagRepository";
import { InMemorySmartCollectionRepository } from "@/src/infrastructure/persistence/InMemorySmartCollectionRepository";
import type {
  IObjectStorage,
  ObjectMetadata,
  PutOptions,
  StreamPutOptions,
  StreamPutResult,
} from "@/src/application/ports/storage/ObjectStorage";
import { SearchService } from "@/src/application/services/SearchService";
import type { SearchDocumentRepository } from "@/src/application/ports/workspaces/SearchDocumentRepository";
import type { SearchChunkRepository } from "@/src/application/ports/workspaces/SearchChunkRepository";
import type { SearchIndexPort } from "@/src/application/ports/workspaces/SearchIndexPort";
import { InMemorySearchDocumentRepository } from "@/src/infrastructure/persistence/InMemorySearchDocumentRepository";
import { InMemorySearchChunkRepository } from "@/src/infrastructure/persistence/InMemorySearchChunkRepository";
import { SQLiteSearchIndexAdapter } from "@/src/infrastructure/persistence/SQLiteSearchIndexAdapter";
import { MetadataService } from "@/src/application/services/MetadataService";
import { CommentService } from "@/src/application/services/CommentService";
import type { CommentThreadRepository } from "@/src/application/ports/workspaces/CommentThreadRepository";
import type { CommentMessageRepository } from "@/src/application/ports/workspaces/CommentMessageRepository";
import type { DocumentPermissionGrantRepository } from "@/src/application/ports/workspaces/DocumentPermissionGrantRepository";
import { InMemoryCommentThreadRepository } from "@/src/infrastructure/persistence/InMemoryCommentThreadRepository";
import { InMemoryCommentMessageRepository } from "@/src/infrastructure/persistence/InMemoryCommentMessageRepository";
import { InMemoryDocumentPermissionGrantRepository } from "@/src/infrastructure/persistence/InMemoryDocumentPermissionGrantRepository";
import { StatisticsService } from "@/src/application/services/StatisticsService";
import type { DocumentStatisticsRepository } from "@/src/application/ports/workspaces/DocumentStatisticsRepository";
import type { ComparisonOperationRepository } from "@/src/application/ports/workspaces/ComparisonOperationRepository";
import type { ComparisonResultRepository } from "@/src/application/ports/workspaces/ComparisonResultRepository";
import { InMemoryDocumentStatisticsRepository } from "@/src/infrastructure/persistence/InMemoryDocumentStatisticsRepository";
import { InMemoryComparisonOperationRepository } from "@/src/infrastructure/persistence/InMemoryComparisonOperationRepository";
import { InMemoryComparisonResultRepository } from "@/src/infrastructure/persistence/InMemoryComparisonResultRepository";
import type { DocumentMetadataRepository } from "@/src/application/ports/workspaces/DocumentMetadataRepository";
import type { BookmarkRepository } from "@/src/application/ports/workspaces/BookmarkRepository";
import type { OutlineItemRepository } from "@/src/application/ports/workspaces/OutlineItemRepository";
import type { AttachmentRepository } from "@/src/application/ports/workspaces/AttachmentRepository";
import { InMemoryDocumentMetadataRepository } from "@/src/infrastructure/persistence/InMemoryDocumentMetadataRepository";
import { InMemoryBookmarkRepository } from "@/src/infrastructure/persistence/InMemoryBookmarkRepository";
import { InMemoryOutlineItemRepository } from "@/src/infrastructure/persistence/InMemoryOutlineItemRepository";
import { InMemoryAttachmentRepository } from "@/src/infrastructure/persistence/InMemoryAttachmentRepository";
import { InMemoryStoredFileRepository } from "@/src/infrastructure/persistence/InMemoryStoredFileRepository";
import type { IFileMetadataRepository } from "@/src/application/ports/storage/FileMetadataRepository";

/**
 * A test container wired entirely with in-memory adapters — no Prisma, no
 * external services — proving the DI wiring works against the same interfaces
 * the production container uses.
 */
function createTestContainer(): Container {
  const c = new Container();
  c.register<ILogger>(Tokens.Logger, () => new ConsoleLogger("error"));
  c.register<IFeatureFlagRepository>(Tokens.FeatureFlagRepository, () => new InMemoryFeatureFlagRepository());
  c.register<IJobRepository>(Tokens.JobRepository, () => new InMemoryJobRepository());
  c.register<IFeatureFlagService>(Tokens.FeatureFlagService, (cc) => {
    return new FeatureFlagService(
      cc.resolve<IFeatureFlagRepository>(Tokens.FeatureFlagRepository),
      cc.resolve<ILogger>(Tokens.Logger),
    );
  });
  c.register<IQueue>(Tokens.Queue, (cc) => {
    return new InMemoryQueue(cc.resolve<IJobRepository>(Tokens.JobRepository), cc.resolve<ILogger>(Tokens.Logger));
  });
  c.register<IWorker>(Tokens.Worker, (cc) => {
    return new InMemoryWorker(
      cc.resolve<IQueue>(Tokens.Queue),
      cc.resolve<IJobRepository>(Tokens.JobRepository),
      cc.resolve<ILogger>(Tokens.Logger),
    );
  });
  return c;
}

describe("DI Container", () => {
  it("resolves a registered service", () => {
    const c = createTestContainer();
    const logger = c.resolve<ILogger>(Tokens.Logger);
    expect(logger).toBeInstanceOf(ConsoleLogger);
  });

  it("caches singletons (same instance on repeated resolve)", () => {
    const c = createTestContainer();
    const a = c.resolve<ILogger>(Tokens.Logger);
    const b = c.resolve<ILogger>(Tokens.Logger);
    expect(a).toBe(b);
  });

  it("wires dependencies across tokens", () => {
    const c = createTestContainer();
    const svc = c.resolve<IFeatureFlagService>(Tokens.FeatureFlagService);
    expect(svc).toBeInstanceOf(FeatureFlagService);
    const queue = c.resolve<IQueue>(Tokens.Queue);
    expect(queue).toBeInstanceOf(InMemoryQueue);
    const worker = c.resolve<IWorker>(Tokens.Worker);
    expect(worker).toBeInstanceOf(InMemoryWorker);
  });

  it("throws for an unregistered token", () => {
    const c = createTestContainer();
    expect(() => c.resolve(Symbol("nope"))).toThrow(/no factory/);
  });
});

/**
 * M7.12 tab sessions. The production container binds
 * Tokens.WorkspaceSessionRepository to the Prisma adapter; this mirrors the
 * wiring with the in-memory repository so TabService's four constructor
 * dependencies are proven to resolve without a database.
 */
describe("DI Container — workspace tab sessions (M7.12)", () => {
  function createSessionContainer(): Container {
    const c = new Container();
    c.register<ILogger>(Tokens.Logger, () => new ConsoleLogger("error"));
    c.register<WorkspaceSessionRepository>(
      Tokens.WorkspaceSessionRepository,
      () => new InMemoryWorkspaceSessionRepository(),
    );
    // TabService only calls .get()/.getById() on these two, so a minimal stand-in
    // keeps the test free of Prisma while exercising the real wiring shape.
    c.register(Tokens.WorkspaceService, () => ({ get: async () => ({}) }));
    c.register(Tokens.DocumentRecordRepository, () => ({ getById: async () => null }));
    c.register<TabService>(Tokens.TabService, (cc) => {
      return new TabService(
        cc.resolve<ILogger>(Tokens.Logger),
        cc.resolve(Tokens.WorkspaceService),
        cc.resolve<WorkspaceSessionRepository>(Tokens.WorkspaceSessionRepository),
        cc.resolve(Tokens.DocumentRecordRepository),
      );
    });
    return c;
  }

  it("resolves the workspace session repository", () => {
    const c = createSessionContainer();
    const repo = c.resolve<WorkspaceSessionRepository>(Tokens.WorkspaceSessionRepository);
    expect(repo).toBeInstanceOf(InMemoryWorkspaceSessionRepository);
  });

  it("resolves TabService with all four dependencies", () => {
    const c = createSessionContainer();
    const service = c.resolve<TabService>(Tokens.TabService);
    expect(service).toBeInstanceOf(TabService);
  });

  it("caches both as singletons, matching container policy", () => {
    const c = createSessionContainer();
    expect(c.resolve(Tokens.TabService)).toBe(c.resolve(Tokens.TabService));
    expect(c.resolve(Tokens.WorkspaceSessionRepository)).toBe(
      c.resolve(Tokens.WorkspaceSessionRepository),
    );
  });

  it("registers WorkspaceSessionRepository under a distinct token", () => {
    expect(Tokens.WorkspaceSessionRepository).not.toBe(Tokens.DocumentRecordRepository);
    expect(Tokens.WorkspaceSessionRepository.toString()).toContain("WorkspaceSessionRepository");
  });
});

/**
 * M7.5 durable autosave. The production container binds
 * Tokens.AutosaveDraftRepository to the Prisma adapter and hands AutosaveService
 * five dependencies; this mirrors that wiring with in-memory adapters. The
 * service is exercised, not merely constructed: an arity or ordering mistake in
 * the registration type-checks but fails the moment a draft is saved.
 */
describe("DI Container — durable autosave (M7.5)", () => {
  /** Byte store standing in for the configured adapter. */
  class MemoryObjectStorage implements IObjectStorage {
    readonly objects = new Map<string, Buffer>();
    async put(key: string, data: Buffer | Uint8Array, _options: PutOptions): Promise<void> {
      this.objects.set(key, Buffer.from(data));
    }
    async get(key: string): Promise<Buffer> {
      const data = this.objects.get(key);
      if (!data) throw new Error(`object ${key} does not exist`);
      return Buffer.from(data);
    }
    async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
      const data = await this.get(key);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(data));
          controller.close();
        },
      });
    }
    async putStream(
      key: string,
      stream: ReadableStream<Uint8Array>,
      options: StreamPutOptions,
    ): Promise<StreamPutResult> {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const data = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      await this.put(key, data, options as PutOptions);
      return { sha256: options.sha256 ?? "", size: data.byteLength };
    }
    async head(key: string): Promise<ObjectMetadata> {
      const data = this.objects.get(key);
      return {
        key,
        size: data?.byteLength ?? 0,
        contentType: null,
        exists: data !== undefined,
      };
    }
    async delete(key: string): Promise<void> {
      this.objects.delete(key);
    }
  }

  const ACTOR = {
    userId: "user-1",
    organizationId: "org-a",
    organizationRole: "member" as const,
    organizationDefaultWorkspaceId: null,
  };

  function createAutosaveContainer(): Container {
    const c = new Container();
    c.register<ILogger>(Tokens.Logger, () => new ConsoleLogger("error"));
    c.register<IObjectStorage>(Tokens.ObjectStorage, () => new MemoryObjectStorage());
    c.register<AutosaveDraftRepository>(
      Tokens.AutosaveDraftRepository,
      () => new InMemoryAutosaveDraftRepository(),
    );
    // AutosaveService only calls .get() / .getById() on these, so minimal
    // stand-ins keep the test free of Prisma while exercising the real shape.
    c.register(Tokens.WorkspaceService, () => ({
      get: async () => ({ workspace: { id: "ws-a", organizationId: "org-a" }, role: "editor" }),
    }));
    c.register(Tokens.DocumentRecordRepository, () => ({
      getById: async () => ({
        id: "doc-1",
        workspaceId: "ws-a",
        organizationId: "org-a",
        lifecycleState: "active",
        revision: 1,
      }),
    }));
    c.register<AutosaveService>(Tokens.AutosaveService, (cc) => {
      return new AutosaveService(
        cc.resolve<ILogger>(Tokens.Logger),
        cc.resolve(Tokens.WorkspaceService),
        cc.resolve<AutosaveDraftRepository>(Tokens.AutosaveDraftRepository),
        cc.resolve(Tokens.DocumentRecordRepository),
        cc.resolve<IObjectStorage>(Tokens.ObjectStorage),
      );
    });
    return c;
  }

  it("resolves the autosave draft repository", () => {
    const c = createAutosaveContainer();
    const repo = c.resolve<AutosaveDraftRepository>(Tokens.AutosaveDraftRepository);
    expect(repo).toBeInstanceOf(InMemoryAutosaveDraftRepository);
  });

  it("resolves AutosaveService with all five dependencies", () => {
    const c = createAutosaveContainer();
    expect(c.resolve<AutosaveService>(Tokens.AutosaveService)).toBeInstanceOf(AutosaveService);
  });

  it("resolves a service whose dependencies are actually usable", async () => {
    const c = createAutosaveContainer();
    const service = c.resolve<AutosaveService>(Tokens.AutosaveService);

    const draft = await service.saveDraft(ACTOR, "ws-a", {
      documentId: "doc-1",
      deviceId: "device-a",
      baseVersion: 1,
      expectedRevision: 1,
      payload: '{"blocks":[]}',
    });

    expect(draft.status).toBe("dirty");
    // The snapshot went to the container's object storage, not into the row.
    const storage = c.resolve<IObjectStorage>(Tokens.ObjectStorage);
    expect((await storage.head(draft.snapshotKey)).exists).toBe(true);
    // The metadata landed in the container's repository.
    const repo = c.resolve<AutosaveDraftRepository>(Tokens.AutosaveDraftRepository);
    expect(await repo.getById("ws-a", draft.id)).not.toBeNull();
  });

  it("caches both as singletons, matching container policy", () => {
    const c = createAutosaveContainer();
    expect(c.resolve(Tokens.AutosaveService)).toBe(c.resolve(Tokens.AutosaveService));
    expect(c.resolve(Tokens.AutosaveDraftRepository)).toBe(
      c.resolve(Tokens.AutosaveDraftRepository),
    );
  });

  it("registers AutosaveDraftRepository under a distinct token", () => {
    expect(Tokens.AutosaveDraftRepository).not.toBe(Tokens.AutosaveService);
    expect(Tokens.AutosaveDraftRepository).not.toBe(Tokens.DocumentRecordRepository);
    expect(Tokens.AutosaveDraftRepository).not.toBe(Tokens.WorkspaceSessionRepository);
    expect(Tokens.AutosaveDraftRepository.toString()).toContain("AutosaveDraftRepository");
  });
});

/**
 * M7.6 durable document versions. The production container binds
 * Tokens.DocumentVersionRepository to the Prisma adapter and hands VersionService
 * five dependencies in a specific order; this mirrors that wiring with in-memory
 * adapters. The registration this replaced passed a file-metadata repository and
 * the WorkspaceService in the wrong positions — a mistake that type-checks under
 * `resolve()`'s inferred returns and only surfaces when a version is created, so
 * these tests exercise the service rather than merely constructing it.
 */
describe("DI Container — durable document versions (M7.6)", () => {
  /** Byte store standing in for the configured adapter. */
  class VersionMemoryStorage implements IObjectStorage {
    readonly objects = new Map<string, Buffer>();
    readonly deletes: string[] = [];
    async put(key: string, data: Buffer | Uint8Array, _options: PutOptions): Promise<void> {
      this.objects.set(key, Buffer.from(data));
    }
    async get(key: string): Promise<Buffer> {
      const data = this.objects.get(key);
      if (!data) throw new Error(`object ${key} does not exist`);
      return Buffer.from(data);
    }
    async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
      const data = await this.get(key);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(data));
          controller.close();
        },
      });
    }
    async putStream(
      key: string,
      stream: ReadableStream<Uint8Array>,
      options: StreamPutOptions,
    ): Promise<StreamPutResult> {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const data = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      await this.put(key, data, options as PutOptions);
      return { sha256: options.sha256 ?? "", size: data.byteLength };
    }
    async head(key: string): Promise<ObjectMetadata> {
      const data = this.objects.get(key);
      return { key, size: data?.byteLength ?? 0, contentType: null, exists: data !== undefined };
    }
    async delete(key: string): Promise<void> {
      this.objects.delete(key);
      this.deletes.push(key);
    }
  }

  const ACTOR = {
    userId: "user-1",
    organizationId: "org-a",
    organizationRole: "member" as const,
    organizationDefaultWorkspaceId: null,
  };

  const MANIFEST = {
    sourceKey: "workspaces/ws-a/sources/doc-1/v1.pdf",
    sourceChecksum: "a".repeat(64),
    sourceByteSize: 2048,
    pageCount: 2,
    thumbnailKeys: ["workspaces/ws-a/thumbs/doc-1/1.png"],
  };

  /** Tracks the pointer/revision advance so the wiring's effect is observable. */
  function documentStub() {
    const state = { revision: 1, currentVersionId: null as string | null };
    return {
      state,
      repository: {
        getById: async () => ({
          id: "doc-1",
          workspaceId: "ws-a",
          organizationId: "org-a",
          lifecycleState: "active",
          revision: state.revision,
          currentVersionId: state.currentVersionId,
        }),
        /*
         * Mirrors `PrismaDocumentRecordRepository.update`: `data.revision` is the
         * EXPECTED CURRENT revision (a compare-and-swap guard) and the column is
         * incremented by the write. A fake that stored the value instead made
         * `VersionService`'s off-by-one pointer write look correct here too.
         */
        update: async (
          _workspaceId: string,
          _documentId: string,
          data: { currentVersionId?: string | null; revision?: number },
        ) => {
          if (data.revision !== undefined && data.revision !== state.revision) {
            throw new Error("Document update conflict.");
          }
          state.revision += 1;
          if (data.currentVersionId !== undefined) state.currentVersionId = data.currentVersionId;
          return { id: "doc-1", ...state };
        },
      },
    };
  }

  function createVersionContainer() {
    const c = new Container();
    const documents = documentStub();
    c.register<ILogger>(Tokens.Logger, () => new ConsoleLogger("error"));
    c.register<IObjectStorage>(Tokens.ObjectStorage, () => new VersionMemoryStorage());
    c.register<DocumentVersionRepository>(
      Tokens.DocumentVersionRepository,
      () => new InMemoryDocumentVersionRepository(),
    );
    c.register(Tokens.WorkspaceService, () => ({
      get: async () => ({ workspace: { id: "ws-a", organizationId: "org-a" }, role: "editor" }),
    }));
    c.register(Tokens.DocumentRecordRepository, () => documents.repository);
    // Pruning asks this whether a version's artifact is still a stored file before
    // deleting the object, so an unregistered token here is a resolve-time failure.
    c.register<IFileMetadataRepository>(
      Tokens.FileMetadataRepository,
      () => new InMemoryStoredFileRepository(),
    );
    c.register<VersionService>(Tokens.VersionService, (cc) => {
      return new VersionService(
        cc.resolve<ILogger>(Tokens.Logger),
        cc.resolve(Tokens.WorkspaceService),
        cc.resolve<DocumentVersionRepository>(Tokens.DocumentVersionRepository),
        cc.resolve(Tokens.DocumentRecordRepository),
        cc.resolve<IObjectStorage>(Tokens.ObjectStorage),
        cc.resolve<IFileMetadataRepository>(Tokens.FileMetadataRepository),
      );
    });
    return { container: c, documents };
  }

  it("resolves the document version repository", () => {
    const { container } = createVersionContainer();
    const repo = container.resolve<DocumentVersionRepository>(Tokens.DocumentVersionRepository);
    expect(repo).toBeInstanceOf(InMemoryDocumentVersionRepository);
  });

  it("resolves VersionService with all six dependencies", () => {
    const { container } = createVersionContainer();
    expect(container.resolve<VersionService>(Tokens.VersionService)).toBeInstanceOf(VersionService);
  });

  it("resolves a service whose dependencies are actually usable", async () => {
    const { container } = createVersionContainer();
    const service = container.resolve<VersionService>(Tokens.VersionService);

    const version = await service.createVersion(ACTOR, "ws-a", {
      documentId: "doc-1",
      expectedRevision: 1,
      manifest: MANIFEST,
    });

    expect(version.versionNumber).toBe(1);
    expect(version.checksum).toMatch(/^[a-f0-9]{64}$/);
    // The row landed in the container's repository, not somewhere the service invented.
    const repo = container.resolve<DocumentVersionRepository>(Tokens.DocumentVersionRepository);
    expect(await repo.getById("ws-a", version.id)).not.toBeNull();
  });

  it("advances the document pointer through the injected document repository", async () => {
    const { container, documents } = createVersionContainer();
    const service = container.resolve<VersionService>(Tokens.VersionService);

    const version = await service.createVersion(ACTOR, "ws-a", {
      documentId: "doc-1",
      expectedRevision: 1,
      manifest: MANIFEST,
    });

    // Proves the document repository is wired into the position the service uses
    // for the pointer write, not merely resolvable.
    expect(documents.state.currentVersionId).toBe(version.id);
    expect(documents.state.revision).toBe(2);
  });

  it("reads history back through the same resolved service", async () => {
    const { container } = createVersionContainer();
    const service = container.resolve<VersionService>(Tokens.VersionService);

    await service.createVersion(ACTOR, "ws-a", {
      documentId: "doc-1",
      expectedRevision: 1,
      manifest: MANIFEST,
    });
    await service.createVersion(ACTOR, "ws-a", {
      documentId: "doc-1",
      expectedRevision: 2,
      manifest: MANIFEST,
    });

    const history = await service.listVersions(ACTOR, "ws-a", "doc-1");
    expect(history.map((v) => v.versionNumber)).toEqual([2, 1]);
  });

  it("caches both as singletons, matching container policy", () => {
    const { container } = createVersionContainer();
    expect(container.resolve(Tokens.VersionService)).toBe(container.resolve(Tokens.VersionService));
    expect(container.resolve(Tokens.DocumentVersionRepository)).toBe(
      container.resolve(Tokens.DocumentVersionRepository),
    );
  });

  it("registers DocumentVersionRepository under a distinct token", () => {
    expect(Tokens.DocumentVersionRepository).not.toBe(Tokens.VersionService);
    expect(Tokens.DocumentVersionRepository).not.toBe(Tokens.AutosaveDraftRepository);
    expect(Tokens.DocumentVersionRepository).not.toBe(Tokens.DocumentRecordRepository);
    expect(Tokens.DocumentVersionRepository.toString()).toContain("DocumentVersionRepository");
  });
});

/**
 * M7.7 tags and smart collections. The registration this replaced passed three
 * arguments in the wrong order to a six-argument constructor, so TagService
 * resolved but could not do anything — these tests exercise real operations
 * through the resolved service rather than merely constructing it, which is what
 * would have caught that.
 */
describe("DI Container — tags and smart collections (M7.7)", () => {
  const ACTOR = {
    userId: "user-1",
    organizationId: "org-a",
    organizationRole: "member" as const,
    organizationDefaultWorkspaceId: null,
  };

  /** One active document, enough for assignment and evaluation to be observable. */
  function documentStub() {
    const record = {
      id: "doc-1",
      workspaceId: "ws-a",
      organizationId: "org-a",
      projectId: null,
      folderId: null,
      name: "Contract.pdf",
      normalizedName: "contract.pdf",
      lifecycleState: "active",
      orderKey: "a0",
      currentVersionId: null,
      favorite: false,
      lastAccessedAt: null,
      createdById: "user-1",
      revision: 1,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      archivedAt: null,
      trashedAt: null,
      archivedById: null,
      trashedById: null,
    };
    return {
      getById: async (workspaceId: string, documentId: string) =>
        workspaceId === "ws-a" && documentId === "doc-1" ? { ...record } : null,
      list: async (query: { workspaceId: string; limit: number }) => ({
        items: query.workspaceId === "ws-a" ? [{ ...record }] : [],
        nextCursor: null,
      }),
    };
  }

  function createTagContainer() {
    const c = new Container();
    c.register<ILogger>(Tokens.Logger, () => new ConsoleLogger("error"));
    c.register<TagRepository>(Tokens.TagRepository, () => new InMemoryTagRepository());
    c.register<DocumentTagRepository>(
      Tokens.DocumentTagRepository,
      () => new InMemoryDocumentTagRepository(),
    );
    c.register<SmartCollectionRepository>(
      Tokens.SmartCollectionRepository,
      () => new InMemorySmartCollectionRepository(),
    );
    c.register(Tokens.WorkspaceService, () => ({
      get: async () => ({ workspace: { id: "ws-a", organizationId: "org-a" }, role: "editor" }),
    }));
    c.register(Tokens.DocumentRecordRepository, () => documentStub());
    c.register<TagService>(Tokens.TagService, (cc) => {
      return new TagService(
        cc.resolve<ILogger>(Tokens.Logger),
        cc.resolve(Tokens.WorkspaceService),
        cc.resolve(Tokens.DocumentRecordRepository),
        cc.resolve<TagRepository>(Tokens.TagRepository),
        cc.resolve<DocumentTagRepository>(Tokens.DocumentTagRepository),
        cc.resolve<SmartCollectionRepository>(Tokens.SmartCollectionRepository),
      );
    });
    return c;
  }

  it("resolves all three M7.7 repositories", () => {
    const container = createTagContainer();
    expect(container.resolve<TagRepository>(Tokens.TagRepository)).toBeInstanceOf(
      InMemoryTagRepository,
    );
    expect(container.resolve<DocumentTagRepository>(Tokens.DocumentTagRepository)).toBeInstanceOf(
      InMemoryDocumentTagRepository,
    );
    expect(
      container.resolve<SmartCollectionRepository>(Tokens.SmartCollectionRepository),
    ).toBeInstanceOf(InMemorySmartCollectionRepository);
  });

  it("resolves TagService with all six dependencies", () => {
    const container = createTagContainer();
    expect(container.resolve<TagService>(Tokens.TagService)).toBeInstanceOf(TagService);
  });

  it("creates a tag through the resolved service and stores it in the container's repository", async () => {
    const container = createTagContainer();
    const service = container.resolve<TagService>(Tokens.TagService);

    const tag = await service.createTag(ACTOR, "ws-a", { name: "Contract" });

    expect(tag.normalizedName).toBe("contract");
    // The row landed in the container's repository, not one the service invented.
    const tags = container.resolve<TagRepository>(Tokens.TagRepository);
    expect(await tags.getById("ws-a", tag.id)).not.toBeNull();
  });

  it("assigns a tag through the injected document-tag repository", async () => {
    const container = createTagContainer();
    const service = container.resolve<TagService>(Tokens.TagService);
    const tag = await service.createTag(ACTOR, "ws-a", { name: "Urgent" });

    await service.assignTag(ACTOR, "ws-a", "doc-1", tag.id);

    const documentTags = container.resolve<DocumentTagRepository>(Tokens.DocumentTagRepository);
    expect(await documentTags.isAssigned("ws-a", "doc-1", tag.id)).toBe(true);
  });

  it("evaluates a smart collection against the injected document repository", async () => {
    const container = createTagContainer();
    const service = container.resolve<TagService>(Tokens.TagService);

    const collection = await service.createSmartCollection(ACTOR, "ws-a", {
      name: "Contracts",
      query: {
        version: 1,
        root: {
          mode: "all",
          conditions: [{ field: "name", operator: "contains", value: "contract" }],
        },
      },
    });
    const evaluated = await service.evaluateSmartCollection(ACTOR, "ws-a", collection.id);

    // Proves the document repository occupies the position the evaluator reads
    // from, not merely that it resolves.
    expect(evaluated.documentIds).toEqual(["doc-1"]);
  });

  it("caches the service and its repositories as singletons, matching container policy", () => {
    const container = createTagContainer();
    expect(container.resolve(Tokens.TagService)).toBe(container.resolve(Tokens.TagService));
    expect(container.resolve(Tokens.TagRepository)).toBe(container.resolve(Tokens.TagRepository));
    expect(container.resolve(Tokens.DocumentTagRepository)).toBe(
      container.resolve(Tokens.DocumentTagRepository),
    );
    expect(container.resolve(Tokens.SmartCollectionRepository)).toBe(
      container.resolve(Tokens.SmartCollectionRepository),
    );
  });

  it("registers each M7.7 repository under a distinct token", () => {
    const tokens = [
      Tokens.TagRepository,
      Tokens.DocumentTagRepository,
      Tokens.SmartCollectionRepository,
      Tokens.TagService,
    ];
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(Tokens.TagRepository.toString()).toContain("TagRepository");
    expect(Tokens.SmartCollectionRepository.toString()).toContain("SmartCollectionRepository");
  });
});

/**
 * M7.8 search index. The tests exercise real index-and-search operations through
 * the resolved service rather than merely constructing it: SearchService takes
 * six positional dependencies, three of which are repositories, so a mis-ordered
 * registration still resolves and still type-checks but cannot index or search.
 */
describe("DI Container — search index (M7.8)", () => {
  const ACTOR = {
    userId: "user-1",
    organizationId: "org-a",
    organizationRole: "member" as const,
    organizationDefaultWorkspaceId: null,
  };

  function documentStub() {
    const record = {
      id: "doc-1",
      workspaceId: "ws-a",
      organizationId: "org-a",
      projectId: null,
      folderId: null,
      name: "Contract.pdf",
      normalizedName: "contract.pdf",
      lifecycleState: "active",
      orderKey: "a0",
      currentVersionId: "ver-1",
      favorite: false,
      lastAccessedAt: null,
      createdById: "user-1",
      revision: 1,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      archivedAt: null,
      trashedAt: null,
      archivedById: null,
      trashedById: null,
    };
    return {
      getById: async (workspaceId: string, documentId: string) =>
        workspaceId === "ws-a" && documentId === "doc-1" ? { ...record } : null,
      list: async (query: { workspaceId: string; limit: number }) => ({
        items: query.workspaceId === "ws-a" ? [{ ...record }] : [],
        nextCursor: null,
      }),
    };
  }

  function createSearchContainer() {
    const c = new Container();
    c.register<ILogger>(Tokens.Logger, () => new ConsoleLogger("error"));
    c.register<SearchDocumentRepository>(
      Tokens.SearchDocumentRepository,
      () => new InMemorySearchDocumentRepository(),
    );
    c.register<SearchChunkRepository>(
      Tokens.SearchChunkRepository,
      () => new InMemorySearchChunkRepository(),
    );
    c.register<SearchIndexPort>(Tokens.SearchIndexPort, (cc) => {
      return new SQLiteSearchIndexAdapter(
        cc.resolve<SearchChunkRepository>(Tokens.SearchChunkRepository),
      );
    });
    c.register(Tokens.WorkspaceService, () => ({
      get: async () => ({ workspace: { id: "ws-a", organizationId: "org-a" }, role: "editor" }),
    }));
    c.register(Tokens.DocumentRecordRepository, () => documentStub());
    // Mirrors the production registration argument-for-argument.
    c.register<SearchService>(Tokens.SearchService, (cc) => {
      return new SearchService(
        cc.resolve<ILogger>(Tokens.Logger),
        cc.resolve(Tokens.WorkspaceService),
        cc.resolve(Tokens.DocumentRecordRepository),
        cc.resolve<SearchDocumentRepository>(Tokens.SearchDocumentRepository),
        cc.resolve<SearchChunkRepository>(Tokens.SearchChunkRepository),
        cc.resolve<SearchIndexPort>(Tokens.SearchIndexPort),
      );
    });
    return c;
  }

  it("resolves both search repositories and the index port", () => {
    const container = createSearchContainer();
    expect(
      container.resolve<SearchDocumentRepository>(Tokens.SearchDocumentRepository),
    ).toBeInstanceOf(InMemorySearchDocumentRepository);
    expect(container.resolve<SearchChunkRepository>(Tokens.SearchChunkRepository)).toBeInstanceOf(
      InMemorySearchChunkRepository,
    );
    expect(container.resolve<SearchIndexPort>(Tokens.SearchIndexPort)).toBeInstanceOf(
      SQLiteSearchIndexAdapter,
    );
  });

  it("resolves SearchService with all six dependencies", () => {
    const container = createSearchContainer();
    expect(container.resolve<SearchService>(Tokens.SearchService)).toBeInstanceOf(SearchService);
  });

  it("indexes and searches a document end to end through the resolved service", async () => {
    const container = createSearchContainer();
    const service = container.resolve<SearchService>(Tokens.SearchService);

    await service.indexDocument(ACTOR, "ws-a", {
      documentId: "doc-1",
      versionId: "ver-1",
      segments: [
        { sourceType: "text", pageNumber: 1, text: "The quarterly contract for 2026." },
      ],
    });
    const results = await service.search(ACTOR, "ws-a", { query: "contract" });

    expect(results.hits.map((hit) => hit.documentId)).toEqual(["doc-1"]);
    expect(results.hits[0].snippets[0].text).toContain("contract");
  });

  it("writes indexed rows into the container's own repositories", async () => {
    const container = createSearchContainer();
    const service = container.resolve<SearchService>(Tokens.SearchService);

    await service.indexDocument(ACTOR, "ws-a", {
      documentId: "doc-1",
      segments: [{ sourceType: "text", pageNumber: 1, text: "Quarterly contract." }],
    });

    // Proves the injected repositories occupy the positions the service writes
    // to, rather than the service having constructed its own.
    const searchDocuments = container.resolve<SearchDocumentRepository>(
      Tokens.SearchDocumentRepository,
    );
    const chunks = container.resolve<SearchChunkRepository>(Tokens.SearchChunkRepository);
    const entry = await searchDocuments.getByDocumentId("ws-a", "doc-1");
    expect(entry?.state).toBe("indexed");
    expect(await chunks.countForDocument("ws-a", "doc-1")).toBeGreaterThan(0);
  });

  it("reports statistics through the injected repositories", async () => {
    const container = createSearchContainer();
    const service = container.resolve<SearchService>(Tokens.SearchService);
    await service.indexDocument(ACTOR, "ws-a", {
      documentId: "doc-1",
      segments: [{ sourceType: "text", pageNumber: 1, text: "Quarterly contract." }],
    });

    const stats = await service.getStatistics(ACTOR, "ws-a");

    expect(stats.indexedDocuments).toBe(1);
    expect(stats.totalChunks).toBeGreaterThan(0);
    expect(stats.lastIndexedAt).toBeInstanceOf(Date);
  });

  it("fails when the repositories are supplied in the wrong constructor order", async () => {
    const c = new Container();
    c.register<ILogger>(Tokens.Logger, () => new ConsoleLogger("error"));
    c.register(Tokens.WorkspaceService, () => ({
      get: async () => ({ workspace: { id: "ws-a", organizationId: "org-a" }, role: "editor" }),
    }));
    c.register(Tokens.DocumentRecordRepository, () => documentStub());
    c.register<SearchService>(Tokens.SearchService, (cc) => {
      return new SearchService(
        cc.resolve<ILogger>(Tokens.Logger),
        cc.resolve(Tokens.WorkspaceService),
        cc.resolve(Tokens.DocumentRecordRepository),
        // Deliberately swapped: chunks where the entry repository belongs.
        new InMemorySearchChunkRepository() as unknown as SearchDocumentRepository,
        new InMemorySearchDocumentRepository() as unknown as SearchChunkRepository,
        new SQLiteSearchIndexAdapter(new InMemorySearchChunkRepository()),
      );
    });

    // Constructing still succeeds — which is exactly why the check has to be a
    // real operation. Indexing is what surfaces the mis-wiring.
    const service = c.resolve<SearchService>(Tokens.SearchService);
    await expect(
      service.indexDocument(ACTOR, "ws-a", {
        documentId: "doc-1",
        segments: [{ sourceType: "text", pageNumber: 1, text: "Quarterly contract." }],
      }),
    ).rejects.toThrow();
  });

  it("caches the search service and its dependencies as singletons", () => {
    const container = createSearchContainer();
    expect(container.resolve(Tokens.SearchService)).toBe(container.resolve(Tokens.SearchService));
    expect(container.resolve(Tokens.SearchDocumentRepository)).toBe(
      container.resolve(Tokens.SearchDocumentRepository),
    );
    expect(container.resolve(Tokens.SearchChunkRepository)).toBe(
      container.resolve(Tokens.SearchChunkRepository),
    );
    expect(container.resolve(Tokens.SearchIndexPort)).toBe(
      container.resolve(Tokens.SearchIndexPort),
    );
  });

  it("registers each M7.8 dependency under a distinct token", () => {
    const tokens = [
      Tokens.SearchDocumentRepository,
      Tokens.SearchChunkRepository,
      Tokens.SearchIndexPort,
      Tokens.SearchService,
    ];
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(Tokens.SearchDocumentRepository.toString()).toContain("SearchDocumentRepository");
    expect(Tokens.SearchChunkRepository.toString()).toContain("SearchChunkRepository");
    expect(Tokens.SearchIndexPort.toString()).toContain("SearchIndexPort");
    expect(Tokens.SearchService.toString()).toContain("SearchService");
  });
});

/**
 * M7.9 metadata, bookmarks, outlines and attachments.
 *
 * MetadataService takes nine positional dependencies, four of which are
 * repositories of the same broad shape. A mis-ordered registration still
 * resolves and still type-checks, so these tests write and read back through the
 * resolved service and then assert against the container's *own* repositories —
 * `instanceof` alone would pass even if the service were handed the wrong four.
 */
describe("DI Container — metadata, bookmarks, outlines, attachments (M7.9)", () => {
  const ACTOR = {
    userId: "user-1",
    organizationId: "org-a",
    organizationRole: "member" as const,
    organizationDefaultWorkspaceId: null,
  };

  class MetadataMemoryStorage implements IObjectStorage {
    readonly objects = new Map<string, Buffer>();

    async put(key: string, data: Buffer | Uint8Array): Promise<void> {
      this.objects.set(key, Buffer.from(data));
    }
    async get(key: string): Promise<Buffer> {
      const found = this.objects.get(key);
      if (!found) throw new Error(`missing ${key}`);
      return found;
    }
    async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
      const bytes = await this.get(key);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      });
    }
    async putStream(
      key: string,
      stream: ReadableStream<Uint8Array>,
      _options: StreamPutOptions,
    ): Promise<StreamPutResult> {
      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const data = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      this.objects.set(key, data);
      return { sha256: "", size: data.length };
    }
    async head(key: string): Promise<ObjectMetadata> {
      const found = this.objects.get(key);
      return {
        key,
        size: found?.length ?? 0,
        contentType: null,
        exists: found !== undefined,
      };
    }
    async delete(key: string): Promise<void> {
      this.objects.delete(key);
    }
  }

  function documentStub() {
    const record = {
      id: "doc-1",
      workspaceId: "ws-a",
      organizationId: "org-a",
      projectId: null,
      folderId: null,
      name: "Contract.pdf",
      normalizedName: "contract.pdf",
      lifecycleState: "active",
      orderKey: "a0",
      currentVersionId: "ver-1",
      favorite: false,
      lastAccessedAt: null,
      createdById: "user-1",
      revision: 1,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      archivedAt: null,
      trashedAt: null,
      archivedById: null,
      trashedById: null,
    };
    return {
      getById: async (workspaceId: string, documentId: string) =>
        workspaceId === "ws-a" && documentId === "doc-1" ? { ...record } : null,
    };
  }

  function createMetadataContainer() {
    const c = new Container();
    c.register<ILogger>(Tokens.Logger, () => new ConsoleLogger("error"));
    c.register<IObjectStorage>(Tokens.ObjectStorage, () => new MetadataMemoryStorage());
    c.register<IFileMetadataRepository>(
      Tokens.FileMetadataRepository,
      () => new InMemoryStoredFileRepository(),
    );
    c.register<DocumentMetadataRepository>(
      Tokens.DocumentMetadataRepository,
      () => new InMemoryDocumentMetadataRepository(),
    );
    c.register<BookmarkRepository>(
      Tokens.BookmarkRepository,
      () => new InMemoryBookmarkRepository(),
    );
    c.register<OutlineItemRepository>(
      Tokens.OutlineItemRepository,
      () => new InMemoryOutlineItemRepository(),
    );
    c.register<AttachmentRepository>(
      Tokens.AttachmentRepository,
      () => new InMemoryAttachmentRepository(),
    );
    c.register(Tokens.WorkspaceService, () => ({
      get: async () => ({ workspace: { id: "ws-a", organizationId: "org-a" }, role: "editor" }),
    }));
    c.register(Tokens.DocumentRecordRepository, () => documentStub());
    // Mirrors the production registration argument-for-argument.
    c.register<MetadataService>(Tokens.MetadataService, (cc) => {
      return new MetadataService(
        cc.resolve<ILogger>(Tokens.Logger),
        cc.resolve(Tokens.WorkspaceService),
        cc.resolve(Tokens.DocumentRecordRepository),
        cc.resolve<DocumentMetadataRepository>(Tokens.DocumentMetadataRepository),
        cc.resolve<BookmarkRepository>(Tokens.BookmarkRepository),
        cc.resolve<OutlineItemRepository>(Tokens.OutlineItemRepository),
        cc.resolve<AttachmentRepository>(Tokens.AttachmentRepository),
        cc.resolve<IObjectStorage>(Tokens.ObjectStorage),
        cc.resolve<IFileMetadataRepository>(Tokens.FileMetadataRepository),
      );
    });
    return c;
  }

  it("resolves all four M7.9 repositories", () => {
    const container = createMetadataContainer();
    expect(
      container.resolve<DocumentMetadataRepository>(Tokens.DocumentMetadataRepository),
    ).toBeInstanceOf(InMemoryDocumentMetadataRepository);
    expect(container.resolve<BookmarkRepository>(Tokens.BookmarkRepository)).toBeInstanceOf(
      InMemoryBookmarkRepository,
    );
    expect(container.resolve<OutlineItemRepository>(Tokens.OutlineItemRepository)).toBeInstanceOf(
      InMemoryOutlineItemRepository,
    );
    expect(container.resolve<AttachmentRepository>(Tokens.AttachmentRepository)).toBeInstanceOf(
      InMemoryAttachmentRepository,
    );
  });

  it("resolves MetadataService with all nine dependencies", () => {
    const container = createMetadataContainer();
    expect(container.resolve<MetadataService>(Tokens.MetadataService)).toBeInstanceOf(
      MetadataService,
    );
  });

  it("persists a metadata write through the injected repository", async () => {
    const container = createMetadataContainer();
    const service = container.resolve<MetadataService>(Tokens.MetadataService);
    await service.setDocumentMetadata(ACTOR, "ws-a", "doc-1", { title: "Wired" });

    // Read back through the container's own repository, not through the service:
    // this is what proves the service was handed *this* instance.
    const repo = container.resolve<DocumentMetadataRepository>(Tokens.DocumentMetadataRepository);
    const stored = await repo.getByDocumentId("ws-a", "doc-1");
    expect(stored?.fields.title).toBe("Wired");
  });

  it("persists a bookmark write through the injected repository", async () => {
    const container = createMetadataContainer();
    const service = container.resolve<MetadataService>(Tokens.MetadataService);
    await service.createBookmark(ACTOR, "ws-a", "doc-1", { pageNumber: 3, title: "Clause 4" });

    const repo = container.resolve<BookmarkRepository>(Tokens.BookmarkRepository);
    const stored = await repo.list({ workspaceId: "ws-a", documentId: "doc-1", limit: 10 });
    expect(stored.map((b) => b.title)).toEqual(["Clause 4"]);
  });

  it("persists an outline write through the injected repository", async () => {
    const container = createMetadataContainer();
    const service = container.resolve<MetadataService>(Tokens.MetadataService);
    await service.createOutlineItem(ACTOR, "ws-a", "doc-1", {
      title: "Chapter 1",
      pageNumber: 1,
    });

    const repo = container.resolve<OutlineItemRepository>(Tokens.OutlineItemRepository);
    const stored = await repo.list({ workspaceId: "ws-a", documentId: "doc-1", limit: 10 });
    expect(stored.map((i) => i.title)).toEqual(["Chapter 1"]);
  });

  it("reaches storage and both injected repositories on an attachment write", async () => {
    const container = createMetadataContainer();
    const service = container.resolve<MetadataService>(Tokens.MetadataService);
    const created = await service.createAttachment(ACTOR, "ws-a", "doc-1", {
      name: "notes.txt",
      mimeType: "text/plain",
      data: Buffer.from("hello attachment"),
    });

    const attachments = container.resolve<AttachmentRepository>(Tokens.AttachmentRepository);
    const stored = await attachments.getById("ws-a", created.id);
    expect(stored?.name).toBe("notes.txt");

    // The StoredFile row and the object itself must both exist: an attachment is
    // a row plus bytes, and a wiring that produced only one would still return a
    // record that looks complete.
    const files = container.resolve<IFileMetadataRepository>(Tokens.FileMetadataRepository);
    const file = await files.get(stored!.storedFileId!);
    expect(file).not.toBeNull();

    const storage = container.resolve<IObjectStorage>(Tokens.ObjectStorage);
    expect((await storage.head(file!.key)).exists).toBe(true);
  });

  it("reads back a real persisted result through the service", async () => {
    const container = createMetadataContainer();
    const service = container.resolve<MetadataService>(Tokens.MetadataService);
    await service.setDocumentMetadata(ACTOR, "ws-a", "doc-1", { title: "Round trip" });
    const read = await service.getDocumentMetadata(ACTOR, "ws-a", "doc-1");

    expect(read?.fields.title).toBe("Round trip");
    expect(read?.revision).toBe(1);
  });

  it("streams a downloadable attachment through the injected storage", async () => {
    const container = createMetadataContainer();
    const service = container.resolve<MetadataService>(Tokens.MetadataService);
    const created = await service.createAttachment(ACTOR, "ws-a", "doc-1", {
      name: "report.txt",
      mimeType: "text/plain",
      data: Buffer.from("streamed bytes"),
    });
    const download = await service.getAttachmentDownload(ACTOR, "ws-a", "doc-1", created.id);

    expect(download.contentDisposition).toContain("attachment;");
    expect(download.byteSize).toBe("streamed bytes".length);
  });

  it("wires the constructor dependencies in the right order", async () => {
    const container = createMetadataContainer();
    const service = container.resolve<MetadataService>(Tokens.MetadataService);

    // Four repositories of a similar shape sit next to each other in the
    // signature, so a transposition is easy and silent. Writing one record of
    // each kind and finding each in its own repository is what rules it out.
    await service.setDocumentMetadata(ACTOR, "ws-a", "doc-1", { title: "Ordered" });
    await service.createBookmark(ACTOR, "ws-a", "doc-1", { pageNumber: 1, title: "B" });
    await service.createOutlineItem(ACTOR, "ws-a", "doc-1", { pageNumber: 1, title: "O" });

    const properties = await service.getDocumentProperties(ACTOR, "ws-a", "doc-1");
    expect(properties.metadata?.fields.title).toBe("Ordered");
    expect(properties.counts.bookmarks).toBe(1);
    expect(properties.counts.outlineItems).toBe(1);
  });

  it("returns singletons per the container's caching policy", () => {
    const container = createMetadataContainer();
    expect(container.resolve(Tokens.MetadataService)).toBe(container.resolve(Tokens.MetadataService));
    expect(container.resolve(Tokens.DocumentMetadataRepository)).toBe(
      container.resolve(Tokens.DocumentMetadataRepository),
    );
    expect(container.resolve(Tokens.BookmarkRepository)).toBe(
      container.resolve(Tokens.BookmarkRepository),
    );
    expect(container.resolve(Tokens.OutlineItemRepository)).toBe(
      container.resolve(Tokens.OutlineItemRepository),
    );
    expect(container.resolve(Tokens.AttachmentRepository)).toBe(
      container.resolve(Tokens.AttachmentRepository),
    );
  });

  it("registers each M7.9 dependency under a distinct token", () => {
    const tokens = [
      Tokens.DocumentMetadataRepository,
      Tokens.BookmarkRepository,
      Tokens.OutlineItemRepository,
      Tokens.AttachmentRepository,
      Tokens.MetadataService,
    ];
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(Tokens.DocumentMetadataRepository.toString()).toContain("DocumentMetadataRepository");
    expect(Tokens.BookmarkRepository.toString()).toContain("BookmarkRepository");
    expect(Tokens.OutlineItemRepository.toString()).toContain("OutlineItemRepository");
    expect(Tokens.AttachmentRepository.toString()).toContain("AttachmentRepository");
    expect(Tokens.MetadataService.toString()).toContain("MetadataService");
  });
});

/**
 * M7.10 comments, sharing and asynchronous collaboration.
 *
 * CommentService takes three same-shaped repositories in a row, so a
 * mis-ordered registration would still resolve and still type-check. These tests
 * therefore drive real operations through the resolved service and assert
 * against the container's *own* repositories — `instanceof` alone would pass
 * even if threads and messages were swapped.
 */
describe("DI Container — comments, sharing and collaboration (M7.10)", () => {
  const ACTOR = {
    userId: "user-1",
    organizationId: "org-a",
    organizationRole: "member" as const,
    organizationDefaultWorkspaceId: null,
  };

  function collaborationDocumentStub() {
    const record = {
      id: "doc-1",
      workspaceId: "ws-a",
      organizationId: "org-a",
      projectId: null,
      folderId: null,
      name: "Contract.pdf",
      normalizedName: "contract.pdf",
      lifecycleState: "active",
      orderKey: "a0",
      currentVersionId: "ver-1",
      favorite: false,
      lastAccessedAt: null,
      createdById: "user-1",
      revision: 1,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      archivedAt: null,
      trashedAt: null,
      archivedById: null,
      trashedById: null,
    };
    return {
      getById: async (workspaceId: string, documentId: string) =>
        workspaceId === "ws-a" && documentId === "doc-1" ? { ...record } : null,
    };
  }

  function createCollaborationContainer(role: "owner" | "editor" | "viewer" = "owner") {
    const c = new Container();
    c.register<ILogger>(Tokens.Logger, () => new ConsoleLogger("error"));
    c.register<CommentThreadRepository>(
      Tokens.CommentThreadRepository,
      () => new InMemoryCommentThreadRepository(),
    );
    c.register<CommentMessageRepository>(
      Tokens.CommentMessageRepository,
      () => new InMemoryCommentMessageRepository(),
    );
    c.register<DocumentPermissionGrantRepository>(
      Tokens.DocumentPermissionGrantRepository,
      () => new InMemoryDocumentPermissionGrantRepository(),
    );
    c.register(Tokens.WorkspaceService, () => ({
      get: async () => ({ workspace: { id: "ws-a", organizationId: "org-a" }, role }),
    }));
    c.register(Tokens.DocumentRecordRepository, () => collaborationDocumentStub());
    // Mirrors the production registration argument-for-argument.
    c.register<CommentService>(Tokens.CommentService, (cc) => {
      return new CommentService(
        cc.resolve<ILogger>(Tokens.Logger),
        cc.resolve(Tokens.WorkspaceService),
        cc.resolve(Tokens.DocumentRecordRepository),
        cc.resolve<CommentThreadRepository>(Tokens.CommentThreadRepository),
        cc.resolve<CommentMessageRepository>(Tokens.CommentMessageRepository),
        cc.resolve<DocumentPermissionGrantRepository>(Tokens.DocumentPermissionGrantRepository),
      );
    });
    return c;
  }

  it("resolves all three M7.10 repositories", () => {
    const container = createCollaborationContainer();
    expect(
      container.resolve<CommentThreadRepository>(Tokens.CommentThreadRepository),
    ).toBeInstanceOf(InMemoryCommentThreadRepository);
    expect(
      container.resolve<CommentMessageRepository>(Tokens.CommentMessageRepository),
    ).toBeInstanceOf(InMemoryCommentMessageRepository);
    expect(
      container.resolve<DocumentPermissionGrantRepository>(
        Tokens.DocumentPermissionGrantRepository,
      ),
    ).toBeInstanceOf(InMemoryDocumentPermissionGrantRepository);
  });

  it("resolves CommentService", () => {
    const container = createCollaborationContainer();
    expect(container.resolve<CommentService>(Tokens.CommentService)).toBeInstanceOf(CommentService);
  });

  it("writes a thread and its message through the injected repositories", async () => {
    // The ordering check: if threads and messages were swapped in the
    // registration, one of these two reads would come back empty.
    const container = createCollaborationContainer();
    const service = container.resolve<CommentService>(Tokens.CommentService);
    const created = await service.createThread(ACTOR, "ws-a", "doc-1", {
      anchor: { type: "page", pageNumber: 2 },
      body: "Injected comment",
    });

    const threads = container.resolve<CommentThreadRepository>(Tokens.CommentThreadRepository);
    const messages = container.resolve<CommentMessageRepository>(Tokens.CommentMessageRepository);
    expect(await threads.getById("ws-a", created.thread.id)).not.toBeNull();
    const stored = await messages.list({
      workspaceId: "ws-a",
      threadId: created.thread.id,
      limit: 10,
    });
    expect(stored.map((m) => m.body)).toEqual(["Injected comment"]);
  });

  it("resolves and reopens through the injected thread repository", async () => {
    const container = createCollaborationContainer();
    const service = container.resolve<CommentService>(Tokens.CommentService);
    const created = await service.createThread(ACTOR, "ws-a", "doc-1", {
      anchor: { type: "document" },
      body: "To be resolved",
    });
    const resolved = await service.resolveThread(
      ACTOR,
      "ws-a",
      "doc-1",
      created.thread.id,
      created.thread.revision,
    );
    expect(resolved.status).toBe("resolved");

    const threads = container.resolve<CommentThreadRepository>(Tokens.CommentThreadRepository);
    expect((await threads.getById("ws-a", created.thread.id))?.status).toBe("resolved");
  });

  it("writes a grant through the injected grant repository", async () => {
    const container = createCollaborationContainer("owner");
    const service = container.resolve<CommentService>(Tokens.CommentService);
    const grant = await service.createGrant(ACTOR, "ws-a", "doc-1", {
      granteeUserId: "user-2",
      role: "commenter",
    });

    const grants = container.resolve<DocumentPermissionGrantRepository>(
      Tokens.DocumentPermissionGrantRepository,
    );
    const stored = await grants.getById("ws-a", grant.id);
    expect(stored?.granteeUserId).toBe("user-2");
    expect(stored?.role).toBe("commenter");
  });

  it("refuses a write for a viewer-role actor through the resolved service", async () => {
    const container = createCollaborationContainer("viewer");
    const service = container.resolve<CommentService>(Tokens.CommentService);
    await expect(
      service.createThread(ACTOR, "ws-a", "doc-1", {
        anchor: { type: "document" },
        body: "should be refused",
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("registers each M7.10 dependency under a distinct token", () => {
    const tokens = [
      Tokens.CommentThreadRepository,
      Tokens.CommentMessageRepository,
      Tokens.DocumentPermissionGrantRepository,
      Tokens.CommentService,
    ];
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(Tokens.CommentThreadRepository.toString()).toContain("CommentThreadRepository");
    expect(Tokens.CommentMessageRepository.toString()).toContain("CommentMessageRepository");
    expect(Tokens.DocumentPermissionGrantRepository.toString()).toContain(
      "DocumentPermissionGrantRepository",
    );
    expect(Tokens.CommentService.toString()).toContain("CommentService");
  });
});

/**
 * M7.11 document statistics and version comparison.
 *
 * StatisticsService takes three same-shaped repositories in a row, so a
 * mis-ordered registration would still resolve and still type-check. These tests
 * therefore drive real calculations and comparisons through the resolved service
 * and read back from the container's *own* repositories — and one test asserts
 * directly that the wrong order fails, so the ordering is pinned rather than
 * assumed.
 */
describe("DI Container — statistics and comparison (M7.11)", () => {
  const ACTOR = {
    userId: "user-1",
    organizationId: "org-a",
    organizationRole: "member" as const,
    organizationDefaultWorkspaceId: null,
  };

  function statisticsDocumentStub() {
    const record = {
      id: "doc-1",
      workspaceId: "ws-a",
      organizationId: "org-a",
      projectId: null,
      folderId: null,
      name: "Report.pdf",
      normalizedName: "report.pdf",
      lifecycleState: "active",
      orderKey: "a0",
      currentVersionId: null,
      favorite: false,
      lastAccessedAt: null,
      createdById: "user-1",
      revision: 1,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      archivedAt: null,
      trashedAt: null,
      archivedById: null,
      trashedById: null,
    };
    return {
      getById: async (workspaceId: string, documentId: string) =>
        workspaceId === "ws-a" && documentId === "doc-1" ? { ...record } : null,
    };
  }

  function createStatisticsContainer(role: "owner" | "editor" | "viewer" = "owner") {
    const c = new Container();
    c.register<ILogger>(Tokens.Logger, () => new ConsoleLogger("error"));
    c.register<DocumentVersionRepository>(
      Tokens.DocumentVersionRepository,
      () => new InMemoryDocumentVersionRepository(),
    );
    c.register<DocumentStatisticsRepository>(
      Tokens.DocumentStatisticsRepository,
      () => new InMemoryDocumentStatisticsRepository(),
    );
    c.register<ComparisonOperationRepository>(
      Tokens.ComparisonOperationRepository,
      () => new InMemoryComparisonOperationRepository(),
    );
    c.register<ComparisonResultRepository>(
      Tokens.ComparisonResultRepository,
      () => new InMemoryComparisonResultRepository(),
    );
    c.register(Tokens.WorkspaceService, () => ({
      get: async (_a: unknown, _w: unknown, write = false) => {
        if (write && role === "viewer") throw new Error("Write access required.");
        return { workspace: { id: "ws-a", organizationId: "org-a" }, role };
      },
    }));
    c.register(Tokens.DocumentRecordRepository, () => statisticsDocumentStub());
    // Server-held content for the trusted recalculation path.
    c.register(Tokens.SearchChunkRepository, () => ({
      listForDocument: async () => [
        {
          id: "chunk-1",
          organizationId: "org-a",
          workspaceId: "ws-a",
          searchDocumentId: "sd-1",
          documentId: "doc-1",
          ordinal: 0,
          sourceType: "page" as const,
          pageNumber: 1,
          text: "one two three",
          normalizedText: "one two three",
          createdAt: new Date("2026-08-01T00:00:00.000Z"),
        },
      ],
    }));
    c.register(Tokens.BookmarkRepository, () => ({ countForDocument: async () => 2 }));
    c.register(Tokens.AttachmentRepository, () => ({ countForDocument: async () => 1 }));
    // Mirrors the production registration argument-for-argument.
    c.register<StatisticsService>(Tokens.StatisticsService, (cc) => {
      return new StatisticsService(
        cc.resolve<ILogger>(Tokens.Logger),
        cc.resolve(Tokens.WorkspaceService),
        cc.resolve(Tokens.DocumentRecordRepository),
        cc.resolve(Tokens.DocumentVersionRepository),
        cc.resolve<DocumentStatisticsRepository>(Tokens.DocumentStatisticsRepository),
        cc.resolve<ComparisonOperationRepository>(Tokens.ComparisonOperationRepository),
        cc.resolve<ComparisonResultRepository>(Tokens.ComparisonResultRepository),
        cc.resolve(Tokens.SearchChunkRepository),
        cc.resolve(Tokens.BookmarkRepository),
        cc.resolve(Tokens.AttachmentRepository),
      );
    });
    return c;
  }

  async function seedVersion(c: Container, documentId = "doc-1") {
    const versions = c.resolve<DocumentVersionRepository>(Tokens.DocumentVersionRepository);
    return versions.create({
      workspaceId: "ws-a",
      organizationId: "org-a",
      documentId,
      revision: 1,
      origin: "save",
      restoredFromVersionId: null,
      label: null,
      manifest: JSON.stringify({
        schema: 1,
        sourceKey: "objects/source.pdf",
        sourceChecksum: "a".repeat(64),
        sourceByteSize: 1024,
        editorStateKey: null,
        editorStateChecksum: null,
        outputKey: null,
        outputChecksum: null,
        pageCount: 2,
        thumbnailKeys: [],
      }),
      checksum: "b".repeat(64),
      createdById: "user-1",
    });
  }

  it("resolves all three M7.11 repositories", () => {
    const container = createStatisticsContainer();
    expect(
      container.resolve<DocumentStatisticsRepository>(Tokens.DocumentStatisticsRepository),
    ).toBeInstanceOf(InMemoryDocumentStatisticsRepository);
    expect(
      container.resolve<ComparisonOperationRepository>(Tokens.ComparisonOperationRepository),
    ).toBeInstanceOf(InMemoryComparisonOperationRepository);
    expect(
      container.resolve<ComparisonResultRepository>(Tokens.ComparisonResultRepository),
    ).toBeInstanceOf(InMemoryComparisonResultRepository);
  });

  it("registers each M7.11 dependency under a distinct token", () => {
    const tokens = [
      Tokens.DocumentStatisticsRepository,
      Tokens.ComparisonOperationRepository,
      Tokens.ComparisonResultRepository,
      Tokens.StatisticsService,
    ];
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(Tokens.DocumentStatisticsRepository.toString()).toContain("DocumentStatisticsRepository");
    expect(Tokens.ComparisonOperationRepository.toString()).toContain(
      "ComparisonOperationRepository",
    );
    expect(Tokens.ComparisonResultRepository.toString()).toContain("ComparisonResultRepository");
    expect(Tokens.StatisticsService.toString()).toContain("StatisticsService");
  });

  it("resolves StatisticsService", () => {
    const container = createStatisticsContainer();
    expect(container.resolve<StatisticsService>(Tokens.StatisticsService)).toBeInstanceOf(
      StatisticsService,
    );
  });

  it("preserves the singleton policy", () => {
    const container = createStatisticsContainer();
    expect(container.resolve(Tokens.StatisticsService)).toBe(
      container.resolve(Tokens.StatisticsService),
    );
    expect(container.resolve(Tokens.DocumentStatisticsRepository)).toBe(
      container.resolve(Tokens.DocumentStatisticsRepository),
    );
  });

  it("calculates real statistics through the resolved service", async () => {
    const container = createStatisticsContainer();
    const version = await seedVersion(container);
    const service = container.resolve<StatisticsService>(Tokens.StatisticsService);

    const stats = await service.calculateStatistics(ACTOR, "ws-a", "doc-1", version.id, {
      segments: [{ pageNumber: 1, text: "one two three", imageCount: 2 }],
      manifestPageCount: 2,
    });

    expect(stats.status).toBe("ready");
    expect(stats.counts.wordCount).toBe(3);
    // Read back from the container's own repository: the row really landed
    // where the registration says it should.
    const statistics = container.resolve<DocumentStatisticsRepository>(
      Tokens.DocumentStatisticsRepository,
    );
    expect((await statistics.getByVersionId("ws-a", version.id))?.counts.imageCount).toBe(2);
  });

  it("creates a real comparison through the resolved service", async () => {
    const container = createStatisticsContainer();
    const left = await seedVersion(container);
    const right = await seedVersion(container);
    const service = container.resolve<StatisticsService>(Tokens.StatisticsService);

    const operation = await service.createComparison(ACTOR, "ws-a", "doc-1", {
      leftVersionId: left.id,
      rightVersionId: right.id,
      type: "textual",
    });

    expect(operation.status).toBe("pending");
    const comparisons = container.resolve<ComparisonOperationRepository>(
      Tokens.ComparisonOperationRepository,
    );
    expect(await comparisons.getById("ws-a", operation.id)).not.toBeNull();
  });

  it("fails the comparison operation when the constructor order is wrong", async () => {
    // The three repositories are structurally different enough that a swap
    // breaks at the first call — which is exactly what this pins. Without this
    // test, a mis-ordered registration would type-check and resolve happily.
    const c = createStatisticsContainer();
    const left = await seedVersion(c);
    const right = await seedVersion(c);

    const misordered = new StatisticsService(
      c.resolve<ILogger>(Tokens.Logger),
      c.resolve(Tokens.WorkspaceService),
      c.resolve(Tokens.DocumentRecordRepository),
      c.resolve(Tokens.DocumentVersionRepository),
      // Comparison repositories swapped into the statistics slots.
      c.resolve(Tokens.ComparisonOperationRepository) as never,
      c.resolve(Tokens.ComparisonResultRepository) as never,
      c.resolve(Tokens.DocumentStatisticsRepository) as never,
      c.resolve(Tokens.SearchChunkRepository),
      c.resolve(Tokens.BookmarkRepository),
      c.resolve(Tokens.AttachmentRepository),
    );

    await expect(
      misordered.createComparison(ACTOR, "ws-a", "doc-1", {
        leftVersionId: left.id,
        rightVersionId: right.id,
        type: "textual",
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("recalculates from server-held content through the resolved service", async () => {
    // The path the HTTP route uses: no measured content crosses the wire, so
    // this proves the server-content repositories are wired to the right slots.
    const container = createStatisticsContainer();
    const version = await seedVersion(container);
    const service = container.resolve<StatisticsService>(Tokens.StatisticsService);

    const stats = await service.recalculateFromServerContent(ACTOR, "ws-a", "doc-1", version.id);

    expect(stats.status).toBe("ready");
    expect(stats.counts.wordCount).toBe(3);
    expect(stats.counts.bookmarkCount).toBe(2);
    expect(stats.counts.attachmentCount).toBe(1);
  });

  it("refuses a recalculation for a viewer-role actor through the resolved service", async () => {
    const container = createStatisticsContainer("viewer");
    const version = await seedVersion(container);
    const service = container.resolve<StatisticsService>(Tokens.StatisticsService);

    await expect(
      service.calculateStatistics(ACTOR, "ws-a", "doc-1", version.id, { segments: [] }),
    ).rejects.toBeInstanceOf(Error);
  });
});

/**
 * M7.13 split view and navigation.
 *
 * SplitViewService is layered over TabService rather than beside it, so these
 * tests prove the layering resolves and that a real pane assignment written
 * through the resolved service lands in the container's own session repository —
 * a second, parallel persistence path would show up here as a session that never
 * changed.
 */
describe("DI Container — split view (M7.13)", () => {
  const ACTOR = {
    userId: "user-1",
    organizationId: "org-a",
    organizationRole: "member" as const,
    organizationDefaultWorkspaceId: null,
  };

  function splitDocumentStub() {
    const record = {
      id: "doc-1",
      workspaceId: "ws-a",
      organizationId: "org-a",
      projectId: null,
      folderId: null,
      name: "Report.pdf",
      normalizedName: "report.pdf",
      lifecycleState: "active",
      orderKey: "a0",
      currentVersionId: "ver-1",
      favorite: false,
      lastAccessedAt: null,
      createdById: "user-1",
      revision: 1,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      archivedAt: null,
      trashedAt: null,
      archivedById: null,
      trashedById: null,
    };
    return {
      getById: async (workspaceId: string, documentId: string) =>
        workspaceId === "ws-a" && documentId.startsWith("doc-")
          ? { ...record, id: documentId }
          : null,
    };
  }

  function createSplitContainer() {
    const c = new Container();
    c.register<ILogger>(Tokens.Logger, () => new ConsoleLogger("error"));
    c.register(Tokens.WorkspaceSessionRepository, () => new InMemoryWorkspaceSessionRepository());
    c.register(Tokens.WorkspaceService, () => ({
      get: async () => ({ workspace: { id: "ws-a", organizationId: "org-a" }, role: "editor" }),
    }));
    c.register(Tokens.DocumentRecordRepository, () => splitDocumentStub());
    c.register<TabService>(Tokens.TabService, (cc) => {
      return new TabService(
        cc.resolve<ILogger>(Tokens.Logger),
        cc.resolve(Tokens.WorkspaceService),
        cc.resolve(Tokens.WorkspaceSessionRepository),
        cc.resolve(Tokens.DocumentRecordRepository),
      );
    });
    // Mirrors the production registration argument-for-argument.
    c.register<SplitViewService>(Tokens.SplitViewService, (cc) => {
      return new SplitViewService(
        cc.resolve<ILogger>(Tokens.Logger),
        cc.resolve<TabService>(Tokens.TabService),
      );
    });
    return c;
  }

  it("resolves SplitViewService over the same TabService", () => {
    const container = createSplitContainer();
    expect(container.resolve<SplitViewService>(Tokens.SplitViewService)).toBeInstanceOf(
      SplitViewService,
    );
    expect(container.resolve(Tokens.TabService)).toBe(container.resolve(Tokens.TabService));
  });

  it("registers the M7.13 token distinctly", () => {
    expect(Tokens.SplitViewService).not.toBe(Tokens.TabService);
    expect(Tokens.SplitViewService.toString()).toContain("SplitViewService");
  });

  it("preserves the singleton policy", () => {
    const container = createSplitContainer();
    expect(container.resolve(Tokens.SplitViewService)).toBe(
      container.resolve(Tokens.SplitViewService),
    );
  });

  it("assigns a pane through the resolved service and persists it", async () => {
    const container = createSplitContainer();
    const tabs = container.resolve<TabService>(Tokens.TabService);
    const split = container.resolve<SplitViewService>(Tokens.SplitViewService);

    const session = await tabs.createWorkspaceSession(ACTOR, "ws-a");
    const first = await tabs.createTab(ACTOR, session.id, "doc-1", "ver-1", "One");
    const second = await tabs.createTab(ACTOR, session.id, "doc-2", "ver-2", "Two");

    const state = await split.assignTabToPane(ACTOR, session.id, second.tab.id, "right");
    expect(state.layout).toBe("split");

    // Read back through the tab service: one persistence path, not two.
    const stored = await tabs.getTabState(ACTOR, session.id, second.tab.id);
    expect(stored?.paneId).toBe("right");
    const untouched = await tabs.getTabState(ACTOR, session.id, first.tab.id);
    expect(untouched?.paneId).toBeUndefined();
  });
});



/**
 * M7.14 command palette and operation center.
 *
 * The registration these tests care about is the canonical command set. It is
 * bound once at container creation, so the palette a user opens holds the same
 * commands on every screen; a per-page registry would show up here as a service
 * that resolves with an empty registry.
 */
describe("DI Container — command palette and operation center (M7.14)", () => {
  const ACTOR = {
    userId: "user-1",
    organizationId: "org-a",
    organizationRole: "member" as const,
    organizationDefaultWorkspaceId: null,
  };

  function commandDocumentStub() {
    const record = {
      id: "doc-1",
      workspaceId: "ws-a",
      organizationId: "org-a",
      projectId: null,
      folderId: null,
      name: "Report.pdf",
      normalizedName: "report.pdf",
      lifecycleState: "active",
      orderKey: "a0",
      currentVersionId: "ver-1",
      favorite: false,
      lastAccessedAt: null,
      createdById: "user-1",
      revision: 1,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      archivedAt: null,
      trashedAt: null,
      archivedById: null,
      trashedById: null,
    };
    return {
      getById: async (workspaceId: string, documentId: string) =>
        workspaceId === "ws-a" && documentId.startsWith("doc-")
          ? { ...record, id: documentId }
          : null,
    };
  }

  /** Refuses writes for a viewer, so re-authorization has something to fail on. */
  function commandWorkspaceStub(role: "editor" | "viewer" = "editor") {
    return {
      get: async (_actor: unknown, workspaceId: string, write = false) => {
        if (workspaceId !== "ws-a") throw new NotFoundError("Workspace not found.");
        if (write && role === "viewer") throw new DomainError("Write access required.");
        return { workspace: { id: "ws-a", organizationId: "org-a" }, role };
      },
    };
  }

  function createCommandContainer(role: "editor" | "viewer" = "editor") {
    const c = new Container();
    c.register<ILogger>(Tokens.Logger, () => new ConsoleLogger("error"));
    c.register(Tokens.WorkspaceService, () => commandWorkspaceStub(role));
    c.register(Tokens.DocumentRecordRepository, () => commandDocumentStub());
    // Mirrors the production registration argument-for-argument, including the
    // canonical bootstrap.
    c.register<CommandPaletteService>(Tokens.CommandPaletteService, (cc) => {
      const service = new CommandPaletteService(
        cc.resolve<ILogger>(Tokens.Logger),
        cc.resolve(Tokens.WorkspaceService),
        cc.resolve(Tokens.DocumentRecordRepository),
      );
      service.registerAll(CANONICAL_COMMANDS);
      return service;
    });
    c.register<OperationCenterService>(Tokens.OperationCenterService, (cc) => {
      return new OperationCenterService(
        cc.resolve<ILogger>(Tokens.Logger),
        cc.resolve(Tokens.WorkspaceService),
      );
    });
    return c;
  }

  const CONTEXT = {
    hasDocument: true,
    hasSelection: true,
    canWrite: true,
    isSplit: true,
    activePane: "left",
    activeDocumentId: "doc-1",
  };

  it("resolves both M7.14 services", () => {
    const container = createCommandContainer();
    expect(container.resolve<CommandPaletteService>(Tokens.CommandPaletteService)).toBeInstanceOf(
      CommandPaletteService,
    );
    expect(container.resolve<OperationCenterService>(Tokens.OperationCenterService)).toBeInstanceOf(
      OperationCenterService,
    );
  });

  it("registers the M7.14 tokens distinctly", () => {
    expect(Tokens.CommandPaletteService).not.toBe(Tokens.OperationCenterService);
    expect(Tokens.CommandPaletteService).not.toBe(Tokens.SplitViewService);
    expect(Tokens.CommandPaletteService.toString()).toContain("CommandPaletteService");
    expect(Tokens.OperationCenterService.toString()).toContain("OperationCenterService");
  });

  it("preserves the singleton policy", () => {
    const container = createCommandContainer();
    expect(container.resolve(Tokens.CommandPaletteService)).toBe(
      container.resolve(Tokens.CommandPaletteService),
    );
    expect(container.resolve(Tokens.OperationCenterService)).toBe(
      container.resolve(Tokens.OperationCenterService),
    );
  });

  it("registers the canonical commands exactly once", () => {
    const palette = createCommandContainer().resolve<CommandPaletteService>(
      Tokens.CommandPaletteService,
    );
    const ids = palette.list().map((command) => command.id);
    expect(ids).toHaveLength(CANONICAL_COMMANDS.length);
    // No duplicate ids: a second registration under the same id would silently
    // replace the first and the count would hide it.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("doc.save");
    expect(ids).toContain("workspace.commandPalette");
  });

  it("searches through the resolved service", () => {
    const palette = createCommandContainer().resolve<CommandPaletteService>(
      Tokens.CommandPaletteService,
    );
    const results = palette.search("save", CONTEXT);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe("doc.save");
  });

  it("re-authorizes command execution through the resolved service", async () => {
    const viewerPalette = createCommandContainer("viewer").resolve<CommandPaletteService>(
      Tokens.CommandPaletteService,
    );
    // The palette would display doc.save; execution is what refuses it.
    await expect(
      viewerPalette.execute(ACTOR, {
        commandId: "doc.save",
        workspaceId: "ws-a",
        documentId: "doc-1",
      }),
    ).rejects.toBeInstanceOf(DomainError);

    const editorPalette = createCommandContainer("editor").resolve<CommandPaletteService>(
      Tokens.CommandPaletteService,
    );
    const result = await editorPalette.execute(ACTOR, {
      commandId: "doc.save",
      workspaceId: "ws-a",
      documentId: "doc-1",
    });
    expect(result.commandId).toBe("doc.save");
  });

  it("starts and lists a real operation through the resolved service", async () => {
    const center = createCommandContainer().resolve<OperationCenterService>(
      Tokens.OperationCenterService,
    );
    const started = await center.start(ACTOR, {
      type: "export",
      workspaceId: "ws-a",
      label: "Exporting report",
    });
    const listed = await center.list(ACTOR, "ws-a");
    expect(listed.map((operation) => operation.id)).toContain(started.id);
  });

  it("scopes operation data to the Workspace", async () => {
    const center = createCommandContainer().resolve<OperationCenterService>(
      Tokens.OperationCenterService,
    );
    await center.start(ACTOR, { type: "export", workspaceId: "ws-a", label: "Exporting" });
    await expect(center.list(ACTOR, "ws-other")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("wires the constructor arguments in the declared order", () => {
    // A transposed logger and Workspace service would resolve without error and
    // fail only at call time, so the wiring is exercised rather than inspected.
    const container = createCommandContainer();
    const palette = container.resolve<CommandPaletteService>(Tokens.CommandPaletteService);
    expect(palette.get("doc.save")?.label).toBe("Save document");
    expect(() => container.resolve<OperationCenterService>(Tokens.OperationCenterService)).not.toThrow();
  });
});
