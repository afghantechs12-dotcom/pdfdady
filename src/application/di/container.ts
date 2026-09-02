import { PrismaClient } from "@prisma/client";

import type { AppConfig } from "@/src/infrastructure/config/env";
import type { ILogger } from "@/src/application/ports/Logger";
import type { IFeatureFlagRepository } from "@/src/application/ports/repositories/FeatureFlagRepository";
import type { IJobRepository } from "@/src/application/ports/repositories/JobRepository";
import type { IFeatureFlagService } from "@/src/application/ports/featureflags/FeatureFlagService";
import type { IQueue } from "@/src/application/ports/queue/Queue";
import type { IWorker } from "@/src/application/ports/queue/Worker";
import { StuckJobRecoveryService } from "@/src/application/services/StuckJobRecoveryService";
import type { IHealthCheck } from "@/src/application/ports/HealthCheck";
import type { IObjectStorage } from "@/src/application/ports/storage/ObjectStorage";
import type { ISignedUrlService } from "@/src/application/ports/storage/SignedUrlService";
import type { IFileMetadataRepository } from "@/src/application/ports/storage/FileMetadataRepository";
import type { IUploadService } from "@/src/application/ports/storage/UploadService";
import type { IDownloadService } from "@/src/application/ports/storage/DownloadService";
import type { IMultipartUpload } from "@/src/application/ports/storage/MultipartUpload";
import type { IJobScheduler } from "@/src/application/ports/queue/JobScheduler";
import type { IJobEvents } from "@/src/application/ports/queue/JobEvents";
import type { IUserProvider } from "@/src/application/ports/auth/UserProvider";
import type { ISessionProvider } from "@/src/application/ports/auth/SessionProvider";
import type { IOrganizationProvider } from "@/src/application/ports/auth/OrganizationProvider";
import type { IRoleProvider } from "@/src/application/ports/auth/RoleProvider";
import type { IAuditLogRepository } from "@/src/application/ports/auth/AuditLogRepository";
import type { IMetrics } from "@/src/application/ports/observability/Metrics";
import type { ITracing } from "@/src/application/ports/observability/Tracing";
import type { IAnalytics } from "@/src/application/ports/observability/Analytics";
import type { IErrorReporter } from "@/src/application/ports/observability/ErrorReporter";

import { getConfig } from "@/src/infrastructure/config/env";
import { getPrismaClient } from "@/src/infrastructure/db/prisma";
import { ConsoleLogger } from "@/src/infrastructure/logging/ConsoleLogger";
import { PrismaFeatureFlagRepository } from "@/src/infrastructure/persistence/PrismaFeatureFlagRepository";
import { PrismaJobRepository } from "@/src/infrastructure/persistence/PrismaJobRepository";
import { InMemoryQueue } from "@/src/infrastructure/queue/InMemoryQueue";
import { InMemoryWorker } from "@/src/infrastructure/queue/InMemoryWorker";
import { DbHealthCheck } from "@/src/infrastructure/health/DbHealthCheck";
import { FeatureFlagService } from "@/src/application/services/FeatureFlagService";
import { UploadService } from "@/src/application/services/UploadService";
import { DownloadService } from "@/src/application/services/DownloadService";
import { LocalFileStorage } from "@/src/infrastructure/storage/LocalFileStorage";
import { R2ObjectStorage } from "@/src/infrastructure/storage/R2ObjectStorage";
import { LocalSignedUrlService } from "@/src/infrastructure/storage/LocalSignedUrlService";
import { R2SignedUrlService } from "@/src/infrastructure/storage/R2SignedUrlService";
import { PrismaStoredFileRepository } from "@/src/infrastructure/persistence/PrismaStoredFileRepository";
import { LocalMultipartUpload } from "@/src/infrastructure/storage/LocalMultipartUpload";
import { R2MultipartUpload } from "@/src/infrastructure/storage/R2MultipartUpload";
import path from "node:path";
import { RedisQueue } from "@/src/infrastructure/queue/RedisQueue";
import { RedisWorker } from "@/src/infrastructure/queue/RedisWorker";
import { RedisJobScheduler } from "@/src/infrastructure/queue/RedisJobScheduler";
import { RedisJobEvents } from "@/src/infrastructure/queue/RedisJobEvents";
import { InMemoryJobScheduler } from "@/src/infrastructure/queue/InMemoryJobScheduler";
import { InMemoryJobEvents } from "@/src/infrastructure/queue/InMemoryJobEvents";
import { ProcessingJobService } from "@/src/application/services/ProcessingJobService";
import { ProcessingUsageRecorder } from "@/src/application/services/ProcessingUsageRecorder";
import {
  UsageMeteringService,
  resolveLimitMode,
} from "@/src/application/services/UsageMeteringService";
import type { IUsageRepository } from "@/src/application/ports/metering/UsageRepository";
import type { IEntitlementProvider } from "@/src/application/ports/metering/EntitlementProvider";
import { PrismaUsageRepository } from "@/src/infrastructure/persistence/PrismaUsageRepository";
import { ProductAnalyticsService } from "@/src/application/services/ProductAnalyticsService";
import { UsageAnalyticsReadService } from "@/src/application/services/UsageAnalyticsReadService";
import { OrganizationEntitlementProvider } from "@/src/infrastructure/metering/OrganizationEntitlementProvider";
import type { IBillingRepository } from "@/src/application/ports/billing/BillingRepository";
import type { IBillingProvider } from "@/src/application/ports/billing/BillingProvider";
import { PrismaBillingRepository } from "@/src/infrastructure/persistence/PrismaBillingRepository";
import { StripeBillingProvider } from "@/src/infrastructure/billing/StripeBillingProvider";
import { BillingService } from "@/src/application/services/BillingService";
import type { IToolProcessorRegistry } from "@/src/application/ports/processing/ToolProcessor";
import { buildProcessorRegistry } from "@/src/infrastructure/processing/processorRegistry";
import { LocalUserProvider } from "@/src/infrastructure/auth/LocalUserProvider";
import { LocalSessionProvider } from "@/src/infrastructure/auth/LocalSessionProvider";
import { LocalOrganizationProvider } from "@/src/infrastructure/auth/LocalOrganizationProvider";
import { LocalRoleProvider } from "@/src/infrastructure/auth/LocalRoleProvider";
import { PrismaAuditLogRepository } from "@/src/infrastructure/persistence/PrismaAuditLogRepository";
import { PrismaWorkspaceRepository } from "@/src/infrastructure/persistence/PrismaWorkspaceRepository";
import { PrismaWorkspaceMembershipRepository } from "@/src/infrastructure/persistence/PrismaWorkspaceMembershipRepository";
import { PrismaProjectRepository } from "@/src/infrastructure/persistence/PrismaProjectRepository";
import { PrismaFolderRepository } from "@/src/infrastructure/persistence/PrismaFolderRepository";
import { PrismaDocumentRecordRepository } from "@/src/infrastructure/persistence/PrismaDocumentRecordRepository";
import { PrismaWorkspaceSessionRepository } from "@/src/infrastructure/persistence/PrismaWorkspaceSessionRepository";
import { PrismaAutosaveDraftRepository } from "@/src/infrastructure/persistence/PrismaAutosaveDraftRepository";
import { PrismaDocumentVersionRepository } from "@/src/infrastructure/persistence/PrismaDocumentVersionRepository";
import { PrismaTagRepository } from "@/src/infrastructure/persistence/PrismaTagRepository";
import { PrismaDocumentTagRepository } from "@/src/infrastructure/persistence/PrismaDocumentTagRepository";
import { PrismaSmartCollectionRepository } from "@/src/infrastructure/persistence/PrismaSmartCollectionRepository";
import { PrismaSearchDocumentRepository } from "@/src/infrastructure/persistence/PrismaSearchDocumentRepository";
import { PrismaSearchChunkRepository } from "@/src/infrastructure/persistence/PrismaSearchChunkRepository";
import { SQLiteSearchIndexAdapter } from "@/src/infrastructure/persistence/SQLiteSearchIndexAdapter";
import { PrismaDocumentIngestionRepository } from "@/src/infrastructure/persistence/PrismaDocumentIngestionRepository";
import { PrismaDocumentMetadataRepository } from "@/src/infrastructure/persistence/PrismaDocumentMetadataRepository";
import { PrismaBookmarkRepository } from "@/src/infrastructure/persistence/PrismaBookmarkRepository";
import { PrismaOutlineItemRepository } from "@/src/infrastructure/persistence/PrismaOutlineItemRepository";
import { PrismaAttachmentRepository } from "@/src/infrastructure/persistence/PrismaAttachmentRepository";
import { PrismaCommentThreadRepository } from "@/src/infrastructure/persistence/PrismaCommentThreadRepository";
import { PrismaCommentMessageRepository } from "@/src/infrastructure/persistence/PrismaCommentMessageRepository";
import { PrismaDocumentPermissionGrantRepository } from "@/src/infrastructure/persistence/PrismaDocumentPermissionGrantRepository";
import { PrismaDocumentStatisticsRepository } from "@/src/infrastructure/persistence/PrismaDocumentStatisticsRepository";
import { PrismaComparisonOperationRepository } from "@/src/infrastructure/persistence/PrismaComparisonOperationRepository";
import { PrismaComparisonResultRepository } from "@/src/infrastructure/persistence/PrismaComparisonResultRepository";
import { WorkspaceAwareUploadService } from "@/src/application/services/WorkspaceAwareUploadService";
import { DocumentIngestionService } from "@/src/application/services/DocumentIngestionService";
import { AutosaveService } from "@/src/application/services/AutosaveService";
import { VersionService } from "@/src/application/services/VersionService";
import { TagService } from "@/src/application/services/TagService";
import { CommentService } from "@/src/application/services/CommentService";
import { StatisticsService } from "@/src/application/services/StatisticsService";
import { SearchService } from "@/src/application/services/SearchService";
import { MetadataService } from "@/src/application/services/MetadataService";
import type { WorkspaceSessionRepository } from "@/src/application/ports/workspaces/WorkspaceSessionRepository";
import type { AutosaveDraftRepository } from "@/src/application/ports/workspaces/AutosaveDraftRepository";
import type { DocumentVersionRepository } from "@/src/application/ports/workspaces/DocumentVersionRepository";
import type { TagRepository } from "@/src/application/ports/workspaces/TagRepository";
import type { DocumentTagRepository } from "@/src/application/ports/workspaces/DocumentTagRepository";
import type { SmartCollectionRepository } from "@/src/application/ports/workspaces/SmartCollectionRepository";
import type { SearchDocumentRepository } from "@/src/application/ports/workspaces/SearchDocumentRepository";
import type { SearchChunkRepository } from "@/src/application/ports/workspaces/SearchChunkRepository";
import type { SearchIndexPort } from "@/src/application/ports/workspaces/SearchIndexPort";
import type { DocumentIngestionRepository } from "@/src/application/ports/workspaces/DocumentIngestionRepository";
import type { DocumentMetadataRepository } from "@/src/application/ports/workspaces/DocumentMetadataRepository";
import type { BookmarkRepository } from "@/src/application/ports/workspaces/BookmarkRepository";
import type { OutlineItemRepository } from "@/src/application/ports/workspaces/OutlineItemRepository";
import type { AttachmentRepository } from "@/src/application/ports/workspaces/AttachmentRepository";
import type { CommentThreadRepository } from "@/src/application/ports/workspaces/CommentThreadRepository";
import type { CommentMessageRepository } from "@/src/application/ports/workspaces/CommentMessageRepository";
import type { DocumentPermissionGrantRepository } from "@/src/application/ports/workspaces/DocumentPermissionGrantRepository";
import type { DocumentStatisticsRepository } from "@/src/application/ports/workspaces/DocumentStatisticsRepository";
import type { ComparisonOperationRepository } from "@/src/application/ports/workspaces/ComparisonOperationRepository";
import type { ComparisonResultRepository } from "@/src/application/ports/workspaces/ComparisonResultRepository";
import { TabService } from "@/src/application/services/TabService";
import { SplitViewService } from "@/src/application/services/SplitViewService";
import { CommandPaletteService } from "@/src/application/services/CommandPaletteService";
import { OperationCenterService } from "@/src/application/services/OperationCenterService";
import { CANONICAL_COMMANDS } from "@/src/domain/entities/canonicalCommands";
import { WorkspaceAuthorizationResolver } from "@/src/application/services/WorkspaceAuthorizationResolver";
import { WorkspaceService } from "@/src/application/services/WorkspaceService";
import { WorkspaceMembershipService } from "@/src/application/services/WorkspaceMembershipService";
import { ProjectService } from "@/src/application/services/ProjectService";
import { FolderService } from "@/src/application/services/FolderService";
import { DocumentRecordService } from "@/src/application/services/DocumentRecordService";
import { AuthService } from "@/src/application/services/AuthService";
import { ConsoleMetrics } from "@/src/infrastructure/observability/ConsoleMetrics";
import { ConsoleTracing } from "@/src/infrastructure/observability/ConsoleTracing";
import { ConsoleAnalytics } from "@/src/infrastructure/observability/ConsoleAnalytics";
import { ConsoleErrorReporter } from "@/src/infrastructure/observability/ConsoleErrorReporter";
import { PdfToolJobService } from "@/src/application/services/PdfToolJobService";
import type { ISelectionService } from "@/src/application/editor/ports/ISelectionService";
import type { ILayerService } from "@/src/application/editor/ports/ILayerService";
import type { ISerializer } from "@/src/application/editor/ports/ISerializer";
import type { EditorServiceFactory } from "@/src/application/editor/EditorDocumentService";
import { SelectionService } from "@/src/application/editor/selection/SelectionService";
import { LayerService } from "@/src/application/editor/layers/LayerService";
import { SerializationService } from "@/src/application/editor/serialization/SerializationService";
import { PluginRegistry } from "@/src/application/editor/plugins/PluginRegistry";
import { createEditorDocumentService } from "@/src/application/editor/EditorDocumentService";
import { CommandHistory } from "@/src/application/editor/commands/CommandHistory";

import { Tokens } from "./tokens";

type Factory<T> = (c: Container) => T;

/**
 * Minimal dependency-injection container (service locator with singleton
 * caching). Factories are sync and receive the container so they can resolve
 * their own dependencies. No external DI framework is needed for this size of
 * app; swapping to InversifyJS later would only change this file.
 */
export class Container {
  private readonly factories = new Map<symbol, Factory<unknown>>();
  private readonly instances = new Map<symbol, unknown>();

  register<T>(token: symbol, factory: Factory<T>): this {
    this.factories.set(token, factory as Factory<unknown>);
    return this;
  }

  resolve<T>(token: symbol): T {
    if (this.instances.has(token)) return this.instances.get(token) as T;
    const factory = this.factories.get(token);
    if (!factory) throw new Error(`DI: no factory registered for token ${String(token)}`);
    const instance = (factory as Factory<T>)(this);
    this.instances.set(token, instance);
    return instance;
  }
}

/**
 * Wires the default container: Prisma-backed repositories + in-memory queue.
 * Swapping any provider (DB, queue, logger) means registering a different
 * adapter here for the same token — nothing in the application layer changes.
 */
export function createContainer(): Container {
  const c = new Container();

  c.register(Tokens.Config, () => getConfig());
  c.register<ILogger>(Tokens.Logger, (cc) => {
    const cfg = cc.resolve<AppConfig>(Tokens.Config);
    return new ConsoleLogger(cfg.logLevel);
  });
  c.register<PrismaClient>(Tokens.PrismaClient, () => getPrismaClient());
  c.register<IFeatureFlagRepository>(Tokens.FeatureFlagRepository, (cc) => {
    return new PrismaFeatureFlagRepository(
      cc.resolve<PrismaClient>(Tokens.PrismaClient),
      cc.resolve<ILogger>(Tokens.Logger),
    );
  });
  c.register<IJobRepository>(Tokens.JobRepository, (cc) => {
    return new PrismaJobRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register<IFeatureFlagService>(Tokens.FeatureFlagService, (cc) => {
    return new FeatureFlagService(
      cc.resolve<IFeatureFlagRepository>(Tokens.FeatureFlagRepository),
      cc.resolve<ILogger>(Tokens.Logger),
    );
  });
  // ---- Queue / worker / scheduler / events (M2.1 in-memory + M2.3 Redis) ---
  // Provider selection is config-driven: Redis when REDIS_URL is set, in-memory
  // otherwise. Swapping providers = a different adapter here for the same token.
  c.register<IJobEvents>(Tokens.JobEvents, (cc) => {
    const cfg = cc.resolve<AppConfig>(Tokens.Config);
    if (cfg.queue.provider === "redis" && cfg.queue.redisUrl) {
      return new RedisJobEvents(cfg.queue.redisUrl);
    }
    return new InMemoryJobEvents();
  });
  c.register<IQueue>(Tokens.Queue, (cc) => {
    const cfg = cc.resolve<AppConfig>(Tokens.Config);
    const jobRepo = cc.resolve<IJobRepository>(Tokens.JobRepository);
    const logger = cc.resolve<ILogger>(Tokens.Logger);
    if (cfg.queue.provider === "redis" && cfg.queue.redisUrl) {
      return new RedisQueue(cfg.queue.redisUrl, jobRepo, logger);
    }
    return new InMemoryQueue(jobRepo, logger);
  });
  c.register<IWorker>(Tokens.Worker, (cc) => {
    const cfg = cc.resolve<AppConfig>(Tokens.Config);
    const events = cc.resolve<IJobEvents>(Tokens.JobEvents);
    const queue = cc.resolve<IQueue>(Tokens.Queue);
    const jobRepo = cc.resolve<IJobRepository>(Tokens.JobRepository);
    const logger = cc.resolve<ILogger>(Tokens.Logger);
    if (cfg.queue.provider === "redis" && cfg.queue.redisUrl) {
      return new RedisWorker(cfg.queue.redisUrl, queue, jobRepo, logger, { events });
    }
    // concurrency = TOOLS_MAX_CONCURRENCY so jobs drained from the queue run in
    // parallel (the synchronous tool route awaits jobs through the queue; a
    // sequential worker would serialize every conversion — a regression).
    return new InMemoryWorker(queue, jobRepo, logger, {
      events,
      concurrency: cfg.toolsMaxConcurrency,
    });
  });
  c.register<IJobScheduler>(Tokens.JobScheduler, (cc) => {
    const cfg = cc.resolve<AppConfig>(Tokens.Config);
    const queue = cc.resolve<IQueue>(Tokens.Queue);
    const jobRepo = cc.resolve<IJobRepository>(Tokens.JobRepository);
    const logger = cc.resolve<ILogger>(Tokens.Logger);
    if (cfg.queue.provider === "redis" && cfg.queue.redisUrl) {
      return new RedisJobScheduler(cfg.queue.redisUrl, queue, jobRepo, logger);
    }
    return new InMemoryJobScheduler(queue, jobRepo, logger);
  });
  c.register<IHealthCheck[]>(Tokens.HealthChecks, (cc) => {
    return [
      new DbHealthCheck(
        cc.resolve<PrismaClient>(Tokens.PrismaClient),
        cc.resolve<ILogger>(Tokens.Logger),
      ),
    ];
  });

  // ---- Storage (M2.2) -----------------------------------------------------
  // Provider selection is config-driven: R2 when its credentials are present,
  // local filesystem otherwise. Swapping providers = a different adapter here
  // for the same token; nothing in the application layer changes.
  c.register<IObjectStorage>(Tokens.ObjectStorage, (cc) => {
    const cfg = cc.resolve<AppConfig>(Tokens.Config);
    if (cfg.storage.provider === "r2" && cfg.storage.r2) {
      return new R2ObjectStorage(cfg.storage.r2);
    }
    return new LocalFileStorage(cfg.storage.localRoot);
  });
  c.register<ISignedUrlService>(Tokens.SignedUrlService, (cc) => {
    const cfg = cc.resolve<AppConfig>(Tokens.Config);
    if (cfg.storage.provider === "r2" && cfg.storage.r2) {
      return new R2SignedUrlService(cfg.storage.r2);
    }
    return new LocalSignedUrlService(cfg.storage.signingSecret, cfg.siteUrl);
  });
  c.register<IFileMetadataRepository>(Tokens.FileMetadataRepository, (cc) => {
    return new PrismaStoredFileRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register<IUploadService>(Tokens.UploadService, (cc) => {
    return new UploadService(
      cc.resolve<IObjectStorage>(Tokens.ObjectStorage),
      cc.resolve<IFileMetadataRepository>(Tokens.FileMetadataRepository),
      cc.resolve<ILogger>(Tokens.Logger),
    );
  });
  c.register<IDownloadService>(Tokens.DownloadService, (cc) => {
    return new DownloadService(
      cc.resolve<IFileMetadataRepository>(Tokens.FileMetadataRepository),
      cc.resolve<ISignedUrlService>(Tokens.SignedUrlService),
    );
  });
  c.register<IMultipartUpload>(Tokens.MultipartUpload, (cc) => {
    const cfg = cc.resolve<AppConfig>(Tokens.Config);
    if (cfg.storage.provider === "r2" && cfg.storage.r2) {
      return new R2MultipartUpload(cfg.storage.r2);
    }
    return new LocalMultipartUpload(
      cc.resolve<IObjectStorage>(Tokens.ObjectStorage),
      path.join(cfg.storage.localRoot, ".multipart"),
      cfg.siteUrl,
    );
  });

  // ---- Auth (M2.4) ---------------------------------------------------------
  // Local providers by default. Clerk adapters (ClerkProviders.ts) exist as a
  // scaffold — switching to Clerk means registering them for these tokens.
  c.register<IUserProvider>(Tokens.UserProvider, (cc) => {
    return new LocalUserProvider(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register<ISessionProvider>(Tokens.SessionProvider, (cc) => {
    return new LocalSessionProvider(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register<IOrganizationProvider>(Tokens.OrganizationProvider, (cc) => {
    return new LocalOrganizationProvider(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register<IRoleProvider>(Tokens.RoleProvider, (cc) => {
    return new LocalRoleProvider(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register<IAuditLogRepository>(Tokens.AuditLogRepository, (cc) => {
    return new PrismaAuditLogRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register(Tokens.WorkspaceRepository, (cc) => {
    return new PrismaWorkspaceRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register(Tokens.WorkspaceMembershipRepository, (cc) => {
    return new PrismaWorkspaceMembershipRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register(Tokens.WorkspaceAuthorizationResolver, () => new WorkspaceAuthorizationResolver());
  c.register(Tokens.WorkspaceService, (cc) => new WorkspaceService(cc.resolve<PrismaClient>(Tokens.PrismaClient), cc.resolve(Tokens.WorkspaceRepository), cc.resolve(Tokens.WorkspaceMembershipRepository), cc.resolve(Tokens.WorkspaceAuthorizationResolver), cc.resolve<ILogger>(Tokens.Logger)));
  c.register(Tokens.WorkspaceMembershipService, (cc) => new WorkspaceMembershipService(cc.resolve(Tokens.WorkspaceMembershipRepository), cc.resolve(Tokens.WorkspaceService)));
  c.register(Tokens.ProjectRepository, (cc) => new PrismaProjectRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient)));
  c.register(Tokens.ProjectService, (cc) => new ProjectService(cc.resolve(Tokens.ProjectRepository), cc.resolve(Tokens.WorkspaceService)));
  c.register(Tokens.FolderRepository, (cc) => new PrismaFolderRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient)));
  c.register(Tokens.FolderService, (cc) => new FolderService(cc.resolve(Tokens.FolderRepository), cc.resolve(Tokens.ProjectRepository), cc.resolve(Tokens.WorkspaceService)));
  c.register(Tokens.DocumentRecordRepository, (cc) => new PrismaDocumentRecordRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient)));
  c.register(Tokens.DocumentRecordService, (cc) => new DocumentRecordService(cc.resolve(Tokens.DocumentRecordRepository), cc.resolve(Tokens.FolderRepository), cc.resolve(Tokens.ProjectRepository), cc.resolve(Tokens.WorkspaceService)));
  c.register<AuthService>(Tokens.AuthService, (cc) => {
    return new AuthService(
      cc.resolve<IUserProvider>(Tokens.UserProvider),
      cc.resolve<ISessionProvider>(Tokens.SessionProvider),
      cc.resolve<PrismaClient>(Tokens.PrismaClient),
    );
  });

  // ---- Observability (M2.5) — local console adapters; Sentry/PostHog swap in
  // by registering their adapters for these tokens. -------------------------
  c.register<IMetrics>(Tokens.Metrics, (cc) => {
    return new ConsoleMetrics(cc.resolve<ILogger>(Tokens.Logger));
  });
  c.register<ITracing>(Tokens.Tracing, (cc) => {
    return new ConsoleTracing(cc.resolve<ILogger>(Tokens.Logger));
  });
  c.register<IAnalytics>(Tokens.Analytics, (cc) => {
    return new ConsoleAnalytics(cc.resolve<ILogger>(Tokens.Logger));
  });
  c.register<IErrorReporter>(Tokens.ErrorReporter, (cc) => {
    return new ConsoleErrorReporter(cc.resolve<ILogger>(Tokens.Logger));
  });

  // ---- Tool jobs (M3.c) — server PDF tools through the queue + storage ------
  // The service enqueues/awaits/cancels pdf-tool jobs; the worker handler is
  // registered lazily by ensureWorkerReady() (see infrastructure/jobs).
  c.register<PdfToolJobService>(Tokens.PdfToolJobService, (cc) => {
    return new PdfToolJobService(
      cc.resolve<IQueue>(Tokens.Queue),
      cc.resolve<IJobRepository>(Tokens.JobRepository),
      cc.resolve<IWorker>(Tokens.Worker),
    );
  });

  // ---- Unified processing pipeline -----------------------------------------
  // One authority over processing-job state. API routes resolve this and never
  // the JobRepository, which is what keeps ownership checks, the lifecycle and
  // the tool allowlist in a single place instead of restated per route.
  c.register<ProcessingJobService>(Tokens.ProcessingJobService, (cc) => {
    return new ProcessingJobService({
      jobRepo: cc.resolve<IJobRepository>(Tokens.JobRepository),
      queue: cc.resolve<IQueue>(Tokens.Queue),
      worker: cc.resolve<IWorker>(Tokens.Worker),
      logger: cc.resolve<ILogger>(Tokens.Logger),
    });
  });
  // Registry, not an if/else in the worker: adding a tool to the pipeline is a
  // registration, and an unregistered slug fails loudly at dispatch.
  c.register<IToolProcessorRegistry>(Tokens.ToolProcessorRegistry, () =>
    buildProcessorRegistry(),
  );
  // Resolved lazily via the container so the metering dependency is the same
  // singleton the handler settles through — a second instance would mean a
  // second settlement claim cache and, with it, a second customer charge.
  c.register<StuckJobRecoveryService>(Tokens.StuckJobRecoveryService, (cc) => {
    return new StuckJobRecoveryService({
      jobRepo: cc.resolve<IJobRepository>(Tokens.JobRepository),
      queue: cc.resolve<IQueue>(Tokens.Queue),
      logger: cc.resolve<ILogger>(Tokens.Logger),
      metering: cc.resolve<UsageMeteringService>(Tokens.UsageMeteringService),
    });
  });
  c.register<ProcessingUsageRecorder>(Tokens.ProcessingUsageRecorder, (cc) => {
    return new ProcessingUsageRecorder(
      cc.resolve<IAnalytics>(Tokens.Analytics),
      cc.resolve<IMetrics>(Tokens.Metrics),
      cc.resolve<ILogger>(Tokens.Logger),
    );
  });

  // ---- Usage metering + entitlements ---------------------------------------
  // Prisma-backed in every real process: counters are the enforcement substrate
  // and have to outlive a deploy. Focused tests swap in InMemoryUsageRepository
  // by constructing UsageMeteringService directly rather than by reaching in
  // here, so the production wiring stays the only wiring.
  c.register<IUsageRepository>(Tokens.UsageRepository, (cc) => {
    return new PrismaUsageRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register<IEntitlementProvider>(Tokens.EntitlementProvider, (cc) => {
    return new OrganizationEntitlementProvider(
      cc.resolve<IOrganizationProvider>(Tokens.OrganizationProvider),
      cc.resolve<ILogger>(Tokens.Logger),
      // Wired unconditionally, not behind the billing-enabled flag. The repository
      // reads rows; whether Stripe credentials exist is irrelevant to that, and
      // making entitlement depend on provider configuration would mean an
      // organization keeps Pro when a key is rotated out.
      cc.resolve<IBillingRepository>(Tokens.BillingRepository),
    );
  });
  c.register<UsageMeteringService>(Tokens.UsageMeteringService, (cc) => {
    return new UsageMeteringService({
      usage: cc.resolve<IUsageRepository>(Tokens.UsageRepository),
      entitlements: cc.resolve<IEntitlementProvider>(Tokens.EntitlementProvider),
      logger: cc.resolve<ILogger>(Tokens.Logger),
      // Observe by default. The ceilings in PLAN_ENTITLEMENTS are candidates
      // measured against real traffic; USAGE_LIMIT_MODE=enforce is the deliberate
      // act that turns them into a paywall.
      mode: resolveLimitMode(process.env.USAGE_LIMIT_MODE),
    });
  });
  c.register<ProductAnalyticsService>(Tokens.ProductAnalyticsService, (cc) => {
    return new ProductAnalyticsService({
      usage: cc.resolve<IUsageRepository>(Tokens.UsageRepository),
      entitlements: cc.resolve<IEntitlementProvider>(Tokens.EntitlementProvider),
      logger: cc.resolve<ILogger>(Tokens.Logger),
      // Falls back to ADMIN_SECRET so funnel stitching works in a deployment
      // that has not set a dedicated variable; absent both, subject hashing is
      // off and the events are still recorded, just unstitched. Never a
      // hardcoded default — a constant salt is not a salt.
      subjectSecret: process.env.ANALYTICS_SUBJECT_SECRET || process.env.ADMIN_SECRET || null,
    });
  });
  c.register<UsageAnalyticsReadService>(Tokens.UsageAnalyticsReadService, (cc) => {
    // Only the repository and a logger. No entitlement provider and no secret:
    // this service reports aggregates, so it never needs to know an owner or to
    // recompute a subject hash, and a dependency it cannot resolve is a leak it
    // cannot have.
    return new UsageAnalyticsReadService({
      usage: cc.resolve<IUsageRepository>(Tokens.UsageRepository),
      logger: cc.resolve<ILogger>(Tokens.Logger),
      // The same resolver the metering service above uses, from the same
      // variable. Two independent readings of one env var is how a readiness
      // report ends up describing a mode the deployment is not in.
      limitMode: resolveLimitMode(process.env.USAGE_LIMIT_MODE),
    });
  });

  // ---- Billing / subscriptions ----------------------------------------------
  // The repository is always wired: it is the entitlement substrate and reading it
  // needs no provider credentials. The *provider* is null unless Stripe is fully
  // configured, and BillingService turns that null into a clear
  // BILLING_NOT_CONFIGURED failure rather than a half-working checkout.
  c.register<IBillingRepository>(Tokens.BillingRepository, (cc) => {
    return new PrismaBillingRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register<IBillingProvider | null>(Tokens.BillingProvider, (cc) => {
    const cfg = cc.resolve<AppConfig>(Tokens.Config);
    if (!cfg.billing.enabled) return null;
    return new StripeBillingProvider({
      secretKey: cfg.billing.secretKey!,
      webhookSecret: cfg.billing.webhookSecret!,
    });
  });
  c.register<BillingService>(Tokens.BillingService, (cc) => {
    const cfg = cc.resolve<AppConfig>(Tokens.Config);
    return new BillingService({
      billing: cc.resolve<IBillingRepository>(Tokens.BillingRepository),
      provider: cc.resolve<IBillingProvider | null>(Tokens.BillingProvider),
      organizations: cc.resolve<IOrganizationProvider>(Tokens.OrganizationProvider),
      users: cc.resolve<IUserProvider>(Tokens.UserProvider),
      audit: cc.resolve<IAuditLogRepository>(Tokens.AuditLogRepository),
      logger: cc.resolve<ILogger>(Tokens.Logger),
      // The price map comes from the environment, so the set of purchasable prices
      // is fixed at boot and a request can never name one.
      prices: cfg.billing.prices,
      // Return URLs are built from configured origin, never from a request host —
      // a Host-header-derived origin is an open redirect with a payment attached.
      siteUrl: cfg.siteUrl,
      providerName: cfg.billing.provider,
    });
  });

  // ---- Premium editor (M3.e) ------------------------------------------------
  // The services + plugin registry are singletons; the editor itself is created
  // per-surface through EditorServiceFactory so each editor gets its own
  // CommandHistory + state. The serializer is wired to the plugin registry's
  // object-type registry so plugin kinds round-trip through save/load.
  c.register<ISelectionService>(Tokens.EditorSelectionService, () => new SelectionService());
  c.register<ILayerService>(Tokens.EditorLayerService, () => new LayerService());
  c.register<PluginRegistry>(Tokens.EditorPluginRegistry, () => new PluginRegistry());
  c.register<ISerializer>(Tokens.EditorSerializer, (cc) => {
    return new SerializationService(
      cc.resolve<PluginRegistry>(Tokens.EditorPluginRegistry).objectTypesRegistry,
    );
  });
  c.register<EditorServiceFactory>(Tokens.EditorServiceFactory, (cc) => ({
    create: (initialState) =>
      createEditorDocumentService({
        history: new CommandHistory(),
        selection: cc.resolve<ISelectionService>(Tokens.EditorSelectionService),
        layers: cc.resolve<ILayerService>(Tokens.EditorLayerService),
        serializer: cc.resolve<ISerializer>(Tokens.EditorSerializer),
        plugins: cc.resolve<PluginRegistry>(Tokens.EditorPluginRegistry),
        initialState,
      }),
  }));

  // ---- M7.4: workspace upload + document ingestion --------------------------
  c.register<DocumentIngestionRepository>(Tokens.DocumentIngestionRepository, (cc) => {
    return new PrismaDocumentIngestionRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register<WorkspaceAwareUploadService>(Tokens.WorkspaceAwareUploadService, (cc) => {
    return new WorkspaceAwareUploadService(
      cc.resolve<IObjectStorage>(Tokens.ObjectStorage),
      cc.resolve<IFileMetadataRepository>(Tokens.FileMetadataRepository),
      cc.resolve<ILogger>(Tokens.Logger),
      cc.resolve(Tokens.WorkspaceService),
      cc.resolve(Tokens.DocumentRecordRepository),
      cc.resolve(Tokens.FolderRepository),
      cc.resolve(Tokens.ProjectRepository),
      cc.resolve<DocumentIngestionRepository>(Tokens.DocumentIngestionRepository),
      cc.resolve<IQueue>(Tokens.Queue),
    );
  });

  // The promotion of a pending ingestion into the document's initial `import`
  // version. Registered after the version repository it depends on; the worker
  // handler and the one-time repair script both resolve this same instance, so
  // there is exactly one implementation of "what an initial version looks like".
  c.register<DocumentIngestionService>(Tokens.DocumentIngestionService, (cc) => {
    return new DocumentIngestionService(
      cc.resolve<ILogger>(Tokens.Logger),
      cc.resolve<DocumentIngestionRepository>(Tokens.DocumentIngestionRepository),
      cc.resolve(Tokens.DocumentRecordRepository),
      cc.resolve<DocumentVersionRepository>(Tokens.DocumentVersionRepository),
      cc.resolve<IFileMetadataRepository>(Tokens.FileMetadataRepository),
      cc.resolve<IObjectStorage>(Tokens.ObjectStorage),
    );
  });

  // ---- M7.5: durable autosave drafts ---------------------------------------
  // The draft row is metadata only; the editor-state snapshot it points at lives
  // in object storage, so the service needs both the repository and the store.
  c.register<AutosaveDraftRepository>(Tokens.AutosaveDraftRepository, (cc) => {
    return new PrismaAutosaveDraftRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register<AutosaveService>(Tokens.AutosaveService, (cc) => {
    return new AutosaveService(
      cc.resolve<ILogger>(Tokens.Logger),
      cc.resolve(Tokens.WorkspaceService),
      cc.resolve<AutosaveDraftRepository>(Tokens.AutosaveDraftRepository),
      cc.resolve(Tokens.DocumentRecordRepository),
      cc.resolve<IObjectStorage>(Tokens.ObjectStorage),
    );
  });

  // ---- M7.6: durable document versions -------------------------------------
  // A version is a metadata row plus a bounded artifact manifest; the bytes it
  // names live in object storage, which is why the service takes the store as
  // well as the repository — pruning a version has to be able to collect them.
  c.register<DocumentVersionRepository>(Tokens.DocumentVersionRepository, (cc) => {
    return new PrismaDocumentVersionRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register<VersionService>(Tokens.VersionService, (cc) => {
    return new VersionService(
      cc.resolve<ILogger>(Tokens.Logger),
      cc.resolve(Tokens.WorkspaceService),
      cc.resolve<DocumentVersionRepository>(Tokens.DocumentVersionRepository),
      cc.resolve(Tokens.DocumentRecordRepository),
      cc.resolve<IObjectStorage>(Tokens.ObjectStorage),
    );
  });

  // ---- M7.7: tags and smart collections ------------------------------------
  // Three repositories rather than one: tag definitions, the document-to-tag
  // assignments, and the collection definitions have separate lifetimes, and a
  // collection's membership is evaluated live against documents and assignments
  // rather than persisted, so the service needs the document repository too.
  c.register<TagRepository>(Tokens.TagRepository, (cc) => {
    return new PrismaTagRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register<DocumentTagRepository>(Tokens.DocumentTagRepository, (cc) => {
    return new PrismaDocumentTagRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register<SmartCollectionRepository>(Tokens.SmartCollectionRepository, (cc) => {
    return new PrismaSmartCollectionRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
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

  // ---- M7.8: search index --------------------------------------------------
  // Two repositories: the per-document index entry and the bounded content
  // chunks beneath it. The service also needs the document repository, because
  // authorization resolves eligible DocumentRecords *before* any chunk is read.
  c.register<SearchDocumentRepository>(Tokens.SearchDocumentRepository, (cc) => {
    return new PrismaSearchDocumentRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register<SearchChunkRepository>(Tokens.SearchChunkRepository, (cc) => {
    return new PrismaSearchChunkRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register<SearchIndexPort>(Tokens.SearchIndexPort, (cc) => {
    return new SQLiteSearchIndexAdapter(
      cc.resolve<SearchChunkRepository>(Tokens.SearchChunkRepository),
    );
  });
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

  // ---- M7.9: metadata, bookmarks, outlines, attachments --------------------
  // Four repositories because the four records have genuinely different shapes
  // and lifetimes: one properties row per document, many bookmarks, a tree of
  // outline items spanning both origins, and a catalogue of attachments whose
  // bytes live behind object storage. The service takes the store and the file
  // metadata repository as well — an attachment is a StoredFile plus a row, and
  // creating one has to be able to roll the other back.
  c.register<DocumentMetadataRepository>(Tokens.DocumentMetadataRepository, (cc) => {
    return new PrismaDocumentMetadataRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register<BookmarkRepository>(Tokens.BookmarkRepository, (cc) => {
    return new PrismaBookmarkRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register<OutlineItemRepository>(Tokens.OutlineItemRepository, (cc) => {
    return new PrismaOutlineItemRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register<AttachmentRepository>(Tokens.AttachmentRepository, (cc) => {
    return new PrismaAttachmentRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
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

  // ---- M7.10: comments, sharing and asynchronous collaboration -------------
  // Three repositories because the three records have genuinely different
  // lifetimes: a thread owns a location and a resolution state, a message owns
  // authored text, and a grant owns a standing capability with its own expiry
  // and revocation. The service takes the document repository too — every
  // collaboration operation is authorized against a real DocumentRecord before
  // any comment row is read.
  c.register<CommentThreadRepository>(Tokens.CommentThreadRepository, (cc) => {
    return new PrismaCommentThreadRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register<CommentMessageRepository>(Tokens.CommentMessageRepository, (cc) => {
    return new PrismaCommentMessageRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register<DocumentPermissionGrantRepository>(
    Tokens.DocumentPermissionGrantRepository,
    (cc) => {
      return new PrismaDocumentPermissionGrantRepository(
        cc.resolve<PrismaClient>(Tokens.PrismaClient),
      );
    },
  );
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

  // ---- M7.11: document statistics and version comparison -------------------
  c.register<DocumentStatisticsRepository>(Tokens.DocumentStatisticsRepository, (cc) => {
    return new PrismaDocumentStatisticsRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register<ComparisonOperationRepository>(Tokens.ComparisonOperationRepository, (cc) => {
    return new PrismaComparisonOperationRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register<ComparisonResultRepository>(Tokens.ComparisonResultRepository, (cc) => {
    return new PrismaComparisonResultRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register<StatisticsService>(Tokens.StatisticsService, (cc) => {
    return new StatisticsService(
      cc.resolve<ILogger>(Tokens.Logger),
      cc.resolve(Tokens.WorkspaceService),
      cc.resolve(Tokens.DocumentRecordRepository),
      cc.resolve(Tokens.DocumentVersionRepository),
      cc.resolve<DocumentStatisticsRepository>(Tokens.DocumentStatisticsRepository),
      cc.resolve<ComparisonOperationRepository>(Tokens.ComparisonOperationRepository),
      cc.resolve<ComparisonResultRepository>(Tokens.ComparisonResultRepository),
      // Server-held content for the trusted recalculation path, so the HTTP
      // surface never accepts measured counts from a client.
      cc.resolve<SearchChunkRepository>(Tokens.SearchChunkRepository),
      cc.resolve<BookmarkRepository>(Tokens.BookmarkRepository),
      cc.resolve<AttachmentRepository>(Tokens.AttachmentRepository),
    );
  });

  // ---- M7.12: workspace tab sessions ---------------------------------------
  c.register<WorkspaceSessionRepository>(Tokens.WorkspaceSessionRepository, (cc) => {
    return new PrismaWorkspaceSessionRepository(cc.resolve<PrismaClient>(Tokens.PrismaClient));
  });
  c.register<TabService>(Tokens.TabService, (cc) => {
    return new TabService(
      cc.resolve<ILogger>(Tokens.Logger),
      cc.resolve(Tokens.WorkspaceService),
      cc.resolve<WorkspaceSessionRepository>(Tokens.WorkspaceSessionRepository),
      cc.resolve(Tokens.DocumentRecordRepository),
    );
  });

  // ---- M7.13: split view and navigation ------------------------------------
  // Layered over TabService rather than beside it, so pane assignment inherits
  // one authorization path and one persistence path.
  c.register<SplitViewService>(Tokens.SplitViewService, (cc) => {
    return new SplitViewService(
      cc.resolve<ILogger>(Tokens.Logger),
      cc.resolve<TabService>(Tokens.TabService),
    );
  });

  // ---- M7.14: command palette and operation center --------------------------
  // The canonical command set is registered here, once, rather than by each page
  // that opens a palette. A per-page registry produces a palette whose contents
  // depend on which screen opened it, and a shortcut that means different things
  // in different places.
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

/** Shared application container. Routes/services resolve from this. */
export const appContainer = createContainer();